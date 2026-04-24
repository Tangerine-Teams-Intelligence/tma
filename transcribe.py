"""
transcribe.py

Dual-stream realtime transcription (Windows):
  - Default microphone           -> labeled "DZ"
  - Default speaker loopback     -> labeled "CTO"  (whatever Discord plays)

Each chunk goes through faster-whisper (large-v3 on GPU by default).
Appends to transcript.md in this directory, timestamped and speaker-labeled.

Env var overrides:
    CHUNK_SECONDS=<n>    processing window in seconds (default 10)
    MODEL=<name>         override whisper model (default large-v3)
    CAPTURE_SR=<n>       capture sample rate (default 48000)

Ctrl+C to stop.
"""
import os
import sys
import site
import queue
import threading
from datetime import datetime


def _add_nvidia_dll_dirs() -> None:
    """Windows: pip-installed nvidia-*-cu12 DLLs aren't on search path by default.
    Register each nvidia/*/bin both via add_dll_directory AND PATH prepend
    (ctranslate2's C++ LoadLibrary uses PATH, not Python's dll dirs).
    """
    if sys.platform != "win32":
        return
    new_paths: list[str] = []
    for sp in site.getsitepackages() + [site.getusersitepackages()]:
        nv = os.path.join(sp, "nvidia")
        if not os.path.isdir(nv):
            continue
        for sub in os.listdir(nv):
            bin_dir = os.path.join(nv, sub, "bin")
            if os.path.isdir(bin_dir):
                new_paths.append(bin_dir)
                if hasattr(os, "add_dll_directory"):
                    try:
                        os.add_dll_directory(bin_dir)
                    except (OSError, FileNotFoundError):
                        pass
    if new_paths:
        os.environ["PATH"] = os.pathsep.join(new_paths) + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()

import warnings

import numpy as np
import soxr
import soundcard as sc
from soundcard.mediafoundation import SoundcardRuntimeWarning

# mediafoundation emits "data discontinuity in recording" all the time; harmless, drown it
warnings.filterwarnings("ignore", category=SoundcardRuntimeWarning)

from faster_whisper import WhisperModel

HERE = os.path.dirname(os.path.abspath(__file__))
TRANSCRIPT_PATH = os.path.join(HERE, "transcript.md")

TARGET_SR = 16000
CAPTURE_SR = int(os.environ.get("CAPTURE_SR", "48000"))
CHUNK_SECONDS = int(os.environ.get("CHUNK_SECONDS", "10"))
MODEL_NAME = os.environ.get("MODEL", "large-v3")


# ---------- Model ----------

def load_model():
    try:
        m = WhisperModel(MODEL_NAME, device="cuda", compute_type="float16")
        print(f"[model] GPU: {MODEL_NAME} / float16", flush=True)
        return m
    except Exception as e:
        print(f"[model] GPU init failed ({e})", flush=True)
        print("[model] Falling back to CPU (medium / int8)...", flush=True)
        m = WhisperModel("medium", device="cpu", compute_type="int8")
        print("[model] CPU ready", flush=True)
        return m


# ---------- Transcript writing ----------

_lock = threading.Lock()


def write_line(speaker: str, text: str) -> None:
    text = text.strip()
    if not text:
        return
    ts = datetime.now().strftime("%H:%M:%S")
    line = f"[{ts}] **{speaker}**: {text}\n\n"
    with _lock:
        with open(TRANSCRIPT_PATH, "a", encoding="utf-8") as f:
            f.write(line)
    print(f"[{ts}] {speaker}: {text}", flush=True)


# ---------- Capture thread ----------

class Capture(threading.Thread):
    def __init__(self, label, source, audio_q, stop_evt):
        super().__init__(daemon=True, name=f"capture-{label}")
        self.label = label
        self.source = source  # soundcard Microphone object (or loopback microphone)
        self.audio_q = audio_q
        self.stop_evt = stop_evt

    def run(self):
        try:
            with self.source.recorder(samplerate=CAPTURE_SR, channels=1) as rec:
                chunk_frames = CAPTURE_SR * CHUNK_SECONDS
                while not self.stop_evt.is_set():
                    data = rec.record(numframes=chunk_frames)
                    if data.ndim > 1:
                        data = data.mean(axis=1)
                    # quick silence skip: if max abs amplitude is tiny, don't enqueue
                    if np.max(np.abs(data)) < 1e-4:
                        continue
                    self.audio_q.put((self.label, data.astype(np.float32)))
        except Exception as e:
            print(f"[{self.label}] capture error: {e}", file=sys.stderr)


# ---------- Worker ----------

def worker(model, audio_q, stop_evt):
    while not stop_evt.is_set():
        try:
            item = audio_q.get(timeout=1.0)
        except queue.Empty:
            continue
        if item is None:
            break
        label, audio = item
        try:
            if CAPTURE_SR != TARGET_SR:
                audio = soxr.resample(audio, CAPTURE_SR, TARGET_SR)
            audio = np.ascontiguousarray(audio, dtype=np.float32)

            segments, _ = model.transcribe(
                audio,
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
                language=None,  # auto-detect (Chinese + English mixed)
            )
            text = " ".join(s.text for s in segments).strip()
            if text:
                write_line(label, text)
        except Exception as e:
            print(f"[{label}] transcribe error: {e}", file=sys.stderr)


# ---------- Main ----------

def main() -> None:
    model = load_model()

    try:
        mic = sc.default_microphone()
    except Exception as e:
        print(f"[fatal] no default microphone: {e}", file=sys.stderr)
        sys.exit(1)

    try:
        speaker = sc.default_speaker()
        loopback = sc.get_microphone(id=str(speaker.name), include_loopback=True)
    except Exception as e:
        print(f"[fatal] no default speaker loopback: {e}", file=sys.stderr)
        sys.exit(1)

    print(f"[mic]  {mic.name}", flush=True)
    print(f"[loop] {speaker.name}  (loopback)", flush=True)
    print(f"[cfg]  chunk={CHUNK_SECONDS}s  sr={CAPTURE_SR}  transcript={TRANSCRIPT_PATH}", flush=True)

    # (re-)init transcript with header
    with open(TRANSCRIPT_PATH, "w", encoding="utf-8") as f:
        f.write(f"# Meeting Transcript - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n\n")

    audio_q: "queue.Queue" = queue.Queue()
    stop_evt = threading.Event()

    w = threading.Thread(target=worker, args=(model, audio_q, stop_evt), daemon=True)
    w.start()

    mic_cap = Capture("DZ", mic, audio_q, stop_evt)
    loop_cap = Capture("CTO", loopback, audio_q, stop_evt)
    mic_cap.start()
    loop_cap.start()

    print("\nListening on Mic + Discord loopback.   Ctrl+C to stop.\n", flush=True)
    try:
        while mic_cap.is_alive() and loop_cap.is_alive():
            mic_cap.join(timeout=1.0)
    except KeyboardInterrupt:
        print("\n[stop] flushing pending chunks...", flush=True)
        stop_evt.set()
        audio_q.put(None)
        w.join(timeout=30)
        print("[stop] done. transcript saved to:", TRANSCRIPT_PATH, flush=True)


if __name__ == "__main__":
    main()
