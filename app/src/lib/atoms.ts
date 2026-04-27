/**
 * v2.0-alpha.2 — typed wrapper around the Rust `list_atoms` Tauri command.
 *
 * Mirrors `app/src-tauri/src/commands/memory.rs::list_atoms`. v2.0-alpha.1
 * landed the Rust side; the React side until now read the layered tree
 * via `walkMemoryTree` (lib/memory.ts) which goes through plugin-fs. The
 * graph builder needs the union view (team + personal) with the same
 * scope tag the Rust handler emits, so this wrapper is the single
 * conversion point.
 *
 * Outside Tauri (vitest, vite dev) the wrapper falls back to a small
 * deterministic mock so the home graph stays usable without a daemon.
 */

const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function realInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function safeInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T,
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    return await realInvoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tauri/atoms] invoke "${cmd}" failed:`, e, "args=", args);
    return await mock();
  }
}

/** One row returned by `list_atoms`. Mirrors the Rust struct exactly. */
export interface AtomEntry {
  /** Path relative to memory root, forward-slash separated. */
  rel_path: string;
  /** Atom kind ("meetings" / "decisions" / "people" / ...). */
  kind: string;
  /** "team" | "personal". */
  scope: string;
  /** File basename including .md. */
  name: string;
}

export interface ListAtomsArgs {
  current_user?: string;
  include_personal?: boolean;
  /** Empty / undefined → every kind. */
  kinds?: string[];
}

export interface ListAtomsResult {
  root: string;
  atoms: AtomEntry[];
  personal_included: boolean;
}

export async function listAtoms(args?: ListAtomsArgs): Promise<ListAtomsResult> {
  return safeInvoke(
    "list_atoms",
    {
      current_user: args?.current_user,
      include_personal: args?.include_personal ?? true,
      kinds: args?.kinds ?? [],
    },
    () => mockAtoms(),
  );
}

/**
 * Deterministic mock — small enough that vitest snapshots stay readable,
 * varied enough that the WorkflowGraph component renders all four node
 * shapes (person / project / decision / agent) and at least one info-flow
 * edge in browser dev.
 */
function mockAtoms(): ListAtomsResult {
  return {
    root: "~/.tangerine-memory",
    atoms: [
      {
        rel_path: "team/people/daizhe.md",
        kind: "people",
        scope: "team",
        name: "daizhe.md",
      },
      {
        rel_path: "team/people/hongyu.md",
        kind: "people",
        scope: "team",
        name: "hongyu.md",
      },
      {
        rel_path: "team/projects/v1-launch.md",
        kind: "projects",
        scope: "team",
        name: "v1-launch.md",
      },
      {
        rel_path: "team/decisions/2026-04-pricing.md",
        kind: "decisions",
        scope: "team",
        name: "2026-04-pricing.md",
      },
      {
        rel_path: "team/decisions/2026-04-scope-lock.md",
        kind: "decisions",
        scope: "team",
        name: "2026-04-scope-lock.md",
      },
      {
        rel_path: "personal/me/cursor/2026-04-26-graph-build.md",
        kind: "agents",
        scope: "personal",
        name: "2026-04-26-graph-build.md",
      },
    ],
    personal_included: true,
  };
}
