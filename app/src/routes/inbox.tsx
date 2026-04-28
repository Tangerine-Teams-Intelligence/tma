// === wave 1.13-A ===
/**
 * /inbox — collab inbox for v1.13.
 *
 * Replaces the wave-5-α pending-alerts view (whose only consumer was the
 * daemon's `briefs/pending.md` writer). The new shape is the collab loop's
 * primary surface:
 *   * Tab 1 — Mentions     (kind === "mention")
 *   * Tab 2 — Review reqs  (kind === "review_request")
 *   * Tab 3 — Comment ↪    (kind === "comment_reply")
 *
 * Each row renders:
 *   * Vendor / source-user color avatar (initial circle keyed by source_user
 *     alias for now; Wave 1.13-D layers presence dots on top).
 *   * Author + atom title + relative time.
 *   * Action group: Open / Mark read / Archive.
 *
 * Filters: an "Unread only" toggle hides events with `read === true`.
 * "Mark all read" empties the unread count for the active tab in one shot.
 * "Archive" is a per-event flag; the archived events get their own pseudo-
 * tab "Archived" reachable from a small ⏷ menu (kept out of the main tab
 * row to keep the visual rhythm clean).
 *
 * Backend: `lib/identity.ts::useInbox` — itself a thin wrapper around
 * `inbox_list` / `inbox_mark_read` / `inbox_archive` / `inbox_mark_all_read`
 * Tauri commands. The hook subscribes to the `inbox:event_created` event so
 * a fresh @mention from a teammate shows up without a refresh.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  AtSign,
  CheckCheck,
  CheckCircle2,
  Inbox as InboxIcon,
  MessageCircle,
  GitPullRequest,
  Archive,
  ExternalLink,
  Eye,
} from "lucide-react";

import {
  useInbox,
  type InboxEvent,
} from "@/lib/identity";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/EmptyState";

type Tab = "mention" | "review_request" | "comment_reply";

const TABS: { id: Tab; iconKey: "at" | "pr" | "msg"; key: string }[] = [
  { id: "mention", iconKey: "at", key: "tabMentions" },
  { id: "review_request", iconKey: "pr", key: "tabReviews" },
  { id: "comment_reply", iconKey: "msg", key: "tabReplies" },
];

function tabIcon(kind: "at" | "pr" | "msg") {
  if (kind === "at") return AtSign;
  if (kind === "pr") return GitPullRequest;
  return MessageCircle;
}

function relativeTime(iso: string, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return t("inbox.relative.justNow", { defaultValue: "just now" });
  const min = Math.round(sec / 60);
  if (min < 60) return t("inbox.relative.minutes", { count: min, defaultValue: `${min}m ago` });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("inbox.relative.hours", { count: hr, defaultValue: `${hr}h ago` });
  const d = Math.round(hr / 24);
  return t("inbox.relative.days", { count: d, defaultValue: `${d}d ago` });
}

function avatarColor(alias: string): { bg: string; fg: string } {
  // Deterministic hash → hue. Keeps each teammate's avatar visually stable
  // across sessions without needing an avatar URL.
  let h = 0;
  for (let i = 0; i < alias.length; i++) h = (h * 31 + alias.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return {
    bg: `hsl(${hue}, 60%, 88%)`,
    fg: `hsl(${hue}, 60%, 30%)`,
  };
}

export default function InboxRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>("mention");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const filter = showArchived ? "archived" : unreadOnly ? "unread" : "all";
  const inbox = useInbox(filter);

  const eventsByKind = useMemo(() => {
    const buckets: Record<Tab, InboxEvent[]> = {
      mention: [],
      review_request: [],
      comment_reply: [],
    };
    for (const e of inbox.events) {
      if (e.kind in buckets) {
        buckets[e.kind as Tab].push(e);
      }
    }
    return buckets;
  }, [inbox.events]);

  const visible = eventsByKind[tab];
  const unreadByTab: Record<Tab, number> = useMemo(() => {
    const out: Record<Tab, number> = {
      mention: 0,
      review_request: 0,
      comment_reply: 0,
    };
    for (const e of inbox.events) {
      if (!e.read && !e.archived && e.kind in out) {
        out[e.kind as Tab] += 1;
      }
    }
    return out;
  }, [inbox.events]);

  // Auto-mark read on mount when an event is opened. We keep this off for
  // now — the explicit "Mark read" action is the only flip. This way the
  // unread badge stays an honest signal until the user actively dismisses.

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <div className="mb-6">
          <Link
            to="/today"
            className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            <ArrowLeft size={12} /> {t("inbox.back", { defaultValue: "/today" })}
          </Link>
        </div>

        <header className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
            <InboxIcon size={20} className="text-stone-500" />
          </div>
          <div className="flex-1">
            <p className="ti-section-label">
              {t("inbox.kicker", { defaultValue: "Inbox" })}
            </p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {t("inbox.titleCollab", { defaultValue: "Activity for you" })}
            </h1>
            <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
              {t("inbox.subtitle", {
                defaultValue:
                  "Mentions, review requests, and replies your teammates sent your way.",
              })}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void inbox.markAllRead()}
            data-testid="inbox-mark-all-read"
            className="inline-flex items-center gap-1.5 rounded border border-stone-200 px-2 py-1 font-mono text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-300 dark:hover:bg-stone-900"
          >
            <CheckCheck size={12} />
            {t("inbox.markAllRead", { defaultValue: "Mark all read" })}
          </button>
        </header>

        {/* Tabs */}
        <nav
          className="mt-6 flex gap-1 border-b border-stone-200 dark:border-stone-800"
          role="tablist"
          data-testid="inbox-tabs"
        >
          {TABS.map((t0) => {
            const Icon = tabIcon(t0.iconKey);
            const active = tab === t0.id;
            const unread = unreadByTab[t0.id];
            return (
              <button
                key={t0.id}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`inbox-tab-${t0.id}`}
                onClick={() => {
                  setTab(t0.id);
                  setShowArchived(false);
                }}
                className={
                  "flex items-center gap-2 border-b-2 px-3 py-2 text-[12px] " +
                  (active
                    ? "border-[var(--ti-orange-500)] text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]"
                    : "border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100")
                }
              >
                <Icon size={13} />
                <span>
                  {t(`inbox.${t0.key}`, {
                    defaultValue:
                      t0.id === "mention"
                        ? "Mentions"
                        : t0.id === "review_request"
                          ? "Review requests"
                          : "Comment replies",
                  })}
                </span>
                {unread > 0 && (
                  <span
                    data-testid={`inbox-tab-${t0.id}-badge`}
                    className="rounded-full bg-[var(--ti-orange-500)] px-1.5 py-0.5 font-mono text-[10px] text-white"
                  >
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Filter row */}
        <div className="mt-3 flex items-center gap-3 text-[11px] text-stone-500 dark:text-stone-400">
          <label className="inline-flex items-center gap-1">
            <input
              type="checkbox"
              data-testid="inbox-unread-toggle"
              checked={unreadOnly}
              disabled={showArchived}
              onChange={(e) => setUnreadOnly(e.target.checked)}
              className="h-3 w-3"
            />
            {t("inbox.unreadOnly", { defaultValue: "Unread only" })}
          </label>
          <button
            type="button"
            data-testid="inbox-show-archived"
            onClick={() => setShowArchived((v) => !v)}
            className="font-mono text-[11px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {showArchived
              ? t("inbox.hideArchived", { defaultValue: "Hide archived" })
              : t("inbox.showArchived", { defaultValue: "Show archived" })}
          </button>
        </div>

        {/* Body */}
        <section
          className="mt-4 space-y-2"
          aria-live="polite"
          aria-busy={inbox.loading}
        >
          {inbox.loading ? (
            <div className="space-y-2" data-testid="inbox-loading">
              {Array.from({ length: 3 }).map((_, i) => (
                <div
                  key={i}
                  className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900"
                >
                  <Skeleton className="h-3 w-1/3" />
                  <Skeleton className="mt-2 h-3 w-1/2" />
                </div>
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={
                <CheckCircle2
                  size={28}
                  className="text-[var(--ti-success)]"
                />
              }
              title={t("inbox.emptyTabTitle", {
                defaultValue:
                  tab === "mention"
                    ? "No mentions yet."
                    : tab === "review_request"
                      ? "No review requests."
                      : "No replies yet.",
              })}
              description={t("inbox.emptyTabBody", {
                defaultValue:
                  "When a teammate @mentions you, asks for a review, or replies to a thread you're in, it shows up here.",
              })}
              testId="inbox-empty"
            />
          ) : (
            visible.map((event) => (
              <EventCard
                key={event.id}
                event={event}
                t={t}
                onMarkRead={() => void inbox.markRead(event.id)}
                onArchive={() => void inbox.archive(event.id)}
                onOpen={() => {
                  // Mark read implicitly when opening, then route to memory
                  // viewer. The /memory route accepts a relative path so a
                  // direct file deep-link works.
                  void inbox.markRead(event.id);
                  if (event.sourceAtom) {
                    navigate(`/memory/${event.sourceAtom}`);
                  }
                }}
              />
            ))
          )}
        </section>
      </div>
    </div>
  );
}

function EventCard({
  event,
  onMarkRead,
  onArchive,
  onOpen,
  t,
}: {
  event: InboxEvent;
  onMarkRead: () => void;
  onArchive: () => void;
  onOpen: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const { bg, fg } = avatarColor(event.sourceUser);
  const initial = (event.sourceUser[0] ?? "?").toUpperCase();
  const snippet = (event.payload?.snippet as string | undefined) ?? "";
  const atomTitle =
    (event.payload?.atom_title as string | undefined) ??
    (event.payload?.atomTitle as string | undefined) ??
    event.sourceAtom ??
    "(no source atom)";
  return (
    <div
      data-testid="inbox-event"
      data-event-id={event.id}
      data-event-kind={event.kind}
      data-event-read={event.read ? "true" : "false"}
      className={
        "flex items-start gap-3 rounded-md border p-3 transition-colors " +
        (event.read
          ? "border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-900"
          : "border-stone-300 bg-white dark:border-stone-700 dark:bg-stone-900")
      }
    >
      <div
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[12px] font-medium"
        style={{ background: bg, color: fg }}
      >
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
            @{event.sourceUser}
          </span>
          <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
            {relativeTime(event.timestamp, t)}
          </span>
          {!event.read && (
            <span
              aria-label={t("inbox.unreadDotLabel", { defaultValue: "unread" })}
              className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ti-orange-500)]"
            />
          )}
        </div>
        <p className="mt-0.5 text-[12px] text-stone-700 dark:text-stone-300">
          {atomTitle}
        </p>
        {snippet && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
            {snippet}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            data-testid="inbox-event-open"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded border border-stone-200 px-2 py-0.5 font-mono text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-300 dark:hover:bg-stone-800"
          >
            <ExternalLink size={11} />
            {t("inbox.open", { defaultValue: "Open" })}
          </button>
          {!event.read && (
            <button
              type="button"
              data-testid="inbox-event-mark-read"
              onClick={onMarkRead}
              className="inline-flex items-center gap-1 rounded border border-stone-200 px-2 py-0.5 font-mono text-[11px] text-stone-600 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <Eye size={11} />
              {t("inbox.markRead", { defaultValue: "Mark read" })}
            </button>
          )}
          {!event.archived && (
            <button
              type="button"
              data-testid="inbox-event-archive"
              onClick={onArchive}
              className="inline-flex items-center gap-1 rounded border border-stone-200 px-2 py-0.5 font-mono text-[11px] text-stone-500 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-800"
            >
              <Archive size={11} />
              {t("inbox.archive", { defaultValue: "Archive" })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
// === end wave 1.13-A ===
