// === wave 6 === BUG #3 — `__APP_VERSION__` is injected by vite.config.ts's
// `define` so the WelcomeOverlay can compare the running build's version
// against the persisted `lastWelcomedVersion`. Declared here (no import
// needed) so any file in `src/` can consume it.
declare const __APP_VERSION__: string;
