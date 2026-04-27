/**
 * v1.9.0-beta.1 — Banner host.
 *
 * Reads `bannerStack` from the store and renders the highest-priority
 * entry (max 1 visible per route). The rest stay queued until the
 * top entry is dismissed; on dismiss the next-highest takes its place
 * automatically because the host re-reads the slice on every render.
 *
 * Mounted from `AppShell.tsx` between the WhatsNewBanner / localOnly
 * strip and the route Outlet so the banner sits at the top of the
 * route content but below the global system strips.
 */

import { useMemo } from "react";

import { useStore } from "@/lib/store";
import { Banner, type BannerProps } from "./Banner";

export function BannerHost() {
  const stack = useStore((s) => s.ui.bannerStack);
  const dismissBanner = useStore((s) => s.ui.dismissBanner);

  // Pick the highest-priority entry. Tie-break by recency (last-pushed
  // wins) because new high-signal banners should usurp older ones with
  // the same priority. `priority` defaults to 5 if unset.
  const top = useMemo<BannerProps | null>(() => {
    if (stack.length === 0) return null;
    let best: BannerProps | null = null;
    let bestPriority = -Infinity;
    for (let i = 0; i < stack.length; i++) {
      const b = stack[i];
      const p = b.priority ?? 5;
      if (p >= bestPriority) {
        // ≥ to favour later entries on ties.
        bestPriority = p;
        best = b;
      }
    }
    return best;
  }, [stack]);

  if (!top) return null;

  return (
    <Banner
      {...top}
      onDismiss={() => {
        // Run the user-supplied onDismiss first (telemetry / analytics)
        // before popping from the queue.
        try {
          top.onDismiss?.();
        } finally {
          dismissBanner(top.id);
        }
      }}
      onAccept={
        top.onAccept || top.ctaHref
          ? () => {
              try {
                if (top.onAccept) {
                  top.onAccept();
                } else if (top.ctaHref && typeof window !== "undefined") {
                  window.location.href = top.ctaHref;
                }
              } finally {
                // Accept also clears the banner — treat the CTA as a
                // resolution of the underlying condition.
                dismissBanner(top.id);
              }
            }
          : undefined
      }
    />
  );
}
