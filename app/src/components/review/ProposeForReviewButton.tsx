// === wave 1.13-B ===
/**
 * Wave 1.13-B L4 — `<ProposeForReviewButton/>`. Drops a "Propose for
 * review" affordance on any atom that hasn't been proposed yet. On click
 * opens a modal that asks for reviewers (chip picker over the team
 * roster), quorum mode, and an optional deadline; on submit fires
 * `review_propose` and (best-effort) flashes a toast.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitPullRequest, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { useTeamRoster } from "@/lib/identity";
import {
  reviewPropose,
  reviewWorkflowStatus,
  type ReviewWorkflowState,
  type WorkflowQuorum,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

export interface ProposeForReviewButtonProps {
  atomPath: string;
  /** Override the default placement; defaults to inline button. */
  variant?: "inline" | "ghost";
  onProposed?: (state: ReviewWorkflowState) => void;
}

export function ProposeForReviewButton({
  atomPath,
  variant = "inline",
  onProposed,
}: ProposeForReviewButtonProps) {
  const { t } = useTranslation();
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);
  const { roster } = useTeamRoster();
  const [open, setOpen] = useState(false);
  const [existing, setExisting] = useState<ReviewWorkflowState | null>(null);

  useEffect(() => {
    let cancel = false;
    void reviewWorkflowStatus(atomPath).then((s) => {
      if (cancel) return;
      setExisting(s);
    });
    return () => {
      cancel = true;
    };
  }, [atomPath]);

  if (existing && existing.status === "under-review") {
    return (
      <span
        data-testid="propose-already"
        className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
      >
        <GitPullRequest size={10} />
        {t("review.alreadyUnderReview")}
      </span>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant={variant === "ghost" ? "ghost" : "outline"}
        onClick={() => setOpen(true)}
        data-testid="propose-for-review"
      >
        <GitPullRequest size={12} className="mr-1" />
        {t("review.proposeButton")}
      </Button>
      {open && (
        <ProposeModal
          atomPath={atomPath}
          currentUser={currentUser}
          rosterAliases={roster
            .map((r) => r.alias)
            .filter((a) => a !== currentUser)}
          onClose={() => setOpen(false)}
          onSubmit={async (reviewers, quorum, deadline) => {
            try {
              const next = await reviewPropose(atomPath, reviewers, {
                quorum,
                deadline: deadline || undefined,
                proposer: currentUser,
              });
              setExisting(next);
              setOpen(false);
              pushToast("success", t("review.proposedToast"));
              onProposed?.(next);
            } catch (e) {
              pushToast("error", `${t("review.proposeFailed")}: ${String(e)}`);
            }
          }}
        />
      )}
    </>
  );
}

interface ProposeModalProps {
  atomPath: string;
  currentUser: string;
  rosterAliases: string[];
  onClose: () => void;
  onSubmit: (
    reviewers: string[],
    quorum: WorkflowQuorum,
    deadline: string,
  ) => Promise<void>;
}

function ProposeModal({
  atomPath,
  currentUser,
  rosterAliases,
  onClose,
  onSubmit,
}: ProposeModalProps) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string[]>([]);
  const [quorum, setQuorum] = useState<WorkflowQuorum>("2/3");
  const [deadline, setDeadline] = useState("");
  const [busy, setBusy] = useState(false);

  const canSubmit = useMemo(() => picked.length > 0 && !busy, [picked, busy]);

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(picked, quorum, deadline);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="propose-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-[460px] max-w-[92vw] rounded border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
            {t("review.modalTitle")}
          </h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label={t("review.close")}
          >
            <X size={12} />
          </Button>
        </header>
        <p className="mb-3 truncate font-mono text-[10px] text-stone-500 dark:text-stone-400">
          {atomPath}
        </p>
        <p className="mb-1 text-[11px] uppercase tracking-wide text-stone-400">
          {t("review.reviewers")}
        </p>
        <div
          className="mb-3 flex flex-wrap gap-1.5"
          data-testid="propose-modal-roster"
        >
          {rosterAliases.length === 0 && (
            <p className="text-[12px] text-stone-400">
              {t("review.rosterEmpty", { user: currentUser })}
            </p>
          )}
          {rosterAliases.map((alias) => {
            const active = picked.includes(alias);
            return (
              <button
                key={alias}
                type="button"
                onClick={() =>
                  setPicked((p) =>
                    p.includes(alias) ? p.filter((x) => x !== alias) : [...p, alias],
                  )
                }
                data-testid={`propose-modal-pick-${alias}`}
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[12px] transition",
                  active
                    ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                    : "border-stone-200 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800",
                )}
              >
                @{alias}
              </button>
            );
          })}
        </div>

        <p className="mb-1 text-[11px] uppercase tracking-wide text-stone-400">
          {t("review.quorumLabel")}
        </p>
        <div className="mb-3 flex gap-1.5">
          {(["2/3", "unanimous", "1/3"] as WorkflowQuorum[]).map((q) => (
            <button
              key={q}
              type="button"
              onClick={() => setQuorum(q)}
              className={cn(
                "rounded border px-2 py-1 text-[11px]",
                quorum === q
                  ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
                  : "border-stone-200 text-stone-600 dark:border-stone-700 dark:text-stone-300",
              )}
              data-testid={`propose-modal-quorum-${q.replace("/", "-")}`}
            >
              {t(`review.quorum.${q.replace("/", "_")}`)}
            </button>
          ))}
        </div>

        <p className="mb-1 text-[11px] uppercase tracking-wide text-stone-400">
          {t("review.deadlineLabel")}
        </p>
        <input
          type="datetime-local"
          value={deadline}
          onChange={(e) => setDeadline(e.target.value)}
          className="mb-4 w-full rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
          data-testid="propose-modal-deadline"
        />

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("review.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={!canSubmit}
            data-testid="propose-modal-submit"
          >
            {busy ? t("review.proposing") : t("review.proposeConfirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
// === end wave 1.13-B ===
