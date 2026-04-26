"""First-run downloader for the bundled local Whisper model.

CLI:
    python -m tmi.model_download --model small --dest <path>

Pulls the int8-quantised faster-whisper model from HuggingFace
(`Systran/faster-whisper-<size>`) into <dest>/faster-whisper-<size>-int8/.

Progress is emitted line-by-line to stdout as JSON so the Tauri frontend can
parse and render a progress bar. Each line is a single JSON object terminated
by `\n`. Lines:

    {"event": "start",    "model": "small", "dest": "..."}
    {"event": "progress", "downloaded": <bytes>, "total": <bytes or null>,
                          "percent": <0-100 float or null>}
    {"event": "done",     "path": "<final-dir>"}
    {"event": "error",    "message": "..."}

Exit codes:
    0  success
    2  argument error
    3  download failed

The model directory layout matches what `WhisperModel(local_path)` expects:
config.json, tokenizer.json, vocabulary.txt, model.bin, etc.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import threading
import time
import warnings
from pathlib import Path
from typing import Optional

# HuggingFace repos for faster-whisper. Systran fork = canonical CTranslate2
# weights for v3 architecture; matches what `faster-whisper` uses if you pass
# a model name string instead of a local path.
_REPOS = {
    "tiny": "Systran/faster-whisper-tiny",
    "base": "Systran/faster-whisper-base",
    "small": "Systran/faster-whisper-small",
    "medium": "Systran/faster-whisper-medium",
    "large-v3": "Systran/faster-whisper-large-v3",
}


def _emit(event: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(event, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _dir_size(p: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                total += (Path(root) / f).stat().st_size
            except OSError:
                pass
    return total


def download_model(model: str, dest_root: Path) -> Path:
    """Download `model` from HF into dest_root/faster-whisper-<model>-int8/.

    Streams progress events to stdout as JSON lines. Returns the final path.
    Raises RuntimeError on failure.
    """
    if model not in _REPOS:
        raise ValueError(f"unknown model: {model}; choices={list(_REPOS)}")

    repo_id = _REPOS[model]
    target = (dest_root / f"faster-whisper-{model}-int8").resolve()
    target.mkdir(parents=True, exist_ok=True)

    # Silence huggingface_hub's tqdm bars + the "unauthenticated requests"
    # banner. They write to stdout and break the JSON-line contract that the
    # Tauri side relies on. Must be set BEFORE importing the library so the
    # env-driven logger config picks them up.
    os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")
    warnings.filterwarnings("ignore", category=UserWarning, module="huggingface_hub")
    logging.getLogger("huggingface_hub").setLevel(logging.ERROR)

    _emit({"event": "start", "model": model, "dest": str(target)})

    try:
        from huggingface_hub import snapshot_download  # type: ignore[import-not-found]
    except ImportError as e:
        raise RuntimeError(f"huggingface_hub not installed: {e}") from e

    # Approximate total: small int8 ~244 MB; we don't know the true size until
    # HF metadata is fetched, so we poll the directory while download runs and
    # emit progress with an unknown total. Frontend renders indeterminate until
    # we can estimate. Good enough for v1.5.
    stop = threading.Event()

    def poll() -> None:
        last = -1
        while not stop.is_set():
            try:
                size = _dir_size(target)
            except OSError:
                size = 0
            if size != last:
                _emit(
                    {
                        "event": "progress",
                        "downloaded": size,
                        "total": None,
                        "percent": None,
                    }
                )
                last = size
            time.sleep(0.5)

    poller = threading.Thread(target=poll, daemon=True)
    poller.start()
    try:
        # `local_dir_use_symlinks` was removed in huggingface_hub >=0.23 —
        # passing it now triggers a UserWarning that pollutes our JSON-line
        # stdout. Default behaviour (no symlinks, real files in local_dir)
        # already matches what we want.
        snapshot_download(
            repo_id=repo_id,
            local_dir=str(target),
            allow_patterns=[
                "config.json",
                "tokenizer.json",
                "vocabulary.txt",
                "vocab.json",
                "preprocessor_config.json",
                "model.bin",
                "*.txt",
                "*.json",
            ],
        )
    except Exception as e:  # pragma: no cover - depends on network
        stop.set()
        poller.join(timeout=2)
        raise RuntimeError(f"snapshot_download failed: {e}") from e
    finally:
        stop.set()
        poller.join(timeout=2)

    _emit({"event": "done", "path": str(target)})
    return target


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="tmi.model_download")
    parser.add_argument(
        "--model",
        default="small",
        choices=list(_REPOS),
        help="Model size to download (default: small).",
    )
    parser.add_argument(
        "--dest",
        required=True,
        type=Path,
        help="Destination root. Final dir is <dest>/faster-whisper-<model>-int8/.",
    )
    args = parser.parse_args(argv)

    try:
        download_model(args.model, args.dest)
    except ValueError as e:
        _emit({"event": "error", "message": str(e)})
        return 2
    except RuntimeError as e:
        _emit({"event": "error", "message": str(e)})
        return 3
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
