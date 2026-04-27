/**
 * v2.5 §1.4 — /reviews — Decision review queue.
 *
 * Co-thinker proposed N decision atoms. Teammates vote here. 2/3 quorum
 * auto-promotes (status flips to `locked`). Below quorum, the atom waits
 * in this list until enough votes land or 14 days lapse (→ stale).
 *
 * Layout:
 *   • Filter chips (open / mine / all)
 *   • One ReviewPanel per matching review
 *
 * Spec: V2_5_SPEC §1.
 */

import { useEffect, useMemo, useState } from "react";
import { GitPullRequest, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { reviewListOpen, type ReviewState } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

type Filter = "open" | "mine" | "all";

export default function ReviewsRoute() {
  const currentUser = useStore((s) => s.ui.currentUser);
  const [filter, setFilter] = useState<Filter>("open");
  const [reviews, setReviews] = useState<ReviewState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    void reviewListOpen()
      .then((rs) => {
        if (cancel) return;
        setReviews(rs);
        setLoading(false);
      })
      .catch(() => {
        if (cancel) return;
        setReviews([]);
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  const filtered = useMemo(() => {
    if (filter === "open") return reviews.filter((r) => r.status === "open");
    if (filter === "mine")
      return reviews.filter(
        (r) => r.status === "open" && !r.votes.some((v) => v.user === currentUser),
      );
    return reviews;
  }, [reviews, filter, currentUser]);

  function handleChanged(next: ReviewState) {
    setReviews((prev) => {
      const idx = prev.findIndex((r) => r.atom_path === next.atom_path);
      if (idx < 0) return [...prev, next];
      const copy = prev.slice();
      copy[idx] = next;
      return copy;
    });
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-medium text-stone-900 dark:text-stone-100">
            <GitPullRequest size={18} />
            Reviews
          </h1>
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            Co-thinker proposals waiting on team vote. 2/3 approval auto-promotes.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCw size={12} className="mr-1" />
          Refresh
        </Button>
      </header>

      <div className="flex items-center gap-1">
        <FilterChip
          active={filter === "open"}
          onClick={() => setFilter("open")}
          count={reviews.filter((r) => r.status === "open").length}
        >
          Open
        </FilterChip>
        <FilterChip
          active={filter === "mine"}
          onClick={() => setFilter("mine")}
          count={
            reviews.filter(
              (r) =>
                r.status === "open" &&
                !r.votes.some((v) => v.user === currentUser),
            ).length
          }
        >
          Awaiting my vote
        </FilterChip>
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          count={reviews.length}
        >
          All
        </FilterChip>
      </div>

      {loading ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState filter={filter} />
      ) : (
        <ul className="space-y-3">
          {filtered.map((r) => (
            <li key={r.atom_path}>
              <ReviewPanel review={r} onChanged={handleChanged} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition",
        active
          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800",
      )}
    >
      <span>{children}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] font-mono",
          active
            ? "bg-[var(--ti-orange-200)] text-[var(--ti-orange-800)] dark:bg-stone-900 dark:text-[var(--ti-orange-500)]"
            : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function EmptyState({ filter }: { filter: Filter }) {
  const msg =
    filter === "mine"
      ? "Nothing waiting on your vote."
      : filter === "open"
        ? "No open reviews. The co-thinker will propose decisions on the next heartbeat."
        : "No reviews yet.";
  return (
    <div className="rounded border border-dashed border-stone-300 p-8 text-center dark:border-stone-700">
      <p className="text-sm text-stone-500 dark:text-stone-400">{msg}</p>
    </div>
  );
}
