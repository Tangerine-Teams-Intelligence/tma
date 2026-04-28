// === wave 20 ===
/**
 * Wave 20 — recent decisions widget for /today.
 *
 * Reads the last N atoms with `kind === "decision"` from the activity ring
 * buffer (Wave 16). The activity bus already carries `kind` per atom and
 * is the cheapest way to get a "recent decisions" cross-vendor view —
 * `searchAtoms` doesn't return `kind` (only score + snippet), and we don't
 * want to issue a fuzzy search for the empty string.
 *
 * Each row collapses to title + author + date with a left vendor dot.
 * Click → navigates to the memory file detail (same convention as
 * ActivityFeed rows).
 *
 * Defensive: any fetch error renders inline via `DashboardWidget`'s
 * `errorMessage` prop. Empty state shows a quiet "No decisions yet"
 * caption — this is normal on a fresh install.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { activityRecent, type ActivityAtomEvent } from "@/lib/tauri";
import { VENDOR_COLORS } from "@/lib/vendor-colors";
import { DashboardWidget } from "./DashboardWidget";

const MAX_ROWS = 3;

export function RecentDecisionsWidget() {
  const [decisions, setDecisions] = useState<ActivityAtomEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        // Pull a wide enough slice that we usually find 3 decisions even
        // when the recent buffer is mostly threads/observations.
        const all = await activityRecent({ limit: 50 });
        if (cancelled) return;
        const filtered = all
          .filter((e) => e.kind === "decision")
          .slice(0, MAX_ROWS);
        setDecisions(filtered);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <DashboardWidget
      testId="dashboard-recent-decisions"
      /* === wave 20 wrap-needed === */
      title="Recent decisions"
      count={decisions.length}
      action={{
        /* === wave 20 wrap-needed === */
        label: "More",
        // No top-level /decisions index yet (only /decisions/lineage as
        // a v2 graph). Send the user to /this-week which lists every
        // recent atom including decisions.
        to: "/this-week",
      }}
      loading={loading}
      errorMessage={error}
    >
      {decisions.length === 0 ? (
        <p
          data-testid="dashboard-recent-decisions-empty"
          className="px-1 py-2 text-[12px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          No decisions captured yet today.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {decisions.map((d) => (
            <li key={`${d.path}@${d.timestamp}`}>
              <DecisionRow event={d} />
            </li>
          ))}
        </ul>
      )}
    </DashboardWidget>
  );
}

function DecisionRow({ event }: { event: ActivityAtomEvent }) {
  const dot = vendorDot(event.vendor);
  const path = `/memory/${encodeURI(event.path)}`;
  const title = event.title || event.path;
  return (
    <Link
      to={path}
      data-testid="dashboard-decision-row"
      className="group flex items-center gap-3 py-2 hover:bg-stone-100/80 dark:hover:bg-stone-900/60"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dot }}
      />
      <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--ti-ink-900)]">
        {title}
      </p>
      <p className="font-mono text-[10px] text-[var(--ti-ink-500)]">
        {event.author ? `@${event.author}` : event.vendor ?? ""} ·{" "}
        {formatShortDate(event.timestamp)}
      </p>
    </Link>
  );
}

function vendorDot(vendor: string | null): string {
  if (!vendor) return "var(--ti-orange-500)";
  const key = vendor.toLowerCase().replace("_", "-");
  const c = (VENDOR_COLORS as Record<string, { hex?: string }>)[key];
  if (c && typeof c.hex === "string" && c.hex.length > 0) return c.hex;
  return "var(--ti-orange-500)";
}

/** "Apr 22" — short month/day, locale-agnostic. */
function formatShortDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const d = new Date(t);
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}
// === end wave 20 ===
