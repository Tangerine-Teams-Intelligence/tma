# `app/resources/`

Build outputs of the bundling pipeline. Never commit the contents.

| Subdir | Produced by | Consumed by |
|---|---|---|
| `python/` | `app/scripts/build_python.ps1` (PyInstaller --onedir) | `commands::tmi::run_tmi` spawns `python/python.exe` |
| `bot/` | `app/scripts/build_bot.ps1` (directory bundle: `dist/` + `node_modules/` + `package.json`) | `commands::bot::start_bot` spawns `node bot/dist/index.js` via the user's Node 20+ on PATH |
| `icons/` | T4 (NSIS installer agent) | Tauri bundle config |

T1's `tauri.conf.json` `bundle.resources` glob must include `resources/python/**` and `resources/bot/**`.
