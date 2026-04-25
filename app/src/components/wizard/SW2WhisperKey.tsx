import { useState } from "react";
import { Eye, EyeOff, ExternalLink, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import { openExternal, validateWhisperKey } from "@/lib/tauri";

export function SW2WhisperKey() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);
  const collected = useStore((s) => s.wizard.collected);

  const [key, setKey] = useState(collected.whisperKey ?? "");
  const [show, setShow] = useState(false);
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const localValid = key.startsWith("sk-") && key.length >= 40;

  async function handleContinue() {
    setError(null);
    setValidating(true);
    try {
      const r = await validateWhisperKey(key);
      if (!r.ok) {
        setError(r.error ?? "Key didn't validate.");
        return;
      }
      setField("whisperKey", key);
      next();
    } finally {
      setValidating(false);
    }
  }

  return (
    <WizardShell
      title="Whisper API key"
      subtitle="Tangerine AI Teams uses OpenAI Whisper to transcribe Discord voice. We never send your key anywhere except OpenAI."
      stepLabel="Step 2 of 5 — Whisper transcription"
      footer={
        <>
          <Button variant="outline" onClick={back}>
            ← Back
          </Button>
          <Button onClick={handleContinue} disabled={!localValid || validating}>
            {validating ? (
              <>
                <Loader2 size={16} className="animate-spin" /> Validating…
              </>
            ) : (
              "Next: Detect Claude →"
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="whisper-key">OpenAI API key</Label>
          <div className="flex items-center gap-2">
            <Input
              id="whisper-key"
              type={show ? "text" : "password"}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="sk-…"
              invalid={!!error}
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="icon"
              type="button"
              onClick={() => setShow(!show)}
              aria-label={show ? "Hide key" : "Show key"}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
          </div>
          {error && (
            <p className="flex items-center gap-1 text-xs text-[#B83232]">
              <AlertCircle size={12} /> {error}
            </p>
          )}
          {localValid && !error && (
            <p className="flex items-center gap-1 text-xs text-[#2D8659]">
              <CheckCircle2 size={12} /> Key format valid.
            </p>
          )}
          <button
            className="text-xs text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
            onClick={() => openExternal("https://platform.openai.com/api-keys")}
            type="button"
          >
            Where do I get this? <ExternalLink size={10} className="inline" />
          </button>
        </div>

        <Card>
          <CardContent className="pt-6 text-sm text-[var(--ti-ink-700)]">
            <p className="mb-1 font-medium text-[var(--ti-ink-900)]">Cost</p>
            <p>
              ~$0.006 / minute of audio (about $0.36 per hour of meeting). Whisper bills per second,
              so a 30-min standup costs roughly $0.18.
            </p>
          </CardContent>
        </Card>
      </div>
    </WizardShell>
  );
}
