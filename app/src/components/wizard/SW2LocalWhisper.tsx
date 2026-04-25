import { useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  ExternalLink,
  AlertCircle,
  CheckCircle2,
  Loader2,
  Download,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { WizardShell } from "./WizardShell";
import { useStore } from "@/lib/store";
import {
  openExternal,
  validateWhisperKey,
  downloadWhisperModel,
  getWhisperModelStatus,
  type WhisperModelStatus,
} from "@/lib/tauri";

export function SW2LocalWhisper() {
  const back = useStore((s) => s.wizard.back);
  const next = useStore((s) => s.wizard.next);
  const setField = useStore((s) => s.wizard.setField);
  const collected = useStore((s) => s.wizard.collected);

  const [mode, setMode] = useState<"local" | "openai">(
    collected.whisperMode ?? "local",
  );
  const [status, setStatus] = useState<WhisperModelStatus>({
    state: "unknown",
    path: null,
    bytes: 0,
  });
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [progressBytes, setProgressBytes] = useState(0);

  // OpenAI fallback fields
  const [advancedOpen, setAdvancedOpen] = useState(mode === "openai");
  const [key, setKey] = useState(collected.whisperKey ?? "");
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  const unsubRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    void getWhisperModelStatus().then(setStatus);
  }, []);
  useEffect(() => () => unsubRef.current?.(), []);

  const localKeyValid = key.startsWith("sk-") && key.length >= 40;

  async function handleDownload(): Promise<void> {
    setDownloadError(null);
    setDownloading(true);
    setProgressBytes(0);
    try {
      const handle = await downloadWhisperModel("small", (evt) => {
        if (evt.event === "progress") setProgressBytes(evt.downloaded);
        if (evt.event === "done") {
          setStatus({ state: "ready", path: evt.path, bytes: progressBytes });
        }
        if (evt.event === "error") setDownloadError(evt.message);
      });
      unsubRef.current = handle.unsubscribe;
      const final = await handle.completion;
      setStatus(final);
    } catch (e) {
      setDownloadError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }

  async function handleContinue(): Promise<void> {
    if (mode === "local") {
      if (status.state !== "ready") return;
      setField("whisperMode", "local");
      next();
      return;
    }
    setKeyError(null);
    setValidating(true);
    try {
      const r = await validateWhisperKey(key);
      if (!r.ok) {
        setKeyError(r.error ?? "Key didn't validate.");
        return;
      }
      setField("whisperMode", "openai");
      setField("whisperKey", key);
      next();
    } finally {
      setValidating(false);
    }
  }

  const localReady = status.state === "ready";
  const continueDisabled =
    mode === "local"
      ? !localReady || downloading
      : !localKeyValid || validating;

  return (
    <WizardShell
      title="Transcription engine"
      subtitle="Tangerine AI Teams ships a bundled local Whisper model so you pay $0 per meeting. First run downloads ~244 MB to your machine; everything stays local."
      stepLabel="Step 2 of 5 — Whisper transcription"
      footer={
        <>
          <Button variant="outline" onClick={back}>
            ← Back
          </Button>
          <Button onClick={handleContinue} disabled={continueDisabled}>
            {downloading || validating ? (
              <>
                <Loader2 size={16} className="animate-spin" />{" "}
                {downloading ? "Downloading…" : "Validating…"}
              </>
            ) : (
              "Next: Detect Claude →"
            )}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* Local model card */}
        <Card>
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-[var(--ti-ink-900)]">
                  Local Whisper (recommended)
                </p>
                <p className="text-sm text-[var(--ti-ink-700)]">
                  faster-whisper, small model, int8 quantised. ~244 MB on disk.
                  Runs on CPU. No API key, no per-minute cost, audio never leaves
                  your machine.
                </p>
              </div>
              {localReady && (
                <span className="flex items-center gap-1 text-xs text-[#2D8659] whitespace-nowrap">
                  <CheckCircle2 size={14} /> Ready
                </span>
              )}
            </div>

            {!localReady && !downloading && (
              <Button onClick={handleDownload} disabled={downloading}>
                <Download size={16} /> Download model (244 MB, one-time)
              </Button>
            )}

            {downloading && (
              <div className="space-y-1">
                <div className="h-2 w-full bg-[var(--ti-ink-100)] rounded">
                  <div
                    className="h-2 bg-[var(--ti-orange-500)] rounded"
                    style={{
                      width: `${Math.min(100, (progressBytes / (244 * 1024 * 1024)) * 100)}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-[var(--ti-ink-700)]">
                  {(progressBytes / (1024 * 1024)).toFixed(1)} MB downloaded…
                </p>
              </div>
            )}

            {downloadError && (
              <p className="flex items-center gap-1 text-xs text-[#B83232]">
                <AlertCircle size={12} /> {downloadError}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Advanced: OpenAI fallback */}
        <button
          type="button"
          className="flex items-center gap-1 text-xs text-[var(--ti-ink-700)] hover:text-[var(--ti-ink-900)]"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          Advanced: use OpenAI Whisper instead
        </button>

        {advancedOpen && (
          <Card>
            <CardContent className="pt-6 space-y-3">
              <p className="text-sm text-[var(--ti-ink-700)]">
                Opt-in OpenAI cloud Whisper for max accuracy or weak CPUs. ~$0.006/min
                ($0.36/hr). Audio is sent to OpenAI.
              </p>
              <div className="space-y-2">
                <Label htmlFor="whisper-key">OpenAI API key</Label>
                <div className="flex items-center gap-2">
                  <Input
                    id="whisper-key"
                    type={showKey ? "text" : "password"}
                    value={key}
                    onChange={(e) => {
                      setKey(e.target.value);
                      if (e.target.value.length > 0) setMode("openai");
                      else setMode("local");
                    }}
                    placeholder="sk-…"
                    invalid={!!keyError}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    aria-label={showKey ? "Hide key" : "Show key"}
                  >
                    {showKey ? <EyeOff size={16} /> : <Eye size={16} />}
                  </Button>
                </div>
                {keyError && (
                  <p className="flex items-center gap-1 text-xs text-[#B83232]">
                    <AlertCircle size={12} /> {keyError}
                  </p>
                )}
                {localKeyValid && !keyError && (
                  <p className="flex items-center gap-1 text-xs text-[#2D8659]">
                    <CheckCircle2 size={12} /> Key format valid.
                  </p>
                )}
                <button
                  className="text-xs text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                  onClick={() =>
                    openExternal("https://platform.openai.com/api-keys")
                  }
                  type="button"
                >
                  Where do I get this? <ExternalLink size={10} className="inline" />
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <input
                  id="use-openai"
                  type="radio"
                  checked={mode === "openai"}
                  onChange={() => setMode("openai")}
                />
                <label htmlFor="use-openai">Use OpenAI mode for this install</label>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </WizardShell>
  );
}
