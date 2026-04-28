// === wave 1.13-A ===
/**
 * Wave 1.13-A — Identity + Inbox TypeScript wrappers.
 *
 * Identity:
 *   * `identityGetCurrentUser` / `useCurrentUser` — current user profile.
 *   * `identityTeamRoster` / `useTeamRoster` — full team roster (derived
 *     from `<memory_dir>/personal/*` subdirectories).
 *   * `identitySetProfile` — persist display_name / email / avatar_url.
 *
 * Inbox:
 *   * `inboxList` / `inboxEmit` / `inboxMarkRead` / `inboxArchive` /
 *     `inboxMarkAllRead`.
 *
 * All commands transparently fall back to mock data when not running inside
 * Tauri (browser dev / vitest). Hooks subscribe to the
 * `inbox:event_created` Tauri event so the consumer auto-refreshes when a
 * new event arrives.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

// Mirror of `safeInvoke` from lib/tauri.ts. Inlined here so we don't
// circular-import (lib/tauri.ts is large).
const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function safeInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T,
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tauri] invoke "${cmd}" failed:`, e, "args=", args);
    return await mock();
  }
}

// ---------------------------------------------------------------------------
// Types — mirror commands::identity + commands::inbox_store
// ---------------------------------------------------------------------------

export interface UserProfile {
  /** URL-safe handle. Never blank. */
  alias: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export interface TeamMember {
  alias: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export interface InboxEvent {
  id: string;
  /** "mention" | "review_request" | "comment_reply" | future kinds. */
  kind: string;
  targetUser: string;
  sourceUser: string;
  sourceAtom: string;
  /** RFC 3339 UTC. */
  timestamp: string;
  payload: Record<string, unknown>;
  read: boolean;
  archived: boolean;
}

export type InboxFilter = "unread" | "all" | "archived";

// ---------------------------------------------------------------------------
// Mock data (browser dev / vitest)
// ---------------------------------------------------------------------------

const MOCK_PROFILE: UserProfile = {
  alias: "you",
  displayName: "You",
};

const MOCK_ROSTER: TeamMember[] = [
  { alias: "alice", displayName: "Alice" },
  { alias: "bob", displayName: "Bob" },
  { alias: "carol", displayName: "Carol" },
];

// ---------------------------------------------------------------------------
// Identity commands
// ---------------------------------------------------------------------------

export async function identityGetCurrentUser(): Promise<UserProfile> {
  return safeInvoke<UserProfile>(
    "identity_get_current_user",
    undefined,
    () => MOCK_PROFILE,
  );
}

export async function identityTeamRoster(): Promise<TeamMember[]> {
  return safeInvoke<TeamMember[]>(
    "identity_team_roster",
    undefined,
    () => MOCK_ROSTER,
  );
}

// === v1.13.4 round-4 ===
// kept for: Settings → Profile editor (display_name / avatar picker).
// Backend command + persistence layer are wired (Rust side at
// commands::identity::identity_set_profile + personal/<alias>/profile.json),
// just no UI consumer yet. The Wave 1.13-A inbox toast already greets
// teammates by displayName, so as soon as the Settings profile editor
// lands this becomes the natural setter. Delete only after one full
// release with no settings UI added.
// === end v1.13.4 round-4 ===
export async function identitySetProfile(args: {
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}): Promise<UserProfile> {
  return safeInvoke<UserProfile>("identity_set_profile", { args }, () => ({
    ...MOCK_PROFILE,
    ...args,
  }));
}

// ---------------------------------------------------------------------------
// Inbox commands
// ---------------------------------------------------------------------------

export async function inboxList(args?: {
  limit?: number;
  filter?: InboxFilter;
  forUser?: string;
}): Promise<InboxEvent[]> {
  return safeInvoke<InboxEvent[]>(
    "inbox_list",
    { args: args ?? {} },
    () => [],
  );
}

// === v1.13.4 round-4 ===
// kept for: frontend-driven inbox events from CommandPalette, /people
// page ("notify @alice this matters"), and dev/QA fixture seeders.
// Today every emit comes from Rust (mention parser, review_request,
// comment_reply) — that's intentional, the source-of-truth is the file
// write. But the wrapper keeps the door open for UI-initiated nudges
// without a Rust round-trip. Delete only if we lock in a "Rust-only
// emit" architectural rule.
// === end v1.13.4 round-4 ===
export async function inboxEmit(args: {
  kind: string;
  targetUser: string;
  sourceAtom: string;
  payload?: Record<string, unknown>;
  sourceUser?: string;
}): Promise<InboxEvent> {
  return safeInvoke<InboxEvent>("inbox_emit", { args }, () => ({
    id: `${args.kind}-mock-${Math.random().toString(36).slice(2, 10)}`,
    kind: args.kind,
    targetUser: args.targetUser,
    sourceUser: args.sourceUser ?? MOCK_PROFILE.alias,
    sourceAtom: args.sourceAtom,
    timestamp: new Date().toISOString(),
    payload: args.payload ?? {},
    read: false,
    archived: false,
  }));
}

export async function inboxMarkRead(eventId: string): Promise<void> {
  return safeInvoke<void>(
    "inbox_mark_read",
    { args: { eventId } },
    () => undefined,
  );
}

export async function inboxArchive(eventId: string): Promise<void> {
  return safeInvoke<void>(
    "inbox_archive",
    { args: { eventId } },
    () => undefined,
  );
}

export async function inboxMarkAllRead(): Promise<number> {
  return safeInvoke<number>("inbox_mark_all_read", undefined, () => 0);
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Resolve the current user profile. Re-fetches once on mount; the alias is
 * stable for a given install so we don't poll.
 *
 * === v1.13.3 round-3 ===
 * Currently has zero in-app callers — AppShell calls
 * `identityGetCurrentUser()` imperatively inside a useEffect (it only
 * needs the alias once, stored into a ref for the inbox listener), and
 * everywhere else reads `useStore((s) => s.ui.currentUser)` for the
 * alias-only shape. Kept intentionally as the exported public-API hook
 * for components that want the full UserProfile shape (display_name,
 * avatar_url) — Settings profile editor + future avatar pickers will be
 * the natural callers. Delete only after one full release with no new
 * call sites added.
 * === end v1.13.3 round-3 ===
 */
export function useCurrentUser(): {
  user: UserProfile | null;
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [user, setUser] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const u = await identityGetCurrentUser();
      setUser(u);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { user, loading, refresh };
}

/**
 * Resolve the team roster. Re-fetches on mount + on every
 * `inbox:event_created` Tauri event (a new mention is the most common
 * reason a roster might have changed — a teammate just opted into the
 * shared memory dir for the first time).
 */
export function useTeamRoster(): {
  roster: TeamMember[];
  loading: boolean;
  refresh: () => Promise<void>;
} {
  const [roster, setRoster] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await identityTeamRoster();
      setRoster(r);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // Re-fetch on inbox events too. The listener is a no-op outside Tauri.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen("inbox:event_created", () => {
          void refresh();
        });
      } catch {
        // browser / vitest — silently no-op
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);
  return { roster, loading, refresh };
}

/**
 * Inbox feed. Subscribes to `inbox:event_created` so the list auto-refreshes
 * when a new event arrives.
 */
export function useInbox(filter: InboxFilter = "all"): {
  events: InboxEvent[];
  loading: boolean;
  unreadCount: number;
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  archive: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
} {
  const [events, setEvents] = useState<InboxEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const e = await inboxList({ filter });
      setEvents(e);
    } finally {
      setLoading(false);
    }
  }, [filter]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen("inbox:event_created", () => {
          void refresh();
        });
      } catch {
        // browser / vitest
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);

  const unreadCount = useMemo(
    () => events.filter((e) => !e.read && !e.archived).length,
    [events],
  );

  const markRead = useCallback(
    async (id: string) => {
      await inboxMarkRead(id);
      setEvents((prev) =>
        prev.map((e) => (e.id === id ? { ...e, read: true } : e)),
      );
    },
    [],
  );
  const archive = useCallback(
    async (id: string) => {
      await inboxArchive(id);
      setEvents((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, archived: true, read: true } : e,
        ),
      );
    },
    [],
  );
  const markAllRead = useCallback(async () => {
    await inboxMarkAllRead();
    setEvents((prev) => prev.map((e) => ({ ...e, read: true })));
  }, []);

  return { events, loading, unreadCount, refresh, markRead, archive, markAllRead };
}

/**
 * Lightweight unread-count hook for the sidebar badge. Polls the unread
 * filter once and listens for new-event events to bump.
 */
export function useInboxUnreadCount(): number {
  const [count, setCount] = useState(0);
  const refresh = useCallback(async () => {
    const list = await inboxList({ filter: "unread" });
    setCount(list.length);
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        unlisten = await listen("inbox:event_created", () => {
          void refresh();
        });
      } catch {
        // browser / vitest
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [refresh]);
  return count;
}
// === end wave 1.13-A ===
