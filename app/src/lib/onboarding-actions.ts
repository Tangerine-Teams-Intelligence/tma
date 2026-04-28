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

// === v1.13.7 round-7 ===
// Round 7 audit: this used to be a `Promise<void>` that the OnboardingChat
// CTA button discarded with `void completeFrontendAction(action)`. Result:
// a user clicking "Open" on a github_oauth / discord_bot_guide /
// whisper_download action card would see NOTHING happen if `openExternal`
// or `downloadWhisperModel` rejected (e.g. shell plugin not granted, no
// disk space, network down). The setup funnel is load-bearing for the
// CEO's Solo+Team funnel pillar — silent click = "Tangerine is broken"
// trust collapse on first run. Returning a discriminated-union result
// lets the caller surface the failure as a toast/inline error without
// destabilising the chat dispatch loop (we don't throw because the chat
// keeps running and a single click failure shouldn't blow up the whole
// transcript).
export type FrontendActionResult =
  | { ok: true }
  | { ok: false; error: string };
// === end v1.13.7 round-7 ===

/**
 * Frontend-side completion. Some action kinds can't be fully run from the
 * backend — the user needs to click through OAuth, see the Discord portal,
 * etc. Returns a `FrontendActionResult`; the caller is expected to render
 * any resulting toast / notification (success or failure).
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
): Promise<FrontendActionResult> {
  // === v1.13.7 round-7 === — wrap each Tauri call so a thrown error
  // returns a structured failure instead of an unhandled promise rejection.
  try {
    switch (action.kind) {
      case "whisper_download": {
        const size = parseWhisperSize(action.detail);
        // Fire and forget — caller renders the progress UI from
        // `onEvent` if it cares. Default `onEvent` is a no-op so the
        // chat surface itself can stay simple.
        await downloadWhisperModel(size, () => {});
        return { ok: true };
      }
      case "github_oauth": {
        // The real device-flow lands the user here; they then come back
        // and the existing GitHub flow polls for the token.
        await openExternal("https://github.com/login/device");
        return { ok: true };
      }
      case "discord_bot_guide": {
        await openExternal("https://discord.com/developers/applications");
        return { ok: true };
      }
      case "restart_required":
      case "configure_mcp":
      case "git_remote_set":
      default:
        // These are either already done by the backend or pure user
        // actions with no URL to open. No-op.
        return { ok: true };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  // === end v1.13.7 round-7 ===
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
