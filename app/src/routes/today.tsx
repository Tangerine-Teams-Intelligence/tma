import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar } from "lucide-react";
import {
  readBrief,
  readTimelineToday,
  markAtomViewed,
  markAtomAcked,
  type BriefData,
  type TimelineSlice,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { DailyBriefCard } from "@/components/DailyBriefCard";
import { TimelineEvent } from "@/components/TimelineEvent";

/**
 * /today — default landing surface for the Chief of Staff UX.
 *
 * Layout (center pane only — sidebar + activity rail come from AppShell):
 *
 *   <TangerineNotes>            (Hook 5 — Stage 1 = empty, Stage 2 fills)
 *   Today · Friday Apr 25
 *   <DailyBriefCard>            (collapsible markdown brief)
 *   ─────────
 *   <chronological events>      (clickable; cursor.atoms_viewed updates)
 *   ─────────
 *   Now <time>                  (clock footer)
 *
 * Reads:
 *   • read_brief(today)         → daily brief markdown
 *   • read_timeline_today(today)→ chronological event list
 *
 * Writes (cursor):
 *   • mark_atom_viewed when an event row is clicked (drill-down)
 *   • mark_atom_acked when "Mark read" on the brief
 */
export default function TodayRoute() {
  const today = todayIso();
  const currentUser = useStore((s) => s.ui.currentUser);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [slice, setSlice] = useState<TimelineSlice | null>(null);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [briefAcked, setBriefAcked] = useState(false);
  const [now, setNow] = useState(() => new Date().toLocaleTimeString());

  useEffect(() => {
    let cancel = false;
    void readBrief(today).then((b) => {
      if (!cancel) setBrief(b);
    });
    void readTimelineToday(today).then((s) => {
      if (!cancel) {
        setSlice(s);
        // Stage 2 hook: notes per route. Stage 1 always [].
        setNotes(s.notes ?? []);
      }
    });
    return () => {
      cancel = true;
    };
  }, [today]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleTimeString()), 60_000);
    return () => clearInterval(id);
  }, []);

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  const onMarkBriefRead = () => {
    if (briefAcked) return;
    setBriefAcked(true);
    // The brief atom id format mirrors `Event::id` for kind=brief. We
    // synthesize the same shape from the date so the cursor tracks acks
    // even when the daemon hasn't tagged the file with a stable atom id
    // yet (Stage 1 brief generator writes only the markdown).
    const briefAtomId = synthesizeBriefAtomId(today);
    void markAtomAcked(currentUser, briefAtomId);
  };

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /today</span>
        <span className="ml-auto">
          Now <span className="text-stone-700 dark:text-stone-300">{now}</span>
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-8">
        <TangerineNotes notes={notes} route="today" />

        <header className="mb-6 flex items-center gap-3">
          <Calendar size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">Today</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {prettyDate(today)}
            </h1>
          </div>
        </header>

        <DailyBriefCard
          date={today}
          markdown={brief?.markdown ?? null}
          exists={brief?.exists ?? false}
          acked={briefAcked}
          onMarkRead={onMarkBriefRead}
        />

        <section>
          <p className="ti-section-label">Timeline</p>
          {slice && slice.events.length === 0 ? (
            <div className="mt-4 rounded-md border border-dashed border-stone-300 p-6 text-center dark:border-stone-700">
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                Nothing captured yet today.
              </p>
              <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">
                <Link
                  to="/sources/discord"
                  className="text-[var(--ti-orange-700)] underline-offset-2 hover:underline dark:text-[var(--ti-orange-500)]"
                >
                  Connect a source
                </Link>{" "}
                to start the feed.
              </p>
            </div>
          ) : (
            <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
              {slice?.events.map((ev) => (
                <li key={ev.id}>
                  <TimelineEvent event={ev} onView={onAtomViewed} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          Sources fan out into ~/.tangerine-memory · daemon refreshes every 5 min
        </p>
      </div>
    </div>
  );
}

function todayIso(): string {
  // YYYY-MM-DD in local time so the brief lookup matches the daemon's
  // Local::now() write.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

/** Synthesize a stable atom-id-shaped value for today's brief so cursor
 *  acks have something to write against even before the brief generator
 *  emits a real atom. Stage 2 will read these atoms_acked entries to
 *  learn the user's reading cadence. */
function synthesizeBriefAtomId(date: string): string {
  // 10 hex chars from the date string — deterministic so re-acks land
  // on the same id.
  let h = 0;
  for (const c of `brief|${date}`) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  const hex = h.toString(16).padStart(10, "0").slice(0, 10);
  return `evt-${date}-${hex}`;
}
