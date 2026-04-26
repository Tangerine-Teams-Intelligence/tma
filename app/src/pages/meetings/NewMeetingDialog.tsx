/**
 * NM-0 New meeting modal.
 *
 * Validates title -> slug per CLI rules, picks participants, calls
 * `createMeeting()` (which spawns `tmi new`).
 */
import { useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createMeeting } from "@/lib/tauri";
import { slugify } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (meetingId: string) => void;
  /** Override the team list (for tests). */
  team?: string[];
}

const DEFAULT_TEAM = ["daizhe", "hongyu"];

export function NewMeetingDialog({ open, onOpenChange, onCreated, team }: Props) {
  const [title, setTitle] = useState("");
  const [scheduled, setScheduled] = useState("");
  const [participants, setParticipants] = useState<string[]>(team ?? DEFAULT_TEAM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const teamList = team ?? DEFAULT_TEAM;
  const slug = useMemo(() => slugify(title), [title]);
  const titleValid = slug.length > 0;
  const valid = titleValid && participants.length > 0;

  useEffect(() => {
    if (!open) {
      setTitle("");
      setScheduled("");
      setParticipants(teamList);
      setSubmitting(false);
      setError(null);
    }
  }, [open, teamList]);

  if (!open) return null;

  const toggleParticipant = (alias: string) => {
    setParticipants((curr) =>
      curr.includes(alias) ? curr.filter((a) => a !== alias) : [...curr, alias]
    );
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { meeting_id } = await createMeeting({
        title,
        participants,
        scheduled: scheduled || undefined,
      });
      onCreated(meeting_id);
    } catch (err) {
      setError(String(err));
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="nm-0-title"
      data-testid="nm-0"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 animate-fade-in"
      onClick={() => !submitting && onOpenChange(false)}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-lg border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] p-6 shadow-lg"
      >
        <div className="flex items-center justify-between">
          <h2 id="nm-0-title" className="font-display text-xl">
            New meeting
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={() => onOpenChange(false)}
            className="rounded-md p-1 text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)]"
          >
            <X size={16} />
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-4">
          <div>
            <Label htmlFor="nm-title">Title</Label>
            <Input
              id="nm-title"
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="David sync"
              invalid={title.length > 0 && !titleValid}
              data-testid="nm-title"
            />
            {title && (
              <p className="mt-1 text-xs text-[var(--ti-ink-500)] font-mono">
                ID: <span data-testid="nm-slug">{new Date().toISOString().slice(0, 10)}-{slug || "???"}</span>
              </p>
            )}
          </div>

          <div>
            <Label htmlFor="nm-scheduled">Scheduled at (optional)</Label>
            <Input
              id="nm-scheduled"
              type="datetime-local"
              value={scheduled}
              onChange={(e) => setScheduled(e.target.value)}
            />
          </div>

          <div>
            <Label>Participants</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {teamList.map((alias) => {
                const on = participants.includes(alias);
                return (
                  <button
                    key={alias}
                    type="button"
                    onClick={() => toggleParticipant(alias)}
                    data-testid={`nm-participant-${alias}`}
                    aria-pressed={on}
                    className={
                      "rounded-full border px-3 py-1 text-xs transition-colors duration-fast " +
                      (on
                        ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                        : "border-[var(--ti-border-default)] text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)]")
                    }
                  >
                    {alias}
                  </button>
                );
              })}
            </div>
            {participants.length === 0 && (
              <p className="mt-1 text-xs text-[#B83232]">Pick at least one participant.</p>
            )}
          </div>

          {error && (
            <p className="text-xs text-[#B83232]" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={!valid || submitting} data-testid="nm-submit">
            {submitting ? "Creating…" : "Create meeting"}
          </Button>
        </div>
      </form>
    </div>
  );
}
