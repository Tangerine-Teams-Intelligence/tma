/**
 * v1.16 Wave 4 D2 — Always-pinned StatusBar.
 *
 * 4-chip live signal bar mounted in AppShell (above ViewTabs / route
 * content) so /feed /threads /people all see the same "what is
 * Tangerine doing right now" strip.
 *
 *   1. Source 🟢   — count of active personal-agent watchers (cursor /
 *                    claude_code / codex / windsurf / devin / replit /
 *                    apple_intelligence / ms_copilot). 0 → amber ⚠ ;
 *                    ≥1 → emerald 🟢 .
 *   2. Today 📥   — count of timeline events captured in the last 24h.
 *                    Re-fetched every 30s (fire-and-forget; failures keep
 *                    the previous count rendered, R6/R7/R8 honesty: a
 *                    stale count is still better than a flicker to 0).
 *   3. Online 👥  — count of teammates fresh in the presence layer's
 *                    TTL window. 0 → "Solo"; ≥1 → "<n> online".
 *   4. For you ⚠  — count of atoms whose body @-mentions the current
 *                    user. Hidden entirely at 0 so a quiet feed doesn't
 *                    grow visual noise.
 *
 * Each chip is clickable and routes to the corresponding triage surface
 * via React Router's `useNavigate`. Coordination with D1 (Settings
 * reorg): we push '/settings' without a tab fragment — D1 owns the
 * landing-tab default.
 *
 * Mount gating: only renders when `welcomed === true`. New users running
 * MagicMoment shouldn't see the live signal bar before they've finished
 * onboarding (it would just flash empty / noise).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useStore } from "@/lib/store";
import { readTimelineRecent, type TimelineEvent } from "@/lib/views";
import { usePresence } from "@/components/presence/PresenceProvider";
import { extractMentions } from "@/lib/mention-extract";

/**
 * Polling cadence for the timeline read. 30 s matches the spec — short
 * enough that "Today / @me" counters feel live, long enough that the
 * Tauri round-trip stays cheap. Fake-timer tests advance this directly.
 */
export const STATUS_BAR_POLL_MS = 30_000;

/** 24 h cutoff for the Today chip. Mirrors `/feed`'s TODAY_CUTOFF_MS. */
const TODAY_CUTOFF_MS = 24 * 60 * 60 * 1000;

interface DerivedCounts {
  todayCount: number;
  forMeCount: number;
}

/**
 * Pure derivation so we can keep the React effect surface tiny + unit-
 * test the math without rendering. Splits an event list into:
 *   - todayCount: events whose `ts` is within TODAY_CUTOFF_MS of now.
 *   - forMeCount: events whose body @-mentions `currentUser`.
 *
 * `currentUser` is lower-cased before the membership check; mention
 * aliases land lower-case from `extractMentions`, so the comparison
 * stays case-insensitive even if the user typed mixed-case in the
 * profile.
 */
function deriveCounts(
  events: TimelineEvent[],
  currentUser: string,
): DerivedCounts {
  const now = Date.now();
  const cutoff = now - TODAY_CUTOFF_MS;
  const me = (currentUser || "").trim().toLowerCase();
  let todayCount = 0;
  let forMeCount = 0;
  for (const ev of events) {
    const tsMs = Date.parse(ev.ts || "");
    if (!Number.isNaN(tsMs) && tsMs >= cutoff) {
      todayCount += 1;
    }
    if (me && ev.body) {
      const aliases = extractMentions(ev.body);
      if (aliases.includes(me)) {
        forMeCount += 1;
      }
    }
  }
  return { todayCount, forMeCount };
}

export function StatusBar() {
  const navigate = useNavigate();
  const welcomed = useStore((s) => s.ui.welcomed);
  const currentUser = useStore((s) => s.ui.currentUser);
  const personalAgentsEnabled = useStore((s) => s.ui.personalAgentsEnabled);
  const { teammatesActive } = usePresence();

  const [events, setEvents] = useState<TimelineEvent[]>([]);

  // We keep the cancellation flag in a ref so the polling loop never
  // races a late-arriving fetch against an unmount. The 30-second
  // interval is owned by a dedicated effect; the cleanup clears it +
  // flips the cancel flag so any in-flight read drops on resolution.
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!welcomed) return;
    cancelRef.current = false;
    const tick = async () => {
      try {
        const d = await readTimelineRecent(500);
        if (cancelRef.current) return;
        setEvents(d.events);
      } catch {
        // Swallow — keep the previous list rendered. R6/R7/R8 honesty
        // would normally flag a read failure visually, but the status
        // bar is a signal-of-signals; surfacing fetch errors here would
        // double-fire alongside the route's own error banner.
      }
    };
    void tick();
    const handle = window.setInterval(() => void tick(), STATUS_BAR_POLL_MS);
    return () => {
      cancelRef.current = true;
      window.clearInterval(handle);
    };
  }, [welcomed]);

  // Source count — sum of true entries in the personal-agents map.
  // Memoised so we don't re-iterate the (small) record on every render.
  const sourceCount = useMemo(() => {
    let n = 0;
    for (const v of Object.values(personalAgentsEnabled)) {
      if (v) n += 1;
    }
    return n;
  }, [personalAgentsEnabled]);

  const { todayCount, forMeCount } = useMemo(
    () => deriveCounts(events, currentUser),
    [events, currentUser],
  );

  const onlineCount = teammatesActive.length;

  // Onboarding gate — never render before MagicMoment has been dismissed.
  // Returning the null AFTER the hooks above keeps the hook order stable
  // across the welcomed flip (React forbids conditional hook calls).
  if (!welcomed) return null;

  // v1.16 Wave 5 — mobile chip compaction. The Source chip drops the
  // vendor name list ("🟢 Cursor + CC" → "🟢 2"), Today/Online drop the
  // word suffix ("📥 12 today" → "📥 12", "👥 3 online" → "👥 3"), @me
  // keeps its full label because the count is the whole point. Desktop
  // (md:) keeps every word so the chip strip reads as a sentence.
  const sourceFull =
    sourceCount > 0 ? sourceLabel(personalAgentsEnabled) : "⚠ No source";
  const sourceShort = sourceCount > 0 ? `🟢 ${sourceCount}` : "⚠";

  return (
    <div
      data-testid="status-bar"
      role="status"
      aria-label="Tangerine status bar"
      className="ti-no-select flex items-center gap-1 overflow-x-auto border-b border-stone-200 bg-white px-2 py-1 font-sans text-[11px] dark:border-stone-800 dark:bg-stone-950 md:gap-2 md:px-3"
    >
      <button
        type="button"
        data-testid="status-bar-source"
        data-active={sourceCount > 0 ? "true" : "false"}
        onClick={() => navigate("/settings")}
        title={
          sourceCount > 0
            ? `${sourceCount} source${sourceCount > 1 ? "s" : ""} connected — open Settings`
            : "No sources connected — open Settings"
        }
        className={
          "shrink-0 rounded-full border px-2 py-0.5 transition-colors " +
          (sourceCount > 0
            ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300"
            : "border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300")
        }
      >
        <span className="md:hidden" data-testid="status-bar-source-short">
          {sourceShort}
        </span>
        <span className="hidden md:inline" data-testid="status-bar-source-full">
          {sourceFull}
        </span>
      </button>

      <button
        type="button"
        data-testid="status-bar-today"
        onClick={() => navigate("/feed?filter=today")}
        title={`${todayCount} captured in the last 24h — open Feed`}
        className="shrink-0 rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 text-stone-700 transition-colors hover:bg-stone-200 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-200"
      >
        {"📥 "}
        {todayCount}
        <span className="hidden md:inline">{" today"}</span>
      </button>

      <button
        type="button"
        data-testid="status-bar-online"
        onClick={() => navigate("/people")}
        title={
          onlineCount > 0
            ? `${onlineCount} teammate${onlineCount > 1 ? "s" : ""} online — open People`
            : "Working solo — open People"
        }
        className="shrink-0 rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-blue-700 transition-colors hover:bg-blue-100 dark:border-blue-900/60 dark:bg-blue-950/40 dark:text-blue-300"
      >
        {"👥 "}
        {onlineCount > 0 ? (
          <>
            {onlineCount}
            <span className="hidden md:inline">{" online"}</span>
          </>
        ) : (
          <>
            <span className="md:hidden">0</span>
            <span className="hidden md:inline">Solo</span>
          </>
        )}
      </button>

      {forMeCount > 0 && (
        <button
          type="button"
          data-testid="status-bar-forme"
          onClick={() => navigate("/feed?filter=me")}
          title={`${forMeCount} mention${forMeCount > 1 ? "s" : ""} of you — open Feed`}
          className="shrink-0 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-orange-700 transition-colors hover:bg-orange-100 dark:border-orange-900/60 dark:bg-orange-950/40 dark:text-orange-300"
        >
          {"⚠ "}
          {forMeCount} @me
        </button>
      )}
    </div>
  );
}

/**
 * Compose the source chip label. Lists the two highest-priority active
 * sources by short name; everything else is folded into "+N". Cursor
 * and Claude Code lead because they're the v1.16 launch sources;
 * everything past those degrades gracefully without bloating the chip.
 */
function sourceLabel(map: Record<string, boolean>): string {
  const SHORT: Record<string, string> = {
    cursor: "Cursor",
    claude_code: "CC",
    codex: "Codex",
    windsurf: "Windsurf",
    devin: "Devin",
    replit: "Replit",
    apple_intelligence: "Apple",
    ms_copilot: "Copilot",
  };
  const order = [
    "cursor",
    "claude_code",
    "codex",
    "windsurf",
    "devin",
    "replit",
    "apple_intelligence",
    "ms_copilot",
  ];
  const active = order.filter((k) => map[k]);
  if (active.length === 0) return "⚠ No source";
  const head = active.slice(0, 2).map((k) => SHORT[k] ?? k);
  const rest = active.length - head.length;
  const label = head.join(" + ") + (rest > 0 ? ` +${rest}` : "");
  return `🟢 ${label}`;
}
