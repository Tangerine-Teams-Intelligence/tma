// === wave 1.13-D ===
/**
 * v1.13 Wave 1.13-D — TeammateAvatar.
 *
 * Tiny avatar disc + colored route-dot. Used inline in the sidebar
 * (next to active routes) and in the top-bar "N teammates active" pill
 * popover.
 *
 * Renders:
 *   • Initial(s) of the teammate's display name. Wave 1.13-A's
 *     `team_roster` exposes `displayName` per `alias`; until that lands
 *     we synthesize a single-letter initial from the alias itself.
 *   • A small colored dot in the bottom-right corner whose color matches
 *     the route they're viewing (matches the sidebar nav's accent so the
 *     visual mapping is consistent).
 *   • Hover title for screen readers / tooltips: "Hongyu — /memory · 12s ago".
 *
 * No external avatar provider (gravatar etc.) — strict OSS, no
 * third-party fetches. The colored disc on initials is the visual identity.
 */

import { useMemo } from "react";
import type { PresenceInfo } from "@/lib/tauri";

export interface TeammateAvatarProps {
  presence: PresenceInfo;
  /** Override the display name when Wave 1.13-A's roster has it. */
  displayName?: string;
  /** Tile size in px. Defaults to 22 (sidebar inline). */
  size?: number;
  /**
   * If true, render the route-color dot in the bottom-right. Top-bar
   * pill popover passes false because the row already shows the route
   * label as text.
   */
  showRouteDot?: boolean;
  /** Optional click handler — top-bar pill rows route to /people. */
  onClick?: () => void;
}

/**
 * Map a route to a color. Picked to be visually distinct + match the
 * sidebar's existing primary-nav accents. Routes outside the primary
 * 4 fall back to a neutral stone tone.
 */
export function routeColor(route: string): string {
  if (route.startsWith("/today")) return "#CC5500"; // tangerine
  if (route.startsWith("/memory")) return "#1A1A2E"; // deep blue
  if (route.startsWith("/brain") || route.startsWith("/co-thinker"))
    return "#7C3AED"; // violet
  if (route.startsWith("/canvas")) return "#0EA5E9"; // sky
  if (route.startsWith("/people")) return "#10B981"; // emerald
  return "#78716C"; // stone-500
}

/**
 * Pick a stable background tint per user so two teammates' initials
 * never blur together. Hash the alias to one of 6 brand-friendly hues.
 */
function userTint(alias: string): string {
  // Tiny djb2-ish hash — good enough for 6-bucket selection.
  let h = 5381;
  for (let i = 0; i < alias.length; i++) {
    h = ((h << 5) + h + alias.charCodeAt(i)) | 0;
  }
  const palette = [
    "#CC5500", // tangerine
    "#1A1A2E", // deep blue
    "#7C3AED", // violet
    "#0EA5E9", // sky
    "#10B981", // emerald
    "#F59E0B", // amber
  ];
  return palette[Math.abs(h) % palette.length];
}

function relativeShort(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "now";
  const ageSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (ageSec < 5) return "now";
  if (ageSec < 60) return `${ageSec}s ago`;
  const m = Math.floor(ageSec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

export function TeammateAvatar({
  presence,
  displayName,
  size = 22,
  showRouteDot = true,
  onClick,
}: TeammateAvatarProps) {
  const label = displayName ?? presence.user;
  const initial = useMemo(() => {
    const trimmed = label.trim();
    if (!trimmed) return "?";
    return trimmed.charAt(0).toUpperCase();
  }, [label]);

  const tint = useMemo(() => userTint(presence.user), [presence.user]);
  const dot = useMemo(
    () => routeColor(presence.current_route),
    [presence.current_route],
  );
  const tooltip = `${label} — ${presence.current_route} · ${relativeShort(
    presence.last_active,
  )}`;

  const dotSize = Math.max(6, Math.round(size * 0.32));
  const fontSize = Math.max(9, Math.round(size * 0.5));

  return (
    <span
      data-testid={`teammate-avatar-${presence.user}`}
      title={tooltip}
      aria-label={tooltip}
      role={onClick ? "button" : "img"}
      onClick={onClick}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        background: tint,
        color: "#fff",
        fontSize,
        fontWeight: 600,
        lineHeight: 1,
        cursor: onClick ? "pointer" : "default",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {initial}
      {showRouteDot && (
        <span
          data-testid={`teammate-avatar-${presence.user}-dot`}
          aria-hidden
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: dotSize,
            height: dotSize,
            borderRadius: "50%",
            background: dot,
            border: "1px solid #fff",
          }}
        />
      )}
    </span>
  );
}
// === end wave 1.13-D ===
