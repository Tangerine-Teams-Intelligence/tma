// === wave 1.13-D ===
/**
 * v1.13 Wave 1.13-D — Real-time team presence provider.
 *
 * Mounts at AppShell level so every route sees the same teammate list.
 * Two responsibilities:
 *
 *   1. Emitter — every 10 s while the user is active (and once on every
 *      route change), call `presenceEmit` with the current pathname +
 *      optional active atom. The Rust side writes
 *      `<memory_root>/.tangerine/presence/{user}.json`; the existing
 *      v1.10 `git_sync` ticker pushes that file to teammates.
 *
 *   2. Reader — every 10 s, call `presenceListActive` to pull every
 *      teammate whose presence file is fresher than 60 s. Also subscribe
 *      to the optional `presence:update` Tauri event so the daemon can
 *      push live updates after a git pull lands a fresher file.
 *
 * Both halves are best-effort: emitter failures are swallowed (CEO rule —
 * presence write failures must not block the heartbeat); reader failures
 * keep the last known teammate list rendered.
 *
 * Wave 1.13-A owns Identity (UserProfile / TeamMember / team_roster).
 * `usePresence()` returns the raw `PresenceInfo[]`; the avatar component
 * is responsible for joining against the roster to render names + colors.
 *
 * Multi-cursor on brain doc — deferred to v1.13.1 polish (the Path B
 * git-poll cycle is too laggy for cursor positions; LAN UDP discovery
 * lights up first).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import {
  listenPresenceUpdates,
  presenceEmit,
  presenceListActive,
  type PresenceInfo,
  type UnlistenPresenceFn,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

/**
 * Heartbeat cadence. 10 s matches the spec wire shape and sits comfortably
 * under the default git_sync poll cycle (30 s) so a remote teammate sees
 * an update at most one full cycle after we emit.
 */
export const PRESENCE_HEARTBEAT_MS = 10_000;

/**
 * TTL the reader applies. 60 s covers a full git_sync poll cycle plus a
 * pull lag and one missed heartbeat — anyone fresher than this is
 * confidently "active right now". Longer TTLs would render long-departed
 * teammates as still online.
 */
export const PRESENCE_TTL_SECONDS = 60;

interface PresenceContextValue {
  /** Teammates active in the last `PRESENCE_TTL_SECONDS` seconds, newest-first. */
  teammatesActive: PresenceInfo[];
  /**
   * Set the atom path the local user is currently focused on (e.g. open
   * in the atom-preview pane). Carried into the next heartbeat so other
   * teammates see "X is reading this" against the same atom. Pass `null`
   * to clear.
   */
  setActiveAtom: (atom: string | null) => void;
  /** Force a heartbeat now — useful on explicit user action ("View atom"). */
  emitNow: (override?: { activeAtom?: string | null; actionType?: string }) => void;
}

const PresenceContext = createContext<PresenceContextValue>({
  teammatesActive: [],
  setActiveAtom: () => {},
  emitNow: () => {},
});

interface PresenceProviderProps {
  children: ReactNode;
  /**
   * Override the heartbeat cadence (test-only). Production uses
   * `PRESENCE_HEARTBEAT_MS` directly.
   */
  heartbeatMs?: number;
}

export function PresenceProvider({
  children,
  heartbeatMs = PRESENCE_HEARTBEAT_MS,
}: PresenceProviderProps) {
  const currentUser = useStore((s) => s.ui.currentUser);
  const location = useLocation();
  const [teammatesActive, setTeammatesActive] = useState<PresenceInfo[]>([]);
  const activeAtomRef = useRef<string | null>(null);

  // Capture the current route in a ref so the heartbeat closure always
  // emits the freshest value without re-installing the interval on every
  // navigation (which would defeat the cadence).
  const routeRef = useRef(location.pathname);
  useEffect(() => {
    routeRef.current = location.pathname;
  }, [location.pathname]);

  const setActiveAtom = useCallback((atom: string | null) => {
    activeAtomRef.current = atom;
  }, []);

  const emitNow = useCallback(
    (override?: { activeAtom?: string | null; actionType?: string }) => {
      if (!currentUser) return;
      const atom =
        override?.activeAtom !== undefined
          ? override.activeAtom
          : activeAtomRef.current;
      // Fire-and-forget. Defensive try/catch wraps the awaited promise
      // because `presenceEmit` itself is best-effort but a ChannelClosed
      // / network drop could still throw — never let that bubble up to
      // the React render path.
      void (async () => {
        try {
          await presenceEmit({
            user: currentUser,
            currentRoute: routeRef.current,
            activeAtom: atom,
            actionType: override?.actionType ?? "heartbeat",
          });
        } catch {
          // Swallow — CEO rule: presence write failures never cascade.
        }
      })();
    },
    [currentUser],
  );

  // Reader: pull teammate list once on mount, then every heartbeat.
  // Mount-time reads precede any emit so the user sees the current
  // teammate list immediately on app open even before they've emitted
  // their own first beat.
  const refreshTeammates = useCallback(async () => {
    if (!currentUser) return;
    try {
      const list = await presenceListActive({
        ttlSeconds: PRESENCE_TTL_SECONDS,
        excludeUser: currentUser,
      });
      setTeammatesActive(list);
    } catch {
      // Keep prior list rendered — observational widget should never
      // collapse to empty just because one read failed.
    }
  }, [currentUser]);

  // Emit-on-route-change. Separate from the cadence interval so a route
  // change always produces an immediate heartbeat with `actionType =
  // route_change`. The interval still fires its own cadence beat 10 s
  // later — the duplicate write is harmless (file is overwritten in place).
  useEffect(() => {
    if (!currentUser) return;
    emitNow({ actionType: "route_change" });
  }, [location.pathname, currentUser, emitNow]);

  // Cadence loop — emit + read every `heartbeatMs`.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    void refreshTeammates();
    emitNow({ actionType: "mount" });
    const handle = window.setInterval(() => {
      if (cancelled) return;
      emitNow({ actionType: "heartbeat" });
      void refreshTeammates();
    }, heartbeatMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [currentUser, heartbeatMs, emitNow, refreshTeammates]);

  // Optional Tauri-event subscription so the daemon can push live updates
  // after a git pull lands a fresher presence file from a teammate. This
  // shrinks the perceived latency from the 10 s polling window down to
  // single-digit seconds when both sides are git-sync'd. Silent no-op
  // outside Tauri or when the daemon doesn't emit the event.
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    let unlisten: UnlistenPresenceFn | null = null;
    void (async () => {
      try {
        unlisten = await listenPresenceUpdates(() => {
          if (cancelled) return;
          // Don't apply the single payload directly — pull the freshest
          // full list so we get TTL filtering + ordering for free.
          void refreshTeammates();
        });
      } catch {
        // Already swallowed inside the wrapper; nothing to do here.
      }
    })();
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, [currentUser, refreshTeammates]);

  const value = useMemo<PresenceContextValue>(
    () => ({ teammatesActive, setActiveAtom, emitNow }),
    [teammatesActive, setActiveAtom, emitNow],
  );

  return (
    <PresenceContext.Provider value={value}>
      {children}
    </PresenceContext.Provider>
  );
}

/**
 * Consume the presence layer.
 *
 * `teammatesActive` — newest-first list of teammates fresh in the last 60 s.
 * `setActiveAtom` — call when the user opens an atom-preview pane so the
 *   next heartbeat carries `active_atom`.
 * `emitNow` — explicit heartbeat trigger (e.g. on click). Optional override
 *   lets the caller bypass `activeAtomRef` for one-shot writes.
 */
export function usePresence(): PresenceContextValue {
  return useContext(PresenceContext);
}
// === end wave 1.13-D ===
