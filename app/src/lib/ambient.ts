/**
 * v1.8 Phase 4 — ambient input layer.
 *
 * The CEO's vision is that every input field in the app is an AGI entry
 * point. There is no chatbot tab. When the user types in any textarea /
 * contenteditable, after a short debounce, the AGI may surface an inline
 * reaction in the page margin (a small card with a 🍊 dot).
 *
 * This module owns the *policy* — the pure, testable rules that decide
 * whether a reaction should be shown. The DOM observer
 * (`components/ambient/AmbientInputObserver.tsx`) and the renderer
 * (`components/ambient/InlineReaction.tsx`) consume these helpers.
 *
 * Three knobs determine "should we surface anything?":
 *   1. **AGI volume** — silent / quiet / chatty. Persisted in `ui.agiVolume`.
 *      Silent kills every reaction; quiet (default) requires high
 *      confidence; chatty drops the bar.
 *   2. **Per-channel mute** — the user can disable ambient surfacing on
 *      Canvas, Memory edits, the Cmd+K palette, /today, or Settings without
 *      affecting other surfaces. Persisted in `ui.mutedAgiChannels`.
 *   3. **Throttle / dismiss memory** — once shown for a given surface, we
 *      cool down 24h before reshowing on that exact surface. Once
 *      explicitly dismissed, also 24h. Persisted in `ui.dismissedSurfaces`.
 *
 * Confidence threshold is configurable in Settings → AGI → confidence
 * slider (range 0.5–0.95, step 0.05). Default 0.7 matches the spec.
 */

/** Volume bands. Default `quiet` — high-confidence reactions only. */
export type AgiVolume = "silent" | "quiet" | "chatty";

/** Surface channels. Used both in the UI mute toggles and in the
 *  per-surface key derivation. */
export type AmbientChannel =
  | "canvas"
  | "memory"
  | "search"
  | "settings"
  | "today";

/** A surface that was previously shown / dismissed. Stored in zustand. */
export interface DismissEntry {
  surfaceId: string;
  dismissedAt: number;
}

/** A surface that has fired a reaction recently. Stored in-memory only —
 *  cheap to lose on restart since the dismiss-memory store covers the
 *  durable side. */
export interface ThrottleEntry {
  surfaceId: string;
  lastReactionAt: number;
}

/** 24 hours in ms. Used by both throttle and dismiss-memory pruning. */
export const THROTTLE_24H_MS = 24 * 60 * 60 * 1000;

/** How long to wait between user keystrokes before considering the input
 *  "settled" enough to send to the AGI. 800ms is the spec value. */
export const DEBOUNCE_MS = 800;

/** The lowest confidence we ever surface. Below this, drop on the floor
 *  no matter the volume. */
export const MIN_CONFIDENCE = 0.7;

/** Bands per volume. Quiet keeps the spec default; chatty drops the bar
 *  to 0.5; silent gates everything (the predicate short-circuits before
 *  this kicks in). */
const VOLUME_THRESHOLD: Record<AgiVolume, number> = {
  silent: 1.01, // unreachable — guarantees never-show
  quiet: 0.7,
  chatty: 0.5,
};

/**
 * The single decision function. Pure — no DOM, no fetch, no clock besides
 * `Date.now()` injected via opts.now (so tests can pin it).
 *
 *   1. silent volume    → false
 *   2. muted channel    → false
 *   3. confidence < min → false (HARD floor; volume can't override this)
 *   4. confidence < volume threshold → false
 *   5. dismissed in last 24h → false
 *   6. throttled in last 24h → false
 *   7. else true
 *
 * The `agiConfidenceThreshold` from store is the user-tunable bar that
 * sits *on top of* the hard MIN_CONFIDENCE floor; we honour both — the
 * higher wins.
 */
export function shouldShowReaction(opts: {
  surfaceId: string;
  channel: AmbientChannel;
  reactionConfidence: number;
  agiVolume: AgiVolume;
  /** `ui.mutedAgiChannels` from the store. Stringly typed so we don't
   *  drag the AmbientChannel enum across the React boundary. */
  mutedChannels: string[];
  /** Surface ids the user dismissed in the last 24h. The store prunes
   *  older entries on hydrate; we still re-check Date.now() here so a
   *  long-running session doesn't surface stale reactions. */
  dismissedToday: string[];
  /** In-memory throttle table: surfaceId → last reaction ts. */
  throttle: Map<string, number>;
  /** User-tunable threshold (Settings → AGI). Defaults to 0.7. */
  userThreshold?: number;
  now?: number;
}): boolean {
  const now = opts.now ?? Date.now();
  if (opts.agiVolume === "silent") return false;
  if (opts.mutedChannels.includes(opts.channel)) return false;
  if (opts.reactionConfidence < MIN_CONFIDENCE) return false;
  const userBar = opts.userThreshold ?? MIN_CONFIDENCE;
  const volumeBar = VOLUME_THRESHOLD[opts.agiVolume];
  // Take the max of the user bar + the volume bar — both are floors. The
  // hardcoded MIN_CONFIDENCE was already checked above, so we don't need
  // to re-include it.
  const effectiveBar = Math.max(userBar, volumeBar);
  if (opts.reactionConfidence < effectiveBar) return false;
  if (opts.dismissedToday.includes(opts.surfaceId)) return false;
  const last = opts.throttle.get(opts.surfaceId);
  if (last !== undefined && now - last < THROTTLE_24H_MS) return false;
  return true;
}

/**
 * Prune dismiss entries older than 24h. Called from the store hydrate path
 * + each time the observer is about to consult the dismiss list, so even
 * very long sessions stay accurate.
 */
export function pruneDismissed(
  entries: DismissEntry[],
  now: number = Date.now(),
): DismissEntry[] {
  return entries.filter((e) => now - e.dismissedAt < THROTTLE_24H_MS);
}

/**
 * Derive a stable surface id for a given input element. Preference:
 *   1. element's `data-ambient-id` attribute (component author opted in)
 *   2. closest ancestor's `data-ambient-id`
 *   3. fallback: a path built from the element's tag chain + its `id` /
 *      `name` attributes. Stable across re-renders for the same DOM.
 */
export function deriveSurfaceId(el: HTMLElement): string {
  const explicit = el.getAttribute("data-ambient-id");
  if (explicit) return explicit;
  const ancestor = el.closest<HTMLElement>("[data-ambient-id]");
  if (ancestor) {
    const id = ancestor.getAttribute("data-ambient-id");
    if (id) return id;
  }
  // Fallback: a coarse path that's stable for the same element across
  // re-renders. Uses tag, optional id, optional name. Not a perfect fingerprint
  // — but in practice surfaces that need a stable id should add the attribute.
  const parts: string[] = [];
  let node: HTMLElement | null = el;
  let depth = 0;
  while (node && depth < 4) {
    const tag = node.tagName.toLowerCase();
    const id = node.id ? `#${node.id}` : "";
    const name = node.getAttribute("name");
    const named = name ? `[name=${name}]` : "";
    parts.unshift(`${tag}${id}${named}`);
    node = node.parentElement;
    depth += 1;
  }
  return `path:${parts.join(">")}`;
}

/**
 * Channel inference from the active route path. The observer doesn't know
 * which route it's running on without help, so we let it pass `pathname`
 * (from `window.location` or React Router) and we compute the channel
 * from the first segment.
 */
export function channelForPath(pathname: string): AmbientChannel {
  const seg = pathname.replace(/^\/+/, "").split("/")[0] ?? "";
  if (seg === "canvas") return "canvas";
  if (seg === "memory") return "memory";
  if (seg === "today") return "today";
  if (seg === "settings") return "settings";
  // Cmd+K palette + everything else falls under "search" — it's the
  // "ephemeral input" bucket.
  return "search";
}

/**
 * Default system prompt the observer sends with every analyze_input call.
 * Kept in this file so tests + the observer reference the exact same
 * string without a circular import.
 */
export const AMBIENT_SYSTEM_PROMPT =
  "You are Tangerine's ambient co-thinker. The user is typing in a regular " +
  "input field. If — and only if — you have a useful reaction worth " +
  "interrupting them with (a relevant memory, a missing follow-up, a " +
  "factual correction), reply with ONE short paragraph (≤2 sentences). " +
  "If you have nothing high-signal to say, reply with the literal token " +
  "'(silent)'. Never repeat the user's text back at them. Never reply with " +
  "filler like 'great point' or 'let me know if'. Default to silence.";

/**
 * The shape returned to the renderer. Confidence is what gates the show
 * decision; text is what we actually render in the card.
 */
export interface AgiReaction {
  text: string;
  confidence: number;
  channel_used: string;
  tool_id: string;
  surface_id: string;
  created_at: number;
}
