import { Link } from "react-router-dom";
import { MessageCircle } from "lucide-react";
import type { ThreadDetailData } from "@/lib/views";
import { TimelineEvent } from "@/components/TimelineEvent";

/**
 * Shared shell for /threads/:topic. Pure render — the route handles
 * loading + cursor writes.
 *
 * Sections:
 *   1. Hero: topic + atom count + members
 *   2. Chronological timeline of atoms in the thread (oldest → newest)
 *      so the discussion reads naturally top-to-bottom.
 */
export function ThreadView({
  data,
  onAtomViewed,
}: {
  data: ThreadDetailData;
  onAtomViewed?: (atomId: string) => void;
}) {
  return (
    <>
      <header className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
          <MessageCircle size={20} className="text-stone-500" />
        </div>
        <div>
          <p className="ti-section-label">Thread</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            #{data.topic}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {data.events.length} atoms ·{" "}
            {data.members.map((m) => (
              <span key={m}>
                <Link
                  to={`/people/${encodeURIComponent(m)}`}
                  className="hover:text-stone-900 dark:hover:text-stone-100"
                >
                  @{m}
                </Link>
                <span className="mx-0.5"> </span>
              </span>
            ))}
          </p>
        </div>
      </header>

      <section className="mt-8">
        <p className="ti-section-label">Timeline</p>
        {data.events.length === 0 ? (
          <p className="mt-3 text-[12px] text-stone-500 dark:text-stone-400">
            No atoms reference this thread yet.
          </p>
        ) : (
          <ol className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
            {data.events.map((ev) => (
              <li key={ev.id}>
                <TimelineEvent event={ev} onView={onAtomViewed} />
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
