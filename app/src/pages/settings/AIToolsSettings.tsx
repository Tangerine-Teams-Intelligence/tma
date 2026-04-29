/**
 * v1.15.2 fix-6 — Merged "AI 工具" Settings tab.
 *
 * Pre-fix this tab showed only the wave-11 "Primary AI tool" picker,
 * while the v1.15 8-tool capture grid lived behind 显示高级设置 →
 * 个人 AI 工具. Two competing truths confused dogfood. v1.15.2 fix-6
 * merges them into ONE surface:
 *
 *   ┌─────────────────────────────────────────────────────────┐
 *   │ Primary channel: [tool dropdown]                        │
 *   │   Tangerine borrows this tool's LLM for co-thinker.     │
 *   │   Falls through priority order if unreachable.          │
 *   ├─────────────────────────────────────────────────────────┤
 *   │ Capture sources                                         │
 *   │   Which AI tools' conversations Tangerine reads.        │
 *   │   ┌── Cursor       [Beta]    [not installed]   [off]    │
 *   │   ├── Claude Code  [Confirmed][captured 55]    [on]     │
 *   │   ├── Codex CLI    [Beta]    [not installed]   [off]    │
 *   │   └── ...                                               │
 *   └─────────────────────────────────────────────────────────┘
 *
 * Wave-11 store keys preserved for back-compat:
 *   - `primaryAITool` (this picker writes it)
 *   - `setupWizardPrimaryChannel` (untouched — only SetupWizard writes it)
 *   - `personalAgentsEnabled` (the capture grid toggles it)
 *
 * The legacy stand-alone Primary-AI-tool picker (the wave-11 layout that
 * shipped pre-1.15.2) is preserved as `_LegacyAIToolsPicker` below for
 * reference but is NOT exported and NOT mounted anywhere — equivalent to
 * Rust's `#[allow(dead_code)]`. Delete after one ship cycle if no one
 * needs to compare against it.
 */

// === wave 5-α === — leftover personal-agents imports kept verbatim
// because the merged tab now embeds the same capture-grid behavior.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  AI_TOOL_PRIORITY,
  type AIToolStatus,
  loadAITools,
  pickPrimary,
} from "@/lib/ai-tools";
import {
  personalAgentsScanAll,
  personalAgentsGetSettings,
  personalAgentsSetWatcher,
  personalAgentsCaptureCursor,
  personalAgentsCaptureClaudeCode,
  personalAgentsCaptureCodex,
  personalAgentsCaptureWindsurf,
  personalAgentsCaptureDevin,
  personalAgentsCaptureReplit,
  personalAgentsCaptureAppleIntelligence,
  personalAgentsCaptureMsCopilot,
  type PersonalAgentId,
  type PersonalAgentSummary,
  type PersonalAgentCaptureResult,
  type PersonalAgentDetectionStatus,
} from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Capture-source row catalog. Mirrors the AGENTS list from the previous
// PersonalAgentsSettings.tsx — moved here so the merged tab is the single
// source of truth for "which AI tools Tangerine knows about".
// ---------------------------------------------------------------------------

type ParserConfidence =
  | { kind: "validated" }
  | { kind: "unvalidated"; reason: string };

type AgentRow = {
  atomDir: string;
  flagKey: PersonalAgentId;
  label: string;
  description: string;
  capture: (currentUser?: string) => Promise<PersonalAgentCaptureResult>;
  confidence: ParserConfidence;
};

const AGENTS: AgentRow[] = [
  {
    atomDir: "cursor",
    flagKey: "cursor",
    label: "Cursor",
    description: "Reads ~/.cursor/conversations/*.json (or %APPDATA%/Cursor on Windows).",
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
    description: "Reads ~/.config/openai/sessions/* (best-effort path probe).",
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
    description: "Reads Windsurf sessions dir (Codeium fork, Cursor-like shape).",
    capture: personalAgentsCaptureWindsurf,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — Windsurf not on validation machine yet.",
    },
  },
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
];

// ---------------------------------------------------------------------------
// Status badges — verbatim from PersonalAgentsSettings.tsx.
// ---------------------------------------------------------------------------

function StatusBadge({
  status,
  fallbackDetected,
  conversationCount,
}: {
  status: PersonalAgentDetectionStatus | undefined;
  fallbackDetected: boolean;
  conversationCount: number;
}) {
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

// ---------------------------------------------------------------------------
// Primary-channel section — the wave-11 picker logic, restructured as a
// dropdown that lives at the top of the merged tab.
// ---------------------------------------------------------------------------

function channelShort(c: AIToolStatus["channel"]): string {
  switch (c) {
    case "mcp":
      return "MCP";
    case "browser_ext":
      return "browser ext";
    case "ide_plugin":
      return "IDE plugin";
    case "local_http":
      return "local HTTP";
  }
}

function PrimaryChannelSection() {
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const setPrimaryAITool = useStore((s) => s.ui.setPrimaryAITool);

  const [tools, setTools] = useState<AIToolStatus[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadAITools();
      setTools(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-launch auto-pick (kept identical to wave-11 behavior so the
  // SetupWizard test that asserts an auto-picked primary still passes).
  useEffect(() => {
    if (primaryAITool !== null) return;
    if (tools.length === 0) return;
    const pick = pickPrimary(tools);
    if (pick) setPrimaryAITool(pick);
  }, [primaryAITool, tools, setPrimaryAITool]);

  const pickable = tools.filter((t) => t.status === "installed");
  const fallback = AI_TOOL_PRIORITY.filter(
    (id) => id !== primaryAITool && pickable.some((t) => t.id === id)
  );

  return (
    <section data-testid="st-ai-primary-channel">
      <h3 className="font-display text-lg">Primary channel</h3>
      <p className="mt-1 max-w-2xl text-sm text-[var(--ti-ink-500)]">
        Tangerine borrows this tool's LLM for co-thinker reasoning — no API key
        needed. If this tool is unreachable we fall through to the next one in
        priority order.
      </p>

      <div className="mt-4 flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => void refresh()}
          disabled={loading}
          data-testid="st-ai-redetect"
        >
          {loading ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <RefreshCw size={14} />
          )}
          Re-detect
        </Button>
        {error ? (
          <span className="text-xs text-[var(--ti-danger)]">{error}</span>
        ) : null}
      </div>

      <div
        className="mt-4 flex flex-col gap-2"
        role="radiogroup"
        aria-label="Primary AI tool"
      >
        {loading && pickable.length === 0 ? (
          <p className="text-sm text-[var(--ti-ink-500)]">Detecting…</p>
        ) : pickable.length === 0 ? (
          <p className="text-sm text-[var(--ti-ink-500)]">
            No AI tools detected on this machine. Install one of{" "}
            {AI_TOOL_PRIORITY.slice(0, 4).join(", ")} and re-detect.
          </p>
        ) : (
          pickable.map((t) => {
            const checked = primaryAITool === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setPrimaryAITool(t.id)}
                data-testid={`st-ai-pick-${t.id}`}
                className={
                  "flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors duration-fast " +
                  (checked
                    ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-ink-900)]"
                    : "border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
                }
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className={
                      "inline-block h-3 w-3 rounded-full border " +
                      (checked
                        ? "border-[var(--ti-orange-600)] bg-[var(--ti-orange-500)]"
                        : "border-[var(--ti-border-default)] bg-transparent")
                    }
                  />
                  <span className="font-medium">{t.name}</span>
                  <span className="text-xs text-[var(--ti-ink-500)]">
                    via {channelShort(t.channel)}
                  </span>
                </span>
                {checked ? (
                  <span className="text-xs text-[var(--ti-orange-700)]">
                    Primary
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>

      {fallback.length > 0 ? (
        <p className="mt-3 text-xs text-[var(--ti-ink-500)]">
          If primary is unreachable: {fallback.join(" → ")}
        </p>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Capture-sources section — the v1.15 8-tool grid from PersonalAgentsSettings,
// embedded under the Primary channel block.
// ---------------------------------------------------------------------------

function CaptureSourcesSection() {
  const { t } = useTranslation();
  const enabled = useStore((s) => s.ui.personalAgentsEnabled);
  const setPersonalAgentsEnabled = useStore(
    (s) => s.ui.setPersonalAgentsEnabled,
  );
  const togglePersonalAgent = useStore((s) => s.ui.togglePersonalAgent);
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [summaries, setSummaries] = useState<PersonalAgentSummary[]>([]);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [lastResult, setLastResult] = useState<
    Record<string, PersonalAgentCaptureResult | null>
  >({});

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
          devin: settings.devin,
          replit: settings.replit,
          apple_intelligence: settings.apple_intelligence,
          ms_copilot: settings.ms_copilot,
        });
        setLastSyncAt(settings.last_sync_at ?? null);
      } catch (e) {
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
    togglePersonalAgent(row.flagKey, next);
    try {
      const updated = await personalAgentsSetWatcher(row.flagKey, next);
      setPersonalAgentsEnabled({
        cursor: updated.cursor,
        claude_code: updated.claude_code,
        codex: updated.codex,
        windsurf: updated.windsurf,
        devin: updated.devin,
        replit: updated.replit,
        apple_intelligence: updated.apple_intelligence,
        ms_copilot: updated.ms_copilot,
      });
      setLastSyncAt(updated.last_sync_at ?? null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast(
        "error",
        `${t("settings.personalAgents.toggleFailed")} ${msg}`,
      );
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
          ? t("settings.personalAgents.syncedHeadlineErrors", {
              count: result.errors.length,
            })
          : t("settings.personalAgents.syncedHeadline", {
              written: result.written,
              skipped: result.skipped,
            });
      pushToast(
        result.errors.length ? "error" : "success",
        `${row.label}: ${headline}`,
      );
      try {
        setSummaries(await personalAgentsScanAll());
      } catch {
        // best-effort
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast(
        "error",
        `${row.label}: ${t("settings.personalAgents.syncFailed")} ${msg}`,
      );
    } finally {
      setBusy((b) => ({ ...b, [row.flagKey]: false }));
    }
  }

  return (
    <section data-testid="st-ai-capture-sources">
      <h3 className="font-display text-lg">Capture sources</h3>
      <p className="mt-1 max-w-2xl text-sm text-[var(--ti-ink-500)]">
        Which AI tools' conversations Tangerine reads. Strict opt-in — every
        source is OFF until you turn it on. Captures land under{" "}
        <code className="font-mono text-xs">
          personal/{currentUser}/threads/&lt;agent&gt;/
        </code>{" "}
        and stay on this machine (git-ignored, never synced to the team repo).
      </p>

      <ul className="mt-4 flex flex-col gap-3">
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
                    <h4 className="font-display text-base">{row.label}</h4>
                    <ParserBadge confidence={row.confidence} />
                    <StatusBadge
                      status={summary?.status}
                      fallbackDetected={detected}
                      conversationCount={conversationCount}
                    />
                    <span className="text-xs text-[var(--ti-ink-500)]">
                      {detected
                        ? conversationCount === 1
                          ? t("settings.personalAgents.detectedSingular", {
                              count: 1,
                            })
                          : t("settings.personalAgents.detectedPlural", {
                              count: conversationCount,
                            })
                        : t("settings.personalAgents.notDetected")}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
                    {row.description}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--ti-ink-400)]">
                    {detected
                      ? `${t("settings.personalAgents.readingFrom")} `
                      : `${t("settings.personalAgents.lookingAt")} `}
                    {homePath}
                  </p>
                  {last && (
                    <p className="mt-2 text-xs text-[var(--ti-ink-500)]">
                      {t("settings.personalAgents.lastSyncWrote")}{" "}
                      <strong>{last.written}</strong>,{" "}
                      {t("settings.personalAgents.skipped")}{" "}
                      <strong>{last.skipped}</strong>
                      {last.errors.length > 0 && (
                        <>
                          {`, ${t("settings.personalAgents.errors")} `}
                          <span className="text-[var(--ti-danger)]">
                            {last.errors.length}
                          </span>
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
                    <span>
                      {isOn
                        ? t("settings.personalAgents.on")
                        : t("settings.personalAgents.off")}
                    </span>
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
                    title={
                      detected
                        ? t("settings.personalAgents.syncTooltip")
                        : t("settings.personalAgents.syncTooltipNotDetected")
                    }
                  >
                    {busy[row.flagKey]
                      ? t("settings.personalAgents.syncing")
                      : t("settings.personalAgents.syncNow")}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 text-xs text-[var(--ti-ink-500)]">
        {lastSyncAt ? (
          <>
            {t("settings.personalAgents.lastSuccessful")}{" "}
            <strong>{new Date(lastSyncAt).toLocaleString()}</strong>
          </>
        ) : (
          t("settings.personalAgents.noCaptures")
        )}
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Public component — the merged "AI 工具" tab.
// ---------------------------------------------------------------------------

export function AIToolsSettings() {
  return (
    <div className="flex flex-col gap-8" data-testid="st-ai-tools">
      <PrimaryChannelSection />
      <hr className="border-[var(--ti-border-faint)]" />
      <CaptureSourcesSection />
    </div>
  );
}

export default AIToolsSettings;

// ---------------------------------------------------------------------------
// Legacy wave-11 picker preserved for reference (`#[allow(dead_code)]` in
// Rust speak). NOT exported, NOT mounted. Delete after one ship cycle if
// nobody asks to compare against it.
// ---------------------------------------------------------------------------
//
// function _LegacyAIToolsPicker() {
//   const primaryAITool = useStore((s) => s.ui.primaryAITool);
//   const setPrimaryAITool = useStore((s) => s.ui.setPrimaryAITool);
//
//   const [tools, setTools] = useState<AIToolStatus[]>([]);
//   const [loading, setLoading] = useState<boolean>(true);
//   const [error, setError] = useState<string | null>(null);
//
//   const refresh = async () => {
//     setLoading(true);
//     setError(null);
//     try {
//       const result = await loadAITools();
//       setTools(result);
//     } catch (e) {
//       setError(String(e));
//     } finally {
//       setLoading(false);
//     }
//   };
//
//   useEffect(() => {
//     void refresh();
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//   }, []);
//
//   useEffect(() => {
//     if (primaryAITool !== null) return;
//     if (tools.length === 0) return;
//     const pick = pickPrimary(tools);
//     if (pick) setPrimaryAITool(pick);
//   }, [primaryAITool, tools, setPrimaryAITool]);
//
//   const pickable = tools.filter((t) => t.status === "installed");
//   const fallback = AI_TOOL_PRIORITY.filter(
//     (id) => id !== primaryAITool && pickable.some((t) => t.id === id),
//   );
//
//   return (
//     <div className="flex flex-col gap-6" data-testid="st-ai-tools-legacy">
//       <section>
//         <h3 className="font-display text-lg">Primary AI tool</h3>
//         <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
//           Co-thinker uses this AI to think. Tangerine borrows your subscription —
//           no API key needed.
//         </p>
//         {/* ...wave-11 layout body, see git history before v1.15.2... */}
//       </section>
//     </div>
//   );
// }
