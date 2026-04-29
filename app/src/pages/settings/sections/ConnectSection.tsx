/**
 * v1.16 Wave 4 D1 — Connect section.
 *
 * Composes the 3-tab Settings redesign (Connect / Privacy / Sync) by
 * pulling the still-relevant pieces out of the legacy 9-tab layout:
 *
 *   1. Theme + language + memory root  (the few bits of GeneralSettings
 *      that survive the cull — meeting repo, log level, timezone, tour
 *      replay all go to Sync since they are repo / config-y)
 *   2. Capture sources — the v1.15 personal-agents grid, filtered to the
 *      4 IDE rows (Cursor / Claude Code / Codex / Windsurf). Devin /
 *      Replit / Apple Intelligence / MS Copilot are 砍 — capture surface
 *      now matches v1.16's "AI tool capture only" scope.
 *   3. External sources — the wave-19 SourcesSettings directory of 11
 *      connectors (Slack / Email / Calendar / GitHub / Discord / etc.)
 *
 * Backwards-compat:
 *   - `personalAgentsEnabled` store key untouched
 *   - `theme` store key untouched
 *   - All Tauri commands (personalAgentsScanAll / personalAgentsSetWatcher
 *     / etc.) called the same way — the 4-row filter is purely view-side
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/lib/store";
import { activeLocale, setLocale } from "@/i18n";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  personalAgentsScanAll,
  personalAgentsGetSettings,
  personalAgentsSetWatcher,
  personalAgentsCaptureCursor,
  personalAgentsCaptureClaudeCode,
  personalAgentsCaptureCodex,
  personalAgentsCaptureWindsurf,
  type PersonalAgentId,
  type PersonalAgentSummary,
  type PersonalAgentCaptureResult,
  type PersonalAgentDetectionStatus,
} from "@/lib/tauri";

import { SourcesSettings } from "../SourcesSettings";

// ---------------------------------------------------------------------------
// 4-IDE capture rows. Filtered down from the v1.15 8-tool grid — only the
// 4 IDE captures survive v1.16. Webhook / cloud agent rows (Devin / Replit /
// Apple Intelligence / MS Copilot) are dropped because the smart layer that
// consumed them is gone.
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

const IDE_AGENTS: AgentRow[] = [
  {
    atomDir: "cursor",
    flagKey: "cursor",
    label: "Cursor",
    description:
      "Reads ~/.cursor/conversations/*.json (or %APPDATA%/Cursor on Windows).",
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
];

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
          className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700"
        >
          captured {conversationCount}
        </span>
      );
    case "access_denied":
      return (
        <span
          data-testid="st-personal-agent-status-access-denied"
          className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-800"
        >
          access denied
        </span>
      );
    case "platform_unsupported":
      return (
        <span className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-100,#f3eee6)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-500)]">
          platform unsupported
        </span>
      );
    case "remote_unconfigured":
      return (
        <span className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-500)]">
          awaiting first capture
        </span>
      );
    case "not_installed":
    default:
      return (
        <span className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-ink-400)]">
          not installed
        </span>
      );
  }
}

function ParserBadge({ confidence }: { confidence: ParserConfidence }) {
  if (confidence.kind === "validated") {
    return (
      <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700">
        Confirmed
      </span>
    );
  }
  return (
    <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700">
      Beta
    </span>
  );
}

// ---------------------------------------------------------------------------
// General prefs block (top of Connect). Theme + language only — meeting repo
// / timezone / tour replay moved to Sync section.
// ---------------------------------------------------------------------------

function GeneralPrefs() {
  const { t } = useTranslation();
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.ui.setTheme);
  const [lang, setLang] = useState<"en" | "zh">(activeLocale());

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="st-connect-general"
    >
      <h3 className="font-display text-base">General</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="st-theme">Theme</Label>
          <select
            id="st-theme"
            data-testid="st-theme"
            value={theme}
            onChange={(e) =>
              setTheme(e.target.value as "system" | "light" | "dark")
            }
            className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </div>

        <div>
          <Label htmlFor="st-language">{t("settings.language.label")}</Label>
          <select
            id="st-language"
            data-testid="st-language"
            value={lang}
            onChange={async (e) => {
              const next = e.target.value === "zh" ? "zh" : "en";
              setLang(next);
              await setLocale(next);
            }}
            className="mt-1 h-10 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
          >
            <option value="en">{t("settings.language.english")}</option>
            <option value="zh">{t("settings.language.chinese")}</option>
          </select>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// IDE capture grid — the 4-row filtered version of the v1.15 grid.
// ---------------------------------------------------------------------------

function IDECaptureGrid() {
  const { t } = useTranslation();
  const enabled = useStore((s) => s.ui.personalAgentsEnabled);
  const setPersonalAgentsEnabled = useStore(
    (s) => s.ui.setPersonalAgentsEnabled,
  );
  const togglePersonalAgent = useStore((s) => s.ui.togglePersonalAgent);
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [summaries, setSummaries] = useState<PersonalAgentSummary[]>([]);
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
        // Preserve full 8-key shape — backend & store still tracks all 8;
        // we just don't render the cloud-agent ones.
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
      } catch (e) {
        if (!cancel) {
          // eslint-disable-next-line no-console
          console.warn("[connect-section] hydrate failed", e);
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
      pushToast(
        result.errors.length ? "error" : "success",
        `${row.label}: wrote ${result.written}, skipped ${result.skipped}`,
      );
      try {
        setSummaries(await personalAgentsScanAll());
      } catch {
        // best-effort
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${row.label}: ${msg}`);
    } finally {
      setBusy((b) => ({ ...b, [row.flagKey]: false }));
    }
  }

  return (
    <section data-testid="st-connect-capture-sources">
      <h3 className="font-display text-base">AI tool capture</h3>
      <p className="mt-1 max-w-2xl text-sm text-[var(--ti-ink-500)]">
        Which AI tools' conversations Tangerine reads. Strict opt-in — every
        source is OFF until you turn it on. Captures land under{" "}
        <code className="font-mono text-xs">
          personal/{currentUser}/threads/&lt;agent&gt;/
        </code>{" "}
        and stay on this machine.
      </p>

      <ul className="mt-4 flex flex-col gap-3">
        {IDE_AGENTS.map((row) => {
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
                  </div>
                  <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
                    {row.description}
                  </p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--ti-ink-400)]">
                    {detected ? "Reading from " : "Looking at "}
                    {homePath}
                  </p>
                  {last && (
                    <p className="mt-2 text-xs text-[var(--ti-ink-500)]">
                      Last sync wrote <strong>{last.written}</strong>, skipped{" "}
                      <strong>{last.skipped}</strong>
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
                    <span>{isOn ? "on" : "off"}</span>
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
                  >
                    {busy[row.flagKey] ? "Syncing…" : "Sync now"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// External sources — wraps SourcesSettings (the wave-19 11-connector
// directory) under a sub-heading. SourcesSettings already handles its own
// title; we just add an explicit divider above it.
// ---------------------------------------------------------------------------

function ExternalSourcesBlock() {
  return (
    <section data-testid="st-connect-external-sources">
      <SourcesSettings />
    </section>
  );
}

export function ConnectSection() {
  return (
    <div className="flex flex-col gap-8" data-testid="st-section-connect">
      <GeneralPrefs />
      <hr className="border-[var(--ti-border-faint)]" />
      <IDECaptureGrid />
      <hr className="border-[var(--ti-border-faint)]" />
      <ExternalSourcesBlock />
    </div>
  );
}

export default ConnectSection;
