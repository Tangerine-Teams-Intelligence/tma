import { useEffect, useState } from "react";
import { Cloud, CloudOff, RefreshCw, AlertCircle } from "lucide-react";
import { syncStatus, type SyncStatusOut } from "@/lib/git";

/**
 * Tiny "Synced 2 min ago" indicator that lives in the sidebar footer.
 * Polls `sync_status` every 5 seconds. Three visible states:
 *
 *   • Solo / no team repo → CloudOff icon, "Solo".
 *   • Healthy → Cloud icon, "Synced 2 min ago" / "just now".
 *   • Error → AlertCircle icon, "Conflict / paused" — clicking it should
 *     eventually open the resolve UI (v1.6.1; for v1.6.0 we just show the
 *     toast on hover).
 */
export function SyncStatusIndicator({ collapsed = false }: { collapsed?: boolean }) {
  const [status, setStatus] = useState<SyncStatusOut | null>(null);
  const [pulsing, setPulsing] = useState(false);

  useEffect(() => {
    let cancel = false;
    const tick = () => {
      void syncStatus().then((s) => {
        if (cancel) return;
        setStatus(s);
      });
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancel = true;
      clearInterval(id);
    };
  }, []);

  // Visual pulse when pending_changes goes positive — gives the user a
  // "I see you" moment without us having to actually sync immediately.
  useEffect(() => {
    if (!status) return;
    if (status.pending_changes > 0) {
      setPulsing(true);
      const t = setTimeout(() => setPulsing(false), 600);
      return () => clearTimeout(t);
    }
  }, [status?.pending_changes, status]);

  if (!status || !status.running) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-[11px] text-stone-500 dark:text-stone-400"
        title="Solo mode — memory stays on this machine. Switch to team mode in Settings."
      >
        <CloudOff size={12} className="shrink-0" />
        {!collapsed && <span>Solo</span>}
      </div>
    );
  }

  if (status.last_error) {
    return (
      <div
        className="flex items-center gap-2 px-2 py-1 text-[11px] text-rose-600 dark:text-rose-400"
        title={`Sync paused — ${status.last_error}`}
      >
        <AlertCircle size={12} className="shrink-0" />
        {!collapsed && <span className="truncate">Sync paused</span>}
      </div>
    );
  }

  const label = status.pending_changes > 0
    ? `Syncing ${status.pending_changes}…`
    : status.last_push
      ? `Synced ${formatRelative(status.last_push)}`
      : status.last_pull
        ? `Pulled ${formatRelative(status.last_pull)}`
        : "Connecting…";

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 text-[11px] text-stone-600 dark:text-stone-400"
      title={`Repo: ${status.repo_path ?? "(unknown)"} as ${status.login ?? "?"}`}
    >
      {status.pending_changes > 0 ? (
        <RefreshCw size={12} className={`shrink-0 ${pulsing ? "animate-spin" : ""}`} />
      ) : (
        <Cloud size={12} className="shrink-0" />
      )}
      {!collapsed && <span className="truncate">{label}</span>}
    </div>
  );
}

/** "just now" / "2 min ago" / "1 hr ago" etc. Tiny, no deps. */
export function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 30) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / (60 * 60 * 24))} d ago`;
}
