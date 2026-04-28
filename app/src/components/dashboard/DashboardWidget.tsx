// === wave 20 ===
/**
 * Wave 20 — shared shell for /today dashboard widgets.
 *
 * Linear-style card with a section title, an optional [More]/[Open]/[Manage]
 * link in the header, an optional eyebrow caption, and a body slot. Each
 * widget owns its own loading / error / empty state but reuses this shell so
 * the dashboard stays visually consistent.
 *
 * Defensive: every widget on /today wraps its body in this shell so a fetch
 * failure renders inline ("Couldn't load this widget") instead of crashing
 * the whole dashboard. The shell never throws on its own.
 */

import { Link } from "react-router-dom";
import type { ReactNode } from "react";

interface DashboardWidgetProps {
  /** Widget title rendered inside the card header (Fraunces serif). */
  title: string;
  /** Optional small label to the right of the title (e.g. "(3)"). */
  count?: number;
  /** Optional action link in the header — "More" / "Open" / "Manage". */
  action?: {
    label: string;
    /** React Router target. If omitted, no link renders. */
    to?: string;
    /** Synchronous click handler — alternative to `to`. */
    onClick?: () => void;
  };
  /** Body content. Widgets typically pass a list, an empty state, or an
   *  error block here. */
  children: ReactNode;
  /** Defensive error string. When set, the body is replaced with a
   *  short "Couldn't load this widget" inline message. */
  errorMessage?: string | null;
  /** Loading flag — when true, body is replaced with a small skeleton
   *  hint so the dashboard doesn't pop in widgets one at a time. */
  loading?: boolean;
  /** Test id for the widget card root. */
  testId: string;
}

export function DashboardWidget({
  title,
  count,
  action,
  children,
  errorMessage,
  loading = false,
  testId,
}: DashboardWidgetProps) {
  const headerRight = action ? (
    action.to ? (
      <Link
        to={action.to}
        data-testid={`${testId}-action`}
        className="text-[11px] font-mono text-[var(--ti-orange-500)] hover:underline"
      >
        {action.label}
      </Link>
    ) : (
      <button
        type="button"
        onClick={action.onClick}
        data-testid={`${testId}-action`}
        className="text-[11px] font-mono text-[var(--ti-orange-500)] hover:underline"
      >
        {action.label}
      </button>
    )
  ) : null;

  return (
    <section
      data-testid={testId}
      className="rounded-xl border border-stone-200 bg-[var(--ti-paper-50,#FAF7F2)] px-5 py-4 shadow-sm transition-shadow hover:shadow-md dark:border-stone-800 dark:bg-stone-900"
    >
      <header className="mb-3 flex items-baseline gap-2">
        <h2
          data-testid={`${testId}-title`}
          className="font-display text-[15px] tracking-tight text-[var(--ti-ink-900)]"
        >
          {title}
        </h2>
        {typeof count === "number" && (
          <span
            data-testid={`${testId}-count`}
            className="font-mono text-[11px] text-[var(--ti-ink-500)]"
          >
            ({count})
          </span>
        )}
        <div className="ml-auto">{headerRight}</div>
      </header>

      {errorMessage ? (
        <div
          data-testid={`${testId}-error`}
          className="rounded-md border border-rose-200 bg-rose-50/60 px-3 py-2 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
        >
          {/* === wave 20 wrap-needed === */}
          Couldn't load this widget. {errorMessage}
        </div>
      ) : loading ? (
        <p
          data-testid={`${testId}-loading`}
          className="px-1 py-2 text-[11px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          Loading…
        </p>
      ) : (
        children
      )}
    </section>
  );
}
// === end wave 20 ===
