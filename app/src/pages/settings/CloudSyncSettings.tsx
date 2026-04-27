/**
 * v2.5 §5 — Cloud sync settings (STUB).
 *
 * Renders a single panel:
 *   • banner: "Cloud sync coming v2.5 production — currently stub"
 *   • per-team repo URL input (saved via cloud_sync_set_config)
 *   • enable toggle
 *   • Test sync buttons (init / pull / push) that hit the Rust stub —
 *     all stubs return Ok with a log message; no real network.
 *
 * Real network transport lands in v2.5 production milestone.
 */

import { useEffect, useState } from "react";
import { Cloud, Save } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  cloudSyncGetConfig,
  cloudSyncInit,
  cloudSyncPull,
  cloudSyncPush,
  cloudSyncSetConfig,
  type CloudSyncConfig,
} from "@/lib/tauri";
import { cn } from "@/lib/utils";

export default function CloudSyncSettings() {
  const pushToast = useStore((s) => s.ui.pushToast);
  const setConfigInStore = useStore((s) => s.ui.setCloudSyncConfig);
  const cfgInStore = useStore((s) => s.ui.cloudSyncConfig);

  const [cfg, setCfg] = useState<CloudSyncConfig>(cfgInStore);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancel = false;
    void cloudSyncGetConfig()
      .then((c) => {
        if (cancel) return;
        setCfg(c);
        setConfigInStore(c);
        setLoaded(true);
      })
      .catch(() => {
        if (cancel) return;
        setLoaded(true);
      });
    return () => {
      cancel = true;
    };
  }, [setConfigInStore]);

  async function handleSave() {
    setBusy(true);
    try {
      await cloudSyncSetConfig(cfg);
      setConfigInStore(cfg);
      pushToast("success", "Cloud sync config saved");
    } catch (e) {
      pushToast("error", `Save failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runStub(
    label: string,
    fn: () => Promise<{ ok: boolean; message: string }>,
  ) {
    setBusy(true);
    try {
      const r = await fn();
      pushToast(
        r.ok ? "info" : "error",
        `${label}: ${r.message}`,
      );
    } catch (e) {
      pushToast("error", `${label} failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-4">
      <header className="flex items-center gap-2">
        <Cloud size={16} className="text-stone-500" />
        <h2 className="text-base font-medium text-stone-900 dark:text-stone-100">
          Cloud sync
        </h2>
      </header>

      <div className="rounded border border-amber-200 bg-amber-50 p-3 text-[12px] text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        Cloud sync coming v2.5 production — currently stub. The form below
        persists locally; no real network calls are made yet.
      </div>

      {!loaded ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
      ) : (
        <div className="space-y-3 rounded border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
          <Toggle
            label="Enable cloud sync (stub)"
            description="When real transport lands, this flag flips on managed git mirroring."
            checked={cfg.enabled}
            onChange={(v) => setCfg((c) => ({ ...c, enabled: v }))}
          />

          <Field
            label="Team repo URL"
            description="e.g. https://git.tangerine.cloud/your-team.git"
          >
            <input
              type="text"
              value={cfg.repo_url}
              onChange={(e) =>
                setCfg((c) => ({ ...c, repo_url: e.target.value }))
              }
              placeholder="https://git.tangerine.cloud/…"
              className="w-full rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            />
          </Field>

          <Field label="Branch" description="Defaults to main.">
            <input
              type="text"
              value={cfg.branch}
              onChange={(e) =>
                setCfg((c) => ({ ...c, branch: e.target.value }))
              }
              placeholder="main"
              className="w-full rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            />
          </Field>

          <Field
            label="Sync interval (minutes)"
            description="How often the daemon should pull/push."
          >
            <input
              type="number"
              min={1}
              value={cfg.sync_interval_min}
              onChange={(e) =>
                setCfg((c) => ({
                  ...c,
                  sync_interval_min: Math.max(1, parseInt(e.target.value, 10) || 1),
                }))
              }
              className="w-32 rounded border border-stone-200 bg-stone-50 px-2 py-1 text-[12px] dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100"
            />
          </Field>

          <div className="flex flex-wrap items-center gap-2 border-t border-stone-200 pt-3 dark:border-stone-800">
            <Button onClick={handleSave} disabled={busy} size="sm">
              <Save size={12} className="mr-1" />
              Save
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runStub("Init", cloudSyncInit)}
            >
              Init (stub)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runStub("Pull", cloudSyncPull)}
            >
              Pull (stub)
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => runStub("Push", cloudSyncPush)}
            >
              Push (stub)
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-3">
      <span className="flex-1">
        <span className="block text-[13px] font-medium text-stone-900 dark:text-stone-100">
          {label}
        </span>
        {description && (
          <span className="block text-[11px] text-stone-500 dark:text-stone-400">
            {description}
          </span>
        )}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition",
          checked ? "bg-[var(--ti-orange-500)]" : "bg-stone-300 dark:bg-stone-700",
        )}
      >
        <span
          className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white shadow transition",
            checked ? "translate-x-4" : "translate-x-0.5",
          )}
        />
      </button>
    </label>
  );
}

function Field({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block">
        <span className="block text-[13px] font-medium text-stone-900 dark:text-stone-100">
          {label}
        </span>
        {description && (
          <span className="mb-1 block text-[11px] text-stone-500 dark:text-stone-400">
            {description}
          </span>
        )}
        {children}
      </label>
    </div>
  );
}
