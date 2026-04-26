import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Mic,
  Square,
  Loader2,
  AlertCircle,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  voiceNotesRecordAndTranscribe,
  voiceNotesListRecent,
  type VoiceListItem,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

type RecordState = "idle" | "recording" | "transcribing" | "error";

/**
 * Voice notes setup + recorder.
 *
 * In-app MediaRecorder. The user clicks Record, speaks, clicks Stop. We
 * encode the audio Blob as base64, send it to the Tauri command which
 * pipes through the bundled Whisper, and write a markdown atom under
 * `~/.tangerine-memory/threads/voice/`.
 */
export default function VoiceNotesSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [state, setState] = useState<RecordState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [pulse, setPulse] = useState<number[]>(new Array(12).fill(0));
  const [recent, setRecent] = useState<VoiceListItem[]>([]);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const mimeRef = useRef<string>("audio/webm");
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  // Initial load of recent notes.
  useEffect(() => {
    void voiceNotesListRecent().then(setRecent);
    return () => {
      stopTickers();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stopTickers() {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  async function handleStart() {
    setError(null);
    if (state === "recording") return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Pick a MIME type the browser supports. Chromium prefers webm/opus.
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
        "audio/wav",
        "audio/mp4",
      ];
      let chosen = "";
      for (const c of candidates) {
        if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) {
          chosen = c;
          break;
        }
      }
      mimeRef.current = chosen || "audio/webm";

      const mr = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);
      mediaRecorderRef.current = mr;
      chunksRef.current = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };
      mr.onstop = () => void handleEncodeAndSend();
      mr.start(250);

      startedAtRef.current = Date.now();
      setElapsedSec(0);
      tickRef.current = window.setInterval(() => {
        setElapsedSec(Math.floor((Date.now() - startedAtRef.current) / 1000));
        // Lightweight visual pulse — random walk, not a real waveform.
        setPulse((prev) => prev.map(() => Math.random()));
      }, 200);

      setState("recording");
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(msg);
      setState("error");
      pushToast("error", `Mic access failed: ${msg}`);
    }
  }

  function handleStop() {
    if (state !== "recording") return;
    stopTickers();
    setState("transcribing");
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") {
      mr.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
  }

  async function handleEncodeAndSend() {
    try {
      const blob = new Blob(chunksRef.current, { type: mimeRef.current });
      chunksRef.current = [];
      if (blob.size === 0) {
        setState("idle");
        pushToast("error", "Recording was empty.");
        return;
      }
      const b64 = await blobToBase64(blob);
      const atom = await voiceNotesRecordAndTranscribe(b64, mimeRef.current);
      pushToast("success", `Voice note transcribed (${atom.duration_sec.toFixed(1)}s).`);
      setState("idle");
      // Refresh the recent list.
      void voiceNotesListRecent().then(setRecent);
      // Navigate to the memory tree at the new file. The /memory route
      // accepts a `?path=` query param to scroll to a specific file.
      navigate(`/memory?path=${encodeURIComponent(atom.file_path)}`);
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setError(msg);
      setState("error");
      pushToast("error", `Transcription failed: ${msg}`);
    }
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={() => navigate("/memory")}
        >
          <ArrowLeft size={16} />
        </Button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <Mic size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Voice notes
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Record
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Voice notes</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Record a voice note
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Click Record, talk, click Stop. Tangerine transcribes via local Whisper and writes
          a markdown atom under{" "}
          <code className="font-mono text-[12px]">~/.tangerine-memory/threads/voice/</code>.
        </p>

        <Card className="mt-8">
          <CardContent className="pt-8 pb-8">
            <div className="flex flex-col items-center gap-4">
              {state === "idle" && (
                <Button
                  size="lg"
                  className="h-20 w-20 rounded-full"
                  onClick={handleStart}
                  aria-label="Start recording"
                >
                  <Mic size={32} />
                </Button>
              )}
              {state === "recording" && (
                <Button
                  size="lg"
                  variant="outline"
                  className="h-20 w-20 rounded-full border-2 border-[#B83232] text-[#B83232]"
                  onClick={handleStop}
                  aria-label="Stop recording"
                >
                  <Square size={28} />
                </Button>
              )}
              {state === "transcribing" && (
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-stone-100 dark:bg-stone-900">
                  <Loader2 size={32} className="animate-spin text-[var(--ti-orange-500)]" />
                </div>
              )}
              {state === "error" && (
                <Button
                  size="lg"
                  variant="outline"
                  className="h-20 w-20 rounded-full"
                  onClick={() => {
                    setError(null);
                    setState("idle");
                  }}
                  aria-label="Reset"
                >
                  <AlertCircle size={32} className="text-[#B83232]" />
                </Button>
              )}

              {state === "recording" && (
                <div className="flex flex-col items-center gap-3">
                  <div className="flex items-end gap-1">
                    {pulse.map((v, i) => (
                      <div
                        key={i}
                        className="w-1.5 rounded-full bg-[var(--ti-orange-500)] transition-all duration-150"
                        style={{ height: `${8 + v * 28}px` }}
                      />
                    ))}
                  </div>
                  <p className="font-mono text-sm text-stone-700 dark:text-stone-300">
                    {formatElapsed(elapsedSec)}
                  </p>
                </div>
              )}

              {state === "idle" && (
                <p className="text-xs text-stone-500 dark:text-stone-400">
                  Tip: keep recordings under ~5 minutes for best transcription quality.
                </p>
              )}
              {state === "transcribing" && (
                <p className="text-sm text-stone-700 dark:text-stone-300">
                  Transcribing via local Whisper…
                </p>
              )}
              {state === "error" && error && (
                <p className="flex items-center gap-1 text-xs text-[#B83232]">
                  <AlertCircle size={12} /> {error}
                </p>
              )}
            </div>
          </CardContent>
        </Card>

        <section className="mt-10">
          <p className="ti-section-label">Recent voice notes</p>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm italic text-stone-500 dark:text-stone-400">
              No recordings yet.
            </p>
          ) : (
            <ul className="mt-3 space-y-1">
              {recent.map((r) => (
                <li
                  key={r.path}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-stone-100 dark:hover:bg-stone-900"
                >
                  <FileText size={14} className="text-[var(--ti-ink-500)]" />
                  <button
                    type="button"
                    className="flex-1 truncate text-left font-mono text-xs text-stone-700 hover:underline dark:text-stone-300"
                    onClick={() =>
                      navigate(`/memory?path=${encodeURIComponent(r.path)}`)
                    }
                  >
                    {r.slug}
                  </button>
                  <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
                    {r.duration_sec > 0 ? `${r.duration_sec.toFixed(1)}s` : "—"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="mt-10 rounded-md border border-stone-200 p-6 dark:border-stone-800">
          <p className="ti-section-label">How it works</p>
          <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
            Audio is captured in your browser via the MediaRecorder API and sent to the
            Tangerine local Whisper model — the same one the Discord meeting flow uses.
            Audio never leaves your machine.
          </p>
          <p className="mt-3 text-xs italic text-stone-500 dark:text-stone-400">
            Make sure you've downloaded the Whisper model first via{" "}
            <button
              type="button"
              className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
              onClick={() => navigate("/sources/discord")}
            >
              /sources/discord
            </button>
            . The voice notes source reuses that same bundled model.
          </p>
        </section>
      </main>
    </div>
  );
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

async function blobToBase64(blob: Blob): Promise<string> {
  // FileReader's readAsDataURL gives `data:<mime>;base64,<payload>`. We
  // strip the prefix so the Rust side gets pure base64.
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error("FileReader error"));
    fr.onload = () => {
      const result = fr.result as string;
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    fr.readAsDataURL(blob);
  });
}
