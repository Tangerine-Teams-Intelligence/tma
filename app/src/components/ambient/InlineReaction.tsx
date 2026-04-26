/**
 * v1.8 Phase 4 — inline ambient reaction renderer.
 *
 * Drops a small, bordered annotation card in the page margin next to an
 * input surface. Visual contract:
 *   - 🍊 dot in the top-left identifies the source as Tangerine's AGI;
 *   - text body, max-width 280px, max 2 lines visible (truncate-3 with
 *     hover-reveal handled by the parent if it needs to);
 *   - dismiss × in the top-right;
 *   - fade-in 200ms;
 *   - click-outside / Esc dismisses + records in the dismiss memory store.
 *
 * Anchoring uses `getBoundingClientRect()` of the surface element. We
 * recompute on resize / scroll so the card tracks its anchor as the user
 * keeps typing. The card itself is rendered through a portal into
 * `document.body` so its overflow-clip behaviour is independent of the
 * input's scroll container.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import type { AgiReaction } from "@/lib/ambient";

interface InlineReactionProps {
  reaction: AgiReaction;
  /** Anchor element to position next to. We hold this as a prop (not a
   *  ref) because the observer hands us a live DOM node; refs would
   *  need a wrapper. */
  anchor: HTMLElement;
  /** Stack offset in px — used when multiple reactions are visible on
   *  the same anchor (reactions stack vertically, max 3 visible). */
  stackOffset?: number;
  onDismiss: () => void;
}

export function InlineReaction({
  reaction,
  anchor,
  stackOffset = 0,
  onDismiss,
}: InlineReactionProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Track the anchor's bounding rect. We listen to scroll + resize so the
  // card follows when the user scrolls the page, the input itself, or
  // resizes the window.
  useEffect(() => {
    function update() {
      if (!anchor.isConnected) return;
      const rect = anchor.getBoundingClientRect();
      // Prefer a position to the *right* of the anchor (margin-style). If
      // there isn't enough room (right edge would clip), fall back below.
      const cardW = 280;
      const gap = 12;
      const fitsRight = rect.right + gap + cardW < window.innerWidth;
      if (fitsRight) {
        setPos({
          top: rect.top + window.scrollY + stackOffset,
          left: rect.right + window.scrollX + gap,
        });
      } else {
        setPos({
          top: rect.bottom + window.scrollY + gap + stackOffset,
          left: Math.max(8, rect.left + window.scrollX),
        });
      }
    }
    update();
    const onWin = () => update();
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
  }, [anchor, stackOffset]);

  // Click-outside / Esc → dismiss. Click-outside is a pointerdown listener
  // on the document; we ignore clicks on the card itself + on the anchor
  // (typing into the input shouldn't dismiss the reaction it just produced).
  const handleDismiss = useCallback(() => onDismiss(), [onDismiss]);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      if (cardRef.current?.contains(target)) return;
      if (anchor.contains(target)) return;
      handleDismiss();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") handleDismiss();
    }
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchor, handleDismiss]);

  if (!pos) return null;

  const card = (
    <div
      ref={cardRef}
      data-testid="ambient-reaction"
      data-surface-id={reaction.surface_id}
      role="status"
      aria-live="polite"
      style={{
        position: "absolute",
        top: pos.top,
        left: pos.left,
        maxWidth: 280,
        zIndex: 80,
      }}
      className="animate-fade-in pointer-events-auto rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-2 text-sm text-[var(--ti-ink-700)] shadow-md dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: "#CC5500" }}
          title="Tangerine"
        >
          {/* The brand orange dot is the AGI's signature — no chatbot tab. */}
        </span>
        <div className="min-w-0 flex-1 leading-snug">{reaction.text}</div>
        <button
          type="button"
          aria-label="Dismiss"
          data-testid="ambient-reaction-dismiss"
          onClick={handleDismiss}
          className="ml-1 rounded p-0.5 text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)] hover:text-[var(--ti-ink-700)] dark:hover:bg-stone-800 dark:hover:text-stone-100"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );

  // Portal into body so the card escapes any overflow-clipping ancestor of
  // the anchor (textareas often live inside a scrolling card).
  if (typeof document === "undefined") return null;
  return createPortal(card, document.body);
}
