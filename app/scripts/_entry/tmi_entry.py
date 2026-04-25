"""PyInstaller entry shim for the bundled `tmi` Python runtime.

Two roles:

1. Default: dispatch to `tmi.cli:app` (the typer-based meeting CLI). This is
   what `<frozen_python>` invocations without `-m` use.

2. Module dispatch: when invoked as `<frozen_python> -m <module> [args...]`
   (e.g. `python.exe -m tmi.transcribe --audio foo.wav --model-dir ...`),
   delegate to `runpy.run_module(<module>, run_name="__main__")`. This is
   what `whisper_model.rs` and the bot's WHISPER_MODE=local path rely on:
   they spawn the frozen exe with `-m tmi.transcribe` / `-m tmi.model_download`
   and expect it to behave like the cpython interpreter would.

   `src/tmi/cli.py` uses relative imports (`from . import __version__`), so
   freezing it directly with PyInstaller strips the package context and the
   binary crashes at import time. Routing through this shim preserves the
   package, which is also why we collect-submodules `tmi` in build_python.ps1.

The frozen onedir is therefore a tiny multi-headed launcher: same exe,
different behaviour based on the leading `-m`.
"""

from __future__ import annotations

import runpy
import sys


def _run_module(module: str, remaining: list[str]) -> int:
    # Reset argv so the target module's `argparse` sees a clean command line:
    # `[<module-as-script>, *remaining]`. This mirrors `python -m <module>`.
    sys.argv = [module, *remaining]
    try:
        runpy.run_module(module, run_name="__main__", alter_sys=True)
    except SystemExit as e:
        # argparse / sys.exit(N) — propagate the code.
        code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
        return code
    return 0


def main() -> int:
    argv = sys.argv[1:]

    # `-m <module> [args...]`: dispatch to that module as __main__.
    if len(argv) >= 2 and argv[0] == "-m":
        return _run_module(argv[1], argv[2:])

    # Default: route to the typer CLI exactly as before. We import lazily so
    # `-m tmi.transcribe` does not pay the cost of importing the full CLI tree
    # (typer / rich / gitpython) on every Discord transcription chunk.
    from tmi.cli import app

    app()
    return 0


if __name__ == "__main__":
    sys.exit(main())
