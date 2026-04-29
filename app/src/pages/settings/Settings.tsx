/**
 * v1.16 Wave 4 D1 — 3-section Settings shell.
 *
 * Pre-D1 layout: 9 tabs (General / AI tools / Sources / Privacy / AGI /
 * Adapters / Team / Advanced + show-advanced toggle). 9 tabs is the same
 * "where do I find X?" disease that bloated v1.15 — D1 collapses to 3:
 *
 *   1. Connect — AI tool capture (4 IDE) + external sources (Slack /
 *      GitHub / Lark / etc.) + theme & language.
 *   2. Privacy — the R6 honest panel (ASCII data-flow + ✓ list).
 *   3. Sync — Solo vs Team mode, GitHub remote URL, auto-sync, personal
 *      vault toggle, meeting repo, team roster, debug bundle / samples.
 *
 * Cut entirely:
 *   - "AI 工具" Primary-channel picker (smart layer is gone in v1.16 W1)
 *   - "AGI" tab (smart layer)
 *   - "Adapters" tab (LLM adapter wiring — smart layer)
 *   - All "show advanced" indirection — there are 3 things, all visible.
 *
 * Backwards-compat:
 *   - All store keys preserved: theme / personalAgentsEnabled / memoryConfig
 *     / gitMode / gitAutoPullIntervalMin / etc.
 *   - All Tauri commands called the same way (the 4-IDE filter is purely
 *     view-side; backend still tracks all 8 personal-agent keys).
 *   - `?tab=privacy` deep-link from WelcomeOverlay still works (now maps
 *     to the privacy section).
 *   - `?tab=ai-tools` / `?tab=sources` legacy deep-links redirect to the
 *     Connect section so external links don't 404.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { getConfig, setConfig } from "@/lib/tauri";
import { ConnectSection } from "./sections/ConnectSection";
import { PrivacySection } from "./sections/PrivacySection";
import { SyncSection } from "./sections/SyncSection";

type SectionId = "connect" | "privacy" | "sync";

const SECTIONS: ReadonlyArray<{ id: SectionId; label: string }> = [
  { id: "connect", label: "Connect" },
  { id: "privacy", label: "Privacy" },
  { id: "sync", label: "Sync" },
];

// Legacy `?tab=` query values mapped to their v1.16 home. Lets old
// WelcomeOverlay / palette / external links keep working without a 404.
const LEGACY_TAB_MAP: Record<string, SectionId> = {
  general: "connect",
  "ai-tools": "connect",
  sources: "connect",
  privacy: "privacy",
  agi: "sync",
  team: "sync",
  adapters: "sync",
  advanced: "sync",
  "personal-agents": "connect",
  // New canonical names (idempotent if already correct)
  connect: "connect",
  sync: "sync",
};

export interface ConfigDraft {
  meetings_repo: string;
  log_level: string;
  team: { alias: string; display_name: string; discord_id: string }[];
  whisper_model: string;
  whisper_chunk_seconds: number;
  output_adapters: { name: string; target_repo: string }[];
}

const DEFAULT_DRAFT: ConfigDraft = {
  meetings_repo: "",
  log_level: "info",
  team: [{ alias: "daizhe", display_name: "Daizhe", discord_id: "" }],
  whisper_model: "whisper-1",
  whisper_chunk_seconds: 10,
  output_adapters: [{ name: "default", target_repo: "" }],
};

export default function Settings() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();

  const initialSection: SectionId = (() => {
    const q = new URLSearchParams(location.search).get("tab");
    if (!q) return "connect";
    return LEGACY_TAB_MAP[q] ?? "connect";
  })();
  const [section, setSection] = useState<SectionId>(initialSection);

  const [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Strip `?tab=` after first paint so later in-page nav doesn't fight the URL.
  useEffect(() => {
    if (location.search) {
      navigate("/settings", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void getConfig().then((cfg) => {
      if (typeof cfg === "object" && cfg !== null) {
        setDraft({ ...DEFAULT_DRAFT, ...(cfg as Partial<ConfigDraft>) });
      }
    });
  }, []);

  const update = <K extends keyof ConfigDraft>(
    key: K,
    val: ConfigDraft[K],
  ) => {
    setDraft((d) => ({ ...d, [key]: val }));
  };

  const save = async () => {
    setError(null);
    try {
      const yaml = renderYaml(draft);
      await setConfig(yaml);
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div
      className="mx-auto flex h-full max-w-4xl flex-col gap-6 p-8"
      data-testid="st-0"
    >
      <header>
        <h1 className="font-display text-3xl">
          {t("settings.title", { defaultValue: "Settings" })}
        </h1>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.subtitleHint", {
            defaultValue: "Stored in",
          })}{" "}
          <code className="font-mono">~/.tmi/config.yaml</code>
          {t("settings.subtitleHintTail", { defaultValue: "" })}
        </p>
      </header>

      <nav
        className="flex gap-1 border-b border-[var(--ti-border-faint)]"
        data-testid="st-section-nav"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            data-testid={`st-tab-${s.id}`}
            className={
              "border-b-2 px-3 py-2 text-sm transition-colors duration-fast " +
              (section === s.id
                ? "border-[var(--ti-orange-500)] text-[var(--ti-orange-700)]"
                : "border-transparent text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-700)]")
            }
          >
            {s.label}
          </button>
        ))}
      </nav>

      <section className="flex-1 overflow-auto">
        {section === "connect" && <ConnectSection />}
        {section === "privacy" && <PrivacySection />}
        {section === "sync" && (
          <SyncSection draft={draft} update={update} />
        )}
      </section>

      <footer className="flex items-center justify-between border-t border-[var(--ti-border-faint)] pt-4">
        <p className="text-xs text-[var(--ti-ink-500)]">
          {error ? (
            <span className="text-[var(--ti-danger)]">{error}</span>
          ) : savedAt ? (
            `${t("settings.savedAt", { defaultValue: "Saved" })} · ${new Date(savedAt).toLocaleTimeString()}`
          ) : (
            t("settings.unsavedHint", { defaultValue: "Unsaved changes" })
          )}
        </p>
        <button
          onClick={save}
          data-testid="st-save"
          className="rounded-md bg-[var(--ti-orange-500)] px-4 py-1.5 text-sm text-white hover:bg-[var(--ti-orange-600)]"
        >
          {t("settings.save", { defaultValue: "Save" })}
        </button>
      </footer>
    </div>
  );
}

function renderYaml(d: ConfigDraft): string {
  const team = d.team
    .map(
      (m) =>
        `  - alias: ${m.alias}\n    display_name: "${m.display_name}"\n    discord_id: ${m.discord_id || "null"}`,
    )
    .join("\n");
  const adapters = d.output_adapters
    .map((a) => `  - name: ${a.name}\n    target_repo: "${a.target_repo}"`)
    .join("\n");
  return `# Edited by ST-0
schema_version: 1
meetings_repo: "${d.meetings_repo}"
logging:
  level: ${d.log_level}
whisper:
  model: ${d.whisper_model}
  chunk_seconds: ${d.whisper_chunk_seconds}
output_adapters:
${adapters}
team:
${team}
`;
}
