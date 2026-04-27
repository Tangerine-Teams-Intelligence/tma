/**
 * /sources/calendar — Calendar source page (v1.8 Phase 2-B).
 *
 * Capture-side (iCal poll) lives in `sources/calendar/` (TypeScript). This
 * page exposes the **writeback** half: when a meeting atom in
 * `~/.tangerine-memory/meetings/` flips to `status: finalized`, the daemon
 * triggers `calendar_writeback_summary` which appends a
 * `📋 Meeting summary (Tangerine)` block to the original calendar event's
 * description.
 *
 * Idempotency lives in Rust — we detect the sentinel and skip the second
 * append. All this page does is gate the writeback behind a per-user toggle
 * persisted in `~/.tmi/config.yaml`.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  CalendarDays,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStore } from "@/lib/store";
import {
  getConfig,
  setConfig,
  calendarWritebackSummary,
} from "@/lib/tauri";
// v1.9.0-beta.3 P3-B — first-time writeback confirm. Editing a Google
// Calendar event description on the user's behalf is irreversible (the
// event is now visibly annotated; collaborators see the change). Per
// spec §3.4 gate the first OFF→ON flip behind a modal.
import { logEvent } from "@/lib/telemetry";

type WritebackOutcome = {
  ok: boolean;
  message: string;
  at: string;
};

interface CalendarWritebackConfig {
  appendSummaryToEvent: boolean;
}

function defaultConfig(): CalendarWritebackConfig {
  return { appendSummaryToEvent: false };
}

const OUTCOMES_KEY = "tangerine.calendar.writeback.outcomes.v1";

function loadOutcomes(): WritebackOutcome[] {
  try {
    const raw = window.localStorage.getItem(OUTCOMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WritebackOutcome[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveOutcomes(outcomes: WritebackOutcome[]): void {
  try {
    window.localStorage.setItem(
      OUTCOMES_KEY,
      JSON.stringify(outcomes.slice(0, 5)),
    );
  } catch {
    /* noop */
  }
}

export default function CalendarSourceRoute() {
  const pushToast = useStore((s) => s.ui.pushToast);
  const pushModal = useStore((s) => s.ui.pushModal);
  const firstWritebackConfirmed = useStore(
    (s) => s.ui.firstWritebackConfirmedThisSession,
  );
  const markWritebackConfirmed = useStore(
    (s) => s.ui.markWritebackConfirmed,
  );
  const unmarkWritebackConfirmed = useStore(
    (s) => s.ui.unmarkWritebackConfirmed,
  );
  const [cfg, setCfg] = useState<CalendarWritebackConfig>(defaultConfig);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [outcomes, setOutcomes] = useState<WritebackOutcome[]>(() => loadOutcomes());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await getConfig()) as ParsedConfig | null;
        if (cancelled) return;
        const wb = readCalendarWriteback(r);
        if (wb) setCfg(wb);
      } catch {
        /* keep defaults */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: CalendarWritebackConfig) {
    setCfg(next);
    setSaving(true);
    try {
      const r = ((await getConfig()) as ParsedConfig | null) ?? {
        yaml: "",
        parsed: {},
        exists: false,
      };
      const merged = mergeCalendarWriteback(r, next);
      await setConfig(merged);
    } catch (e) {
      pushToast(
        "error",
        `Couldn't save Calendar writeback prefs: ${(e as Error).message}`,
      );
    } finally {
      setSaving(false);
    }
  }

  /**
   * v1.9.0-beta.3 P3-B — first OFF→ON flip is gated behind a confirm
   * modal. OFF flips skip and clear the latch.
   */
  function persistWithConfirm(next: CalendarWritebackConfig) {
    const turningOn = next.appendSummaryToEvent && !cfg.appendSummaryToEvent;
    if (!turningOn) {
      void persist(next);
      if (!next.appendSummaryToEvent && firstWritebackConfirmed.has("calendar")) {
        unmarkWritebackConfirmed("calendar");
      }
      return;
    }
    if (firstWritebackConfirmed.has("calendar")) {
      void persist(next);
      return;
    }
    pushModal({
      id: "calendar-writeback-first-time",
      emoji: "🍊",
      title: "Edit calendar event descriptions on Tangerine's behalf?",
      body:
        "When enabled, Tangerine will append a 📋 Meeting summary block to the original Google Calendar event's description after each meeting finalizes. Each edit is automated — no per-message confirm.\n\n" +
        "This is a one-time confirm. Disable any time.",
      confirmLabel: "Allow calendar edits",
      cancelLabel: "Not now",
      onConfirm: () => {
        markWritebackConfirmed("calendar");
        void persist(next);
        void logEvent("accept_suggestion", {
          tier: "modal",
          template_name: "writeback_first_time_calendar",
        });
      },
      onCancel: () => {
        // Revert local checkbox so it reflects "still off".
        setCfg(cfg);
        void logEvent("dismiss_suggestion", {
          surface_id: "calendar-writeback-first-time",
          modal_kind: "writeback_first_time_calendar",
        });
      },
    });
  }

  function recordOutcome(o: WritebackOutcome) {
    const next = [o, ...outcomes].slice(0, 5);
    setOutcomes(next);
    saveOutcomes(next);
  }

  async function runTest() {
    setTesting(true);
    try {
      // Empty meeting_path / event_id will return user-error from Rust;
      // we just exercise the IPC plumbing here. Real triggers come from
      // the daemon hooked into the heartbeat.
      await calendarWritebackSummary("", "");
      recordOutcome({
        ok: true,
        message: "Writeback IPC reachable.",
        at: new Date().toISOString(),
      });
      pushToast("success", "Writeback IPC reachable.");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      recordOutcome({ ok: false, message: msg, at: new Date().toISOString() });
      pushToast("error", `Calendar writeback test failed: ${msg}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Link
          to="/today"
          className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <ArrowLeft size={16} />
        </Link>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <CalendarDays size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Calendar
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Writeback
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-16">
        <p className="ti-section-label">Source · Calendar</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Calendar writeback
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          When a meeting atom is finalized, append a `📋 Meeting summary
          (Tangerine)` block to the original Google Calendar event's description.
          Detection is sentinel-based, so re-finalizing the same atom won't
          double-post.
        </p>

        {!hydrated ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-[var(--ti-ink-500)]">
            <Loader2 size={14} className="animate-spin" /> Loading config…
          </div>
        ) : (
          <>
            <section className="mt-8 space-y-3">
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <ToggleRow
                    label="Append meeting summary to calendar event description"
                    description="Adds decisions + action items into the event the meeting was on. Idempotent — safe to leave on."
                    checked={cfg.appendSummaryToEvent}
                    onChange={(v) => persistWithConfirm({ appendSummaryToEvent: v })}
                  />
                  {saving && (
                    <p className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
                      <Loader2 size={12} className="animate-spin" /> Saving…
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-3 pt-6">
                  <p className="ti-section-label">Test writeback</p>
                  <p className="text-xs text-[var(--ti-ink-500)]">
                    Smoke-tests the IPC path. Real writebacks fire from the
                    daemon when an atom transitions to status: finalized.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={runTest}
                    disabled={testing}
                  >
                    {testing ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Send size={14} />
                    )}
                    Run test
                  </Button>
                </CardContent>
              </Card>
            </section>

            <section className="mt-6">
              <p className="ti-section-label">Recent writeback outcomes</p>
              <Card className="mt-3">
                <CardContent className="pt-6">
                  {outcomes.length === 0 ? (
                    <p className="text-xs italic text-[var(--ti-ink-500)]">
                      No writeback attempts yet.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {outcomes.map((o, i) => (
                        <li
                          key={`${o.at}-${i}`}
                          className="flex items-start gap-2 text-sm"
                        >
                          {o.ok ? (
                            <CheckCircle2
                              size={14}
                              className="mt-0.5 shrink-0 text-[#2D8659]"
                            />
                          ) : (
                            <AlertCircle
                              size={14}
                              className="mt-0.5 shrink-0 text-[#B83232]"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[11px] uppercase text-[var(--ti-ink-500)]">
                                calendar
                              </span>
                              <span className="font-mono text-[11px] text-[var(--ti-ink-500)]">
                                {formatRelative(o.at)}
                              </span>
                            </div>
                            <p className="break-words text-xs text-[var(--ti-ink-700)]">
                              {o.message}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div className="flex-1">
        <p className="font-medium text-[var(--ti-ink-900)]">{label}</p>
        <p className="text-xs text-[var(--ti-ink-500)]">{description}</p>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--ti-orange-500)]"
      />
    </label>
  );
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

// ----------------------------------------------------------------------
// config.yaml round-trip helpers — same string-marker pattern as the Slack
// page so the two writeback blocks coexist cleanly in one yaml file.

interface ParsedConfig {
  yaml: string;
  parsed: { sources?: { calendar?: { writeback?: CalendarWritebackConfig } } };
  exists: boolean;
}

function readCalendarWriteback(
  r: ParsedConfig | null,
): CalendarWritebackConfig | null {
  const wb = r?.parsed?.sources?.calendar?.writeback;
  if (!wb) return null;
  return {
    appendSummaryToEvent: !!wb.appendSummaryToEvent,
  };
}

function mergeCalendarWriteback(
  r: ParsedConfig,
  wb: CalendarWritebackConfig,
): string {
  const block = renderCalendarBlock(wb);
  const yaml = r.exists ? r.yaml : minimalScaffoldYaml();
  const startMarker = "# === calendar writeback (v1.8 Phase 2-B) ===";
  const endMarker = "# === end calendar writeback ===";
  const startIdx = yaml.indexOf(startMarker);
  if (startIdx < 0) {
    return yaml.trimEnd() + "\n\n" + block + "\n";
  }
  const endIdx = yaml.indexOf(endMarker, startIdx);
  if (endIdx < 0) {
    return yaml.trimEnd() + "\n\n" + block + "\n";
  }
  const before = yaml.slice(0, startIdx);
  const after = yaml.slice(endIdx + endMarker.length);
  return (before.trimEnd() + "\n\n" + block + after).replace(/\n{3,}/g, "\n\n");
}

function renderCalendarBlock(wb: CalendarWritebackConfig): string {
  return [
    "# === calendar writeback (v1.8 Phase 2-B) ===",
    "sources:",
    "  calendar:",
    "    writeback:",
    `      appendSummaryToEvent: ${wb.appendSummaryToEvent}`,
    "# === end calendar writeback ===",
  ].join("\n");
}

function minimalScaffoldYaml(): string {
  return [
    "schema_version: 1",
    "meetings_repo: ~/.tangerine-meetings",
    "team: []",
    "discord: {}",
    "whisper: {}",
    "claude: {}",
    "output_adapters: []",
  ].join("\n");
}
