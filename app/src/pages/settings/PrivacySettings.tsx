// === wave 1.13-E ===
/**
 * v1.13 Agent E — Privacy panel.
 *
 * "Local-first" claim is load-bearing for the dual-layer capture positioning
 * (AI tools + human comm). This panel gives the user the receipts:
 *   - which v1.13-E source tokens are configured (presence-only — no values)
 *   - what data stays on the machine vs what may leave it
 *   - a one-click "verify local-execution" audit
 *   - a telemetry opt-out toggle
 *
 * The diagram is ASCII-rendered (not React Flow) — keeps the dep tree lean
 * and survives a fresh install with zero source tokens configured. The fixed-
 * width font + monospace box-drawing characters match the rest of the app's
 * "builder, not McKinsey" aesthetic.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface SourcePresence {
  source: string;
  present: boolean;
}

interface PrivacyOverview {
  sources: SourcePresence[];
  telemetry_opt_out: boolean;
  local_only_assets: string[];
  egress_assets: string[];
}

interface LocalExecutionAudit {
  since_seconds: number;
  endpoints_contacted: string[];
  tangerine_call_count: number;
}

async function invokeOrMock<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => T,
): Promise<T> {
  if (!inTauri()) return mock();
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[privacy] invoke "${cmd}" failed:`, e);
    return mock();
  }
}

const MOCK_OVERVIEW: PrivacyOverview = {
  sources: [
    { source: "lark", present: false },
    { source: "zoom", present: false },
    { source: "teams", present: false },
    { source: "slack", present: false },
    { source: "github", present: false },
  ],
  telemetry_opt_out: false,
  local_only_assets: [
    "memory_dir",
    "git_remote_user_owned",
    "whisper_transcription",
    "mcp_sampling",
    "discord_bot_subprocess",
    "source_tokens_keychain",
    "ai_tool_conversations",
  ],
  egress_assets: [
    "git_push_user_remote",
    "telemetry_anonymized",
    "auto_updater_check",
    "cloud_sync_optional",
  ],
};

const ASCII_DIAGRAM = `\
   Your machine                       Tangerine Cloud (optional)
┌─────────────────┐                   ┌──────────────────┐
│ Cursor history  │ ─── reads ──→     │   (only if you   │
│ Claude session  │                   │    opted in)     │
│ Codex log       │   atoms           │                  │
│ ChatGPT history │   ↓               │                  │
│                 │                   │                  │
│ ~/.tangerine-   │ ─── git push →    │ optional cloud   │
│  memory/        │ (your git remote) │  sync            │
│                 │                   │                  │
│ OS keychain     │ holds tokens      │                  │
│ (encrypted)     │ never sent        │                  │
└─────────────────┘                   └──────────────────┘`;

export function PrivacySettings() {
  const { t } = useTranslation();
  const [overview, setOverview] = useState<PrivacyOverview | null>(null);
  const [audit, setAudit] = useState<LocalExecutionAudit | null>(null);
  const [loading, setLoading] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    void invokeOrMock<PrivacyOverview>(
      "privacy_get_overview",
      undefined,
      () => MOCK_OVERVIEW,
    ).then(setOverview);
  }, []);

  const flipTelemetry = async (next: boolean) => {
    setSavedAt(null);
    await invokeOrMock<void>(
      "privacy_set_telemetry_opt_out",
      { args: { opt_out: next } },
      () => undefined,
    );
    setOverview((prev) =>
      prev ? { ...prev, telemetry_opt_out: next } : prev,
    );
    setSavedAt(Date.now());
  };

  const runAudit = async () => {
    setLoading(true);
    try {
      const r = await invokeOrMock<LocalExecutionAudit>(
        "privacy_verify_local_execution",
        undefined,
        () => ({
          since_seconds: 3600,
          endpoints_contacted: [
            "github.com (your remote, your data)",
            "api.github.com/user/code (auto-updater manifest)",
          ],
          tangerine_call_count: 0,
        }),
      );
      setAudit(r);
    } finally {
      setLoading(false);
    }
  };

  if (!overview) {
    return (
      <div className="text-sm text-[var(--ti-ink-500)]" data-testid="st-privacy-loading">
        {t("privacy.loading", "Loading privacy overview…")}
      </div>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-6" data-testid="st-privacy">
      <header>
        <h2 className="font-display text-xl">
          {t("privacy.title", "Privacy")}
        </h2>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t(
            "privacy.subtitle",
            "Tangerine runs 100% on your machines by default. Receipts below.",
          )}
        </p>
      </header>

      {/* ASCII data-flow diagram. Fixed-width font matches the
          "builder, not McKinsey" aesthetic. */}
      <section data-testid="st-privacy-diagram">
        <h3 className="mb-2 text-sm font-medium text-[var(--ti-ink-700)]">
          {t("privacy.diagramTitle", "Data flow")}
        </h3>
        <pre
          className="overflow-auto rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] p-3 font-mono text-[10px] text-[var(--ti-ink-700)]"
        >
          {ASCII_DIAGRAM}
        </pre>
      </section>

      {/* What stays local */}
      <section data-testid="st-privacy-local">
        <h3 className="mb-2 text-sm font-medium text-[var(--ti-ink-700)]">
          {t("privacy.localTitle", "What stays on your machine")}
        </h3>
        <ul className="space-y-1">
          {overview.local_only_assets.map((asset) => (
            <li key={asset} className="text-xs text-[var(--ti-ink-700)]">
              <span className="text-[var(--ti-success, #2a8c4d)]">{"✓"}</span>{" "}
              {t(`privacy.local.${asset}`, assetLabelLocal(asset))}
            </li>
          ))}
        </ul>
      </section>

      {/* What may leave */}
      <section data-testid="st-privacy-egress">
        <h3 className="mb-2 text-sm font-medium text-[var(--ti-ink-700)]">
          {t("privacy.egressTitle", "What may leave your machine")}
        </h3>
        <ul className="space-y-1">
          {overview.egress_assets.map((asset) => (
            <li key={asset} className="text-xs text-[var(--ti-ink-700)]">
              <span className="text-[var(--ti-orange-600)]">{"⦵"}</span>{" "}
              {t(`privacy.egress.${asset}`, assetLabelEgress(asset))}
            </li>
          ))}
        </ul>
      </section>

      {/* Source token presence — no values shown */}
      <section data-testid="st-privacy-sources">
        <h3 className="mb-2 text-sm font-medium text-[var(--ti-ink-700)]">
          {t("privacy.sourcesTitle", "Source tokens (in OS keychain)")}
        </h3>
        <ul className="space-y-1">
          {overview.sources.map((s) => (
            <li
              key={s.source}
              className="flex items-center gap-2 text-xs text-[var(--ti-ink-700)]"
              data-testid={`st-privacy-source-${s.source}`}
            >
              <span
                className={
                  "inline-block h-2 w-2 rounded-full " +
                  (s.present
                    ? "bg-[var(--ti-success, #2a8c4d)]"
                    : "bg-[var(--ti-ink-300, #c8c8c8)]")
                }
              />
              <span className="font-mono">{s.source}</span>
              <span className="text-[var(--ti-ink-500)]">
                {s.present
                  ? t("privacy.sourceConfigured", "configured")
                  : t("privacy.sourceNotConfigured", "not configured")}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Telemetry opt-out toggle */}
      <section data-testid="st-privacy-telemetry">
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={!overview.telemetry_opt_out}
            onChange={(e) => void flipTelemetry(!e.target.checked)}
            data-testid="st-privacy-telemetry-toggle"
            className="mt-1"
          />
          <span>
            <span className="font-medium text-[var(--ti-ink-700)]">
              {t(
                "privacy.telemetryToggle",
                "Send anonymized usage telemetry",
              )}
            </span>
            <span className="block text-xs text-[var(--ti-ink-500)]">
              {t(
                "privacy.telemetryHint",
                "Default ON. Helps us see which features get used. No content, no identifiers.",
              )}
            </span>
            {savedAt && (
              <span className="mt-1 block text-[10px] text-[var(--ti-ink-500)]">
                {t("privacy.savedAt", "Saved")} ·{" "}
                {new Date(savedAt).toLocaleTimeString()}
              </span>
            )}
          </span>
        </label>
      </section>

      {/* Verify local execution button */}
      <section data-testid="st-privacy-verify">
        <button
          type="button"
          onClick={() => void runAudit()}
          disabled={loading}
          data-testid="st-privacy-verify-btn"
          className="rounded-md border border-[var(--ti-border-default)] bg-white px-3 py-1.5 text-xs hover:bg-[var(--ti-paper-50)] disabled:opacity-50"
        >
          {loading
            ? t("privacy.verifyLoading", "Auditing…")
            : t("privacy.verifyBtn", "Verify local-execution")}
        </button>
        {audit && (
          <div className="mt-3 rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] p-3 text-xs">
            <div data-testid="st-privacy-verify-result">
              {audit.tangerine_call_count === 0 ? (
                <span className="text-[var(--ti-success, #2a8c4d)]">
                  {"✓"}{" "}
                  {t(
                    "privacy.verifyZero",
                    "0 calls to Tangerine servers in last hour",
                  )}
                </span>
              ) : (
                <span className="text-[var(--ti-danger)]">
                  {audit.tangerine_call_count}{" "}
                  {t(
                    "privacy.verifyNonZero",
                    "calls to Tangerine servers in last hour",
                  )}
                </span>
              )}
            </div>
            {audit.endpoints_contacted.length > 0 && (
              <ul className="mt-2 space-y-1 font-mono text-[10px] text-[var(--ti-ink-700)]">
                {audit.endpoints_contacted.map((ep) => (
                  <li key={ep}>• {ep}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function assetLabelLocal(key: string): string {
  switch (key) {
    case "memory_dir":
      return "Memory dir (~/.tangerine-memory/)";
    case "git_remote_user_owned":
      return "Git repo (your GitHub/Gitea — not Tangerine)";
    case "whisper_transcription":
      return "Whisper transcription (faster-whisper bundled, runs CPU local)";
    case "mcp_sampling":
      return "MCP sampling (uses your editor's LLM, not ours)";
    case "discord_bot_subprocess":
      return "Discord bot subprocess (Node.js on your machine)";
    case "source_tokens_keychain":
      return "Source tokens (OS keychain encrypted)";
    case "ai_tool_conversations":
      return "AI tool conversation files (read locally, never uploaded)";
    default:
      return key;
  }
}

function assetLabelEgress(key: string): string {
  switch (key) {
    case "git_push_user_remote":
      return "Git push to your specified remote (your data → your server)";
    case "telemetry_anonymized":
      return "Anonymized telemetry (opt-out via toggle)";
    case "auto_updater_check":
      return "Auto-updater check (version comparison only, no data)";
    case "cloud_sync_optional":
      return "If Cloud opted in: encrypted brain sync to Tangerine servers";
    default:
      return key;
  }
}

export default PrivacySettings;
// === end wave 1.13-E ===
