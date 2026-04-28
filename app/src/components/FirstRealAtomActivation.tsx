// === v1.15.0 Wave 1.4 ===
/**
 * v1.15.0 Wave 1.4 — first-real-atom activation listener.
 *
 * Mounted once at the AppShell root. Subscribes to the wave-16
 * `activity:atom_written` Tauri event and, the FIRST time an event lands
 * with `isSample === false`, fires the `first_real_atom_captured`
 * telemetry event AND latches `firstAtomCapturedAt` in the store so
 * subsequent matches no-op.
 *
 * Why a dedicated component, not the activity feed listener:
 *   - Activity feed is a right-rail surface; `first_real_atom_captured`
 *     is a global activation funnel marker that must fire even when the
 *     feed isn't mounted (collapsed sidebar, route without the panel).
 *   - Keeping the activation logic in its own component lets the test
 *     drive the listener without rendering ActivityFeed's full tree.
 *
 * R9 invariant: sample atoms (Wave 13 demo seeds carrying `sample: true`
 * in YAML frontmatter) MUST NOT count. The Rust side propagates the
 * frontmatter flag onto `ActivityAtomEvent.is_sample` (camelCase
 * `isSample` on the wire, see `tauri.ts::ActivityAtomEvent`); we filter
 * on it here.
 *
 * Defensive:
 *   - Listener registration is async; we cancel on unmount via the
 *     unlisten fn so a fast unmount/remount cycle doesn't leak handlers.
 *   - Once `firstAtomCapturedAt` is non-null, we don't even bother
 *     subscribing — the listener returns early so a returning user
 *     past activation pays zero IPC cost.
 *   - The callback wraps `setFirstAtomCapturedAt` + `logEvent` in a
 *     try/catch so a thrown side-effect can never break the listener.
 */

import { useEffect } from "react";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { listenActivityAtoms, type ActivityAtomEvent } from "@/lib/tauri";

/**
 * Pure predicate — extracted so vitest can drive the sample-filter
 * branches without mocking the whole listener wire-up. Returns true
 * when the event represents a real (non-sample) atom write that
 * should trip the activation latch.
 */
export function isFirstRealAtomTrigger(args: {
  event: ActivityAtomEvent;
  alreadyCaptured: boolean;
}): boolean {
  const { event, alreadyCaptured } = args;
  if (alreadyCaptured) return false;
  // R9 invariant: sample seeds never count.
  if (event.isSample) return false;
  return true;
}

/**
 * Resolve a stable telemetry source label from the event. Prefers the
 * vendor (cursor / claude-code / …); falls back to the kind so a brain
 * refresh / decision write still surfaces a useful label.
 */
export function resolveActivationSource(event: ActivityAtomEvent): string {
  if (event.vendor && event.vendor.length > 0) return event.vendor;
  return event.kind;
}

/**
 * Headless listener — renders null. Mount once at the AppShell root.
 */
export function FirstRealAtomActivation() {
  const firstAtomCapturedAt = useStore((s) => s.ui.firstAtomCapturedAt);
  const setFirstAtomCapturedAt = useStore(
    (s) => s.ui.setFirstAtomCapturedAt,
  );

  useEffect(() => {
    // Already-activated returning users: skip subscribing entirely.
    if (firstAtomCapturedAt !== null) {
      return;
    }
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      const off = await listenActivityAtoms((ev) => {
        try {
          // Re-check the store at fire time so a parallel listener
          // (e.g. ActivityFeed) that already latched doesn't double-
          // fire. Pull from `useStore.getState()` because the closure
          // captured the initial value.
          const cur = useStore.getState().ui.firstAtomCapturedAt;
          if (
            !isFirstRealAtomTrigger({
              event: ev,
              alreadyCaptured: cur !== null,
            })
          ) {
            return;
          }
          setFirstAtomCapturedAt(Date.now());
          void logEvent("first_real_atom_captured", {
            source: resolveActivationSource(ev),
          });
        } catch {
          // Defensive: a thrown side-effect must NOT take down the
          // listener. Wave 16 listener uses the same swallow pattern.
        }
      });
      if (cancelled) {
        // Unmounted before the await resolved — clean up the listener
        // we just registered.
        try {
          off();
        } catch {
          // ignore
        }
        return;
      }
      unlisten = off;
    })();
    return () => {
      cancelled = true;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // ignore
        }
      }
    };
  }, [firstAtomCapturedAt, setFirstAtomCapturedAt]);

  return null;
}
// === end v1.15.0 Wave 1.4 ===
