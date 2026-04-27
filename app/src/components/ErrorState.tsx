// === wave 5-α ===
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Wave 5-α — unified error state component.
 *
 * Drop-in replacement for the bespoke "couldn't load X" red blocks each
 * route currently hand-rolls. Renders a banner-style card with:
 *   - red-tinted background + left-border for severity
 *   - AlertCircle icon
 *   - human title (the route owner's "what couldn't load" copy)
 *   - the underlying error message in a code block
 *   - Retry + Report buttons (both optional)
 *
 * Pass `error` as a string OR an Error — we surface `error.message` for
 * Errors and the raw string for everything else.
 *
 * Report opens a prefilled GitHub issue against the team repo via
 * `mailto:` fallback when `onReport` is omitted (the parent owns the
 * actual reporter so this stays decoupled from the IPC layer).
 */
export interface ErrorStateProps {
  error: Error | string | unknown;
  /** Short title — what couldn't be done. e.g. "Couldn't load reviews." */
  title?: string;
  onRetry?: () => void;
  onReport?: () => void;
  retryLabel?: string;
  reportLabel?: string;
  /** Optional data-testid for stable test selectors. */
  testId?: string;
  /** Compact mode — drops the title and shows just the icon + message
   *  + retry. Useful inline. Default false (banner). */
  compact?: boolean;
}

function humanizeError(e: Error | string | unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const obj = e as { message?: string; detail?: string; code?: string };
    return obj.message ?? obj.detail ?? obj.code ?? JSON.stringify(e);
  }
  return String(e ?? "Unknown error.");
}

export function ErrorState({
  error,
  title,
  onRetry,
  onReport,
  retryLabel = "Retry",
  reportLabel = "Report issue",
  testId,
  compact = false,
}: ErrorStateProps) {
  const message = humanizeError(error);

  if (compact) {
    return (
      <div
        role="alert"
        data-testid={testId ?? "error-state"}
        className="flex items-center gap-2 rounded-md border-l-4 border-[var(--ti-danger)] bg-[var(--ti-danger)]/5 px-3 py-2 text-xs text-[var(--ti-danger)]"
      >
        <AlertCircle size={14} className="shrink-0" />
        <span className="flex-1 font-mono">{message}</span>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retryLabel}
          </Button>
        )}
      </div>
    );
  }

  return (
    <section
      role="alert"
      data-testid={testId ?? "error-state"}
      className="rounded-md border border-[var(--ti-danger)]/40 border-l-4 border-l-[var(--ti-danger)] bg-[var(--ti-danger)]/5 p-5"
    >
      <div className="flex items-start gap-3">
        <AlertCircle
          size={18}
          className="mt-0.5 shrink-0 text-[var(--ti-danger)]"
        />
        <div className="min-w-0 flex-1">
          {title && (
            <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
              {title}
            </p>
          )}
          <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--ti-danger)]">
            {message}
          </pre>
          {(onRetry || onReport) && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {onRetry && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  {retryLabel}
                </Button>
              )}
              {onReport && (
                <Button variant="ghost" size="sm" onClick={onReport}>
                  {reportLabel}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export default ErrorState;
// === end wave 5-α ===
