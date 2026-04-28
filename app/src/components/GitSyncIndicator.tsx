// === wave 10-B ===
// Tiny status dot for the sidebar footer. Polled by the parent (or by
// 10-A's wiring) — this component is pure-presentational and never calls
// Tauri itself. All state arrives via the `status` prop, all strings via
// the `labels` prop. That keeps the test surface tiny (mock the prop, no
// IPC harness) and lets 10-A swap in real i18n without touching this file.
//
// Five visual states:
//   - not_initialized → grey GitBranch icon, no animation
//   - clean           → green dot with a 12px Check
//   - pushing         → orange dot, ArrowUp spinning
//   - pulling         → blue dot, ArrowDown spinning
//   - conflict        → red dot, AlertCircle
//
// Sizing target is ~16-20px wide so it sits next to the existing Solo /
// Settings / Theme / Sign-out icons without disrupting alignment. We pick
// 16px for the outer dot to match the other footer glyphs.

import { GitBranch, Check, ArrowUp, ArrowDown, AlertCircle } from "lucide-react";

export interface GitSyncStatus {
  state: "not_initialized" | "clean" | "pushing" | "pulling" | "conflict";
  /** Local commits ahead of remote (used by `pushing` tooltip). */
  ahead?: number;
  /** Remote commits behind not yet pulled. */
  behind?: number;
  /** ISO timestamp of last successful pull (used by `clean` tooltip). */
  last_pull_iso?: string;
  /** ISO timestamp of last successful push. */
  last_push_iso?: string;
  /** Currently checked-out branch (informational; not rendered yet). */
  current_branch?: string;
  /** File paths with merge conflicts (rendered by parent popover, not here). */
  conflict_files?: string[];
}

export interface GitSyncIndicatorLabels {
  notInitialized: string;
  cleanInSync: string;
  pushingAhead: (n: number) => string;
  pullConflict: string;
  pulling: string;
  /** Caller appends the relative time, e.g. "Last pull: 2m ago". */
  lastPullPrefix: string;
}

export interface GitSyncIndicatorProps {
  status: GitSyncStatus;
  onClick?: () => void;
  labels: GitSyncIndicatorLabels;
}

/**
 * Compose the tooltip for the current state. Kept inline so each state's
 * copy lives next to its visual treatment — easier to audit than a switch
 * in another file.
 */
function tooltipFor(status: GitSyncStatus, labels: GitSyncIndicatorLabels): string {
  switch (status.state) {
    case "not_initialized":
      return labels.notInitialized;
    case "clean": {
      const tail = status.last_pull_iso
        ? ` ${labels.lastPullPrefix}${formatRelative(status.last_pull_iso)}`
        : "";
      return `${labels.cleanInSync}${tail}`;
    }
    case "pushing":
      return labels.pushingAhead(status.ahead ?? 0);
    case "pulling":
      return labels.pulling;
    case "conflict":
      return labels.pullConflict;
  }
}

/**
 * "just now" / "2m ago" / "3h ago" / "4d ago". Same scheme as the
 * existing SyncStatusIndicator's formatRelative but exported separately
 * so 10-A doesn't have to import from a sibling file. Kept simple — the
 * sub-minute resolution buys nothing here because git-sync polls at 5s.
 */
export function formatRelative(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 30) return "just now";
  if (seconds < 60) return "1m ago";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / (60 * 60 * 24))}d ago`;
}

export function GitSyncIndicator({ status, onClick, labels }: GitSyncIndicatorProps) {
  const tooltip = tooltipFor(status, labels);

  // The visual recipe per state. We keep dot size fixed at 16px so it
  // lines up with the other footer icons; the icon inside is 12px (matches
  // SyncStatusIndicator's icon size).
  const recipe = (() => {
    switch (status.state) {
      case "not_initialized":
        return {
          dotClass:
            "text-[var(--ti-ink-400)] dark:text-[var(--ti-ink-500)] opacity-60",
          icon: <GitBranch size={12} aria-hidden />,
          dataState: "not_initialized",
        };
      case "clean":
        return {
          dotClass:
            "bg-[var(--ti-green-500)] text-white rounded-full flex items-center justify-center",
          icon: <Check size={10} strokeWidth={3} aria-hidden />,
          dataState: "clean",
        };
      case "pushing":
        return {
          dotClass: "text-[var(--ti-orange-500)]",
          icon: <ArrowUp size={12} className="animate-spin" aria-hidden />,
          dataState: "pushing",
        };
      case "pulling":
        return {
          dotClass: "text-[var(--ti-blue-500)]",
          icon: <ArrowDown size={12} className="animate-spin" aria-hidden />,
          dataState: "pulling",
        };
      case "conflict":
        return {
          dotClass: "text-[var(--ti-danger)]",
          icon: <AlertCircle size={12} aria-hidden />,
          dataState: "conflict",
        };
    }
  })();

  // role=button + tabIndex=0 so the indicator is keyboard-reachable and
  // screen-readers announce it as interactive (matches the existing
  // sidebar-footer affordances). title= drives the native browser tooltip
  // both for hover and for keyboard focus on most platforms.
  return (
    <button
      type="button"
      onClick={onClick}
      title={tooltip}
      aria-label={tooltip}
      data-testid="git-sync-indicator"
      data-state={recipe.dataState}
      className={
        "ti-no-select inline-flex h-4 w-4 items-center justify-center rounded-sm hover:bg-[var(--ti-paper-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 " +
        recipe.dotClass
      }
    >
      {recipe.icon}
    </button>
  );
}

export default GitSyncIndicator;
