// === v1.15.0 wave 1.2 ===
/**
 * W1.2 — AI tool detection grid for the onboarding wizard's
 * "Connect AI tool" step (rendered at /setup/connect).
 *
 * Renders one card per supported tool (8 total). Each card shows:
 *   - structured detection status from `personal_agents_scan_all`
 *     (R6 PersonalAgentDetectionStatus tagged enum) via the existing
 *     <StatusBadge/>-style chip rendered inline below
 *   - one CTA driven by the detection status:
 *       Detected      → "Auto-configure" (calls W1.3 command, then
 *                        polls handshake until Connected ✓ or 30s)
 *       NotInstalled  → "Get [tool] →" external link via openExternal
 *       AccessDenied  → reason chip + "Retry" (re-runs scan)
 *   - post-configure UI states driven by handshake polling:
 *       "Waiting for restart" while polling
 *       "Connected ✓"          on first true
 *       "Restart [tool] to finish setup" on 30s timeout
 *
 * Honesty contract (R6/R7 lessons):
 *   - We never display Connected ✓ unless `mcp_server_handshake`
 *     returned true at least once.
 *   - Auto-configure failures surface the raw error via toast and a
 *     loud red banner on the card; the badge stays at "Detected" (not
 *     advanced to "Waiting for restart").
 *   - If `personal_agents_scan_all` itself throws we render an
 *     ErrorState row instead of silently empty.
 *
 * Display order (per W1.2 spec):
 *   1. Detected tools first (top)
 *   2. Remaining tools by US/EU developer market share, descending:
 *        Cursor → Claude Code → Codex → Windsurf → Devin → Replit
 *        → Apple Intelligence → MS Copilot
 *
 * A11y:
 *   - Each card is a focusable region with `role="group"` + ARIA
 *     label tying status copy to the card's heading.
 *   - Tab/Shift-Tab moves between cards; Enter activates the primary
 *     CTA on the focused card; Esc bubbles up to the route wrapper
 *     which navigates back to the wizard.
 *
 * The grid is dependency-light on purpose: it reads from
 * `personalAgentsScanAll` + `setupWizardAutoConfigureMcp` +
 * `mcpServerHandshake` (all wired in lib/tauri.ts) and emits one
 * telemetry event (`mcp_connected`, registered in W1.4) on success.
 * It does NOT mutate the zustand store — W1.1 owns that surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  AlertCircle,
  ExternalLink,
  Loader2,
  RefreshCw,
  Wand2,
} from "lucide-react";
import {
  personalAgentsScanAll,
  setupWizardAutoConfigureMcp,
  mcpServerHandshake,
  openExternal,
  type PersonalAgentSummary,
  type PersonalAgentDetectionStatus,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

// ----------------------------------------------------------------------------
// Catalog
// ----------------------------------------------------------------------------

/** Tool descriptor. `sourceKey` matches the `source` field returned by
 *  `personal_agents_scan_all` so we can join detection status by key.
 *  `installUrl` is the official "Get this tool" landing page used for
 *  the NotInstalled CTA. */
export interface AIToolDescriptor {
  /** Stable tool id used for telemetry, command args, test ids. */
  id: string;
  /** Display name shown on the card heading. */
  name: string;
  /** Matches `PersonalAgentSummary.source`. */
  sourceKey: string;
  /** Official install / signup URL (opened via `openExternal`). */
  installUrl: string;
  /** US/EU developer market share rank (1 = largest). Used for the
   *  NotInstalled fallback ordering when no tool is detected. */
  marketRank: number;
  /** v1.15.1 — diagnostic-only display string showing where Tangerine
   *  writes the MCP entry for this tool. The user sees this as a small
   *  monospace caption under the card heading so they can verify the
   *  file lives where their AI tool actually reads from (the Daizhe
   *  v1.15.0 trust-collapse: Tangerine wrote to `~/.claude/mcp_servers
   *  .json`, CC reads `~/.claude.json`). Use the `~` prefix shorthand
   *  for HOME. */
  configPathHint: string;
}

/** 8 tools per W1.2 spec. Order in this array == market rank for the
 *  fallback sort. Detected tools jump to the top regardless of rank. */
export const AI_TOOL_CATALOG: readonly AIToolDescriptor[] = [
  { id: "cursor", name: "Cursor", sourceKey: "cursor", installUrl: "https://www.cursor.com/", marketRank: 1, configPathHint: "~/.cursor/mcp.json" },
  { id: "claude-code", name: "Claude Code", sourceKey: "claude-code", installUrl: "https://www.anthropic.com/claude-code", marketRank: 2, configPathHint: "~/.claude.json" },
  { id: "codex", name: "Codex", sourceKey: "codex", installUrl: "https://github.com/openai/codex", marketRank: 3, configPathHint: "~/.codex/config.toml" },
  { id: "windsurf", name: "Windsurf", sourceKey: "windsurf", installUrl: "https://codeium.com/windsurf", marketRank: 4, configPathHint: "~/.codeium/windsurf/mcp_config.json" },
  { id: "devin", name: "Devin", sourceKey: "devin", installUrl: "https://devin.ai/", marketRank: 5, configPathHint: "OS keychain (tangerine.tool.devin)" },
  { id: "replit", name: "Replit", sourceKey: "replit", installUrl: "https://replit.com/", marketRank: 6, configPathHint: "OS keychain (tangerine.tool.replit)" },
  { id: "apple-intelligence", name: "Apple Intelligence", sourceKey: "apple-intelligence", installUrl: "https://www.apple.com/apple-intelligence/", marketRank: 7, configPathHint: "(macOS only — pending Apple notarisation)" },
  { id: "ms-copilot", name: "MS Copilot", sourceKey: "ms-copilot", installUrl: "https://copilot.microsoft.com/", marketRank: 8, configPathHint: "(Windows only — pending MS Partner sign-off)" },
] as const;

// ----------------------------------------------------------------------------
// Per-card lifecycle state
// ----------------------------------------------------------------------------

/** Phases drive the CTA + chip combo on a single card. Keep flat so
 *  React diffing stays cheap and tests can assert on `data-phase`. */
type CardPhase =
  | { kind: "idle" }                  // Initial render — show detection-driven CTA
  | { kind: "configuring" }           // setup_wizard_auto_configure_mcp in flight
  | { kind: "waiting_restart"; startedAt: number } // Polling mcp_server_handshake
  | { kind: "connected" }             // Handshake returned true
  | { kind: "restart_timeout" }       // 30s elapsed without true handshake
  | { kind: "error"; message: string }; // Auto-configure failed loudly

/** Polling interval. 3s per W1.2 spec. */
const HANDSHAKE_POLL_MS = 3000;
/** Max time before we give up and tell user to restart manually. */
const HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * Wave 4 wire-up — coarse error classifier for `onboarding_mcp_failed`
 * telemetry. We bucket by substring rather than parse a structured error
 * because the W1.3 Rust handlers return free-text error messages
 * (`Cannot write ~/.claude.json: permission denied`, `~/.claude.json
 * malformed: ...`, `PlatformUnsupported: ...`). Keep this list short —
 * "other" is fine; we just want "permission_denied" rate vs "malformed"
 * rate vs "platform_unsupported" rate visible in the funnel.
 */
function classifyMcpError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes("permission")) return "permission_denied";
  if (m.includes("malformed") || m.includes("parse")) return "malformed_config";
  if (m.includes("platformunsupported") || m.includes("platform_unsupported"))
    return "platform_unsupported";
  if (m.includes("not found") || m.includes("does not exist")) return "not_found";
  if (m.includes("timeout")) return "timeout";
  if (m.includes("bridge")) return "bridge_error";
  return "other";
}

// ----------------------------------------------------------------------------
// Display helpers
// ----------------------------------------------------------------------------

/** Stable sort: detected first (in market rank order), then everyone
 *  else (in market rank order). */
function sortToolsForDisplay(
  tools: readonly AIToolDescriptor[],
  statusByKey: Map<string, PersonalAgentDetectionStatus>,
): AIToolDescriptor[] {
  const ranked = [...tools].sort((a, b) => a.marketRank - b.marketRank);
  const detected: AIToolDescriptor[] = [];
  const undetected: AIToolDescriptor[] = [];
  for (const t of ranked) {
    if (statusByKey.get(t.sourceKey)?.kind === "installed") detected.push(t);
    else undetected.push(t);
  }
  return [...detected, ...undetected];
}

// ----------------------------------------------------------------------------
// Status chip
// ----------------------------------------------------------------------------

function StatusChip({ status }: { status: PersonalAgentDetectionStatus | undefined }) {
  const effective: PersonalAgentDetectionStatus = status ?? { kind: "not_installed" };
  switch (effective.kind) {
    case "installed":
      return (
        <span
          data-testid="grid-chip-installed"
          className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
        >
          <CheckCircle2 size={10} aria-hidden /> Detected
        </span>
      );
    case "access_denied":
      return (
        <span
          data-testid="grid-chip-access-denied"
          title={effective.reason}
          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300"
        >
          <AlertCircle size={10} aria-hidden /> Access denied
        </span>
      );
    case "platform_unsupported":
      return (
        <span
          data-testid="grid-chip-platform-unsupported"
          title={effective.reason}
          className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400"
        >
          Platform unsupported
        </span>
      );
    case "remote_unconfigured":
      return (
        <span
          data-testid="grid-chip-remote-unconfigured"
          className="inline-flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400"
        >
          Remote — not configured
        </span>
      );
    case "not_installed":
    default:
      return (
        <span
          data-testid="grid-chip-not-installed"
          className="inline-flex items-center gap-1 rounded border border-stone-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400"
        >
          <Circle size={10} aria-hidden /> Not installed
        </span>
      );
  }
}

// ----------------------------------------------------------------------------
// Single card
// ----------------------------------------------------------------------------

interface CardProps {
  tool: AIToolDescriptor;
  status: PersonalAgentDetectionStatus | undefined;
  onRetryScan: () => void;
}

function ToolCard({ tool, status, onRetryScan }: CardProps) {
  const pushToast = useStore((s) => s.ui.pushToast);
  const [phase, setPhase] = useState<CardPhase>({ kind: "idle" });
  // Track in-flight polling so we can cancel on unmount + on success.
  const pollTimerRef = useRef<number | null>(null);
  const timeoutTimerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (timeoutTimerRef.current !== null) {
      window.clearTimeout(timeoutTimerRef.current);
      timeoutTimerRef.current = null;
    }
  }, []);

  // Cleanup on unmount — leaving polling timers running would leak
  // intervals into the next route mount.
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Status changes from upstream re-scan reset the per-card phase to
  // idle so the CTA re-derives from the new status. We do this only
  // on transitions from non-installed → installed (or vice versa); a
  // mid-poll status flip should NOT clobber an in-flight handshake.
  useEffect(() => {
    if (phase.kind === "configuring" || phase.kind === "waiting_restart") return;
    setPhase({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.kind]);

  /** Begin polling `mcp_server_handshake` every 3s with a 30s ceiling.
   *  Stops the moment a `true` lands or the timeout fires. */
  const startHandshakePolling = useCallback(() => {
    setPhase({ kind: "waiting_restart", startedAt: Date.now() });
    const poll = async () => {
      try {
        const ok = await mcpServerHandshake(tool.id);
        if (ok) {
          stopPolling();
          setPhase({ kind: "connected" });
          pushToast("success", `${tool.name} connected.`);
          // Wave 4 wire-up: `mcp_connected` is now in the
          // TelemetryEventName union (Wave 1.4 block) — cast removed.
          void logEvent("mcp_connected", { tool_id: tool.id });
        }
      } catch (e) {
        // Honesty rule: a thrown handshake is a real error, not a
        // "still waiting". Surface it loudly and stop the poll —
        // otherwise we'd keep retrying against a broken bridge and
        // mask the underlying problem.
        stopPolling();
        const msg = e instanceof Error ? e.message : String(e);
        setPhase({ kind: "error", message: msg });
        pushToast("error", `${tool.name} handshake failed: ${msg}`);
      }
    };
    // First probe immediately so a fast restart shows up without a 3s
    // wait. Then schedule the recurring poll.
    void poll();
    pollTimerRef.current = window.setInterval(() => void poll(), HANDSHAKE_POLL_MS);
    timeoutTimerRef.current = window.setTimeout(() => {
      stopPolling();
      setPhase((curr) => {
        if (curr.kind === "waiting_restart") {
          // Wave 4 wire-up — emit timeout telemetry (analytics) so we
          // can compute "% of users who never restart their AI tool"
          // and tune the restart prompt copy.
          void logEvent("onboarding_mcp_timeout", {
            tool_id: tool.id,
            elapsed_ms: HANDSHAKE_TIMEOUT_MS,
          });
          return { kind: "restart_timeout" };
        }
        return curr;
      });
    }, HANDSHAKE_TIMEOUT_MS);
  }, [pushToast, stopPolling, tool.id, tool.name]);

  const onAutoConfigure = useCallback(async () => {
    setPhase({ kind: "configuring" });
    try {
      const result = await setupWizardAutoConfigureMcp(tool.id);
      // The W1.3 contract returns `{ ok, error }`; honor it instead of
      // assuming success on a non-throw. Mock returns `ok: true`.
      if (!result.ok) {
        const msg = result.error ?? "Auto-configure failed";
        setPhase({ kind: "error", message: msg });
        pushToast("error", `${tool.name}: ${msg}`);
        // Wave 4 wire-up — emit configure-failed telemetry. R6/R7/R8
        // honesty: we know the configure failed, surface it loudly to
        // analytics too, not just the user.
        void logEvent("onboarding_mcp_failed", {
          tool_id: tool.id,
          error_class: classifyMcpError(msg),
        });
        return;
      }
      pushToast(
        "success",
        `${tool.name} configured. Restart ${tool.name} to finish setup.`,
      );
      startHandshakePolling();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg });
      pushToast("error", `${tool.name}: ${msg}`);
      void logEvent("onboarding_mcp_failed", {
        tool_id: tool.id,
        error_class: classifyMcpError(msg),
      });
    }
  }, [pushToast, startHandshakePolling, tool.id, tool.name]);

  const onGetTool = useCallback(async () => {
    try {
      await openExternal(tool.installUrl);
    } catch {
      // openExternal already falls back to window.open — if even that
      // fails we still want the user to know.
      pushToast("error", `Couldn't open ${tool.installUrl}`);
    }
  }, [pushToast, tool.installUrl]);

  const onRetry = useCallback(() => {
    setPhase({ kind: "idle" });
    onRetryScan();
  }, [onRetryScan]);

  // Map phase → primary CTA. Detection status drives the idle-state CTA;
  // active phases (configuring / waiting / connected / timeout / error)
  // override regardless of detection so the user sees the operation in
  // progress even if the underlying scan flips mid-flow.
  const cta = renderCta({
    phase,
    status,
    onAutoConfigure,
    onGetTool,
    onRetry,
    tool,
    onRestartHandshake: startHandshakePolling,
  });

  return (
    <li
      role="group"
      aria-label={`${tool.name} setup`}
      data-testid={`grid-card-${tool.id}`}
      data-phase={phase.kind}
      className="flex flex-col gap-3 rounded-md border border-stone-200 bg-white p-4 focus-within:border-[var(--ti-orange-500)] dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3
            id={`grid-card-title-${tool.id}`}
            className="font-display text-sm text-stone-900 dark:text-stone-100"
          >
            {tool.name}
          </h3>
          {/* v1.15.1 — diagnostic line. Shows the user EXACTLY where
              Tangerine writes (or will write) the MCP entry for this
              tool. R6/R7/R8 trust extension: not just honest UI, but
              auditable behavior. The Daizhe v1.15.0 trust-collapse
              ("you wrote nothing") was actually a path mismatch
              between Tangerine and CC; this caption surfaces that
              ground truth so users can verify on disk. */}
          <p
            data-testid={`grid-config-path-${tool.id}`}
            title={`Tangerine writes the MCP entry for ${tool.name} here.`}
            className="mt-0.5 truncate font-mono text-[10px] text-stone-400 dark:text-stone-500"
          >
            {tool.configPathHint}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StatusChip status={status} />
            {phase.kind === "waiting_restart" && (
              <span
                data-testid={`grid-state-waiting-${tool.id}`}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-stone-500 dark:text-stone-400"
              >
                <Loader2 size={10} className="animate-spin" aria-hidden /> Waiting for restart…
              </span>
            )}
            {phase.kind === "connected" && (
              <span
                data-testid={`grid-state-connected-${tool.id}`}
                className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
              >
                <CheckCircle2 size={10} aria-hidden /> Connected
              </span>
            )}
            {phase.kind === "restart_timeout" && (
              <span
                data-testid={`grid-state-timeout-${tool.id}`}
                className="inline-flex items-center gap-1 font-mono text-[10px] text-amber-700 dark:text-amber-300"
              >
                Restart {tool.name} to finish setup.
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0">{cta}</div>
      </div>

      {phase.kind === "error" && (
        <p
          data-testid={`grid-state-error-${tool.id}`}
          className="rounded border border-rose-200 bg-rose-50 p-2 font-mono text-[10px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
        >
          {phase.message}
        </p>
      )}

      {status?.kind === "access_denied" && (
        <p
          data-testid={`grid-card-reason-${tool.id}`}
          className="rounded border border-amber-200 bg-amber-50 p-2 font-mono text-[10px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
        >
          {(status as { kind: "access_denied"; reason: string }).reason}
        </p>
      )}
    </li>
  );
}

// ----------------------------------------------------------------------------
// CTA renderer (split out so the JSX above stays scannable)
// ----------------------------------------------------------------------------

interface CtaProps {
  phase: CardPhase;
  status: PersonalAgentDetectionStatus | undefined;
  tool: AIToolDescriptor;
  onAutoConfigure: () => void;
  onGetTool: () => void;
  onRetry: () => void;
  onRestartHandshake: () => void;
}

function renderCta(p: CtaProps) {
  const { phase, status, tool, onAutoConfigure, onGetTool, onRetry, onRestartHandshake } = p;

  // Active phases override the status-driven CTA.
  if (phase.kind === "configuring") {
    return (
      <button
        type="button"
        disabled
        data-testid={`grid-cta-configuring-${tool.id}`}
        className="inline-flex items-center gap-1 rounded border border-stone-300 bg-stone-100 px-2 py-1 font-mono text-[11px] text-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-400"
      >
        <Loader2 size={11} className="animate-spin" aria-hidden /> Configuring…
      </button>
    );
  }
  if (phase.kind === "waiting_restart") {
    return (
      <span
        data-testid={`grid-cta-waiting-${tool.id}`}
        className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 dark:text-stone-400"
      >
        <Loader2 size={11} className="animate-spin" aria-hidden /> Waiting for {tool.name}…
      </span>
    );
  }
  if (phase.kind === "connected") {
    return (
      <span
        data-testid={`grid-cta-connected-${tool.id}`}
        className="inline-flex items-center gap-1 rounded border border-emerald-300 bg-emerald-50 px-2 py-1 font-mono text-[11px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
      >
        <CheckCircle2 size={11} aria-hidden /> Connected
      </span>
    );
  }
  if (phase.kind === "restart_timeout") {
    return (
      <button
        type="button"
        onClick={onRestartHandshake}
        data-testid={`grid-cta-retry-handshake-${tool.id}`}
        aria-label={`Retry connecting ${tool.name}`}
        className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[11px] text-amber-800 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <RefreshCw size={11} aria-hidden /> Retry
      </button>
    );
  }
  if (phase.kind === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        data-testid={`grid-cta-retry-${tool.id}`}
        aria-label={`Retry ${tool.name} detection`}
        className="inline-flex items-center gap-1 rounded border border-rose-300 bg-rose-50 px-2 py-1 font-mono text-[11px] text-rose-800 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
      >
        <RefreshCw size={11} aria-hidden /> Retry
      </button>
    );
  }

  // Idle — drive from detection status.
  const kind = status?.kind ?? "not_installed";
  if (kind === "installed") {
    return (
      <button
        type="button"
        onClick={onAutoConfigure}
        data-testid={`grid-cta-auto-configure-${tool.id}`}
        aria-label={`Auto-configure ${tool.name}`}
        aria-describedby={`grid-card-title-${tool.id}`}
        className="inline-flex items-center gap-1 rounded border border-[var(--ti-orange-500)] bg-[var(--ti-orange-500)] px-2 py-1 font-mono text-[11px] font-medium text-white hover:bg-[var(--ti-orange-600)]"
      >
        <Wand2 size={11} aria-hidden /> Auto-configure
      </button>
    );
  }
  if (kind === "access_denied") {
    return (
      <button
        type="button"
        onClick={onRetry}
        data-testid={`grid-cta-retry-${tool.id}`}
        aria-label={`Retry ${tool.name} detection`}
        className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 font-mono text-[11px] text-amber-800 hover:bg-amber-100 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200"
      >
        <RefreshCw size={11} aria-hidden /> Retry
      </button>
    );
  }
  // not_installed / platform_unsupported / remote_unconfigured all surface
  // the install link — for remote sources this still makes sense (it's the
  // signup page).
  return (
    <button
      type="button"
      onClick={onGetTool}
      data-testid={`grid-cta-get-${tool.id}`}
      aria-label={`Get ${tool.name}`}
      className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white px-2 py-1 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
    >
      Get {tool.name} <ExternalLink size={11} aria-hidden />
    </button>
  );
}

// ----------------------------------------------------------------------------
// Top-level grid
// ----------------------------------------------------------------------------

export interface AIToolDetectionGridProps {
  /** Optional: parent route uses this to navigate back on Esc. */
  onEscape?: () => void;
}

export default function AIToolDetectionGrid({ onEscape }: AIToolDetectionGridProps) {
  const [summaries, setSummaries] = useState<PersonalAgentSummary[]>([]);
  const [scanError, setScanError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Bumping `scanNonce` triggers a re-scan via the effect below. Used by
  // per-card Retry (access_denied) so a single tool's denial fix can
  // refresh the entire grid.
  const [scanNonce, setScanNonce] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setScanError(null);
    void (async () => {
      try {
        const rows = await personalAgentsScanAll();
        if (cancel) return;
        setSummaries(rows);
      } catch (e) {
        if (cancel) return;
        setScanError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [scanNonce]);

  const onRetryScan = useCallback(() => setScanNonce((n) => n + 1), []);

  const statusByKey = useMemo(() => {
    const m = new Map<string, PersonalAgentDetectionStatus>();
    for (const s of summaries) {
      // R6 PersonalAgentSummary.status is optional for back-compat —
      // derive a synthetic kind from the legacy `detected` bool when
      // the Rust side hasn't shipped the structured field yet.
      const synthetic: PersonalAgentDetectionStatus = s.detected
        ? { kind: "installed" }
        : { kind: "not_installed" };
      m.set(s.source, s.status ?? synthetic);
    }
    return m;
  }, [summaries]);

  const sorted = useMemo(
    () => sortToolsForDisplay(AI_TOOL_CATALOG, statusByKey),
    [statusByKey],
  );

  // Esc handler — bubbles up to the route wrapper so it can navigate
  // back to the wizard. We keep this on the section root rather than
  // window-level so multiple grids on a page can't fight over it.
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape" && onEscape) {
      e.preventDefault();
      onEscape();
    }
  };

  if (loading) {
    return (
      <section
        data-testid="ai-tool-detection-grid"
        data-state="loading"
        className="flex items-center gap-2 p-4 font-mono text-[11px] text-stone-500"
      >
        <Loader2 size={12} className="animate-spin" aria-hidden /> Scanning AI tools…
      </section>
    );
  }

  if (scanError) {
    return (
      <section
        data-testid="ai-tool-detection-grid"
        data-state="error"
        className="rounded-md border border-rose-200 bg-rose-50 p-4 dark:border-rose-900/50 dark:bg-rose-950/30"
      >
        <p className="text-[12px] font-medium text-rose-900 dark:text-rose-100">
          Couldn't scan AI tools.
        </p>
        <p className="mt-1 font-mono text-[10px] text-rose-700 dark:text-rose-300">
          {scanError}
        </p>
        <button
          type="button"
          onClick={onRetryScan}
          data-testid="ai-tool-detection-grid-retry"
          className="mt-2 inline-flex items-center gap-1 rounded border border-rose-300 bg-white px-2 py-1 font-mono text-[11px] text-rose-700 hover:bg-rose-100 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-200"
        >
          <RefreshCw size={11} aria-hidden /> Retry scan
        </button>
      </section>
    );
  }

  return (
    <section
      data-testid="ai-tool-detection-grid"
      data-state="ready"
      role="region"
      aria-label="Connect an AI tool"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="flex flex-col gap-3"
    >
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {sorted.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            status={statusByKey.get(tool.sourceKey)}
            onRetryScan={onRetryScan}
          />
        ))}
      </ul>
    </section>
  );
}
// === end v1.15.0 wave 1.2 ===
