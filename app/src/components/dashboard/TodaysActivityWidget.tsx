// === wave 20 ===
/**
 * Wave 20 — today's activity widget for /today.
 *
 * Reads up to 10 atoms from the activity ring buffer and subscribes to
 * `activity:atom_written` so the list updates real-time as the daemon
 * writes new files. This is the dashboard mirror of the right-rail
 * `<ActivityFeed />` (Wave 16) — same data source, different surface.
 *
 * Each row: vendor color dot · 40-char truncated title · "Xm ago".
 * Click → navigates to the memory file detail.
 *
 * Defensive: any fetch error renders inline. The live listener is
 * mounted independently so a failed initial hydrate still surfaces
 * incoming events.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  activityRecent,
  listenActivityAtoms,
  type ActivityAtomEvent,
} from "@/lib/tauri";
import { VENDOR_COLORS } from "@/lib/vendor-colors";
import { DashboardWidget } from "./DashboardWidget";

const MAX_ROWS = 10;

export function TodaysActivityWidget() {
  const [events, setEvents] = useState<ActivityAtomEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Initial hydrate from the ring buffer.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await activityRecent({ limit: MAX_ROWS });
        if (cancelled) return;
        setEvents(initial);
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

  // Live updates — prepend each new atom written event.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const fn = await listenActivityAtoms((ev) => {
        if (cancelled) return;
        setEvents((prev) => {
          const key = `${ev.path}@${ev.timestamp}`;
          const prevKey = prev.length
            ? `${prev[0].path}@${prev[0].timestamp}`
            : "";
          if (key === prevKey) return prev;
          return [ev, ...prev].slice(0, MAX_ROWS);
        });
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  // === v1.13.2 round-2 ===
  // Round 2 hypothesis #9: should this widget also surface presence pings
  // ("Hongyu just opened /memory")? Decision: NOT in this round. Reasons:
  //   1. Presence and atom events live in different streams (presence:update
  //      vs activity:atom_written). Interleaving by timestamp needs a unified
  //      event model + kind-aware row renderer that doesn't exist yet.
  //   2. Presence is high-frequency (10s heartbeats) — without dedup +
  //      coalescing the widget would thrash the activity ring buffer view.
  //   3. PresenceProvider already drives SidebarPresenceDots inline with
  //      each route in the rail — that surfaces "who's where" at a glance
  //      without competing with atom captures here.
  // Defer to v1.13.3+: introduce an ActivityEvent union type with kind=
  // "atom_write" | "presence_change" and route through a single feed.
  // === end v1.13.2 round-2 ===
  return (
    <DashboardWidget
      testId="dashboard-todays-activity"
      /* === wave 20 wrap-needed === */
      title="Today's activity"
      count={events.length}
      action={{
        /* === wave 20 wrap-needed === */
        label: "More",
        to: "/this-week",
      }}
      loading={loading}
      errorMessage={error}
    >
      {events.length === 0 ? (
        <p
          data-testid="dashboard-todays-activity-empty"
          className="px-1 py-2 text-[12px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          No activity yet — connect a tool and your team's captures appear
          here.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {events.map((e) => (
            <li key={`${e.path}@${e.timestamp}`}>
              <ActivityRow event={e} />
            </li>
          ))}
        </ul>
      )}
    </DashboardWidget>
  );
}

function ActivityRow({ event }: { event: ActivityAtomEvent }) {
  const dot = vendorDot(event.vendor);
  const path = `/memory/${encodeURI(event.path)}`;
  const title = truncate(event.title || event.path, 40);
  return (
    <Link
      to={path}
      data-testid="dashboard-activity-row"
      className="group flex items-center gap-3 py-2 hover:bg-stone-100/80 dark:hover:bg-stone-900/60"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dot }}
      />
      <p className="min-w-0 flex-1 truncate text-[12px] text-[var(--ti-ink-900)]">
        {title}
      </p>
      <p className="font-mono text-[10px] text-[var(--ti-ink-500)]">
        {formatRelative(event.timestamp)}
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

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/** Same shape as ActivityFeed.formatRelative — keep them in sync. */
function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const now = Date.now();
  const dSec = Math.max(0, Math.floor((now - t) / 1000));
  if (dSec < 5) return "just now";
  if (dSec < 60) return `${dSec}s ago`;
  const dMin = Math.floor(dSec / 60);
  if (dMin < 60) return `${dMin}m ago`;
  const dHr = Math.floor(dMin / 60);
  if (dHr < 24) return `${dHr}h ago`;
  const dDay = Math.floor(dHr / 24);
  return `${dDay}d ago`;
}
// === end wave 20 ===
