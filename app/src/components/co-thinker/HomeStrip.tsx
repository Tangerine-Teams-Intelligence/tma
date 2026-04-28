/**
 * v2.0-beta.3 — Co-thinker home strip.
 *
 * A persistent 1-line strip mounted at the top of every route inside
 * `<AppShell/>`. Makes the AGI's presence visible all the time so the
 * user doesn't have to navigate to `/co-thinker` to know whether the
 * brain is alive. Modelled on ChatGPT's model indicator: never disappears,
 * never claims a click unless the user chooses.
 *
 * Surface contract:
 *   • Reads `co_thinker_status()` via `coThinkerStatus()` on mount; polls
 *     every 30s so the "last heartbeat" relative time stays fresh without
 *     a route nav.
 *   • Renders nothing when `agiParticipation === false` so the master
 *     kill switch (per v1.8) actually quiets the strip too. The store's
 *     setter flips this synchronously so the strip pops in/out immediately.
 *   • Displays a 🍊 dot, the last-heartbeat relative time, and a count of
 *     "things watching" derived from `observations_today`. Click anywhere
 *     on the strip routes to `/co-thinker`.
 *   • Subtle pulse cue when the brain made activity in the last 10 min —
 *     adds `data-recent="true"` so the renderer can play the existing
 *     `ti-pulse` keyframe without needing a new animation. Pure CSS, no
 *     extra deps.
 *
 * The strip is purposely terse — it sits above the main content on every
 * route so any chrome here costs the user attention permanently.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { coThinkerStatus, type CoThinkerStatus } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { relativeTime } from "@/lib/co-thinker";
// === wave 9 === — vendor color for the heartbeat dot. The dot picks up
// the color of the vendor whose channel served the most recent
// heartbeat so the strip telegraphs "this beat went through Cursor"
// vs "this beat went through Ollama". Cross-vendor visibility moat.
import { vendorColor } from "@/lib/vendor-colors";

/** Poll cadence for `coThinkerStatus()`. 30s keeps "5 min ago" → "6 min
 *  ago" rolling without hammering the bridge. */
const POLL_INTERVAL_MS = 30_000;

/** Threshold below which the strip is considered "recently active" and
 *  pulses. 10 minutes covers the 5-min default heartbeat plus jitter. */
const RECENT_ACTIVITY_MS = 10 * 60 * 1000;

export function HomeStrip() {
  const agiParticipation = useStore((s) => s.ui.agiParticipation);
  // === wave 9 === — the strip's heartbeat dot tints to the user's
  // primary AI tool (which is the channel each scheduled heartbeat
  // routes through). Telegraphs cross-vendor visibility on every page.
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const [status, setStatus] = useState<CoThinkerStatus | null>(null);

  // Poll status — read on mount, then every POLL_INTERVAL_MS. Skipped
  // while the master switch is off so we don't churn the bridge for a
  // hidden surface. The interval is rebuilt when participation flips
  // back on so the strip refreshes quickly.
  useEffect(() => {
    if (!agiParticipation) return;
    let cancel = false;
    const fetchStatus = async () => {
      try {
        const s = await coThinkerStatus();
        if (!cancel) setStatus(s);
      } catch {
        // Bridge not available (browser dev / vitest) — leave the
        // last-known status in place so the strip stays usable.
      }
    };
    void fetchStatus();
    const interval = window.setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => {
      cancel = true;
      window.clearInterval(interval);
    };
  }, [agiParticipation]);

  // Master switch off → render nothing. We unmount rather than hide so
  // the polling interval also tears down (`useEffect` cleanup above).
  if (!agiParticipation) return null;

  const lastHeartbeat = status?.last_heartbeat_at ?? null;
  const observations = status?.observations_today ?? 0;
  const isRecent = lastHeartbeat !== null &&
    Date.now() - new Date(lastHeartbeat).getTime() < RECENT_ACTIVITY_MS;
  // === wave 9 === — vendor color for the heartbeat dot. When the
  // primary AI tool is set, the dot tints to that vendor's color; we
  // also surface the vendor name in the tooltip so the user can see
  // which AI just answered. Apple-Intelligence falls back to a solid
  // purple since it's a CSS gradient (can't tint a 1.5px dot with one).
  const vc = vendorColor(primaryAITool);
  const dotHex = vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc.hex;
  const tooltip = primaryAITool
    ? `Last heartbeat used: ${vc.label}`
    : "No primary AI tool set yet";

  return (
    <Link
      to="/co-thinker"
      data-testid="co-thinker-home-strip"
      data-recent={isRecent ? "true" : "false"}
      data-vendor={primaryAITool ?? "default"}
      className={
        "ti-no-select flex h-7 items-center gap-2 border-b border-stone-200 " +
        "bg-stone-50 px-4 font-mono text-[11px] text-stone-600 " +
        "transition-colors duration-fast hover:bg-stone-100 " +
        "dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400 " +
        "dark:hover:bg-stone-900"
      }
      aria-label="Co-thinker status — click to open"
      title={tooltip}
    >
      {/* === wave 9 === — heartbeat dot picks up the primary AI tool's
          vendor color. When recent activity → vendor-colored alive halo
          (semantic: "this vendor is currently feeding the brain").
          Stale → solid vendor dot. Empty (no primary tool) → orange. */}
      {isRecent ? (
        <span
          aria-hidden
          data-testid="co-thinker-home-strip-dot"
          className="ti-alive-dot"
          style={{ width: "8px", height: "8px", background: dotHex }}
        />
      ) : (
        <span
          aria-hidden
          data-testid="co-thinker-home-strip-dot"
          className="inline-block h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ background: primaryAITool ? dotHex : "var(--ti-orange-500)" }}
        />
      )}
      {/* === wave 8 === — Co-thinker label uses display serif at body
          size for editorial gravitas without breaking the strip rhythm. */}
      <span
        className="text-stone-700 dark:text-stone-200"
        style={{ fontFamily: "var(--ti-font-display)", fontSize: "12px", fontWeight: 500 }}
      >
        Co-thinker
      </span>
      <span aria-hidden>·</span>
      <span data-testid="co-thinker-home-strip-heartbeat">
        last heartbeat {lastHeartbeat ? relativeTime(lastHeartbeat) : "never"}
      </span>
      {/* Observations counter is gated on a real heartbeat. Pre-init the
          strip would otherwise flash "0 things watching", which reads as
          a broken empty state — friendlier to point at the Initialize CTA
          on /co-thinker until the first heartbeat actually fires.
          === wave 8 === — count rendered with the display serif so the
          number gets its own visual weight on the strip. */}
      {lastHeartbeat ? (
        <>
          <span aria-hidden>·</span>
          <span data-testid="co-thinker-home-strip-observations">
            <span
              style={{
                fontFamily: "var(--ti-font-display)",
                fontWeight: 600,
                color: "var(--ti-ink-800)",
              }}
            >
              {observations}
            </span>{" "}
            thing{observations === 1 ? "" : "s"} watching
          </span>
        </>
      ) : (
        <>
          <span aria-hidden>·</span>
          <span
            data-testid="co-thinker-home-strip-uninitialized"
            className="italic text-stone-500 dark:text-stone-500"
          >
            not started yet — click to initialize
          </span>
        </>
      )}
      <span className="ml-auto text-stone-500 dark:text-stone-500">
        {lastHeartbeat ? "click to dive" : "→"}
      </span>
    </Link>
  );
}
