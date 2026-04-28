// === wave 1.13-B ===
/**
 * Wave 1.13-B L4 — `<WorkflowReviewModal/>`. Modal that opens when the
 * user clicks a row on `/reviews`. Shows the atom body + the vote
 * widgets (Approve / Reject / Request Changes) + a comment box.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  X,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  reviewVote,
  reviewWorkflowStatus,
  type AtomReviewSummary,
  type ReviewWorkflowState,
  type WorkflowVoteValue,
} from "@/lib/tauri";
import { readMemoryFile, stripFrontmatter } from "@/lib/memory";
import { cn } from "@/lib/utils";

export interface WorkflowReviewModalProps {
  summary: AtomReviewSummary;
  onClose: () => void;
  onChanged?: (next: ReviewWorkflowState) => void;
}

export function WorkflowReviewModal({
  summary,
  onClose,
  onChanged,
}: WorkflowReviewModalProps) {
  const { t } = useTranslation();
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);
  const [body, setBody] = useState("");
  const [state, setState] = useState<ReviewWorkflowState | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    void Promise.all([
      readMemoryFile(memoryRoot, summary.atom_path),
      reviewWorkflowStatus(summary.atom_path),
    ]).then(([raw, st]) => {
      if (cancel) return;
      setBody(stripFrontmatter(raw ?? ""));
      setState(st);
    });
    return () => {
      cancel = true;
    };
  }, [memoryRoot, summary.atom_path]);

  const myVote = useMemo(
    () => state?.votes.find((v) => v.user === currentUser),
    [state, currentUser],
  );

  async function submit(value: WorkflowVoteValue) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await reviewVote(
        summary.atom_path,
        currentUser,
        value,
        comment.trim() || undefined,
      );
      setState(next);
      setComment("");
      onChanged?.(next);
      if (next.status === "ratified") {
        pushToast("success", t("review.ratifiedToast"));
      } else if (next.status === "rejected") {
        pushToast("info", t("review.rejectedToast"));
      } else {
        pushToast("info", t("review.voteRecorded"));
      }
    } catch (e) {
      pushToast("error", `${t("review.voteFailed")}: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const closed = state?.status === "ratified" || state?.status === "rejected";

  return (
    <div
      data-testid="workflow-review-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="flex w-[760px] max-w-[94vw] max-h-[90vh] flex-col overflow-hidden rounded border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between border-b border-stone-200 px-5 py-3 dark:border-stone-800">
          <div className="min-w-0">
            <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
              {summary.atom_title}
            </h2>
            <p className="truncate font-mono text-[10px] text-stone-500 dark:text-stone-400">
              {summary.atom_path}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge status={summary.status} />
            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              aria-label={t("review.close")}
              data-testid="workflow-review-modal-close"
            >
              <X size={12} />
            </Button>
          </div>
        </header>

        <div className="flex-1 overflow-auto px-5 py-4">
          <article className="prose-tangerine max-w-none">
            <ReactMarkdown>{body || "_(empty)_"}</ReactMarkdown>
          </article>

          {state && state.votes.length > 0 && (
            <section className="mt-6 border-t border-stone-200 pt-3 dark:border-stone-800">
              <h3 className="mb-2 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                {t("review.votesSoFar", {
                  cast: summary.votes_cast,
                  required: summary.votes_required,
                })}
              </h3>
              <ul className="space-y-2">
                {state.votes.map((v, i) => (
                  <li
                    key={`${v.user}-${i}`}
                    className="rounded bg-stone-50 px-2 py-1.5 text-[12px] dark:bg-stone-950"
                    data-testid={`workflow-review-vote-${v.user}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-stone-800 dark:text-stone-200">
                        {v.user}
                      </span>
                      <VoteChip value={v.vote} />
                    </div>
                    {v.comment && (
                      <p className="mt-1 text-stone-600 dark:text-stone-400">
                        {v.comment}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {!closed && (
          <footer className="border-t border-stone-200 px-5 py-3 dark:border-stone-800">
            <textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={t("review.commentPlaceholder")}
              className="mb-2 w-full rounded border border-stone-200 bg-stone-50 p-2 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
              rows={2}
              data-testid="workflow-review-comment"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => void submit("approve")}
                disabled={busy}
                className={cn(
                  myVote?.vote === "approve" && "ring-2 ring-emerald-500",
                )}
                data-testid="workflow-review-approve"
              >
                <ThumbsUp size={12} className="mr-1" />
                {t("review.approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void submit("reject")}
                disabled={busy}
                className={cn(
                  myVote?.vote === "reject" && "ring-2 ring-rose-500",
                )}
                data-testid="workflow-review-reject"
              >
                <ThumbsDown size={12} className="mr-1" />
                {t("review.reject")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void submit("request_changes")}
                disabled={busy}
                className={cn(
                  myVote?.vote === "request_changes" && "ring-2 ring-amber-500",
                )}
                data-testid="workflow-review-request-changes"
              >
                <AlertCircle size={12} className="mr-1" />
                {t("review.requestChanges")}
              </Button>
              <span className="ml-auto text-[10px] text-stone-400">
                {t("review.youAre", { user: currentUser })}
              </span>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: AtomReviewSummary["status"] }) {
  const map: Record<
    AtomReviewSummary["status"],
    { label: string; cls: string; Icon: typeof Clock }
  > = {
    "draft": {
      label: "Draft",
      cls: "bg-stone-200 text-stone-700",
      Icon: Clock,
    },
    "proposed": {
      label: "Proposed",
      cls: "bg-amber-100 text-amber-700",
      Icon: Clock,
    },
    "under-review": {
      label: "Under review",
      cls: "bg-amber-100 text-amber-700",
      Icon: Clock,
    },
    "ratified": {
      label: "Ratified",
      cls: "bg-emerald-100 text-emerald-700",
      Icon: CheckCircle2,
    },
    "rejected": {
      label: "Rejected",
      cls: "bg-rose-100 text-rose-700",
      Icon: XCircle,
    },
    "expired": {
      label: "Expired",
      cls: "bg-stone-200 text-stone-700",
      Icon: Clock,
    },
  };
  const { label, cls, Icon } = map[status];
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium",
        cls,
      )}
    >
      <Icon size={10} />
      {label}
    </span>
  );
}

function VoteChip({ value }: { value: WorkflowVoteValue }) {
  const map: Record<WorkflowVoteValue, { label: string; cls: string }> = {
    approve: {
      label: "Approve",
      cls: "bg-emerald-100 text-emerald-700",
    },
    reject: {
      label: "Reject",
      cls: "bg-rose-100 text-rose-700",
    },
    request_changes: {
      label: "Changes requested",
      cls: "bg-amber-100 text-amber-700",
    },
  };
  const { label, cls } = map[value];
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        cls,
      )}
    >
      {label}
    </span>
  );
}
// === end wave 1.13-B ===
