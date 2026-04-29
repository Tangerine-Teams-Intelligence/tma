/**
 * v1.16 Wave 2 — sticky day group header for the Story Feed. Shown
 * above each day chunk: "Today" / "Yesterday" / "Mon Apr 28" / "Apr 24"
 * / ISO date depending on age.
 */

interface DaySeparatorProps {
  /** ISO date YYYY-MM-DD. */
  date: string;
}

export function DaySeparator({ date }: DaySeparatorProps) {
  const label = humanizeDate(date);
  return (
    <div
      data-testid={`day-separator-${date}`}
      className="sticky top-0 z-10 -mx-3 mb-2 mt-4 px-3 py-1.5 backdrop-blur first:mt-0"
      style={{
        backgroundColor: "rgba(255,255,255,0.85)",
      }}
    >
      <span className="font-mono text-[11px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {label}
      </span>
    </div>
  );
}

function humanizeDate(date: string): string {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return date || "—";
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  if (date === todayStr) return "Today";
  const yesterday = new Date(today.getTime() - 86_400_000);
  const yStr = yesterday.toISOString().slice(0, 10);
  if (date === yStr) return "Yesterday";
  const d = new Date(date + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return date;
  const ageDays = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (ageDays < 7) {
    return d.toLocaleDateString("en-US", {
      weekday: "short",
      month: "short",
      day: "numeric",
    });
  }
  if (ageDays < 365) {
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  }
  return date;
}
