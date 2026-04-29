/**
 * v1.16 Wave 2 — bottom-pinned search + filter chips for the Story Feed.
 * Filter is multi-AND: clicking [@Me] AND [Cursor] shows only Cursor
 * atoms authored by current user. Chips are pure UI — the actual
 * filtering happens in feed.tsx by reading these state values.
 */

import { useEffect, useRef } from "react";
import { Search } from "lucide-react";

export interface FeedFilter {
  /** Limit to current user's atoms. */
  onlyMe: boolean;
  /** Limit to last 24h. */
  todayOnly: boolean;
  /** Source filter — empty array = all sources. */
  sources: string[];
  /** Free-text search query (matches body / actor / concepts). */
  query: string;
}

export const EMPTY_FILTER: FeedFilter = {
  onlyMe: false,
  todayOnly: false,
  sources: [],
  query: "",
};

interface FilterChipsProps {
  filter: FeedFilter;
  onChange: (next: FeedFilter) => void;
  /** Sources detected from current atom set, used to populate vendor
   *  filter chips. e.g. ["cursor", "claude-code", "slack"]. */
  availableSources: string[];
}

export function FilterChips({ filter, onChange, availableSources }: FilterChipsProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Cmd+/ focuses the search box.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "/") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div
      data-testid="feed-filter-chips"
      className="sticky bottom-0 left-0 right-0 z-20 border-t border-stone-200 bg-white/95 px-3 py-2 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95 md:px-4"
    >
      {/* v1.16 Wave 5 — search row stays full-width; chip row breaks to
          a second row on mobile and scrolls horizontally if chips
          overflow the 375px viewport. Desktop keeps everything inline. */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 md:flex-row md:items-center">
        <div className="flex items-center gap-2 rounded border border-stone-300 bg-white px-2 py-1 dark:border-stone-700 dark:bg-stone-900 md:flex-1">
          <Search size={14} className="shrink-0 text-stone-400" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            placeholder="Search captures…  (Cmd+/)"
            value={filter.query}
            onChange={(e) => onChange({ ...filter, query: e.target.value })}
            data-testid="feed-search-input"
            className="w-full bg-transparent text-[12px] outline-none dark:text-stone-100"
          />
        </div>
        <div
          data-testid="feed-filter-chip-row"
          className="-mx-1 flex items-center gap-2 overflow-x-auto px-1 md:overflow-visible"
        >
          <ChipButton
            active={filter.onlyMe}
            testId="feed-filter-me"
            onClick={() => onChange({ ...filter, onlyMe: !filter.onlyMe })}
          >
            @Me
          </ChipButton>
          <ChipButton
            active={filter.todayOnly}
            testId="feed-filter-today"
            onClick={() =>
              onChange({ ...filter, todayOnly: !filter.todayOnly })
            }
          >
            Today
          </ChipButton>
          {availableSources.map((src) => (
            <ChipButton
              key={src}
              active={filter.sources.includes(src)}
              testId={`feed-filter-source-${src}`}
              onClick={() => {
                const has = filter.sources.includes(src);
                onChange({
                  ...filter,
                  sources: has
                    ? filter.sources.filter((s) => s !== src)
                    : [...filter.sources, src],
                });
              }}
            >
              {src}
            </ChipButton>
          ))}
        </div>
      </div>
    </div>
  );
}

function ChipButton({
  active,
  testId,
  onClick,
  children,
}: {
  active: boolean;
  testId: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-active={active ? "true" : "false"}
      onClick={onClick}
      className={
        "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors " +
        (active
          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
          : "border-stone-300 bg-white text-stone-600 hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800")
      }
    >
      {children}
    </button>
  );
}
