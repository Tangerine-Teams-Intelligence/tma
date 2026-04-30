/**
 * v1.18.0 — Replay button (canvas top-right corner).
 *
 * Toggles between Play / Pause / Replay-from-start depending on the
 * controller state. The progress fill underneath the icon doubles as a
 * visual scrub — at 60% playback we paint a 60%-wide orange bar across
 * the bottom of the chip so the user can eyeball remaining time.
 */

import { Play, Pause, RotateCcw } from "lucide-react";

export interface ReplayButtonProps {
  playing: boolean;
  progress: number;
  /** Total atoms the replay would step through (used in the label). */
  atomCount: number;
  onToggle: () => void;
  onReset: () => void;
}

export function ReplayButton({
  playing,
  progress,
  atomCount,
  onToggle,
  onReset,
}: ReplayButtonProps) {
  const finished = progress >= 1;
  const inMidplay = !playing && progress > 0 && progress < 1;
  const Icon = playing ? Pause : finished ? RotateCcw : Play;
  const label = playing
    ? `Pause replay (${Math.round(progress * 100)}%)`
    : finished
    ? "Replay"
    : inMidplay
    ? `Resume replay (${Math.round(progress * 100)}%)`
    : `Replay last ${atomCount} atom${atomCount === 1 ? "" : "s"}`;

  return (
    <div
      data-testid="replay-button-wrap"
      className="absolute right-3 top-3 z-20 flex items-center gap-1"
    >
      <button
        type="button"
        data-testid="replay-button"
        data-playing={playing}
        data-progress={progress.toFixed(3)}
        onClick={() => {
          if (finished) {
            // After a full play, click resets + plays from t=0.
            onReset();
            // Defer the toggle so the reset state lands first.
            setTimeout(onToggle, 0);
            return;
          }
          onToggle();
        }}
        title={label}
        aria-label={label}
        className="relative flex items-center gap-1.5 overflow-hidden rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[11px] font-medium text-stone-700 shadow-sm hover:bg-stone-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
      >
        <Icon size={12} />
        <span>
          {playing
            ? "Pause"
            : finished
            ? "Replay"
            : inMidplay
            ? "Resume"
            : "Replay"}
        </span>
        {(playing || inMidplay) && (
          <span
            data-testid="replay-progress-fill"
            className="pointer-events-none absolute bottom-0 left-0 h-0.5 bg-[var(--ti-orange-500,#cc5500)]"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        )}
      </button>
    </div>
  );
}

export default ReplayButton;
