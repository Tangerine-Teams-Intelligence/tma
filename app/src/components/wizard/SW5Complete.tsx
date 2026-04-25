import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import { finishWizard } from "@/lib/tauri";

export function SW5Complete() {
  const back = useStore((s) => s.wizard.back);
  const reset = useStore((s) => s.wizard.reset);
  const collected = useStore((s) => s.wizard.collected);
  const markLoaded = useStore((s) => s.config.markLoaded);
  const pushToast = useStore((s) => s.ui.pushToast);
  const navigate = useNavigate();

  const [committing, setCommitting] = useState(false);
  const [committed, setCommitted] = useState(false);

  async function commit() {
    setCommitting(true);
    try {
      await finishWizard(collected);
      setCommitted(true);
      markLoaded();
      pushToast("success", "Setup complete. Tangerine AI Teams is ready.");
    } catch (e) {
      pushToast("error", `Setup failed: ${(e as Error).message}`);
    } finally {
      setCommitting(false);
    }
  }

  function launchApp() {
    reset();
    navigate("/");
  }

  return (
    <WizardShell
      title={committed ? "Setup complete" : "Review your setup"}
      subtitle={
        committed
          ? "Tangerine AI Teams is ready. Create your first meeting whenever you're ready."
          : "Confirm everything below, then we'll write your config and register the secrets."
      }
      stepLabel="Step 5 of 5 — Finish"
      footer={
        committed ? (
          <>
            <span />
            <Button onClick={launchApp}>Launch Tangerine AI Teams →</Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={back} disabled={committing}>
              ← Back
            </Button>
            <Button onClick={commit} disabled={committing}>
              {committing ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Writing config…
                </>
              ) : (
                "Looks good — finish"
              )}
            </Button>
          </>
        )
      }
    >
      {committed ? (
        <div className="flex h-full flex-col items-center justify-center text-center">
          <CheckCircle2 size={56} className="mb-4 text-[#2D8659]" />
          <p className="text-sm text-[var(--ti-ink-700)]">
            Config written to <code className="font-mono">~/.tmi/config.yaml</code>. Secrets stored
            in your Windows user environment.
          </p>
        </div>
      ) : (
        <Card>
          <CardContent className="pt-6">
            <dl className="grid grid-cols-[180px_1fr] gap-y-3 text-sm">
              <Row label="Discord guild" value={collected.guildId ?? "(skipped — set later)"} />
              <Row
                label="Discord token"
                value={
                  collected.discordToken
                    ? mask(collected.discordToken)
                    : "(none)"
                }
              />
              <Row
                label="Whisper key"
                value={collected.whisperKey ? mask(collected.whisperKey) : "(none)"}
              />
              <Row label="Claude CLI" value={collected.claudeCliPath ?? "(not detected)"} />
              <Row
                label="Team"
                value={
                  collected.team
                    ?.map((m) => m.alias)
                    .filter(Boolean)
                    .join(", ") || "(none)"
                }
              />
            </dl>
          </CardContent>
        </Card>
      )}
    </WizardShell>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="text-[var(--ti-ink-500)]">{label}</dt>
      <dd className="font-mono text-xs text-[var(--ti-ink-900)] break-all">{value}</dd>
    </>
  );
}

function mask(v: string): string {
  if (v.length <= 8) return "********";
  return `${v.slice(0, 4)}…${v.slice(-4)} (${v.length} chars)`;
}
