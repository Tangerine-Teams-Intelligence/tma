/**
 * ST-0 Settings — tabbed: General / AI tools / Team / Adapters / Advanced.
 *
 * Spec mentions Discord/Whisper/Claude tabs too; we collapse those into
 * "Adapters" + "Advanced" to keep ST-0 lean. T1 may split them later if user
 * feedback wants it.
 *
 * v1.8 adds the "AI tools" tab — the user picks a primary external AI tool
 * (Cursor / Claude Code / etc.) for the co-thinker brain to think through.
 */
import { useEffect, useState } from "react";

import { getConfig, setConfig } from "@/lib/tauri";
import { GeneralSettings } from "./GeneralSettings";
import { TeamSettings } from "./TeamSettings";
import { AdaptersSettings } from "./AdaptersSettings";
import { AdvancedSettings } from "./AdvancedSettings";
import { AIToolsSettings } from "./AIToolsSettings";
import { AGISettings } from "./AGISettings";
// v3.0 §1 — Personal Agents tab. Strict opt-in capture for Cursor / Claude
// Code / Codex / Windsurf logs into the personal vault.
import { PersonalAgentsSettings } from "./PersonalAgentsSettings";

const TABS = [
  { id: "general", label: "General" },
  { id: "ai-tools", label: "AI tools" },
  { id: "agi", label: "AGI" },
  // v3.0 §1 — Personal Agents tab.
  { id: "personal-agents", label: "Personal Agents" },
  { id: "team", label: "Team" },
  { id: "adapters", label: "Adapters" },
  { id: "advanced", label: "Advanced" },
] as const;

type TabId = (typeof TABS)[number]["id"];

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
  const [tab, setTab] = useState<TabId>("general");
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

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-6 p-8" data-testid="st-0">
      <header>
        <h1 className="font-display text-3xl">Settings</h1>
        <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
          Lives at <code className="font-mono">~/.tmi/config.yaml</code>. Secrets in HKCU\Environment.
        </p>
      </header>

      <nav className="flex gap-1 border-b border-[var(--ti-border-faint)]">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            data-testid={`st-tab-${t.id}`}
            className={
              "border-b-2 px-3 py-2 text-sm transition-colors duration-fast " +
              (tab === t.id
                ? "border-[var(--ti-orange-500)] text-[var(--ti-orange-700)]"
                : "border-transparent text-[var(--ti-ink-500)] hover:text-[var(--ti-ink-700)]")
            }
          >
            {t.label}
          </button>
        ))}
      </nav>

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
              ? `Saved · ${new Date(savedAt).toLocaleTimeString()}`
              : "Unsaved changes are discarded on close."}
        </p>
        <button
          onClick={save}
          data-testid="st-save"
          className="rounded-md bg-[var(--ti-orange-500)] px-4 py-1.5 text-sm text-white hover:bg-[var(--ti-orange-600)]"
        >
          Save
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
