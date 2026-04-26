/**
 * RV-0 Review.
 *
 * Three-column: block list (left), block detail (center), action panel embedded
 * in DiffBlockCard footer. Keyboard: ↑↓ / j/k navigate, a/r/e/s decide,
 * ←/→ collapse the left list, Esc cancel edit.
 *
 * Replaces CLI's TUI: faster, click-to-jump, transcript-ref click opens modal
 * with line context.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  applyMeeting,
  applyReviewDecisions,
  getReviewJson,
  type DiffBlockJson,
  type ReviewJson,
} from "@/lib/tauri";
import { DiffBlockCard } from "./components/DiffBlockCard";

type Decision = "approved" | "rejected" | "edited" | "pending" | "skipped";

interface BlockState {
  decision: Decision;
  body: string;
}

export default function ReviewView() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [data, setData] = useState<ReviewJson | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  const [editing, setEditing] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [refModal, setRefModal] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [states, setStates] = useState<Record<number, BlockState>>({});

  useEffect(() => {
    if (!id) return;
    setError(null);
    setData(null);
    getReviewJson(id)
      .then((r) => {
        setData(r);
        const init: Record<number, BlockState> = {};
        for (const b of r.blocks) {
          init[b.id] = { decision: b.status as Decision, body: b.body };
        }
        setStates(init);
      })
      .catch((e) => setError(String(e)));
  }, [id]);

  const blocks = data?.blocks ?? [];
  const active: DiffBlockJson | undefined = blocks[activeIdx];

  const counts = useMemo(() => {
    let approved = 0;
    let rejected = 0;
    let edited = 0;
    let decided = 0;
    for (const b of blocks) {
      const st = states[b.id]?.decision ?? "pending";
      if (st === "approved") {
        approved++;
        decided++;
      } else if (st === "rejected") {
        rejected++;
        decided++;
      } else if (st === "edited") {
        edited++;
        approved++;
        decided++;
      }
    }
    return { approved, rejected, edited, decided };
  }, [blocks, states]);

  const setDecision = useCallback(
    (blockId: number, decision: Decision) => {
      setStates((prev) => ({
        ...prev,
        [blockId]: { ...(prev[blockId] ?? { body: "", decision: "pending" }), decision },
      }));
    },
    []
  );

  const goNext = useCallback(() => {
    setActiveIdx((i) => Math.min(blocks.length - 1, i + 1));
  }, [blocks.length]);

  const goPrev = useCallback(() => {
    setActiveIdx((i) => Math.max(0, i - 1));
  }, []);

  // Keyboard shortcuts (only when not editing)
  useEffect(() => {
    if (editing || !active) return;
    const handler = (e: KeyboardEvent) => {
      // Ignore when focus is in input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        goNext();
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        goPrev();
      } else if (e.key === "ArrowLeft") {
        setCollapsed(true);
      } else if (e.key === "ArrowRight") {
        setCollapsed(false);
      } else if (e.key === "a") {
        setDecision(active.id, "approved");
        goNext();
      } else if (e.key === "r") {
        setDecision(active.id, "rejected");
        goNext();
      } else if (e.key === "e") {
        setEditing(true);
      } else if (e.key === "s") {
        setDecision(active.id, "skipped");
        goNext();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editing, active, goNext, goPrev, setDecision]);

  if (!id) return null;
  if (error) {
    return <p className="p-8 text-sm text-[#B83232]">{error}</p>;
  }
  if (!data) {
    return <p className="p-8 text-sm text-[var(--ti-ink-500)]">Loading review…</p>;
  }
  if (blocks.length === 0) {
    return (
      <p className="p-8 text-sm text-[var(--ti-ink-500)]">
        knowledge-diff.md is empty — nothing to review.
      </p>
    );
  }

  const submitDecisions = async () => {
    setSubmitting(true);
    try {
      const approved: number[] = [];
      const rejected: number[] = [];
      const edited: Record<number, string> = {};
      for (const b of blocks) {
        const st = states[b.id];
        if (!st) continue;
        if (st.decision === "approved") approved.push(b.id);
        else if (st.decision === "rejected") rejected.push(b.id);
        else if (st.decision === "edited") {
          approved.push(b.id);
          edited[b.id] = st.body;
        }
      }
      await applyReviewDecisions(id, { approved, rejected, edited });
      const apply = await applyMeeting(id);
      nav(`/meetings/${id}/review?applied=1&commit=${apply.commit_sha}&written=${apply.written}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full flex-col" data-testid="rv-0">
      <header className="flex items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-6 py-3">
        <div>
          <h1 className="font-display text-lg">Review · {data.meeting_id}</h1>
          <p className="text-xs text-[var(--ti-ink-500)]" data-testid="rv-progress">
            {counts.decided} of {blocks.length} reviewed · {counts.approved} approved
            {counts.edited > 0 ? ` (${counts.edited} edited)` : ""} · {counts.rejected} rejected
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => nav(`/meetings/${id}`)}>
          Done
        </Button>
      </header>

      <div className="grid flex-1 grid-cols-[auto_1fr] divide-x divide-[var(--ti-border-faint)] overflow-hidden">
        <aside
          className={
            "flex flex-col overflow-hidden bg-[var(--ti-paper-50)] " +
            (collapsed ? "w-12" : "w-72")
          }
          data-testid="rv-block-list"
        >
          <div className="flex items-center justify-between p-2">
            <span className={"ti-section-label " + (collapsed ? "hidden" : "")}>
              Blocks
            </span>
            <button
              onClick={() => setCollapsed((c) => !c)}
              aria-label={collapsed ? "Expand list" : "Collapse list"}
              className="rounded-md p-1 text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)]"
            >
              {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>
          <ol className="flex-1 overflow-auto px-2 pb-2">
            {blocks.map((b, i) => {
              const dec = states[b.id]?.decision ?? "pending";
              return (
                <li key={b.id}>
                  <button
                    onClick={() => {
                      setActiveIdx(i);
                      setEditing(false);
                    }}
                    data-testid={`rv-block-${b.id}`}
                    className={
                      "mb-1 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors duration-fast " +
                      (i === activeIdx
                        ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                        : "text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
                    }
                  >
                    <DecisionIcon decision={dec} />
                    {!collapsed && (
                      <>
                        <span className="font-mono">#{b.id}</span>
                        <span className="truncate flex-1">{b.target_file}</span>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="flex min-h-0 flex-col p-6">
          {active && (
            <DiffBlockCard
              block={{
                ...active,
                status: (states[active.id]?.decision ?? "pending") as DiffBlockJson["status"],
              }}
              index={activeIdx}
              total={blocks.length}
              effectiveBody={states[active.id]?.body ?? active.body}
              isEditing={editing}
              onApprove={() => {
                setDecision(active.id, "approved");
                goNext();
              }}
              onReject={() => {
                setDecision(active.id, "rejected");
                goNext();
              }}
              onEdit={() => setEditing(true)}
              onSkip={goNext}
              onSaveEdit={(body) => {
                setStates((prev) => ({
                  ...prev,
                  [active.id]: { decision: "edited", body },
                }));
                setEditing(false);
                goNext();
              }}
              onCancelEdit={() => setEditing(false)}
              onTranscriptRef={(r) => setRefModal(r)}
            />
          )}
        </section>
      </div>

      <footer className="flex items-center justify-between border-t border-[var(--ti-border-faint)] bg-[var(--ti-paper-50)] px-6 py-3">
        <p className="text-xs text-[var(--ti-ink-500)]">
          {counts.decided === blocks.length
            ? "All blocks decided."
            : `${blocks.length - counts.decided} block${
                blocks.length - counts.decided === 1 ? "" : "s"
              } still pending.`}
        </p>
        <Button
          onClick={submitDecisions}
          disabled={counts.decided !== blocks.length || submitting}
          data-testid="rv-merge"
        >
          {submitting ? "Applying…" : `Merge approved blocks (${counts.approved})`}
        </Button>
      </footer>

      {refModal && (
        <TranscriptRefModal
          ref_={refModal}
          meetingId={id}
          onClose={() => setRefModal(null)}
        />
      )}
    </div>
  );
}

function DecisionIcon({ decision }: { decision: Decision }) {
  const map: Record<Decision, { sym: string; color: string }> = {
    approved: { sym: "✓", color: "#065F46" },
    rejected: { sym: "✗", color: "#991B1B" },
    edited: { sym: "✎", color: "#A03F00" },
    pending: { sym: "●", color: "#A8A29E" },
    skipped: { sym: "○", color: "#A8A29E" },
  };
  const c = map[decision];
  return (
    <span
      aria-hidden
      data-testid={`decision-icon-${decision}`}
      style={{ color: c.color }}
      className="w-3 text-center text-sm leading-none"
    >
      {c.sym}
    </span>
  );
}

function TranscriptRefModal({
  ref_,
  meetingId,
  onClose,
}: {
  ref_: string;
  meetingId: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      data-testid="rv-ref-modal"
    >
      <div
        className="w-full max-w-2xl rounded-lg border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-display text-lg">Transcript context · {ref_}</h3>
          <button
            aria-label="Close"
            onClick={onClose}
            className="rounded-md p-1 text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)]"
          >
            <X size={16} />
          </button>
        </div>
        <p className="mt-3 text-xs text-[var(--ti-ink-500)] font-mono">
          {meetingId}/transcript.md
        </p>
        <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-[var(--ti-paper-100)] p-3 font-mono text-xs">
          {`(transcript context unavailable in mock — T3 wires read_meeting_file with offset around ${ref_})`}
        </pre>
      </div>
    </div>
  );
}
