// === wave 5-α ===
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { exportDebugBundle } from "@/lib/tauri";
import type { ConfigDraft } from "./Settings";

interface Props {
  draft: ConfigDraft;
  // update unused for now — kept for parity with sibling tabs.
  update: <K extends keyof ConfigDraft>(key: K, val: ConfigDraft[K]) => void;
}

export function AdvancedSettings(_props: Props) {
  const { t } = useTranslation();
  const [last, setLast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
