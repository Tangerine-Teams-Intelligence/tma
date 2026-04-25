/**
 * State-aware action bar for MD-0. Maps `state` → buttons per APP-INTERFACES.md
 * §3 MD-0 actions.
 */
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import type { MeetingDetail } from "@/lib/tauri";

export function ActionBar({ meeting }: { meeting: MeetingDetail }) {
  const nav = useNavigate();
  const id = meeting.id;

  const buttons: Array<{ label: string; onClick: () => void; variant?: "default" | "outline" | "destructive"; testid: string }> = [];

  switch (meeting.state) {
    case "created":
    case "prepped":
      buttons.push({
        label: "Run prep",
        onClick: () => nav(`/meetings/${id}/live?prep=1`),
        variant: "outline",
        testid: "ab-run-prep",
      });
      buttons.push({
        label: "Start meeting",
        onClick: () => nav(`/meetings/${id}/live`),
        testid: "ab-start",
      });
      break;
    case "live":
      buttons.push({
        label: "Open Live panel",
        onClick: () => nav(`/meetings/${id}/live`),
        testid: "ab-live",
      });
      buttons.push({
        label: "Wrap meeting",
        onClick: () => nav(`/meetings/${id}/live?wrap=1`),
        variant: "destructive",
        testid: "ab-wrap",
      });
      break;
    case "ended":
      buttons.push({
        label: "Wrap",
        onClick: () => nav(`/meetings/${id}/live?wrap=1`),
        testid: "ab-wrap-now",
      });
      break;
    case "wrapped":
      buttons.push({
        label: "Review diff",
        onClick: () => nav(`/meetings/${id}/review`),
        testid: "ab-review",
      });
      break;
    case "reviewed":
      buttons.push({
        label: "Apply",
        onClick: () => nav(`/meetings/${id}/review?apply=1`),
        testid: "ab-apply",
      });
      break;
    case "merged":
      buttons.push({
        label: "Open in editor",
        onClick: () => {
          // Best-effort: route to settings to find target_repo, T3 wires real open.
          void import("@/lib/tauri").then((m) => m.openExternal(`file://${meeting.id}`));
        },
        variant: "outline",
        testid: "ab-open-editor",
      });
      break;
    default:
      // failed_*
      buttons.push({
        label: "Retry",
        onClick: () => {
          /* T3 wires retry */
        },
        variant: "destructive",
        testid: "ab-retry",
      });
      buttons.push({
        label: "Show debug",
        onClick: () => {
          /* opens .tmi/*.log */
        },
        variant: "outline",
        testid: "ab-debug",
      });
  }

  return (
    <div className="flex items-center gap-2" data-testid="action-bar">
      {buttons.map((b) => (
        <Button
          key={b.label}
          variant={b.variant ?? "default"}
          size="sm"
          onClick={b.onClick}
          data-testid={b.testid}
        >
          {b.label}
        </Button>
      ))}
    </div>
  );
}
