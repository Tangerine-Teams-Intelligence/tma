/**
 * v3.0 §1 + §5 — Settings → Personal Agents tab.
 *
 * Lists every personal AI agent capture source (Cursor / Claude Code /
 * Codex / Windsurf) with:
 *   - detection status (`detected: true` ⇒ green dot; otherwise grey
 *     dot + "looking for X at <path>" hint)
 *   - per-source toggle (off by default — strict opt-in per spec §5.1)
 *   - "Sync now" button that fires a manual capture and reports
 *     `written / skipped / errors`
 *   - last successful sync time at the bottom of the card
 *
 * The Tauri bridge is the source of truth: on mount we call
 * `personal_agents_get_settings` to reconcile the zustand mirror with
 * what's on disk, then writes go through `personal_agents_set_watcher`
 * to the Rust side which immediately persists to
 * `<user_data>/personal_agents.json`.
 */

// === wave 5-α ===
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "@/lib/store";
import {
  personalAgentsScanAll,
  personalAgentsGetSettings,
  personalAgentsSetWatcher,
  personalAgentsCaptureCursor,
  personalAgentsCaptureClaudeCode,
  personalAgentsCaptureCodex,
  personalAgentsCaptureWindsurf,
  // === v3.0 wave 2 personal agents ===
  personalAgentsCaptureDevin,
  personalAgentsCaptureReplit,
  personalAgentsCaptureAppleIntelligence,
  personalAgentsCaptureMsCopilot,
  type PersonalAgentId,
  // === end v3.0 wave 2 personal agents ===
  type PersonalAgentSummary,
  type PersonalAgentCaptureResult,
  // === v1.14.5 round-6 ===
  type PersonalAgentDetectionStatus,
  // === end v1.14.5 round-6 ===
} from "@/lib/tauri";

// === wave 7 ===
// v1.9.3 honesty pass: per-parser validation status. Sourced from
// `app/src-tauri/src/personal_agents/PARSER_STATUS.md`. Only Claude Code
// has been validated against real session files; the other 7 are wired
// but unvalidated. Rendered as a badge next to each row's title so
// users know which parsers are production-confidence.
type ParserConfidence =
  | { kind: "validated" }
  | { kind: "unvalidated"; reason: string };

type AgentRow = {
  /** Atom dir name on disk — used as the row's react key + the source
   *  field on the summary. */
  atomDir: string;
  /** Toggle key in the persisted settings struct. */
  flagKey: PersonalAgentId;
  label: string;
  description: string;
  capture: (currentUser?: string) => Promise<PersonalAgentCaptureResult>;
  /** v1.9.3: parser validation status — drives the per-row badge. */
  confidence: ParserConfidence;
};

const AGENTS: AgentRow[] = [
  {
    atomDir: "cursor",
    flagKey: "cursor",
    label: "Cursor",
    description:
      "Reads Cursor conversations from %APPDATA%\\Cursor\\User\\conversations (Windows), ~/Library/Application Support/Cursor/User/conversations (macOS), or ~/.config/Cursor/User/conversations (Linux). Falls back to legacy ~/.cursor/conversations.",
    capture: personalAgentsCaptureCursor,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — Cursor not on validation machine yet.",
    },
  },
  {
    atomDir: "claude-code",
    flagKey: "claude_code",
    label: "Claude Code",
    description: "Reads ~/.claude/projects/<slug>/<session-uuid>.jsonl.",
    capture: personalAgentsCaptureClaudeCode,
    confidence: { kind: "validated" },
  },
  {
    atomDir: "codex",
    flagKey: "codex",
    label: "Codex CLI",
    description:
      "Reads Codex CLI sessions from %APPDATA%\\Codex\\sessions (Windows) or ~/.config/openai/sessions (macOS/Linux). Also probes ~/.codex/sessions (npm CLI install).",
    capture: personalAgentsCaptureCodex,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — Codex not on validation machine yet.",
    },
  },
  {
    atomDir: "windsurf",
    flagKey: "windsurf",
    label: "Windsurf",
    description:
      "Reads Windsurf sessions from ~/.codeium/windsurf/ (Codeium fork canonical) plus the platform Electron path: %APPDATA%\\Windsurf\\User on Windows, ~/Library/Application Support/Windsurf/User on macOS, ~/.config/Windsurf/User on Linux.",
    capture: personalAgentsCaptureWindsurf,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — Windsurf not on validation machine yet.",
    },
  },
  // === v3.0 wave 2 personal agents ===
  {
    atomDir: "devin",
    flagKey: "devin",
    label: "Devin",
    description:
      "Cognition Labs cloud agent. Webhook + REST poll fallback (token + secret in Settings).",
    capture: personalAgentsCaptureDevin,
    confidence: {
      kind: "unvalidated",
      reason: "API stub — exercised only via fixture payloads.",
    },
  },
  {
    atomDir: "replit",
    flagKey: "replit",
    label: "Replit Agent",
    description: "Replit cloud agent. REST poll (token in Settings, stub default).",
    capture: personalAgentsCaptureReplit,
    confidence: {
      kind: "unvalidated",
      reason: "API stub — exercised only via fixture payloads.",
    },
  },
  {
    atomDir: "apple-intelligence",
    flagKey: "apple_intelligence",
    label: "Apple Intelligence",
    description:
      "macOS Shortcuts post-action hook (Writing Tools / Image Playground / Genmoji). macOS only.",
    capture: personalAgentsCaptureAppleIntelligence,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — needs a macOS dev machine to validate.",
    },
  },
  {
    atomDir: "ms-copilot",
    flagKey: "ms_copilot",
    label: "MS Copilot (personal)",
    description:
      "Microsoft Copilot via Graph API. Enterprise license required — stub mode by default.",
    capture: personalAgentsCaptureMsCopilot,
    confidence: {
      kind: "unvalidated",
      reason: "API stub — needs an enterprise license + token to validate live.",
    },
  },
  // === end v3.0 wave 2 personal agents ===
];

// === v1.14.5 round-6 ===
/**
 * R6 status badge. Renders the structured detection status from
 * `personal_agents_scan_all` so users can tell "not installed" (silent
 * grey dot) from "installed but unreadable" (loud amber warning). The
 * trust-collapse case the R6 audit was scoped to surface: a user who
 * sees "I'm using Cursor every day but Tangerine has nothing from
 * Cursor" needs to know the problem is a perms denial, not a missing
 * install.
 */
function StatusBadge({
  status,
  fallbackDetected,
  conversationCount,
}: {
  status: PersonalAgentDetectionStatus | undefined;
  fallbackDetected: boolean;
  conversationCount: number;
}) {
  // Pre-R6 backend: derive a status from the legacy bool so the UI
  // doesn't blank out when called against an older Tauri build.
  const effective: PersonalAgentDetectionStatus = status ?? {
    kind: fallbackDetected ? "installed" : "not_installed",
  };
  switch (effective.kind) {
    case "installed":
      return (
        <span
          data-testid="st-personal-agent-status-installed"
          className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
          title={`Captured ${conversationCount} conversation${conversationCount === 1 ? "" : "s"}.`}
        >
          captured {conversationCount}
        </span>
      );
    case "access_denied":
      return (
        <span
          data-testid="st-personal-agent-status-access-denied"
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800 dark:border-amber-800/50 dark:bg-amber-950/30 dark:text-amber-300"
          title={`Permission denied — Tangerine can read the path but not its contents. ${effective.reason}`}
        >
          access denied
        </span>
      );
    case "platform_unsupported":
      return (
        <span
          data-testid="st-personal-agent-status-platform-unsupported"
          className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-100,#f3eee6)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-500)]"
          title={effective.reason}
        >
          platform unsupported
        </span>
      );
    case "remote_unconfigured":
      return (
        <span
          data-testid="st-personal-agent-status-remote-unconfigured"
          className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-500)]"
          title="Remote source — no captures yet. Configure a token / webhook to start."
        >
          awaiting first capture
        </span>
      );
    case "not_installed":
    default:
      return (
        <span
          data-testid="st-personal-agent-status-not-installed"
          className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-400)]"
          title="Source not installed on this machine."
        >
          not installed
        </span>
      );
  }
}
// === end v1.14.5 round-6 ===

/**
 * v1.9.3 per-row badge. Renders "Confirmed ✓" for validated parsers
 * (Claude Code) or "Beta — unvalidated" for the other 7. The tooltip
 * surfaces the validation reason from PARSER_STATUS.md.
 */
function ParserBadge({ confidence }: { confidence: ParserConfidence }) {
  if (confidence.kind === "validated") {
    return (
      <span
        title="Parser validated against real session files."
        className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:text-emerald-300"
      >
        Confirmed
      </span>
    );
  }
  return (
    <span
      title={`Beta. ${confidence.reason} Try it; report issues.`}
      className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300"
    >
      Beta
    </span>
  );
}
// === end wave 7 ===

export function PersonalAgentsSettings() {
  const { t } = useTranslation();
  const enabled = useStore((s) => s.ui.personalAgentsEnabled);
  const setPersonalAgentsEnabled = useStore((s) => s.ui.setPersonalAgentsEnabled);
  const togglePersonalAgent = useStore((s) => s.ui.togglePersonalAgent);
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [summaries, setSummaries] = useState<PersonalAgentSummary[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<Record<string, PersonalAgentCaptureResult | null>>(
    {},
  );

  const summaryByDir = useMemo(() => {
    const map = new Map<string, PersonalAgentSummary>();
    for (const s of summaries) map.set(s.source, s);
    return map;
  }, [summaries]);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const [scan, settings] = await Promise.all([
          personalAgentsScanAll(),
          personalAgentsGetSettings(),
        ]);
        if (cancel) return;
        setSummaries(scan);
        setPersonalAgentsEnabled({
          cursor: settings.cursor,
          claude_code: settings.claude_code,
          codex: settings.codex,
          windsurf: settings.windsurf,
          // === v3.0 wave 2 personal agents ===
          devin: settings.devin,
          replit: settings.replit,
          apple_intelligence: settings.apple_intelligence,
          ms_copilot: settings.ms_copilot,
          // === end v3.0 wave 2 personal agents ===
        });
        setLastSyncAt(settings.last_sync_at ?? null);
      } catch (e) {
        // Silent — Settings still renders the rows in the "not detected"
        // state when the bridge is missing (vitest / browser dev).
        if (!cancel) {
          // eslint-disable-next-line no-console
          console.warn("[personal-agents] hydrate failed", e);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setPersonalAgentsEnabled]);

  async function onToggle(row: AgentRow, next: boolean) {
    // Optimistic local flip — the persisted write below is the truth.
    togglePersonalAgent(row.flagKey, next);
    try {
      const updated = await personalAgentsSetWatcher(row.flagKey, next);
      // Reconcile with disk truth in case another tab raced us.
      setPersonalAgentsEnabled({
        cursor: updated.cursor,
        claude_code: updated.claude_code,
        codex: updated.codex,
        windsurf: updated.windsurf,
        // === v3.0 wave 2 personal agents ===
        devin: updated.devin,
        replit: updated.replit,
        apple_intelligence: updated.apple_intelligence,
        ms_copilot: updated.ms_copilot,
        // === end v3.0 wave 2 personal agents ===
      });
      setLastSyncAt(updated.last_sync_at ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${t("settings.personalAgents.toggleFailed")} ${msg}`);
      // Roll back the optimistic flip.
      togglePersonalAgent(row.flagKey, !next);
    }
  }

  async function onSyncNow(row: AgentRow) {
    setBusy((b) => ({ ...b, [row.flagKey]: true }));
    try {
      const result = await row.capture(currentUser);
      setLastResult((r) => ({ ...r, [row.flagKey]: result }));
      const headline =
        result.errors.length > 0
          ? t("settings.personalAgents.syncedHeadlineErrors", { count: result.errors.length })
          : t("settings.personalAgents.syncedHeadline", { written: result.written, skipped: result.skipped });
      pushToast(result.errors.length ? "error" : "success", `${row.label}: ${headline}`);
      // Refresh detection counts so the row's "N conversations" line
      // stays in sync with disk after a write pass.
      try {
        setSummaries(await personalAgentsScanAll());
      } catch {
        // Silent — best-effort.
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${row.label}: ${t("settings.personalAgents.syncFailed")} ${msg}`);
    } finally {
      setBusy((b) => ({ ...b, [row.flagKey]: false }));
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="st-personal-agents">
      <section>
        <h3 className="font-display text-lg">{t("settings.personalAgents.heading")}</h3>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ti-ink-500)]">
          {t("settings.personalAgents.intro")}{" "}
          <code className="font-mono text-xs">
            personal/{currentUser}/threads/&lt;agent&gt;/
          </code>
          {t("settings.personalAgents.introTail")}
        </p>
      </section>

      <ul className="flex flex-col gap-3">
        {AGENTS.map((row) => {
          const summary = summaryByDir.get(row.atomDir);
          const detected = summary?.detected ?? false;
          const conversationCount = summary?.conversation_count ?? 0;
          const homePath = summary?.home_path ?? "(unknown)";
          const isOn = enabled[row.flagKey];
          const last = lastResult[row.flagKey];
          return (
            <li
              key={row.flagKey}
              data-testid={`st-personal-agent-row-${row.flagKey}`}
              className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-4 py-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    {/* === v1.14.5 round-6 === — dot color now reflects
                        the structured status: green = installed, amber =
                        access denied (the trust-collapse case the R6
                        audit was scoped to surface), grey = not
                        installed / awaiting first remote capture. */}
                    <span
                      aria-hidden
                      className={
                        "inline-block h-2 w-2 rounded-full " +
                        (summary?.status?.kind === "access_denied"
                          ? "bg-amber-500"
                          : detected
                            ? "bg-[var(--ti-success-500,#3a8c5a)]"
                            : "bg-[var(--ti-ink-400,#8c8c93)]")
                      }
                    />
                    {/* === end v1.14.5 round-6 === */}
                    <h4 className="font-display text-base">{row.label}</h4>
                    {/* === wave 7 === parser confidence badge */}
                    <ParserBadge confidence={row.confidence} />
                    {/* === v1.14.5 round-6 === structured status badge */}
                    <StatusBadge
                      status={summary?.status}
                      fallbackDetected={detected}
                      conversationCount={conversationCount}
                    />
                    {/* === end v1.14.5 round-6 === */}
                    <span className="text-xs text-[var(--ti-ink-500)]">
                      {detected
                        ? conversationCount === 1
                          ? t("settings.personalAgents.detectedSingular", { count: 1 })
                          : t("settings.personalAgents.detectedPlural", { count: conversationCount })
                        : t("settings.personalAgents.notDetected")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--ti-ink-500)]">{row.description}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--ti-ink-400)]">
                    {detected ? `${t("settings.personalAgents.readingFrom")} ` : `${t("settings.personalAgents.lookingAt")} `}
                    {homePath}
                  </p>
                  {last && (
                    <p className="mt-2 text-xs text-[var(--ti-ink-500)]">
                      {t("settings.personalAgents.lastSyncWrote")} <strong>{last.written}</strong>, {t("settings.personalAgents.skipped")}{" "}
                      <strong>{last.skipped}</strong>
                      {last.errors.length > 0 && (
                        <>
                          {`, ${t("settings.personalAgents.errors")} `}
                          <span className="text-[var(--ti-danger)]">{last.errors.length}</span>
                        </>
                      )}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={isOn}
                      onChange={(e) => void onToggle(row, e.target.checked)}
                      data-testid={`st-personal-agent-toggle-${row.flagKey}`}
                    />
                    <span>{isOn ? t("settings.personalAgents.on") : t("settings.personalAgents.off")}</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => void onSyncNow(row)}
                    disabled={busy[row.flagKey] || !detected}
                    data-testid={`st-personal-agent-sync-${row.flagKey}`}
                    className={
                      "rounded-md border border-[var(--ti-border-default)] px-3 py-1 text-xs transition-colors " +
                      (detected
                        ? "hover:bg-[var(--ti-paper-100,#f3eee6)]"
                        : "cursor-not-allowed opacity-50")
                    }
                    title={detected ? t("settings.personalAgents.syncTooltip") : t("settings.personalAgents.syncTooltipNotDetected")}
                  >
                    {busy[row.flagKey] ? t("settings.personalAgents.syncing") : t("settings.personalAgents.syncNow")}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="text-xs text-[var(--ti-ink-500)]">
        {lastSyncAt ? (
          <p>
            {t("settings.personalAgents.lastSuccessful")} <strong>{new Date(lastSyncAt).toLocaleString()}</strong>
          </p>
        ) : (
          <p>{t("settings.personalAgents.noCaptures")}</p>
        )}
      </section>
    </div>
  );
}

export default PersonalAgentsSettings;
// === end wave 5-α ===
