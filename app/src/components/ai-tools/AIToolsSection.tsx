import { useEffect, useState } from "react";
import { NavLink } from "react-router-dom";
import { Sparkles, Star } from "lucide-react";
import {
  loadAITools,
  pickPrimary,
  channelLabel,
  type AIToolStatus,
} from "@/lib/ai-tools";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";
// === wave 9 === — vendor color treatment per row. Each tool entry shows
// a circular vendor-color ring around its icon so the rail reads
// cross-vendor at a glance.
// === wave 14 === — vendor color is a dev concept (Cursor blue / Claude
// purple etc.) that adds cognitive load for end users. We drop the
// vendor-color rings here and use plain neutral grey instead. The
// import stays in case other components need it; the active "live"
// dot below is now solid green regardless of vendor.

/**
 * AI TOOLS — first-class sidebar section (v1.8 Phase 1).
 *
 * Lifecycle:
 *   1. On mount, call `detect_ai_tools` (via `loadAITools()`).
 *   2. If no `primaryAITool` is persisted yet, run `pickPrimary()` to choose
 *      the highest-priority `installed` tool and persist it.
 *   3. Re-detect when the window regains focus so installs/uninstalls reflect.
 *
 * Each row links to `/ai-tools/{id}`; the setup page is owned by
 * `components/ai-tools/AIToolSetupPage.tsx` (Agent 3).
 *
 * === wave 9 === — Each row picks up vendor-color treatment:
 *   • icon wrapped in a circular vendor-color ring (`ti-vendor-ring`)
 *   • status dot uses the vendor color when `installed`
 *   • star indicator pinned to right edge for primary tool
 */
export function AIToolsSection() {
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const setPrimaryAITool = useStore((s) => s.ui.setPrimaryAITool);
  const [tools, setTools] = useState<AIToolStatus[] | null>(null);

  useEffect(() => {
    let cancel = false;
    const refresh = () =>
      loadAITools().then((t) => {
        if (cancel) return;
        setTools(t);
        // First-launch auto-pick. We re-read primaryAITool from the store
        // here (via getState) instead of capturing it in deps because we
        // want this to fire only when the persisted value is null — running
        // the picker on every change to primaryAITool would override the
        // user's manual choice the moment they made one.
        const current = useStore.getState().ui.primaryAITool;
        if (current === null) {
          const pick = pickPrimary(t);
          if (pick) setPrimaryAITool(pick);
        }
      });
    void refresh();
    const onFocus = () => void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
      }
    };
  }, [setPrimaryAITool]);

  if (!tools) {
    return (
      <ul>
        <li className="px-2 py-1 font-mono text-[10px] text-stone-400 dark:text-stone-500">
          detecting…
        </li>
      </ul>
    );
  }

  return (
    <ul>
      {tools.map((t) => (
        <li key={t.id}>
          <AIToolLink tool={t} isPrimary={t.id === primaryAITool} />
        </li>
      ))}
    </ul>
  );
}

function AIToolLink({
  tool,
  isPrimary,
}: {
  tool: AIToolStatus;
  isPrimary: boolean;
}) {
  // === wave 14 === — vendor color rings dropped. Plain grey neutral
  // background for the icon. The Sparkles icon stays as the cross-tool
  // glyph; primary star stays. The data-vendor attribute is kept for
  // the test selector (wave 9 contract) but the visual no longer
  // announces vendor.
  return (
    <NavLink
      to={`/ai-tools/${tool.id}`}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2 rounded px-2 py-1 text-[12px]",
          isActive
            ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
            : "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
        )
      }
      title={`${tool.name} · via ${channelLabel(tool.channel)}`}
      data-vendor={tool.id}
      data-testid={`ai-tool-link-${tool.id}`}
    >
      {/* === wave 14 === — plain neutral icon. No vendor ring, no
          vendor-tinted Sparkles. */}
      <span
        aria-hidden
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-stone-100 dark:bg-stone-800"
      >
        <Sparkles size={11} className="text-stone-500 dark:text-stone-400" />
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="truncate">{tool.name}</span>
        <span className="ml-1 font-mono text-[10px] text-stone-400 dark:text-stone-500">
          via {channelLabel(tool.channel)}
        </span>
      </span>
      {isPrimary && (
        <Star
          size={10}
          className="shrink-0 fill-[var(--ti-orange-500)] text-[var(--ti-orange-500)]"
          aria-label="Primary"
          data-testid={`ai-tool-star-${tool.id}`}
        />
      )}
      <StatusDot status={tool.status} />
    </NavLink>
  );
}

/**
 * Status dot. Mirrors the four status verdicts from the Rust detector:
 *   installed             → solid green dot (wave 14 — was vendor color)
 *   needs_setup           → amber dot (installed but not wired up)
 *   browser_ext_required  → amber dot (needs our extension first)
 *   not_installed         → grey dot
 */
function StatusDot({
  status,
}: {
  status: AIToolStatus["status"];
}) {
  // === wave 14 === — installed dot is solid green, vendor-agnostic.
  // The previous wave-9 vendor-color tint added cognitive load (user
  // doesn't care that "Cursor's dot is blue and Claude's is purple").
  // The pulse animation stays so live tools still telegraph activity.
  if (status === "installed") {
    return (
      <span
        className="ti-live-dot h-1.5 w-1.5 shrink-0"
        style={{ background: "var(--ti-green-500, #22c55e)" }}
        title="Installed"
        aria-label="Installed"
        data-testid="ai-tool-status-installed"
      />
    );
  }
  if (status === "needs_setup" || status === "browser_ext_required") {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-ti-warn"
        title={status === "needs_setup" ? "Needs setup" : "Needs browser ext"}
        aria-label={status === "needs_setup" ? "Needs setup" : "Needs browser extension"}
      />
    );
  }
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-700"
      title="Not installed"
      aria-label="Not installed"
    />
  );
}
