// === wave 9 ===
/**
 * Wave 9 — Vendor color system.
 *
 * Each AI vendor (Cursor, Claude, ChatGPT, ...) gets a brand-derived accent
 * color. Per the v1.9.4 positioning brief, we want EVERY surface that shows
 * cross-vendor data (sidebar / atom cards / heartbeat ribbon / today
 * particles) to render the vendor's color so the user can scan a wall of
 * data and know which AI did what at a glance. Without this, the app reads
 * as mono-vendor — fatal positioning failure for "agent-native team OS".
 *
 * The colors were picked with two constraints:
 *   1. Loosely match the vendor's own brand mark so the user doesn't have
 *      to learn a Tangerine-internal mapping. Cursor blue, Claude purple,
 *      ChatGPT green, Codex amber, Windsurf cyan, etc.
 *   2. Stay legible at 1.5px dot size (sidebar status dots) and 4px border
 *      strip width (atom card left border). That rules out pastels and
 *      forces some saturation.
 *
 * Vendor ids match `app/src/lib/ai-tools.ts::AI_TOOL_PRIORITY`.
 */

export interface VendorColor {
  /** Solid hex (or gradient string for Apple Intelligence). */
  hex: string;
  /** Human-facing label used in tooltips + ribbon copy. */
  label: string;
  /**
   * Background tint expressed as the same color at 8% opacity. Pre-baked
   * so call sites don't have to color-mix. Format is plain CSS rgba string
   * for direct use in inline style. For the gradient vendor (Apple
   * Intelligence) bgTint is "transparent" — gradients don't tint nicely.
   */
  bgTint: string;
}

/**
 * Color registry. Keys are stable vendor ids; do not rename without also
 * updating `lib/ai-tools.ts::AI_TOOL_PRIORITY` and the `ti-vendor-dot`
 * data-vendor selectors in `index.css`.
 */
export const VENDOR_COLORS = {
  "claude-code": {
    hex: "#5C2DC8",
    label: "Claude Code",
    bgTint: "rgba(92, 45, 200, 0.08)",
  },
  "claude-ai": {
    hex: "#5C2DC8",
    label: "Claude.ai",
    bgTint: "rgba(92, 45, 200, 0.08)",
  },
  cursor: {
    hex: "#00A8E8",
    label: "Cursor",
    bgTint: "rgba(0, 168, 232, 0.08)",
  },
  codex: {
    hex: "#F59E0B",
    label: "Codex",
    bgTint: "rgba(245, 158, 11, 0.08)",
  },
  windsurf: {
    hex: "#06B6D4",
    label: "Windsurf",
    bgTint: "rgba(6, 182, 212, 0.08)",
  },
  chatgpt: {
    hex: "#10A37F",
    label: "ChatGPT",
    bgTint: "rgba(16, 163, 127, 0.08)",
  },
  gemini: {
    hex: "#4285F4",
    label: "Gemini",
    bgTint: "rgba(66, 133, 244, 0.08)",
  },
  copilot: {
    hex: "#6E6E6E",
    label: "GitHub Copilot",
    bgTint: "rgba(110, 110, 110, 0.08)",
  },
  v0: {
    hex: "#000000",
    label: "v0",
    bgTint: "rgba(0, 0, 0, 0.08)",
  },
  ollama: {
    hex: "#000000",
    label: "Ollama",
    bgTint: "rgba(0, 0, 0, 0.08)",
  },
  devin: {
    hex: "#06B6D4",
    label: "Devin",
    bgTint: "rgba(6, 182, 212, 0.08)",
  },
  replit: {
    hex: "#FF7E1B",
    label: "Replit",
    bgTint: "rgba(255, 126, 27, 0.08)",
  },
  "apple-intelligence": {
    hex: "linear-gradient(135deg,#FF6B6B,#4ECDC4,#FFD93D)",
    label: "Apple Intelligence",
    bgTint: "transparent",
  },
  "ms-copilot": {
    hex: "#0078D4",
    label: "MS Copilot",
    bgTint: "rgba(0, 120, 212, 0.08)",
  },
} as const;

export type VendorId = keyof typeof VENDOR_COLORS;

/**
 * Default fallback color for an unknown vendor id. Returns a neutral grey
 * so the call site never crashes when the catalog hasn't seen this vendor
 * yet (e.g. a future MCP client we don't have a brand color for). Same
 * shape as VendorColor.
 */
const DEFAULT_VENDOR_COLOR: VendorColor = {
  hex: "#78716C", // ti-ink-500
  label: "Unknown",
  bgTint: "rgba(120, 113, 108, 0.08)",
};

/**
 * Look up a vendor's color. Accepts both the canonical id forms used in
 * `ai-tools.ts` ("claude-code") AND the underscore variants used by the
 * Rust active-agents handler ("Claude Code", "claude_code"). Falls through
 * to a neutral grey when nothing matches so call sites stay branchless.
 */
export function vendorColor(id: string | null | undefined): VendorColor {
  if (!id) return DEFAULT_VENDOR_COLOR;
  // Direct hit on the canonical key.
  const direct = (VENDOR_COLORS as Record<string, VendorColor>)[id];
  if (direct) return direct;
  // Normalize: lowercase, swap underscores + spaces for hyphens, strip dots.
  const norm = id.toLowerCase().replace(/[_\s.]/g, "-");
  const fuzzy = (VENDOR_COLORS as Record<string, VendorColor>)[norm];
  if (fuzzy) return fuzzy;
  // Common renames from the Rust agent stub ("Cursor" -> "cursor",
  // "Claude Code" -> "claude-code"). Already covered by `norm`; this
  // branch handles the few vendor names that include extra punctuation
  // (e.g. "github-copilot" -> "copilot").
  if (norm === "github-copilot") return VENDOR_COLORS.copilot;
  return DEFAULT_VENDOR_COLOR;
}

/**
 * Convenience: list of all vendor ids in priority order. Mirrors the
 * order in `ai-tools.ts::AI_TOOL_PRIORITY` so the welcome card visualizer
 * + empty-state vendor row both render in the same canonical sequence.
 */
export const ALL_VENDOR_IDS: VendorId[] = [
  "cursor",
  "claude-code",
  "codex",
  "windsurf",
  "claude-ai",
  "chatgpt",
  "gemini",
  "copilot",
  "v0",
  "ollama",
  "devin",
  "replit",
  "apple-intelligence",
  "ms-copilot",
];
// === end wave 9 ===
