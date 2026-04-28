// === wave 20 ===
/**
 * Wave 20 — connected AI tools widget for /today.
 *
 * Reads the AI-tool detection registry (`loadAITools`) and the activity
 * ring buffer to compute "atoms today per tool". Renders one row per
 * tool that's either installed or had at least one atom today; tools that
 * are neither stay collapsed under the [Manage] link in the sidebar.
 *
 * Each row: status dot · vendor name · "X atoms today" or "not connected".
 *
 * Defensive: any fetch error renders inline. The widget never blocks on
 * the activity fetch — if it fails we show the tool list without per-tool
 * counts.
 */

import { useEffect, useMemo, useState } from "react";
import {
  activityRecent,
  type ActivityAtomEvent,
} from "@/lib/tauri";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";
import { VENDOR_COLORS } from "@/lib/vendor-colors";
import { DashboardWidget } from "./DashboardWidget";

export function ConnectedToolsWidget() {
  const [tools, setTools] = useState<AIToolStatus[]>([]);
  const [activity, setActivity] = useState<ActivityAtomEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [toolList, recent] = await Promise.all([
          loadAITools(),
          // Best-effort — if this throws we still render the tool list.
          activityRecent({ limit: 50 }).catch(() => [] as ActivityAtomEvent[]),
        ]);
        if (cancelled) return;
        setTools(toolList);
        setActivity(recent);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bucket activity by vendor id for fast per-row lookup.
  const atomsByVendor = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of activity) {
      if (!ev.vendor) continue;
      const key = ev.vendor.toLowerCase().replace("_", "-");
      m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [activity]);

  // Show: installed tools first, then any tool that produced atoms,
  // de-duped. Cap at 6 rows so the widget doesn't run away.
  const visible = useMemo(() => {
    const installed = tools.filter((t) => t.status === "installed");
    const others = tools
      .filter((t) => t.status !== "installed")
      .filter((t) => (atomsByVendor.get(t.id) ?? 0) > 0);
    return [...installed, ...others].slice(0, 6);
  }, [tools, atomsByVendor]);

  return (
    <DashboardWidget
      testId="dashboard-connected-tools"
      /* === wave 20 wrap-needed === */
      title="Connected tools"
      count={visible.length}
      action={{
        /* === wave 20 wrap-needed === */
        label: "Manage",
        to: "/settings",
      }}
      loading={loading}
      errorMessage={error}
    >
      {visible.length === 0 ? (
        <p
          data-testid="dashboard-connected-tools-empty"
          className="px-1 py-2 text-[12px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          No AI tools connected yet. Connect Cursor, Claude Code, or
          another tool from the sidebar.
        </p>
      ) : (
        <ul className="divide-y divide-stone-200 dark:divide-stone-800">
          {visible.map((t) => {
            const count = atomsByVendor.get(t.id) ?? 0;
            return (
              <li key={t.id}>
                <ToolRow tool={t} atomsToday={count} />
              </li>
            );
          })}
        </ul>
      )}
    </DashboardWidget>
  );
}

function ToolRow({
  tool,
  atomsToday,
}: {
  tool: AIToolStatus;
  atomsToday: number;
}) {
  const dot = vendorDot(tool.id);
  const installed = tool.status === "installed";
  return (
    <div
      data-testid="dashboard-tool-row"
      data-tool-id={tool.id}
      className="flex items-center gap-3 py-2"
    >
      <span
        aria-hidden
        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{
          backgroundColor: installed ? dot : "var(--ti-ink-300, #cbc5b8)",
          opacity: installed ? 1 : 0.4,
        }}
      />
      <p className="min-w-0 flex-1 truncate text-[13px] text-[var(--ti-ink-900)]">
        {tool.name}
      </p>
      <p className="font-mono text-[10px] text-[var(--ti-ink-500)]">
        {installed
          ? /* === wave 20 wrap-needed === */
            `${atomsToday} atoms today`
          : /* === wave 20 wrap-needed === */
            "not connected"}
      </p>
    </div>
  );
}

function vendorDot(vendor: string | null): string {
  if (!vendor) return "var(--ti-orange-500)";
  const key = vendor.toLowerCase().replace("_", "-");
  const c = (VENDOR_COLORS as Record<string, { hex?: string }>)[key];
  if (c && typeof c.hex === "string" && c.hex.length > 0) return c.hex;
  return "var(--ti-orange-500)";
}
// === end wave 20 ===
