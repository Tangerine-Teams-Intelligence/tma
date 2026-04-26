# Tangerine — Browser Extension (v0.1.0)

Inject your team's memory into ChatGPT, Claude, and Gemini with one click.

A small Chrome extension (Manifest V3) that adds a 🍊 button next to your prompt
input on the major chat AIs. Click it, search your local Tangerine memory, and
the matched note is prepended to your prompt — so the model has the team
context before you hit Enter.

```
You're typing in claude.ai → 🍊 → search "postgres" → click result → prepended → Enter
```

## How it works

```
┌─────────────────┐     postMessage     ┌──────────────────┐    ws://127.0.0.1:7780    ┌──────────────────┐
│ content script  │ ─────────────────▶ │  service worker  │ ──────────────────────▶ │ Tangerine app    │
│  (ChatGPT etc.) │                     │   (background)   │                           │  (memory store)  │
└─────────────────┘                     └──────────────────┘                           └──────────────────┘
```

The extension never reads your filesystem directly. It talks over a localhost
websocket to the **Tangerine desktop app**, which owns memory access and
permissions. If the app isn't running you'll see a "Tangerine app not running"
banner inside the overlay.

## Install (developer mode)

1. `npm install`
2. `npm run build`  → produces `dist/`
3. Open `chrome://extensions`, enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**, select the `dist/` folder
5. Pin the 🍊 from the extensions menu

The extension is also bundled as `tangerine-ext-0.1.0.zip` (run `npm run zip`)
for Chrome Web Store submission.

## Configuration

Click the 🍊 in the browser toolbar to open the settings popup:

| Setting              | Default                       | Notes                                          |
|----------------------|-------------------------------|------------------------------------------------|
| Endpoint             | `ws://127.0.0.1:7780/memory`  | Localhost websocket exposed by the desktop app |
| Enabled sites        | ChatGPT / Claude / Gemini all on | Disable per-site if you don't want the button  |
| Results per search   | 5                             | Sent as `limit` in the search request          |
| Auto-prefill query   | on                            | Seeds the search box from your textarea text   |
| **Smart inject**     | **off**                       | Proactive injector — see below                  |

Settings persist via `chrome.storage.sync` (synced across your Chrome profile).

## Smart inject (Stage 1 AI surface upgrade)

When **Smart inject** is on, the content script silently watches your prompt
textarea (debounced 1.5s). If the typed text looks like a question
(`isQuestionLike` heuristic — wh-words, ends in `?`, >50 chars, or contains
imperative verbs like `summarise` / `find` / `recap`), we run a memory
search through the localhost websocket. If results come back, a small chip
pops near the textarea:

```
🍊 3 relevant memories  ⭐ confident  ×
```

Hover the chip → dropdown of snippets. Click **Inject all** → memories
prepended to your prompt as a quoted context block. Click **×** → dismissed
for that prompt for the rest of the tab session.

**Privacy.** Off by default. Even on, every search is local
(`ws://127.0.0.1:7780/memory`) — nothing leaves your machine. The chip is
opt-in because debounced polling has a predictable read pattern that some
users want to disable.

## AGI envelope (Stage 1 Hook 4)

The desktop app's localhost ws server returns the same envelope shape as the
MCP server:

```json
{
  "data":              {"...": "actual payload"},
  "confidence":        1.0,
  "freshness_seconds": 60,
  "source_atoms":      ["evt-..."],
  "alternatives":      [],
  "reasoning_notes":   null
}
```

Stage 1 always returns `confidence: 1.0`. The smart-inject chip surfaces
this as `⭐ confident`. Stage 2 will start emitting `< 1.0` and the chip
will downgrade the badge to `· likely` (≥ 0.5) or `🤔 uncertain` (< 0.5).
Schema is documented in `mcp-server/README.md` and the desktop app's
`<root>/.tangerine/SCHEMA.md`.

## Wire protocol

Client → server (one of):

```json
{ "op": "search", "query": "postgres", "limit": 5 }
{ "op": "file",   "path":  "/abs/path/to/note.md" }
```

Server → client (one of):

```json
{ "op": "search.result", "results": [
    { "file": "/abs/path/to/note.md",
      "title": "2026-04-25 David sync",
      "snippet": "matched snippet ~200 chars",
      "preview": "longer preview ~1500 chars",
      "score": 0.87 }
] }

{ "op": "file.result", "path": "/abs/...", "content": "..." }

{ "op": "error", "code": "unreachable|timeout|not_found|invalid_request|internal", "message": "..." }
```

Same shape as the Tangerine MCP server tool response, so the desktop app can
proxy with no transformation.

## Path A vs Path B

- **Path A (this version)** — talks to the desktop app over localhost ws.
  Requires the app to be running. This is the only mode in v0.1.0.
- **Path B (planned for v1.6.1)** — for users without the desktop app, bundle a
  local snapshot of the memory index. User pastes the path to
  `~/.tangerine-memory/.tangerine/index.json` once in settings; the extension
  reads it via the File System Access API. Stays out of v0.1 to keep scope tight.

## Site selectors (by site)

These get stale fast. If the 🍊 stops appearing, update the selector in the
matching `src/content/inject-*.ts` and rebuild.

- **ChatGPT**: `div#prompt-textarea[contenteditable="true"]` (current ProseMirror), `textarea#prompt-textarea` (legacy)
- **Claude**: `div[contenteditable="true"].ProseMirror`
- **Gemini**: `rich-textarea div.ql-editor[contenteditable="true"]`

A `MutationObserver` plus a 2s polling safety net catches SPA navigations.

## Layout

```
browser-ext/
├── manifest.json
├── package.json
├── vite.config.ts
├── tsconfig.json
├── icons/                      # 16/32/48/128 PNG (orange-circle placeholder)
├── scripts/
│   ├── gen-icons.mjs           # zero-dep PNG generator
│   └── zip.mjs                 # pack dist/ for the Chrome Web Store
├── src/
│   ├── background/service-worker.ts
│   ├── content/
│   │   ├── inject-chatgpt.ts
│   │   ├── inject-claude.ts
│   │   ├── inject-gemini.ts
│   │   ├── inject-shared.ts    # bridge to background + setEditorValue helper
│   │   └── overlay.ts          # vanilla-DOM search panel UI
│   ├── popup/
│   │   ├── popup.html
│   │   └── popup.ts
│   └── shared/
│       ├── memory-client.ts    # localhost ws client
│       └── types.ts            # wire-protocol types + settings shape
└── tests/
    ├── manifest.test.ts
    └── memory-client.test.ts
```

## Build & develop

```bash
npm install        # pulls vite + @crxjs/vite-plugin
npm run build      # → dist/  (load this in chrome://extensions)
npm run dev        # vite watch mode (rebuilds dist/ on save)
npm run test       # vitest unit tests (memory-client + manifest)
npm run lint       # tsc --noEmit
npm run zip        # tangerine-ext-0.1.0.zip
```

## Roadmap

- [x] v0.1.0 — Path A (localhost ws), 🍊 overlay, settings popup
- [ ] v0.1.1 — Visual snapshot tests of injected button (Playwright)
- [ ] v1.6.1 — Path B fallback for "no desktop app installed"
- [ ] v0.2 — Inline citations (clicking a result also tags the prompt with `cite: <file>`)
- [ ] v0.2 — Firefox port (manifest v2 shim)

## License

Apache-2.0. See [`LICENSE`](LICENSE).
