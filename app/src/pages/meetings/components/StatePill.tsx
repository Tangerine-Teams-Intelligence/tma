/**
 * State pill — color-coded by INTERFACES.md state machine.
 */
import type { MeetingStateName } from "@/lib/tauri";

const COLORS: Record<MeetingStateName, { bg: string; fg: string; label: string; pulse?: boolean }> = {
  created: { bg: "#E7E5E4", fg: "#44403C", label: "Created" },
  prepped: { bg: "#DBEAFE", fg: "#1E40AF", label: "Prepped" },
  live: { bg: "#D1FAE5", fg: "#065F46", label: "Live", pulse: true },
  ended: { bg: "#FEF3C7", fg: "#92400E", label: "Ended" },
  wrapped: { bg: "#EDE9FE", fg: "#5B21B6", label: "Wrapped" },
  reviewed: { bg: "#FCE7F3", fg: "#9D174D", label: "Reviewed" },
  merged: { bg: "#FFE8D6", fg: "#A03F00", label: "Merged" },
  failed_bot: { bg: "#FEE2E2", fg: "#991B1B", label: "Failed (bot)" },
  failed_observer: { bg: "#FEE2E2", fg: "#991B1B", label: "Failed (observer)" },
  failed_wrap: { bg: "#FEE2E2", fg: "#991B1B", label: "Failed (wrap)" },
  failed_apply: { bg: "#FEE2E2", fg: "#991B1B", label: "Failed (apply)" },
};

export function StatePill({ state }: { state: MeetingStateName }) {
  const c = COLORS[state];
  return (
    <span
      data-testid={`state-pill-${state}`}
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium"
      style={{ background: c.bg, color: c.fg }}
    >
      {c.pulse && <span className="ti-live-dot" aria-hidden />}
      {c.label}
    </span>
  );
}
