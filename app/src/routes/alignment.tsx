import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Disc,
  FileText,
  Users,
} from "lucide-react";
import {
  readAlignment,
  readTimelineRecent,
  type AlignmentData,
  type TimelineEvent,
  type TangerineNote,
} from "@/lib/views";
import { TangerineNotes } from "@/components/TangerineNotes";
import { AlignmentBars } from "@/components/AlignmentBars";
import { Skeleton } from "@/components/ui/Skeleton";

/**
 * /alignment — real same-screen rate dashboard.
 *
 * Reads `read_alignment` (parsed `<memory>/.tangerine/alignment.json`) and
 * `read_timeline_recent` for the capture-stats counters. Stage 1 ships
 * with the live rate from cursor diff (per_user_seen ÷ total_atoms);
 * Stage 2 adds the predictive layer ("members behind", what's about to
 * stale).
 *
 * Sections:
 *   1. Big hero number — overall rate %
 *   2. Per-member coverage bars
 *   3. Capture stats (last 7 days) per source
 *   4. Memory growth (this week vs last week)
 *   5. "What's behind alignment loss" — actionable list
 */
export default function AlignmentRoute() {
  const [data, setData] = useState<AlignmentData | null>(null);
  const [recent, setRecent] = useState<TimelineEvent[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    let cancel = false;
    Promise.all([readAlignment(), readTimelineRecent(500)])
      .then(([d, t]) => {
        if (cancel) return;
        setData(d);
        setNotes(d.notes);
        setRecent(t.events);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read alignment data.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  };

  useEffect(() => {
    return load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stats7d = useMemo(() => statsForRange(recent, 7), [recent]);
  const stats14d = useMemo(() => statsForRange(recent, 14), [recent]);
  const growth = useMemo(() => {
    const last7 = stats7d.total;
    const prev7 = Math.max(0, stats14d.total - stats7d.total);
    if (prev7 === 0) return last7 > 0 ? 100 : 0;
    return Math.round(((last7 - prev7) / prev7) * 100);
  }, [stats7d, stats14d]);

  const lostAlignment = useMemo(() => {
    if (!data) return [];
    const total = data.latest.total_atoms;
    return data.latest.users
      .map((u) => {
        const seen = data.latest.per_user_seen[u] ?? 0;
        const missed = Math.max(0, total - seen);
        return { user: u, missed };
      })
      .filter((r) => r.missed > 0)
      .sort((a, b) => b.missed - a.missed)
      .slice(0, 4);
  }, [data]);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-5xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/today"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> /today
          </Link>
        </div>

        <TangerineNotes notes={notes} route="alignment" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <Activity size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">Alignment</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Same-screen rate
            </h1>
          </div>
        </header>

        {error ? (
          <div
            role="alert"
            className="mt-8 rounded-md border border-[var(--ti-danger)]/40 bg-[var(--ti-danger)]/5 p-6 text-center"
          >
            <AlertCircle size={20} className="mx-auto text-[var(--ti-danger)]" />
            <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
              Couldn't read alignment snapshot.
            </p>
            <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
              {error}
            </p>
            <button
              type="button"
              onClick={load}
              className="mt-3 rounded border border-stone-300 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="mt-8 space-y-6" data-testid="alignment-loading" aria-busy="true">
            <div className="rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="mt-4 h-12 w-40" />
              <Skeleton className="mt-4 h-2 w-full" />
            </div>
            <div className="rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
              <Skeleton className="h-3 w-32" />
              <div className="mt-4 space-y-2">
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-5/6" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          </div>
        ) : (
          <>
        {/* Hero metric */}
        <section className="mt-8 rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
          <p className="ti-section-label">Team alignment</p>
          <div className="mt-3 flex items-baseline gap-4">
            <span className="font-display text-6xl tracking-tight text-stone-900 dark:text-stone-100">
              {Math.round((data?.latest.rate ?? 0) * 100)}%
            </span>
            <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
              {data?.latest.shared_viewed ?? 0} / {data?.latest.total_atoms ?? 0} atoms shared
            </span>
          </div>
          <div className="mt-4 h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
            <div
              className="h-2 rounded bg-[var(--ti-orange-500)]"
              style={{ width: `${Math.round((data?.latest.rate ?? 0) * 100)}%` }}
            />
          </div>
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
            Share of captured atoms viewed by every tracked team member. Live
            from cursor diff in <code>.tangerine/alignment.json</code>.
          </p>
        </section>

        {/* Per-member coverage */}
        <section className="mt-6 rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
          <div className="mb-4 flex items-center gap-2">
            <Users size={14} className="text-stone-500" />
            <p className="ti-section-label">Member coverage</p>
          </div>
          {data ? <AlignmentBars snapshot={data.latest} /> : null}
        </section>

        {/* Capture stats */}
        <section className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <CaptureCard
            icon={<Disc size={14} />}
            label="Meetings captured"
            value={String(stats7d.meetings)}
            sub="last 7 days"
          />
          <CaptureCard
            icon={<FileText size={14} />}
            label="Decisions extracted"
            value={String(stats7d.decisions)}
            sub="last 7 days"
          />
          <CaptureCard
            icon={<Users size={14} />}
            label="Active members"
            value={`${data?.latest.users.length ?? 0}`}
            sub="tracked in cursor"
          />
          <CaptureCard
            icon={<Activity size={14} />}
            label="Total atoms"
            value={String(data?.latest.total_atoms ?? 0)}
            sub={`${growth >= 0 ? "+" : ""}${growth}% vs prior week`}
          />
        </section>

        {/* Behind alignment loss */}
        <section className="mt-6 rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
          <p className="ti-section-label">What's behind alignment loss</p>
          {lostAlignment.length === 0 ? (
            <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
              Everyone tracked has viewed every captured atom. Same-screen rate is healthy.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
              {lostAlignment.map((r) => (
                <li
                  key={r.user}
                  className="flex items-center gap-3 py-2 text-[12px] text-stone-700 dark:text-stone-300"
                >
                  <Link
                    to={`/people/${encodeURIComponent(r.user)}`}
                    className="font-mono text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
                  >
                    @{r.user}
                  </Link>
                  <span className="text-stone-500 dark:text-stone-400">
                    has missed{" "}
                    <strong className="text-stone-900 dark:text-stone-100">
                      {r.missed}
                    </strong>{" "}
                    atom{r.missed === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto inline-flex items-center gap-1 font-mono text-[11px] text-stone-400 dark:text-stone-500">
                    push brief <ArrowRight size={11} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="mt-6 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          Snapshot computed{" "}
          {data?.latest.computed_at
            ? new Date(data.latest.computed_at).toLocaleString()
            : "(never)"}
        </p>
          </>
        )}
      </div>
    </div>
  );
}

function CaptureCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {icon}
        {label}
      </p>
      <p className="mt-2 font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        {value}
      </p>
      <p className="mt-1 text-[10px] text-stone-500 dark:text-stone-400">{sub}</p>
    </div>
  );
}

function statsForRange(events: TimelineEvent[], days: number) {
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const slice = events.filter((e) => !e.sample && e.ts.slice(0, 10) >= cutoff);
  return {
    total: slice.length,
    meetings: slice.filter((e) => e.kind === "meeting_chunk").length,
    decisions: slice.filter((e) => e.kind === "decision").length,
  };
}
