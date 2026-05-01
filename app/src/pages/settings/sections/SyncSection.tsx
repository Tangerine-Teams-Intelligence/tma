/**
 * v1.20.2 — Sync section: Obsidian-grade visual rewrite.
 *
 * Same content (Mode, GitHub URL, Auto-sync, Personal vault, Meeting repo,
 * Team roster, Debug bundle, Sample data) and the same store-key contract,
 * but the visual layer is now pure typography:
 *
 *   • No card chrome around subsections — hairline (1px stone-200) between
 *     blocks, NOT box borders.
 *   • Mode picker: 2 typography-only buttons. Active = orange underline +
 *     stone-900 label; inactive = stone-500. No filled cards.
 *   • Inputs: stone-200 underline only (no box). Mono for paths, sans for
 *     labels.
 *   • Auto-sync block: a stacked single-column list. Drops the inset card.
 *   • Save bar lives in Settings.tsx; this component is just sections.
 *
 * Backwards-compat preserved end-to-end:
 *   - All `st-sync-*` testids match wave4-d1 verbatim.
 *   - All store keys (gitMode / memoryConfig / gitAutoPullIntervalMin /
 *     gitAutoCommitOnHeartbeat / gitAutoPushOnCommit) untouched.
 *   - `meetings_repo` flows through ConfigDraft `update()` callback as
 *     before.
 *   - Debug bundle / sample-data clear preserved (escape hatches).
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useStore } from "@/lib/store";
import {
  exportDebugBundle,
  demoSeedCheck,
  demoSeedClear,
} from "@/lib/tauri";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
import type { ConfigDraft } from "../Settings";

interface Props {
  draft: ConfigDraft;
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
}

// ---------------------------------------------------------------------------
// Mode picker — Solo vs Team. `gitMode === "skip"` → solo.
// Visual: two buttons, orange underline on active, no filled card chrome.
// ---------------------------------------------------------------------------

function ModePicker() {
  const gitMode = useStore((s) => s.ui.gitMode);
  const setGitMode = useStore((s) => s.ui.setGitMode);
  const isSolo = gitMode === "skip";

  return (
    <section data-testid="st-sync-mode">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        Mode
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        Solo keeps everything local. Team syncs to a shared git remote.
      </p>
      <div
        className="mt-3 flex gap-1"
        role="radiogroup"
        aria-label="Sync mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={isSolo}
          data-testid="st-sync-mode-solo"
          onClick={() => setGitMode("skip")}
          className={
            "shrink-0 border-b-2 px-3 py-2 text-[14px] font-medium transition-colors duration-fast " +
            (isSolo
              ? "border-[var(--ti-orange-500)] text-stone-900 dark:text-stone-100"
              : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
          }
        >
          Solo
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!isSolo}
          data-testid="st-sync-mode-team"
          onClick={() => setGitMode("init")}
          className={
            "shrink-0 border-b-2 px-3 py-2 text-[14px] font-medium transition-colors duration-fast " +
            (!isSolo
              ? "border-[var(--ti-orange-500)] text-stone-900 dark:text-stone-100"
              : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
          }
        >
          Team
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub repo URL — writes to memoryConfig.repoUrl. Input is underline-only
// (no box border).
// ---------------------------------------------------------------------------

function GitHubRepoUrlBlock() {
  const memoryConfig = useStore((s) => s.ui.memoryConfig);
  const setMemoryConfig = useStore((s) => s.ui.setMemoryConfig);
  const url = memoryConfig.repoUrl ?? "";

  return (
    <section data-testid="st-sync-github-url">
      <label
        htmlFor="st-github-url"
        className="block text-[14px] font-medium text-stone-900 dark:text-stone-100"
      >
        GitHub repo URL
      </label>
      <input
        id="st-github-url"
        data-testid="st-github-url"
        value={url}
        onChange={(e) => setMemoryConfig({ repoUrl: e.target.value })}
        placeholder="git@github.com:your-org/team-memory.git"
        className="mt-2 w-full bg-transparent py-1.5 font-mono text-[12px] text-stone-900 placeholder-stone-400 transition-colors focus:outline-none dark:text-stone-100 dark:placeholder-stone-600"
        style={{
          borderBottom: "1px solid var(--ti-border-default)",
        }}
      />
      <p className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        Your remote — Tangerine pushes here, teammates pull from here. The
        repo stays yours; we never proxy.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Personal vault toggle — flips `memoryConfig.personalDirEnabled`.
// ---------------------------------------------------------------------------

function PersonalVaultToggle() {
  const memoryConfig = useStore((s) => s.ui.memoryConfig);
  const setMemoryConfig = useStore((s) => s.ui.setMemoryConfig);
  const enabled = memoryConfig.personalDirEnabled ?? true;

  return (
    <section data-testid="st-sync-personal-vault">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        Personal vault
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        Atoms under <span>personal/&lt;user&gt;/</span> stay git-ignored —
        your private notes never leave this machine.
      </p>
      <label className="mt-3 flex cursor-pointer items-center gap-2 text-[13px] text-stone-700 dark:text-stone-300">
        <input
          type="checkbox"
          data-testid="st-sync-personal-toggle"
          checked={enabled}
          onChange={(e) =>
            setMemoryConfig({ personalDirEnabled: e.target.checked })
          }
          className="accent-[var(--ti-orange-500)]"
        />
        <span>Enable personal vault</span>
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Auto-sync — single column rows (was a card with grid). Same store keys.
// ---------------------------------------------------------------------------

function GitAutoSyncBlock() {
  const { t } = useTranslation();
  const gitAutoPullIntervalMin = useStore((s) => s.ui.gitAutoPullIntervalMin);
  const setGitAutoPullIntervalMin = useStore(
    (s) => s.ui.setGitAutoPullIntervalMin,
  );
  const gitAutoCommitOnHeartbeat = useStore(
    (s) => s.ui.gitAutoCommitOnHeartbeat,
  );
  const setGitAutoCommitOnHeartbeat = useStore(
    (s) => s.ui.setGitAutoCommitOnHeartbeat,
  );
  const gitAutoPushOnCommit = useStore((s) => s.ui.gitAutoPushOnCommit);
  const setGitAutoPushOnCommit = useStore((s) => s.ui.setGitAutoPushOnCommit);
  const setGitMode = useStore((s) => s.ui.setGitMode);

  return (
    <section data-testid="st-git-sync-block">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        {t("git.settingsHeader", { defaultValue: "Auto-sync" })}
      </h2>

      <div className="mt-3 flex items-center justify-between py-2">
        <label
          htmlFor="st-git-pull-interval"
          className="text-[13px] text-stone-700 dark:text-stone-300"
        >
          {t("git.settingsAutoPullInterval", {
            defaultValue: "Pull interval",
          })}
        </label>
        <select
          id="st-git-pull-interval"
          data-testid="st-git-pull-interval"
          value={gitAutoPullIntervalMin}
          onChange={(e) =>
            setGitAutoPullIntervalMin(parseInt(e.target.value, 10) || 15)
          }
          className="rounded-md border border-stone-200 bg-white px-3 py-1.5 font-mono text-[12px] text-stone-900 focus:border-[var(--ti-orange-500)] focus:outline-none dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        >
          <option value={5}>5 min</option>
          <option value={15}>15 min</option>
          <option value={30}>30 min</option>
        </select>
      </div>

      <label className="flex cursor-pointer items-center gap-2 py-2 text-[13px] text-stone-700 dark:text-stone-300">
        <input
          type="checkbox"
          data-testid="st-git-auto-commit"
          checked={gitAutoCommitOnHeartbeat}
          onChange={(e) => setGitAutoCommitOnHeartbeat(e.target.checked)}
          className="accent-[var(--ti-orange-500)]"
        />
        {t("git.settingsAutoCommit", {
          defaultValue: "Auto-commit on heartbeat",
        })}
      </label>

      <label className="flex cursor-pointer items-center gap-2 py-2 text-[13px] text-stone-700 dark:text-stone-300">
        <input
          type="checkbox"
          data-testid="st-git-auto-push"
          checked={gitAutoPushOnCommit}
          onChange={(e) => setGitAutoPushOnCommit(e.target.checked)}
          className="accent-[var(--ti-orange-500)]"
        />
        {t("git.settingsAutoPush", {
          defaultValue: "Auto-push on commit",
        })}
      </label>

      <button
        type="button"
        data-testid="st-git-reset-state"
        onClick={() => setGitMode("unknown")}
        className="mt-3 rounded-md border border-rose-300 px-3 py-1.5 font-mono text-[11px] text-rose-700 transition-colors hover:bg-rose-50 dark:border-rose-900/50 dark:text-rose-400 dark:hover:bg-rose-950/40"
      >
        {t("git.settingsResetState", { defaultValue: "Reset git state" })}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Meeting repo. Underline-only input.
// ---------------------------------------------------------------------------

function MeetingRepoBlock({ draft, update }: Props) {
  const { t } = useTranslation();
  return (
    <section data-testid="st-sync-meetings-repo">
      <label
        htmlFor="st-meetings-repo"
        className="block text-[14px] font-medium text-stone-900 dark:text-stone-100"
      >
        {t("settings.general.meetingsRepo", { defaultValue: "Meetings repo" })}
      </label>
      <input
        id="st-meetings-repo"
        value={draft.meetings_repo}
        onChange={(e) => update("meetings_repo", e.target.value)}
        placeholder="C:\\Users\\you\\tangerine-meetings"
        data-testid="st-meetings-repo"
        className="mt-2 w-full bg-transparent py-1.5 font-mono text-[12px] text-stone-900 placeholder-stone-400 transition-colors focus:outline-none dark:text-stone-100 dark:placeholder-stone-600"
        style={{
          borderBottom: "1px solid var(--ti-border-default)",
        }}
      />
      <p className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        {t("settings.general.meetingsRepoHint", {
          defaultValue: "Local folder for meeting notes / transcripts.",
        })}
      </p>

      <p className="mt-3 font-mono text-[11px] text-stone-400 dark:text-stone-600">
        configs persist to ~/.tmi/config.yaml · keys to OS keychain
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Team roster. Each row gets stacked underline-only inputs + Remove text-button.
// ---------------------------------------------------------------------------

function TeamRosterBlock({ draft, update }: Props) {
  const { t } = useTranslation();
  const setRow = (
    i: number,
    patch: Partial<ConfigDraft["team"][number]>,
  ) => {
    const next = draft.team.map((m, idx) =>
      idx === i ? { ...m, ...patch } : m,
    );
    update("team", next);
  };
  const removeRow = (i: number) => {
    update(
      "team",
      draft.team.filter((_, idx) => idx !== i),
    );
  };
  const addRow = () => {
    update("team", [
      ...draft.team,
      { alias: "", display_name: "", discord_id: "" },
    ]);
  };

  return (
    <section data-testid="st-sync-team-roster">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        Team roster
      </h2>
      <ul className="mt-3 divide-y divide-stone-200 dark:divide-stone-800">
        {draft.team.map((m, i) => (
          <li
            key={i}
            data-testid={`team-row-${i}`}
            className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-3 py-2"
          >
            <input
              value={m.alias}
              onChange={(e) => setRow(i, { alias: e.target.value })}
              placeholder="alias"
              className="bg-transparent py-1 font-mono text-[12px] text-stone-900 placeholder-stone-400 focus:outline-none dark:text-stone-100"
              style={{
                borderBottom: "1px solid var(--ti-border-faint)",
              }}
            />
            <input
              value={m.display_name}
              onChange={(e) => setRow(i, { display_name: e.target.value })}
              placeholder="display name"
              className="bg-transparent py-1 text-[13px] text-stone-900 placeholder-stone-400 focus:outline-none dark:text-stone-100"
              style={{
                borderBottom: "1px solid var(--ti-border-faint)",
              }}
            />
            <input
              value={m.discord_id}
              onChange={(e) => setRow(i, { discord_id: e.target.value })}
              placeholder="discord id"
              className="bg-transparent py-1 font-mono text-[11px] text-stone-700 placeholder-stone-400 focus:outline-none dark:text-stone-300"
              style={{
                borderBottom: "1px solid var(--ti-border-faint)",
              }}
            />
            <button
              type="button"
              onClick={() => removeRow(i)}
              data-testid={`team-remove-${i}`}
              aria-label="Remove row"
              className="font-mono text-[11px] text-stone-400 transition-colors hover:text-rose-700 dark:text-stone-600 dark:hover:text-rose-400"
            >
              remove
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={addRow}
        data-testid="team-add"
        className="mt-3 font-mono text-[11px] text-stone-500 transition-colors hover:text-[var(--ti-orange-500)] dark:text-stone-500 dark:hover:text-[var(--ti-orange-500)]"
      >
        + {t("settings.team.addRow", { defaultValue: "add row" })}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Debug bundle + sample data clear. Same Tauri commands; new visual.
// ---------------------------------------------------------------------------

function DebugAndSamplesBlock() {
  const { t } = useTranslation();
  const setDemoMode = useStore((s) => s.ui.setDemoMode);

  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sampleCount, setSampleCount] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [lastClearedCount, setLastClearedCount] = useState<number | null>(
    null,
  );

  const refreshSampleCount = async () => {
    try {
      const r = await demoSeedCheck();
      setSampleCount(r.sample_count);
    } catch {
      setSampleCount(0);
    }
  };

  useEffect(() => {
    void refreshSampleCount();
  }, []);

  const handleClearSamples = async () => {
    if (clearing) return;
    setClearing(true);
    setClearError(null);
    try {
      const r = await demoSeedClear();
      setLastClearedCount(r.removed_files);
      setDemoMode(false);
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(MEMORY_REFRESHED_EVENT));
      }
      await refreshSampleCount();
    } catch (e) {
      setClearError(String(e));
    } finally {
      setClearing(false);
    }
  };

  const exportBundle = async () => {
    setError(null);
    try {
      const dest = `tangerine-meeting-debug-${new Date()
        .toISOString()
        .slice(0, 10)}.zip`;
      const r = await exportDebugBundle(dest);
      setLast(`${r.zip_path} (${r.file_count} files)`);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <section className="flex flex-col gap-6" data-testid="st-sync-debug">
      <div>
        <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
          {t("settings.advanced.debugTitle", { defaultValue: "Debug bundle" })}
        </h2>
        <button
          type="button"
          onClick={exportBundle}
          data-testid="st-export-bundle"
          className="mt-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 font-mono text-[11px] text-stone-700 transition-colors hover:border-[var(--ti-orange-500)] hover:text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300 dark:hover:text-stone-100"
        >
          {t("settings.advanced.exportBundle", {
            defaultValue: "Export bundle",
          })}
        </button>
        {last && (
          <p
            className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500"
            data-testid="st-export-result"
          >
            {last}
          </p>
        )}
        {error && (
          <p className="mt-2 font-mono text-[11px] text-rose-700 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>

      <div data-testid="st-clear-samples-section">
        <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
          Sample data
        </h2>
        {sampleCount === null ? (
          <p className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500">
            counting…
          </p>
        ) : sampleCount === 0 ? (
          <p
            data-testid="st-clear-samples-none"
            className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500"
          >
            no sample atoms on disk
            {lastClearedCount !== null && lastClearedCount > 0
              ? ` · cleared ${lastClearedCount} file${lastClearedCount === 1 ? "" : "s"}`
              : ""}
          </p>
        ) : (
          <p
            data-testid="st-clear-samples-count"
            className="mt-2 font-mono text-[11px] text-stone-500 dark:text-stone-500"
          >
            {sampleCount} sample atom{sampleCount === 1 ? "" : "s"} on disk
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleClearSamples()}
          disabled={clearing || sampleCount === 0}
          data-testid="st-clear-samples"
          className="mt-2 rounded-md border border-stone-200 bg-white px-3 py-1.5 font-mono text-[11px] text-stone-700 transition-colors hover:border-rose-300 hover:text-rose-700 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300"
        >
          {clearing ? "Clearing…" : "Clear sample data"}
        </button>
        {clearError && (
          <p
            className="mt-2 font-mono text-[11px] text-rose-700 dark:text-rose-400"
            data-testid="st-clear-samples-error"
          >
            {clearError}
          </p>
        )}
      </div>
    </section>
  );
}

export function SyncSection({ draft, update }: Props) {
  const gitMode = useStore((s) => s.ui.gitMode);
  const isSolo = gitMode === "skip";

  return (
    <div className="flex flex-col gap-8" data-testid="st-section-sync">
      <ModePicker />
      {!isSolo && (
        <>
          <div
            aria-hidden
            className="h-px w-full bg-stone-200 dark:bg-stone-800"
          />
          <GitHubRepoUrlBlock />
          <div
            aria-hidden
            className="h-px w-full bg-stone-200 dark:bg-stone-800"
          />
          <GitAutoSyncBlock />
        </>
      )}
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <PersonalVaultToggle />
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <MeetingRepoBlock draft={draft} update={update} />
      {!isSolo && (
        <>
          <div
            aria-hidden
            className="h-px w-full bg-stone-200 dark:bg-stone-800"
          />
          <TeamRosterBlock draft={draft} update={update} />
        </>
      )}
      <div
        aria-hidden
        className="h-px w-full bg-stone-200 dark:bg-stone-800"
      />
      <DebugAndSamplesBlock />
    </div>
  );
}

export default SyncSection;
