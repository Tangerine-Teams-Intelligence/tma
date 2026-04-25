import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Plus } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { TOOLS, type ToolDef } from "@/lib/tools";
import { useStore, isMeetingConfigured } from "@/lib/store";
import { listMeetings, type MeetingListItem } from "@/lib/tauri";

/**
 * Home — your team's AI desktop. One status card per tool, all 10 always
 * shown. Active tools render real data; v1.6+ tools render a soft "Coming"
 * card that's still navigable.
 */
export default function HomeRoute() {
  const navigate = useNavigate();
  const meetingConfig = useStore((s) => s.skills.meetingConfig);
  const meetingReady = isMeetingConfigured(meetingConfig);
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!meetingReady) {
      setMeetings([]);
      return;
    }
    listMeetings({})
      .then((rows) => {
        if (!cancelled) setMeetings(rows);
      })
      .catch(() => {
        if (!cancelled) setMeetings([]);
      });
    return () => {
      cancelled = true;
    };
  }, [meetingReady]);

  return (
    <div className="mx-auto w-full max-w-6xl px-8 py-10">
      {/* Hero */}
      <header>
        <h1 className="font-display text-4xl tracking-tight text-[var(--ti-ink-900)]">
          Your team's AI desktop
        </h1>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--ti-ink-700)]">
          Meetings, wiki, tracking, reviews — all in one app instead of 12 tabs and 12
          subscriptions.
        </p>
      </header>

      {/* Status grid */}
      <section className="mt-10">
        <h2 className="ti-section-label mb-4">Tools</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {TOOLS.map((tool) => (
            <ToolStatusCard
              key={tool.id}
              tool={tool}
              meetingReady={meetingReady}
              latestMeeting={meetings && meetings.length > 0 ? meetings[0] : null}
              onOpen={() => navigate(tool.path)}
              onSetup={() => navigate("/meeting/setup")}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

interface CardProps {
  tool: ToolDef;
  meetingReady: boolean;
  latestMeeting: MeetingListItem | null;
  onOpen: () => void;
  onSetup: () => void;
}

function ToolStatusCard({ tool, meetingReady, latestMeeting, onOpen, onSetup }: CardProps) {
  const Icon = tool.icon;
  const coming = !!tool.comingIn;

  // Body content varies per tool/state; chrome stays uniform.
  let body: React.ReactNode;
  let action: React.ReactNode;

  if (tool.id === "meeting") {
    if (!meetingReady) {
      body = (
        <p className="text-sm text-[var(--ti-ink-500)]">
          No meetings yet — set up Meeting to start.
        </p>
      );
      action = (
        <Button size="sm" onClick={onSetup}>
          <Plus size={14} /> Set up
        </Button>
      );
    } else if (latestMeeting) {
      body = (
        <div>
          <p className="truncate text-sm font-medium text-[var(--ti-ink-900)]">
            {latestMeeting.title || "Untitled meeting"}
          </p>
          <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
            {formatWhen(latestMeeting.date)} ·{" "}
            <span className="capitalize">{latestMeeting.state}</span>
          </p>
        </div>
      );
      action = (
        <Button size="sm" variant="outline" onClick={onOpen}>
          Open <ArrowRight size={14} />
        </Button>
      );
    } else {
      body = (
        <p className="text-sm text-[var(--ti-ink-500)]">
          Configured. No meetings yet — start your first one.
        </p>
      );
      action = (
        <Button size="sm" onClick={onOpen}>
          <Plus size={14} /> New meeting
        </Button>
      );
    }
  } else {
    body = <p className="text-sm text-[var(--ti-ink-500)]">{tool.shortBlurb}</p>;
    action = (
      <Button size="sm" variant="ghost" onClick={onOpen}>
        Preview <ArrowRight size={14} />
      </Button>
    );
  }

  return (
    <Card className="flex h-full flex-col transition-shadow hover:shadow-md">
      <CardContent className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-md"
              style={
                coming
                  ? { background: "var(--ti-paper-200)", color: "var(--ti-ink-500)" }
                  : { background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }
              }
            >
              <Icon size={18} />
            </div>
            <p className="font-medium text-[var(--ti-ink-900)]">{tool.title}</p>
          </div>
          {coming && (
            <span className="rounded-full bg-[var(--ti-paper-200)] px-2 py-0.5 text-[10px] font-medium text-[var(--ti-ink-500)]">
              Coming {tool.comingIn}
            </span>
          )}
        </div>

        <div className="mt-4 min-h-[44px] flex-1">{body}</div>

        <div className="mt-4 flex items-center justify-end">{action}</div>
      </CardContent>
    </Card>
  );
}

function formatWhen(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = Date.now();
    const diffMin = Math.round((now - d.getTime()) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDay = Math.round(diffHr / 24);
    if (diffDay < 7) return `${diffDay}d ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}
