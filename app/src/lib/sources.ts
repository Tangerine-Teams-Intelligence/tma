/**
 * Source registry — every place Tangerine reads team work from.
 *
 * One source = one connector. Connectors push events into the user's memory
 * dir as markdown files (frontmatter + body). Tangerine never holds the data
 * itself — the data lives in the user's repo.
 *
 * === wave 7 ===
 * v1.9.3 honesty pass: `status` is the static catalog verdict — does the
 * connector code path ship in this build? `"shipped"` means the setup page
 * is real (config persists, capture/writeback runs); `"beta"` means the
 * page exists but the underlying ingestion isn't fully validated;
 * `"coming"` means the page is a placeholder with a Coming-v1.X badge.
 *
 * The sidebar status chip shows "已连/Connected" ONLY when the user has
 * actually configured the source on this machine — that's a runtime check
 * (e.g. `notionGetConfig().token_present`) done by the sidebar, not a
 * static field here. We removed `"active"` from this file because it was
 * being interpreted as "connected" when it really meant "shipped." See
 * SourceStatus and the sidebar's StatusChip for the runtime truth.
 */

import {
  MessageSquare,
  GitBranch,
  Hash,
  FileText,
  CalendarDays,
  Github,
  Video,
  Disc,
  Mail,
  Mic,
  Globe,
} from "lucide-react";

export type SourceId =
  | "discord"
  | "slack"
  | "github"
  | "linear"
  | "notion"
  | "cal"
  | "loom"
  | "zoom"
  | "email"
  | "voice-notes"
  | "external";

// === wave 7 ===
// v1.9.3 honesty pass: split static "what ships" from runtime "is it
// connected." Sidebar uses both: catalog status to decide which colour to
// pre-render, runtime check to flip to green only when real config exists.
//   "shipped"   — connector setup page is real + persists config
//   "beta"      — surface exists but capture/writeback is unvalidated
//   "coming"    — placeholder; renders Coming-v1.X badge
export type SourceStatus = "shipped" | "beta" | "coming";

/**
 * Runtime connection state for the sidebar chip. Computed by the Sidebar
 * component from per-source Tauri probes (notionGetConfig.token_present,
 * loomGetConfig.token_present, etc). Falls back to "unknown" when no probe
 * has run yet, which renders as a quiet grey dot rather than "Connected."
 */
export type SourceConnState = "connected" | "not_configured" | "unknown";
// === end wave 7 ===

export interface SourceDef {
  id: SourceId;
  title: string;
  /** What the source produces in your memory dir. */
  produces: string;
  /** One-liner shown in the sidebar tooltip and the source detail page. */
  blurb: string;
  /** Long-form description for the source detail page. */
  longBlurb: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  status: SourceStatus;
  /** undefined = shipping now. */
  comingIn?: string;
  /**
   * Route to dispatch to when the user clicks this source in the sidebar.
   * Defaults to `/sources/<id>` (handled by source-detail.tsx). Set
   * explicitly when a source ships before the others in the same batch
   * and needs a different path (e.g. /sources/voice-notes vs the legacy
   * /sources/voice).
   */
  routePath?: string;
}

/**
 * Render order in the sidebar — chosen to put the most-used team comm
 * surfaces (Discord / Slack / GitHub) on top, project-tracking next
 * (Linear / Notion / Calendar), and asynchronous capture sources last
 * (Loom / Zoom / Email / Voice notes).
 */
// === wave 7 ===
// v1.9.3 honesty pass:
//   - Removed all `"active"` (was misread as "connected"). Replaced with
//     `"shipped"` (real setup page + config persistence) or `"beta"`
//     (page exists, ingestion not fully validated end-to-end).
//   - Updated `comingIn` markers to the v1.10/v1.11 horizon — the old
//     v1.6/v1.7/v1.8 markers were planning tags from when v1.5 was
//     current, and now look like "shipped in v1.6" instead of "scheduled."
//   - The sidebar layers a runtime "connected/not configured" check on
//     top of this catalog (see Sidebar.tsx StatusChip).
export const SOURCES: SourceDef[] = [
  {
    id: "discord",
    title: "Discord",
    produces: "memory/meetings/*.md",
    blurb: "Bot joins voice, transcribes, writes a meeting file per call.",
    longBlurb:
      "Tangerine's Discord bot joins your team's voice channels, captures audio, transcribes via local Whisper (or OpenAI as opt-in), and writes a memory file per meeting with decisions, action items, and per-person follow-ups. The bot reads only — it never sends a message back to the channel.",
    icon: Disc,
    status: "shipped",
  },
  {
    id: "slack",
    title: "Slack",
    produces: "memory/threads/slack-*.md",
    blurb: "Writeback config; capture pending.",
    longBlurb:
      "Capture (workspace OAuth + channel pick) is not yet wired in the desktop app — the v1.9.x build only ships writeback (post a pre-meeting brief, post a decision summary). To hydrate Slack threads into memory you currently need to run `tangerine-slack auth set` from the CLI. Full in-app capture lands in v1.10.",
    icon: Hash,
    status: "beta",
    comingIn: "v1.10",
  },
  {
    id: "github",
    title: "GitHub",
    produces: "memory/threads/pr-*.md, memory/decisions/*.md",
    blurb: "Writeback; capture is CLI-only.",
    longBlurb:
      "v1.9.x writeback (decision atoms post back to a designated repo) is wired and persists to ~/.tmi/config.yaml. Capture (PR thread → atom) still runs out of the `sources/github/` Node package — the in-app capture page lands in v1.10. Read + writeback default OFF.",
    icon: Github,
    status: "beta",
    comingIn: "v1.10",
  },
  {
    id: "linear",
    title: "Linear",
    produces: "memory/threads/linear-*.md, memory/decisions/*.md",
    blurb: "Writeback; capture is CLI-only.",
    longBlurb:
      "Same shape as GitHub: writeback (decisions → Linear comments) is wired in v1.9.x; capture runs from the `sources/linear/` Node package. Full in-app OAuth + issue selector lands in v1.10.",
    icon: GitBranch,
    status: "beta",
    comingIn: "v1.10",
  },
  {
    id: "notion",
    title: "Notion",
    produces: "memory/projects/{project}/notion/*.md",
    blurb: "Mirrors your databases as markdown; writes back decisions.",
    longBlurb:
      "Walks the Notion databases you authorize each heartbeat, writes one markdown atom per page (with frontmatter for source / page id / db id / last_edited_time), and mirrors decisions back into a designated decisions database when writeback is enabled. Read + write are both off by default — toggle them in the source settings.",
    icon: FileText,
    status: "shipped",
  },
  {
    id: "cal",
    title: "Calendar",
    produces: "memory/threads/cal-*.md",
    blurb: "Writeback shipped; capture is CLI-only.",
    longBlurb:
      "Writeback (append meeting summary to the calendar event description) is wired and persists to ~/.tmi/config.yaml. Capture (event → atom) runs from `sources/calendar/`. In-app OAuth + calendar selector lands in v1.10.",
    icon: CalendarDays,
    status: "beta",
    comingIn: "v1.10",
  },
  {
    id: "loom",
    title: "Loom",
    produces: "memory/threads/loom/*.md",
    blurb: "Pulls workspace transcripts; one atom per video.",
    longBlurb:
      "Walks the Loom workspace videos you authorize and writes one markdown atom per video with the transcript inline. Optional folder filters; manual transcript pull from any Loom share URL.",
    icon: Video,
    status: "shipped",
  },
  {
    id: "zoom",
    title: "Zoom",
    produces: "memory/meetings/zoom-*.md",
    blurb: "Pulls Zoom cloud recording transcripts.",
    longBlurb:
      "Replacement capture path for users without Discord. Server-to-Server OAuth pulls cloud recordings + auto-generated transcripts and writes one meeting atom per call. Configurable lookback window (default 7 days).",
    icon: MessageSquare,
    status: "shipped",
  },
  {
    id: "email",
    title: "Email",
    produces: "memory/threads/email/*.md",
    blurb: "IMAP digest — daily fetch, threaded into memory.",
    longBlurb:
      "Connect Gmail or Outlook (or any IMAP provider) with an app password. Tangerine fetches recent threads daily, groups by subject + reply chain, and writes one digest atom per thread to memory/threads/email/. Read-only — Tangerine never sends mail.",
    icon: Mail,
    status: "shipped",
    routePath: "/sources/email/setup",
  },
  {
    id: "voice-notes",
    title: "Voice notes",
    produces: "memory/threads/voice/*.md",
    blurb: "Record a voice note, transcribed via local Whisper.",
    longBlurb:
      "Click record in the Tangerine desktop app, talk, click stop. The audio runs through the bundled Whisper model (the same one Discord meetings use) and lands as a markdown atom under memory/threads/voice/. Audio never leaves your machine.",
    icon: Mic,
    status: "shipped",
    routePath: "/sources/voice-notes/setup",
  },
  {
    id: "external",
    title: "External world",
    produces: "memory/personal/<you>/threads/external/*.md",
    blurb: "RSS, podcasts, YouTube, and articles — read once, capture forever.",
    longBlurb:
      "Subscribe to RSS feeds and podcasts, paste any YouTube URL, save any article. Every capture lands as a markdown atom under personal/<you>/threads/external/. Personal vault — never synced to the team.",
    icon: Globe,
    status: "shipped",
    routePath: "/sources/external",
  },
];
// === end wave 7 ===

export function findSource(id: SourceId): SourceDef {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown source id: ${id}`);
  return s;
}
