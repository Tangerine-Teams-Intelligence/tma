import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Loader2, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import { detectClaudeCli, detectNodeRuntime, openExternal } from "@/lib/tauri";

/**
 * SW3 — Prerequisite detection.
 *
 * Path D (2026-04-24): we no longer bundle Node (pkg@5.8.1 does not support
 * Node 20+). User must have Node 20+ on PATH, same model as their Claude Code
 * subscription. This screen checks BOTH in one step.
 */
export function SW3ClaudeDetect() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);

  // Claude detection
  const [claudeLoading, setClaudeLoading] = useState(true);
  const [claudeFound, setClaudeFound] = useState(false);
  const [claudePath, setClaudePath] = useState<string | null>(null);
  const [claudeVersion, setClaudeVersion] = useState<string | null>(null);

  // Node detection
  const [nodeLoading, setNodeLoading] = useState(true);
  const [nodeFound, setNodeFound] = useState(false);
  const [nodePath, setNodePath] = useState<string | null>(null);
  const [nodeVersion, setNodeVersion] = useState<string | null>(null);
  const [nodeMeetsMin, setNodeMeetsMin] = useState(false);

  // User explicit override (for cases like "I'll install later")
  const [acknowledgedMissing, setAcknowledgedMissing] = useState(false);

  useEffect(() => {
    let cancel = false;
    (async () => {
      setClaudeLoading(true);
      try {
        const r = await detectClaudeCli();
        if (cancel) return;
        setClaudeFound(r.found);
        setClaudePath(r.path);
        setClaudeVersion(r.version);
        if (r.found && r.path) setField("claudeCliPath", r.path);
        if (r.version) setField("claudeCliVersion", r.version);
      } finally {
        if (!cancel) setClaudeLoading(false);
      }
    })();
    (async () => {
      setNodeLoading(true);
      try {
        const r = await detectNodeRuntime();
        if (cancel) return;
        setNodeFound(r.found);
        setNodePath(r.path);
        setNodeVersion(r.version);
        setNodeMeetsMin(r.meets_min);
        setField("nodeAvailable", r.found && r.meets_min);
        if (r.path) setField("nodePath", r.path);
        if (r.version) setField("nodeVersion", r.version);
      } finally {
        if (!cancel) setNodeLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setField]);

  const claudeOk = claudeFound;
  const nodeOk = nodeFound && nodeMeetsMin;
  const allOk = claudeOk && nodeOk;
  const canContinue = allOk || acknowledgedMissing;

  return (
    <WizardShell
      title="Detect prerequisites"
      subtitle="Tangerine AI Teams uses your existing Claude Code subscription and your Node.js runtime. We'll detect both now."
      stepLabel="Step 3 of 5 — Prerequisites"
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
        {/* Claude Code */}
        <Card>
          <CardContent className="pt-6">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
              Claude Code CLI
            </div>
            {claudeLoading ? (
              <div className="flex items-center gap-3 text-sm text-[var(--ti-ink-700)]">
                <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
                <span>
                  Looking for the <code className="font-mono">claude</code> CLI…
                </span>
              </div>
            ) : claudeOk ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-[#2D8659]">
                  <CheckCircle2 size={16} />
                  <span>Claude Code detected.</span>
                </div>
                <dl className="space-y-1 text-xs text-[var(--ti-ink-700)]">
                  <div className="flex gap-2">
                    <dt className="w-16 text-[var(--ti-ink-500)]">Path</dt>
                    <dd className="font-mono break-all">{claudePath}</dd>
                  </div>
                  {claudeVersion && (
                    <div className="flex gap-2">
                      <dt className="w-16 text-[var(--ti-ink-500)]">Version</dt>
                      <dd className="font-mono">{claudeVersion}</dd>
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
                  Install Claude Code from{" "}
                  <button
                    className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                    onClick={() => openExternal("https://claude.ai/code")}
                    type="button"
                  >
                    claude.ai/code
                    <ExternalLink size={10} className="inline ml-0.5" />
                  </button>
                  , then restart this app.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Node runtime */}
        <Card>
          <CardContent className="pt-6">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
              Node.js Runtime (≥ 20.0.0)
            </div>
            {nodeLoading ? (
              <div className="flex items-center gap-3 text-sm text-[var(--ti-ink-700)]">
                <Loader2 size={16} className="animate-spin text-[var(--ti-orange-500)]" />
                <span>
                  Looking for <code className="font-mono">node</code>…
                </span>
              </div>
            ) : nodeOk ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm text-[#2D8659]">
                  <CheckCircle2 size={16} />
                  <span>Node.js {nodeVersion} detected.</span>
                </div>
                <dl className="space-y-1 text-xs text-[var(--ti-ink-700)]">
                  <div className="flex gap-2">
                    <dt className="w-16 text-[var(--ti-ink-500)]">Path</dt>
                    <dd className="font-mono break-all">{nodePath}</dd>
                  </div>
                  {nodeVersion && (
                    <div className="flex gap-2">
                      <dt className="w-16 text-[var(--ti-ink-500)]">Version</dt>
                      <dd className="font-mono">{nodeVersion}</dd>
                    </div>
                  )}
                </dl>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm text-[#B83232]">
                  <AlertCircle size={16} />
                  <span>
                    {nodeFound
                      ? `Node ${nodeVersion ?? "?"} found, but the Discord bot requires Node 20+.`
                      : "Node.js not found on your PATH."}
                  </span>
                </div>
                <p className="text-sm text-[var(--ti-ink-700)]">
                  Download Node 20 LTS from{" "}
                  <button
                    className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                    onClick={() => openExternal("https://nodejs.org/")}
                    type="button"
                  >
                    nodejs.org
                    <ExternalLink size={10} className="inline ml-0.5" />
                  </button>
                  , install, then restart this app. The Discord bot subprocess runs on your local
                  Node — same model as Claude Code: we use what you already have, never our own
                  cloud runtime.
                </p>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Override */}
        {!allOk && (
          <Card>
            <CardContent className="pt-6">
              <label className="flex items-start gap-2 text-sm text-[var(--ti-ink-700)]">
                <input
                  type="checkbox"
                  checked={acknowledgedMissing}
                  onChange={(e) => setAcknowledgedMissing(e.target.checked)}
                  className="mt-0.5 accent-[var(--ti-orange-500)]"
                />
                <span>
                  I'll install the missing prerequisites later. (Meetings won't run until both are
                  detected on the next launch.)
                </span>
              </label>
            </CardContent>
          </Card>
        )}
      </div>
    </WizardShell>
  );
}
