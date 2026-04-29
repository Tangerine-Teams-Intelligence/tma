/**
 * v1.16 Wave 2 — vendor color dot mapping (single source of truth).
 *
 * 4 IDE tools (cursor / claude-code / codex / windsurf) share `stone-700`
 * because the user thinks of them as "AI assistants" not as 4 distinct
 * vendors. Slack / Email / GitHub get distinct colors so the user can
 * scan the feed visually for "who said it" with 1-bit perception.
 *
 * The hex values are tailwind v3 stone-700, emerald-500, stone-400,
 * violet-500 — kept as raw strings so the dot can render outside a
 * Tailwind context (e.g. inside a virtualized cell where utility
 * classes might be purged).
 */

export type VendorKey =
  | "cursor"
  | "claude-code"
  | "codex"
  | "windsurf"
  | "slack"
  | "email"
  | "github"
  | "discord"
  | "lark"
  | "zoom"
  | "teams"
  | "calendar"
  | "linear"
  | "notion"
  | "loom"
  | "unknown";

interface VendorMeta {
  /** Hex color for the dot. Avoid Tailwind utility classes so this works
   *  inside virtualized cells where purging can be aggressive. */
  color: string;
  /** Display name shown next to the actor on a card. */
  display: string;
}

const TABLE: Record<VendorKey, VendorMeta> = {
  // 4 IDE tools — same color (user perception: "AI assistant")
  "cursor": { color: "#44403c", display: "Cursor" },
  "claude-code": { color: "#44403c", display: "Claude Code" },
  "codex": { color: "#44403c", display: "Codex" },
  "windsurf": { color: "#44403c", display: "Windsurf" },
  // External comm
  "slack": { color: "#10b981", display: "Slack" },
  "email": { color: "#a8a29e", display: "Email" },
  "github": { color: "#8b5cf6", display: "GitHub" },
  "discord": { color: "#5865f2", display: "Discord" },
  "lark": { color: "#10b981", display: "Lark" },
  "zoom": { color: "#2d8cff", display: "Zoom" },
  "teams": { color: "#5b5fc7", display: "Teams" },
  "calendar": { color: "#a8a29e", display: "Calendar" },
  "linear": { color: "#5e6ad2", display: "Linear" },
  "notion": { color: "#a8a29e", display: "Notion" },
  "loom": { color: "#a8a29e", display: "Loom" },
  "unknown": { color: "#a8a29e", display: "—" },
};

/**
 * Look up vendor metadata by source string. Falls back to "unknown"
 * (gray dot) so an unrecognized source never crashes the feed render.
 */
export function vendorFor(source: string | null | undefined): VendorMeta {
  if (!source) return TABLE.unknown;
  const key = source.trim().toLowerCase() as VendorKey;
  return TABLE[key] ?? TABLE.unknown;
}
