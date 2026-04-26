import { useState } from "react";
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
        <h3 className="font-display text-lg">Debug bundle</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
          Zips app log, tmi log, sanitized config, and the last 5 status.yaml
          files. Send this to <code>daizhe@berkeley.edu</code> with a description
          of the issue.
        </p>
        <Button onClick={exportBundle} className="mt-3" data-testid="st-export-bundle">
          <Download size={14} />
          Export debug bundle
        </Button>
        {last && (
          <p className="mt-2 text-xs text-[var(--ti-ink-500)]" data-testid="st-export-result">
            Saved: <code className="font-mono">{last}</code>
          </p>
        )}
        {error && (
          <p className="mt-2 text-xs text-[#B83232]">{error}</p>
        )}
      </section>

      <section>
        <h3 className="font-display text-lg">About</h3>
        <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
          Tangerine AI Teams v1.5.3-beta · build {new Date().toISOString().slice(0, 10)}
        </p>
        <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
          Auto-update infrastructure ships, but the manifest endpoint is empty
          for the dogfood beta. v1.5.1 will be the first auto-pulled release.
        </p>
      </section>
    </div>
  );
}
