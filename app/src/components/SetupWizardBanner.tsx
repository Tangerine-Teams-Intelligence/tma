// === wave 11 ===
/**
 * v1.10.2 — slim banner that nudges fresh installs to set up an LLM
 * channel before the heartbeat starts firing failed dispatches.
 *
 * === v1.15.2 Fix #3 — handshake-aware visibility + CTR telemetry ===
 *
 * v1.15.1 dogfood found two real bugs:
 *
 *   1. The banner self-hid the moment `setupWizardChannelReady === true`
 *      flipped (set when the wizard finished). But the persisted flag is
 *      a one-way latch — if the user's MCP host disconnects later
 *      (Claude Desktop quit / config edited / Cursor crashed) the banner
 *      stays hidden FOREVER even though the channel is broken. The user
 *      sees no nudge and silently lives with a dead brain.
 *
 *   2. Click on "立即配置" / "Set up now" was wired to
 *      `setSetupWizardOpen(true)` which IS honored by AppShell — but we
 *      shipped no telemetry for the click itself, only for the wizard
 *      mount that follows. CTR on the banner CTA was unmeasurable.
 *
 * Fix #3 reshapes the visibility gate around what's TRUE on disk, not a
 * stale latch:
 *
 *   - Hide if `dismissedThisSession` (session-scoped — banner re-appears
 *     on cold launch).
 *   - If `setupWizardChannelReady === false` → ALWAYS show (no handshake
 *     probe needed; we know the channel isn't set up).
 *   - If `setupWizardChannelReady === true` AND the primary channel is
 *     an MCP-sampling tool → poll `mcp_server_handshake(tool_id)`. Hide
 *     iff the handshake returns true; SHOW iff it returns false (the
 *     real channel state contradicts the latch — broken).
 *   - If `setupWizardChannelReady === true` AND the primary channel is
 *     ollama / browser-ext / null → trust the flag (no frontend probe
 *     for those channels yet; HFB lesson — never paint a fake "broken"
 *     state when we have no honest way to verify).
 *
 * Also adds the `setup_wizard_banner_clicked` telemetry event so we can
 * compute CTR independent of mount success.
 *
 * === end v1.15.2 Fix #3 ===
 *
 * Mounted at the AppShell layer in the system-banner stack so it stays
 * visible across route changes. Independent of the WelcomeOverlay (4-C)
 * and the auto-trigger of SetupWizard on first launch — those are
 * one-shot first-run nudges; this banner is the persistent reminder
 * for users who skipped the auto-trigger.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import { mcpServerHandshake } from "@/lib/tauri";

// === v1.15.2 Fix #3 ===
// Re-probe the handshake every 30s while the banner is mounted. Cheap
// (one IPC) and only fires when `setupWizardChannelReady === true` and
// the primary channel is an MCP-sampling tool. Outside Tauri the mock
// in tauri.ts answers `false`, which is the honest "no live bridge"
// answer — but unit tests override via `vi.spyOn(...)`.
const HANDSHAKE_REPROBE_MS = 30_000;

/** Parse `mcp_sampling/{tool_id}` → tool_id; return null for any other shape. */
function extractMcpToolId(primaryChannel: string | null): string | null {
  if (!primaryChannel) return null;
  if (!primaryChannel.startsWith("mcp_sampling/")) return null;
  const id = primaryChannel.slice("mcp_sampling/".length).trim();
  return id.length > 0 ? id : null;
}
// === end v1.15.2 Fix #3 ===

export function SetupWizardBanner() {
  const { t } = useTranslation();
  const channelReady = useStore((s) => s.ui.setupWizardChannelReady);
  const primaryChannel = useStore((s) => s.ui.setupWizardPrimaryChannel);
  const dismissedThisSession = useStore(
    (s) => s.ui.setupWizardDismissedThisSession,
  );
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  const setSetupWizardDismissedThisSession = useStore(
    (s) => s.ui.setSetupWizardDismissedThisSession,
  );

  // === v1.15.2 Fix #3 ===
  // Mirror of the live handshake state. `null` = haven't probed yet,
  // `true` = probe came back ok, `false` = probe came back broken.
  // We render the banner whenever the latch + probe disagree (latch
  // says ready, probe says broken).
  const [handshakeOk, setHandshakeOk] = useState<boolean | null>(null);
  // Stable ref to the probe so the polling effect can call it without
  // resubscribing on every render.
  const mountedRef = useRef(true);

  const mcpToolId = extractMcpToolId(primaryChannel);
  // We only poll when:
  //   - the latch says we should be ready (otherwise the banner
  //     is already showing for the right reason — no need to probe), AND
  //   - the primary channel is mcp-sampling (the only frontend probe
  //     we have today).
  const shouldProbe = channelReady && mcpToolId !== null;

  useEffect(() => {
    mountedRef.current = true;
    if (!shouldProbe) {
      // Reset so a flag flip from true→false→true doesn't leave a stale
      // "broken" reading hanging around.
      setHandshakeOk(null);
      return () => {
        mountedRef.current = false;
      };
    }
    const probe = async () => {
      try {
        const ok = await mcpServerHandshake(mcpToolId!);
        if (mountedRef.current) setHandshakeOk(ok);
      } catch {
        // Honesty rule: a thrown probe is real evidence of brokenness.
        // Surface it as "not ok" so the banner reappears.
        if (mountedRef.current) setHandshakeOk(false);
      }
    };
    void probe();
    const id = window.setInterval(() => void probe(), HANDSHAKE_REPROBE_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(id);
    };
  }, [shouldProbe, mcpToolId]);
  // === end v1.15.2 Fix #3 ===

  // Self-hide for users who explicitly dismissed for this session.
  // `dismissedThisSession` resets on cold launch so the banner returns
  // every time the user re-opens the app with a still-broken channel.
  if (dismissedThisSession) return null;

  // === v1.15.2 Fix #3 ===
  // Honesty visibility gate.
  //
  //   - shouldProbe = false   →   trust the latch alone
  //                                (no mcp tool to verify against).
  //   - shouldProbe = true    →   require BOTH the latch AND a
  //                                successful handshake before hiding.
  //                                A null handshakeOk (still probing on
  //                                first mount) keeps the latch behavior:
  //                                we don't want to FLASH the banner on
  //                                every cold launch while the first
  //                                probe is in flight, so we hide
  //                                optimistically and re-show iff the
  //                                probe definitively returns false.
  if (!shouldProbe) {
    if (channelReady) return null;
  } else {
    if (handshakeOk !== false) return null;
  }
  // === end v1.15.2 Fix #3 ===

  return (
    <div
      data-testid="setup-wizard-banner"
      className="ti-no-select flex flex-wrap items-center gap-3 border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-4 py-2 text-[12px] text-[var(--ti-orange-700)] dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900 dark:text-[var(--ti-orange-500)]"
    >
      <Sparkles size={14} className="shrink-0" aria-hidden />
      <span className="flex-1 leading-relaxed">{t("setupWizard.bannerText")}</span>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => {
            // === v1.15.2 Fix #3 ===
            // Emit BOTH events: `_clicked` for CTR analytics (fires
            // unconditionally on every click), `_open` for the wizard
            // mount audit (kept for back-compat with the wave-11 funnel).
            void logEvent("setup_wizard_banner_clicked", {
              channel_ready_flag: channelReady,
              primary_channel: primaryChannel,
            });
            void logEvent("setup_wizard_banner_open", {});
            // === end v1.15.2 Fix #3 ===
            setSetupWizardOpen(true);
          }}
          data-testid="setup-wizard-banner-open"
        >
          {t("setupWizard.bannerOpen")}
        </Button>
        <button
          type="button"
          aria-label={t("setupWizard.bannerDismiss")}
          data-testid="setup-wizard-banner-dismiss"
          onClick={() => {
            void logEvent("setup_wizard_banner_dismissed", {});
            setSetupWizardDismissedThisSession(true);
          }}
          className="inline-flex h-6 w-6 items-center justify-center rounded text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-100)] dark:hover:bg-stone-800"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// === end wave 11 ===
