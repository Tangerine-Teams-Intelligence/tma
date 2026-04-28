// === wave 16 ===
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Activity, Clock, X } from "lucide-react";
import {
  activityRecent,
  listenActivityAtoms,
  type ActivityAtomEvent,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { VENDOR_COLORS } from "@/lib/vendor-colors";
import { useTranslation } from "react-i18next";

/**
 * Right-rail persistent activity feed (Wave 16 wiring).
 *
 * Mounted once in <AppShell/> so it stays put across all routes. Reverse
 * chronological recent atom writes across every source. Three filter
 * tabs (`all` / `me` / `team`) persist the selection in
 * `ui.activityFeedFilter` (zustand) so the user's pick survives across
 * launches.
 *
 * Wave 16 swaps the v1.x polling-of-`readTimelineRecent` for two real-
 * time hooks against the new Rust activity bus:
 *
 *   1. On mount → `activityRecent({ limit: 50 })` hydrates the initial
 *      array from the in-memory ring buffer. Outside Tauri this returns
 *      `[]` so vitest renders the empty state cleanly.
 *
 *   2. On mount → `listenActivityAtoms((ev) => prepend(ev))` subscribes
 *      to the `activity:atom_written` Tauri event. Every successful atom
 *      write (co-thinker brain refresh, personal-agent parser) prepends
 *      to local state without polling.
 *
 * Each row carries a vendor-colour dot (from VENDOR_COLORS), a 40-char
 * truncated title, the author/vendor label, and a relative-time stamp
 * (justNow / Xm / Xh / Xd). Empty state preserves the v1.x copy
 * ("Nothing captured yet · Connect a source to start the feed.") so the
 * dogfood screenshots stay valid.
 */
export function ActivityFeed() {
  const { t } = useTranslation();
  const currentUser = useStore((s) => s.ui.currentUser);
  const dismissed = useStore((s) => s.ui.dismissedAtoms);
  const dismissAtom = useStore((s) => s.ui.dismissAtom);
  const filter = useStore((s) => s.ui.activityFeedFilter);
  const setFilter = useStore((s) => s.ui.setActivityFeedFilter);

  const [events, setEvents] = useState<ActivityAtomEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // 1. Hydrate from the ring buffer on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const initial = await activityRecent({ limit: 50 });
        if (cancelled) return;
        setEvents(initial);
      } catch {
        // Defensive: even on Tauri-side error we still render the empty
        // state. The live listener will populate as new events fire.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 2. Subscribe to live `activity:atom_written` events. Each event is
  //    prepended to the array (newest first) and capped at 50 rows.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const fn = await listenActivityAtoms((ev) => {
        if (cancelled) return;
        setEvents((prev) => {
          // Dedup on (path + timestamp) so a rapid double-emit doesn't
          // flood the rail with identical rows.
          const key = `${ev.path}@${ev.timestamp}`;
          const prevKey = prev.length
            ? `${prev[0].path}@${prev[0].timestamp}`
            : "";
          if (key === prevKey) return prev;
          const next = [ev, ...prev];
          return next.slice(0, 50);
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

  const filtered = useMemo(() => {
    const dismissedSet = new Set(dismissed);
    return events
      .filter((e) => !dismissedSet.has(activityKey(e)))
      .filter((e) => {
        if (filter === "all") return true;
        const isMe = e.author === currentUser;
        return filter === "me" ? isMe : !isMe;
      });
  }, [events, filter, dismissed, currentUser]);

  const top = filtered.slice(0, 10);

  return (
    <aside
      data-activity-feed
      data-testid="activity-feed"
      className="ti-no-select hidden h-full w-[300px] shrink-0 flex-col border-l border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950 lg:flex"
    >
      <div className="flex items-center gap-2 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <Activity size={12} className="text-[var(--ti-orange-500)]" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-stone-700 dark:text-stone-300">
          {t("today.activity")}
        </span>
        <div className="ml-auto flex gap-1">
          {(["all", "me", "team"] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              data-testid={`activity-filter-${f}`}
              className={
                "rounded px-1.5 py-0.5 font-mono text-[10px] " +
                (filter === f
                  ? "bg-[var(--ti-orange-500)] text-white"
                  : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-900")
              }
              aria-pressed={filter === f}
              aria-label={t(`activity.filter${capitalize(f)}` as const) ?? f}
            >
              {t(`activity.filter${capitalize(f)}` as const)}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && top.length === 0 ? (
          <p className="px-2 py-4 text-center text-[11px] text-stone-400 dark:text-stone-500">
            {t("common.loading")}
          </p>
        ) : top.length === 0 ? (
          <div className="px-3 py-6 text-center" data-testid="activity-empty">
            <Clock size={14} className="mx-auto text-stone-300 dark:text-stone-700" />
            <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
              {t("activity.emptyTitle")}
            </p>
            <p className="mt-1 text-[10px] text-stone-400 dark:text-stone-500">
              {t("activity.emptyBody")}
            </p>
          </div>
        ) : (
          top.map((e) => (
            <ActivityRow
              key={activityKey(e)}
              event={e}
              onDismiss={() => dismissAtom(activityKey(e))}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function ActivityRow({
  event,
  onDismiss,
}: {
  event: ActivityAtomEvent;
  onDismiss: () => void;
}) {
  const dotColor = vendorDot(event.vendor);
  const path = `/memory/${encodeURI(event.path)}`;
  const title = truncate(event.title || event.path, 40);
  const labelBits: string[] = [];
  if (event.author) labelBits.push(`@${event.author}`);
  if (event.vendor) labelBits.push(event.vendor);
  if (labelBits.length === 0) labelBits.push(event.kind.replace("_", " "));
  return (
    <div
      className="group relative flex items-start gap-2 rounded px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-900"
      data-testid="activity-row"
      data-activity-vendor={event.vendor ?? ""}
    >
      <span
        aria-hidden
        className="mt-1.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: dotColor }}
      />
      <Link to={path} className="block min-w-0 flex-1">
        <p className="truncate text-[11px] text-stone-700 dark:text-stone-300">
          {title}
        </p>
        <p className="font-mono text-[9px] text-stone-400 dark:text-stone-500">
          {labelBits.join(" · ")} · {formatRelative(event.timestamp)}
        </p>
      </Link>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onDismiss();
        }}
        className="opacity-0 transition-opacity group-hover:opacity-100"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X
          size={11}
          className="text-stone-400 hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-200"
        />
      </button>
    </div>
  );
}

function activityKey(e: ActivityAtomEvent): string {
  return `${e.path}@${e.timestamp}`;
}

function vendorDot(vendor: string | null): string {
  if (!vendor) return "var(--ti-orange-500)";
  // VENDOR_COLORS keys are lowercase canonical labels with dashes.
  const key = vendor.toLowerCase().replace("_", "-");
  const c = (VENDOR_COLORS as Record<string, { hex?: string }>)[key];
  if (c && typeof c.hex === "string" && c.hex.length > 0) return c.hex;
  return "var(--ti-orange-500)";
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

/** Best-effort relative-time formatter. Locale-agnostic for now —
 *  the i18n layer ships the labels (justNow / secondsAgo / minutesAgo);
 *  hours / days fall back to "Xh" / "Xd". */
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

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
// === end wave 16 ===
