// === wave 5-α ===
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { ArrowLeft, CalendarRange } from "lucide-react";
import {
  readTimelineRecent,
  computeWeekStats,
  type TimelineEvent as TimelineEventT,
  type TangerineNote,
} from "@/lib/views";
import { TangerineNotes } from "@/components/TangerineNotes";
import { TimelineEvent } from "@/components/TimelineEvent";

/**
 * /this-week — last 7 days aggregation.
 *
 *   • Counts: meetings / decisions / PRs / comments / tickets
 *   • Top decisions made (kind === "decision")
 *   • Stale threads — atoms with status: "stale" or no recent follow-up
 *   • Member activity heatmap (text breakdown)
 *
 * Reads `read_timeline_recent(500)` and slices to last 7 days client-side
 * to keep the wire payload small.
 */
export default function ThisWeekRoute() {
  const { t } = useTranslation();
  const [events, setEvents] = useState<TimelineEventT[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);

  useEffect(() => {
    let cancel = false;
    void readTimelineRecent(500).then((d) => {
      if (cancel) return;
      setEvents(d.events);
      setNotes(d.notes);
    });
    return () => {
      cancel = true;
    };
  }, []);

  const cutoff = useMemo(() => {
    const d = new Date(Date.now() - 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  }, []);

  const weekEvents = useMemo(
    () => events.filter((e) => e.ts.slice(0, 10) >= cutoff),
    [events, cutoff],
  );

  const stats = useMemo(() => computeWeekStats(weekEvents), [weekEvents]);
  const decisions = useMemo(
    () => weekEvents.filter((e) => e.kind === "decision").slice(0, 6),
    [weekEvents],
  );
  const stale = useMemo(
    () =>
      weekEvents.filter(
        (e) =>
          e.status === "stale" ||
          (e.lifecycle &&
            typeof e.lifecycle === "object" &&
            "review_by" in (e.lifecycle as Record<string, unknown>) &&
            (e.lifecycle as Record<string, string>).review_by < new Date().toISOString()),
      ).slice(0, 6),
    [weekEvents],
  );

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/today"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /today
          </Link>
        </div>

        <TangerineNotes notes={notes} route="this-week" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <CalendarRange size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">{t("thisWeek.kicker")}</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {t("thisWeek.title")}
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {t("thisWeek.captured", { count: weekEvents.length, cutoff })}
            </p>
          </div>
        </header>

        <section className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat n={stats.meetings} label={t("thisWeek.labelMeetings")} />
          <Stat n={stats.decisions} label={t("thisWeek.labelDecisions")} />
          <Stat n={stats.prs} label={t("thisWeek.labelPRs")} />
          <Stat n={stats.comments} label={t("thisWeek.labelComments")} />
          <Stat n={stats.tickets} label={t("thisWeek.labelTickets")} />
        </section>

        <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
          <section className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
            <p className="ti-section-label">{t("thisWeek.topDecisions")}</p>
            {decisions.length === 0 ? (
              <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
                {t("thisWeek.noDecisions")}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
                {decisions.map((ev) => (
                  <li key={ev.id}>
                    <TimelineEvent event={ev} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
            <p className="ti-section-label">{t("thisWeek.staleThreads")}</p>
            {stale.length === 0 ? (
              <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
                {t("thisWeek.nothingStale")}
              </p>
            ) : (
              <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
                {stale.map((ev) => (
                  <li key={ev.id}>
                    <TimelineEvent event={ev} compact />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <section className="mt-8 rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
          <p className="ti-section-label">{t("thisWeek.memberActivity")}</p>
          {Object.keys(stats.by_member).length === 0 ? (
            <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
              {t("thisWeek.noActivity")}
            </p>
          ) : (
            <div className="mt-3 space-y-2">
              {Object.entries(stats.by_member)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([alias, count]) => {
                  const max = Math.max(...Object.values(stats.by_member));
                  const pct = max > 0 ? Math.round((count / max) * 100) : 0;
                  return (
                    <div key={alias}>
                      <div className="flex items-center justify-between text-xs">
                        <Link
                          to={`/people/${encodeURIComponent(alias)}`}
                          className="font-mono text-stone-700 hover:text-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
                        >
                          @{alias}
                        </Link>
                        <span className="font-mono text-stone-500 dark:text-stone-400">
                          {count}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
                        <div
                          className="h-1 rounded bg-[var(--ti-orange-500)]"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        {n}
      </p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {label}
      </p>
    </div>
  );
}
// === end wave 5-α ===
