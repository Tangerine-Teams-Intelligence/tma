// === wave 1.13-D ===
/**
 * v1.13 Wave 1.13-D — SidebarPresenceDots.
 *
 * Render up to 3 stacked teammate avatars next to a sidebar nav item
 * for each route a teammate is currently viewing. The Sidebar mounts
 * one of these per primary nav item; we filter the live presence list
 * down to the matching route.
 *
 * Examples:
 *   <SidebarPresenceDots route="/memory" />
 *     → renders Hongyu's avatar inline with the "Memory" rail item
 *       when Hongyu is on /memory right now.
 *
 * Returns null when no teammates match — the sidebar item should look
 * unchanged in the solo case.
 */

import { useMemo } from "react";
import { usePresence } from "./PresenceProvider";
import { TeammateAvatar } from "./TeammateAvatar";

interface Props {
  /** Route prefix to match. /brain matches /co-thinker too via fallback. */
  route: string;
  /** Max avatars to stack inline. Default 3; surplus renders as "+N". */
  max?: number;
}

export function SidebarPresenceDots({ route, max = 3 }: Props) {
  const { teammatesActive } = usePresence();

  const matching = useMemo(() => {
    return teammatesActive.filter((p) => {
      // /brain alias also matches /co-thinker (Wave 19 IA).
      if (route === "/brain") {
        return (
          p.current_route.startsWith("/brain") ||
          p.current_route.startsWith("/co-thinker")
        );
      }
      return p.current_route.startsWith(route);
    });
  }, [teammatesActive, route]);

  if (matching.length === 0) return null;

  const visible = matching.slice(0, max);
  const overflow = matching.length - visible.length;

  return (
    <span
      data-testid={`sidebar-presence-${route}`}
      className="ml-auto inline-flex shrink-0 items-center"
      style={{ marginLeft: "auto" }}
    >
      {visible.map((p, idx) => (
        <span
          key={p.user}
          style={{
            marginLeft: idx === 0 ? 0 : -6,
            zIndex: visible.length - idx,
          }}
        >
          <TeammateAvatar
            presence={p}
            size={16}
            showRouteDot={false}
          />
        </span>
      ))}
      {overflow > 0 && (
        <span
          className="ml-1 text-[9px] text-stone-500 dark:text-stone-400"
          aria-label={`${overflow} more`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}
// === end wave 1.13-D ===
