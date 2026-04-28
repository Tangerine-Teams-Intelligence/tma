// === wave 9 ===
/**
 * Wave 9 — Brain visualization hero for /today.
 *
 * Visual translation of design moats #3 (cross-vendor visibility) and the
 * "agent-native team OS" positioning. The brain orb sits at center; vendor
 * particles arrange around it in a circle. Active vendors (those with
 * recent atoms) flow inward toward the brain — tells the user
 * instantly "which AIs are feeding the AGI right now".
 *
 * State machine:
 *   • alive  — brain ticked in last 10 min → green halo, particles drift in
 *   • idle   — brain has ticked at least once but not recently → grey halo
 *   • empty  — brain never fired → dim grey orb, "?" placeholder particles
 *
 * Pure CSS animation. No JS animation loop. The vendor particle positions
 * are computed once at mount via simple trig (8 evenly-spaced angles). The
 * inward-drift animation uses CSS variables `--tx` / `--ty` to set the
 * destination — kept on the host element so each particle has its own
 * trajectory without us writing 8 keyframes.
 */

import { ALL_VENDOR_IDS, type VendorId } from "@/lib/vendor-colors";

export type BrainState = "alive" | "idle" | "empty";

export interface BrainVizHeroProps {
  state: BrainState;
  /** Vendor ids that have produced atoms recently — these particles drift
   *  inward toward the brain. Other vendors render as static dots on the
   *  ring. */
  activeVendors?: string[];
  /** Total atom count today — shown inside the brain orb when alive/idle.
   *  Empty state shows a "?" instead. */
  atomsToday?: number;
}

/**
 * Subset of vendors we render around the brain. We pick 8 so the ring is
 * visually balanced and each particle has room (45° spacing). Order matches
 * `ALL_VENDOR_IDS` priority so the user's primary tools sit at the
 * top-of-ring positions where the eye lands first.
 */
const RING_VENDORS: VendorId[] = ALL_VENDOR_IDS.slice(0, 8);

/** Radius of the particle ring around the 200px brain orb. */
const RING_RADIUS = 160;

export function BrainVizHero({
  state,
  activeVendors = [],
  atomsToday = 0,
}: BrainVizHeroProps) {
  const activeSet = new Set(activeVendors.map((v) => v.toLowerCase()));

  return (
    <div
      className="relative mx-auto flex h-[420px] w-[420px] items-center justify-center"
      data-testid="brain-viz-hero"
      role="img"
      aria-label={`AGI brain — ${state}, ${atomsToday} atoms today`}
    >
      {/* Particle ring sits behind the orb so flowing-inward particles
          appear to disappear into the brain. */}
      <div className="ti-particle-ring" aria-hidden>
        {RING_VENDORS.map((vendor, i) => {
          const angle = (i / RING_VENDORS.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * RING_RADIUS;
          const y = Math.sin(angle) * RING_RADIUS;
          const isActive = activeSet.has(vendor);
          // For the inward-flow animation we point the particle from its
          // ring position back to the center: tx = -x, ty = -y.
          const style: React.CSSProperties = {
            transform: `translate(${x}px, ${y}px)`,
            ["--tx" as string]: `${-x}px`,
            ["--ty" as string]: `${-y}px`,
          };
          return (
            <span
              key={vendor}
              data-vendor={vendor}
              data-active={isActive ? "true" : "false"}
              data-testid={`brain-particle-${vendor}`}
              className="ti-particle"
              style={style}
              title={vendor}
            />
          );
        })}
      </div>

      {/* The brain orb itself. The number inside is hero-scale so /today
          opens with a real visual anchor. */}
      <div
        className="ti-brain-orb"
        data-state={state}
        data-testid="brain-orb"
      >
        {state === "empty" ? "?" : atomsToday}
      </div>
    </div>
  );
}

/**
 * Empty-state variant — used when zero AI tools have been wired up. Shows
 * a halo of grey "?" placeholder dots instead of vendor colors so the
 * user understands "you haven't connected anything yet".
 */
export function BrainVizEmpty() {
  return (
    <div
      className="relative mx-auto flex h-[420px] w-[420px] items-center justify-center"
      data-testid="brain-viz-empty"
    >
      <div className="ti-particle-ring" aria-hidden>
        {RING_VENDORS.map((vendor, i) => {
          const angle = (i / RING_VENDORS.length) * Math.PI * 2 - Math.PI / 2;
          const x = Math.cos(angle) * RING_RADIUS;
          const y = Math.sin(angle) * RING_RADIUS;
          return (
            <span
              key={vendor}
              data-vendor="default"
              className="ti-particle flex items-center justify-center text-[10px] font-semibold text-[var(--ti-ink-400)]"
              style={{
                transform: `translate(${x}px, ${y}px)`,
                background: "var(--ti-paper-200)",
                boxShadow: "none",
                width: 18,
                height: 18,
                marginTop: -9,
                marginLeft: -9,
              }}
            >
              ?
            </span>
          );
        })}
      </div>
      <div className="ti-brain-orb" data-state="empty">
        ?
      </div>
    </div>
  );
}

export default BrainVizHero;
// === end wave 9 ===
