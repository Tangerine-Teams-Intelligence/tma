/**
 * v1.8 Phase 4 — global ambient input observer.
 *
 * The CEO's vision: the entire app is a chat surface, but there is no
 * chatbot tab. Any input field — textarea, contenteditable, the Cmd+K
 * search palette — is implicitly an AGI entry point. The user types
 * normally; if the AGI has a high-signal reaction, a small card
 * surfaces in the page margin with a 🍊 dot.
 *
 * This observer is mounted **once** at the AppShell level. It uses a
 * single `document.addEventListener("input", ..., true)` (capture phase)
 * to intercept every input event in the app. That's a deliberate
 * micro-optimization: one listener instead of dozens, and the capture
 * phase guarantees we see the event even if the target stops propagation.
 *
 * Per surface (derived from `data-ambient-id` or a path fallback) we
 * debounce 800ms. After the debounce fires we:
 *   1. Skip if the surface is muted, dismissed, throttled, or we're in
 *      silent volume — see `lib/ambient.ts::shouldShowReaction`.
 *   2. Otherwise call the Tauri `agi_analyze_input` command (which
 *      delegates to `session_borrower::dispatch` with a fixed system
 *      prompt).
 *   3. If the result has confidence ≥ threshold, show an
 *      `<InlineReaction/>` portal anchored to the input element.
 *   4. Stack at most 3 visible reactions per page; older ones are
 *      replaced as new high-confidence reactions land.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useStore } from "@/lib/store";
import { agiAnalyzeInput } from "@/lib/tauri";
import {
  AMBIENT_SYSTEM_PROMPT,
  channelForPath,
  DEBOUNCE_MS,
  deriveSurfaceId,
  shouldShowReaction,
  type AgiReaction,
  type AmbientChannel,
} from "@/lib/ambient";

import { InlineReaction } from "./InlineReaction";

interface ActiveReaction {
  reaction: AgiReaction;
  anchor: HTMLElement;
}

interface AmbientCtx {
  showReaction: (
    surfaceId: string,
    anchorEl: HTMLElement,
    reaction: AgiReaction,
  ) => void;
  dismissReaction: (surfaceId: string) => void;
  reactionsBySurface: Map<string, AgiReaction>;
}

const AmbientContext = createContext<AmbientCtx | null>(null);

/** Public hook: components that own a custom ambient input surface (e.g.
 *  the Canvas freeform editor, owned by P4-B / P4-C) can opt into the
 *  same renderer pipeline by reading this context. */
export function useAmbientCtx(): AmbientCtx {
  const ctx = useContext(AmbientContext);
  if (!ctx) {
    throw new Error("useAmbientCtx outside AmbientInputObserver provider");
  }
  return ctx;
}

const MAX_VISIBLE = 3;

/** Predicate used by the global delegate to decide whether an input
 *  event is one we care about. We skip password / hidden / file inputs
 *  + native form-submitting types we definitely don't want to listen to. */
function isEligibleSurface(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.dataset.ambientIgnore !== undefined) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    const t = (el.type || "text").toLowerCase();
    if (t === "password" || t === "hidden" || t === "file" || t === "checkbox" || t === "radio") {
      return false;
    }
    return true;
  }
  if (el.isContentEditable) return true;
  return false;
}

/** Read the current text from any eligible surface uniformly. */
function readText(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    return el.value;
  }
  return el.innerText ?? "";
}

export function AmbientInputObserver({ children }: { children?: React.ReactNode }) {
  const agiVolume = useStore((s) => s.ui.agiVolume);
  const mutedAgiChannels = useStore((s) => s.ui.mutedAgiChannels);
  const dismissedSurfaces = useStore((s) => s.ui.dismissedSurfaces);
  const agiConfidenceThreshold = useStore((s) => s.ui.agiConfidenceThreshold);
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const rememberDismissed = useStore((s) => s.ui.rememberDismissed);

  // Active reactions, keyed by surface id. Map preserves insertion order
  // — we display the last MAX_VISIBLE.
  const [activeMap, setActiveMap] = useState<Map<string, ActiveReaction>>(
    () => new Map(),
  );

  // Per-surface debounce timers + throttle table. Refs because they need
  // to survive across renders without retriggering effects.
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );
  const throttle = useRef<Map<string, number>>(new Map());

  // We pin the latest copy of every dependency in a ref so the global
  // input listener (installed once on mount) reads the current values
  // without us having to detach/reattach on every state change.
  const policyRef = useRef({
    agiVolume,
    mutedAgiChannels,
    dismissedSurfaces,
    agiConfidenceThreshold,
    primaryAITool,
  });
  useEffect(() => {
    policyRef.current = {
      agiVolume,
      mutedAgiChannels,
      dismissedSurfaces,
      agiConfidenceThreshold,
      primaryAITool,
    };
  }, [
    agiVolume,
    mutedAgiChannels,
    dismissedSurfaces,
    agiConfidenceThreshold,
    primaryAITool,
  ]);

  const dismissReaction = useCallback(
    (surfaceId: string) => {
      rememberDismissed(surfaceId);
      setActiveMap((prev) => {
        if (!prev.has(surfaceId)) return prev;
        const next = new Map(prev);
        next.delete(surfaceId);
        return next;
      });
    },
    [rememberDismissed],
  );

  const showReaction = useCallback(
    (surfaceId: string, anchorEl: HTMLElement, reaction: AgiReaction) => {
      throttle.current.set(surfaceId, Date.now());
      setActiveMap((prev) => {
        const next = new Map(prev);
        // Drop oldest if we're at the cap (Map preserves insertion order).
        next.delete(surfaceId);
        next.set(surfaceId, { reaction, anchor: anchorEl });
        while (next.size > MAX_VISIBLE) {
          const oldest = next.keys().next().value;
          if (oldest === undefined) break;
          next.delete(oldest);
        }
        return next;
      });
    },
    [],
  );

  // Global capture-phase input listener. Installed exactly once.
  useEffect(() => {
    function handler(e: Event) {
      const target = e.target as Element | null;
      if (!isEligibleSurface(target)) return;
      const surfaceId = deriveSurfaceId(target);
      // Snapshot the anchor + text now — by the time the debounce fires
      // the user may have moved focus, but the surface id is stable so
      // we can re-look-up the anchor via DOM query.
      const text = readText(target);
      // Empty text → cancel any pending debounce for this surface (the
      // user cleared the field; no point analysing an empty buffer).
      const existing = debounceTimers.current.get(surfaceId);
      if (existing) clearTimeout(existing);
      if (!text.trim()) return;
      const timer = setTimeout(() => {
        void fire(surfaceId, target as HTMLElement, text);
      }, DEBOUNCE_MS);
      debounceTimers.current.set(surfaceId, timer);
    }

    async function fire(
      surfaceId: string,
      anchor: HTMLElement,
      text: string,
    ) {
      const policy = policyRef.current;
      const channel: AmbientChannel = channelForPath(
        typeof window !== "undefined" ? window.location.pathname : "/",
      );
      // Pre-flight: skip the IPC entirely when we *know* we won't show
      // anything (silent volume, muted channel, dismissed, throttled).
      // We pass a stub confidence above MIN to let the predicate focus
      // on the surface-level gates; the real confidence check happens
      // again after the response.
      const dismissedIds = policy.dismissedSurfaces.map((d) => d.surfaceId);
      const preflight = shouldShowReaction({
        surfaceId,
        channel,
        reactionConfidence: 1.0,
        agiVolume: policy.agiVolume,
        mutedChannels: policy.mutedAgiChannels,
        dismissedToday: dismissedIds,
        throttle: throttle.current,
        userThreshold: policy.agiConfidenceThreshold,
      });
      if (!preflight) return;

      let result;
      try {
        result = await agiAnalyzeInput(
          buildPrompt(text, channel),
          surfaceId,
          policy.primaryAITool ?? undefined,
        );
      } catch {
        // Swallow errors silently — ambient surfacing is opportunistic;
        // a failed call mustn't bubble up to the user.
        return;
      }
      // Explicit silent sentinel from the LLM.
      if (
        result.text.trim() === "(silent)" ||
        result.channel_used === "silent"
      ) {
        return;
      }
      const ok = shouldShowReaction({
        surfaceId,
        channel,
        reactionConfidence: result.confidence,
        agiVolume: policy.agiVolume,
        mutedChannels: policy.mutedAgiChannels,
        dismissedToday: dismissedIds,
        throttle: throttle.current,
        userThreshold: policy.agiConfidenceThreshold,
      });
      if (!ok) return;
      // Anchor may have been removed since we kicked off the IPC — bail
      // gracefully if so.
      if (!anchor.isConnected) return;
      showReaction(surfaceId, anchor, {
        text: result.text,
        confidence: result.confidence,
        channel_used: result.channel_used,
        tool_id: result.tool_id,
        surface_id: surfaceId,
        created_at: Date.now(),
      });
    }

    document.addEventListener("input", handler, true);
    return () => {
      document.removeEventListener("input", handler, true);
      for (const t of debounceTimers.current.values()) clearTimeout(t);
      debounceTimers.current.clear();
    };
  }, [showReaction]);

  // Public ctx for surfaces that want to manually trigger a reaction
  // (Canvas freeform editor in P4-B / P4-C).
  const ctx: AmbientCtx = useMemo(() => {
    const reactionsBySurface = new Map<string, AgiReaction>();
    for (const [k, v] of activeMap.entries()) reactionsBySurface.set(k, v.reaction);
    return {
      showReaction,
      dismissReaction,
      reactionsBySurface,
    };
  }, [activeMap, dismissReaction, showReaction]);

  // Render the active reaction cards. Each one stacks vertically on the
  // same anchor; cards on different anchors render in their own positions.
  const visible = Array.from(activeMap.values()).slice(-MAX_VISIBLE);

  return (
    <AmbientContext.Provider value={ctx}>
      {children}
      {visible.map((entry, idx) => (
        <InlineReaction
          key={entry.reaction.surface_id}
          reaction={entry.reaction}
          anchor={entry.anchor}
          stackOffset={idx * 56}
          onDismiss={() => dismissReaction(entry.reaction.surface_id)}
        />
      ))}
    </AmbientContext.Provider>
  );
}

/**
 * Build the user prompt for the analyze call. We prepend a small context
 * line ("user is typing in the {channel} surface") so the model can tune
 * its reaction. The system prompt itself lives in `lib/ambient.ts` so
 * the Rust side and the React side reference the same string.
 */
function buildPrompt(text: string, channel: AmbientChannel): string {
  const ctx = `[surface=${channel}]`;
  return `${AMBIENT_SYSTEM_PROMPT}\n\n${ctx}\nUser is typing:\n${text}`;
}
