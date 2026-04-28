// === wave 18 ===
/**
 * v1.10.4 — onboarding-action helpers.
 *
 * Pure helpers that map an `OnboardingAction.kind` returned by the Rust
 * `onboarding_chat_turn` command to:
 *   - the Lucide icon the React side renders inside the inline action card
 *   - a human-friendly title (i18n-keyed) shown above the `detail` line
 *   - a frontend-side completion handler for the actions the backend can't
 *     finish on its own (open OAuth URL, surface restart hint, kick off the
 *     real Whisper download via the existing `download_whisper_model`
 *     command, etc.)
 *
 * Splitting this out of OnboardingChat.tsx keeps the component focused on
 * rendering + chat state and lets the action map grow without ballooning
 * the JSX. The shape is intentionally small — no React state, no JSX —
 * because every helper here gets unit-tested standalone.
 */

import {
  Cpu,
  GitBranch,
  Download,
  MessageCircle,
  Github,
  RotateCw,
  AlertTriangle,
  type LucideIcon,
} from "lucide-react";

import type { OnboardingAction } from "./tauri";
import { downloadWhisperModel, openExternal } from "./tauri";

/** Stable list of action kinds the backend can return. Used by the
 *  switch statements below + by the onboarding-actions test to assert
 *  every kind has a renderer. */
export const ONBOARDING_ACTION_KINDS = [
  "configure_mcp",
  "git_remote_set",
  "whisper_download",
  "discord_bot_guide",
  "github_oauth",
  "restart_required",
] as const;

export type OnboardingActionKind = (typeof ONBOARDING_ACTION_KINDS)[number];

/** Lucide icon for each action kind. Unknown kinds get the warning sign so
 *  it's visually obvious the model returned something we don't render. */
export function actionIcon(kind: string): LucideIcon {
  switch (kind) {
    case "configure_mcp":
      return Cpu;
    case "git_remote_set":
      return GitBranch;
    case "whisper_download":
      return Download;
    case "discord_bot_guide":
      return MessageCircle;
    case "github_oauth":
      return Github;
    case "restart_required":
      return RotateCw;
    default:
      return AlertTriangle;
  }
}

/** Short title for each action kind. The React side renders this in the
 *  card header above the `detail` line. We don't i18n here — these labels
 *  are short and stable; the i18n keys for the surrounding chat shell live
 *  in `onboardingChat.*`. */
export function actionTitle(kind: string): string {
  switch (kind) {
    case "configure_mcp":
      return "Configure MCP";
    case "git_remote_set":
      return "Link GitHub repo";
    case "whisper_download":
      return "Download Whisper model";
    case "discord_bot_guide":
      return "Set up Discord bot";
    case "github_oauth":
      return "Authorize GitHub";
    case "restart_required":
      return "Restart your editor";
    default:
      return kind;
  }
}

/** Color hints — drives the card's left-border + status dot. Mirrors the
 *  spec's "✓ green / ⏳ yellow / ✗ red" mapping. */
export function actionStatusColor(
  status: string,
): "green" | "yellow" | "red" | "stone" {
  switch (status) {
    case "succeeded":
      return "green";
    case "pending":
    case "executing":
      return "yellow";
    case "failed":
      return "red";
    default:
      return "stone";
  }
}

/** Human label for the status line (no i18n — short stable strings). */
export function actionStatusLabel(status: string): string {
  switch (status) {
    case "succeeded":
      return "Done";
    case "executing":
      return "Running…";
    case "pending":
      return "Next step";
    case "failed":
      return "Failed";
    default:
      return status;
  }
}

/**
 * Frontend-side completion. Some action kinds can't be fully run from the
 * backend — the user needs to click through OAuth, see the Discord portal,
 * etc. Returns a Promise<void>; the caller is expected to render any
 * resulting toast / notification.
 *
 * `whisper_download`: the Rust backend marks the action `pending` because
 * it doesn't want to block the chat reply on a 244MB download — the
 * frontend kicks off the real progress-streaming command here. The model
 * size is parsed back out of the `detail` line ("Download Whisper small
 * model (~244MB)").
 *
 * `github_oauth`: opens the GitHub device-flow URL in the user's default
 * browser. The actual token exchange is owned by the existing
 * `github_device_flow_*` commands; the chat just hands off to that flow.
 *
 * `discord_bot_guide` / `restart_required`: both are pure user actions —
 * we surface the relevant URL or hint and the user takes the step in
 * their own time.
 */
export async function completeFrontendAction(
  action: OnboardingAction,
): Promise<void> {
  switch (action.kind) {
    case "whisper_download": {
      const size = parseWhisperSize(action.detail);
      // Fire and forget — caller renders the progress UI from
      // `onEvent` if it cares. Default `onEvent` is a no-op so the
      // chat surface itself can stay simple.
      await downloadWhisperModel(size, () => {});
      return;
    }
    case "github_oauth": {
      // The real device-flow lands the user here; they then come back
      // and the existing GitHub flow polls for the token.
      await openExternal("https://github.com/login/device");
      return;
    }
    case "discord_bot_guide": {
      await openExternal("https://discord.com/developers/applications");
      return;
    }
    case "restart_required":
    case "configure_mcp":
    case "git_remote_set":
    default:
      // These are either already done by the backend or pure user
      // actions with no URL to open. No-op.
      return;
  }
}

/** Pull "small" / "base" / "medium" out of a whisper_download detail line.
 *  Defaults to "small" so a malformed detail doesn't throw. */
export function parseWhisperSize(
  detail: string,
): "small" | "base" | "medium" {
  if (/medium/i.test(detail)) return "medium";
  if (/base/i.test(detail)) return "base";
  return "small";
}
// === end wave 18 ===
