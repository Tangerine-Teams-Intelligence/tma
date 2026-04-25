"""PyInstaller entry shim for `tmi.cli`.

`src/tmi/cli.py` uses relative imports (`from . import __version__`), so
freezing it directly with `pyinstaller src/tmi/cli.py` strips the package
context and the script crashes at import time. Use this shim as the entry
script instead — it routes through the package, preserving relative imports,
and delegates to the existing typer `app`.
"""

from __future__ import annotations

import sys

from tmi.cli import app


def main() -> None:
    app()


if __name__ == "__main__":
    main()
    sys.exit(0)
