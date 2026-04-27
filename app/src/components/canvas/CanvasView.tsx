import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, ChevronDown, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  canvasListTopics,
  canvasLoadTopic,
  canvasSaveTopic,
} from "@/lib/tauri";
import {
  type CanvasTopic,
  type Sticky,
  type Comment,
  topicToMarkdown,
  topicFromMarkdown,
  newSticky,
  newTopic,
  slugify,
} from "@/lib/canvas";
import { StickyNote } from "./StickyNote";
// v1.9.0-beta.1 P1-A — log every user-thrown sticky so the suggestion
// engine can see "user threw 7 stickies on this topic in 10min →
// possibly worth proposing a decision lock". The brief points at
// StickyNote.tsx but StickyNote is purely render-side; the actual
// create lives here in CanvasView's `addSticky` callback.
import { logEvent } from "@/lib/telemetry";

/**
 * v1.8 Phase 4-B — Per-project canvas view.
 *
 * Layout:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ <project> / <topic ▾>     [+ New topic] [+ New sticky]       │  ← top toolbar
 *   ├──────────────────────────────────────────────────────────────┤
 *   │                                                              │
 *   │     ┌──────────┐                                             │
 *   │     │ sticky 1 │                                             │
 *   │     └──────────┘             pan + zoom canvas               │
 *   │                                                              │
 *   │              ┌──────────┐                                    │
 *   │              │ sticky 2 │                                    │
 *   │              └──────────┘                                    │
 *   │                                                              │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Pan = left-mouse drag on the empty canvas surface (NOT on a sticky).
 * Zoom = mouse wheel anywhere on the canvas. Both transforms compose into
 * a single `translate + scale` on the inner div — hand-rolled, no library.
 *
 * State management: the source of truth for the topic is the on-disk
 * markdown file. Every mutation (sticky add / drag / edit / comment / color)
 * round-trips through `canvasSaveTopic` so a sibling P4-C heartbeat reads
 * the latest state. Saves are debounced 250ms to coalesce drag updates.
 */
export function CanvasView({ project }: { project: string }) {
  const currentUser = useStore((s) => s.ui.currentUser);

  const [topicSlugs, setTopicSlugs] = useState<string[]>([]);
  const [activeSlug, setActiveSlug] = useState<string | null>(null);
  const [topic, setTopic] = useState<CanvasTopic | null>(null);
  const [loading, setLoading] = useState(true);
  const [topicMenuOpen, setTopicMenuOpen] = useState(false);

  // Pan + zoom state. Hand-rolled — no third-party canvas library; we just
  // compose translate + scale into the inner stage.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const panStateRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);

  // Refresh topic list whenever project changes.
  const refreshTopics = useCallback(async () => {
    setLoading(true);
    try {
      const slugs = await canvasListTopics(project);
      setTopicSlugs(slugs);
      // Auto-pick the first topic if we don't have one yet (or the current
      // one disappeared).
      if (slugs.length === 0) {
        setActiveSlug(null);
        setTopic(null);
      } else if (!activeSlug || !slugs.includes(activeSlug)) {
        setActiveSlug(slugs[0]);
      }
    } finally {
      setLoading(false);
    }
  }, [project, activeSlug]);

  useEffect(() => {
    void refreshTopics();
    // We deliberately depend on `project` only — refreshTopics keeps a
    // closure over activeSlug, but we don't want to re-run on every slug
    // flip since loading the topic body has its own effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  // Load the active topic's body whenever it changes.
  useEffect(() => {
    if (!activeSlug) {
      setTopic(null);
      return;
    }
    let cancel = false;
    void canvasLoadTopic(project, activeSlug).then((md) => {
      if (cancel) return;
      if (md.trim().length === 0) {
        // No file yet (mock or first call) — synthesize a fresh topic in
        // memory; it gets persisted on the first save.
        setTopic(newTopic({ project, topic: activeSlug, author: currentUser }));
      } else {
        setTopic(topicFromMarkdown(md, project, activeSlug));
      }
    });
    return () => {
      cancel = true;
    };
  }, [project, activeSlug, currentUser]);

  // Debounced save. Every mutation calls `setTopic(next)` then `scheduleSave`;
  // we coalesce a burst of drags into a single write. 250ms felt right
  // matching the rest of the app's typing-to-write debounce.
  const saveTimerRef = useRef<number | null>(null);
  const scheduleSave = useCallback(
    (next: CanvasTopic) => {
      if (saveTimerRef.current != null) {
        window.clearTimeout(saveTimerRef.current);
      }
      saveTimerRef.current = window.setTimeout(() => {
        const md = topicToMarkdown(next);
        void canvasSaveTopic(next.project, next.topic, md);
      }, 250);
    },
    [],
  );

  // Mutators — all funnel through here so the debounced save fires.
  const updateTopic = useCallback(
    (next: CanvasTopic) => {
      setTopic(next);
      scheduleSave(next);
    },
    [scheduleSave],
  );

  const addSticky = useCallback(() => {
    if (!topic) return;
    // Drop the new sticky at the current screen center (in canvas
    // coordinates) so it lands where the user is looking.
    const stage = stageRef.current;
    let cx = 80;
    let cy = 80;
    if (stage) {
      const rect = stage.getBoundingClientRect();
      cx = (rect.width / 2 - pan.x) / scale - 130;
      cy = (rect.height / 2 - pan.y) / scale - 80;
    }
    const fresh = newSticky({
      author: currentUser,
      x: Math.round(cx),
      y: Math.round(cy),
    });
    // v1.9.0-beta.1 P1-A — log the user-thrown sticky. AGI-thrown stickies
    // go through the Rust `agi_throw_sticky` command (which already has
    // its own audit trail in `co_thinker.rs::heartbeat_log`); only
    // human-initiated throws are logged here, hence `is_agi: false`.
    void logEvent("canvas_throw_sticky", {
      project,
      topic: activeSlug ?? topic.topic,
      color: fresh.color,
      is_agi: false,
    });
    const next: CanvasTopic = {
      ...topic,
      stickies: [...topic.stickies, fresh],
    };
    updateTopic(next);
  }, [topic, currentUser, pan, scale, updateTopic, project, activeSlug]);

  const updateSticky = useCallback(
    (next: Sticky) => {
      if (!topic) return;
      const updated: CanvasTopic = {
        ...topic,
        stickies: topic.stickies.map((s) => (s.id === next.id ? next : s)),
      };
      updateTopic(updated);
    },
    [topic, updateTopic],
  );

  const deleteSticky = useCallback(
    (id: string) => {
      if (!topic) return;
      const updated: CanvasTopic = {
        ...topic,
        stickies: topic.stickies.filter((s) => s.id !== id),
      };
      updateTopic(updated);
    },
    [topic, updateTopic],
  );

  const appendComment = useCallback(
    (stickyId: string, comment: Comment) => {
      if (!topic) return;
      const updated: CanvasTopic = {
        ...topic,
        stickies: topic.stickies.map((s) =>
          s.id === stickyId ? { ...s, comments: [...s.comments, comment] } : s,
        ),
      };
      updateTopic(updated);
    },
    [topic, updateTopic],
  );

  const createTopic = useCallback(async () => {
    const raw = window.prompt("New topic name:");
    if (!raw) return;
    const slug = slugify(raw);
    if (!slug) return;
    const seed = newTopic({ project, topic: slug, title: raw, author: currentUser });
    await canvasSaveTopic(project, slug, topicToMarkdown(seed));
    // Reload list + flip to the new slug.
    const slugs = await canvasListTopics(project);
    setTopicSlugs(slugs);
    setActiveSlug(slug);
  }, [project, currentUser]);

  // Pan + zoom handlers on the empty canvas surface.
  const stageRef = useRef<HTMLDivElement | null>(null);

  const onStageMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Only pan when the click target IS the stage / scrim — never on a
    // sticky or its descendants. We rely on `data-canvas-pan-target` to
    // mark the panable surface.
    const target = e.target as HTMLElement;
    if (!target.dataset.canvasPanTarget) return;
    panStateRef.current = {
      ox: e.clientX,
      oy: e.clientY,
      sx: pan.x,
      sy: pan.y,
    };
    const onMove = (ev: MouseEvent) => {
      const st = panStateRef.current;
      if (!st) return;
      setPan({ x: st.sx + (ev.clientX - st.ox), y: st.sy + (ev.clientY - st.oy) });
    };
    const onUp = () => {
      panStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onStageWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey && Math.abs(e.deltaY) < 4) return;
    e.preventDefault();
    const factor = e.deltaY > 0 ? 0.92 : 1.08;
    setScale((s) => clamp(s * factor, 0.3, 2.5));
  };

  const isEmpty = !loading && (topicSlugs.length === 0 || !topic);

  // Stable keyed sticky list so React doesn't re-mount on every drag tick.
  const stickyList = useMemo(() => topic?.stickies ?? [], [topic]);

  return (
    <div className="flex h-full flex-col bg-stone-50 dark:bg-stone-950">
      {/* Top header */}
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /canvas/{project}</span>
        <span className="ml-auto">
          {topicSlugs.length} topic{topicSlugs.length === 1 ? "" : "s"}
        </span>
      </header>

      {/* Toolbar */}
      <div className="ti-no-select flex items-center gap-3 border-b border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {project}
        </span>
        {activeSlug && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setTopicMenuOpen((v) => !v)}
              className="flex items-center gap-1 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:bg-stone-800"
              aria-label="Switch topic"
            >
              <FileText size={12} />
              <span className="font-mono">{topic?.title ?? activeSlug}</span>
              <ChevronDown size={10} />
            </button>
            {topicMenuOpen && (
              <ul className="absolute left-0 top-full z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded border border-stone-200 bg-white py-1 shadow-md dark:border-stone-700 dark:bg-stone-900">
                {topicSlugs.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveSlug(s);
                        setTopicMenuOpen(false);
                      }}
                      className={`block w-full px-3 py-1 text-left font-mono text-[12px] hover:bg-stone-100 dark:hover:bg-stone-800 ${
                        s === activeSlug
                          ? "text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]"
                          : "text-stone-700 dark:text-stone-300"
                      }`}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={createTopic} aria-label="New topic">
            <Plus size={12} />
            New topic
          </Button>
          <Button
            size="sm"
            onClick={addSticky}
            disabled={!topic}
            aria-label="New sticky"
          >
            <Plus size={12} />
            New sticky
          </Button>
        </div>
      </div>

      {/* Canvas */}
      {loading ? (
        <p className="px-8 py-12 font-mono text-[12px] text-stone-500 dark:text-stone-400">
          Loading canvas…
        </p>
      ) : isEmpty ? (
        <EmptyState onCreate={createTopic} project={project} />
      ) : (
        <div
          ref={stageRef}
          data-canvas-pan-target="1"
          data-testid="canvas-stage"
          onMouseDown={onStageMouseDown}
          onWheel={onStageWheel}
          className="relative flex-1 overflow-hidden bg-[radial-gradient(circle,rgba(120,113,108,0.18)_1px,transparent_1px)] [background-size:24px_24px] cursor-grab active:cursor-grabbing dark:bg-[radial-gradient(circle,rgba(168,162,158,0.18)_1px,transparent_1px)]"
        >
          <div
            data-canvas-pan-target="1"
            className="absolute inset-0 origin-top-left"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`,
            }}
          >
            {stickyList.map((s) => (
              <StickyNote
                key={s.id}
                sticky={s}
                scale={scale}
                onChange={updateSticky}
                onDelete={() => deleteSticky(s.id)}
                onAppendComment={(c) => appendComment(s.id, c)}
                currentUser={currentUser}
              />
            ))}
          </div>

          {/* Zoom indicator */}
          <div className="ti-no-select pointer-events-none absolute bottom-3 right-3 rounded bg-white/80 px-2 py-0.5 font-mono text-[10px] text-stone-500 shadow-sm dark:bg-stone-900/80 dark:text-stone-400">
            {Math.round(scale * 100)}%
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({
  onCreate,
  project,
}: {
  onCreate: () => void;
  project: string;
}) {
  return (
    <section
      data-testid="canvas-empty"
      className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 px-8 py-12 text-center"
    >
      <h2 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        No canvas topics yet.
      </h2>
      <p className="max-w-prose text-sm leading-relaxed text-stone-600 dark:text-stone-400">
        The canvas for{" "}
        <span className="font-mono text-stone-700 dark:text-stone-300">{project}</span>{" "}
        is empty. Throw down a topic — a roadmap discussion, a half-formed idea,
        a meeting prep board. Tangerine joins as a peer.
      </p>
      <Button onClick={onCreate} aria-label="Create the first topic">
        <Plus size={14} />
        New topic
      </Button>
    </section>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
