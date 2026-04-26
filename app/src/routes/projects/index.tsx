import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { FolderKanban } from "lucide-react";
import {
  readProjectsList,
  formatRelativeTime,
  type ProjectRow,
  type TangerineNote,
} from "@/lib/views";
import { TangerineNotes } from "@/components/TangerineNotes";

/**
 * /projects — list of every project slug Tangerine has captured atoms for.
 * Auto-derived from `refs.projects` across atoms.
 */
export default function ProjectsListRoute() {
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    void readProjectsList().then((d) => {
      if (cancel) return;
      setRows(d.projects);
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
        <TangerineNotes notes={notes} route="projects" />

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <FolderKanban size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">Projects</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Active projects
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {rows.length} project{rows.length === 1 ? "" : "s"} captured from atoms
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
                No projects captured yet.
              </p>
              <p className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">
                Tag atoms with refs.projects so they aggregate here.
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-stone-200 dark:divide-stone-800">
              <li className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 bg-stone-100 px-4 py-2 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:bg-stone-900 dark:text-stone-400">
                <span>slug</span>
                <span className="text-right">atoms</span>
                <span className="text-right">members</span>
                <span className="text-right">last active</span>
              </li>
              {rows.map((r) => (
                <li
                  key={r.slug}
                  className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-3 px-4 py-2 hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <Link
                    to={`/projects/${encodeURIComponent(r.slug)}`}
                    className="font-mono text-[12px] text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
                  >
                    {r.slug}
                  </Link>
                  <span className="text-right font-mono text-[12px] text-stone-700 dark:text-stone-300">
                    {r.atom_count}
                  </span>
                  <span className="text-right font-mono text-[12px] text-stone-700 dark:text-stone-300">
                    {r.member_count}
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
