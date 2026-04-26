/**
 * LV-0 Live meeting — split: agenda (20%) | transcript (50%) | observer (30%).
 *
 * Top bar: state pill, transcript line count, elapsed time, "Stop meeting".
 * Bottom bar: bot status + observer status. APP-INTERFACES.md §3 LV-0.
 */
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { readMeeting, type MeetingDetail } from "@/lib/tauri";
import { StatePill } from "./components/StatePill";
import { TranscriptTail } from "./components/TranscriptTail";
import { ObserverPanel } from "./components/ObserverPanel";
import { AgendaList } from "./components/AgendaList";

function extractTopics(md: string): string[] {
  const out: string[] = [];
  const m = md.match(/##\s*Topics([\s\S]*?)(\n##|$)/);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const item = line.match(/^[-*]\s+(.+)$/);
    if (item) out.push(item[1].trim());
  }
  return out;
}

export default function LivePanel() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<MeetingDetail | null>(null);
  const [observerMode, setObserverMode] = useState<"silent" | "active">("silent");
  const [elapsedSec, setElapsedSec] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);

  useEffect(() => {
    if (!id) return;
    readMeeting(id).then(setData);
  }, [id]);

  useEffect(() => {
    const t = setInterval(() => setElapsedSec((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const agenda = useMemo(() => {
    if (!data) return [];
    return data.intents.map((i) => ({
      alias: i.alias,
      topics: extractTopics(i.markdown ?? ""),
    }));
  }, [data]);

  if (!id || !data) {
    return <p className="p-8 text-sm text-[var(--ti-ink-500)]">Loading…</p>;
  }

  return (
    <div className="flex h-full flex-col" data-testid="lv-0">
      <header className="flex items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-6 py-3">
        <div className="flex items-center gap-3">
          <StatePill state={data.state} />
          <h1 className="font-display text-lg">{data.title}</h1>
          <span className="text-xs text-[var(--ti-ink-500)] font-mono">{data.id}</span>
        </div>
        <div className="flex items-center gap-4 text-xs text-[var(--ti-ink-500)]">
          <span>{data.participants.length} participants</span>
          <span>{data.transcript_lines} lines</span>
          <span>{formatElapsed(elapsedSec)}</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setConfirmStop(true)}
            data-testid="lv-stop"
          >
            Stop meeting
          </Button>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-[220px_3fr_2fr] divide-x divide-[var(--ti-border-faint)] overflow-hidden">
        <aside className="overflow-auto p-4">
          <h2 className="ti-section-label mb-3">Agenda</h2>
          <AgendaList items={agenda} />
        </aside>
        <section className="flex min-h-0 flex-col p-4">
          <TranscriptTail meetingId={data.id} initialLineCount={data.transcript_lines} />
        </section>
        <aside className="overflow-auto p-4">
          <ObserverPanel
            observationsMd={data.observations_md ?? ""}
            showModeToggle
            mode={observerMode}
            onModeChange={setObserverMode}
          />
        </aside>
      </div>

      <footer className="flex items-center justify-between border-t border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-6 py-2 text-xs text-[var(--ti-ink-500)]">
        <span>Bot: connected · channel: General · reconnects: 0</span>
        <span>Observer: running · last poll 14s ago</span>
      </footer>

      {confirmStop && (
        <ConfirmStop
          onCancel={() => setConfirmStop(false)}
          onWrap={() => {
            setConfirmStop(false);
            nav(`/meetings/${data.id}?wrap=1`);
          }}
        />
      )}
    </div>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ConfirmStop({ onCancel, onWrap }: { onCancel: () => void; onWrap: () => void }) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] p-6"
      >
        <h2 className="font-display text-xl">Stop meeting?</h2>
        <p className="mt-2 text-sm text-[var(--ti-ink-700)]">
          This leaves the Discord voice channel, stops the observer, and writes
          summary.md + knowledge-diff.md.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onWrap}>Wrap now</Button>
        </div>
      </div>
    </div>
  );
}
