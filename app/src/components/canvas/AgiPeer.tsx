import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

import { coThinkerStatus } from "@/lib/tauri";

/**
 * v1.8 Phase 4-C — AGI peer "presence" chip.
 *
 * A floating chip in the canvas top-right that signals Tangerine is alive
 * on this canvas:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 🍊 Tangerine Co-thinker · 5m ago         │
 *   └──────────────────────────────────────────┘
 *
 * Pulses faintly when the AGI just made a recent throw / comment on this
 * canvas (last heartbeat was within 60s). Click → navigates to the
 * /co-thinker brain route.
 *
 * Polls `co_thinker_status` once on mount + every 30s while mounted. The
 * Tangerine daemon owns the actual heartbeat schedule; we just surface the
 * `last_heartbeat_at` timestamp here.
 *
 * Mounted in `routes/canvas.tsx` so it overlays the CanvasView (P4-B's
 * component doesn't expose a slot we can plug into without modifying it,
 * and the prompt explicitly says don't touch P4-B's CanvasView.tsx).
 */
export function AgiPeer({ project: _project }: { project?: string }) {
  const navigate = useNavigate();
  const [lastBeatIso, setLastBeatIso] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const st = await coThinkerStatus();
      setLastBeatIso(st.last_heartbeat_at);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => {
      void refresh();
      setNow(Date.now());
    }, 30 * 1000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // Recompute "now" each render but cap update frequency via the interval
  // above. We don't bother with requestAnimationFrame — the user can't read
  // sub-second timestamps anyway.
  const lastBeatMs = lastBeatIso ? Date.parse(lastBeatIso) : null;
  const recencyMs =
    lastBeatMs && Number.isFinite(lastBeatMs) ? Math.max(0, now - lastBeatMs) : null;
  const isRecent = recencyMs != null && recencyMs < 60 * 1000;

  return (
    <button
      type="button"
      data-testid="agi-peer-chip"
      onClick={() => navigate("/co-thinker")}
      title="Tangerine Co-thinker — click to open the brain doc"
      aria-label="Open Tangerine Co-thinker"
      className={[
        "ti-no-select absolute right-3 top-3 z-20 flex items-center gap-2 rounded-full border bg-white/90 px-3 py-1 text-[11px] font-medium shadow-sm transition-shadow",
        "border-stone-200 text-stone-700 hover:border-[var(--ti-orange-300)] hover:text-stone-900 dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-300",
        isRecent ? "ring-2 ring-[var(--ti-orange-300)] animate-[ti-pulse_1.6s_ease-in-out_infinite]" : "",
      ].join(" ")}
    >
      <span aria-hidden>🍊</span>
      <span className="font-mono">Tangerine Co-thinker</span>
      <span className="font-mono text-[10px] text-stone-500 dark:text-stone-400">
        ·
      </span>
      <span data-testid="agi-peer-recency" className="font-mono text-[10px] text-stone-500 dark:text-stone-400">
        {error
          ? "offline"
          : recencyMs == null
            ? "no heartbeat yet"
            : `last activity ${formatRecency(recencyMs)}`}
      </span>
    </button>
  );
}

function formatRecency(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 30) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
