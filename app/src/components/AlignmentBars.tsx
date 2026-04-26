import type { AlignmentSnapshot } from "@/lib/views";

/**
 * Per-member coverage bars used by /alignment.
 *
 * Drives off `alignment.json::latest.per_user_seen + total_atoms` from the
 * Python `compute_alignment` snapshot. Each bar = (atoms this user has
 * viewed) / (total non-sample atoms).
 *
 * Returns an empty hint when no users are tracked yet; the parent route
 * renders a connect-source CTA above this when total_atoms === 0.
 */
export function AlignmentBars({ snapshot }: { snapshot: AlignmentSnapshot }) {
  const total = snapshot.total_atoms;
  if (snapshot.users.length === 0 || total === 0) {
    return (
      <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
        No member coverage yet.
      </p>
    );
  }
  const rows = snapshot.users
    .map((user) => {
      const seen = snapshot.per_user_seen[user] ?? 0;
      const pct = total > 0 ? Math.round((seen / total) * 100) : 0;
      return { user, seen, pct };
    })
    .sort((a, b) => b.pct - a.pct);
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <div key={r.user} data-alignment-bar>
          <div className="flex items-center justify-between text-xs">
            <span className="font-mono text-stone-700 dark:text-stone-300">
              @{r.user}
            </span>
            <span className="font-mono text-stone-500 dark:text-stone-400">
              {r.seen} / {total} ({r.pct}%)
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
            <div
              className="h-1.5 rounded bg-[var(--ti-orange-500)]"
              style={{ width: `${r.pct}%` }}
              aria-label={`${r.user} coverage ${r.pct}%`}
              role="progressbar"
              aria-valuenow={r.pct}
              aria-valuemin={0}
              aria-valuemax={100}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
