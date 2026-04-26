import type { CoThinkerStatus } from "@/lib/tauri";
import { relativeTime } from "@/lib/co-thinker";

interface Props {
  status: CoThinkerStatus | null;
  /**
   * Cadence label shown next to "alive" pulse, e.g. "5 min foreground".
   * Static for now — Phase 4 will let the user re-tune.
   */
  cadence?: string;
}

/**
 * Top-of-page badge for the co-thinker route. Shows:
 *   • a small pulsing dot communicating "the brain is alive"
 *   • "Last heartbeat: <relative time>"
 *   • optional " · Next: <relative time>"
 *   • cadence label
 *
 * `null` status renders the "never fired" form so the empty-state path
 * doesn't have to special-case the absence of this badge.
 */
export function HeartbeatBadge({ status, cadence = "5 min foreground" }: Props) {
  const last = status?.last_heartbeat_at ?? null;
  const next = status?.next_heartbeat_at ?? null;
  return (
    <div
      data-testid="heartbeat-badge"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-stone-500 dark:text-stone-400"
    >
      <Pulse />
      <span>
        Last heartbeat:{" "}
        <span className="text-stone-700 dark:text-stone-200">
          {last ? relativeTime(last) : "never"}
        </span>
      </span>
      {next && (
        <span>
          · Next:{" "}
          <span className="text-stone-700 dark:text-stone-200">{relativeTime(next)}</span>
        </span>
      )}
      <span>· Cadence: {cadence}</span>
    </div>
  );
}

/**
 * Three-dot CSS pulse. Pure CSS — no extra deps. Animates via the keyframe
 * defined inline (Tailwind doesn't ship a stagger-able pulse out of the box
 * and this is a 6-line component so we keep it local).
 */
function Pulse() {
  return (
    <span
      aria-hidden
      className="inline-flex items-center gap-0.5"
      data-testid="heartbeat-pulse"
    >
      <Dot delay="0s" />
      <Dot delay="0.2s" />
      <Dot delay="0.4s" />
    </span>
  );
}

function Dot({ delay }: { delay: string }) {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--ti-orange-500)]"
      style={{
        animation: "ti-pulse 1.4s ease-in-out infinite",
        animationDelay: delay,
      }}
    />
  );
}
