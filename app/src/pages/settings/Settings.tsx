/**
 * ST-0 Settings — tabbed: General / AI tools / Team / Adapters / Advanced.
 *
 * Spec mentions Discord/Whisper/Claude tabs too; we collapse those into
 * "Adapters" + "Advanced" to keep ST-0 lean. T1 may split them later if user
 * feedback wants it.
 *
 * v1.8 adds the "AI tools" tab — the user picks a primary external AI tool
 * (Cursor / Claude Code / etc.) for the co-thinker brain to think through.
 *
 * === wave 5-α ===
 * Progressive disclosure: by default only General / AI tools / AGI /
 * Personal Agents are visible. Adapters / Team / Advanced live behind a
 * "Show advanced settings" toggle persisted in `ui.showAdvancedSettings`.
 * === end wave 5-α ===
 */
// === wave 4-D i18n ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { getConfig, setConfig } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { GeneralSettings } from "./GeneralSettings";
import { TeamSettings } from "./TeamSettings";
import { AdaptersSettings } from "./AdaptersSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { AIToolsSettings } from "./AIToolsSettings";
import { AGISettings } from "./AGISettings";
// v3.0 §1 — Personal Agents tab. Strict opt-in capture for Cursor / Claude
// Code / Codex / Windsurf logs into the personal vault.
import { PersonalAgentsSettings } from "./PersonalAgentsSettings";

// === wave 5-α ===
// Tab classification:
//   default — always visible (small, opinionated set)
//   advanced — only visible when `ui.showAdvancedSettings` is true
// === wave 14 === — DRASTIC SIMPLIFICATION. Default drops to 2 tabs
// (General, AI tools). AGI + Personal Agents move behind the
// "Show advanced" toggle alongside Team / Adapters / Advanced.
// Rationale: a brand-new user lands on Settings and only sees the
// two opinionated controls (general prefs + AI tool detection); the
// dev-grade tabs (sensitivity sliders, parser configs, adapter wiring)
// are one click away, not in their face.
const DEFAULT_TABS = [
  { id: "general", label: "General" },
  { id: "ai-tools", label: "AI tools" },
] as const;

const ADVANCED_TABS = [
  { id: "agi", label: "AGI" },
  { id: "personal-agents", label: "Personal Agents" },
  { id: "adapters", label: "Adapters" },
  { id: "team", label: "Team" },
  { id: "advanced", label: "Advanced" },
] as const;

type DefaultTabId = (typeof DEFAULT_TABS)[number]["id"];
type AdvancedTabId = (typeof ADVANCED_TABS)[number]["id"];
type TabId = DefaultTabId | AdvancedTabId;
// === end wave 5-α ===

// Minimal in-app shape; T1's WizardData lives in store.
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
  // === wave 5-α ===
  const showAdvanced = useStore((s) => s.ui.showAdvancedSettings);
  const setShowAdvanced = useStore((s) => s.ui.setShowAdvancedSettings);
  const [tab, setTab] = useState<TabId>("general");
  // === end wave 5-α ===
  const [draft, setDraft] = useState<ConfigDraft>(DEFAULT_DRAFT);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getConfig().then((cfg) => {
      // Best-effort: real cfg comes from yaml string. In mock we just keep defaults.
      if (typeof cfg === "object" && cfg !== null) {
        setDraft({ ...DEFAULT_DRAFT, ...(cfg as Partial<ConfigDraft>) });
      }
    });
  }, []);

  // === wave 5-α ===
  // If the user hides advanced while sitting on an advanced tab, fall
  // back to the general tab so the page never renders nothing.
  useEffect(() => {
    if (
      !showAdvanced &&
      ADVANCED_TABS.some((tt) => tt.id === tab)
    ) {
      setTab("general");
    }
  }, [showAdvanced, tab]);
  // === end wave 5-α ===

  const update = <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: val }));
  };

  const save = async () => {
    setError(null);
    try {
      // Render minimal yaml. T1's full builder lives in tauri.ts → finishWizard;
      // we just stringify here so the user sees something on disk.
      const yaml = renderYaml(draft);
      await setConfig(yaml);
      setSavedAt(Date.now());
    } catch (e) {
      setError(String(e));
    }
  };

  // === wave 5-α ===
  const visibleTabs: ReadonlyArray<{ id: TabId; label: string }> = showAdvanced
    ? [...DEFAULT_TABS, ...ADVANCED_TABS]
    : [...DEFAULT_TABS];
  // === end wave 5-α ===

  const tabLabelKey: Record<TabId, string> = {
    general: "settings.tabs.general",
    "ai-tools": "settings.tabs.aiTools",
    agi: "settings.tabs.agi",
    "personal-agents": "settings.tabs.personalAgents",
    team: "settings.tabs.team",
    adapters: "settings.tabs.adapters",
    advanced: "settings.tabs.advanced",
  };

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 p-8" data-testid="st-0">
      <header>
        <h1 className="font-display text-3xl">{t("settings.title")}</h1>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          {t("settings.subtitleHint")} <code className="font-mono">~/.tmi/config.yaml</code>
          {t("settings.subtitleHintTail")}
        </p>
      </header>

      <nav className="flex gap-1 border-b border-[var(--ti-border-faint)]">
        {visibleTabs.map((tab2) => (
          <button
            key={tab2.id}
            onClick={() => setTab(tab2.id)}
            data-testid={`st-tab-${tab2.id}`}
            className={
              "border-b-2 px-3 py-2 text-sm transition-colors duration-fast " +
              (tab === tab2.id
                ? "border-[var(--ti-orange-500)] text-[var(--ti-orange-700)]"
                : "border-transparent text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-700)]")
            }
          >
            {t(tabLabelKey[tab2.id])}
          </button>
        ))}
      </nav>

      {/* === wave 5-α ===
          Show / hide advanced tabs link. Sits below the tab row, mono
          11px font so it reads as a power-user affordance rather than
          a primary action. */}
      <div className="-mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          data-testid="st-advanced-toggle"
          className="font-mono text-[11px] text-[var(--ti-ink-500)] underline-offset-2 hover:text-[var(--ti-orange-600)] hover:underline"
        >
          {showAdvanced
            ? t("settings.hideAdvanced")
            : t("settings.showAdvanced")}
        </button>
        {!showAdvanced && (
          <span className="text-[11px] text-[var(--ti-ink-500)]">
            {t("settings.advancedHint")}
          </span>
        )}
      </div>
      {/* === end wave 5-α === */}

      <section className="flex-1 overflow-auto">
        {tab === "general" && (
          <GeneralSettings
            draft={draft}
            update={update}
            onJumpToAGI={() => setTab("agi")}
          />
        )}
        {tab === "ai-tools" && <AIToolsSettings />}
        {tab === "agi" && <AGISettings />}
        {tab === "personal-agents" && <PersonalAgentsSettings />}
        {tab === "team" && <TeamSettings draft={draft} update={update} />}
        {tab === "adapters" && <AdaptersSettings draft={draft} update={update} />}
        {tab === "advanced" && <AdvancedSettings draft={draft} update={update} />}
      </section>

      <footer className="flex items-center justify-between border-t border-[var(--ti-border-faint)] pt-4">
        <p className="text-xs text-[var(--ti-ink-500)]">
          {error
            ? <span className="text-[var(--ti-danger)]">{error}</span>
            : savedAt
              ? `${t("settings.savedAt")} · ${new Date(savedAt).toLocaleTimeString()}`
              : t("settings.unsavedHint")}
        </p>
        <button
          onClick={save}
          data-testid="st-save"
          className="rounded-md bg-[var(--ti-orange-500)] px-4 py-1.5 text-sm text-white hover:bg-[var(--ti-orange-600)]"
        >
          {t("settings.save")}
        </button>
      </footer>
    </div>
  );
}

function renderYaml(d: ConfigDraft): string {
  const team = d.team
    .map(
      (m) =>
        `  - alias: ${m.alias}\n    display_name: "${m.display_name}"\n    discord_id: ${m.discord_id || "null"}`
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
