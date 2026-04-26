/**
 * smart-inject.ts — heuristics + watcher state for the proactive injector.
 *
 * Stage 1 of the AI surface upgrade: when the user types in ChatGPT /
 * Claude.ai / Gemini, we silently search team memory every 1.5s (debounced).
 * If the model is likely about to answer a question that team memory could
 * inform, we surface a small chip near the textarea: "🍊 N relevant memories".
 *
 * Privacy: feature is OPT-IN per-session. Default off (popup toggle). The
 * background watcher does not send anything to the wire until the user opts
 * in. The endpoint is local (ws://127.0.0.1:7780/memory) so traffic never
 * leaves the user's machine, but we still default-off because debounced
 * polling = predictable read pattern, which some users want to disable.
 */

/** Min textarea length before we'll consider triggering a search. */
export const MIN_QUERY_LEN = 10;

/** Debounce window between consecutive search triggers. */
export const DEBOUNCE_MS = 1500;

/**
 * Heuristic: is this a question / command worth searching team memory for?
 *
 * We want few false positives (don't pop the chip on shopping-list inputs),
 * and few false negatives (don't miss "what did david say about pricing").
 * Stage 1 = rule-based. Stage 2 will replace with a tiny on-device classifier.
 *
 * Triggers (any of):
 *   - text ends with "?"
 *   - contains a wh-word at a token boundary (what / how / who / when / where / why)
 *   - text is reasonably long (>50 chars) — likely a real prompt, not a draft
 *   - contains command verbs ("explain", "summarise", "remind me", "find", "look up")
 */
export function isQuestionLike(text: string): boolean {
  const trimmed = (text ?? "").trim();
  if (trimmed.length < MIN_QUERY_LEN) return false;
  if (trimmed.endsWith("?")) return true;
  if (trimmed.length > 50) return true;
  const lower = trimmed.toLowerCase();
  // Wh-words at token boundary.
  if (/\b(what|how|who|when|where|why|which)\b/.test(lower)) return true;
  // Imperatives that usually mean "use my context".
  if (/\b(explain|summarise|summarize|remind me|find|look\s*up|recap|catch me up|tell me about)\b/.test(lower)) return true;
  return false;
}

/** Per-session deduplication state.
 *
 * The chip should not re-pop for the same prompt the user already dismissed.
 * We hash the trimmed query → if the user dismisses, we remember the hash.
 */
export class SmartInjectMemo {
  private dismissed = new Set<string>();

  /** Mark a query as dismissed for this session. Hash by lowercase trimmed text. */
  dismiss(query: string): void {
    this.dismissed.add(this.hash(query));
  }

  /** Has the user dismissed this query (or a near-identical one)? */
  isDismissed(query: string): boolean {
    return this.dismissed.has(this.hash(query));
  }

  /** Reset dismissed set (called on tab navigation / reload). */
  clear(): void {
    this.dismissed.clear();
  }

  /** Public for tests. */
  hash(query: string): string {
    return (query ?? "").trim().toLowerCase();
  }

  /** Public for tests. */
  size(): number {
    return this.dismissed.size;
  }
}

/**
 * Debouncer: each trigger resets the timer. Fires `fn` only when no new call
 * has come in for `delayMs`.
 */
export function makeDebouncer<T>(
  delayMs: number,
  fn: (arg: T) => void | Promise<void>,
): (arg: T) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArg: T | null = null;
  return (arg: T) => {
    pendingArg = arg;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const a = pendingArg as T;
      pendingArg = null;
      void fn(a);
    }, delayMs);
  };
}

/**
 * Confidence threshold: only show the chip when the search returned at least
 * one result with score >= MIN_CONFIDENCE (or no score, which Stage 1 treats
 * as "always confident enough" — see envelope hook 4).
 */
export const MIN_CONFIDENCE = 0.0; // Stage 1: no scoring. Stage 2: 0.5 default.

export function shouldShowChip(
  results: Array<{ score?: number }>,
): boolean {
  if (!Array.isArray(results) || results.length === 0) return false;
  // Stage 1: if any result has no explicit score, treat as confident.
  return results.some((r) => (r.score ?? 1.0) >= MIN_CONFIDENCE);
}
