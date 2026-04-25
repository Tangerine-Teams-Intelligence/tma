/**
 * ML-0 Meetings list — APP-INTERFACES.md §3.
 *
 * Loads from `listMeetings()` (Tauri-mocked in browser/test). Cards link to
 * MD-0. "+ New meeting" opens NewMeetingDialog.
 */
import { useEffect, useMemo, useState } from "react";
import { Plus, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { listMeetings, type MeetingListItem } from "@/lib/tauri";
import { StatePill } from "./components/StatePill";
import { NewMeetingDialog } from "./NewMeetingDialog";

const STATE_FILTERS: Array<{ label: string; value: string | undefined }> = [
  { label: "All", value: undefined },
  { label: "Created", value: "created" },
  { label: "Live", value: "live" },
  { label: "Wrapped", value: "wrapped" },
  { label: "Reviewed", value: "reviewed" },
  { label: "Merged", value: "merged" },
];

export default function MeetingsList() {
  const nav = useNavigate();
  const [meetings, setMeetings] = useState<MeetingListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<string | undefined>(undefined);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    listMeetings({ state: stateFilter, query: query || undefined })
      .then((rows) => {
        if (!cancelled) setMeetings(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [query, stateFilter]);

  const visible = useMemo(() => meetings ?? [], [meetings]);

  return (
    <div className="mx-auto flex h-full max-w-5xl flex-col gap-6 p-8" data-testid="ml-0">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl">Meetings</h1>
          <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
            Every meeting is a folder on disk. Pick one or start a new one.
          </p>
        </div>
        <Button onClick={() => setNewOpen(true)} data-testid="new-meeting-button">
          <Plus size={16} />
          New meeting
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={14}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ti-ink-500)]"
          />
          <Input
            placeholder="Search by title, ID or alias"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-9"
            aria-label="Search meetings"
          />
        </div>
        <div className="flex gap-1">
          {STATE_FILTERS.map((f) => (
            <button
              key={f.label}
              onClick={() => setStateFilter(f.value)}
              className={
                "rounded-md border px-3 py-1.5 text-xs transition-colors duration-fast " +
                (stateFilter === f.value
                  ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                  : "border-[var(--ti-border-default)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-[#B83232] bg-[#B83232]/10 p-4 text-sm text-[#B83232]">
          Failed to load meetings: {error}
        </div>
      )}

      {meetings === null ? (
        <p className="text-sm text-[var(--ti-ink-500)]">Loading…</p>
      ) : visible.length === 0 ? (
        <EmptyState onCreate={() => setNewOpen(true)} />
      ) : (
        <ul className="flex flex-col gap-3" data-testid="meetings-list">
          {visible.map((m) => (
            <li key={m.id}>
              <button
                onClick={() => nav(`/meetings/${m.id}`)}
                className="w-full text-left"
                data-testid={`meeting-card-${m.id}`}
              >
                <Card className="p-4 hover:border-[var(--ti-orange-500)] transition-colors duration-fast">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <StatePill state={m.state} />
                        <h2 className="truncate font-display text-lg">{m.title}</h2>
                      </div>
                      <p className="mt-1 truncate text-xs text-[var(--ti-ink-500)] font-mono">
                        {m.id}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-[var(--ti-ink-500)]">
                      <span>{m.date}</span>
                      <span>{m.transcript_lines} lines</span>
                    </div>
                  </div>
                  {m.participants.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {m.participants.map((p) => (
                        <span
                          key={p}
                          className="rounded-full bg-[var(--ti-paper-200)] px-2 py-0.5 text-xs text-[var(--ti-ink-700)]"
                        >
                          {p}
                        </span>
                      ))}
                    </div>
                  )}
                </Card>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewMeetingDialog
        open={newOpen}
        onOpenChange={setNewOpen}
        onCreated={(meetingId) => {
          setNewOpen(false);
          nav(`/meetings/${meetingId}`);
        }}
      />
    </div>
  );
}

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div
      data-testid="ml-empty"
      className="flex h-64 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--ti-border-default)] p-8 text-center"
    >
      <p className="text-sm text-[var(--ti-ink-500)]">
        No meetings yet. Create your first.
      </p>
      <Button onClick={onCreate}>
        <Plus size={16} />
        New meeting
      </Button>
    </div>
  );
}
