// === wave 5-α ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  exportDebugBundle,
  // === v1.13.9 round-9 ===
  // R9 deceptive-success audit: power-user "Clear sample data" CTA in
  // Advanced settings. Same backend as the DemoModeBanner button — but
  // discoverable after the user has hidden the banner.
  demoSeedCheck,
  demoSeedClear,
  // === end v1.13.9 round-9 ===
} from "@/lib/tauri";
// === v1.13.9 round-9 ===
import { useStore } from "@/lib/store";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
// === end v1.13.9 round-9 ===
import type { ConfigDraft } from "./Settings";

interface Props {
  draft: ConfigDraft;
  // update unused for now — kept for parity with sibling tabs.
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
}

export function AdvancedSettings(_props: Props) {
  const { t } = useTranslation();
  // === v1.16 Wave 1 === — wave-1.15 W1.1 "Configure with AI" entry砍
  // alongside `onboardingMode` / `setOnboardingMode` (chat onboarding
  // gone). W3 will reintroduce the appropriate settings entry once the
  // new first-run surface lands.
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // === v1.13.9 round-9 ===
  // Sample-data state. We poll once on mount + after each clear so the
  // count reflects disk truth. `null` while the check is pending so we
  // can render a skeleton instead of a misleading "0 sample files".
  const setDemoMode = useStore((s) => s.ui.setDemoMode);
  const [sampleCount, setSampleCount] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState<string | null>(null);
  const [lastClearedCount, setLastClearedCount] = useState<number | null>(null);

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
  // === end v1.13.9 round-9 ===

  const exportBundle = async () => {
    setError(null);
    try {
      const dest = `tangerine-meeting-debug-${new Date().toISOString().slice(0, 10)}.zip`;
      const r = await exportDebugBundle(dest);
      setLast(`${r.zip_path} (${r.file_count} files)`);
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="font-display text-lg">{t("settings.advanced.debugTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
          {t("settings.advanced.debugBody")} <code>daizhe@berkeley.edu</code> {t("settings.advanced.debugBodyTail")}
        </p>
        <Button onClick={exportBundle} className="mt-3" data-testid="st-export-bundle">
          <Download size={14} />
          {t("settings.advanced.exportBundle")}
        </Button>
        {last && (
          <p className="mt-2 text-xs text-[var(--ti-ink-500)]" data-testid="st-export-result">
            {t("settings.advanced.saved")} <code className="font-mono">{last}</code>
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-[var(--ti-danger)]">{error}</p>
        )}
      </section>

      {/* === v1.13.9 round-9 ===
          R9 deceptive-success audit. The Wave 13 demo seed installs
          ~16 sample atoms (`team/decisions/2026-04-22-tier2-pcb-supplier.md`,
          `team/co-thinker.md`, `personal/{alex,sam,jess}/threads/...`)
          on first launch. They render in /memory, /co-thinker, and the
          file tree alongside real atoms. The DemoModeBanner has a
          Clear CTA, but a user who hits "Hide" loses the affordance —
          this section is the recover-able path. */}
      <section data-testid="st-clear-samples-section">
        <h3 className="font-display text-lg">Sample data</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
          Tangerine ships with bundled sample atoms so a fresh install
          isn't empty on first paint. These show up in <code>~/.tangerine-memory/team/</code> and{" "}
          <code>~/.tangerine-memory/personal/&lt;user&gt;/</code> with
          <code>sample: true</code> in their YAML frontmatter. Clearing
          removes <em>only</em> those files — anything you've written
          stays untouched.
        </p>
        {sampleCount === null ? (
          <p className="mt-2 font-mono text-[11px] text-[var(--ti-ink-500)]">
            counting…
          </p>
        ) : sampleCount === 0 ? (
          <p
            data-testid="st-clear-samples-none"
            className="mt-2 font-mono text-[11px] text-[var(--ti-ink-500)]"
          >
            No sample atoms on disk
            {lastClearedCount !== null && lastClearedCount > 0
              ? ` — cleared ${lastClearedCount} file${lastClearedCount === 1 ? "" : "s"}.`
              : "."}
          </p>
        ) : (
          <p
            data-testid="st-clear-samples-count"
            className="mt-2 font-mono text-[11px] text-[var(--ti-ink-500)]"
          >
            {sampleCount} sample atom{sampleCount === 1 ? "" : "s"} on disk
          </p>
        )}
        <Button
          onClick={() => void handleClearSamples()}
          disabled={clearing || sampleCount === 0}
          className="mt-3"
          data-testid="st-clear-samples"
        >
          <Trash2 size={14} />
          {clearing ? "Clearing…" : "Clear sample data"}
        </Button>
        {clearError && (
          <p className="mt-2 text-xs text-[var(--ti-danger)]" data-testid="st-clear-samples-error">
            {clearError}
          </p>
        )}
      </section>
      {/* === end v1.13.9 round-9 === */}

      {/* === v1.16 Wave 1 === — wave-1.15 W1.1 Configure-with-AI section
          砍 (smart layer gone). */}

      <section>
        <h3 className="font-display text-lg">{t("settings.advanced.aboutTitle")}</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
          {t("settings.advanced.aboutBody", { date: new Date().toISOString().slice(0, 10) })}
        </p>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          {t("settings.advanced.aboutHint")}
        </p>
      </section>
    </div>
  );
}
// === end wave 5-α ===
