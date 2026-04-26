/**
 * Typed wrappers around the Tauri git_* + invite_* commands.
 *
 * All wrappers degrade to mocks outside Tauri so vitest + browser dev still
 * render the new screens. The mocks return shapes that match the Rust side
 * exactly so a UI bug doesn't hide a real Rust shape change.
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
    console.error(`[tauri/git] invoke "${cmd}" failed:`, e, "args=", args);
    throw e;
  }
}

// ---------- git ops ----------

export interface GitCheckResult {
  available: boolean;
  path: string | null;
  version: string | null;
  install_url: string;
}

export async function gitCheck(): Promise<GitCheckResult> {
  return safeInvoke("git_check", undefined, () => ({
    available: true,
    path: "/usr/bin/git (mock)",
    version: "git version 2.44.0",
    install_url: "https://git-scm.com/downloads",
  }));
}

export interface GitCloneResult {
  dest: string;
  branch: string;
}

export async function gitClone(args: {
  url: string;
  dest: string;
  token?: string;
}): Promise<GitCloneResult> {
  return safeInvoke(
    "git_clone",
    { args: { url: args.url, dest: args.dest, token: args.token ?? null } },
    () => ({ dest: args.dest, branch: "main" }),
  );
}

export interface GitOpResult {
  ok: boolean;
  message: string;
}

export async function gitPull(args: { repo: string; token?: string }): Promise<GitOpResult> {
  return safeInvoke(
    "git_pull",
    { args: { repo: args.repo, token: args.token ?? null } },
    () => ({ ok: true, message: "pulled" }),
  );
}

export async function gitPush(args: { repo: string; token?: string }): Promise<GitOpResult> {
  return safeInvoke(
    "git_push",
    { args: { repo: args.repo, token: args.token ?? null } },
    () => ({ ok: true, message: "pushed" }),
  );
}

export interface GitStatusResult {
  clean: boolean;
  branch: string;
  ahead: number;
  behind: number;
  changed: string[];
}

export async function gitStatus(args: { repo: string }): Promise<GitStatusResult> {
  return safeInvoke("git_status", { args }, () => ({
    clean: true,
    branch: "main",
    ahead: 0,
    behind: 0,
    changed: [],
  }));
}

export async function gitCommitAll(args: {
  repo: string;
  message: string;
  pathSpec?: string;
}): Promise<GitOpResult> {
  return safeInvoke(
    "git_commit_all",
    {
      args: {
        repo: args.repo,
        message: args.message,
        path_spec: args.pathSpec ?? null,
      },
    },
    () => ({ ok: true, message: "committed" }),
  );
}

export async function gitInitAndPush(args: {
  repo: string;
  remoteUrl: string;
  token?: string;
}): Promise<GitOpResult> {
  return safeInvoke(
    "git_init_and_push",
    {
      args: {
        repo: args.repo,
        remote_url: args.remoteUrl,
        token: args.token ?? null,
      },
    },
    () => ({ ok: true, message: "initialized_and_pushed" }),
  );
}

// ---------- background sync ticker ----------

export async function syncStart(args: { repoPath: string; login: string }): Promise<void> {
  return safeInvoke(
    "sync_start",
    { args: { repo_path: args.repoPath, login: args.login } },
    () => undefined,
  );
}

export async function syncStop(): Promise<void> {
  return safeInvoke("sync_stop", undefined, () => undefined);
}

export async function syncKick(): Promise<void> {
  return safeInvoke("sync_kick", undefined, () => undefined);
}

export interface SyncStatusOut {
  running: boolean;
  repo_path: string | null;
  login: string | null;
  last_pull: string | null;
  last_push: string | null;
  last_error: string | null;
  pending_changes: number;
}

export async function syncStatus(): Promise<SyncStatusOut> {
  return safeInvoke("sync_status", undefined, () => ({
    running: false,
    repo_path: null,
    login: null,
    last_pull: null,
    last_push: null,
    last_error: null,
    pending_changes: 0,
  }));
}

// ---------- invite codec ----------

export interface InviteOut {
  uri: string;
  repo_url: string;
  expires_at: number;
}

export async function generateInvite(args: { repoUrl: string }): Promise<InviteOut> {
  return safeInvoke(
    "generate_invite",
    { args: { repo_url: args.repoUrl } },
    () => ({
      uri: `tangerine://join?repo=${encodeURIComponent(args.repoUrl)}&token=mock-token`,
      repo_url: args.repoUrl,
      expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
    }),
  );
}

export interface ParseInviteOut {
  valid: boolean;
  repo_url: string | null;
  expired: boolean;
  reason: string | null;
}

export async function parseInvite(args: { uri: string }): Promise<ParseInviteOut> {
  return safeInvoke(
    "parse_invite",
    { args },
    () => {
      // Mock: extract repo from query for the join-team route in dev.
      const m = args.uri.match(/repo=([^&]+)/);
      return {
        valid: !!m,
        repo_url: m ? decodeURIComponent(m[1]) : null,
        expired: false,
        reason: m ? null : "Invite link is missing the repo URL.",
      };
    },
  );
}

/**
 * Subscribe to deep-link `deeplink://join` events emitted by uri_handler.rs.
 * Used by App.tsx so any tangerine:// URL clicked anywhere on the OS routes
 * the user to /join?...
 */
export async function onDeepLinkJoin(
  onUri: (uri: string) => void,
): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<{ uri: string }>("deeplink://join", (e) => onUri(e.payload.uri));
  return un;
}
