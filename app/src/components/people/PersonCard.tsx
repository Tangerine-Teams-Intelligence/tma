/**
 * v1.16 Wave 2 Agent B3 — large person card for /people grid.
 *
 * Spec: 64px avatar, alias name, bold "N today" count of last-24h
 * atoms, top 3 hashtag chips, "Nh ago" / "yesterday" relative time of
 * latest atom. Click → parent filters AtomCard list to this person.
 *
 * Selected card gets ring-2 ring-orange outline. Default selection in
 * the route is `currentUser` so a solo user lands on themselves.
 *
 * R6/R7/R8 honesty: this card never invents activity counts — the
 * route hands us the already-aggregated PersonStats. If a teammate has
 * 0 atoms in the last 24h, the count says "0 today" rather than being
 * hidden, so the user knows we did look.
 */
import { Avatar } from "@/components/feed/Avatar";

export interface PersonStats {
  /** alias is the unique key — e.g. "daizhe", "hongyu". */
  alias: string;
  /** Atoms authored in the last 24h. Always rendered, even when 0. */
  countToday: number;
  /** Top 3 hashtags by frequency across this person's atoms. */
  hashtags: string[];
  /** Relative time of their most recent atom — drives "Nh ago" status. */
  latestTs: string | null;
}

interface PersonCardProps {
  person: PersonStats;
  selected: boolean;
  onSelect: (alias: string) => void;
}

/** "2h ago" / "yesterday" / "3d ago" — short status line for the card. */
export function formatStatus(iso: string | null): string {
  if (!iso) return "no activity";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const ms = Date.now() - t;
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "yesterday";
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function PersonCard({ person, selected, onSelect }: PersonCardProps) {
  const status = formatStatus(person.latestTs);
  const ringClass = selected
    ? "ring-2 ring-[var(--ti-orange-500)] ring-offset-2 ring-offset-stone-50"
    : "ring-1 ring-transparent";
  return (
    <button
      type="button"
      data-testid={`person-card-${person.alias}`}
      data-selected={selected ? "true" : "false"}
      onClick={() => onSelect(person.alias)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(person.alias);
        }
      }}
      className={
        "group flex flex-col items-start gap-3 rounded-md border border-stone-200 bg-white p-4 text-left transition-shadow hover:shadow-sm dark:border-stone-800 dark:bg-stone-900 " +
        ringClass
      }
    >
      <div className="flex items-center gap-3">
        <Avatar alias={person.alias} size={64} />
        <div className="min-w-0">
          <div
            className="font-semibold text-stone-900 dark:text-stone-100"
            data-testid={`person-card-name-${person.alias}`}
          >
            {person.alias}
          </div>
          <div
            className="mt-0.5 font-mono text-[11px] text-stone-500 dark:text-stone-400"
            data-testid={`person-card-status-${person.alias}`}
          >
            {status}
          </div>
        </div>
      </div>
      <div
        className="text-[15px] font-bold text-stone-900 dark:text-stone-100"
        data-testid={`person-card-count-${person.alias}`}
      >
        {person.countToday} today
      </div>
      {person.hashtags.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          data-testid={`person-card-tags-${person.alias}`}
        >
          {person.hashtags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
            >
              #{tag}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}
