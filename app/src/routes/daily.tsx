// === wave 24 ===
/**
 * Wave 24 — Daily notes route.
 *
 * Layout:
 *   ┌────────────────────────────────────────────────────────────┐
 *   │ Header: < prev | YYYY-MM-DD picker | next >  · Apply tpl ▾ │
 *   ├────────────────────────────────────┬───────────────────────┤
 *   │ Editor (textarea)                  │  Calendar heatmap     │
 *   │   - frontmatter visible            │  (clickable days)     │
 *   │   - 4 sections, 2 user / 2 auto    │                       │
 *   └────────────────────────────────────┴───────────────────────┘
 *
 * Default lands on TODAY's daily note (computed via the browser's local
 * clock so the file matches the user's wall-clock day).
 *
 * The Wave-24 spec rule 9 mandates *local time* for "today" — never UTC.
 * The frontend is the authority on the user's wall-clock day; the Rust
 * side accepts a YYYY-MM-DD string and otherwise falls back to its own
 * local clock.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import {
  Calendar as CalendarIcon,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Save,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { DAILY_TEMPLATE_MENU_OPEN_EVENT } from "@/components/CommandPalette";
import {
  dailyNotesEnsureToday,
  dailyNotesList,
  dailyNotesRead,
  dailyNotesSave,
  localTodayIso,
  templatesApply,
  templatesList,
  type DailyNoteSummary,
  type TemplateSummary,
} from "@/lib/tauri";

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Add `delta` days to a YYYY-MM-DD string. Pure date math; no tz drift. */
function addDays(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map((s) => Number(s));
  const dt = new Date(Date.UTC(y, (m ?? 1) - 1, d ?? 1));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const ny = dt.getUTCFullYear();
  const nm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(dt.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

function prettyDate(iso: string): string {
  if (!ISO_RE.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map((s) => Number(s));
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  return dt.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export default function DailyRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const pushToast = useStore((s) => s.ui.pushToast);

  // The route's source-of-truth date. URL param wins, else today (local).
  const today = useMemo(() => localTodayIso(), []);
  const urlDate = searchParams.get("date");
  const initialDate = urlDate && ISO_RE.test(urlDate) ? urlDate : today;
  const [date, setDate] = useState(initialDate);

  const [content, setContent] = useState<string>("");
  const [originalContent, setOriginalContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [recent, setRecent] = useState<DailyNoteSummary[]>([]);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);

  const dirty = content !== originalContent;
  const datePickerRef = useRef<HTMLInputElement>(null);

  // Keep the URL in sync with the active date so deep-links work.
  useEffect(() => {
    if (urlDate !== date) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("date", date);
          return next;
        },
        { replace: true },
      );
    }
  }, [date, urlDate, setSearchParams]);

  // Ensure today's note exists on first mount, then load whatever date is active.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      // Idempotent ensure — only writes if the file doesn't exist.
      try {
        await dailyNotesEnsureToday({ date });
      } catch {
        // Best-effort; the read below will still try.
      }
      const body = await dailyNotesRead(date);
      if (cancelled) return;
      setContent(body);
      setOriginalContent(body);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [date]);

  // Load the recent notes for the calendar heatmap once on mount + after save.
  const refreshRecent = useCallback(async () => {
    const rows = await dailyNotesList({ limit: 30 });
    setRecent(rows);
  }, []);
  useEffect(() => {
    void refreshRecent();
  }, [refreshRecent]);

  // Load the template library once.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const rows = await templatesList();
      if (cancelled) return;
      setTemplates(rows);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Cmd+K → "Apply template…" pops this menu via the window event below.
  useEffect(() => {
    const onOpen = () => setPickerOpen(true);
    window.addEventListener(DAILY_TEMPLATE_MENU_OPEN_EVENT, onOpen);
    return () =>
      window.removeEventListener(DAILY_TEMPLATE_MENU_OPEN_EVENT, onOpen);
  }, []);

  const onPrev = useCallback(() => setDate((d) => addDays(d, -1)), []);
  const onNext = useCallback(() => setDate((d) => addDays(d, 1)), []);
  const onJumpToday = useCallback(() => setDate(today), [today]);

  const onPickerChange = (value: string) => {
    if (ISO_RE.test(value)) setDate(value);
  };

  const onSave = useCallback(async () => {
    if (!dirty) return;
    setSaving(true);
    try {
      await dailyNotesSave(date, content);
      setOriginalContent(content);
      void refreshRecent();
      pushToast(
        "success",
        t("daily.savedToast", { defaultValue: "Daily note saved." }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast(
        "error",
        t("daily.saveFailedToast", {
          defaultValue: "Save failed: {{msg}}",
          msg,
        }),
      );
    } finally {
      setSaving(false);
    }
  }, [content, date, dirty, pushToast, refreshRecent, t]);

  const onApplyTemplate = useCallback(
    async (tpl: TemplateSummary) => {
      try {
        const r = await templatesApply({ templateId: tpl.id, date });
        if (r.copied || r.rel_path) {
          navigate(`/memory/${r.rel_path}`);
          pushToast(
            "success",
            t("templates.appliedToast", {
              defaultValue: "Applied template: {{label}}",
              label: tpl.label,
            }),
          );
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        pushToast(
          "error",
          t("templates.applyFailedToast", {
            defaultValue: "Template apply failed: {{msg}}",
            msg,
          }),
        );
      }
    },
    [date, navigate, pushToast, t],
  );

  // Build a Set of YYYY-MM-DD that have recorded notes for the heatmap.
  const recentDateSet = useMemo(
    () => new Set(recent.map((r) => r.date)),
    [recent],
  );

  return (
    <div
      data-testid="daily-route"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      <header
        data-testid="daily-header"
        className="ti-no-select flex h-12 shrink-0 items-center justify-between border-b border-stone-200 px-6 dark:border-stone-800"
      >
        <div className="flex items-center gap-3">
          <CalendarIcon
            size={14}
            className="text-stone-500 dark:text-stone-400"
          />
          <h1 className="font-display text-base tracking-tight text-stone-900 dark:text-stone-100">
            {t("daily.heading", { defaultValue: "Daily notes" })}
          </h1>
          <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
            · {prettyDate(date)}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onPrev}
            data-testid="daily-prev"
            aria-label={t("daily.prev", { defaultValue: "Previous day" })}
          >
            <ChevronLeft size={14} />
          </Button>
          <input
            ref={datePickerRef}
            type="date"
            value={date}
            onChange={(e) => onPickerChange(e.target.value)}
            data-testid="daily-date-picker"
            className="rounded border border-stone-200 bg-white px-2 py-1 font-mono text-[12px] text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
            aria-label={t("daily.datePicker", { defaultValue: "Pick a date" })}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onNext}
            data-testid="daily-next"
            aria-label={t("daily.next", { defaultValue: "Next day" })}
          >
            <ChevronRight size={14} />
          </Button>
          {date !== today && (
            <Button
              variant="outline"
              size="sm"
              onClick={onJumpToday}
              data-testid="daily-jump-today"
            >
              {t("daily.today", { defaultValue: "Today" })}
            </Button>
          )}
          <div className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPickerOpen((v) => !v)}
              data-testid="daily-template-button"
              aria-haspopup="menu"
              aria-expanded={pickerOpen}
            >
              <FileText size={12} />
              {t("templates.applyButton", { defaultValue: "Apply template" })}
            </Button>
            {pickerOpen && (
              <ul
                role="menu"
                data-testid="daily-template-menu"
                className="absolute right-0 z-30 mt-1 w-72 overflow-hidden rounded-md border border-stone-200 bg-white shadow-lg dark:border-stone-700 dark:bg-stone-900"
              >
                {templates.length === 0 && (
                  <li className="px-3 py-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {t("templates.empty", {
                      defaultValue: "No templates installed.",
                    })}
                  </li>
                )}
                {templates.map((tpl) => (
                  <li key={tpl.id}>
                    <button
                      type="button"
                      data-testid={`daily-template-item-${tpl.id}`}
                      onClick={() => {
                        setPickerOpen(false);
                        void onApplyTemplate(tpl);
                      }}
                      className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] text-stone-800 hover:bg-stone-100 dark:text-stone-100 dark:hover:bg-stone-800"
                      role="menuitem"
                    >
                      <span>{tpl.label}</span>
                      {tpl.kind && (
                        <span className="font-mono text-[10px] uppercase tracking-wide text-stone-400">
                          {tpl.kind}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button
            size="sm"
            onClick={onSave}
            disabled={!dirty || saving}
            data-testid="daily-save"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {t("daily.save", { defaultValue: "Save" })}
          </Button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <section
          data-testid="daily-editor-pane"
          className="flex flex-1 flex-col bg-stone-50 px-6 py-4 dark:bg-stone-950"
        >
          {loading ? (
            <div
              data-testid="daily-loading"
              className="flex h-full items-center justify-center font-mono text-[12px] text-stone-400"
            >
              <Loader2 size={14} className="mr-2 animate-spin" />
              {t("daily.loading", { defaultValue: "Loading…" })}
            </div>
          ) : (
            <textarea
              data-testid="daily-editor"
              aria-label={t("daily.editorAria", {
                defaultValue: "Daily note editor",
              })}
              className="block h-full w-full flex-1 rounded-md border border-stone-200 bg-white p-4 font-mono text-[12px] leading-relaxed text-stone-900 outline-none focus:border-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          )}
        </section>

        <aside
          data-testid="daily-calendar-pane"
          className="flex w-[280px] shrink-0 flex-col border-l border-stone-200 bg-white px-3 py-4 dark:border-stone-800 dark:bg-stone-950"
        >
          <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {t("daily.heatmapHeading", {
              defaultValue: "Last 30 days",
            })}
          </h2>
          <CalendarHeatmap
            today={today}
            recentDates={recentDateSet}
            activeDate={date}
            onPick={setDate}
          />
          <h2 className="mb-2 mt-4 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {t("daily.recentHeading", { defaultValue: "Recent" })}
          </h2>
          <ul className="space-y-1 overflow-auto">
            {recent.length === 0 && (
              <li className="font-mono text-[11px] italic text-stone-400">
                {t("daily.recentEmpty", {
                  defaultValue: "No notes yet.",
                })}
              </li>
            )}
            {recent.slice(0, 10).map((r) => (
              <li key={r.date}>
                <button
                  type="button"
                  onClick={() => setDate(r.date)}
                  data-testid={`daily-recent-${r.date}`}
                  className={`block w-full rounded px-2 py-1 text-left font-mono text-[11px] hover:bg-stone-100 dark:hover:bg-stone-800 ${
                    r.date === date
                      ? "bg-stone-100 text-stone-900 dark:bg-stone-800 dark:text-stone-100"
                      : "text-stone-600 dark:text-stone-400"
                  }`}
                >
                  {r.date}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      </div>
    </div>
  );
}

/**
 * Heatmap-style 30-day calendar. Each cell is one local day; cells whose
 * date is in `recentDates` get a filled tint, cells matching `activeDate`
 * get the orange ring, today gets a subtle border. Pure CSS grid.
 */
function CalendarHeatmap({
  today,
  recentDates,
  activeDate,
  onPick,
}: {
  today: string;
  recentDates: Set<string>;
  activeDate: string;
  onPick: (iso: string) => void;
}) {
  // 30 cells, oldest first, today last (reading order).
  const days = useMemo(() => {
    const out: string[] = [];
    for (let i = 29; i >= 0; i--) {
      out.push(addDays(today, -i));
    }
    return out;
  }, [today]);

  return (
    <div
      data-testid="daily-heatmap"
      className="grid grid-cols-7 gap-1"
      role="grid"
      aria-label="Daily-note heatmap, last 30 days"
    >
      {days.map((iso) => {
        const has = recentDates.has(iso);
        const isActive = iso === activeDate;
        const isToday = iso === today;
        const baseTone = has
          ? "bg-[var(--ti-orange-500)] text-white"
          : "bg-stone-100 text-stone-400 dark:bg-stone-800 dark:text-stone-600";
        return (
          <button
            key={iso}
            type="button"
            onClick={() => onPick(iso)}
            data-testid={`daily-heatmap-cell-${iso}`}
            data-has-note={has ? "true" : "false"}
            title={iso}
            className={`flex h-7 items-center justify-center rounded text-[10px] font-mono transition ${baseTone} ${
              isActive ? "ring-2 ring-[var(--ti-orange-500)] ring-offset-1" : ""
            } ${isToday ? "border border-stone-400" : ""}`}
          >
            {Number(iso.slice(-2))}
          </button>
        );
      })}
    </div>
  );
}
// === end wave 24 ===
