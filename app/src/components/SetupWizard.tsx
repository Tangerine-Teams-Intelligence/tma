// === wave 11 ===
/**
 * v1.10.2 — first-run LLM channel setup wizard.
 *
 * The single biggest UX gap blocking real-user adoption: a fresh install
 * lands on /today, the heartbeat fires within ~5 min and tries to call an
 * LLM via session_borrower (3 channels: MCP sampling / Browser ext /
 * Ollama HTTP). All 3 channels fail by default — the user sees a cryptic
 * "心跳失败" toast with no actionable path forward.
 *
 * SetupWizard fixes this with a 5-step guided flow:
 *
 *   1. Welcome      — "Set up your AGI brain in 60 seconds" + Skip link.
 *   2. Detect       — calls `setup_wizard_detect` and renders results.
 *                     Highlights the recommended easiest path. The user
 *                     can pick an alternative.
 *   3. Configure    — varies by selection. For MCP tools we offer
 *                     auto-configure (writes a `tangerine` entry to
 *                     mcp.json) or "show me the snippet" for manual paste.
 *                     For Ollama we just confirm. For "no channel" we
 *                     show install hints + a Re-detect button.
 *   4. Test         — sends a fixed prompt through `session_borrower`
 *                     and shows the response preview + latency. On fail
 *                     the user can Retry or pick a different channel.
 *   5. Done         — flips `setup_wizard.channel_ready` so the banner
 *                     and heartbeat error toast hide.
 *
 * Mounted by AppShell (only auto-shows on first cold launch after the
 * WelcomeOverlay closes). Also opened on demand from:
 *   - the Cmd+K palette ("Set up LLM channel")
 *   - the SetupWizardBanner ("Set up now")
 *   - the heartbeat-fail toast ("Set up channel" CTA)
 *
 * Defensive: every Tauri call is wrapped in try/catch with a safe
 * fallback (post-Wave-10.1 lesson — a thrown render-time exception in
 * this overlay would blank the whole shell since SetupWizard sits at
 * the top of the z-stack).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Sparkles,
  RotateCw,
  Check,
  X,
  ChevronRight,
  ExternalLink,
  Copy,
  Server,
  Brain,
  Globe,
  Cloud,
  AlertCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";
import {
  setupWizardDetect,
  setupWizardAutoConfigureMcp,
  setupWizardTestChannel,
  setupWizardInstallOllamaHint,
  setupWizardPersistState,
  type SetupWizardDetection,
  type SetupWizardTestResult,
  type RecommendedChannel,
  type DetectedMcpTool,
  type InstallHintResult,
  // === wave 11.1 ===
  type SetupWizardDiagnostic,
  // === wave 13 ===
  // Wave 13 — Step 5 sample query CTA. We dispatch through the same
  // co-thinker bridge the rest of the app uses so a successful sample
  // query proves the wizard's just-configured channel actually works.
  coThinkerDispatch,
  type LlmResponse,
  // === end wave 13 ===
} from "@/lib/tauri";

type WizardStep = "welcome" | "detect" | "configure" | "test" | "done";

/**
 * The user's selected channel — set on the Detect step + carried through
 * Configure → Test → Done. Mirrors the shape of `RecommendedChannel`
 * but without the "no_channel_available" variant (the Configure step
 * branches into install-hints when there's nothing to use yet).
 */
type SelectedChannel =
  | { kind: "mcp_sampling"; tool_id: string; config_path: string }
  | { kind: "ollama_http"; default_model: string }
  | { kind: "browser_ext" }
  | { kind: "install_required" };

interface SetupWizardProps {
  /** When true, the wizard renders as a full-screen overlay. */
  open: boolean;
  /** Close handler. Called from Skip + the X button + step 5 CTA. */
  onClose: () => void;
}

export function SetupWizard({ open, onClose }: SetupWizardProps) {
  const { t } = useTranslation();
  const setSetupWizardChannelReady = useStore(
    (s) => s.ui.setSetupWizardChannelReady,
  );
  const setSetupWizardSkipped = useStore((s) => s.ui.setSetupWizardSkipped);
  const setSetupWizardPrimaryChannel = useStore(
    (s) => s.ui.setSetupWizardPrimaryChannel,
  );
  const setPrimaryAITool = useStore((s) => s.ui.setPrimaryAITool);

  const [step, setStep] = useState<WizardStep>("welcome");
  const [detection, setDetection] = useState<SetupWizardDetection | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [detectError, setDetectError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedChannel | null>(null);
  const [autoConfigStatus, setAutoConfigStatus] = useState<
    "idle" | "writing" | "ok" | "error"
  >("idle");
  const [autoConfigPath, setAutoConfigPath] = useState<string | null>(null);
  const [autoConfigError, setAutoConfigError] = useState<string | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const [testResult, setTestResult] = useState<SetupWizardTestResult | null>(
    null,
  );
  const [testing, setTesting] = useState(false);
  const [installHint, setInstallHint] = useState<InstallHintResult | null>(
    null,
  );

  // Reset transient state on every fresh open. Persisted facts
  // (channel_ready / primary_channel) stay where they were.
  useEffect(() => {
    if (!open) return;
    setStep("welcome");
    setDetection(null);
    setDetectError(null);
    setSelected(null);
    setAutoConfigStatus("idle");
    setAutoConfigPath(null);
    setAutoConfigError(null);
    setShowSnippet(false);
    setTestResult(null);
    void logEvent("setup_wizard_opened", {});
  }, [open]);

  // Lazy-load the install hint the first time the user lands on the
  // "no channel" Configure step. Cached for the rest of the wizard
  // session.
  useEffect(() => {
    if (selected?.kind !== "install_required") return;
    if (installHint !== null) return;
    void (async () => {
      try {
        const hint = await setupWizardInstallOllamaHint();
        setInstallHint(hint);
      } catch (e) {
        // Non-fatal — the React side renders a generic install link
        // when the hint isn't available.
        // eslint-disable-next-line no-console
        console.error("[setupWizard] install hint failed", e);
      }
    })();
  }, [selected, installHint]);

  // ---- step transitions ----

  const onSkip = () => {
    void logEvent("setup_wizard_skipped", { from_step: step });
    setSetupWizardSkipped(true);
    // Persist so the wizard never auto-prompts again unless the user
    // explicitly re-opens it from Cmd+K or the banner. Tauri-side write
    // is fire-and-forget — failure is logged but doesn't block the close.
    void setupWizardPersistState({
      channelReady: false,
      primaryChannel: null,
      skipped: true,
    }).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[setupWizard] persist skipped state failed", e);
    });
    onClose();
  };

  const onAdvanceToDetect = async () => {
    setStep("detect");
    setDetecting(true);
    setDetectError(null);
    try {
      const det = await setupWizardDetect();
      setDetection(det);
      // Pre-pick the recommended channel so the user can hit Continue
      // without thinking. They can change it before advancing.
      const rec = det.recommended_channel;
      if (rec) {
        setSelected(recommendedToSelected(rec, det.mcp_capable_tools));
      }
    } catch (e) {
      setDetectError(typeof e === "string" ? e : (e as Error).message);
      // eslint-disable-next-line no-console
      console.error("[setupWizard] detect failed", e);
    } finally {
      setDetecting(false);
    }
  };

  const onAutoConfigure = async () => {
    if (selected?.kind !== "mcp_sampling") return;
    setAutoConfigStatus("writing");
    setAutoConfigError(null);
    try {
      const r = await setupWizardAutoConfigureMcp(selected.tool_id);
      setAutoConfigPath(r.file_written);
      if (r.ok) {
        setAutoConfigStatus("ok");
        void logEvent("setup_wizard_auto_configured", {
          tool_id: selected.tool_id,
        });
      } else {
        setAutoConfigStatus("error");
        setAutoConfigError(r.error ?? "unknown error");
      }
    } catch (e) {
      setAutoConfigStatus("error");
      setAutoConfigError(typeof e === "string" ? e : (e as Error).message);
      // eslint-disable-next-line no-console
      console.error("[setupWizard] auto configure failed", e);
    }
  };

  const onAdvanceToTest = async () => {
    if (!selected || selected.kind === "install_required") return;
    setStep("test");
    setTesting(true);
    setTestResult(null);
    try {
      const channel =
        selected.kind === "mcp_sampling"
          ? "mcp_sampling"
          : selected.kind === "ollama_http"
            ? "ollama"
            : "browser_ext";
      const toolId =
        selected.kind === "mcp_sampling" ? selected.tool_id : undefined;
      const r = await setupWizardTestChannel({
        channel,
        toolId,
      });
      setTestResult(r);
      void logEvent("setup_wizard_tested", {
        ok: r.ok,
        channel: r.channel_used,
        latency_ms: r.latency_ms,
      });
    } catch (e) {
      const msg = typeof e === "string" ? e : (e as Error).message;
      setTestResult({
        ok: false,
        channel_used: "error",
        response_preview: "",
        latency_ms: 0,
        error: msg,
      });
      // eslint-disable-next-line no-console
      console.error("[setupWizard] test channel failed", e);
    } finally {
      setTesting(false);
    }
  };

  const onAdvanceToDone = async () => {
    setStep("done");
    if (!selected) return;
    const channelLabel =
      selected.kind === "mcp_sampling"
        ? `mcp_sampling/${selected.tool_id}`
        : selected.kind === "ollama_http"
          ? "ollama"
          : "browser_ext";
    setSetupWizardChannelReady(true);
    setSetupWizardPrimaryChannel(channelLabel);
    // Set the user's primary AI tool so subsequent heartbeats route
    // straight to the channel they just verified.
    if (selected.kind === "mcp_sampling") {
      setPrimaryAITool(selected.tool_id);
    } else if (selected.kind === "ollama_http") {
      setPrimaryAITool("ollama");
    }
    try {
      await setupWizardPersistState({
        channelReady: true,
        primaryChannel: channelLabel,
        skipped: false,
      });
      void logEvent("setup_wizard_completed", { primary_channel: channelLabel });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[setupWizard] persist completed state failed", e);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-stone-950/70 px-4 py-6 backdrop-blur-sm"
      data-testid="setup-wizard"
      aria-modal="true"
      role="dialog"
      aria-labelledby="setup-wizard-title"
    >
      <div className="relative w-full max-w-2xl rounded-lg border border-stone-200 bg-white p-7 shadow-2xl dark:border-stone-800 dark:bg-stone-900">
        <button
          type="button"
          aria-label={t("setupWizard.close")}
          data-testid="setup-wizard-close"
          className="absolute right-4 top-4 inline-flex h-7 w-7 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
          onClick={onClose}
        >
          <X size={14} />
        </button>

        <StepProgress step={step} />

        {step === "welcome" && (
          <WelcomeStep onContinue={() => void onAdvanceToDetect()} onSkip={onSkip} />
        )}

        {step === "detect" && (
          <DetectStep
            detection={detection}
            detecting={detecting}
            error={detectError}
            selected={selected}
            onSelect={setSelected}
            onContinue={() => {
              setStep("configure");
              setShowSnippet(false);
              setAutoConfigStatus("idle");
            }}
            onRetry={() => void onAdvanceToDetect()}
            onSkip={onSkip}
          />
        )}

        {step === "configure" && (
          <ConfigureStep
            selected={selected}
            autoConfigStatus={autoConfigStatus}
            autoConfigPath={autoConfigPath}
            autoConfigError={autoConfigError}
            showSnippet={showSnippet}
            setShowSnippet={setShowSnippet}
            installHint={installHint}
            onAutoConfigure={() => void onAutoConfigure()}
            onContinueAfterRestart={() => void onAdvanceToTest()}
            onContinueOllama={() => void onAdvanceToTest()}
            onReDetect={() => void onAdvanceToDetect()}
            onSkip={onSkip}
          />
        )}

        {step === "test" && (
          <TestStep
            testing={testing}
            result={testResult}
            onRetry={() => void onAdvanceToTest()}
            onPickDifferent={() => setStep("detect")}
            onContinue={() => void onAdvanceToDone()}
            onSkip={onSkip}
          />
        )}

        {step === "done" && <DoneStep onClose={onClose} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function WelcomeStep({
  onContinue,
  onSkip,
}: {
  onContinue: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid="setup-wizard-step-welcome" className="space-y-6">
      <header>
        <p className="ti-section-label">{t("setupWizard.kicker")}</p>
        <h1
          id="setup-wizard-title"
          className="mt-2 text-display-md text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
        >
          {t("setupWizard.welcomeTitle")}
        </h1>
        <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
          {t("setupWizard.welcomeBody")}
        </p>
      </header>

      <div className="rounded-md border border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)]/40 p-4 dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900/40">
        <div className="flex items-start gap-3">
          <Sparkles
            size={18}
            className="mt-0.5 shrink-0 text-[var(--ti-orange-500)]"
          />
          <p className="text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
            {t("setupWizard.welcomeHint")}
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <Button onClick={onContinue} data-testid="setup-wizard-welcome-continue">
          {t("setupWizard.letsGo")}
          <ChevronRight size={16} aria-hidden />
        </Button>
        <button
          type="button"
          onClick={onSkip}
          data-testid="setup-wizard-welcome-skip"
          className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
        >
          {t("setupWizard.skipForLater")}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Detect
// ---------------------------------------------------------------------------

function DetectStep({
  detection,
  detecting,
  error,
  selected,
  onSelect,
  onContinue,
  onRetry,
  onSkip,
}: {
  detection: SetupWizardDetection | null;
  detecting: boolean;
  error: string | null;
  selected: SelectedChannel | null;
  onSelect: (s: SelectedChannel | null) => void;
  onContinue: () => void;
  onRetry: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid="setup-wizard-step-detect" className="space-y-5">
      <header>
        <h2 className="text-display-sm text-[var(--ti-ink-900)]">
          {t("setupWizard.detectTitle")}
        </h2>
        <p className="mt-2 text-[13px] text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
          {t("setupWizard.detectSubtitle")}
        </p>
      </header>

      {detecting && (
        <div
          data-testid="setup-wizard-detect-loading"
          className="flex items-center gap-2 text-[13px] text-stone-600 dark:text-stone-400"
        >
          <RotateCw size={14} className="animate-spin" />
          <span>{t("setupWizard.detecting")}</span>
        </div>
      )}

      {error && !detecting && (
        <div
          data-testid="setup-wizard-detect-error"
          className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[12px] text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300"
        >
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p>{error}</p>
              <button
                type="button"
                className="mt-2 underline underline-offset-2"
                onClick={onRetry}
              >
                {t("setupWizard.retry")}
              </button>
            </div>
          </div>
        </div>
      )}

      {!detecting && !error && detection && (
        <div className="space-y-3" data-testid="setup-wizard-detect-results">
          {/* MCP-capable editors */}
          {detection.mcp_capable_tools.length > 0 ? (
            detection.mcp_capable_tools.map((tool) => {
              const isSelected =
                selected?.kind === "mcp_sampling" &&
                selected.tool_id === tool.tool_id;
              return (
                <ChannelCard
                  key={`mcp-${tool.tool_id}`}
                  testId={`setup-wizard-channel-mcp-${tool.tool_id}`}
                  icon={Brain}
                  title={tool.display_name}
                  subtitle={
                    tool.already_has_tangerine
                      ? t("setupWizard.alreadyConfigured")
                      : t("setupWizard.foundAt", { path: shortenPath(tool.config_path) })
                  }
                  badge={t("setupWizard.recommendedMcp")}
                  selected={isSelected}
                  onClick={() =>
                    onSelect({
                      kind: "mcp_sampling",
                      tool_id: tool.tool_id,
                      config_path: tool.config_path,
                    })
                  }
                />
              );
            })
          ) : (
            <p className="text-[12px] text-stone-500 dark:text-stone-400">
              {t("setupWizard.noEditorFound")}
            </p>
          )}

          {/* Ollama */}
          <ChannelCard
            testId="setup-wizard-channel-ollama"
            icon={Server}
            title="Ollama"
            subtitle={
              detection.ollama_running
                ? detection.ollama_default_model
                  ? t("setupWizard.ollamaRunning", {
                      model: detection.ollama_default_model,
                    })
                  : t("setupWizard.ollamaRunningNoModel")
                : t("setupWizard.ollamaNotRunning")
            }
            badge={
              detection.ollama_running ? t("setupWizard.fallback") : undefined
            }
            disabled={!detection.ollama_running}
            selected={selected?.kind === "ollama_http"}
            onClick={() =>
              detection.ollama_running &&
              onSelect({
                kind: "ollama_http",
                default_model:
                  detection.ollama_default_model ?? "llama3.1:8b",
              })
            }
          />

          {/* Browser ext fallback */}
          {detection.browser_ext_browsers.length > 0 && (
            <ChannelCard
              testId="setup-wizard-channel-browser"
              icon={Globe}
              title={t("setupWizard.browserExt")}
              subtitle={t("setupWizard.browserExtDetected", {
                browser: detection.browser_ext_browsers[0],
              })}
              badge={t("setupWizard.lastResort")}
              selected={selected?.kind === "browser_ext"}
              onClick={() => onSelect({ kind: "browser_ext" })}
            />
          )}

          {/* Cloud */}
          <ChannelCard
            testId="setup-wizard-channel-cloud"
            icon={Cloud}
            title={t("setupWizard.cloud")}
            subtitle={t("setupWizard.cloudComingSoon")}
            disabled
            selected={false}
            onClick={() => undefined}
          />

          {/* Install required fallback — when nothing was detected the
              recommendation is "no_channel_available". Show the user a
              path forward by selecting "install_required". */}
          {!detection.mcp_capable_tools.length &&
            !detection.ollama_running && (
              <ChannelCard
                testId="setup-wizard-channel-install"
                icon={ExternalLink}
                title={t("setupWizard.installSomething")}
                subtitle={t("setupWizard.installSomethingHint")}
                selected={selected?.kind === "install_required"}
                onClick={() => onSelect({ kind: "install_required" })}
              />
            )}
        </div>
      )}

      {!detecting && !error && (
        <div className="flex flex-wrap items-center gap-4 pt-2">
          <Button
            onClick={onContinue}
            disabled={selected === null}
            data-testid="setup-wizard-detect-continue"
          >
            {t("setupWizard.useThis")}
            <ChevronRight size={16} aria-hidden />
          </Button>
          <button
            type="button"
            onClick={onRetry}
            data-testid="setup-wizard-detect-retry"
            className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {t("setupWizard.reDetect")}
          </button>
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {t("setupWizard.skipForLater")}
          </button>
        </div>
      )}
    </section>
  );
}

function ChannelCard({
  testId,
  icon: Icon,
  title,
  subtitle,
  badge,
  selected,
  disabled,
  onClick,
}: {
  testId: string;
  icon: typeof Sparkles;
  title: string;
  subtitle: string;
  badge?: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      data-selected={selected ? "true" : "false"}
      disabled={disabled}
      onClick={onClick}
      className={
        "flex w-full items-start gap-3 rounded-md border p-4 text-left transition-colors duration-fast " +
        (selected
          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] dark:bg-stone-800/60"
          : "border-stone-200 bg-stone-50 hover:border-stone-300 dark:border-stone-700 dark:bg-stone-900 dark:hover:border-stone-600") +
        (disabled ? " cursor-not-allowed opacity-60" : "")
      }
    >
      <Icon size={18} className="mt-0.5 shrink-0 text-stone-700 dark:text-stone-300" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]">
            {title}
          </h3>
          {badge && (
            <span className="rounded bg-[var(--ti-orange-100,#FFE4CD)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
              {badge}
            </span>
          )}
        </div>
        <p className="mt-1 text-[12px] text-stone-600 dark:text-stone-400">
          {subtitle}
        </p>
      </div>
      {selected && (
        <Check
          size={14}
          className="mt-1 shrink-0 text-[var(--ti-orange-500)]"
          aria-hidden
        />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Configure
// ---------------------------------------------------------------------------

function ConfigureStep({
  selected,
  autoConfigStatus,
  autoConfigPath,
  autoConfigError,
  showSnippet,
  setShowSnippet,
  installHint,
  onAutoConfigure,
  onContinueAfterRestart,
  onContinueOllama,
  onReDetect,
  onSkip,
}: {
  selected: SelectedChannel | null;
  autoConfigStatus: "idle" | "writing" | "ok" | "error";
  autoConfigPath: string | null;
  autoConfigError: string | null;
  showSnippet: boolean;
  setShowSnippet: (v: boolean) => void;
  installHint: InstallHintResult | null;
  onAutoConfigure: () => void;
  onContinueAfterRestart: () => void;
  onContinueOllama: () => void;
  onReDetect: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  const snippet = useMemo(() => buildMcpSnippet(), []);

  if (selected === null) {
    return (
      <section
        data-testid="setup-wizard-step-configure"
        className="text-[13px] text-stone-600 dark:text-stone-400"
      >
        {t("setupWizard.noChannelSelected")}
      </section>
    );
  }

  return (
    <section data-testid="setup-wizard-step-configure" className="space-y-5">
      <header>
        <h2 className="text-display-sm text-[var(--ti-ink-900)]">
          {t("setupWizard.configureTitle")}
        </h2>
      </header>

      {selected.kind === "mcp_sampling" && (
        <McpConfigurePane
          toolId={selected.tool_id}
          configPath={selected.config_path}
          autoConfigStatus={autoConfigStatus}
          autoConfigPath={autoConfigPath}
          autoConfigError={autoConfigError}
          showSnippet={showSnippet}
          setShowSnippet={setShowSnippet}
          snippet={snippet}
          onAutoConfigure={onAutoConfigure}
          onContinueAfterRestart={onContinueAfterRestart}
        />
      )}

      {selected.kind === "ollama_http" && (
        <div className="space-y-4" data-testid="setup-wizard-configure-ollama">
          <p className="text-[13px] leading-relaxed text-[var(--ti-ink-700)] dark:text-stone-300">
            {t("setupWizard.ollamaInstructions", {
              model: selected.default_model,
            })}
          </p>
          <Button
            onClick={onContinueOllama}
            data-testid="setup-wizard-configure-ollama-continue"
          >
            {t("setupWizard.continueButton")}
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      )}

      {selected.kind === "browser_ext" && (
        <div
          className="space-y-4"
          data-testid="setup-wizard-configure-browser"
        >
          <p className="text-[13px] leading-relaxed text-[var(--ti-ink-700)] dark:text-stone-300">
            {t("setupWizard.browserInstructions")}
          </p>
          <Button onClick={onContinueOllama}>
            {t("setupWizard.continueButton")}
            <ChevronRight size={16} aria-hidden />
          </Button>
        </div>
      )}

      {selected.kind === "install_required" && (
        <div
          className="space-y-4"
          data-testid="setup-wizard-configure-install"
        >
          <p className="text-[13px] leading-relaxed text-[var(--ti-ink-700)] dark:text-stone-300">
            {t("setupWizard.installInstructions")}
          </p>
          <ul className="space-y-2 text-[13px] text-[var(--ti-ink-700)] dark:text-stone-300">
            <li className="flex items-center gap-2">
              <span aria-hidden className="text-[var(--ti-orange-500)]">·</span>
              <a
                href="https://cursor.com"
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
              >
                {t("setupWizard.installCursor")}
              </a>
            </li>
            {installHint && (
              <li className="flex items-center gap-2">
                <span aria-hidden className="text-[var(--ti-orange-500)]">·</span>
                <a
                  href={installHint.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                >
                  {t("setupWizard.installOllama")}
                </a>
                {installHint.cli && (
                  <code className="ml-2 rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[11px] text-stone-700 dark:bg-stone-800 dark:text-stone-300">
                    {installHint.cli}
                  </code>
                )}
              </li>
            )}
          </ul>
          <Button onClick={onReDetect} data-testid="setup-wizard-install-redetect">
            <RotateCw size={14} />
            {t("setupWizard.iveInstalledRedetect")}
          </Button>
        </div>
      )}

      <div className="border-t border-stone-200 pt-3 dark:border-stone-800">
        <button
          type="button"
          onClick={onSkip}
          className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
        >
          {t("setupWizard.skipForLater")}
        </button>
      </div>
    </section>
  );
}

function McpConfigurePane({
  toolId,
  configPath,
  autoConfigStatus,
  autoConfigPath,
  autoConfigError,
  showSnippet,
  setShowSnippet,
  snippet,
  onAutoConfigure,
  onContinueAfterRestart,
}: {
  toolId: string;
  configPath: string;
  autoConfigStatus: "idle" | "writing" | "ok" | "error";
  autoConfigPath: string | null;
  autoConfigError: string | null;
  showSnippet: boolean;
  setShowSnippet: (v: boolean) => void;
  snippet: string;
  onAutoConfigure: () => void;
  onContinueAfterRestart: () => void;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked — silently no-op. The user can still copy
      // manually from the visible code block.
    }
  };
  return (
    <div className="space-y-4" data-testid="setup-wizard-configure-mcp">
      <p className="text-[13px] leading-relaxed text-[var(--ti-ink-700)] dark:text-stone-300">
        {t("setupWizard.mcpInstructions", {
          tool: toolId,
          path: shortenPath(configPath),
        })}
      </p>

      {autoConfigStatus === "idle" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={onAutoConfigure}
            data-testid="setup-wizard-mcp-auto"
          >
            {t("setupWizard.autoConfigureNow")}
          </Button>
          <button
            type="button"
            onClick={() => setShowSnippet(!showSnippet)}
            data-testid="setup-wizard-mcp-snippet-toggle"
            className="font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {showSnippet
              ? t("setupWizard.hideSnippet")
              : t("setupWizard.showSnippet")}
          </button>
        </div>
      )}

      {autoConfigStatus === "writing" && (
        <div className="flex items-center gap-2 text-[13px] text-stone-600 dark:text-stone-400">
          <RotateCw size={14} className="animate-spin" />
          <span>{t("setupWizard.writing")}</span>
        </div>
      )}

      {autoConfigStatus === "ok" && (
        <div
          className="rounded-md border border-emerald-300 bg-emerald-50 p-3 text-[13px] text-emerald-700 dark:border-emerald-700/50 dark:bg-emerald-950/30 dark:text-emerald-300"
          data-testid="setup-wizard-mcp-written"
        >
          <div className="flex items-start gap-2">
            <Check size={14} className="mt-0.5 shrink-0" />
            <div>
              <p>
                {t("setupWizard.writtenTo", {
                  path: shortenPath(autoConfigPath ?? configPath),
                })}
              </p>
              <p className="mt-1 text-[12px] text-emerald-700/80 dark:text-emerald-300/80">
                {t("setupWizard.restartHint", { tool: toolId })}
              </p>
            </div>
          </div>
        </div>
      )}

      {autoConfigStatus === "error" && (
        <div className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/30 dark:text-rose-300">
          <div className="flex items-start gap-2">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <div>
              <p>{t("setupWizard.autoConfigureFailed")}</p>
              {autoConfigError && (
                <p className="mt-1 font-mono text-[11px]">{autoConfigError}</p>
              )}
              <p className="mt-2 text-[12px]">
                {t("setupWizard.tryManualSnippet")}
              </p>
              <button
                type="button"
                className="mt-2 underline underline-offset-2"
                onClick={() => setShowSnippet(true)}
              >
                {t("setupWizard.showSnippet")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showSnippet && (
        <div
          className="rounded-md border border-stone-200 bg-stone-100 p-3 dark:border-stone-700 dark:bg-stone-800"
          data-testid="setup-wizard-mcp-snippet"
        >
          <div className="flex items-center justify-between pb-2 text-[11px] uppercase tracking-wide text-stone-500 dark:text-stone-400">
            <span>{t("setupWizard.snippetLabel")}</span>
            <button
              type="button"
              onClick={() => void onCopy()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-200 dark:hover:bg-stone-700"
            >
              <Copy size={11} />
              <span>
                {copied ? t("setupWizard.copied") : t("setupWizard.copy")}
              </span>
            </button>
          </div>
          <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-stone-800 dark:text-stone-200">
            {snippet}
          </pre>
          <p className="mt-2 text-[11px] text-stone-500 dark:text-stone-400">
            {t("setupWizard.pasteHint", { path: shortenPath(configPath) })}
          </p>
        </div>
      )}

      {/* === wave 11.1 === explicit restart gate. The original Wave 11
          wizard let the user advance straight from "auto-configure ok" into
          the Test step — but the MCP server only spawns on next editor
          launch, so the test fired against an empty registry and silently
          fell through to Ollama (404). Now we render a numbered restart
          checklist + a primary CTA that explicitly says "I restarted, run
          test". User MUST acknowledge before the test runs. */}
      {(autoConfigStatus === "ok" || showSnippet) && (
        <div
          className="rounded-md border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)]/30 p-4 dark:border-[var(--ti-orange-500)]/40 dark:bg-stone-800/40"
          data-testid="setup-wizard-mcp-restart-gate"
        >
          <h3 className="text-[13px] font-medium text-[var(--ti-ink-900)] dark:text-stone-200">
            {t("setupWizard.restartGateTitle", { tool: displayNameForToolId(toolId) })}
          </h3>
          <ol className="mt-3 space-y-2 text-[12px] text-[var(--ti-ink-700)] dark:text-stone-300">
            <li className="flex gap-2">
              <span aria-hidden className="font-mono text-[var(--ti-orange-500)]">
                1.
              </span>
              <span>
                {t("setupWizard.restartStep1", {
                  tool: displayNameForToolId(toolId),
                })}
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="font-mono text-[var(--ti-orange-500)]">
                2.
              </span>
              <span>
                {t("setupWizard.restartStep2", {
                  tool: displayNameForToolId(toolId),
                })}
              </span>
            </li>
            <li className="flex gap-2">
              <span aria-hidden className="font-mono text-[var(--ti-orange-500)]">
                3.
              </span>
              <span>{t("setupWizard.restartStep3")}</span>
            </li>
          </ol>
          <div className="mt-4">
            <Button
              onClick={onContinueAfterRestart}
              data-testid="setup-wizard-mcp-restarted"
            >
              {t("setupWizard.restartGateCta", {
                tool: displayNameForToolId(toolId),
              })}
              <ChevronRight size={16} aria-hidden />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// === wave 11.1 ===
/** Catalog of pretty display names — must mirror MCP_CATALOG on the Rust
 *  side. Falls back to the raw tool_id for unknown ones. */
function displayNameForToolId(toolId: string): string {
  switch (toolId) {
    case "cursor":
      return "Cursor";
    case "claude-code":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "windsurf":
      return "Windsurf";
    case "ollama":
      return "Ollama";
    default:
      return toolId;
  }
}

// ---------------------------------------------------------------------------
// Step 4 — Test
// ---------------------------------------------------------------------------

function TestStep({
  testing,
  result,
  onRetry,
  onPickDifferent,
  onContinue,
  onSkip,
}: {
  testing: boolean;
  result: SetupWizardTestResult | null;
  onRetry: () => void;
  onPickDifferent: () => void;
  onContinue: () => void;
  onSkip: () => void;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid="setup-wizard-step-test" className="space-y-5">
      <header>
        <h2 className="text-display-sm text-[var(--ti-ink-900)]">
          {t("setupWizard.testTitle")}
        </h2>
        <p className="mt-2 text-[13px] text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
          {t("setupWizard.testSubtitle")}
        </p>
      </header>

      {testing && (
        <div
          className="flex items-center gap-2 text-[13px] text-stone-600 dark:text-stone-400"
          data-testid="setup-wizard-test-loading"
        >
          <RotateCw size={14} className="animate-spin" />
          <span>{t("setupWizard.testing")}</span>
        </div>
      )}

      {!testing && result && result.ok && (
        <div
          className="rounded-md border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-700/50 dark:bg-emerald-950/30"
          data-testid="setup-wizard-test-ok"
        >
          <div className="flex items-start gap-2">
            <Check
              size={16}
              className="mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-emerald-700 dark:text-emerald-300">
                {t("setupWizard.testOk")}
              </p>
              <p className="mt-2 font-mono text-[11px] leading-relaxed text-stone-700 dark:text-stone-300">
                {result.response_preview || "(empty response)"}
              </p>
              <p className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">
                {t("setupWizard.via", {
                  channel: result.channel_used,
                  latency: result.latency_ms,
                })}
              </p>
            </div>
          </div>
        </div>
      )}

      {!testing && result && !result.ok && (
        <div
          className="rounded-md border border-rose-300 bg-rose-50 p-4 dark:border-rose-700/50 dark:bg-rose-950/30"
          data-testid="setup-wizard-test-fail"
        >
          <div className="flex items-start gap-2">
            <AlertCircle
              size={16}
              className="mt-0.5 shrink-0 text-rose-600 dark:text-rose-400"
            />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-rose-700 dark:text-rose-300">
                {t("setupWizard.testFailed")}
              </p>
              {/* === wave 11.1 === Render channel-specific friendly copy
                  driven by the structured `error_kind` from the Rust side.
                  Falls back to the raw `error` string for legacy responses
                  that don't carry a diagnostic. */}
              {result.error && (
                <p className="mt-1 text-[12px] text-rose-700/90 dark:text-rose-300/90">
                  {friendlyErrorCopy(t, result)}
                </p>
              )}
              {/* === wave 11.1 === diagnostic expander */}
              {result.diagnostic && (
                <DiagnosticExpander diagnostic={result.diagnostic} />
              )}
            </div>
          </div>
        </div>
      )}

      {!testing && (
        <div className="flex flex-wrap items-center gap-3 pt-1">
          {result && result.ok ? (
            <Button
              onClick={onContinue}
              data-testid="setup-wizard-test-continue"
            >
              {t("setupWizard.continueButton")}
              <ChevronRight size={16} aria-hidden />
            </Button>
          ) : (
            <>
              <Button
                onClick={onRetry}
                data-testid="setup-wizard-test-retry"
              >
                <RotateCw size={14} />
                {t("setupWizard.retry")}
              </Button>
              <Button
                variant="outline"
                onClick={onPickDifferent}
                data-testid="setup-wizard-test-pick-different"
              >
                {t("setupWizard.pickDifferent")}
              </Button>
            </>
          )}
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto font-mono text-[12px] text-stone-500 underline-offset-2 hover:text-stone-900 hover:underline dark:text-stone-400 dark:hover:text-stone-100"
          >
            {t("setupWizard.skipForLater")}
          </button>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 5 — Done
// ---------------------------------------------------------------------------

function DoneStep({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  // === wave 13 ===
  // Wave 13 — sample query CTA. The user's channel was just verified by
  // Step 4's TestChannel call; this step exercises the bridge end-to-end
  // with a real co-thinker dispatch over the user's sample/team data,
  // showing the answer inline as a chat bubble. Three canned queries
  // are wired so the user can see what populated team data feels like
  // before they land on /today.
  //
  // We render the answer inside the wizard (no nav) so the user keeps
  // the "Take me to /today" CTA visible. State is local to this step —
  // it resets on a fresh wizard open via the parent's reset effect.
  //
  // The 3 query strings live next to the JSX so Wave 12 can wrap them
  // into `setupWizard.sampleQueries.*` keys later without re-finding
  // the source. Marked with `// === wave 13 wrap-needed ===`.
  const SAMPLE_QUERIES: ReadonlyArray<{ id: string; label: string }> = [
    {
      id: "sample-pricing",
      // === wave 13 wrap-needed === — `setupWizard.sampleQueries.pricing`.
      label: "What did our team decide about pricing?",
    },
    {
      id: "sample-sam-claude",
      // === wave 13 wrap-needed === — `setupWizard.sampleQueries.samClaude`.
      label: "Show me Sam's recent work in Claude Code",
    },
    {
      id: "sample-week-summary",
      // === wave 13 wrap-needed === — `setupWizard.sampleQueries.weekSummary`.
      label: "Summarize last week",
    },
  ];

  const [sampleAnswer, setSampleAnswer] = useState<LlmResponse | null>(null);
  const [sampleAnswerError, setSampleAnswerError] = useState<string | null>(
    null,
  );
  const [askingFor, setAskingFor] = useState<string | null>(null);
  const [activeQuery, setActiveQuery] = useState<string | null>(null);

  async function ask(label: string, queryId: string) {
    setAskingFor(queryId);
    setActiveQuery(label);
    setSampleAnswer(null);
    setSampleAnswerError(null);
    void logEvent("setup_wizard_sample_query_clicked", { query_id: queryId });
    try {
      const resp = await coThinkerDispatch({
        system_prompt:
          "You are Tangerine, the team's co-thinker. You have read-only access to the team's memory dir (decisions, timeline, threads). Answer in 3-4 sentences using the sample data — be specific, cite people and dates when you can.",
        user_prompt: label,
        max_tokens: 400,
        temperature: 0.4,
      });
      setSampleAnswer(resp);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setSampleAnswerError(msg || "Co-thinker dispatch failed.");
    } finally {
      setAskingFor(null);
    }
  }
  // === end wave 13 ===

  return (
    <section data-testid="setup-wizard-step-done" className="space-y-5">
      <header>
        <h2 className="text-display-sm text-[var(--ti-ink-900)]">
          {t("setupWizard.doneTitle")}
        </h2>
        <p className="mt-2 text-[13px] text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
          {t("setupWizard.doneBody")}
        </p>
      </header>

      {/* === wave 13 === — sample query CTA. Sits ABOVE the "Take me to
          /today" button so the user proves the wizard's value before
          leaving the overlay. The chat-bubble result renders inline; the
          take-me-to-today button stays visible the whole time. */}
      <div
        className="space-y-3 rounded-md border border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)]/30 p-4 dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900/40"
        data-testid="setup-wizard-sample-query"
      >
        <p className="text-[12px] font-medium text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-500)]">
          {/* === wave 13 wrap-needed === — `setupWizard.sampleQueriesPrompt`. */}
          Try asking your team brain something:
        </p>
        <div className="flex flex-wrap gap-2">
          {SAMPLE_QUERIES.map((q) => (
            <button
              key={q.id}
              type="button"
              onClick={() => void ask(q.label, q.id)}
              disabled={askingFor !== null}
              data-testid={`setup-wizard-sample-query-${q.id}`}
              className="rounded border border-[var(--ti-orange-300,#FFB477)] bg-white px-3 py-1.5 text-left text-[12px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-100,#FFE4CD)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-700"
            >
              {q.label}
            </button>
          ))}
        </div>

        {askingFor !== null && (
          <p
            className="text-[11px] italic text-stone-500 dark:text-stone-400"
            data-testid="setup-wizard-sample-query-pending"
          >
            {/* === wave 13 wrap-needed === — `setupWizard.sampleQueryPending`. */}
            Asking the brain…
          </p>
        )}

        {sampleAnswer && activeQuery && (
          <div
            data-testid="setup-wizard-sample-query-answer"
            className="space-y-2 rounded border border-stone-200 bg-white p-3 dark:border-stone-700 dark:bg-stone-900"
          >
            <p className="text-[11px] font-mono text-stone-500 dark:text-stone-400">
              {/* User bubble */}
              You: <span className="text-stone-700 dark:text-stone-200">{activeQuery}</span>
            </p>
            <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-stone-800 dark:text-stone-200">
              <span className="mr-1" aria-hidden>
                🍊
              </span>
              {sampleAnswer.text}
            </p>
            <p className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
              via {sampleAnswer.channel_used}/{sampleAnswer.tool_id} ·{" "}
              {sampleAnswer.latency_ms}ms
            </p>
          </div>
        )}

        {sampleAnswerError && (
          <div
            data-testid="setup-wizard-sample-query-error"
            className="rounded border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-700 dark:border-rose-700/50 dark:bg-rose-950/40 dark:text-rose-300"
          >
            {/* === wave 13 wrap-needed === — `setupWizard.sampleQueryError`. */}
            Couldn&rsquo;t reach the brain: {sampleAnswerError}
          </div>
        )}
      </div>
      {/* === end wave 13 === */}

      <Button onClick={onClose} data-testid="setup-wizard-done-close">
        {t("setupWizard.takeMeToToday")}
      </Button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function StepProgress({ step }: { step: WizardStep }) {
  const order: WizardStep[] = ["welcome", "detect", "configure", "test", "done"];
  const currentIdx = order.indexOf(step);
  return (
    <div
      className="ti-no-select mb-5 flex items-center gap-1"
      aria-label="Setup progress"
      data-testid="setup-wizard-progress"
    >
      {order.map((s, i) => (
        <div
          key={s}
          data-step={s}
          data-active={i <= currentIdx ? "true" : "false"}
          className={
            "h-1 flex-1 rounded " +
            (i <= currentIdx
              ? "bg-[var(--ti-orange-500)]"
              : "bg-stone-200 dark:bg-stone-700")
          }
        />
      ))}
    </div>
  );
}

function recommendedToSelected(
  rec: RecommendedChannel,
  tools: DetectedMcpTool[],
): SelectedChannel | null {
  switch (rec.kind) {
    case "mcp_sampling": {
      const tool = tools.find((t) => t.tool_id === rec.tool_id);
      return {
        kind: "mcp_sampling",
        tool_id: rec.tool_id,
        config_path: tool?.config_path ?? "",
      };
    }
    case "ollama_http":
      return { kind: "ollama_http", default_model: rec.default_model };
    case "browser_ext":
      return { kind: "browser_ext" };
    case "no_channel_available":
      return { kind: "install_required" };
    default:
      return null;
  }
}

/** Trim a long file path for the UI without losing the filename. */
function shortenPath(p: string): string {
  if (p.length <= 50) return p;
  // Keep the last 2 segments + leading "...".
  const parts = p.split(/[\\/]/);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

// === wave 11.1 ===
/** Pick the localized friendly error copy for a given test result. The
 *  `diagnostic.error_kind` enum drives the i18n key; for legacy results
 *  without a diagnostic we fall back to the raw `error` string the Rust
 *  side already populated (also human-readable, just not localized). */
function friendlyErrorCopy(
  t: ReturnType<typeof useTranslation>["t"],
  result: SetupWizardTestResult,
): string {
  const diag = result.diagnostic;
  if (!diag) return result.error ?? "";
  const tool = displayNameForToolId(diag.tool_id || "");
  const key = `setupWizard.errors.${diag.error_kind}`;
  // i18next returns the key string itself if not found — guard against
  // that so we degrade to the raw error rather than rendering a key.
  const localized = t(key, { tool });
  if (localized === key) return result.error ?? "";
  return localized;
}

// === wave 11.1 ===
/** Show me what's wrong" expander. Collapsed by default; one click
 *  toggles the panel of channel/tool/raw-error/extra metadata. */
function DiagnosticExpander({
  diagnostic,
}: {
  diagnostic: SetupWizardDiagnostic;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3" data-testid="setup-wizard-diagnostic">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        data-testid="setup-wizard-diagnostic-toggle"
        className="font-mono text-[11px] text-rose-700 underline-offset-2 hover:underline dark:text-rose-300"
      >
        {open
          ? t("setupWizard.diagnosticHide")
          : t("setupWizard.diagnosticShow")}
      </button>
      {open && (
        <div
          data-testid="setup-wizard-diagnostic-panel"
          className="mt-2 rounded-md border border-rose-200 bg-white p-2 font-mono text-[10px] leading-relaxed text-stone-700 dark:border-rose-700/50 dark:bg-stone-900 dark:text-stone-300"
        >
          <div>
            <span className="text-stone-500">channel: </span>
            <span>{diagnostic.channel_attempted}</span>
            {diagnostic.tool_id ? <span> / {diagnostic.tool_id}</span> : null}
          </div>
          {diagnostic.channel_attempted === "mcp_sampling" && (
            <div>
              <span className="text-stone-500">sampler_registered: </span>
              <span>{diagnostic.sampler_registered ? "true" : "false"}</span>
            </div>
          )}
          <div>
            <span className="text-stone-500">elapsed_ms: </span>
            <span>{diagnostic.elapsed_ms}</span>
          </div>
          <div>
            <span className="text-stone-500">error_kind: </span>
            <span>{diagnostic.error_kind}</span>
          </div>
          {diagnostic.raw_error && (
            <div className="mt-1">
              <span className="text-stone-500">raw: </span>
              <span className="break-words">{diagnostic.raw_error}</span>
            </div>
          )}
          {diagnostic.extra && Object.keys(diagnostic.extra).length > 0 && (
            <div className="mt-1">
              {Object.entries(diagnostic.extra).map(([k, v]) => (
                <div key={k}>
                  <span className="text-stone-500">{k}: </span>
                  <span>{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The canonical Tangerine MCP server snippet — kept in sync with the
 *  Rust merge_tangerine_into_mcp_json shape. */
function buildMcpSnippet(): string {
  const obj = {
    mcpServers: {
      tangerine: {
        command: "npx",
        args: ["-y", "tangerine-mcp@latest"],
        env: {
          TANGERINE_SAMPLING_BRIDGE: "1",
        },
      },
    },
  };
  return JSON.stringify(obj, null, 2);
}

// === end wave 11 ===
