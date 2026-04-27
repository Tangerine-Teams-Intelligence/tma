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

import { useEffect, useMemo, useState } from "react";
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
} from "@/lib/tauri";

type AgentRow = {
  /** Atom dir name on disk — used as the row's react key + the source
   *  field on the summary. */
  atomDir: string;
  /** Toggle key in the persisted settings struct. */
  flagKey: PersonalAgentId;
  label: string;
  description: string;
  capture: (currentUser?: string) => Promise<PersonalAgentCaptureResult>;
};

const AGENTS: AgentRow[] = [
  {
    atomDir: "cursor",
    flagKey: "cursor",
    label: "Cursor",
    description: "Reads ~/.cursor/conversations/*.json (or %APPDATA%/Cursor on Windows).",
    capture: personalAgentsCaptureCursor,
  },
  {
    atomDir: "claude-code",
    flagKey: "claude_code",
    label: "Claude Code",
    description: "Reads ~/.claude/projects/<slug>/<session-uuid>.jsonl.",
    capture: personalAgentsCaptureClaudeCode,
  },
  {
    atomDir: "codex",
    flagKey: "codex",
    label: "Codex CLI",
    description: "Reads ~/.config/openai/sessions/* (best-effort path probe).",
    capture: personalAgentsCaptureCodex,
  },
  {
    atomDir: "windsurf",
    flagKey: "windsurf",
    label: "Windsurf",
    description: "Reads Windsurf sessions dir (Codeium fork, Cursor-like shape).",
    capture: personalAgentsCaptureWindsurf,
  },
  // === v3.0 wave 2 personal agents ===
  {
    atomDir: "devin",
    flagKey: "devin",
    label: "Devin",
    description:
      "Cognition Labs cloud agent. Webhook + REST poll fallback (token + secret in Settings).",
    capture: personalAgentsCaptureDevin,
  },
  {
    atomDir: "replit",
    flagKey: "replit",
    label: "Replit Agent",
    description: "Replit cloud agent. REST poll (token in Settings, stub default).",
    capture: personalAgentsCaptureReplit,
  },
  {
    atomDir: "apple-intelligence",
    flagKey: "apple_intelligence",
    label: "Apple Intelligence",
    description:
      "macOS Shortcuts post-action hook (Writing Tools / Image Playground / Genmoji). macOS only.",
    capture: personalAgentsCaptureAppleIntelligence,
  },
  {
    atomDir: "ms-copilot",
    flagKey: "ms_copilot",
    label: "MS Copilot (personal)",
    description:
      "Microsoft Copilot via Graph API. Enterprise license required — stub mode by default.",
    capture: personalAgentsCaptureMsCopilot,
  },
  // === end v3.0 wave 2 personal agents ===
];

export function PersonalAgentsSettings() {
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
      pushToast("error", `Toggle failed: ${msg}`);
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
          ? `Synced with ${result.errors.length} error(s)`
          : `Synced — wrote ${result.written}, skipped ${result.skipped}`;
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
      pushToast("error", `${row.label}: sync failed: ${msg}`);
    } finally {
      setBusy((b) => ({ ...b, [row.flagKey]: false }));
    }
  }

  return (
    <div className="flex flex-col gap-6" data-testid="st-personal-agents">
      <section>
        <h3 className="font-display text-lg">Personal AI agent capture</h3>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ti-ink-500)]">
          Tangerine reads your local AI agent conversation logs and writes
          one atom per conversation under{" "}
          <code className="font-mono text-xs">
            personal/{currentUser}/threads/&lt;agent&gt;/
          </code>
          . Strict opt-in — every source is OFF until you turn it on. Atoms
          stay on this machine; the personal vault is git-ignored and never
          syncs to the team repo.
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
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={
                        "inline-block h-2 w-2 rounded-full " +
                        (detected
                          ? "bg-[var(--ti-success-500,#3a8c5a)]"
                          : "bg-[var(--ti-ink-400,#8c8c93)]")
                      }
                    />
                    <h4 className="font-display text-base">{row.label}</h4>
                    <span className="text-xs text-[var(--ti-ink-500)]">
                      {detected
                        ? `${conversationCount} conversation${conversationCount === 1 ? "" : "s"} found`
                        : "not detected"}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-[var(--ti-ink-500)]">{row.description}</p>
                  <p className="mt-1 break-all font-mono text-xs text-[var(--ti-ink-400)]">
                    {detected ? "Reading from " : "Looking at "}
                    {homePath}
                  </p>
                  {last && (
                    <p className="mt-2 text-xs text-[var(--ti-ink-500)]">
                      Last sync: wrote <strong>{last.written}</strong>, skipped{" "}
                      <strong>{last.skipped}</strong>
                      {last.errors.length > 0 && (
                        <>
                          {", errors: "}
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
                    <span>{isOn ? "On" : "Off"}</span>
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
                    title={detected ? "Run a one-off capture now" : "Source not detected on this machine"}
                  >
                    {busy[row.flagKey] ? "Syncing…" : "Sync now"}
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
            Last successful capture: <strong>{new Date(lastSyncAt).toLocaleString()}</strong>
          </p>
        ) : (
          <p>No captures yet — flip a toggle and click &ldquo;Sync now&rdquo; to start.</p>
        )}
      </section>
    </div>
  );
}

export default PersonalAgentsSettings;
