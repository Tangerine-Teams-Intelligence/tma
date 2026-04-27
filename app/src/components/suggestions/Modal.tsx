/**
 * v1.9.0-beta.1 — Modal tier component.
 *
 * Spec ref: SUGGESTION_ENGINE_SPEC.md §3.4.
 *
 * The escape-hatch tier. Hard-stop confirmation when the AGI is about to
 * take an irreversible action ("Tangerine wants to publish to
 * #engineering — confirm?"). Should be RARE — modal budget is ≤ 1 per
 * session, enforced upstream in `suggestion-bus.ts`. This component
 * itself is purely presentational: render via portal, dim backdrop,
 * centred card with title + body + Cancel/Confirm buttons.
 *
 * Dismiss model:
 *   - Esc                 → onCancel
 *   - backdrop click      → onCancel
 *   - Cancel button       → onCancel
 *   - Confirm button      → onConfirm (the only "accept" path)
 *   - clicking the card   → no-op (stopPropagation)
 *
 * The portal target is `document.body` so dimmed-backdrop sizing isn't
 * affected by any overflow-clipping ancestor.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Polish 4 (v1.9.0-beta.3) — duration of the green flash applied to the
 *  modal card after Confirm. Mirrors `ACCEPT_FLASH_MS` in `Banner.tsx`. */
const ACCEPT_FLASH_MS = 200;

export interface ModalProps {
  /** Stable id for queue identity. */
  id: string;
  /** Override the default 🍊 dot. */
  emoji?: string;
  /** Bold title above the body. */
  title: string;
  /** Body paragraph(s). Plain string for v1.9.0-beta.1. */
  body: string;
  /** Default "Cancel". */
  cancelLabel?: string;
  /** Required — the affirmative button label, e.g. "Publish". */
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
  /** When true, the confirm button is styled red (destructive action). */
  dangerous?: boolean;
}

export function Modal({
  id,
  emoji = "🍊",
  title,
  body,
  cancelLabel = "Cancel",
  confirmLabel,
  onCancel,
  onConfirm,
  dangerous = false,
}: ModalProps) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  // Polish 4 (v1.9.0-beta.3) — flash green on Confirm before unmount.
  const [confirming, setConfirming] = useState(false);

  // Esc → cancel. We listen on document so the modal can be dismissed
  // even when focus is somewhere odd.
  const handleCancel = useCallback(() => onCancel(), [onCancel]);
  const handleConfirm = useCallback(() => {
    setConfirming(true);
    // The flash needs to paint, but the parent host (`<ModalHost/>`)
    // pops us off the queue eagerly so the user's onConfirm fires first.
    // We let the keyframe run for ACCEPT_FLASH_MS as a visual confirmation;
    // the modal card unmounts once dismissModal hits zustand.
    onConfirm();
  }, [onConfirm]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [handleCancel]);

  // Backdrop click → cancel. Stop propagation on the card itself so a
  // click *inside* doesn't bubble up and trigger a false dismiss.
  const onBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) handleCancel();
    },
    [handleCancel],
  );

  // Lock body scroll while the modal is open. We restore the previous
  // overflow value on unmount so we don't trample other modals.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  if (typeof document === "undefined") return null;

  const node = (
    <div
      data-testid="suggestion-modal-backdrop"
      data-modal-id={id}
      // Polish 2 (v1.9.0-beta.3) — explicit role + aria-modal lets screen
      // readers treat the rest of the page as inert while the modal is up.
      // aria-labelledby points at the title `<h2>` so the announcement
      // includes the prompt rather than just "dialog".
      role="dialog"
      aria-modal="true"
      aria-labelledby={`modal-title-${id}`}
      onClick={onBackdropClick}
      style={{ position: "fixed", inset: 0, zIndex: 100 }}
      // Polish 1 (v1.9.0-beta.3) — backdrop alpha tuned for dark mode:
      // 40% black in light is enough to dim the navy paper, but in dark
      // we need 60% to actually dim a near-black background. The
      // dark: variant takes care of it.
      className="flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in dark:bg-black/60"
    >
      <div
        ref={cardRef}
        data-testid="suggestion-modal-card"
        onClick={(e) => e.stopPropagation()}
        // Polish 1 (v1.9.0-beta.3) — card uses --ti-bg-elevated so it
        // sits above the backdrop in both modes. The border token swaps
        // automatically via the dark vars.
        // Polish 4 — accept-flash class wraps the card on Confirm.
        className={
          "w-[480px] max-w-[90vw] rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-bg-elevated)] p-5 shadow-xl" +
          (confirming ? " ti-accept-flash" : "")
        }
      >
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="mt-0.5 inline-block flex-shrink-0 text-[16px]"
            title="Tangerine"
          >
            {emoji}
          </span>
          <div className="min-w-0 flex-1">
            <h2
              id={`modal-title-${id}`}
              // Polish 1 — ink-900 token swaps light/dark automatically.
              className="font-display text-base font-semibold tracking-tight text-[var(--ti-ink-900)]"
            >
              {title}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--ti-ink-700)]">
              {body}
            </p>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            data-testid="suggestion-modal-cancel"
            // Polish 2 — focus-visible ring for keyboard users.
            className="rounded border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-1.5 text-[12px] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-500)]"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            data-testid="suggestion-modal-confirm"
            className={
              dangerous
                ? "rounded border border-rose-500 bg-rose-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300"
                : "rounded border border-[var(--ti-orange-500)] bg-[var(--ti-orange-500)] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--ti-orange-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ti-orange-300)]"
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
