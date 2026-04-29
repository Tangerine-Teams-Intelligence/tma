import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { MessageCircle, AlertCircle } from "lucide-react";
import {
  readThreadsList,
  formatRelativeTime,
  type ThreadRow,
  type TangerineNote,
} from "@/lib/views";
import { TangerineNotes } from "@/components/TangerineNotes";
import { Skeleton } from "@/components/ui/Skeleton";
// === v1.16 Wave 1 === — EmptyStateCard onboarding card砍 (smart layer gone).

/**
 * /threads — list of every conversational thread Tangerine has captured.
 * Auto-derived from `refs.threads` across atoms.
 */
export default function ThreadsListRoute() {
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // === v1.16 Wave 1 === — `firstAtomCapturedAt` latch read砍.

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    readThreadsList()
      .then((d) => {
        if (cancel) return;
        setRows(d.threads);
        setNotes(d.notes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read threads.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <TangerineNotes notes={notes} route="threads" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <MessageCircle size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">Threads</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Open threads
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {rows.length} thread{rows.length === 1 ? "" : "s"} captured
            </p>
          </div>
        </header>

        <section className="mt-8 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
          {loading ? (
            <div className="space-y-2 px-4 py-4" aria-busy="true" data-testid="threads-loading">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="grid grid-cols-[2fr_1fr_1fr] items-center gap-3">
                  <Skeleton className="h-3 w-24" />
                  <Skeleton className="ml-auto h-3 w-8" />
                  <Skeleton className="ml-auto h-3 w-12" />
                </div>
              ))}
            </div>
          ) : error ? (
            <div role="alert" className="px-4 py-8 text-center">
              <AlertCircle size={20} className="mx-auto text-[var(--ti-danger)]" />
              <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
                Couldn't read threads.
              </p>
              <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
                {error}
              </p>
              <button
                type="button"
                onClick={() => setRefreshKey((k) => k + 1)}
                className="mt-3 rounded border border-stone-300 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                Retry
              </button>
            </div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center" data-testid="threads-empty-returning">
              <MessageCircle size={20} className="mx-auto text-stone-400" />
              <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
                No threads captured yet.
              </p>
              <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
                Threads form when atoms share a `refs.threads` value (e.g. "pr-47", "pricing").
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              <li className="grid grid-cols-[2fr_1fr_1fr] gap-3 bg-stone-100 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                <span>topic</span>
                <span className="text-right">atoms</span>
                <span className="text-right">last active</span>
              </li>
              {rows.map((r) => (
                <li
                  key={r.topic}
                  className="grid grid-cols-[2fr_1fr_1fr] gap-3 px-4 py-2 hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <Link
                    to={`/threads/${encodeURIComponent(r.topic)}`}
                    className="font-mono text-[12px] text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
                  >
                    #{r.topic}
                  </Link>
                  <span className="text-right font-mono text-[12px] text-stone-700 dark:text-stone-300">
                    {r.atom_count}
                  </span>
                  <span className="text-right font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {formatRelativeTime(r.last_active)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
