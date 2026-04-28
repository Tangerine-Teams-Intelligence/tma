// === wave 22 ===
/**
 * Wave 22 — TryThisFAB.
 *
 * Floating "Did you know?" button at bottom-right of every route. Click
 * opens a small popover with one tip card. The card pool is curated; the
 * picker rotates through cards the user hasn't dismissed yet (persisted
 * via `ui.tryThisDismissed`). When every card has been dismissed the
 * button still works — it just re-cycles through the pool from the start.
 *
 * Position: bottom-right, but offset 56px above the existing HelpButton
 * so the two don't stack visually. The HelpButton lives at bottom-4 right-4
 * (h-9 w-9), so we sit at bottom-16 right-4.
 *
 * Telemetry: every click logs `try_this_clicked` with the card id; every
 * dismiss is silent (no-op telemetry — dismiss memory is the signal).
 */
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lightbulb, X } from "lucide-react";

import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { kbdShortcut } from "@/lib/platform";

interface TryThisCard {
  /** Stable id used for dismiss persistence + telemetry. */
  id: string;
  /** i18n sub-key under `coachmark.tryThis`. */
  key: "cmdK" | "brainEdit" | "starTool" | "memoryGit" | "tourReplay" | "shortcuts";
}

const CARDS: TryThisCard[] = [
  { id: "cmdk", key: "cmdK" },
  { id: "brain_edit", key: "brainEdit" },
  { id: "star_tool", key: "starTool" },
  { id: "memory_git", key: "memoryGit" },
  { id: "tour_replay", key: "tourReplay" },
  { id: "shortcuts", key: "shortcuts" },
];

export function TryThisFAB() {
  const { t } = useTranslation();
  const tryThisDismissed = useStore((s) => s.ui.tryThisDismissed);
  const dismissTryThisCard = useStore((s) => s.ui.dismissTryThisCard);
  const [open, setOpen] = useState(false);
  const [cardIdx, setCardIdx] = useState<number | null>(null);

  // Pick a card the user hasn't dismissed yet. If they've dismissed
  // everything we still rotate (re-cycle) so the affordance keeps
  // working.
  const pickFreshCard = useMemo(() => {
    return (skipIdx: number | null): number => {
      const fresh = CARDS.findIndex(
        (c, i) => i !== skipIdx && !tryThisDismissed.includes(c.id),
      );
      if (fresh >= 0) return fresh;
      // No fresh — round-robin from the next index.
      return ((skipIdx ?? -1) + 1) % CARDS.length;
    };
  }, [tryThisDismissed]);

  // Sync card selection on first open + on every "show another" click.
  useEffect(() => {
    if (!open) return;
    if (cardIdx !== null) return;
    setCardIdx(pickFreshCard(null));
  }, [open, cardIdx, pickFreshCard]);

  // Esc closes the popover.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const handleOpen = () => {
    setOpen(true);
    // Telemetry only fires on explicit open — not on the auto-pick
    // useEffect above (that one runs every render until it resolves).
    setCardIdx(null);
  };

  const handleNext = () => {
    if (cardIdx === null) return;
    setCardIdx(pickFreshCard(cardIdx));
  };

  const handleDismiss = () => {
    if (cardIdx === null) return;
    const id = CARDS[cardIdx].id;
    dismissTryThisCard(id);
    // Move on to the next fresh card so the popover doesn't sit on a
    // dismissed entry. Close if we exhaust everything.
    const next = pickFreshCard(cardIdx);
    setCardIdx(next);
  };

  const card = cardIdx !== null ? CARDS[cardIdx] : null;
  const cardBody = card
    ? t(`coachmark.tryThis.${card.key}`, {
        // The cmdK card has a {{kbd}} placeholder — populate it with the
        // platform-aware shortcut so Mac users see ⌘K and Windows sees Ctrl+K.
        kbd: kbdShortcut("k"),
      })
    : "";

  return (
    <>
      <button
        type="button"
        aria-label={t("coachmark.tryThis.ariaLabel")}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          void logEvent("try_this_clicked", { card_id: card?.id ?? "open" });
          handleOpen();
        }}
        data-testid="try-this-fab"
        className="fixed bottom-16 right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full border border-stone-200 bg-stone-50 text-[var(--ti-orange-700)] shadow-md transition-colors hover:bg-[var(--ti-orange-50)] dark:border-stone-700 dark:bg-stone-800 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-700"
      >
        <Lightbulb size={16} />
      </button>

      {open && card && (
        <div
          data-testid="try-this-popover"
          role="dialog"
          aria-labelledby="try-this-title"
          className="fixed bottom-28 right-4 z-50 w-72 rounded-lg border border-stone-200 bg-white p-3 shadow-xl dark:border-stone-700 dark:bg-stone-900"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p
                id="try-this-title"
                className="font-mono text-[10px] uppercase tracking-wider text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]"
              >
                {t("coachmark.tryThis.title")}
              </p>
              <p
                data-testid={`try-this-card-${card.id}`}
                className="mt-1 text-[13px] leading-relaxed text-stone-700 dark:text-stone-300"
              >
                {cardBody}
              </p>
            </div>
            <button
              type="button"
              aria-label={t("coachmark.tryThis.dismiss")}
              data-testid="try-this-close"
              onClick={() => setOpen(false)}
              className="-mr-1 -mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            >
              <X size={12} />
            </button>
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button
              type="button"
              data-testid="try-this-dismiss"
              onClick={handleDismiss}
              className="font-mono text-[11px] text-stone-500 underline-offset-2 hover:text-stone-700 hover:underline dark:text-stone-400 dark:hover:text-stone-200"
            >
              {t("coachmark.tryThis.dismiss")}
            </button>
            <button
              type="button"
              data-testid="try-this-next"
              onClick={handleNext}
              className="rounded-md border border-[var(--ti-orange-300)] bg-[var(--ti-orange-50)] px-2.5 py-1 text-[11px] font-medium text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-100)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-700"
            >
              {t("coachmark.tryThis.next")}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
// === end wave 22 ===
