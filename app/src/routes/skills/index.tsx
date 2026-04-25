import { Link, useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Lock,
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useStore, isSkillInstalled, type SkillId } from "@/lib/store";
import { cn } from "@/lib/utils";

interface SkillDef {
  id: SkillId;
  title: string;
  blurb: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  /** undefined = shipping now. */
  comingIn?: string;
}

const SKILLS: SkillDef[] = [
  {
    id: "meeting",
    title: "Meeting",
    blurb: "Live transcription, Discord bot, Claude review.",
    icon: Mic,
  },
  {
    id: "wiki",
    title: "Wiki",
    blurb: "Auto-built team knowledge base from your meetings + repos.",
    icon: BookOpen,
    comingIn: "v1.6",
  },
  {
    id: "track",
    title: "Track",
    blurb: "Goal + KPI tracker that watches outcomes, not check-ins.",
    icon: Activity,
    comingIn: "v1.6",
  },
  {
    id: "review",
    title: "Review",
    blurb: "Code + decision review threads with retained context.",
    icon: ClipboardCheck,
    comingIn: "v1.6",
  },
  {
    id: "schedule",
    title: "Schedule",
    blurb: "Calendar agent that picks meeting times humans hate picking.",
    icon: CalendarDays,
    comingIn: "v1.7",
  },
  {
    id: "loom",
    title: "Loom",
    blurb: "Async video memos with auto-transcript + summary.",
    icon: Video,
    comingIn: "v1.7",
  },
  {
    id: "hire",
    title: "Hire",
    blurb: "Candidate pipeline + structured interview notes.",
    icon: Users,
    comingIn: "v1.8",
  },
  {
    id: "voice",
    title: "Voice",
    blurb: "Voice-only standups for distributed teams.",
    icon: PhoneCall,
    comingIn: "v1.8",
  },
  {
    id: "survey",
    title: "Survey",
    blurb: "Pulse surveys that summarise themselves into action items.",
    icon: ListChecks,
    comingIn: "v1.9",
  },
  {
    id: "chat",
    title: "Chat",
    blurb: "Internal Q&A bot grounded in your team's own data.",
    icon: MessageSquare,
    comingIn: "v1.9",
  },
];

export default function SkillsMarketplaceRoute() {
  const meetingConfig = useStore((s) => s.skills.meetingConfig);
  const navigate = useNavigate();

  return (
    <div className="min-h-full bg-[var(--ti-paper-100)]">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-100)] px-6">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={() => navigate("/dashboard")}
        >
          <ArrowLeft size={16} />
        </Button>
        <span className="font-display text-lg leading-none text-[var(--ti-ink-900)]">
          Skills
        </span>
        <span className="text-xs text-[var(--ti-ink-500)]">/ Marketplace</span>
      </header>

      <main className="mx-auto max-w-6xl p-8">
        <h1 className="font-display text-3xl tracking-tight text-[var(--ti-ink-900)]">
          Skills marketplace
        </h1>
        <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
          One skill ships in v1.5. Nine more are queued for v1.6+.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {SKILLS.map((skill) => {
            const installed = isSkillInstalled(skill.id, meetingConfig);
            const locked = !!skill.comingIn;
            return (
              <SkillCard
                key={skill.id}
                skill={skill}
                installed={installed}
                locked={locked}
                onClick={() => {
                  if (locked) return;
                  if (skill.id === "meeting") navigate("/skills/meeting");
                }}
              />
            );
          })}
        </div>
      </main>
    </div>
  );
}

interface SkillCardProps {
  skill: SkillDef;
  installed: boolean;
  locked: boolean;
  onClick: () => void;
}

function SkillCard({ skill, installed, locked, onClick }: SkillCardProps) {
  const Icon = skill.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={locked}
      className={cn(
        "block w-full text-left transition-shadow",
        locked ? "cursor-not-allowed" : "hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)]",
      )}
    >
      <Card
        className={cn(
          "h-full",
          locked && "opacity-60",
        )}
      >
        <CardContent className="pt-6">
          <div className="flex items-start justify-between gap-3">
            <div
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-md",
              )}
              style={
                locked
                  ? { background: "var(--ti-paper-200)", color: "var(--ti-ink-500)" }
                  : { background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }
              }
            >
              {locked ? <Lock size={16} /> : <Icon size={18} />}
            </div>
            {skill.comingIn && (
              <span className="rounded-full bg-[var(--ti-paper-200)] px-2 py-0.5 text-[10px] font-medium text-[var(--ti-ink-500)]">
                Coming {skill.comingIn}
              </span>
            )}
            {!skill.comingIn && installed && (
              <span className="rounded-full bg-[#2D8659]/10 px-2 py-0.5 text-[10px] font-medium text-[#2D8659]">
                Installed
              </span>
            )}
          </div>
          <p className="mt-3 font-medium text-[var(--ti-ink-900)]">{skill.title}</p>
          <p className="mt-1 text-xs text-[var(--ti-ink-700)]">{skill.blurb}</p>

          {!locked && (
            <p className="mt-4 text-xs text-[var(--ti-orange-500)]">
              {installed ? "Configure →" : "Install →"}
            </p>
          )}
        </CardContent>
      </Card>
    </button>
  );
}

export { SKILLS };
