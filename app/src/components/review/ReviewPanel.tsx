/**
 * v2.5 §1.4 — Review detail panel.
 *
 * Renders one decision atom's review thread:
 *   • atom path + status badge
 *   • vote panel (Approve / Reject / Abstain + optional comment)
 *   • quorum progress bar
 *   • threaded comments (one bubble per vote with comment)
 *
 * Backed by `lib/tauri::review*` wrappers. Voting calls
 * `review_cast_vote`; the returned `ReviewState` is propagated up via
 * `onChanged` so the parent list can re-tally without a full refetch.
 */

import { useMemo, useState } from "react";
import {
  ThumbsUp,
  ThumbsDown,
  CircleSlash,
  CheckCircle2,
  XCircle,
  Clock,
  GitMerge,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  reviewCastVote,
  reviewPromote,
  type ReviewState,
  type VoteValue,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

export interface ReviewPanelProps {
  review: ReviewState;
  onChanged?: (next: ReviewState) => void;
}

export function ReviewPanel({ review, onChanged }: ReviewPanelProps) {
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const myVote = useMemo(
    () => review.votes.find((v) => v.user === currentUser),
    [review.votes, currentUser],
  );

  const approveCount = review.votes.filter((v) => v.value === "approve").length;
  const rejectCount = review.votes.filter((v) => v.value === "reject").length;
  const abstainCount = review.votes.filter((v) => v.value === "abstain").length;
  const teamSize = Math.max(review.team_member_count_at_create, 1);
  const quorumPct = Math.min(
    100,
    Math.round((approveCount / teamSize) * 100),
  );
  const requiredPct = Math.round(review.quorum_threshold * 100);
  const quorumHit = approveCount / teamSize >= review.quorum_threshold;

  async function vote(value: VoteValue) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await reviewCastVote(
        review.atom_path,
        currentUser,
        value,
        comment.trim() || undefined,
      );
      setComment("");
      onChanged?.(next);
      if (next.status === "approved") {
        pushToast("success", "Decision promoted — atom locked");
      }
    } catch (e) {
      pushToast("error", `Vote failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function manualPromote() {
    if (busy) return;
    setBusy(true);
    try {
      const next = await reviewPromote(review.atom_path);
      onChanged?.(next);
      pushToast("success", "Manually promoted — atom locked");
    } catch (e) {
      pushToast("error", `Promote failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-[12px] text-stone-700 dark:text-stone-300">
            {review.atom_path}
          </p>
          <p className="text-[10px] text-stone-400 dark:text-stone-500">
            opened {new Date(review.created_at).toLocaleString()} · {teamSize}{" "}
            teammates · quorum {requiredPct}%
          </p>
        </div>
        <StatusBadge status={review.status} />
      </header>

      <QuorumBar
        approve={approveCount}
        reject={rejectCount}
        abstain={abstainCount}
        team={teamSize}
        pct={quorumPct}
        required={requiredPct}
      />

      {review.status === "open" && (
        <div className="mt-3">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Optional comment on your vote"
            className="w-full rounded border border-stone-200 bg-stone-50 p-2 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            rows={2}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <VoteButton
              icon={ThumbsUp}
              label="Approve"
              active={myVote?.value === "approve"}
              tone="emerald"
              disabled={busy}
              onClick={() => vote("approve")}
            />
            <VoteButton
              icon={ThumbsDown}
              label="Reject"
              active={myVote?.value === "reject"}
              tone="rose"
              disabled={busy}
              onClick={() => vote("reject")}
            />
            <VoteButton
              icon={CircleSlash}
              label="Abstain"
              active={myVote?.value === "abstain"}
              tone="stone"
              disabled={busy}
              onClick={() => vote("abstain")}
            />
            {quorumHit && !review.promoted_at && (
              <Button
                size="sm"
                variant="ghost"
                onClick={manualPromote}
                disabled={busy}
                className="ml-auto"
              >
                <GitMerge size={12} className="mr-1" />
                Promote now
              </Button>
            )}
          </div>
        </div>
      )}

      {review.votes.length > 0 && (
        <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-800">
          <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
            Votes
          </p>
          <ul className="space-y-2">
            {review.votes.map((v, i) => (
              <li
                key={`${v.user}-${i}`}
                className="rounded bg-stone-50 px-2 py-1.5 text-[12px] dark:bg-stone-950"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-stone-800 dark:text-stone-200">
                    {v.user}
                  </span>
                  <VoteChip value={v.value} />
                </div>
                {v.comment && (
                  <p className="mt-1 text-stone-600 dark:text-stone-400">
                    {v.comment}
                  </p>
                )}
                <p className="text-[10px] text-stone-400 dark:text-stone-500">
                  {new Date(v.ts).toLocaleString()}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components

function StatusBadge({ status }: { status: ReviewState["status"] }) {
  const map: Record<
    ReviewState["status"],
    { label: string; cls: string; icon: typeof Clock }
  > = {
    open: {
      label: "Open",
      cls: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      icon: Clock,
    },
    approved: {
      label: "Approved",
      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
      icon: CheckCircle2,
    },
    rejected: {
      label: "Rejected",
      cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
      icon: XCircle,
    },
    stale: {
      label: "Stale",
      cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-400",
      icon: Clock,
    },
  };
  const { label, cls, icon: Icon } = map[status];
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

function VoteButton({
  icon: Icon,
  label,
  active,
  tone,
  disabled,
  onClick,
}: {
  icon: typeof ThumbsUp;
  label: string;
  active: boolean;
  tone: "emerald" | "rose" | "stone";
  disabled: boolean;
  onClick: () => void;
}) {
  const toneCls = {
    emerald:
      "bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-300",
    rose: "bg-rose-600 text-white hover:bg-rose-700 focus:ring-rose-300",
    stone:
      "bg-stone-600 text-white hover:bg-stone-700 focus:ring-stone-300",
  }[tone];
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-1 text-[12px] transition",
        active
          ? toneCls
          : "border border-stone-200 bg-white text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function VoteChip({ value }: { value: VoteValue }) {
  const map: Record<VoteValue, { label: string; cls: string }> = {
    approve: {
      label: "Approve",
      cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
    },
    reject: {
      label: "Reject",
      cls: "bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300",
    },
    abstain: {
      label: "Abstain",
      cls: "bg-stone-200 text-stone-700 dark:bg-stone-800 dark:text-stone-400",
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

function QuorumBar({
  approve,
  reject,
  abstain,
  team,
  pct,
  required,
}: {
  approve: number;
  reject: number;
  abstain: number;
  team: number;
  pct: number;
  required: number;
}) {
  const requiredPos = Math.min(100, required);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-stone-500 dark:text-stone-400">
        <span>
          {approve} approve · {reject} reject · {abstain} abstain · {team}{" "}
          total
        </span>
        <span>{pct}%</span>
      </div>
      <div className="relative h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
        <div
          className="absolute inset-y-0 left-0 bg-emerald-500"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-stone-700 dark:bg-stone-300"
          style={{ left: `${requiredPos}%` }}
          title={`quorum: ${required}%`}
        />
      </div>
    </div>
  );
}
