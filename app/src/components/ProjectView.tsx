import { Link } from "react-router-dom";
import { FolderKanban, ArrowRight } from "lucide-react";
import type { ProjectDetailData } from "@/lib/views";
import { TimelineEvent } from "@/components/TimelineEvent";

/**
 * Shared shell for /projects/:slug. Pure render — the route handles
 * loading + cursor writes.
 *
 * Sections:
 *   1. Hero: project slug + atom count + member count
 *   2. Recent activity (last 60 atoms touching this project)
 *   3. Members + Threads chips → drill to /people/:alias and /threads/:topic
 */
export function ProjectView({
  data,
  onAtomViewed,
}: {
  data: ProjectDetailData;
  onAtomViewed?: (atomId: string) => void;
}) {
  return (
    <>
      <header className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
          <FolderKanban size={20} className="text-stone-500" />
        </div>
        <div>
          <p className="ti-section-label">Project</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            {data.slug}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {data.recent_events.length} events · {data.members.length} members
          </p>
        </div>
      </header>

      <section className="mt-8">
        <p className="ti-section-label">Recent activity</p>
        {data.recent_events.length === 0 ? (
          <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
            No atoms reference this project yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
            {data.recent_events.map((ev) => (
              <li key={ev.id}>
                <TimelineEvent event={ev} onView={onAtomViewed} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="mt-8 grid grid-cols-1 gap-4 md:grid-cols-2">
        <ChipsCard
          title="Members"
          items={data.members}
          to={(a) => `/people/${encodeURIComponent(a)}`}
          prefix="@"
        />
        <ChipsCard
          title="Threads"
          items={data.threads}
          to={(t) => `/threads/${encodeURIComponent(t)}`}
        />
      </div>
    </>
  );
}

function ChipsCard({
  title,
  items,
  to,
  prefix = "",
}: {
  title: string;
  items: string[];
  to: (item: string) => string;
  prefix?: string;
}) {
  return (
    <section className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
      <p className="ti-section-label">{title}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
          None yet.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.map((it) => (
            <Link
              key={it}
              to={to(it)}
              className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:border-[var(--ti-orange-500)] hover:bg-[var(--ti-orange-50)] hover:text-[var(--ti-orange-700)] dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
            >
              {prefix}
              {it}
              <ArrowRight size={10} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
