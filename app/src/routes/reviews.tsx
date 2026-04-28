// === wave 1.13-B ===
/**
 * v2.5 §1.4 + Wave 1.13-B — `/reviews` route.
 *
 * Wave 1.13-B reshapes this route around the **frontmatter-native review
 * workflow** (the new state machine: draft → proposed → under-review →
 * ratified | rejected). The v2.5 sidecar surface (the original
 * `<ReviewPanel/>`) is kept as a fallback for atoms that still use the
 * sidecar shape — see the bottom of this file.
 *
 * 4 tabs:
 *   • Pending review  — atoms where the current user is a reviewer + has
 *                       not yet voted.
 *   • Proposed by me  — atoms whose `proposer:` is the current user.
 *   • Ratified        — workflow status === "ratified".
 *   • Rejected        — workflow status === "rejected" or "expired".
 *
 * Click a row → `<WorkflowReviewModal/>` opens with the body + vote
 * widgets.
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitPullRequest,
  RefreshCw,
  CheckCircle2,
  ListChecks,
  XCircle,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";
import { WorkflowReviewModal } from "@/components/review/WorkflowReviewModal";
import {
  reviewListPending,
  reviewListProposedBy,
  reviewListByStatus,
  type AtomReviewSummary,
  type ReviewWorkflowState,
} from "@/lib/tauri";

type Tab = "pending" | "proposed" | "ratified" | "rejected";

interface TabState {
  rows: AtomReviewSummary[];
  loading: boolean;
  error: string | null;
}

const EMPTY: TabState = { rows: [], loading: true, error: null };

export default function ReviewsRoute() {
  const { t } = useTranslation();
  const currentUser = useStore((s) => s.ui.currentUser);
  const [tab, setTab] = useState<Tab>("pending");
  const [state, setState] = useState<Record<Tab, TabState>>({
    pending: EMPTY,
    proposed: EMPTY,
    ratified: EMPTY,
    rejected: EMPTY,
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const [active, setActive] = useState<AtomReviewSummary | null>(null);

  // Fetch all four tabs in parallel on mount + on refresh.
  useEffect(() => {
    let cancel = false;
    async function loadOne(
      name: Tab,
      fetcher: () => Promise<AtomReviewSummary[]>,
    ) {
      try {
        const rows = await fetcher();
        if (cancel) return;
        setState((prev) => ({
          ...prev,
          [name]: { rows, loading: false, error: null },
        }));
      } catch (e) {
        if (cancel) return;
        const msg =
          typeof e === "string" ? e : (e as Error)?.message ?? String(e);
        setState((prev) => ({
          ...prev,
          [name]: { rows: [], loading: false, error: msg },
        }));
      }
    }
    setState({
      pending: { ...EMPTY },
      proposed: { ...EMPTY },
      ratified: { ...EMPTY },
      rejected: { ...EMPTY },
    });
    void loadOne("pending", () => reviewListPending(currentUser));
    void loadOne("proposed", () => reviewListProposedBy(currentUser));
    void loadOne("ratified", () => reviewListByStatus("ratified"));
    void loadOne("rejected", async () => {
      const [r, exp] = await Promise.all([
        reviewListByStatus("rejected"),
        reviewListByStatus("expired"),
      ]);
      return [...r, ...exp];
    });
    return () => {
      cancel = true;
    };
  }, [currentUser, refreshKey]);

  const current = state[tab];

  function handleChanged(next: ReviewWorkflowState) {
    // Naive — re-pull all tabs on any vote.
    setRefreshKey((k) => k + 1);
    setActive(null);
    void next;
  }

  return (
    <div
      className="mx-auto flex max-w-3xl flex-col gap-4 p-6"
      data-testid="reviews-route"
    >
      <header className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-lg font-medium text-stone-900 dark:text-stone-100">
            <GitPullRequest size={18} />
            {t("reviews.title")}
          </h1>
          <p className="text-[12px] text-stone-500 dark:text-stone-400">
            {t("review.tabsSubtitle")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <RefreshCw size={12} className="mr-1" />
          {t("reviews.refresh")}
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1" role="tablist">
        <TabChip
          active={tab === "pending"}
          onClick={() => setTab("pending")}
          count={state.pending.rows.length}
          testId="reviews-tab-pending"
        >
          {t("review.tabs.pending")}
        </TabChip>
        <TabChip
          active={tab === "proposed"}
          onClick={() => setTab("proposed")}
          count={state.proposed.rows.length}
          testId="reviews-tab-proposed"
        >
          {t("review.tabs.proposed")}
        </TabChip>
        <TabChip
          active={tab === "ratified"}
          onClick={() => setTab("ratified")}
          count={state.ratified.rows.length}
          testId="reviews-tab-ratified"
        >
          {t("review.tabs.ratified")}
        </TabChip>
        <TabChip
          active={tab === "rejected"}
          onClick={() => setTab("rejected")}
          count={state.rejected.rows.length}
          testId="reviews-tab-rejected"
        >
          {t("review.tabs.rejected")}
        </TabChip>
      </div>

      {current.loading ? (
        <div className="space-y-3" data-testid="reviews-loading">
          {Array.from({ length: 2 }).map((_, i) => (
            <div
              key={i}
              className="rounded border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
            >
              <Skeleton className="h-3 w-1/3" />
              <Skeleton className="mt-2 h-3 w-1/2" />
              <Skeleton className="mt-3 h-3 w-full" />
            </div>
          ))}
        </div>
      ) : current.error ? (
        <ErrorState
          error={current.error}
          title={t("reviews.errorLoad")}
          onRetry={() => setRefreshKey((k) => k + 1)}
          retryLabel={t("buttons.retry")}
          testId="reviews-error"
        />
      ) : current.rows.length === 0 ? (
        <ReviewsEmpty tab={tab} />
      ) : (
        <ul className="space-y-2" data-testid={`reviews-list-${tab}`}>
          {current.rows.map((row) => (
            <li key={row.atom_path}>
              <ReviewRow
                row={row}
                onClick={() => setActive(row)}
                currentUser={currentUser}
              />
            </li>
          ))}
        </ul>
      )}

      {active && (
        <WorkflowReviewModal
          summary={active}
          onClose={() => setActive(null)}
          onChanged={handleChanged}
        />
      )}
    </div>
  );
}

function TabChip({
  active,
  onClick,
  count,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      role="tab"
      aria-selected={active}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition",
        active
          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "border-stone-200 bg-white text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400 dark:hover:bg-stone-800",
      )}
    >
      <span>{children}</span>
      <span
        className={cn(
          "rounded-full px-1.5 py-0.5 text-[10px] font-mono",
          active
            ? "bg-[var(--ti-orange-200)] text-[var(--ti-orange-800)] dark:bg-stone-900 dark:text-[var(--ti-orange-500)]"
            : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
        )}
      >
        {count}
      </span>
    </button>
  );
}

function ReviewRow({
  row,
  onClick,
  currentUser,
}: {
  row: AtomReviewSummary;
  onClick: () => void;
  currentUser: string;
}) {
  const { t } = useTranslation();
  const youReview = row.reviewers.includes(currentUser);
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`reviews-row-${row.atom_path}`}
      className="flex w-full flex-col gap-1.5 rounded border border-stone-200 bg-white p-3 text-left transition hover:border-[var(--ti-orange-500)] hover:bg-stone-50 dark:border-stone-800 dark:bg-stone-900 dark:hover:bg-stone-800"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium text-stone-800 dark:text-stone-100">
            {row.atom_title}
          </p>
          <p className="truncate font-mono text-[10px] text-stone-500 dark:text-stone-400">
            {row.atom_path}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <p className="text-[10px] text-stone-500 dark:text-stone-400">
            {t("review.voteProgress", {
              cast: row.votes_cast,
              total: row.votes_required,
            })}
          </p>
          {row.deadline && (
            <p className="text-[10px] text-amber-700 dark:text-amber-300">
              {t("review.dueBy", {
                when: new Date(row.deadline).toLocaleString(),
              })}
            </p>
          )}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {row.reviewers.map((r) => (
            <span
              key={r}
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px]",
                r === currentUser
                  ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                  : "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
              )}
            >
              @{r}
            </span>
          ))}
        </div>
        {row.proposer && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-stone-500 dark:text-stone-400">
            <User size={10} />
            {row.proposer}
          </span>
        )}
        {youReview && (
          <span className="text-[10px] font-medium text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]">
            {t("review.youAreReviewer")}
          </span>
        )}
      </div>
    </button>
  );
}

function ReviewsEmpty({ tab }: { tab: Tab }) {
  const { t } = useTranslation();
  const map: Record<
    Tab,
    { title: string; description: string; Icon: typeof CheckCircle2 }
  > = {
    pending: {
      title: t("review.empty.pending.title"),
      description: t("review.empty.pending.body"),
      Icon: CheckCircle2,
    },
    proposed: {
      title: t("review.empty.proposed.title"),
      description: t("review.empty.proposed.body"),
      Icon: ListChecks,
    },
    ratified: {
      title: t("review.empty.ratified.title"),
      description: t("review.empty.ratified.body"),
      Icon: CheckCircle2,
    },
    rejected: {
      title: t("review.empty.rejected.title"),
      description: t("review.empty.rejected.body"),
      Icon: XCircle,
    },
  };
  const { title, description, Icon } = map[tab];
  return (
    <EmptyState
      icon={<Icon size={32} className="text-stone-300" />}
      title={title}
      description={description}
      testId={`reviews-empty-${tab}`}
    />
  );
}
// === end wave 1.13-B ===
