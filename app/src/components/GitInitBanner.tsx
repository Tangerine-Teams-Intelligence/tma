// === wave 10-B ===
// Non-blocking banner that appears at the top of /today when the memory
// directory exists but is not yet under git. The user has three exits:
//
//   1. "Initialize now" — optional remote URL input, runs `onInitialize`.
//   2. "Already on Cloud" — confirmation, then `onSkipForever` (parent
//      persists the choice so we don't pester them again).
//   3. "Maybe later" — `onDismiss`; resurfaces next session.
//
// Like GitSyncIndicator this is pure-presentational. State (`shouldShow`),
// persistence, and the actual git wiring all live in the parent (Wave 10-A
// owns the store + tauri.ts side). That lets us test the UX in isolation
// without standing up a Rust harness.

import { useState } from "react";
import { GitBranch, Loader2 } from "lucide-react";

export interface GitInitBannerLabels {
  title: string;
  body: string;
  initializeNow: string;
  alreadyOnCloud: string;
  maybeLater: string;
  remoteUrlPlaceholder: string;
  initializing: string;
}

export interface GitInitBannerProps {
  shouldShow: boolean;
  onDismiss: () => void;
  onInitialize: (remoteUrl?: string) => Promise<void>;
  onSkipForever: () => void;
  labels: GitInitBannerLabels;
}

export function GitInitBanner({
  shouldShow,
  onDismiss,
  onInitialize,
  onSkipForever,
  labels,
}: GitInitBannerProps) {
  // Local-only UI state. We deliberately don't surface these via props
  // because they're cosmetic (URL field expand toggle, in-flight spinner,
  // confirmation modal) and the parent shouldn't have to thread them.
  const [showUrlInput, setShowUrlInput] = useState(false);
  const [remoteUrl, setRemoteUrl] = useState("");
  const [initializing, setInitializing] = useState(false);
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  if (!shouldShow) return null;

  const handleInitializeClick = async () => {
    // First click: expand the URL field so the user has a chance to paste
    // a remote. Second click (when URL field is already visible): actually
    // run the init. Empty URL → init local-only.
    if (!showUrlInput) {
      setShowUrlInput(true);
      return;
    }
    setInitializing(true);
    try {
      await onInitialize(remoteUrl.trim() || undefined);
    } finally {
      // We deliberately don't clear `initializing` here — the parent will
      // unmount the banner once init succeeds (shouldShow flips). If init
      // fails the parent should re-mount fresh.
      setInitializing(false);
    }
  };

  const handleAlreadyOnCloudClick = () => {
    if (!confirmingSkip) {
      setConfirmingSkip(true);
      return;
    }
    onSkipForever();
  };

  return (
    <div
      data-testid="git-init-banner"
      role="region"
      aria-label={labels.title}
      className="flex w-full flex-wrap items-start gap-4 border-l-4 border-[var(--ti-orange-500)] bg-[var(--ti-paper-50)] px-4 py-3 text-[12px] text-[var(--ti-ink-900)] dark:bg-[var(--ti-paper-200)]"
    >
      <GitBranch
        size={16}
        className="mt-0.5 shrink-0 text-[var(--ti-orange-500)]"
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-semibold text-[var(--ti-ink-900)]">
          {labels.title}
        </h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-500)]">
          {labels.body}
        </p>
        {showUrlInput && (
          <input
            type="text"
            data-testid="git-init-banner-remote-url"
            value={remoteUrl}
            onChange={(e) => setRemoteUrl(e.target.value)}
            placeholder={labels.remoteUrlPlaceholder}
            disabled={initializing}
            className="mt-2 w-full rounded-md border border-[var(--ti-border-default)] bg-white px-2 py-1 font-mono text-[11px] text-[var(--ti-ink-900)] placeholder:text-[var(--ti-ink-500)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:bg-[var(--ti-paper-100)]"
          />
        )}
        {confirmingSkip && (
          <p
            data-testid="git-init-banner-confirm-skip"
            className="mt-2 text-[11px] text-[var(--ti-warning)]"
          >
            Click again to confirm — git sync will stay disabled for this install.
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="git-init-banner-initialize"
          onClick={() => void handleInitializeClick()}
          disabled={initializing}
          className="inline-flex items-center gap-1 rounded-md bg-[var(--ti-orange-500)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--ti-orange-600)] disabled:opacity-60"
        >
          {initializing && <Loader2 size={12} className="animate-spin" aria-hidden />}
          {initializing ? labels.initializing : labels.initializeNow}
        </button>
        <button
          type="button"
          data-testid="git-init-banner-already-on-cloud"
          onClick={handleAlreadyOnCloudClick}
          disabled={initializing}
          className="rounded-md border border-[var(--ti-border-default)] bg-transparent px-3 py-1.5 text-[12px] font-medium text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-100)] disabled:opacity-60"
        >
          {labels.alreadyOnCloud}
        </button>
        <button
          type="button"
          data-testid="git-init-banner-maybe-later"
          onClick={onDismiss}
          disabled={initializing}
          className="rounded-md bg-transparent px-2 py-1.5 text-[12px] text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-900)] disabled:opacity-60"
        >
          {labels.maybeLater}
        </button>
      </div>
    </div>
  );
}

export default GitInitBanner;
