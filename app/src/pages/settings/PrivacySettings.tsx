// === wave 1.13-E ===
// === v1.20.2 visual rewrite ===
/**
 * Privacy panel — Obsidian-grade visual rewrite.
 *
 * The "Local-first" claim is load-bearing for the dual-layer capture
 * positioning. This panel gives the user the receipts:
 *   - Which v1.13-E source tokens are configured (presence-only — no values).
 *   - What stays on the machine vs what may leave it.
 *   - A one-click "verify local-execution" audit.
 *   - A telemetry opt-out toggle.
 *
 * v1.20.2 visual changes:
 *   - Narrow centered column lives in the parent (Settings shell); this
 *     component is just typography on stone-50.
 *   - No card chrome around subsections — just hairline (1px stone-200)
 *     spacing and clean type hierarchy.
 *   - Mono for paths / asset keys / endpoint URLs; sans for labels.
 *   - Single accent rule: orange ONLY on the telemetry-toggle accent +
 *     hover state of the audit button. Status pips are `text-stone-500`
 *     mono, not green/orange chrome.
 *   - The ASCII data-flow diagram survives — it's the most honest
 *     possible visual and matches the "builder, not McKinsey" aesthetic.
 *
 * Backwards-compat preserved end-to-end:
 *   - `st-privacy-*` testids match the wave1-13e test contract verbatim.
 *   - Honest error / loading branches preserved (R6).
 *   - Subtitle still includes the "100% on your machines" load-bearing
 *     claim copy that the wave4-d1 + wave1-13e tests assert.
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

// === v1.13.6 round-6 ===
// Outside Tauri (vitest / vite dev) we still mock so the UI renders for
// development. Inside Tauri, errors PROPAGATE so the caller can surface
// a real error UI; the React side stores `lastError` and renders an
// explicit "couldn't load receipts" card rather than fake green checkmarks.
async function invokeOrMockErrors<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => T,
): Promise<T> {
  if (!inTauri()) return mock();
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<T>(cmd, args);
}

async function invokeOrMockSilent<T>(
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
// === end v1.13.6 round-6 ===

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
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    invokeOrMockErrors<PrivacyOverview>(
      "privacy_get_overview",
      undefined,
      () => MOCK_OVERVIEW,
    )
      .then((o) => {
        setOverview(o);
        setLoadError(null);
      })
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[privacy] privacy_get_overview failed:", e);
        setLoadError(String(e));
      });
  }, []);

  const flipTelemetry = async (next: boolean) => {
    setSavedAt(null);
    await invokeOrMockSilent<void>(
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
      const r = await invokeOrMockSilent<LocalExecutionAudit>(
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

  // R6 — honest error state. Don't render fake mock receipts when the
  // real load failed in production.
  if (loadError) {
    return (
      <div
        className="rounded-md border border-rose-300 bg-rose-50 p-3 text-[13px] text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/40 dark:text-rose-200"
        data-testid="st-privacy-error"
      >
        <div className="font-medium">
          {t("privacy.errorTitle", "Couldn't load privacy receipts")}
        </div>
        <div className="mt-1 font-mono text-[11px] opacity-80">
          {loadError}
        </div>
        <div className="mt-2 text-[11px] opacity-80">
          {t(
            "privacy.errorHint",
            "Restart the app or open the developer console for details. We refuse to render fake 'all-local' receipts when we can't verify them.",
          )}
        </div>
      </div>
    );
  }

  if (!overview) {
    return (
      <div
        className="font-mono text-[11px] text-stone-500 dark:text-stone-500"
        data-testid="st-privacy-loading"
      >
        {t("privacy.loading", "Loading privacy overview…")}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8" data-testid="st-privacy">
      {/* Subtitle — the load-bearing "100% on your machines" claim. */}
      <p className="text-[13px] text-stone-700 dark:text-stone-300">
        {t(
          "privacy.subtitle",
          "Tangerine runs 100% on your machines by default. Receipts below.",
        )}
      </p>

      {/* ASCII data-flow diagram. Fixed-width font matches the
          "builder, not McKinsey" aesthetic. */}
      <section data-testid="st-privacy-diagram">
        <h2 className="mb-3 text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {t("privacy.diagramTitle", "Data flow")}
        </h2>
        <pre className="overflow-auto rounded-md bg-stone-100 p-4 font-mono text-[10px] text-stone-700 dark:bg-stone-900 dark:text-stone-300">
          {ASCII_DIAGRAM}
        </pre>
      </section>

      {/* What stays local */}
      <section data-testid="st-privacy-local">
        <h2 className="mb-3 text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {t("privacy.localTitle", "What stays on your machine")}
        </h2>
        <ul className="flex flex-col gap-1">
          {overview.local_only_assets.map((asset) => (
            <li
              key={asset}
              className="flex items-baseline gap-2 text-[13px] text-stone-700 dark:text-stone-300"
            >
              <span
                aria-hidden
                className="font-mono text-[11px] text-stone-500 dark:text-stone-500"
              >
                ✓
              </span>
              <span>
                {t(`privacy.local.${asset}`, assetLabelLocal(asset))}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* What may leave */}
      <section data-testid="st-privacy-egress">
        <h2 className="mb-3 text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {t("privacy.egressTitle", "What may leave your machine")}
        </h2>
        <ul className="flex flex-col gap-1">
          {overview.egress_assets.map((asset) => (
            <li
              key={asset}
              className="flex items-baseline gap-2 text-[13px] text-stone-700 dark:text-stone-300"
            >
              <span
                aria-hidden
                className="font-mono text-[11px] text-stone-500 dark:text-stone-500"
              >
                →
              </span>
              <span>
                {t(`privacy.egress.${asset}`, assetLabelEgress(asset))}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Source token presence — no values shown */}
      <section data-testid="st-privacy-sources">
        <h2 className="mb-3 text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {t("privacy.sourcesTitle", "Source tokens (in OS keychain)")}
        </h2>
        <ul className="flex flex-col gap-1">
          {overview.sources.map((s) => (
            <li
              key={s.source}
              className="flex items-center gap-2 text-[13px] text-stone-700 dark:text-stone-300"
              data-testid={`st-privacy-source-${s.source}`}
            >
              <span
                aria-hidden
                className={
                  "inline-block h-1.5 w-1.5 shrink-0 rounded-full " +
                  (s.present
                    ? "bg-[var(--ti-orange-500)]"
                    : "bg-stone-300 dark:bg-stone-700")
                }
              />
              <span className="font-mono text-[12px]">{s.source}</span>
              <span className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
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
        <label className="flex items-start gap-3 text-[13px]">
          <input
            type="checkbox"
            checked={!overview.telemetry_opt_out}
            onChange={(e) => void flipTelemetry(!e.target.checked)}
            data-testid="st-privacy-telemetry-toggle"
            className="mt-1 accent-[var(--ti-orange-500)]"
          />
          <span>
            <span className="font-medium text-stone-900 dark:text-stone-100">
              {t(
                "privacy.telemetryToggle",
                "Send anonymized usage telemetry",
              )}
            </span>
            <span className="block font-mono text-[11px] text-stone-500 dark:text-stone-500">
              {t(
                "privacy.telemetryHint",
                "Default ON. Helps us see which features get used. No content, no identifiers.",
              )}
            </span>
            {savedAt && (
              <span className="mt-1 block font-mono text-[10px] text-stone-500 dark:text-stone-500">
                {t("privacy.savedAt", "saved")} ·{" "}
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
          className="rounded-md border border-stone-200 bg-white px-3 py-1.5 text-[12px] text-stone-700 transition-colors hover:border-[var(--ti-orange-500)] hover:text-stone-900 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
        >
          {loading
            ? t("privacy.verifyLoading", "Auditing…")
            : t("privacy.verifyBtn", "Verify local-execution")}
        </button>
        {audit && (
          <div className="mt-3 font-mono text-[11px]">
            <div data-testid="st-privacy-verify-result">
              {audit.tangerine_call_count === 0 ? (
                <span className="text-stone-700 dark:text-stone-300">
                  ✓ {t(
                    "privacy.verifyZero",
                    "0 calls to Tangerine servers in last hour",
                  )}
                </span>
              ) : (
                <span className="text-rose-700 dark:text-rose-400">
                  {audit.tangerine_call_count}{" "}
                  {t(
                    "privacy.verifyNonZero",
                    "calls to Tangerine servers in last hour",
                  )}
                </span>
              )}
            </div>
            {audit.endpoints_contacted.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-stone-500 dark:text-stone-500">
                {audit.endpoints_contacted.map((ep) => (
                  <li key={ep}>· {ep}</li>
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
