/**
 * MD-0 Meeting detail.
 *
 * Tabs: intent | transcript | observations | summary | diff (last two visible only when state >= wrapped).
 * State-aware action bar: Run prep / Start / Wrap / Review / Apply / Open in editor.
 */
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { readMeeting, type MeetingDetail as MeetingDetailModel } from "@/lib/tauri";
import { StatePill } from "./components/StatePill";
import { IntentViewer } from "./components/IntentViewer";
import { TranscriptTail } from "./components/TranscriptTail";
import { ObserverPanel } from "./components/ObserverPanel";
import { ActionBar } from "./components/ActionBar";

const TABS = [
  { id: "intent", label: "Intent" },
  { id: "transcript", label: "Transcript" },
  { id: "observations", label: "Observations" },
  { id: "summary", label: "Summary" },
  { id: "diff", label: "Diff" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export default function MeetingDetail() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<MeetingDetailModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("intent");

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    readMeeting(id)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [id]);

  if (!id) return null;

  const showSummary = data && ["wrapped", "reviewed", "merged"].includes(data.state);
  const visibleTabs = TABS.filter((t) =>
    t.id === "summary" || t.id === "diff" ? !!showSummary : true
  );

  return (
    <div className="flex h-full flex-col" data-testid="md-0">
      <div className="flex items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-6 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <Button variant="ghost" size="icon" onClick={() => nav("/meetings")} aria-label="Back">
            <ArrowLeft size={18} />
          </Button>
          <div className="min-w-0">
            {data ? (
              <>
                <div className="flex items-center gap-3">
                  <h1 className="truncate font-display text-2xl">{data.title}</h1>
                  <StatePill state={data.state} />
                </div>
                <p className="truncate text-xs text-[var(--ti-ink-500)] font-mono">
                  {data.id} · {data.date} ·{" "}
                  {data.participants.map((p) => p.alias).join(", ")}
                </p>
              </>
            ) : (
              <p className="text-sm text-[var(--ti-ink-500)]">{error ?? "Loading…"}</p>
            )}
          </div>
        </div>
        {data && <ActionBar meeting={data} />}
      </div>

      <nav className="flex gap-1 border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-4">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`md-tab-${t.id}`}
            className={
              "border-b-2 px-3 py-2 text-sm transition-colors duration-fast " +
              (tab === t.id
                ? "border-[var(--ti-orange-500)] text-[var(--ti-orange-700)]"
                : "border-transparent text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-700)]")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div className="flex-1 overflow-auto p-6">
        {!data ? null : tab === "intent" ? (
          <IntentViewer intents={data.intents} />
        ) : tab === "transcript" ? (
          <TranscriptTail meetingId={data.id} initialLineCount={data.transcript_lines} />
        ) : tab === "observations" ? (
          <ObserverPanel observationsMd={data.observations_md ?? ""} />
        ) : tab === "summary" ? (
          <MarkdownBlock body={data.summary_md ?? "(no summary)"} />
        ) : (
          <MarkdownBlock body={data.diff_md ?? "(diff unavailable — open Review to load blocks)"} />
        )}
      </div>
    </div>
  );
}

function MarkdownBlock({ body }: { body: string }) {
  return (
    <pre className="whitespace-pre-wrap font-mono text-sm leading-relaxed text-[var(--ti-ink-700)]">
      {body}
    </pre>
  );
}
