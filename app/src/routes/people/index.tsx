import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Users } from "lucide-react";
import {
  readPeopleList,
  formatRelativeTime,
  type PersonRow,
  type TangerineNote,
} from "@/lib/views";
import { TangerineNotes } from "@/components/TangerineNotes";

/**
 * /people — list of every alias Tangerine has captured atoms for. Auto-
 * derived from atoms (actor + actors + refs.people). Each row links to
 * /people/:alias with last-active + atom count + same-screen rate.
 *
 * Same-screen rate column is null in Stage 1 unless the alignment
 * snapshot has tracked the user; we render — when null.
 */
export default function PeopleListRoute() {
  const [rows, setRows] = useState<PersonRow[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    void readPeopleList().then((d) => {
      if (cancel) return;
      setRows(d.people);
      setNotes(d.notes);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <TangerineNotes notes={notes} route="people" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <Users size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">People</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Team
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {rows.length} member{rows.length === 1 ? "" : "s"} captured from atoms
            </p>
          </div>
        </header>

        <section className="mt-8 overflow-hidden rounded-md border border-stone-200 dark:border-stone-800">
          {loading ? (
            <p className="px-4 py-6 text-center text-[12px] text-stone-500 dark:text-stone-400">
              Loading…
            </p>
          ) : rows.length === 0 ? (
            <div className="px-4 py-8 text-center">
              <p className="text-[12px] text-stone-500 dark:text-stone-400">
                No people captured yet.
              </p>
              <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">
                Connect a source — once an atom mentions @someone, they'll show up here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              <li className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 bg-stone-100 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                <span>alias</span>
                <span className="text-right">atoms</span>
                <span className="text-right">last active</span>
                <span className="text-right">same-screen</span>
              </li>
              {rows.map((r) => (
                <li
                  key={r.alias}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-2 hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <Link
                    to={`/people/${encodeURIComponent(r.alias)}`}
                    className="font-mono text-[12px] text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
                  >
                    @{r.alias}
                  </Link>
                  <span className="text-right font-mono text-[12px] text-stone-700 dark:text-stone-300">
                    {r.atom_count}
                  </span>
                  <span className="text-right font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {formatRelativeTime(r.last_active)}
                  </span>
                  <span className="text-right font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {r.same_screen_rate == null
                      ? "—"
                      : `${Math.round(r.same_screen_rate * 100)}%`}
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
