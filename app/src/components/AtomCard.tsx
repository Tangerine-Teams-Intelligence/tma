// === wave 9 ===
/**
 * Wave 9 — AtomCard primitive.
 *
 * The visual translation of design moat #3 (cross-vendor visibility): every
 * atom in the system is rendered as a card with a vendor-colored 4px left
 * border. Strip a screenshot of /memory or /today and the user can scan
 * in one second which AI tools have been writing — "I see lots of Cursor
 * blue and one Claude purple" tells a real story.
 *
 * Where it's consumed:
 *   • /memory list view (lists of atoms)
 *   • /co-thinker "Cited atoms (grounding)" section — confirms which AI
 *     wrote which atom the brain doc references.
 *   • /today recent activity panel — replaces the prior <TimelineEvent />
 *     row in the wave 9 hero composition (TimelineEvent is kept for
 *     /this-week's chronological list which is unchanged).
 *   • Sidebar Active threads — collapsed mini variant.
 *
 * The card is purely presentational. The parent supplies vendor + content;
 * we own the layout, the hover lift, and the border.
 */

import { Link } from "react-router-dom";
import { vendorColor } from "@/lib/vendor-colors";

export interface AtomCardProps {
  /** Vendor id used to look up the accent color (border + label color). */
  vendor: string | null | undefined;
  /** Short headline shown in display serif at the top. */
  title: string;
  /** Body preview — clipped to ~3 lines via line-clamp. */
  body?: string | null;
  /** Source path shown in mono at the bottom-left. e.g. "team/decisions/foo.md". */
  sourcePath?: string | null;
  /** ISO timestamp shown at the top-right as a relative or short label. */
  timestamp?: string | null;
  /** Pre-formatted timestamp label (e.g. "5min" / "2h"). When supplied,
   *  takes precedence over `timestamp` (we don't reformat). */
  timestampLabel?: string | null;
  /** When supplied, the card becomes a <Link/> to that route. Otherwise
   *  it renders as a static <div/>. */
  linkTo?: string | null;
  /** Optional click handler — fires alongside navigation when linkTo is set. */
  onClick?: () => void;
  /** Compact variant — used in the sidebar Active threads mini view.
   *  Drops the body preview + sourcePath and tightens the padding. */
  compact?: boolean;
  /** Optional data-testid for stable test selectors. */
  testId?: string;
  // === wave 14 === — opt-in vendor color border. Default is `false`
  // so /today and /co-thinker show plain neutral cards (vendor as text
  // label only, no color). The /memory detail view passes
  // `showVendorColor` so dev users still get the cross-vendor visual
  // when they explicitly drill into one atom. Wave 9 default behavior
  // is preserved at the call site by passing `showVendorColor`.
  showVendorColor?: boolean;
}

export function AtomCard({
  vendor,
  title,
  body,
  sourcePath,
  timestamp,
  timestampLabel,
  linkTo,
  onClick,
  compact = false,
  testId,
  showVendorColor = false,
}: AtomCardProps) {
  const vc = vendorColor(vendor);
  const dataVendor = normalizeVendorId(vendor);
  // Format timestamp: prefer the pre-formatted label; otherwise show the
  // first 5 chars of an ISO date (HH:MM if it parses; raw fallback otherwise).
  const ts = timestampLabel ?? formatTimestamp(timestamp);

  // === wave 14 === — vendor is shown as a small grey text label only
  // unless `showVendorColor` is true (e.g. /memory detail view). The
  // border-l color and the text accent color both gate on this flag.
  const vendorLabelClass = showVendorColor
    ? "ti-vendor-text font-mono text-[10px] uppercase tracking-wider"
    : "font-mono text-[10px] uppercase tracking-wider text-[var(--ti-ink-500)]";

  const inner = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span
          className={vendorLabelClass}
          aria-label={`Vendor: ${vc.label}`}
        >
          {/* === wave 14 === — show "from <Vendor>" so the relationship
              reads as user-language not data-vendor jargon. */}
          {showVendorColor ? vc.label : `from ${vc.label}`}
        </span>
        {ts && (
          <span className="font-mono text-[10px] tabular-nums text-[var(--ti-ink-500)]">
            {ts}
          </span>
        )}
      </div>
      <h4
        className="mt-1 truncate font-display text-[18px] leading-tight tracking-tight text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
        title={title}
      >
        {title}
      </h4>
      {!compact && body && (
        <p
          className="mt-1.5 overflow-hidden text-[12px] leading-relaxed text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-600)]"
          style={{
            display: "-webkit-box",
            WebkitLineClamp: 3,
            WebkitBoxOrient: "vertical",
          }}
        >
          {truncate(body, 240)}
        </p>
      )}
      {!compact && sourcePath && (
        <p
          className="mt-2 truncate font-mono text-[10px] text-[var(--ti-ink-500)]"
          title={sourcePath}
        >
          {sourcePath}
        </p>
      )}
    </>
  );

  // Padding tightens for the compact variant so the sidebar mini-card
  // fits within the 240px rail without truncating the title aggressively.
  const padding = compact ? "px-2.5 py-1.5" : "px-3.5 py-2.5";
  // === wave 14 === — vendor border-l only renders when opt-in. Default
  // is a normal full border for visual containment.
  const borderClass = showVendorColor
    ? "ti-vendor-border-l rounded-r-md border border-l-0 border-stone-200 dark:border-stone-800"
    : "rounded-md border border-stone-200 dark:border-stone-800";
  const className = `ti-atom-card ${borderClass} block bg-white/80 ${padding} dark:bg-stone-900/60`;

  const wrapperProps = {
    "data-vendor": dataVendor,
    "data-testid": testId ?? "atom-card",
    "data-vendor-id": vendor ?? "",
    className,
  } as const;

  if (linkTo) {
    return (
      <Link to={linkTo} onClick={onClick} {...wrapperProps}>
        {inner}
      </Link>
    );
  }
  return (
    <div onClick={onClick} {...wrapperProps}>
      {inner}
    </div>
  );
}

/**
 * Normalize a vendor id for the data-vendor attribute selector. The CSS
 * defines `[data-vendor="cursor"]` etc. — we lowercase + swap underscores
 * + spaces for hyphens so "Claude Code" / "claude_code" both resolve to
 * the canonical "claude-code" key. Unknown values fall back to "default".
 */
function normalizeVendorId(id: string | null | undefined): string {
  if (!id) return "default";
  const norm = id.toLowerCase().replace(/[_\s.]/g, "-");
  // Mirror the lookup tier in vendor-colors.ts so we don't return a key
  // that has no CSS rule.
  const known = [
    "cursor",
    "claude-code",
    "claude-ai",
    "codex",
    "windsurf",
    "chatgpt",
    "gemini",
    "copilot",
    "v0",
    "ollama",
    "devin",
    "replit",
    "ms-copilot",
    "apple-intelligence",
  ];
  if (known.includes(norm)) return norm;
  if (norm === "github-copilot") return "copilot";
  return "default";
}

/** Compress overlong body strings before line-clamp kicks in. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}

/**
 * Format an ISO timestamp for the top-right label. Returns HH:MM in the
 * user's local time when parseable; passes the raw string through
 * otherwise. Null / undefined → null (caller hides the label).
 */
function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export default AtomCard;
// === end wave 9 ===
