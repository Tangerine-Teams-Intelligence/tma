// === wave 10 ===
// v1.10 — Container that wires the pure-presentational `GitSyncIndicator`
// (Wave 10-B) to the live `git_sync_status` Tauri command + i18n strings.
//
// Mounted by Sidebar above the existing SyncStatusIndicator. Polls every
// 10s; on click, expands a popover with branch + last commit + Pull/Push
// buttons + recent history.

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitSyncIndicator,
  type GitSyncStatus as IndicatorStatus,
  type GitSyncIndicatorLabels,
} from "@/components/GitSyncIndicator";
import {
  gitSyncStatus,
  gitSyncPull,
  gitSyncPush,
  gitSyncHistory,
  type GitSyncStatus as RustStatus,
  type GitSyncCommitInfo,
} from "@/lib/tauri";
import { showInFolder } from "@/lib/tauri";
import { useStore } from "@/lib/store";

const POLL_MS = 10_000;

/** Translate the Rust `GitSyncStatus` (4 states) into the presentational
 *  component's `GitSyncStatus` shape (5 states — pulling is overlaid via
 *  the `working === "pull"` flag). */
function mapStatus(rust: RustStatus | null, working: "pull" | "push" | null): IndicatorStatus {
  if (!rust) {
    return { state: "not_initialized" };
  }
  if (working === "pull") {
    return {
      state: "pulling",
      ahead: rust.ahead,
      behind: rust.behind,
      last_pull_iso: rust.last_auto_pull ?? undefined,
      last_push_iso: rust.last_auto_push ?? undefined,
      current_branch: rust.branch ?? undefined,
    };
  }
  if (working === "push") {
    return {
      state: "pushing",
      ahead: rust.ahead,
      behind: rust.behind,
      last_pull_iso: rust.last_auto_pull ?? undefined,
      last_push_iso: rust.last_auto_push ?? undefined,
      current_branch: rust.branch ?? undefined,
    };
  }
  switch (rust.state) {
    case "not_initialized":
      return { state: "not_initialized" };
    case "ahead":
      return {
        state: "pushing",
        ahead: rust.ahead,
        behind: rust.behind,
        last_pull_iso: rust.last_auto_pull ?? undefined,
        last_push_iso: rust.last_auto_push ?? undefined,
        current_branch: rust.branch ?? undefined,
      };
    case "conflict":
      return {
        state: "conflict",
        ahead: rust.ahead,
        behind: rust.behind,
        current_branch: rust.branch ?? undefined,
      };
    case "clean":
    default:
      return {
        state: "clean",
        ahead: rust.ahead,
        behind: rust.behind,
        last_pull_iso: rust.last_auto_pull ?? undefined,
        last_push_iso: rust.last_auto_push ?? undefined,
        current_branch: rust.branch ?? undefined,
      };
  }
}

interface Props {
  /** When the user clicks a `not_initialized` indicator we punt them to
   *  the GitInitBanner via this callback. AppShell wires it. */
  onClickInit?: () => void;
}

export function GitSyncIndicatorContainer({ onClickInit }: Props) {
  const { t } = useTranslation();
  const setGitMode = useStore((s) => s.ui.setGitMode);
  const [rust, setRust] = useState<RustStatus | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [working, setWorking] = useState<"pull" | "push" | null>(null);
  const [history, setHistory] = useState<GitSyncCommitInfo[]>([]);

  // Poll the Rust status. On every flip from "not init → init" persist
  // `gitMode = "init"` so the GitInitBanner stays dismissed forever.
  useEffect(() => {
    let cancel = false;
    const tick = async () => {
      const next = await gitSyncStatus();
      if (cancel) return;
      setRust((prev) => {
        if (
          (!prev || prev.state === "not_initialized") &&
          next.state !== "not_initialized"
        ) {
          setGitMode("init");
        }
        return next;
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [setGitMode]);

  // Pull history when the popover opens.
  useEffect(() => {
    if (!popoverOpen) return;
    let cancel = false;
    void gitSyncHistory({ limit: 8 }).then((rows) => {
      if (!cancel) setHistory(rows);
    });
    return () => {
      cancel = true;
    };
  }, [popoverOpen]);

  const labels: GitSyncIndicatorLabels = useMemo(
    () => ({
      notInitialized: t("git.stateNotInitialized"),
      cleanInSync: t("git.stateClean", { when: "" }).replace(/\s*[-—]?\s*$/, ""),
      pushingAhead: (n: number) =>
        t("git.stateAhead", { count: n }) as string,
      pullConflict: t("git.stateConflict"),
      pulling: t("git.popoverPullNow"),
      lastPullPrefix: "",
    }),
    [t],
  );

  const indicatorStatus = mapStatus(rust, working);

  return (
    <div className="relative">
      <GitSyncIndicator
        status={indicatorStatus}
        labels={labels}
        onClick={() => {
          if (indicatorStatus.state === "not_initialized") {
            onClickInit?.();
          } else {
            setPopoverOpen((v) => !v);
          }
        }}
      />
      {popoverOpen && rust && rust.git_initialized && (
        <SyncPopover
          rust={rust}
          working={working}
          history={history}
          onPull={async () => {
            setWorking("pull");
            try {
              await gitSyncPull();
              setRust(await gitSyncStatus());
            } finally {
              setWorking(null);
            }
          }}
          onPush={async () => {
            setWorking("push");
            try {
              await gitSyncPush();
              setRust(await gitSyncStatus());
            } finally {
              setWorking(null);
            }
          }}
          onOpenShell={() => {
            if (rust.memory_dir) void showInFolder(rust.memory_dir);
          }}
          onClose={() => setPopoverOpen(false)}
        />
      )}
    </div>
  );
}

interface PopoverProps {
  rust: RustStatus;
  working: "pull" | "push" | null;
  history: GitSyncCommitInfo[];
  onPull: () => void | Promise<void>;
  onPush: () => void | Promise<void>;
  onOpenShell: () => void;
  onClose: () => void;
}

function SyncPopover({
  rust,
  working,
  history,
  onPull,
  onPush,
  onOpenShell,
  onClose,
}: PopoverProps) {
  const { t } = useTranslation();
  return (
    <div
      role="dialog"
      data-testid="git-sync-popover"
      className="absolute bottom-full left-0 z-50 mb-2 w-80 rounded-md border border-stone-200 bg-stone-50 p-3 shadow-lg dark:border-stone-800 dark:bg-stone-900"
      onMouseLeave={onClose}
    >
      <div className="mb-2 text-[12px] font-semibold text-stone-700 dark:text-stone-200">
        {t("git.popoverTitle")}
      </div>
      <div className="space-y-1 text-[11px] text-stone-600 dark:text-stone-400">
        <div className="flex justify-between gap-2">
          <span>{t("git.popoverBranch")}</span>
          <span className="font-mono">{rust.branch ?? "—"}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>{t("git.popoverLocalAhead")}</span>
          <span className="font-mono">{rust.ahead}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>{t("git.popoverRemoteBehind")}</span>
          <span className="font-mono">{rust.behind}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>{t("git.popoverLastCommit")}</span>
          <span className="font-mono truncate" title={rust.last_commit_msg ?? ""}>
            {rust.last_commit_msg
              ? rust.last_commit_msg.slice(0, 32) +
                (rust.last_commit_msg.length > 32 ? "…" : "")
              : "—"}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="git-sync-popover-pull"
          disabled={working !== null}
          onClick={() => void onPull()}
          className="rounded border border-stone-200 bg-white px-2 py-1 text-[11px] hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
        >
          {t("git.popoverPullNow")}
        </button>
        <button
          type="button"
          data-testid="git-sync-popover-push"
          disabled={working !== null}
          onClick={() => void onPush()}
          className="rounded border border-stone-200 bg-white px-2 py-1 text-[11px] hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
        >
          {t("git.popoverPushNow")}
        </button>
        <button
          type="button"
          data-testid="git-sync-popover-shell"
          onClick={onOpenShell}
          className="rounded border border-stone-200 bg-white px-2 py-1 text-[11px] hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-800"
        >
          {t("git.popoverOpenShell")}
        </button>
      </div>

      <div className="mt-3 border-t border-stone-200 pt-2 dark:border-stone-800">
        <div className="mb-1 text-[10px] uppercase tracking-wide text-stone-500">
          {t("git.popoverHistory")}
        </div>
        {history.length === 0 ? (
          <div className="text-[11px] italic text-stone-500">
            {t("git.popoverNoHistory")}
          </div>
        ) : (
          <ul
            data-testid="git-sync-popover-history"
            className="max-h-40 space-y-0.5 overflow-auto"
          >
            {history.map((c) => (
              <li
                key={c.sha}
                className="text-[11px] text-stone-600 dark:text-stone-400"
              >
                <span className="mr-1 font-mono text-stone-400">
                  {c.sha.slice(0, 7)}
                </span>
                <span>
                  {c.message.length > 56
                    ? c.message.slice(0, 55) + "…"
                    : c.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {rust.last_error && (
        <div
          data-testid="git-sync-popover-error"
          className="mt-2 rounded border border-rose-300 bg-rose-50 px-2 py-1 text-[11px] text-rose-700 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-300"
        >
          {rust.last_error}
        </div>
      )}
    </div>
  );
}

export default GitSyncIndicatorContainer;
