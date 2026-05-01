/**
 * v1.20.2 — Connect section: Obsidian-grade visual rewrite.
 *
 * Same content survives (Theme + Language + 4 IDE capture rows + external
 * sources directory), but the visual layer is now pure typography:
 *
 *   • General block: 2 stacked rows (Theme, Language). Label left fixed
 *     width, dropdown right fixed width. No grid card. No "General"
 *     subsection heading — the rows ARE the block.
 *   • AI tool capture block: subsection heading "Sources" + 1-line mono
 *     path hint. Each source is typography-only: vendor color dot +
 *     vendor name + right-aligned status meta + toggle + Sync. Below
 *     the head row: 2 mono lines (read path + resolved disk OR
 *     "not detected"). Connected sources float to top; not-installed
 *     dimmed via opacity-50.
 *   • External sources: wraps SourcesSettings (now also typography-only).
 *   • Hairline (1px stone-200) separators between subsections + between
 *     rows within a subsection. NO box borders.
 *
 * Backwards-compat preserved end-to-end:
 *   - All `st-personal-agent-*` testids still exist (toggle, sync, row,
 *     status, errors).
 *   - `st-theme` / `st-language` selects still flip the same store keys.
 *   - `st-connect-general` / `st-connect-capture-sources` /
 *     `st-connect-external-sources` testids stay so wave4-d1 can find
 *     them.
 *   - All Tauri commands (personalAgentsScanAll / set / capture*) called
 *     identically — the rewrite is purely view-side.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/lib/store";
import { activeLocale, setLocale } from "@/i18n";
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

type ParserConfidence =
  | { kind: "validated" }
  | { kind: "unvalidated"; reason: string };

type AgentRow = {
  atomDir: string;
  flagKey: PersonalAgentId;
  label: string;
  vendorId: string; // matches CSS [data-vendor="..."] in index.css
  readPath: string; // canonical glob/path the walker reads
  capture: (currentUser?: string) => Promise<PersonalAgentCaptureResult>;
  confidence: ParserConfidence;
};

const IDE_AGENTS: AgentRow[] = [
  {
    atomDir: "cursor",
    flagKey: "cursor",
    label: "Cursor",
    vendorId: "cursor",
    readPath: "~/.cursor/conversations/*.json",
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
    vendorId: "claude-code",
    readPath: "~/.claude/projects/<slug>/<session>.jsonl",
    capture: personalAgentsCaptureClaudeCode,
    confidence: { kind: "validated" },
  },
  {
    atomDir: "codex",
    flagKey: "codex",
    label: "Codex CLI",
    vendorId: "codex",
    readPath: "~/.config/openai/sessions/*",
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
    vendorId: "windsurf",
    readPath: "~/.windsurf/sessions/*",
    capture: personalAgentsCaptureWindsurf,
    confidence: {
      kind: "unvalidated",
      reason: "Schema assumed — Windsurf not on validation machine yet.",
    },
  },
];

// Trim long Rust error messages to fit a single toast line.
function truncateError(msg: string): string {
  const cleaned = msg.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 80) return cleaned;
  return cleaned.slice(0, 77) + "…";
}

/**
 * Resolve a source row to a single-line status meta (mono 11px stone-500).
 * Honest: connected sources show the captured-atom count; not-installed
 * sources say so plainly; unsupported / access-denied surface explicitly.
 */
function statusMeta(
  row: AgentRow,
  summary: PersonalAgentSummary | undefined,
): { connected: boolean; meta: string; testid: string } {
  const status: PersonalAgentDetectionStatus =
    summary?.status ?? {
      kind: summary?.detected ? "installed" : "not_installed",
    };
  const confLabel = row.confidence.kind === "validated" ? "Confirmed" : "Beta";
  switch (status.kind) {
    case "installed": {
      const n = summary?.conversation_count ?? 0;
      return {
        connected: true,
        meta: `${confLabel} · Connected · ${n} atom${n === 1 ? "" : "s"}`,
        testid: "st-personal-agent-status-installed",
      };
    }
    case "access_denied":
      return {
        connected: false,
        meta: `${confLabel} · access denied`,
        testid: "st-personal-agent-status-access-denied",
      };
    case "platform_unsupported":
      return {
        connected: false,
        meta: `${confLabel} · platform unsupported`,
        testid: "st-personal-agent-status-platform",
      };
    case "remote_unconfigured":
      return {
        connected: false,
        meta: `${confLabel} · awaiting first capture`,
        testid: "st-personal-agent-status-awaiting",
      };
    case "not_installed":
    default:
      return {
        connected: false,
        meta: `${confLabel} · not installed`,
        testid: "st-personal-agent-status-not-installed",
      };
  }
}

// ---------------------------------------------------------------------------
// General prefs — Theme + Language. Stacked single-column rows; label fixed
// width left, dropdown fixed width right.
// ---------------------------------------------------------------------------

function GeneralPrefs() {
  const { t } = useTranslation();
  const theme = useStore((s) => s.ui.theme);
  const setTheme = useStore((s) => s.ui.setTheme);
  const [lang, setLang] = useState<"en" | "zh">(activeLocale());

  return (
    <section data-testid="st-connect-general">
      <ul className="flex flex-col gap-1">
        <li className="flex items-center justify-between py-2">
          <label
            htmlFor="st-theme"
            className="w-[10ch] text-[13px] text-stone-700 dark:text-stone-300"
          >
            Theme
          </label>
          <select
            id="st-theme"
            data-testid="st-theme"
            value={theme}
            onChange={(e) =>
              setTheme(e.target.value as "system" | "light" | "dark")
            }
            className="w-[20ch] rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[13px] text-stone-900 transition-colors hover:border-stone-300 focus:border-[var(--ti-orange-500)] focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </li>
        <li className="flex items-center justify-between py-2">
          <label
            htmlFor="st-language"
            className="w-[10ch] text-[13px] text-stone-700 dark:text-stone-300"
          >
            {t("settings.language.label", { defaultValue: "Language" })}
          </label>
          <select
            id="st-language"
            data-testid="st-language"
            value={lang}
            onChange={async (e) => {
              const next = e.target.value === "zh" ? "zh" : "en";
              setLang(next);
              await setLocale(next);
            }}
            className="w-[20ch] rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[13px] text-stone-900 transition-colors hover:border-stone-300 focus:border-[var(--ti-orange-500)] focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          >
            <option value="en">
              {t("settings.language.english", { defaultValue: "English" })}
            </option>
            <option value="zh">
              {t("settings.language.chinese", { defaultValue: "中文" })}
            </option>
          </select>
        </li>
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// IDE capture — typography-only rows. Connected first, not-installed dimmed.
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
        // Preserve full 8-key shape — backend & store still tracks all 8.
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
        `${t("settings.personalAgents.toggleFailed", { defaultValue: "Toggle failed:" })} ${msg}`,
      );
      togglePersonalAgent(row.flagKey, !next);
    }
  }

  async function onSyncNow(row: AgentRow) {
    setBusy((b) => ({ ...b, [row.flagKey]: true }));
    try {
      const result = await row.capture(currentUser);
      setLastResult((r) => ({ ...r, [row.flagKey]: result }));
      const errCount = result.errors.length;
      const summary =
        errCount > 0
          ? `${row.label}: wrote ${result.written}, skipped ${result.skipped}, ${errCount} error${
              errCount === 1 ? "" : "s"
            } — ${truncateError(result.errors[0])}`
          : `${row.label}: wrote ${result.written}, skipped ${result.skipped}`;
      pushToast(errCount > 0 ? "error" : "success", summary);
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

  // Connected sources float to the top; not-installed sources sink to the
  // bottom. The order within each group preserves the IDE_AGENTS canonical
  // order so toggling Cursor doesn't reflow Claude Code.
  const ordered = useMemo(() => {
    const connected: AgentRow[] = [];
    const rest: AgentRow[] = [];
    for (const row of IDE_AGENTS) {
      const summary = summaryByDir.get(row.atomDir);
      const detected = summary?.detected ?? false;
      if (detected) connected.push(row);
      else rest.push(row);
    }
    return [...connected, ...rest];
  }, [summaryByDir]);

  return (
    <section data-testid="st-connect-capture-sources">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        Sources
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        ~/.tangerine-memory/personal/{currentUser}/threads/&lt;source&gt;/
      </p>

      <ul className="mt-4 divide-y divide-stone-200 dark:divide-stone-800">
        {ordered.map((row) => {
          const summary = summaryByDir.get(row.atomDir);
          const detected = summary?.detected ?? false;
          const isOn = enabled[row.flagKey];
          const last = lastResult[row.flagKey];
          const meta = statusMeta(row, summary);
          return (
            <li
              key={row.flagKey}
              data-testid={`st-personal-agent-row-${row.flagKey}`}
              className={
                "py-3 transition-opacity " +
                (detected ? "opacity-100" : "opacity-50")
              }
            >
              {/* Head row: dot · vendor name | meta | toggle | Sync */}
              <div className="flex items-center gap-3">
                <span
                  aria-hidden
                  data-vendor={row.vendorId}
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{
                    background:
                      "var(--ti-vendor-color, var(--ti-ink-300))",
                  }}
                />
                <span className="flex-1 text-[14px] font-medium text-stone-900 dark:text-stone-100">
                  {row.label}
                </span>
                <span
                  data-testid={meta.testid}
                  className={
                    "shrink-0 font-mono text-[11px] " +
                    (meta.connected
                      ? "text-[var(--ti-orange-500)]"
                      : "text-stone-500 dark:text-stone-500")
                  }
                >
                  {meta.meta}
                </span>
                <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-[12px] text-stone-700 dark:text-stone-300">
                  <input
                    type="checkbox"
                    checked={isOn}
                    onChange={(e) => void onToggle(row, e.target.checked)}
                    data-testid={`st-personal-agent-toggle-${row.flagKey}`}
                    className="accent-[var(--ti-orange-500)]"
                  />
                  <span className="font-mono">{isOn ? "on" : "off"}</span>
                </label>
                {isOn && (
                  <button
                    type="button"
                    onClick={() => void onSyncNow(row)}
                    disabled={busy[row.flagKey] || !detected}
                    data-testid={`st-personal-agent-sync-${row.flagKey}`}
                    className={
                      "shrink-0 rounded-md border border-stone-200 px-2.5 py-1 font-mono text-[11px] text-stone-700 transition-colors hover:border-stone-300 hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600 dark:hover:bg-stone-900"
                    }
                  >
                    {busy[row.flagKey] ? "Syncing…" : "Sync ↻"}
                  </button>
                )}
              </div>

              {/* Sub line — read path (mono, stone-500) */}
              <p className="mt-1 break-all pl-[18px] font-mono text-[11px] text-stone-500 dark:text-stone-500">
                {row.readPath}
              </p>

              {/* Sub line — disk presence. Dedupe: if installed, just say so;
                  no need to repeat the path. If not, say "not detected". */}
              <p className="break-all pl-[18px] font-mono text-[11px] text-stone-400 dark:text-stone-600">
                {detected ? "✓ reading from disk" : "not detected on disk"}
              </p>

              {/* Persistent last-sync line + collapsible errors. Only shown
                  after the user has clicked Sync once for this row. */}
              {last && (
                <div className="mt-2 pl-[18px] font-mono text-[11px]">
                  <p className="text-stone-500 dark:text-stone-500">
                    last sync · wrote {last.written} · skipped {last.skipped}
                    {last.errors.length > 0 && (
                      <span className="text-rose-700 dark:text-rose-400">
                        {" · "}
                        {last.errors.length} error
                        {last.errors.length === 1 ? "" : "s"}
                      </span>
                    )}
                  </p>
                  {last.errors.length > 0 && (
                    <details
                      data-testid={`st-personal-agent-errors-${row.flagKey}`}
                      className="mt-1 text-rose-700 dark:text-rose-400"
                    >
                      <summary className="cursor-pointer">
                        show error{last.errors.length === 1 ? "" : "s"}
                      </summary>
                      <ul className="mt-1 ml-3 list-disc space-y-0.5 break-words">
                        {last.errors.slice(0, 5).map((e, i) => (
                          <li key={i}>{e}</li>
                        ))}
                        {last.errors.length > 5 && (
                          <li>… {last.errors.length - 5} more</li>
                        )}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// External sources — wraps SourcesSettings (now also typography-only).
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
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <IDECaptureGrid />
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <ExternalSourcesBlock />
    </div>
  );
}

export default ConnectSection;
