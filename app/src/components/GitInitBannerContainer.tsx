// === wave 10 ===
// v1.10 — Container that wires the pure-presentational `GitInitBanner`
// (Wave 10-B) to the Tauri side + the persisted `gitMode` store flag.
//
// Trigger logic:
//   - Only shows when `gitMode === "unknown"` AND the live Rust status
//     reports `git_initialized === false`. The 3 button paths flip the
//     persisted store value:
//       * Initialize now → `gitMode = "init"` (also runs `git_sync_init`)
//       * Already on Cloud → `gitMode = "skip"` (forward-looking; the
//         actual Cloud surface ships in v2.5+ — for now this just stops
//         the banner from re-prompting)
//       * Maybe later → `gitMode = "later"` (per-session only; the
//         persist hydration collapses `later` back to `unknown` on the
//         next cold launch so the user gets re-prompted)

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  GitInitBanner,
  type GitInitBannerLabels,
} from "@/components/GitInitBanner";
import { gitSyncInit, gitSyncStatus, type GitSyncStatus } from "@/lib/tauri";
import { useStore } from "@/lib/store";

export function GitInitBannerContainer() {
  const { t } = useTranslation();
  const gitMode = useStore((s) => s.ui.gitMode);
  const setGitMode = useStore((s) => s.ui.setGitMode);
  const currentUser = useStore((s) => s.ui.currentUser);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [status, setStatus] = useState<GitSyncStatus | null>(null);

  // Re-fetch the status on mount + window focus so the banner reacts fast
  // when the user runs `git init` in their shell.
  useEffect(() => {
    let cancel = false;
    const fetchOnce = () =>
      void gitSyncStatus().then((s) => {
        if (!cancel) setStatus(s);
      });
    fetchOnce();
    const onFocus = () => fetchOnce();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, []);

  const labels: GitInitBannerLabels = useMemo(
    () => ({
      title: t("git.bannerTitle"),
      body: t("git.bannerBody"),
      initializeNow: t("git.bannerInitialize"),
      alreadyOnCloud: t("git.bannerCloud"),
      maybeLater: t("git.bannerLater"),
      remoteUrlPlaceholder: t("git.bannerRemotePlaceholder"),
      initializing: "…",
    }),
    [t],
  );

  // Visibility gate. Only the "unknown" state triggers; the user's choice
  // (init/skip/later) silences it for the appropriate window.
  const shouldShow =
    gitMode === "unknown" &&
    status !== null &&
    status.git_initialized === false &&
    status.memory_dir !== null;

  return (
    <GitInitBanner
      shouldShow={shouldShow}
      labels={labels}
      onDismiss={() => setGitMode("later")}
      onSkipForever={() => setGitMode("skip")}
      onInitialize={async (remoteUrl) => {
        try {
          const next = await gitSyncInit({
            remoteUrl: remoteUrl ?? null,
            defaultUserAlias: currentUser ?? null,
          });
          setStatus(next);
          setGitMode("init");
          pushToast({
            kind: "success",
            msg: t("git.toastPullOk"),
          });
        } catch (e) {
          pushToast({
            kind: "error",
            msg: String((e as Error).message ?? e),
          });
          // Re-throw so the presentational banner clears its `initializing`
          // flag and the user can retry without the spinner getting stuck.
          throw e;
        }
      }}
    />
  );
}

export default GitInitBannerContainer;
