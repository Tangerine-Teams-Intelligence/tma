/**
 * v1.20.2 — Settings: Obsidian-grade visual rewrite.
 *
 * The 3-section IA (Connect / Privacy / Sync) survives from v1.16 W4 D1.
 * What changed in v1.20.2 is the visual layer: the page got the same
 * Obsidian-grade restraint /feed earned in v1.19 — narrow centered column
 * (max-w-2xl ≈ 640px), pure typography hierarchy, no card chrome around
 * subsections, single-accent rule (`var(--ti-orange-500)` only on active
 * tab / hover / Save / Connected pip), mono for paths + IDs + counts,
 * sans for labels + headlines.
 *
 * Header rewrite: `Settings` is sans-serif h1 (was display-serif). The
 * mono `~/.tmi/config.yaml` hint moved out of the header into the Sync
 * section (where it's relevant). A right-aligned `⌘,` chip signals the
 * keyboard shortcut.
 *
 * Tab strip: orange underline on active, no background fill, hairline
 * separator below.
 *
 * Save bar: bottom border-t, mono "discards unsaved changes on close"
 * hint left, orange Save button right.
 *
 * Backwards-compat preserved end-to-end:
 *   - All `st-*` test ids that the wave4-d1 + wave5-mobile + wave1-13e
 *     tests assert against still exist.
 *   - The 3 section components keep their `data-testid="st-section-*"`
 *     contract.
 *   - All store keys (theme / personalAgentsEnabled / memoryConfig / ...)
 *     untouched.
 *   - Legacy `?tab=` query value mapping unchanged.
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
      // v1.20.2 — narrow centered column, same width as /feed time-density.
      // No card chrome, no h-full bleed; the page IS the type.
      className="mx-auto flex w-full max-w-2xl flex-col px-8 py-12"
      data-testid="st-0"
    >
      <header className="flex items-baseline justify-between">
        <h1 className="text-[28px] font-medium tracking-tight text-stone-900 dark:text-stone-100">
          {t("settings.title", { defaultValue: "Settings" })}
        </h1>
        <span
          aria-hidden
          className="font-mono text-[11px] text-stone-500 dark:text-stone-500"
        >
          ⌘,
        </span>
      </header>
      <div
        aria-hidden
        className="mt-4 h-px w-full bg-stone-200 dark:bg-stone-800"
      />

      <nav
        // v1.20.2 — tab strip is plain typography. Orange underline on
        // active, stone-500 inactive, no chrome.
        className="mt-6 flex gap-1"
        data-testid="st-section-nav"
      >
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            onClick={() => setSection(s.id)}
            data-testid={`st-tab-${s.id}`}
            className={
              "shrink-0 border-b-2 px-3 py-2 text-[14px] font-medium transition-colors duration-fast " +
              (section === s.id
                ? "border-[var(--ti-orange-500)] text-stone-900 dark:text-stone-100"
                : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
            }
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />

      <section className="mt-8 flex-1">
        {section === "connect" && <ConnectSection />}
        {section === "privacy" && <PrivacySection />}
        {section === "sync" && (
          <SyncSection draft={draft} update={update} />
        )}
      </section>

      <footer className="mt-12 flex items-center justify-between border-t border-stone-200 py-4 dark:border-stone-800">
        <p className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
          {error ? (
            <span className="text-[var(--ti-danger)]">{error}</span>
          ) : savedAt ? (
            `${t("settings.savedAt", { defaultValue: "saved" })} · ${new Date(savedAt).toLocaleTimeString()}`
          ) : (
            t("settings.unsavedHint", {
              defaultValue: "discards unsaved changes on close",
            })
          )}
        </p>
        <button
          onClick={save}
          data-testid="st-save"
          className="rounded-md bg-[var(--ti-orange-500)] px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--ti-orange-700)]"
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
