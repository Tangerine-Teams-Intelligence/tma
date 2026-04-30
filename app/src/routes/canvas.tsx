/**
 * v1.18.0 — /canvas route.
 *
 * One canvas surface, two zoom levels, one Replay timelapse:
 *   • Zoom-out (default): heat-map of (day × actor), GitHub-contribution-
 *     style. "Did anything happen this week, and who?" answered in 1s.
 *   • Zoom-in (scroll-wheel): cells crossfade into individual atoms;
 *     same-thread atoms cluster, @mention edges connect related atoms.
 *   • Replay button (top-right): 5-second timelapse of the corpus in
 *     `ts` order, atoms light up + edges draw as their endpoints
 *     appear. Auto-plays once on first visit; the user always controls
 *     the play/pause/replay state.
 *
 * The route is a thin shell: data fetch, IA-honest empty / loading /
 * error states, and a small intro strip explaining the affordances.
 * The canvas mechanics live in <CanvasView/>.
 */

import { useCallback, useEffect, useState } from "react";
import { Map as MapIcon, AlertCircle } from "lucide-react";
import {
  readTimelineRecent,
  type TimelineEvent,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { CanvasView } from "@/components/canvas/CanvasView";
import { TangerineNotes } from "@/components/TangerineNotes";

export default function CanvasRoute() {
  const welcomedReplayDone = useStore((s) => s.ui.welcomedReplayDone);
  const setWelcomedReplayDone = useStore((s) => s.ui.setWelcomedReplayDone);

  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    readTimelineRecent(500)
      .then((d) => {
        if (cancel) return;
        setEvents(d.events);
        setNotes(d.notes);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setLoading(false);
        setError(
          typeof e === "string"
            ? e
            : (e as Error)?.message ?? "Could not read recent timeline.",
        );
      });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  const onAutoReplayComplete = useCallback(() => {
    setWelcomedReplayDone(true);
  }, [setWelcomedReplayDone]);

  const shouldAutoPlay = !welcomedReplayDone && events.length > 0;

  return (
    <div
      data-testid="canvas-route"
      className="flex h-full flex-col bg-stone-50 dark:bg-stone-950"
    >
      <header className="flex items-center gap-3 border-b border-stone-200 px-4 py-3 dark:border-stone-800">
        <div className="flex h-10 w-10 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
          <MapIcon size={18} className="text-stone-500" />
        </div>
        <div className="min-w-0 flex-1">
          <h1
            data-testid="canvas-header"
            className="text-[18px] font-semibold tracking-tight text-stone-900 dark:text-stone-100"
          >
            Canvas
          </h1>
          <p
            className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
            data-testid="canvas-subhead"
          >
            scroll = zoom (heat-map ↔ atoms) · drag = pan · Replay = 5s
            timelapse
          </p>
        </div>
        {events.length > 0 && (
          <span
            data-testid="canvas-corpus-count"
            className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
          >
            {events.length} atom{events.length === 1 ? "" : "s"}
          </span>
        )}
      </header>

      {notes.length > 0 && (
        <div className="px-4 py-2">
          <TangerineNotes notes={notes} route="/canvas" />
        </div>
      )}

      {loading && (
        <div
          data-testid="canvas-loading"
          className="flex flex-1 items-center justify-center text-stone-500"
        >
          <span className="font-mono text-[12px]">Reading captures…</span>
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-1 flex-col items-center justify-center px-4">
          <div
            data-testid="canvas-error"
            role="alert"
            className="w-full max-w-md rounded-md border border-rose-300 bg-rose-50 p-4 text-[13px] text-rose-800 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
          >
            <div className="flex items-center gap-2 font-semibold">
              <AlertCircle size={16} />
              Couldn't load canvas.
            </div>
            <div className="mt-1 font-mono text-[11px]">{error}</div>
            <button
              type="button"
              data-testid="canvas-retry"
              onClick={() => setRefreshKey((k) => k + 1)}
              className="mt-3 rounded border border-rose-300 bg-white px-2 py-0.5 font-mono text-[11px] text-rose-800 hover:bg-rose-100 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-100 dark:hover:bg-rose-900"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {!loading && !error && events.length === 0 && (
        <div
          data-testid="canvas-empty"
          className="flex flex-1 flex-col items-center justify-center px-4 text-center"
        >
          <span
            aria-hidden
            className="mb-4 inline-block h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--ti-orange-500,#cc5500)]"
          />
          <div className="text-[14px] font-semibold text-stone-700 dark:text-stone-200">
            No atoms captured yet
          </div>
          <p className="mt-2 max-w-sm text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
            The canvas paints itself the moment your AI tools start writing.
            Open Cursor or Claude Code, send one message, and the first heat-
            map cell lights up here within seconds.
          </p>
        </div>
      )}

      {!loading && !error && events.length > 0 && (
        <main className="relative flex-1 overflow-hidden">
          <CanvasView
            events={events}
            autoPlayReplay={shouldAutoPlay}
            onAutoReplayComplete={onAutoReplayComplete}
          />
        </main>
      )}
    </div>
  );
}
