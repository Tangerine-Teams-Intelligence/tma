/**
 * v1.16 Wave 2 Agent B2 — /threads ThreadCard.
 *
 * Single thread row visual primitive. A "thread" in v1.16 = a set of atoms
 * sharing the same @mention set (e.g. atoms whose body @-mentions
 * `[hongyu]` form one thread, atoms mentioning `[hongyu, bob]` form a
 * different thread). Threads are derived purely from atom body text — no
 * `refs.threads` wave-4 plumbing.
 *
 * Card surface (collapsed):
 *   - Title row: "with @hongyu" / "with @hongyu, @bob" / "Uncategorized"
 *   - Atom count badge
 *   - Latest atom body preview (first 80 chars)
 *   - Latest atom relative time
 *
 * Click → expand inline. Expanded view renders one B1 AtomCard per atom
 * in the thread (alwaysExpanded so long bodies don't double-toggle).
 *
 * R6/R7/R8 honesty: parent owns loading/error/empty. This card just
 * paints what it's given.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TimelineEvent } from "@/lib/views";
import { formatRelativeTime } from "@/lib/views";
import { AtomCard } from "@/components/feed/AtomCard";

const PREVIEW_MAX = 80;

export interface Thread {
  /** Stable key — sorted+joined mention set, e.g. "bob,hongyu". Empty
   *  string for the Uncategorized bucket. */
  key: string;
  /** Display title — "with @hongyu, @bob" or "Uncategorized". */
  title: string;
  /** Sorted lowercase mention aliases. Empty for Uncategorized. */
  mentions: string[];
  /** Atoms in the thread, newest first. */
  events: TimelineEvent[];
}

export interface ThreadCardProps {
  thread: Thread;
  /** Optional initial expansion. Default false. Tests / future deep-link
   *  may force-open on mount. */
  defaultExpanded?: boolean;
}

export function ThreadCard({ thread, defaultExpanded = false }: ThreadCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const latest = thread.events[0];
  const previewSource = (latest?.body ?? "").split("\n").find((l) => l.trim().length > 0) ?? "";
  const preview =
    previewSource.length > PREVIEW_MAX
      ? previewSource.slice(0, PREVIEW_MAX) + "…"
      : previewSource || (latest?.kind ?? "(no body)");
  const time = formatRelativeTime(latest?.ts ?? "");
  const handleToggle = () => setExpanded((v) => !v);

  return (
    <article
      data-testid={`thread-card-${thread.key || "uncategorized"}`}
      data-thread-key={thread.key}
      data-expanded={expanded ? "true" : "false"}
      className="rounded-md border border-stone-200 bg-white transition-shadow hover:shadow-sm dark:border-stone-800 dark:bg-stone-900"
    >
      <button
        type="button"
        data-testid={`thread-card-toggle-${thread.key || "uncategorized"}`}
        onClick={handleToggle}
        className="flex w-full items-start gap-3 px-3 py-3 text-left"
      >
        <span
          aria-hidden
          className="mt-1 text-stone-400 dark:text-stone-500"
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px]">
            <span
              data-testid={`thread-card-title-${thread.key || "uncategorized"}`}
              className="truncate font-semibold text-stone-900 dark:text-stone-100"
            >
              {thread.title}
            </span>
            {thread.mentions.length > 0 && (
              <span
                data-testid={`thread-card-mention-emphasis-${thread.key}`}
                className="rounded bg-[var(--ti-orange-50)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ti-orange-700)]"
              >
                @{thread.mentions[0]}
                {thread.mentions.length > 1 && ` +${thread.mentions.length - 1}`}
              </span>
            )}
            <span
              data-testid={`thread-card-count-${thread.key || "uncategorized"}`}
              className="ml-auto rounded-full bg-stone-100 px-2 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
            >
              {thread.events.length} atom{thread.events.length === 1 ? "" : "s"}
            </span>
          </div>
          <p
            data-testid={`thread-card-preview-${thread.key || "uncategorized"}`}
            className="mt-1.5 truncate text-[12px] text-stone-700 dark:text-stone-300"
          >
            {preview}
          </p>
          {latest && (
            <time
              dateTime={latest.ts}
              title={latest.ts}
              data-testid={`thread-card-time-${thread.key || "uncategorized"}`}
              className="mt-1 block font-mono text-[10px] text-stone-500 dark:text-stone-400"
            >
              {time}
            </time>
          )}
        </div>
      </button>
      {expanded && (
        <div
          data-testid={`thread-card-expanded-${thread.key || "uncategorized"}`}
          className="space-y-2 border-t border-stone-200 bg-stone-50 px-3 py-3 dark:border-stone-800 dark:bg-stone-950"
        >
          {thread.events.map((ev) => (
            <AtomCard key={ev.id} event={ev} alwaysExpanded />
          ))}
        </div>
      )}
    </article>
  );
}
