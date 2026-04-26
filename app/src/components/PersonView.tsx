import { Link } from "react-router-dom";
import { User, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PersonDetailData } from "@/lib/views";
import { TimelineEvent } from "@/components/TimelineEvent";

/**
 * Shared shell for /people/:alias. Pure render — the route handles loading
 * the data + cursor writes (mark_atom_viewed when the user opens an atom).
 *
 * Sections:
 *   1. Hero: alias + atom count + last active
 *   2. Recent activity (last 30 days from the atom's perspective)
 *   3. Mentioned projects + threads (chips → /projects/:slug + /threads/:topic)
 *   4. "Brief them" CTA — Stage 2 will compose a brief from the user's
 *      cursor state. Stage 1 placeholder.
 */
export function PersonView({
  data,
  onAtomViewed,
}: {
  data: PersonDetailData;
  onAtomViewed?: (atomId: string) => void;
}) {
  return (
    <>
      <header className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
          <User size={20} className="text-stone-500" />
        </div>
        <div>
          <p className="ti-section-label">Person</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            @{data.alias}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {data.recent_events.length} events captured · last 30 days
          </p>
        </div>
        <div className="ml-auto">
          <Button
            variant="default"
            size="sm"
            disabled
            title="Stage 2: brief composer reads cursor + recent atoms"
          >
            Brief them
          </Button>
        </div>
      </header>

      <section className="mt-8">
        <p className="ti-section-label">Recent activity</p>
        {data.recent_events.length === 0 ? (
          <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
            No captured atoms in the last 30 days.
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
          title="Projects"
          items={data.mentioned_projects}
          to={(slug) => `/projects/${encodeURIComponent(slug)}`}
        />
        <ChipsCard
          title="Threads"
          items={data.mentioned_threads}
          to={(topic) => `/threads/${encodeURIComponent(topic)}`}
        />
      </div>
    </>
  );
}

function ChipsCard({
  title,
  items,
  to,
}: {
  title: string;
  items: string[];
  to: (item: string) => string;
}) {
  return (
    <section className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
      <p className="ti-section-label">{title}</p>
      {items.length === 0 ? (
        <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
          None mentioned yet.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {items.map((it) => (
            <Link
              key={it}
              to={to(it)}
              className="inline-flex items-center gap-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:border-[var(--ti-orange-500)] hover:bg-[var(--ti-orange-50)] hover:text-[var(--ti-orange-700)] dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700"
            >
              {it}
              <ArrowRight size={10} />
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
