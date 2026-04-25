/**
 * The 10 tools that make up Tangerine AI Teams.
 *
 * One tool ships in v1.5 (Meeting). The rest are scheduled for v1.6+ but are
 * still always present in the sidebar — clicking them opens a "Coming v1.x"
 * detail page, never a blocked / locked card.
 */

import {
  Mic,
  BookOpen,
  Activity,
  ClipboardCheck,
  CalendarDays,
  Video,
  Users,
  PhoneCall,
  ListChecks,
  MessageSquare,
} from "lucide-react";

export type ToolId =
  | "meeting"
  | "wiki"
  | "track"
  | "review"
  | "schedule"
  | "loom"
  | "hire"
  | "voice"
  | "survey"
  | "chat";

export interface ToolDef {
  id: ToolId;
  title: string;
  blurb: string;
  /** Short one-line description used on the home grid. */
  shortBlurb: string;
  /** Long-form description used on each Coming-soon detail page. */
  longBlurb: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** undefined = shipping now. */
  comingIn?: string;
  path: string;
}

export const TOOLS: ToolDef[] = [
  {
    id: "meeting",
    title: "Meeting",
    blurb: "Live transcription, Discord bot, Claude review.",
    shortBlurb: "Live transcripts, decisions, follow-ups.",
    longBlurb:
      "Capture team meetings via a Discord bot, transcribe with local Whisper, and let Claude turn the transcript into decisions, action items, and a per-person follow-up.",
    icon: Mic,
    path: "/meeting",
  },
  {
    id: "wiki",
    title: "Wiki",
    blurb: "Auto-built team knowledge base from your meetings + repos.",
    shortBlurb: "Knowledge base built from your meetings + repos.",
    longBlurb:
      "An always-fresh team wiki, written by Claude from your meeting transcripts, decisions, and code. No more stale Notion pages no one updates.",
    icon: BookOpen,
    comingIn: "v1.6",
    path: "/wiki",
  },
  {
    id: "track",
    title: "Track",
    blurb: "Goal + KPI tracker that watches outcomes, not check-ins.",
    shortBlurb: "Goals + KPIs, watched continuously.",
    longBlurb:
      "Set a goal, hook up the data source, and Track watches it. No standups, no manual updates — just the metric and what changed since last week.",
    icon: Activity,
    comingIn: "v1.6",
    path: "/track",
  },
  {
    id: "review",
    title: "Review",
    blurb: "Code + decision review threads with retained context.",
    shortBlurb: "Threaded review with retained context.",
    longBlurb:
      "Code reviews and decision reviews live as threads inside Tangerine, with full prior context loaded automatically. Replaces the GitHub-PR / Slack-thread split.",
    icon: ClipboardCheck,
    comingIn: "v1.6",
    path: "/review",
  },
  {
    id: "schedule",
    title: "Schedule",
    blurb: "Calendar agent that picks meeting times humans hate picking.",
    shortBlurb: "Calendar agent that picks the meeting time.",
    longBlurb:
      "Drop in a list of attendees and a duration. Schedule reads everyone's calendar, picks the time, and books it. Replaces Cal.com / Calendly.",
    icon: CalendarDays,
    comingIn: "v1.7",
    path: "/schedule",
  },
  {
    id: "loom",
    title: "Loom",
    blurb: "Async video memos with auto-transcript + summary.",
    shortBlurb: "Async video memos, auto-transcribed.",
    longBlurb:
      "Record a screen + voice memo, get an instant transcript, summary, and chapter list. Searchable by anyone on the team, owned by your team — not a SaaS.",
    icon: Video,
    comingIn: "v1.7",
    path: "/loom",
  },
  {
    id: "hire",
    title: "Hire",
    blurb: "Candidate pipeline + structured interview notes.",
    shortBlurb: "Pipeline + structured interview notes.",
    longBlurb:
      "Track candidates from intro to offer, with interview notes that auto-fill from Meeting transcripts. Replaces a lightweight ATS.",
    icon: Users,
    comingIn: "v1.8",
    path: "/hire",
  },
  {
    id: "voice",
    title: "Voice",
    blurb: "Voice-only standups for distributed teams.",
    shortBlurb: "Voice-only async standups.",
    longBlurb:
      "Each teammate records a 60-second voice standup whenever they want. Voice transcribes, summarizes, and surfaces blockers. No daily 9am video grind.",
    icon: PhoneCall,
    comingIn: "v1.8",
    path: "/voice",
  },
  {
    id: "survey",
    title: "Survey",
    blurb: "Pulse surveys that summarise themselves into action items.",
    shortBlurb: "Pulse surveys that turn into actions.",
    longBlurb:
      "Run pulse surveys, customer-research surveys, or post-meeting feedback. Claude reads every response and writes the summary + action items for you.",
    icon: ListChecks,
    comingIn: "v1.9",
    path: "/survey",
  },
  {
    id: "chat",
    title: "Chat",
    blurb: "Internal Q&A bot grounded in your team's own data.",
    shortBlurb: "Q&A bot grounded in your team's data.",
    longBlurb:
      "A chat bot every teammate can ask: what did we decide about X? Who owns Y? Grounded in your meetings, wiki, and code — not the public internet.",
    icon: MessageSquare,
    comingIn: "v1.9",
    path: "/chat",
  },
];

export function findTool(id: ToolId): ToolDef {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tool id: ${id}`);
  return t;
}
