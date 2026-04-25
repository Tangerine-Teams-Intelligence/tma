import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import { detectClaudeCli, openExternal } from "@/lib/tauri";

export function SW3ClaudeDetect() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);

  const [loading, setLoading] = useState(true);
  const [found, setFound] = useState(false);
  const [path, setPath] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [acknowledgedMissing, setAcknowledgedMissing] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setLoading(true);
      try {
        const r = await detectClaudeCli();
        if (cancel) return;
        setFound(r.found);
        setPath(r.path);
        setVersion(r.version);
        if (r.found && r.path) setField("claudeCliPath", r.path);
        if (r.version) setField("claudeCliVersion", r.version);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setField]);

  const canContinue = found || acknowledgedMissing;

  return (
    <WizardShell
      title="Detect Claude Code"
      subtitle="Tangerine AI Teams writes meeting decisions into your team's Claude Code project. We'll detect the CLI now."
      stepLabel="Step 3 of 5 — Claude Code"
      footer={
        <>
          <Button variant="outline" onClick={back}>
            ← Back
          </Button>
          <Button onClick={next} disabled={!canContinue}>
            Next: Team members →
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Card>
          <CardContent className="pt-6">
            {loading ? (
              <div className="flex items-center gap-3 text-sm text-[var(--ti-ink-700)]">
                <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
                <span>Looking for the <code className="font-mono">claude</code> CLI…</span>
              </div>
            ) : found ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-[#2D8659]">
                  <CheckCircle2 size={16} />
                  <span>Claude Code detected.</span>
                </div>
                <dl className="space-y-1 text-xs text-[var(--ti-ink-700)]">
                  <div className="flex gap-2">
                    <dt className="w-16 text-[var(--ti-ink-500)]">Path</dt>
                    <dd className="font-mono">{path}</dd>
                  </div>
                  {version && (
                    <div className="flex gap-2">
                      <dt className="w-16 text-[var(--ti-ink-500)]">Version</dt>
                      <dd className="font-mono">{version}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-[#B83232]">
                  <AlertCircle size={16} />
                  <span>
                    <code className="font-mono">claude</code> CLI not found on your PATH.
                  </span>
                </div>
                <p className="text-sm text-[var(--ti-ink-700)]">
                  You can install Claude Code from{" "}
                  <button
                    className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                    onClick={() => openExternal("https://claude.ai/code")}
                    type="button"
                  >
                    claude.ai/code
                    <ExternalLink size={10} className="inline ml-0.5" />
                  </button>
                  . You can also continue without it — Claude is only required when applying
                  meeting outputs.
                </p>
                <label className="flex items-center gap-2 text-sm text-[var(--ti-ink-700)]">
                  <input
                    type="checkbox"
                    checked={acknowledgedMissing}
                    onChange={(e) => setAcknowledgedMissing(e.target.checked)}
                    className="accent-[var(--ti-orange-500)]"
                  />
                  I have a Claude Code subscription and will install the CLI later.
                </label>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </WizardShell>
  );
}
