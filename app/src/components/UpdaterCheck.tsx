// === wave 25 ===
//
// In-app auto-update banner for Tauri 2's `tauri-plugin-updater`.
//
// Behaviour:
//   * On mount (after WelcomeOverlay closes — `welcomed === true`), call
//     `check()` from the updater plugin to ask the configured GitHub endpoint
//     whether a newer release is available.
//   * If a new version is found, render a small fixed-position banner in the
//     top-right with "vX.Y.Z available" + an "Install now" button. Clicking
//     installs (download → restart). Dismiss leaves it for next launch.
//   * Defensive: if the updater bridge throws (no Tauri host, missing pubkey,
//     network down, signature check fail), swallow + console.warn. We never
//     blank the shell on update-check failure — Wave 10.1 lesson.
//
// The pubkey in tauri.conf.json is currently a placeholder. Until CEO runs
// `npx tauri signer generate -w ~/.tauri/myapp.key` and rebuilds, signed
// `latest.json` artifacts can't be verified, so the plugin will refuse the
// install and silently no-op. That's the intended graceful degrade — the
// component never throws, just stays hidden.
//
// Mount location: AppShell.tsx top-right notification slot, alongside
// HelpButton. Only one updater banner ever lives in the tree at a time
// (component self-suppresses if `dismissed === true`).
//
// === end wave 25 ===

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";

// Shape of the metadata returned by `check()` from `@tauri-apps/plugin-updater`.
// Re-declared locally to avoid a hard import dep on the plugin module path
// during vitest runs (we lazy-import the plugin inside an effect so the
// jsdom test environment doesn't try to resolve `@tauri-apps/plugin-updater`).
interface UpdateMeta {
  version: string;
  date?: string;
  body?: string;
  downloadAndInstall: (
    onEvent?: (e: { event: string; data?: unknown }) => void,
  ) => Promise<void>;
}

export function UpdaterCheck() {
  const welcomed = useStore((s) => s.ui.welcomed);
  const [update, setUpdate] = useState<UpdateMeta | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    // Only ask the updater after the user has seen the welcome tour. Otherwise
    // a fresh-install user gets a "v1.12.1 available" toast on top of the
    // 4-card overlay, which is confusing.
    if (!welcomed) return;
    let cancelled = false;
    void (async () => {
      try {
        // Test-only override: vitest can install
        // `globalThis.__TANGERINE_UPDATER_MOCK__` to short-circuit the lazy
        // dynamic import (which fails in jsdom because the real plugin
        // package isn't a dep of the test environment). Production builds
        // never hit this branch — `__TANGERINE_UPDATER_MOCK__` is undefined.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const testMock = (globalThis as any).__TANGERINE_UPDATER_MOCK__ as
          | { check: () => Promise<UpdateMeta | null> }
          | undefined;
        let mod: { check: () => Promise<UpdateMeta | null> };
        if (testMock && typeof testMock.check === "function") {
          mod = testMock;
        } else {
          // Dynamic import behind a runtime variable so Vite doesn't try to
          // statically resolve `@tauri-apps/plugin-updater` at build time
          // (the package may not be installed in vitest jsdom environments).
          // Vite's module resolver still picks it up in real builds because
          // the string is a literal at runtime.
          const modPath = "@tauri-apps/plugin-updater";
          mod = (await import(/* @vite-ignore */ modPath)) as {
            check: () => Promise<UpdateMeta | null>;
          };
        }
        if (cancelled) return;
        const result = await mod.check();
        if (cancelled) return;
        // `check()` resolves to `null` when the running build is already the
        // latest on the endpoint; only surface UI when a real update lands.
        if (result) {
          setUpdate(result as unknown as UpdateMeta);
        }
      } catch (err) {
        // No Tauri host (vitest / browser dev), no network, missing pubkey,
        // signature mismatch — all swallow into the same `null` UI.
        console.warn("[wave25] updater check failed", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [welcomed]);

  const handleInstall = async () => {
    if (!update || installing) return;
    setInstalling(true);
    try {
      await update.downloadAndInstall((evt) => {
        if (
          evt.event === "Progress" &&
          typeof evt.data === "object" &&
          evt.data !== null &&
          "chunkLength" in (evt.data as Record<string, unknown>)
        ) {
          // Best-effort progress tick. We don't render a real bar — just a
          // pulsing label — so we just keep `progress` non-zero to flip the
          // copy from "Installing..." to "Downloading...".
          setProgress((p) => p + 1);
        }
      });
      // Once downloadAndInstall resolves, Tauri triggers a restart on
      // Windows/Linux; macOS may need a manual relaunch via plugin-process.
      try {
        const procPath = "@tauri-apps/plugin-process";
        const proc = (await import(/* @vite-ignore */ procPath)) as {
          relaunch: () => Promise<void>;
        };
        await proc.relaunch();
      } catch {
        // Best-effort relaunch; if the process plugin isn't available, the
        // installer prompt will have handled it.
      }
    } catch (err) {
      console.warn("[wave25] updater install failed", err);
      setInstalling(false);
    }
  };

  if (dismissed || !update) return null;

  return (
    <div
      data-testid="updater-banner"
      data-update-version={update.version}
      role="status"
      className="pointer-events-auto fixed right-4 top-4 z-40 flex max-w-sm items-center gap-2 rounded-md border border-[var(--ti-orange-300,#FFB477)] bg-[var(--ti-orange-50,#FFF4EC)] px-3 py-2 text-[12px] shadow-md dark:border-stone-600 dark:bg-stone-800"
    >
      <span aria-hidden className="text-[14px]">
        🍊
      </span>
      <span className="flex-1 text-stone-800 dark:text-stone-200">
        <strong className="font-semibold">v{update.version}</strong> available
      </span>
      {installing ? (
        <span className="text-stone-600 dark:text-stone-400">
          {progress > 0 ? "Downloading..." : "Installing..."}
        </span>
      ) : (
        <>
          <button
            type="button"
            data-testid="updater-install"
            onClick={() => void handleInstall()}
            className="rounded border border-[var(--ti-orange-400,#FF8B47)] bg-[var(--ti-orange-100,#FFE4CD)] px-2 py-0.5 font-mono text-[11px] text-[var(--ti-orange-700,#A04400)] hover:bg-[var(--ti-orange-200,#FFD0A8)] dark:border-stone-500 dark:bg-stone-700 dark:text-[var(--ti-orange-500,#CC5500)] dark:hover:bg-stone-600"
          >
            Install now
          </button>
          <button
            type="button"
            data-testid="updater-dismiss"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss update banner"
            className="text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100"
          >
            ×
          </button>
        </>
      )}
    </div>
  );
}

export default UpdaterCheck;
