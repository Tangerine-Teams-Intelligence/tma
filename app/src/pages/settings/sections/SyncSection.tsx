/**
 * v1.16 Wave 4 D1 — Sync section.
 *
 * Consolidates the legacy "Team" + "Advanced" tabs' git/sync content into
 * one screen. Layout:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Mode                                     │
 *   │   ( ) Solo         (•) Team              │
 *   │                                          │
 *   │ GitHub repo URL                          │
 *   │   [_______________________________]      │
 *   │                                          │
 *   │ Personal vault                           │
 *   │   [x] Enable personal/<user>/ scope      │
 *   │                                          │
 *   │ Auto-pull / commit / push                │
 *   │   (existing wave-10 GitSyncSettingsBlock)│
 *   │                                          │
 *   │ Meeting repo                             │
 *   │   [_______________________________]      │
 *   │                                          │
 *   │ Team roster (Solo mode hides this)       │
 *   │   ...                                    │
 *   │                                          │
 *   │ Debug bundle / Sample data / About       │
 *   └──────────────────────────────────────────┘
 *
 * Backwards-compat:
 *   - `gitMode` store key untouched
 *   - `memoryConfig.personalDirEnabled` untouched
 *   - `gitAutoPullIntervalMin` / `gitAutoCommitOnHeartbeat` /
 *     `gitAutoPushOnCommit` untouched
 *   - `meetings_repo` flows through the same ConfigDraft `update()`
 *     callback as the legacy GeneralSettings
 *
 * What's CUT vs the old layout:
 *   - LLM adapter config (AdaptersSettings) — entire tab dropped, smart
 *     layer is gone in v1.16 Wave 1
 *   - Whisper config — also dropped (same reason)
 *   - Tour replay — dropped, lives in WelcomeOverlay's own retrigger
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
// Mode picker — Solo vs Team. Drives whether the team-roster block renders.
// `gitMode` store key is the source of truth; we expose a synthetic
// "solo" / "team" abstraction over it (gitMode === "skip" → solo, anything
// else → team-capable).
// ---------------------------------------------------------------------------

function ModePicker() {
  const gitMode = useStore((s) => s.ui.gitMode);
  const setGitMode = useStore((s) => s.ui.setGitMode);

  const isSolo = gitMode === "skip";

  return (
    <section data-testid="st-sync-mode">
      <h3 className="font-display text-base">Mode</h3>
      <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
        Solo keeps everything local. Team syncs to a shared git remote so
        teammates see the same atoms.
      </p>
      <div
        className="mt-3 flex gap-2"
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
            "flex-1 rounded-md border px-3 py-2 text-sm transition-colors duration-fast " +
            (isSolo
              ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-ink-900)]"
              : "border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
          }
        >
          <div className="font-medium">Solo</div>
          <div className="text-xs text-[var(--ti-ink-500)]">
            Local only — no git remote
          </div>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={!isSolo}
          data-testid="st-sync-mode-team"
          onClick={() => setGitMode("init")}
          className={
            "flex-1 rounded-md border px-3 py-2 text-sm transition-colors duration-fast " +
            (!isSolo
              ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] text-[var(--ti-ink-900)]"
              : "border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-200)]")
          }
        >
          <div className="font-medium">Team</div>
          <div className="text-xs text-[var(--ti-ink-500)]">
            Push to shared git remote
          </div>
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// GitHub repo URL — writes to memoryConfig (the canonical place the rest of
// the app reads remote URL from).
// ---------------------------------------------------------------------------

function GitHubRepoUrlBlock() {
  const memoryConfig = useStore((s) => s.ui.memoryConfig);
  const setMemoryConfig = useStore((s) => s.ui.setMemoryConfig);
  const url = memoryConfig.repoUrl ?? "";

  return (
    <section data-testid="st-sync-github-url">
      <Label htmlFor="st-github-url">GitHub repo URL</Label>
      <Input
        id="st-github-url"
        data-testid="st-github-url"
        value={url}
        onChange={(e) => setMemoryConfig({ repoUrl: e.target.value })}
        placeholder="git@github.com:your-org/team-memory.git"
      />
      <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
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
      <h3 className="font-display text-base">Personal vault</h3>
      <p className="mt-1 text-sm text-[var(--ti-ink-500)]">
        When on, atoms under <code>personal/&lt;user&gt;/</code> stay
        git-ignored — your private notes never leave this machine even when
        Team mode is enabled.
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="st-sync-personal-toggle"
          checked={enabled}
          onChange={(e) =>
            setMemoryConfig({ personalDirEnabled: e.target.checked })
          }
        />
        <span>Enable personal vault</span>
      </label>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Git auto-sync block — copy of the wave-10 GitSyncSettingsBlock from the
// legacy GeneralSettings.tsx, lifted here so it lives next to the other
// remote / sync controls instead of a vanished "General" tab.
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
    <section
      data-testid="st-git-sync-block"
      className="rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 py-3"
    >
      <div className="mb-2 text-[12px] font-semibold text-[var(--ti-ink-700)]">
        {t("git.settingsHeader", { defaultValue: "Auto-sync" })}
      </div>

      <div className="mb-2">
        <Label htmlFor="st-git-pull-interval">
          {t("git.settingsAutoPullInterval", {
            defaultValue: "Auto-pull interval (minutes)",
          })}
        </Label>
        <select
          id="st-git-pull-interval"
          data-testid="st-git-pull-interval"
          value={gitAutoPullIntervalMin}
          onChange={(e) =>
            setGitAutoPullIntervalMin(parseInt(e.target.value, 10) || 15)
          }
          className="mt-1 h-9 w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-3 text-sm"
        >
          <option value={5}>5</option>
          <option value={15}>15</option>
          <option value={30}>30</option>
        </select>
      </div>

      <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--ti-ink-700)]">
        <input
          type="checkbox"
          data-testid="st-git-auto-commit"
          checked={gitAutoCommitOnHeartbeat}
          onChange={(e) => setGitAutoCommitOnHeartbeat(e.target.checked)}
        />
        {t("git.settingsAutoCommit", {
          defaultValue: "Auto-commit on heartbeat",
        })}
      </label>

      <label className="mt-2 flex items-center gap-2 text-[12px] text-[var(--ti-ink-700)]">
        <input
          type="checkbox"
          data-testid="st-git-auto-push"
          checked={gitAutoPushOnCommit}
          onChange={(e) => setGitAutoPushOnCommit(e.target.checked)}
        />
        {t("git.settingsAutoPush", {
          defaultValue: "Auto-push on commit",
        })}
      </label>

      <button
        type="button"
        data-testid="st-git-reset-state"
        onClick={() => setGitMode("unknown")}
        className="mt-3 rounded-md border border-rose-300 px-3 py-1.5 text-[12px] text-rose-700 hover:bg-rose-50"
      >
        {t("git.settingsResetState", { defaultValue: "Reset git state" })}
      </button>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Meeting repo + team roster. Pulled from the legacy GeneralSettings +
// TeamSettings tabs. Roster only renders when not Solo (Solo = no team).
// ---------------------------------------------------------------------------

function MeetingRepoBlock({ draft, update }: Props) {
  const { t } = useTranslation();
  return (
    <section data-testid="st-sync-meetings-repo">
      <Label htmlFor="st-meetings-repo">
        {t("settings.general.meetingsRepo", { defaultValue: "Meetings repo" })}
      </Label>
      <Input
        id="st-meetings-repo"
        value={draft.meetings_repo}
        onChange={(e) => update("meetings_repo", e.target.value)}
        placeholder="C:\\Users\\you\\tangerine-meetings"
        data-testid="st-meetings-repo"
      />
      <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
        {t("settings.general.meetingsRepoHint", {
          defaultValue: "Local folder for meeting notes / transcripts.",
        })}
      </p>
    </section>
  );
}

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
      <h3 className="font-display text-base">Team roster</h3>
      <div className="mt-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-2 text-xs text-[var(--ti-ink-500)]">
        <Label>{t("settings.team.alias", { defaultValue: "Alias" })}</Label>
        <Label>
          {t("settings.team.displayName", { defaultValue: "Display name" })}
        </Label>
        <Label>
          {t("settings.team.discordId", { defaultValue: "Discord ID" })}
        </Label>
        <span />
      </div>
      <div className="flex flex-col gap-2">
        {draft.team.map((m, i) => (
          <div
            key={i}
            className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2"
            data-testid={`team-row-${i}`}
          >
            <Input
              value={m.alias}
              onChange={(e) => setRow(i, { alias: e.target.value })}
              placeholder="daizhe"
            />
            <Input
              value={m.display_name}
              onChange={(e) => setRow(i, { display_name: e.target.value })}
              placeholder="Daizhe"
            />
            <Input
              value={m.discord_id}
              onChange={(e) => setRow(i, { discord_id: e.target.value })}
              placeholder="1234567890..."
            />
            <Button
              variant="ghost"
              size="icon"
              onClick={() => removeRow(i)}
              data-testid={`team-remove-${i}`}
              aria-label="Remove row"
            >
              <Trash2 size={16} />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={addRow}
          data-testid="team-add"
          className="self-start"
        >
          <Plus size={14} />
          {t("settings.team.addRow", { defaultValue: "Add row" })}
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Debug bundle + sample-data clear — survived the cull because they're escape
// hatches, not LLM-related power-user knobs.
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
    <section className="flex flex-col gap-4" data-testid="st-sync-debug">
      <div>
        <h3 className="font-display text-base">
          {t("settings.advanced.debugTitle", { defaultValue: "Debug bundle" })}
        </h3>
        <Button
          onClick={exportBundle}
          className="mt-2"
          data-testid="st-export-bundle"
        >
          <Download size={14} />
          {t("settings.advanced.exportBundle", {
            defaultValue: "Export bundle",
          })}
        </Button>
        {last && (
          <p
            className="mt-1 text-xs text-[var(--ti-ink-500)]"
            data-testid="st-export-result"
          >
            <code className="font-mono">{last}</code>
          </p>
        )}
        {error && (
          <p className="mt-1 text-xs text-[var(--ti-danger)]">{error}</p>
        )}
      </div>

      <div data-testid="st-clear-samples-section">
        <h3 className="font-display text-base">Sample data</h3>
        {sampleCount === null ? (
          <p className="mt-1 font-mono text-[11px] text-[var(--ti-ink-500)]">
            counting…
          </p>
        ) : sampleCount === 0 ? (
          <p
            data-testid="st-clear-samples-none"
            className="mt-1 font-mono text-[11px] text-[var(--ti-ink-500)]"
          >
            No sample atoms on disk
            {lastClearedCount !== null && lastClearedCount > 0
              ? ` — cleared ${lastClearedCount} file${lastClearedCount === 1 ? "" : "s"}.`
              : "."}
          </p>
        ) : (
          <p
            data-testid="st-clear-samples-count"
            className="mt-1 font-mono text-[11px] text-[var(--ti-ink-500)]"
          >
            {sampleCount} sample atom{sampleCount === 1 ? "" : "s"} on disk
          </p>
        )}
        <Button
          onClick={() => void handleClearSamples()}
          disabled={clearing || sampleCount === 0}
          className="mt-2"
          data-testid="st-clear-samples"
        >
          <Trash2 size={14} />
          {clearing ? "Clearing…" : "Clear sample data"}
        </Button>
        {clearError && (
          <p
            className="mt-1 text-xs text-[var(--ti-danger)]"
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
          <GitHubRepoUrlBlock />
          <GitAutoSyncBlock />
        </>
      )}
      <PersonalVaultToggle />
      <MeetingRepoBlock draft={draft} update={update} />
      {!isSolo && <TeamRosterBlock draft={draft} update={update} />}
      <hr className="border-[var(--ti-border-faint)]" />
      <DebugAndSamplesBlock />
    </div>
  );
}

export default SyncSection;
