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
      ? "rounded-md border border-dashed border-stone-300 bg-stone-100/40 p-8 text-center dark:border-stone-700 dark:bg-stone-900/40"
      : "p-6 text-center";
  return (
    <section
      data-testid={testId ?? "empty-state"}
      className={wrapperClass}
    >
      <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
        <div
          aria-hidden
          className="flex h-10 w-10 items-center justify-center text-stone-400 dark:text-stone-500"
        >
          {icon}
        </div>
        <h3 className="font-display text-base tracking-tight text-stone-900 dark:text-stone-100">
          {title}
        </h3>
        <p className="text-[12px] leading-relaxed text-stone-600 dark:text-stone-400">
          {description}
        </p>
        {(primaryAction || secondaryAction) && (
          <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
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
        {helpHref && (
          <a
            href={helpHref}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
          >
            {helpLabel ?? "Learn more"}
          </a>
        )}
      </div>
    </section>
  );
}

export default EmptyState;
// === end wave 5-α ===
