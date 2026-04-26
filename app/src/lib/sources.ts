/**
 * Source registry — every place Tangerine reads team work from.
 *
 * v1.5 ships Discord only. The other rows are visible in the sidebar but
 * land on a "Coming v1.x" page.
 *
 * One source = one connector. Connectors push events into the user's memory
 * dir as markdown files (frontmatter + body). Tangerine never holds the data
 * itself — the data lives in the user's repo.
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
  | "voice-notes";

export type SourceStatus = "active" | "coming" | "disconnected";

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
export const SOURCES: SourceDef[] = [
  {
    id: "discord",
    title: "Discord",
    produces: "memory/meetings/*.md",
    blurb: "Bot joins voice, transcribes, writes a meeting file per call.",
    longBlurb:
      "Tangerine's Discord bot joins your team's voice channels, captures audio, transcribes via local Whisper (or OpenAI as opt-in), and writes a memory file per meeting with decisions, action items, and per-person follow-ups. The bot reads only — it never sends a message back to the channel.",
    icon: Disc,
    status: "active",
  },
  {
    id: "slack",
    title: "Slack",
    produces: "memory/threads/slack-*.md",
    blurb: "Reads team channels, surfaces decisions and questions.",
    longBlurb:
      "Indexes the channels you authorize. Long threads collapse into a memory file with the decision (if any) at the top and the original message links underneath. Read-only — Tangerine never posts to your Slack.",
    icon: Hash,
    status: "coming",
    comingIn: "v1.8",
  },
  {
    id: "github",
    title: "GitHub",
    produces: "memory/threads/pr-*.md, memory/decisions/*.md",
    blurb: "Pulls PR threads, review decisions, commit log.",
    longBlurb:
      "Watches the repos you authorize. PR threads, review comments, and merge decisions become memory. The commit message + files-changed summary feeds your AI tools so they know what shipped without you re-explaining.",
    icon: Github,
    status: "coming",
    comingIn: "v1.6",
  },
  {
    id: "linear",
    title: "Linear",
    produces: "memory/threads/linear-*.md, memory/decisions/*.md",
    blurb: "Pulls issues, comments, and project state into memory.",
    longBlurb:
      "When connected, every Linear issue + comment + status change becomes part of your team's memory. Decisions in issue threads are extracted as decision records. Read-only in v1.6 — write-back (Tangerine commenting on issues) is gated behind /inbox approval in v1.7.",
    icon: GitBranch,
    status: "coming",
    comingIn: "v1.6",
  },
  {
    id: "notion",
    title: "Notion",
    produces: "memory/projects/{project}/notion/*.md",
    blurb: "Mirrors your databases as markdown; writes back decisions.",
    longBlurb:
      "Walks the Notion databases you authorize each heartbeat, writes one markdown atom per page (with frontmatter for source / page id / db id / last_edited_time), and mirrors decisions back into a designated decisions database when writeback is enabled. Read + write are both off by default — toggle them in the source settings.",
    icon: FileText,
    status: "active",
  },
  {
    id: "cal",
    title: "Calendar",
    produces: "memory/threads/cal-*.md",
    blurb: "Records meetings + attendees, links to transcripts.",
    longBlurb:
      "Reads your team's Google / Outlook calendars (read-only). Each event becomes a memory entry; if Discord captured the audio, the entry links to the transcript file.",
    icon: CalendarDays,
    status: "coming",
    comingIn: "v1.7",
  },
  {
    id: "loom",
    title: "Loom",
    produces: "memory/threads/loom/*.md",
    blurb: "Pulls workspace transcripts; one atom per video.",
    longBlurb:
      "Walks the Loom workspace videos you authorize and writes one markdown atom per video with the transcript inline. Optional folder filters; manual transcript pull from any Loom share URL.",
    icon: Video,
    status: "active",
  },
  {
    id: "zoom",
    title: "Zoom",
    produces: "memory/meetings/zoom-*.md",
    blurb: "Pulls Zoom cloud recording transcripts.",
    longBlurb:
      "Replacement capture path for users without Discord. Server-to-Server OAuth pulls cloud recordings + auto-generated transcripts and writes one meeting atom per call. Configurable lookback window (default 7 days).",
    icon: MessageSquare,
    status: "active",
  },
  {
    id: "email",
    title: "Email",
    produces: "memory/threads/email/*.md",
    blurb: "IMAP digest — daily fetch, threaded into memory.",
    longBlurb:
      "Connect Gmail or Outlook (or any IMAP provider) with an app password. Tangerine fetches recent threads daily, groups by subject + reply chain, and writes one digest atom per thread to memory/threads/email/. Read-only — Tangerine never sends mail.",
    icon: Mail,
    status: "active",
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
    status: "active",
    routePath: "/sources/voice-notes/setup",
  },
];

export function findSource(id: SourceId): SourceDef {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown source id: ${id}`);
  return s;
}
