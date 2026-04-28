// === wave 5-α ===
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Wave 5-α — unified empty state component.
 *
 * Replaces the ad-hoc empty states scattered across routes with one
 * consistent surface. Each empty state has:
 *   - a domain-specific icon (no generic "inbox" stand-ins)
 *   - a title (one short heading)
 *   - a description (1-2 sentences explaining "why empty + what to do")
 *   - up to two actions (primary + secondary)
 *   - an optional helpHref linkable to docs
 *
 * Style follows the design tokens: dashed border, paper-100 bg, ink-900
 * heading, ink-500 body, orange-500 primary CTA. Centered with a
 * 24rem max width so dense pages feel balanced.
 */
export interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  primaryAction?: {
    label: string;
    onClick: () => void;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
  helpHref?: string;
  helpLabel?: string;
  /** Optional override for outer container — useful when nesting in a
   *  page that already supplies its own padding/border. Default: dashed
   *  card. */
  variant?: "card" | "bare";
  /** Optional data-testid for stable test selectors. */
  testId?: string;
}

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
  helpHref,
  helpLabel,
  variant = "card",
  testId,
}: EmptyStateProps) {
  const wrapperClass =
    variant === "card"
      ? "rounded-lg border border-dashed border-stone-300 bg-stone-100/40 p-10 text-center dark:border-stone-700 dark:bg-stone-900/40"
      : "p-8 text-center";
  return (
    <section
      data-testid={testId ?? "empty-state"}
      className={wrapperClass}
    >
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
        {/* === wave 8 === — bigger icon (16x16 box, 48px target inside)
            wrapped in a soft circular paper-200 tint so the empty state
            has a visual anchor instead of a flat lucide line. */}
        <div
          aria-hidden
          className="flex h-16 w-16 items-center justify-center rounded-full bg-[var(--ti-paper-200)] text-[var(--ti-ink-500)] dark:bg-[var(--ti-paper-200)] dark:text-[var(--ti-ink-500)]"
        >
          {icon}
        </div>
        {/* === wave 8 === — title in display serif at slightly larger
            size for proper hierarchy. */}
        <h3 className="font-display text-lg tracking-tight text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]">
          {title}
        </h3>
        <p className="text-[13px] leading-relaxed text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
          {description}
        </p>
        {(primaryAction || secondaryAction) && (
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            {primaryAction && (
              <Button size="sm" onClick={primaryAction.onClick}>
                {primaryAction.label}
              </Button>
            )}
            {secondaryAction && (
              <Button
                variant="outline"
                size="sm"
                onClick={secondaryAction.onClick}
              >
                {secondaryAction.label}
              </Button>
            )}
          </div>
        )}
        {/* === wave 8 === — help link rendered as an outline-style
            button at the bottom rather than a tiny mono link. Keeps the
            mono affordance for the underline reveal but gains a
            tappable target. */}
        {helpHref && (
          <a
            href={helpHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-[var(--ti-border-faint)] px-3 py-1 font-mono text-[11px] text-[var(--ti-ink-700)] underline-offset-2 transition-colors duration-fast hover:border-[var(--ti-orange-300)] hover:bg-[var(--ti-orange-50)] hover:text-[var(--ti-orange-700)] dark:hover:bg-[var(--ti-paper-200)]"
          >
            {helpLabel ?? "Learn more"}
            <span aria-hidden>→</span>
          </a>
        )}
      </div>
    </section>
  );
}

export default EmptyState;
// === end wave 5-α ===
