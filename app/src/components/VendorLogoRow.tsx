// === wave 9 ===
/**
 * Wave 9 — Cross-vendor empty-state vendor logo row.
 *
 * When a route that's about cross-vendor data has no atoms yet (e.g.
 * /memory empty, /today empty), instead of a generic "no atoms" message
 * we show a row of vendor logos. Each logo is grey + 0.45 opacity until
 * its vendor parser finds atoms — then it "wakes up" (transitions to
 * full color over 600ms) via the `data-awake="true"` attribute.
 *
 * The story this tells: "your AI tools will populate this — here's the
 * list of which ones we watch". Beats a static "connect a source" CTA.
 */

import { Link } from "react-router-dom";
import { vendorColor, ALL_VENDOR_IDS, type VendorId } from "@/lib/vendor-colors";

export interface VendorLogoRowProps {
  /** Vendor ids that have synced at least one atom. These render in full
   *  color; the rest stay grey. */
  awakeVendors?: string[];
  /** Optional vendor subset to render. Defaults to a curated 8-tool ring. */
  vendors?: VendorId[];
  /** Click target for each logo. Defaults to /ai-tools/{id}. */
  toLink?: (vendor: VendorId) => string;
}

const DEFAULT_VENDORS: VendorId[] = [
  "cursor",
  "claude-code",
  "chatgpt",
  "codex",
  "windsurf",
  "claude-ai",
  "gemini",
  "ollama",
];

export function VendorLogoRow({
  awakeVendors = [],
  vendors = DEFAULT_VENDORS,
  toLink = (v) => `/ai-tools/${v}`,
}: VendorLogoRowProps) {
  const awakeSet = new Set(awakeVendors.map((v) => v.toLowerCase()));
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2"
      data-testid="vendor-logo-row"
    >
      {vendors.map((v) => {
        const vc = vendorColor(v);
        const isAwake = awakeSet.has(v);
        // Single-letter "logo" derived from vendor label first char so we
        // don't have to bundle 14 brand SVGs. The vendor color tinted
        // background does the heavy lifting visually.
        const initial = vc.label.replace(/^Claude\.?/i, "C")[0] ?? "?";
        return (
          <Link
            key={v}
            to={toLink(v)}
            className="ti-vendor-logo"
            data-vendor={v}
            data-awake={isAwake ? "true" : "false"}
            data-testid={`vendor-logo-${v}`}
            title={isAwake ? `${vc.label} — synced` : `${vc.label} — not yet`}
            aria-label={`${vc.label}${isAwake ? " — synced" : " — not yet"}`}
          >
            {initial}
          </Link>
        );
      })}
    </div>
  );
}

export default VendorLogoRow;
// === end wave 9 ===
