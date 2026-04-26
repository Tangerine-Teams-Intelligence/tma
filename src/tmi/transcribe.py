"""Local transcription via faster-whisper.

CLI:
    python -m tmi.transcribe --audio <wav> --model-dir <dir> [--language zh]

Prints a single JSON object to stdout:
    {"text": "...", "segments": [{"start": s, "end": s, "text": "..."}, ...],
     "language": "zh"}

Exit codes:
    0  success
    2  argument error
    3  model load failed
    4  audio decode / transcription failed

Used by the Node Discord bot when WHISPER_MODE=local. The Node side spawns
`<bundled-python> -m tmi.transcribe ...` with a 16kHz mono WAV file path, then
parses the stdout JSON. We deliberately keep the model load on every CLI call
explicit and short-lived: each Discord chunk gets its own subprocess. faster-
whisper's int8 small model loads in ~1-2 s on a modern CPU and a 10s chunk
transcribes in well under wall-clock 10s, so the per-call overhead is
acceptable for v1.5. v1.6 may switch to a long-running daemon.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Optional


def transcribe(
    audio_path: Path,
    model_dir: Path,
    language: Optional[str] = None,
    *,
    compute_type: str = "int8",
    beam_size: int = 1,
) -> dict[str, object]:
    """Run faster-whisper on a single audio file. Returns serialisable dict.

    Raises RuntimeError if the model fails to load or transcription fails.
    Imports faster_whisper lazily so this module can be imported without the
    heavy dependency installed (e.g. for tests / static analysis).
    """
    try:
        from faster_whisper import WhisperModel  # type: ignore[import-not-found]
    except ImportError as e:  # pragma: no cover - depends on env
        raise RuntimeError(f"faster_whisper not installed: {e}") from e

    if not audio_path.is_file():
        raise FileNotFoundError(f"audio file not found: {audio_path}")
    if not model_dir.is_dir():
        raise FileNotFoundError(f"model dir not found: {model_dir}")

    try:
        model = WhisperModel(
            str(model_dir),
            device="cpu",
            compute_type=compute_type,
            local_files_only=True,
        )
    except Exception as e:  # pragma: no cover - depends on env
        raise RuntimeError(f"failed to load whisper model: {e}") from e

    try:
        segments_iter, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=beam_size,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
        )
        segments = []
        text_parts: list[str] = []
        for seg in segments_iter:
            segments.append(
                {
                    "start": float(seg.start),
                    "end": float(seg.end),
                    "text": seg.text.strip(),
                }
            )
            if seg.text:
                text_parts.append(seg.text.strip())
    except Exception as e:  # pragma: no cover - depends on env
        raise RuntimeError(f"transcription failed: {e}") from e

    return {
        "text": " ".join(text_parts).strip(),
        "segments": segments,
        "language": info.language if info is not None else (language or ""),
    }


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="tmi.transcribe")
    parser.add_argument("--audio", required=True, type=Path)
    parser.add_argument("--model-dir", required=True, type=Path)
    parser.add_argument(
        "--language",
        default=None,
        help="ISO 639-1 language hint (e.g. zh, en). Omit for auto-detect.",
    )
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--beam-size", default=1, type=int)
    args = parser.parse_args(argv)

    try:
        result = transcribe(
            args.audio,
            args.model_dir,
            language=args.language,
            compute_type=args.compute_type,
            beam_size=args.beam_size,
        )
    except FileNotFoundError as e:
        sys.stderr.write(f"{e}\n")
        return 2
    except RuntimeError as e:
        sys.stderr.write(f"{e}\n")
        # Distinguish load failures from runtime failures by message prefix.
        return 3 if "failed to load" in str(e) else 4

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
