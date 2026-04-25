# `app/resources/`

Build outputs of the bundling pipeline. Never commit the contents.

| Subdir | Produced by | Consumed by |
|---|---|---|
| `python/` | `app/scripts/build_python.ps1` (PyInstaller --onedir) | `commands::tmi::run_tmi` spawns `python/python.exe` |
| `bot/` | `app/scripts/build_bot.ps1` (`pkg --targets node20-win-x64`) | `commands::bot::start_bot` spawns `bot/tangerine-meeting-bot.exe` |
| `icons/` | T4 (NSIS installer agent) | Tauri bundle config |

T1's `tauri.conf.json` `bundle.resources` glob must include `resources/python/**` and `resources/bot/**`.
