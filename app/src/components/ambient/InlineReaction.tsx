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
// v1.9.0-beta.1 P1-A — log every chip dismiss so the suggestion engine
// can promote 3-dismisses-in-7d to a 30-day suppression. The dismiss
// reason (× button vs Esc vs click-outside) all funnel through onDismiss
// so a single event shape covers all three.
import { logEvent } from "@/lib/telemetry";

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
  /** v1.9.0-beta.3 Polish 4 — fired when the user clicks the chip's
   *  CTA. Optional because most chips are dismiss-only (no CTA); when
   *  present, the chip flashes green for 200ms before unmounting. */
  onAccept?: () => void;
  /** v1.9.0-beta.3 Polish 4 — optional CTA label. When provided, a
   *  small pill button renders next to the dismiss × and triggers
   *  onAccept on click. Keeps chip footprint minimal — no CTA = no
   *  button rendered, identical to beta.2 layout. */
  ctaLabel?: string;
}

export function InlineReaction({
  reaction,
  anchor,
  stackOffset = 0,
  onDismiss,
  onAccept,
  ctaLabel,
}: InlineReactionProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  // v1.9.0-beta.3 Polish 4 — green flash on accept before unmount.
  const [accepting, setAccepting] = useState(false);

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
  //
  // v1.9.0-beta.1 P1-A — log the dismiss before calling the parent's
  // dismiss handler so telemetry sees every dismiss regardless of whether
  // the parent unmounts the component synchronously.
  const handleDismiss = useCallback(() => {
    void logEvent("dismiss_chip", {
      surface_id: reaction.surface_id,
      // Hash the body so we can later detect "the same content keeps
      // getting dismissed" without storing the full text. A simple length
      // suffices for v1.9.0-beta.1; v1.9.0-beta.2 will switch to a
      // 4-byte FNV when the suppression engine needs it.
      content_hash: `len:${reaction.text.length}`,
    });
    onDismiss();
  }, [onDismiss, reaction.surface_id, reaction.text]);

  // v1.9.0-beta.3 Polish 4 — accept flash + onAccept fan-out. The 200ms
  // flash is purely visual; the user's onAccept fires synchronously so
  // any side-effect (navigation, queue pop) is eager.
  const handleAccept = useCallback(() => {
    setAccepting(true);
    if (onAccept) onAccept();
  }, [onAccept]);

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
      // Polish 1 (v1.9.0-beta.3) — chip uses --ti-bg-elevated so it sits
      // above the route paper in both modes; the existing dark: variants
      // are kept for safe-net but the token swap covers the common case.
      // Polish 4 — accept-flash class on confirm.
      className={
        "animate-fade-in pointer-events-auto rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-bg-elevated)] px-3 py-2 text-sm text-[var(--ti-ink-700)] shadow-md" +
        (accepting ? " ti-accept-flash" : "")
      }
    >
      <div className="flex items-start gap-2">
        <span
          aria-hidden
          className="mt-0.5 inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full"
          // Polish 1 — orange dot stays #CC5500 in both modes (we never
          // filter the brand mark — the dot IS the AGI's signature).
          style={{ backgroundColor: "#CC5500" }}
          title="Tangerine"
        >
          {/* The brand orange dot is the AGI's signature — no chatbot tab. */}
        </span>
        <div className="min-w-0 flex-1 leading-snug">{reaction.text}</div>
        {ctaLabel && (
          <button
            type="button"
            data-testid="ambient-reaction-cta"
            onClick={handleAccept}
            className="ml-1 rounded border border-[var(--ti-orange-300)] bg-[var(--ti-orange-100)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-700"
          >
            {ctaLabel}
          </button>
        )}
        <button
          type="button"
          aria-label="Dismiss"
          data-testid="ambient-reaction-dismiss"
          onClick={handleDismiss}
          className="ml-1 rounded p-0.5 text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-200)] hover:text-[var(--ti-ink-900)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)]"
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
