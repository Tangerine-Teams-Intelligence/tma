import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { ScrollText, Sparkles } from "lucide-react";

import { topicFromMarkdown, type Sticky } from "@/lib/canvas";
import { canvasListTopics, canvasLoadTopic, canvasProposeLock } from "@/lib/tauri";
import { useStore } from "@/lib/store";
// v1.9.0-beta.1 P1-A — log every propose-lock click so the suggestion
// engine can see "user proposed 3 decisions in this session → power
// user, lower the suggestion-toast cadence" patterns.
import { logEvent } from "@/lib/telemetry";

/**
 * v1.8 Phase 4-C — AGI affordance overlay for canvas stickies.
 *
 * P4-B's `StickyNote.tsx` doesn't expose a footer slot, so this component
 * mounts as a sibling of the canvas stage, locates each sticky DOM node
 * via its `data-testid="sticky-{id}"` attribute, and overlays affordances
 * via React portals + position-absolute children. This keeps P4-C
 * additive — we never touch P4-B's component tree.
 *
 * Per-sticky affordances:
 *   - 🍊 dot (top-left) when `sticky.is_agi === true`. Visually marks AGI
 *     stickies so a human scanning the board can see at a glance which
 *     ones came from the co-thinker.
 *   - "🍊 Propose as decision" button — visible on hover. Click → calls
 *     `canvas_propose_lock`, toasts "Decision draft created", links to
 *     /memory route.
 *   - "🍊 View AGI reasoning" button — only when `sticky.is_agi`. Click →
 *     navigates to `/co-thinker#sticky-{id}` so the brain doc scrolls to
 *     the matching `Recent reasoning` entry.
 *
 * The component is intentionally simple — we don't track positions in
 * state; we re-query the DOM on every render. Re-renders are cheap because
 * the parent CanvasView only re-renders on sticky list changes (debounced
 * to 250ms by P4-B's save scheduler). On the rare worst case (drag), the
 * affordance stays anchored because `useEffect` runs after layout and
 * portals re-mount under the moved sticky DOM.
 */
export function AgiStickyAffordances(props: {
  project: string;
  /** Explicit topic + sticky list — caller already has the loaded canvas. */
  topic?: string;
  stickies?: Sticky[];
}) {
  if (props.topic && props.stickies) {
    return (
      <ExplicitMode
        project={props.project}
        topic={props.topic}
        stickies={props.stickies}
      />
    );
  }
  return <SelfLoadingMode project={props.project} />;
}

function ExplicitMode({
  project,
  topic,
  stickies,
}: {
  project: string;
  topic: string;
  stickies: Sticky[];
}) {
  return (
    <>
      {stickies.map((s) => (
        <AgiStickyOverlay
          key={s.id}
          project={project}
          topic={topic}
          sticky={s}
        />
      ))}
    </>
  );
}

/**
 * Self-discovery mode: when the caller mounts <AgiStickyAffordances /> at
 * the route level (no in-memory access to CanvasView's sticky list), we
 * fetch the active canvas topic + sticky list ourselves. We poll lightly
 * (every 2.5s) so AGI-thrown stickies eventually surface their affordances
 * even before the user interacts. CanvasView's debounced save fires every
 * 250ms on user mutation; AGI heartbeat fires every 5min. 2.5s feels
 * like the right cadence — fast enough that user-visible lag isn't
 * noticeable, slow enough that we don't hammer the disk.
 */
function SelfLoadingMode({ project }: { project: string }) {
  const [topic, setTopic] = useState<string | null>(null);
  const [stickies, setStickies] = useState<Sticky[]>([]);

  useEffect(() => {
    let cancel = false;

    const tick = async () => {
      try {
        const slugs = await canvasListTopics(project);
        if (cancel || slugs.length === 0) return;
        const activeSlug = slugs[0]; // Match CanvasView's auto-select rule.
        const md = await canvasLoadTopic(project, activeSlug);
        if (cancel) return;
        if (md.trim().length === 0) {
          setTopic(activeSlug);
          setStickies([]);
          return;
        }
        const t = topicFromMarkdown(md, project, activeSlug);
        setTopic(activeSlug);
        setStickies(t.stickies);
      } catch {
        // Soft-fail — affordances simply don't render until the next tick.
      }
    };

    void tick();
    const id = window.setInterval(tick, 2500);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [project]);

  if (!topic) return null;
  return <ExplicitMode project={project} topic={topic} stickies={stickies} />;
}

function AgiStickyOverlay({
  project,
  topic,
  sticky,
}: {
  project: string;
  topic: string;
  sticky: Sticky;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  // Re-tick when stickies move so the portal target stays in sync.
  const tickRef = useRef(0);

  useEffect(() => {
    // Find the P4-B-rendered sticky DOM node.
    const node = document.querySelector<HTMLElement>(
      `[data-testid="sticky-${sticky.id}"]`,
    );
    setHost(node);
    // No mutation observer — CanvasView re-renders on every drag tick which
    // re-runs this effect. If the sticky disappears (delete), `node` is
    // null and we render nothing. This is robust enough for typical use.
    tickRef.current++;
  }, [sticky.id, sticky.x, sticky.y, sticky.color]);

  if (!host) return null;
  return createPortal(
    <AffordanceOverlay project={project} topic={topic} sticky={sticky} />,
    host,
  );
}

function AffordanceOverlay({
  project,
  topic,
  sticky,
}: {
  project: string;
  topic: string;
  sticky: Sticky;
}) {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);
  // v1.9.0-beta.3 P3-B — propose-lock now goes through a confirm modal.
  // Drafting a decision atom in `~/.tangerine-memory/decisions/` is
  // irreversible (the file is written to disk + tracked by the watcher)
  // so per spec §3.4 we gate it behind a single "are you sure?" step.
  const pushModal = useStore((s) => s.ui.pushModal);
  const [busy, setBusy] = useState(false);
  const [hover, setHover] = useState(false);

  const runProposeLock = async () => {
    setBusy(true);
    try {
      const path = await canvasProposeLock(project, topic, sticky.id);
      pushToast(
        "success",
        `Decision draft created: ${shortPath(path)}`,
      );
      void logEvent("accept_suggestion", {
        tier: "modal",
        template_name: "propose_lock_decision",
        atom_ref: `sticky:${project}/${topic}/${sticky.id}`,
      });
    } catch (e) {
      pushToast(
        "error",
        `Propose-lock failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const onPropose = () => {
    // v1.9.0-beta.1 P1-A — log on click, before the modal opens. We stamp
    // the event regardless of the outcome so the engine sees "user
    // attempted to propose-lock 3×" even if every attempt was cancelled.
    void logEvent("canvas_propose_lock", {
      project,
      topic,
      sticky_id: sticky.id,
    });
    const trimmed =
      sticky.body.length > 200
        ? sticky.body.slice(0, 200) + "…"
        : sticky.body;
    const surfaceId = `propose-lock-${sticky.id}`;
    pushModal({
      id: surfaceId,
      emoji: "🍊",
      title: "Lock this as a decision?",
      body:
        `Tangerine will draft a decision atom from this sticky and put it in /memory/decisions/. You can edit before it's final.\n\n` +
        trimmed,
      confirmLabel: "Draft decision",
      cancelLabel: "Cancel",
      onConfirm: () => {
        void runProposeLock();
      },
      onCancel: () => {
        void logEvent("dismiss_suggestion", {
          surface_id: surfaceId,
          modal_kind: "propose_lock_decision",
        });
      },
    });
  };

  const onViewReasoning = () => {
    // Co-thinker route scrolls to `[sticky:{p}/{t}/{id}]` reasoning entry
    // when URL hash matches `#sticky-{id}`.
    navigate(`/co-thinker#sticky-${sticky.id}`);
  };

  return (
    <div
      data-testid={`agi-affordance-${sticky.id}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      // Pointer events pass through unless hovered, so we don't block
      // dragging the sticky header.
      className="pointer-events-none absolute inset-0 z-10"
    >
      {/* AGI marker dot — top-left, visible always when is_agi. */}
      {sticky.is_agi && (
        <span
          data-testid={`agi-dot-${sticky.id}`}
          aria-label="AGI sticky"
          title="Posted by Tangerine AGI"
          className="pointer-events-auto absolute -left-1.5 -top-1.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[var(--ti-orange-500,#CC5500)] text-[10px] leading-none text-white shadow-sm"
        >
          {/* Tangerine emoji renders as the 🍊 dot. */}
          <span aria-hidden>🍊</span>
        </span>
      )}

      {/* Footer affordances — visible on hover. */}
      {hover && (
        <div
          className="pointer-events-auto absolute -bottom-7 left-0 flex items-center gap-1 rounded border border-stone-200 bg-white/95 px-1 py-0.5 shadow-md dark:border-stone-700 dark:bg-stone-900/95"
          // Stop the parent canvas pan-on-drag from kicking in.
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onPropose}
            disabled={busy}
            data-testid={`propose-lock-${sticky.id}`}
            aria-label="Propose as decision"
            title="Lift this sticky into a draft decision atom"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-50,rgba(255,200,150,0.4))] disabled:opacity-50 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-800"
          >
            <Sparkles size={10} />
            {busy ? "Proposing…" : "🍊 Propose as decision"}
          </button>
          {sticky.is_agi && (
            <button
              type="button"
              onClick={onViewReasoning}
              data-testid={`view-reasoning-${sticky.id}`}
              aria-label="View AGI reasoning"
              title="Jump to the matching co-thinker reasoning entry"
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              <ScrollText size={10} />
              🍊 View AGI reasoning
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function shortPath(p: string): string {
  // Surface only the basename in the toast — full paths are noisy.
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}
