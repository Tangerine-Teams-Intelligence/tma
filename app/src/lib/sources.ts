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
    produces: "memory/projects/*.md",
    blurb: "Mirrors your project pages as markdown.",
    longBlurb:
      "Watches the Notion pages you authorize and mirrors them as markdown into your memory dir. Subsequent edits in Notion show up as diffs in /inbox before the memory file updates.",
    icon: FileText,
    status: "coming",
    comingIn: "v1.8",
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
    produces: "memory/threads/loom-*.md",
    blurb: "Auto-transcribes shared video memos.",
    longBlurb:
      "When a teammate shares a Loom in a connected channel, Tangerine pulls the transcript and stores a memory entry alongside the link.",
    icon: Video,
    status: "coming",
    comingIn: "v1.9",
  },
  {
    id: "zoom",
    title: "Zoom",
    produces: "memory/meetings/*.md",
    blurb: "Pulls Zoom cloud recording transcripts.",
    longBlurb:
      "Same shape as Discord but for Zoom — Tangerine reads cloud-recording transcripts and writes a meeting memory file per call.",
    icon: MessageSquare,
    status: "coming",
    comingIn: "v1.9",
  },
  {
    id: "email",
    title: "Email",
    produces: "memory/threads/email-*.md",
    blurb: "Reads team mailboxes; surfaces decisions and threads.",
    longBlurb:
      "Connects via OAuth (Gmail / Outlook). Threads with decisions, action items, or external commitments become memory entries. Tangerine never sends mail — read-only.",
    icon: Mail,
    status: "coming",
    comingIn: "v1.8",
  },
  {
    id: "voice-notes",
    title: "Voice notes",
    produces: "memory/threads/voice-*.md",
    blurb: "Drop a voice note, get a transcribed memory entry.",
    longBlurb:
      "Record a voice note from your phone or desktop and Tangerine transcribes it via local Whisper, attaches it to the relevant thread, and writes a memory entry. Useful for capturing ideas between meetings without typing.",
    icon: Mic,
    status: "coming",
    comingIn: "v1.8",
  },
];

export function findSource(id: SourceId): SourceDef {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`Unknown source id: ${id}`);
  return s;
}
