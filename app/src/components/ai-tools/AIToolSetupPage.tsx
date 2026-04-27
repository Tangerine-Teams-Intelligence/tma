import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Copy,
  ExternalLink,
  Loader2,
  AlertCircle,
  Wand2,
} from "lucide-react";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";
import { getAIToolConfig, type AIToolConfig } from "@/lib/ai-tools-config";
// === wave 5-γ ===
import { mcpConfigDisplayPath } from "@/lib/platform";
import { coThinkerDispatch } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

/**
 * /ai-tools/:id — generic per-tool setup page.
 *
 * Reads the static config from `lib/ai-tools-config.ts` and the live
 * detection verdict from the Rust `get_ai_tool_status` command on mount.
 * Renders three sections:
 *
 *   1. Status banner: detected ✅ / needs setup / not installed (with install link)
 *   2. "How to wire it up": 3 setup steps as numbered list, w/ optional code blocks
 *   3. "Test it": 3 🍊 Test Query buttons → mock answer card (Phase 1 only)
 *
 * Phase 3 will replace the mock query handler with a real session-borrowed
 * call into the upstream LLM via Tangerine's MCP / browser-ext / IDE bridge.
 */
export default function AIToolSetupPage() {
  const params = useParams();
  const id = params.id ?? "";
  const config = useMemo(() => getAIToolConfig(id), [id]);

  const [status, setStatus] = useState<AIToolStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Load the live detection verdict on mount. We piggy-back on `loadAITools()`
  // (which Agent 2 already wired through `lib/tauri.ts::detectAITools`) and
  // pluck out the row matching `:id`. That keeps us aligned with the sidebar
  // and avoids duplicating mock fixtures.
  useEffect(() => {
    let cancel = false;
    if (!id) return;
    setStatusLoading(true);
    setStatusError(null);
    setStatus(null);
    (async () => {
      try {
        const all = await loadAITools();
        if (cancel) return;
        const row = all.find((t) => t.id === id) ?? null;
        setStatus(row);
      } catch (e) {
        if (cancel) return;
        setStatusError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancel) setStatusLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [id]);

  if (!config) {
    return (
      <div className="bg-stone-50 dark:bg-stone-950">
        <div className="mx-auto max-w-3xl px-8 py-10">
          <BackLink />
          <p className="mt-6 text-[12px] text-stone-500 dark:text-stone-400">
            Unknown AI tool: <code className="font-mono">{id}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <BackLink />

        <header className="mt-6">
          <p className="ti-section-label">AI tools</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            {config.name}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            channel: {config.channel.replace("_", " ")}
          </p>
        </header>

        <StatusBanner
          config={config}
          status={status}
          statusLoading={statusLoading}
          statusError={statusError}
        />

        <AutoConfigureCard config={config} status={status} />

        <SetupSteps config={config} status={status} />

        <TestQuerySection config={config} />

        <footer className="mt-10 border-t border-stone-200 pt-6 text-[11px] leading-relaxed text-stone-500 dark:border-stone-800 dark:text-stone-400">
          Tangerine borrows your existing {config.name} session — no API key
          needed.
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Back link
// ----------------------------------------------------------------------------

function BackLink() {
  return (
    <Link
      to="/today"
      className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
    >
      <ArrowLeft size={12} /> /today
    </Link>
  );
}

// ----------------------------------------------------------------------------
// Status banner
// ----------------------------------------------------------------------------

function StatusBanner({
  config,
  status,
  statusLoading,
  statusError,
}: {
  config: AIToolConfig;
  status: AIToolStatus | null;
  statusLoading: boolean;
  statusError: string | null;
}) {
  if (statusLoading) {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <Loader2
          size={14}
          className="animate-spin text-stone-500 dark:text-stone-400"
        />
        <p className="text-[12px] text-stone-600 dark:text-stone-300">
          Detecting {config.name}…
        </p>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
        <AlertCircle
          size={14}
          className="mt-0.5 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-amber-900 dark:text-amber-200">
            Couldn't run detection
          </p>
          <p className="mt-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            {statusError}
          </p>
        </div>
      </div>
    );
  }

  const verdict = status?.status ?? "not_installed";

  if (verdict === "installed") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
        <CheckCircle2
          size={14}
          className="mt-0.5 text-emerald-600 dark:text-emerald-400"
        />
        <div>
          <p className="text-[13px] font-medium text-emerald-900 dark:text-emerald-200">
            {config.name} detected on this machine.
          </p>
          <p className="mt-1 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
            Follow the steps below if you haven't wired Tangerine in yet.
          </p>
        </div>
      </div>
    );
  }

  if (verdict === "needs_setup") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
        <Circle
          size={14}
          className="mt-0.5 text-amber-600 dark:text-amber-400"
        />
        <div>
          <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
            {config.name} found, pending setup.
          </p>
          <p className="mt-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            We can see the app but haven't found a Tangerine entry yet.
          </p>
        </div>
      </div>
    );
  }

  if (verdict === "browser_ext_required") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <Circle size={14} className="mt-0.5 text-stone-500" />
        <div>
          <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
            {config.name} needs the Tangerine browser extension.
          </p>
          <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
            We can't auto-detect web tools — install the extension below.
          </p>
        </div>
      </div>
    );
  }

  // not_installed
  const installUrl = status?.install_url ?? config.install_url;
  return (
    <div className="mt-6 flex items-start gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <Circle size={14} className="mt-0.5 text-stone-400" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
          {config.name} not installed.
        </p>
        <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
          Install it first, then come back to this page.
        </p>
      </div>
      {installUrl && (
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded border border-stone-200 px-2 py-1 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Install {config.name} <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Wave 4-C — auto-configure
// ----------------------------------------------------------------------------

/**
 * Wave 4-C — per-tool MCP config file path. Wired so the auto-configure
 * card can show the user exactly where the snippet should land. Returns
 * `null` for tools where auto-configuration isn't applicable (browser
 * extensions, local-HTTP probes).
 *
 * The path placeholder syntax (`~/.cursor/mcp.json` etc.) is what the
 * existing `setup_steps[1].body` already documents — we keep it
 * consistent so the auto-configure flow reads as a one-click shortcut
 * for the manual flow, not a separate concept.
 *
 * === wave 5-γ ===
 * The returned string is the canonical POSIX form. Display-time consumers
 * MUST run it through `mcpConfigDisplayPath()` from lib/platform so the
 * Windows shell variant (`%USERPROFILE%\.cursor\mcp.json`) shows up on
 * Windows hosts. The clipboard JSON snippet stays OS-neutral.
 */
function mcpConfigPathFor(toolId: string): string | null {
  switch (toolId) {
    case "cursor":
      return "~/.cursor/mcp.json";
    case "claude-code":
      return "~/.claude/mcp_servers.json";
    case "codex":
      return "~/.codex/mcp.json";
    case "windsurf":
      // Windsurf uses an in-app settings panel rather than a flat JSON
      // file; we still surface it so the user knows where the config
      // landed.
      return "Settings → MCP";
    default:
      return null;
  }
}

/**
 * Auto-configure card. Only renders when:
 *   1. The tool is on the MCP channel (others have no config file),
 *   2. The tool is detected as `installed` on this machine, AND
 *   3. We have a known config path for it.
 *
 * When all three hold we surface a one-click "Auto-configure" button
 * that copies the Tangerine MCP snippet to the clipboard and tells the
 * user exactly which file to paste into. Hiding the manual 3-step
 * setup behind a collapsible details section (handled by SetupSteps)
 * keeps the simple path simple — but the manual fallback is always
 * one click away.
 *
 * Note on actual file writes: a true auto-write would need a Tauri
 * command on the Rust side (`write_mcp_config(tool_id, snippet)`) that
 * idempotently merges the Tangerine entry into the existing file.
 * That's not yet wired (no fs::write helper exists in lib/tauri.ts as
 * of Wave 4 HEAD). The clipboard-based flow is the safe, no-data-loss
 * path that still cuts the manual flow from "open settings, navigate
 * to MCP, edit JSON" to "click button, paste, restart".
 */
function AutoConfigureCard({
  config,
  status,
}: {
  config: AIToolConfig;
  status: AIToolStatus | null;
}) {
  const pushToast = useStore((s) => s.ui.pushToast);
  const [copied, setCopied] = useState(false);

  // Only meaningful for MCP-channel tools that are actually installed.
  // Browser extensions / local HTTP / IDE plugins surface the manual
  // flow only — the steps for them already collapse to "click a button"
  // and don't benefit from auto-configure.
  const eligible =
    config.channel === "mcp" &&
    status?.status === "installed" &&
    mcpConfigPathFor(config.id) !== null;

  if (!eligible) return null;

  // === wave 5-γ ===
  // Translate the canonical POSIX path into the OS-correct display string
  // (`%USERPROFILE%\.cursor\mcp.json` on Windows, `~/.cursor/mcp.json`
  // elsewhere). Telemetry still gets the canonical form so dashboards
  // group the same path across OSes.
  const canonicalPath = mcpConfigPathFor(config.id) ?? "";
  const path = mcpConfigDisplayPath(canonicalPath);

  // Pull the JSON snippet straight out of the existing setup_steps so
  // the source of truth stays in lib/ai-tools-config.ts. We pick the
  // first step that has a `code` block; that's the MCP server snippet
  // for every tool currently in the catalog.
  const snippet =
    config.setup_steps.find((s) => s.code)?.code ?? "";

  const onAutoConfigure = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      pushToast(
        "success",
        `Tangerine MCP config copied. Paste it into ${path}, then restart ${config.name}.`,
      );
      void logEvent("ai_tool_auto_configure", {
        tool_id: config.id,
        // Telemetry stays OS-neutral so analytics can group across hosts.
        path: canonicalPath,
        outcome: "copied",
      });
      // Clear the "Copied" badge after a beat so the button feels
      // re-clickable rather than stuck.
      window.setTimeout(() => setCopied(false), 2400);
    } catch (e) {
      // Clipboard API can fail in headless contexts (Tauri without the
      // permission, sandboxed iframes). Fall back to a clear instruction
      // so the user can still complete setup.
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `Couldn't copy: ${msg}. Use the manual steps below.`);
      void logEvent("ai_tool_auto_configure", {
        tool_id: config.id,
        path: canonicalPath,
        outcome: "copy_failed",
      });
    }
  };

  return (
    <section
      data-testid="ai-tool-auto-configure"
      className="mt-6 rounded-md border border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)]/40 p-5 dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900/40"
    >
      <div className="flex items-start gap-3">
        <Wand2
          size={16}
          className="mt-0.5 text-[var(--ti-orange-500)]"
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
            Auto-configure {config.name}
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-stone-600 dark:text-stone-400">
            We detected {config.name} on this machine. One click copies the
            Tangerine MCP snippet to your clipboard — paste it into{" "}
            <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[11px] text-stone-800 dark:bg-stone-800 dark:text-stone-100">
              {path}
            </code>{" "}
            and restart {config.name}.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="ai-tool-auto-configure-btn"
              onClick={() => void onAutoConfigure()}
              className="inline-flex items-center gap-2 rounded border border-[var(--ti-orange-500)] bg-[var(--ti-orange-500)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--ti-orange-600)]"
            >
              {copied ? (
                <>
                  <CheckCircle2 size={12} />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Auto-configure
                </>
              )}
            </button>
            <p className="font-mono text-[10px] text-stone-500 dark:text-stone-400">
              Manual fallback below if you'd rather edit the file by hand.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Setup steps
// ----------------------------------------------------------------------------

// === wave 5-γ ===
/**
 * Translate every POSIX home-relative path token (`~/.cursor/mcp.json`,
 * `~/.claude/mcp_servers.json`, etc) inside a free-form prose string into
 * the OS-correct display form. macOS / Linux pass-through; Windows swaps to
 * `%USERPROFILE%\.<dir>\file`. The clipboard JSON snippet (rendered from
 * `step.code`) is intentionally NOT touched — Cursor / Claude Code / Codex
 * loaders accept the same JSON across OSes.
 *
 * The regex is intentionally narrow (`~/.<word>/...`) so we don't accidentally
 * mangle prose that happens to contain a `~/` literal in some other context.
 */
function translatePathsInProse(text: string): string {
  return text.replace(/~\/(\.[\w.-]+\/[\w./-]+)/g, (_match, rest) =>
    mcpConfigDisplayPath(`~/${rest}`),
  );
}

function SetupSteps({
  config,
  status,
}: {
  config: AIToolConfig;
  status: AIToolStatus | null;
}) {
  // Wave 4-C — when the auto-configure card is rendering (MCP tool
  // detected as installed), collapse the manual steps into a <details>
  // so the simple path is the obvious path. Returning users / users
  // who prefer the manual flow open the disclosure and see the full
  // 3-step list.
  const collapsible =
    config.channel === "mcp" &&
    status?.status === "installed" &&
    mcpConfigPathFor(config.id) !== null;

  const stepsList = (
    <ol className="mt-4 space-y-4">
      {config.setup_steps.map((step, idx) => (
        <li
          key={idx}
          className="flex gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ti-orange-500)] font-mono text-[11px] font-medium text-white">
            {idx + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
              {/* === wave 5-γ === translate ~/ paths in step titles too */}
              {translatePathsInProse(step.title)}
            </p>
            {step.body && (
              <p className="mt-1 text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
                {/* === wave 5-γ === */}
                {translatePathsInProse(step.body)}
              </p>
            )}
            {step.code && (
              <pre className="mt-2 overflow-x-auto rounded border border-stone-200 bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-800 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200">
                {step.code}
              </pre>
            )}
          </div>
        </li>
      ))}
    </ol>
  );

  if (collapsible) {
    return (
      <section className="mt-10" data-testid="ai-tool-setup-steps">
        <details className="group">
          <summary
            className="flex cursor-pointer items-center gap-2 text-base font-display text-stone-900 marker:hidden dark:text-stone-100"
            data-testid="ai-tool-manual-toggle"
          >
            <ChevronRight
              size={14}
              className="text-stone-500 transition-transform group-open:hidden"
            />
            <ChevronDown
              size={14}
              className="hidden text-stone-500 group-open:block"
            />
            Manual setup (3 steps)
          </summary>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            Skip this if you used Auto-configure above.
          </p>
          {stepsList}
        </details>
      </section>
    );
  }

  return (
    <section className="mt-10" data-testid="ai-tool-setup-steps">
      <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
        How to wire it up
      </h2>
      {stepsList}
    </section>
  );
}

// ----------------------------------------------------------------------------
// Test queries
// ----------------------------------------------------------------------------

interface TestQueryRecord {
  query: string;
  /** "loading" while we dispatch to the upstream tool, "done" once back. */
  state: "loading" | "done";
  /** Final answer text once `state === "done"` and `source !== "error"`. */
  answer?: string;
  /**
   * "real" when the answer came back from a real session-borrowed channel
   * (Ollama HTTP / MCP-stub canned response). "mock" when the channel is
   * not yet implemented (browser ext / IDE plugin) — we fall back to the
   * Phase 1 canned answer with a clear disclaimer.
   *
   * === wave 6 === added "error" — when no LLM channel is reachable in a
   * production Tauri build. Renders a real setup-help block instead of a
   * misleading mock answer.
   */
  source?: "real" | "mock" | "error";
  /** Channel reported by Rust (only set when `source === "real"`). */
  channel?: string;
  /** Tool id reported by Rust (only set when `source === "real"`). */
  toolId?: string;
  /** Round-trip latency (only set when `source === "real"`). */
  latencyMs?: number;
  /** Raw Rust error message (only set when `source === "error"`). */
  errorMessage?: string;
}

function TestQuerySection({ config }: { config: AIToolConfig }) {
  // Per-button history. Keyed by query index so re-clicking just re-runs.
  const [results, setResults] = useState<Record<number, TestQueryRecord>>({});

  const runQuery = async (idx: number, query: string) => {
    setResults((prev) => ({
      ...prev,
      [idx]: { query, state: "loading" },
    }));
    try {
      // v1.8 Phase 3-A: real session-borrowed dispatch. Pass the per-tool id
      // as the primary so this Test Query button always exercises the user's
      // intended channel (rather than whatever the global priority would
      // resolve to).
      const resp = await coThinkerDispatch(
        {
          system_prompt: "You are Tangerine, a team memory assistant.",
          user_prompt: query,
        },
        config.id,
      );
      setResults((prev) => ({
        ...prev,
        [idx]: {
          query,
          state: "done",
          answer: resp.text,
          source: "real",
          channel: resp.channel_used,
          toolId: resp.tool_id,
          latencyMs: resp.latency_ms,
        },
      }));
    } catch (e) {
      // Tauri returns AppError for `not_implemented` (browser ext / IDE
      // plugin tools) and `all_channels_exhausted`. We treat the former as
      // expected during Phase 3 and fall back to the canned mock answer
      // with a Phase-4 disclaimer.
      //
      // === wave 6 === — the latter (no LLM channel reachable) used to fall
      // through to the same mock answer, which LIED to the user about why the
      // call failed. We now render a real error card with setup guidance.
      const msg = e instanceof Error ? e.message : String(e);
      const isNotImplemented =
        /not_implemented|browser_ext|wires in Phase 4/i.test(msg);
      if (isNotImplemented) {
        setResults((prev) => ({
          ...prev,
          [idx]: {
            query,
            state: "done",
            answer: mockAnswer(query, config.name),
            source: "mock",
            channel: "browser_ext",
            toolId: config.id,
          },
        }));
      } else {
        // Real dispatch failure — no LLM channel reachable. Show the user how
        // to fix it instead of a fake "mock" answer.
        setResults((prev) => ({
          ...prev,
          [idx]: {
            query,
            state: "done",
            source: "error",
            toolId: config.id,
            errorMessage: msg,
          },
        }));
      }
    }
  };

  return (
    <section className="mt-10">
      <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
        Test it
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
        Click any button below to send the query through {config.name} via
        Tangerine.
      </p>

      <div className="mt-4 grid gap-2">
        {config.preset_queries.map((q, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => runQuery(idx, q)}
            className="group flex items-center gap-3 rounded-md border border-stone-200 bg-white p-3 text-left transition-colors hover:border-[var(--ti-orange-500)] hover:bg-orange-50/40 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-[var(--ti-orange-500)] dark:hover:bg-orange-950/20"
          >
            <span aria-hidden="true" className="text-base leading-none">
              🍊
            </span>
            <span className="flex-1 text-[13px] text-stone-800 dark:text-stone-200">
              {q}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-stone-400 group-hover:text-[var(--ti-orange-500)] dark:text-stone-500">
              Test query
            </span>
          </button>
        ))}
      </div>

      {/* Result cards stacked under the buttons. Most-recent click wins per slot. */}
      <div className="mt-4 space-y-3">
        {Object.entries(results).map(([key, rec]) => (
          <ResultCard key={key} record={rec} />
        ))}
      </div>
    </section>
  );
}

function ResultCard({ record }: { record: TestQueryRecord }) {
  // === wave 6 === — error variant has its own card style so the user can't
  // confuse a real failure with a successful (or mock) response.
  if (record.state === "done" && record.source === "error") {
    return (
      <div className="rounded-md border border-rose-300 bg-rose-50 p-4 dark:border-rose-900/50 dark:bg-rose-950/30">
        <p className="font-mono text-[10px] uppercase tracking-wider text-rose-600 dark:text-rose-400">
          Query failed
        </p>
        <p className="mt-1 text-[12px] text-stone-700 dark:text-stone-300">
          {record.query}
        </p>
        <div className="mt-3 border-t border-rose-200 pt-3 dark:border-rose-900/50">
          <p className="text-[13px] font-medium text-rose-900 dark:text-rose-100">
            All LLM channels failed.
          </p>
          <p className="mt-1 text-[12px] leading-relaxed text-rose-800 dark:text-rose-200">
            To use Tangerine's borrowed-LLM feature you need at least one of:
          </p>
          <ul className="mt-2 space-y-1 pl-5 text-[12px] leading-relaxed text-rose-800 dark:text-rose-200">
            <li className="list-disc">
              Install Cursor / Claude Code / Codex / Windsurf and add{" "}
              <code className="rounded bg-rose-100 px-1 py-0.5 font-mono text-[11px] text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
                TANGERINE_SAMPLING_BRIDGE=1
              </code>{" "}
              to that tool's MCP config (see the setup steps above), <strong>or</strong>
            </li>
            <li className="list-disc">
              Install Ollama at the default port (
              <code className="rounded bg-rose-100 px-1 py-0.5 font-mono text-[11px] text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
                localhost:11434
              </code>
              ) — Tangerine borrows your local model automatically.
            </li>
          </ul>
          {record.errorMessage && (
            <details className="mt-3">
              <summary className="cursor-pointer font-mono text-[10px] text-rose-600 hover:underline dark:text-rose-400">
                Show technical details
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-rose-100 p-2 font-mono text-[10px] text-rose-900 dark:bg-rose-900/40 dark:text-rose-100">
                {record.errorMessage}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
      <p className="font-mono text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
        Query
      </p>
      <p className="mt-1 text-[12px] text-stone-700 dark:text-stone-300">
        {record.query}
      </p>

      <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-800">
        {record.state === "loading" ? (
          <div className="flex items-center gap-2">
            <Loader2
              size={12}
              className="animate-spin text-stone-500 dark:text-stone-400"
            />
            <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
              Tangerine is thinking…
            </p>
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-stone-900 dark:text-stone-100">
              <span className="font-medium text-[var(--ti-orange-500)]">
                Tangerine:{" "}
              </span>
              {record.answer}
            </p>
            <ResultFooter record={record} />
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Per-result footer. Shows the borrowed-channel metadata when the dispatcher
 * actually returned a response, or a Phase-4 disclaimer when the channel
 * isn't implemented yet (browser ext / IDE plugin).
 */
function ResultFooter({ record }: { record: TestQueryRecord }) {
  if (record.source === "real") {
    return (
      <p className="mt-2 font-mono text-[10px] text-stone-400 dark:text-stone-500">
        via {record.toolId} ({record.channel}) ·{" "}
        {record.latencyMs !== undefined ? `${record.latencyMs}ms` : "—"}
      </p>
    );
  }
  if (record.source === "mock" && record.channel === "browser_ext") {
    return (
      <p className="mt-2 font-mono text-[10px] text-stone-400 dark:text-stone-500">
        Browser ext channel wires in Phase 4 polish.
      </p>
    );
  }
  return (
    <p className="mt-2 font-mono text-[10px] text-stone-400 dark:text-stone-500">
      Mock response — dispatcher unreachable.
    </p>
  );
}

/**
 * Fake response generator used until Phase 3 wires the real session borrower.
 * Picks a plausible-but-clearly-stub answer based on substring matches in
 * the query. Returns plain English; never a real fact.
 */
function mockAnswer(query: string, toolName: string): string {
  const q = query.toLowerCase();
  if (q.includes("上周") || q.includes("决定")) {
    return "上周共有 3 个决定 — (1) v1 scope 锁定 Discord + Claude Code 输出, (2) 周一例会强制 dogfood TMA, (3) Whisper CN 区延迟 1.2s 可接受。下次会议建议 follow-up 第三项。";
  }
  if (q.includes("david") || q.includes("david 开会")) {
    return "上次 David sync (2026-04-24) 留了一个 open question: Whisper CN 区延迟是否可接受。建议带上 latency benchmark 数据 + v1 scope decision 一并交付,避免重复讨论。";
  }
  if (q.includes("status") || q.includes("project")) {
    return "tangerine-teams-app 当前 v1.7.0-beta.3,Phase 1 backend 已 ship (commit 64cb0cc),frontend 正在并行实现 AI tools sidebar。下一里程碑:Phase 3 真实 session 借用。";
  }
  // Fallback: still tool-aware so the UI feels responsive on novel queries.
  return `(via ${toolName}) Tangerine 找到了相关上下文,但此为 Phase 1 mock 占位。Phase 3 将通过你已登录的 ${toolName} session 返回真实答案。`;
}
