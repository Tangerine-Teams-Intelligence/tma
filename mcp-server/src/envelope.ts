/**
 * envelope.ts — Stage 1 AGI response envelope (Hook 4 of STAGE1_AGI_HOOKS.md).
 *
 * Every MCP tool response wraps its payload in this shape so downstream
 * clients (Cursor / Claude Code / Claude Desktop) can already render
 * confidence indicators, freshness, and source attribution from day one.
 *
 * Stage 1 defaults:
 *   - confidence: 1.0  (raw, unaudited)
 *   - alternatives: [] (no LLM scoring yet)
 *   - reasoning_notes: null (no reasoning loop yet)
 *
 * Stage 2 fills these in for real (see STAGE1_AGI_HOOKS.md table).
 */
export interface AgiEnvelope<T = unknown> {
  /** Actual tool payload — shape depends on the tool. */
  data: T;
  /** 0.0–1.0 confidence in the result. Stage 1 = always 1.0. */
  confidence: number;
  /** Seconds since the underlying source data was written. 0 if unknown. */
  freshness_seconds: number;
  /** Atom ids that contributed to this response. Used for trust calibration. */
  source_atoms: string[];
  /** Stage 2: alternative interpretations. Stage 1 = always []. */
  alternatives: unknown[];
  /** Stage 2: reasoning loop annotation. Stage 1 = always null. */
  reasoning_notes: string | null;
}

export interface EnvelopeOptions {
  /**
   * Source atom ids (event ids from timeline.json) that this response was
   * derived from. Empty list means "computed from raw memory files, not
   * indexed atoms".
   */
  sourceAtoms?: string[];
  /**
   * Seconds elapsed since the freshest source atom / file was written. The
   * caller can compute this from `Date.now()` minus the newest mtime / ts.
   * Defaults to 0 (treated as "right now" / unknown).
   */
  freshnessSeconds?: number;
  /** Override confidence. Stage 1 = always 1.0. Tests use this. */
  confidence?: number;
  /** Stage 2 fills these. Defaults to empty. */
  alternatives?: unknown[];
  /** Stage 2 fills this. Defaults to null. */
  reasoningNotes?: string | null;
}

/**
 * Wrap a payload in the AGI envelope. Cheap — just builds an object. All
 * tools should call this exactly once per response so the shape is uniform.
 */
export function wrap<T>(data: T, opts: EnvelopeOptions = {}): AgiEnvelope<T> {
  return {
    data,
    confidence: opts.confidence ?? 1.0,
    freshness_seconds: Math.max(0, Math.floor(opts.freshnessSeconds ?? 0)),
    source_atoms: opts.sourceAtoms ?? [],
    alternatives: opts.alternatives ?? [],
    reasoning_notes: opts.reasoningNotes ?? null,
  };
}

/**
 * Compute freshness in seconds from an ISO timestamp string. Returns 0 for
 * empty / invalid input — callers treat 0 as "unknown / fresh enough".
 */
export function freshnessSecondsFromIso(iso: string | null | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 0;
  const elapsed = Math.floor((Date.now() - t) / 1000);
  return Math.max(0, elapsed);
}
