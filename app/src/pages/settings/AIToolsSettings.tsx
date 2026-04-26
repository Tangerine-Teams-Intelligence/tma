/**
 * v1.8 Phase 1 — "Primary AI Tool" picker.
 *
 * In v1.8 Tangerine borrows the user's existing AI tool subscriptions
 * instead of holding its own API key. The user picks ONE tool as primary —
 * the co-thinker brain uses that tool to think. If primary is unreachable
 * we fall through `AI_TOOL_PRIORITY` until something answers.
 *
 * This tab does three things:
 *   1. Calls `loadAITools()` (Rust `detect_ai_tools`) on mount + on
 *      "Re-detect" click.
 *   2. Renders click-to-select cards for every detected `installed` tool
 *      (plus Ollama if reachable). Browser-ext-only and not-installed
 *      tools are filtered out — we surface them in the per-tool setup
 *      pages (Phase 2, owned by Agent 3).
 *   3. On first launch (when `primaryAITool === null`), auto-picks the
 *      highest-priority installed tool. The effect is keyed on
 *      `primaryAITool` so a user who explicitly clears the pick won't get
 *      it auto-restored on the next render.
 */

import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  AI_TOOL_PRIORITY,
  type AIToolStatus,
  loadAITools,
  pickPrimary,
} from "@/lib/ai-tools";

export function AIToolsSettings() {
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const setPrimaryAITool = useStore((s) => s.ui.setPrimaryAITool);

  const [tools, setTools] = useState<AIToolStatus[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // Detect on mount + every time the user hits "Re-detect".
  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loadAITools();
      setTools(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // refresh is stable enough for this single-shot mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-launch auto-pick: if the user hasn't chosen yet AND we have a
  // detection result, land the first installed tool from priority order.
  // Keyed on `primaryAITool` (only fires while it's still null) and `tools`
  // (so it runs once detection returns).
  useEffect(() => {
    if (primaryAITool !== null) return;
    if (tools.length === 0) return;
    const pick = pickPrimary(tools);
    if (pick) setPrimaryAITool(pick);
  }, [primaryAITool, tools, setPrimaryAITool]);

  // Pickable rows = every "installed" tool. Ollama becomes "installed" only
  // when the local HTTP probe succeeds, so this filter naturally hides it
  // when ollama isn't running.
  const pickable = tools.filter((t) => t.status === "installed");

  // Fallback preview = priority order minus the primary, restricted to
  // installed tools (no point listing things the co-thinker can't reach).
  const fallback = AI_TOOL_PRIORITY.filter(
    (id) => id !== primaryAITool && pickable.some((t) => t.id === id)
  );

  return (
    <div className="flex flex-col gap-6" data-testid="st-ai-tools">
      <section>
        <h3 className="font-display text-lg">Primary AI tool</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Co-thinker uses this AI to think. Tangerine borrows your subscription —
          no API key needed.
        </p>

        <div className="mt-4 flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            data-testid="st-ai-redetect"
          >
            {loading ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <RefreshCw size={14} />
            )}
            Re-detect
          </Button>
          {error ? (
            <span className="text-xs text-[#B83232]">{error}</span>
          ) : null}
        </div>

        <div className="mt-4 flex flex-col gap-2" role="radiogroup" aria-label="Primary AI tool">
          {loading && pickable.length === 0 ? (
            <p className="text-sm text-[var(--ti-ink-500)]">Detecting…</p>
          ) : pickable.length === 0 ? (
            <p className="text-sm text-[var(--ti-ink-500)]">
              No AI tools detected on this machine. Install one of{" "}
              {AI_TOOL_PRIORITY.slice(0, 4).join(", ")} and re-detect.
            </p>
          ) : (
            pickable.map((t) => {
              const checked = primaryAITool === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setPrimaryAITool(t.id)}
                  data-testid={`st-ai-pick-${t.id}`}
                  className={
                    "flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors duration-fast " +
                    (checked
                      ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-ink-900)]"
                      : "border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
                  }
                >
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden
                      className={
                        "inline-block h-3 w-3 rounded-full border " +
                        (checked
                          ? "border-[var(--ti-orange-600)] bg-[var(--ti-orange-500)]"
                          : "border-[var(--ti-border-default)] bg-transparent")
                      }
                    />
                    <span className="font-medium">{t.name}</span>
                    <span className="text-xs text-[var(--ti-ink-500)]">
                      via {channelShort(t.channel)}
                    </span>
                  </span>
                  {checked ? (
                    <span className="text-xs text-[var(--ti-orange-700)]">Primary</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>

        {fallback.length > 0 ? (
          <p className="mt-3 text-xs text-[var(--ti-ink-500)]">
            If primary is unreachable: {fallback.join(" → ")}
          </p>
        ) : null}
      </section>
    </div>
  );
}

function channelShort(c: AIToolStatus["channel"]): string {
  switch (c) {
    case "mcp":
      return "MCP";
    case "browser_ext":
      return "browser ext";
    case "ide_plugin":
      return "IDE plugin";
    case "local_http":
      return "local HTTP";
  }
}
