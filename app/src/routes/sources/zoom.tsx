import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  ExternalLink,
  Eye,
  EyeOff,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RefreshCw,
  MessageSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  openExternal,
  setSecret,
  zoomGetConfig,
  zoomSetConfig,
  zoomValidateCredentials,
  zoomCapture,
  resolveMemoryRoot,
  type ZoomConfig,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

/**
 * Zoom uses Server-to-Server OAuth: the user creates an S2S OAuth app in
 * the Zoom Marketplace, which yields an account_id + client_id +
 * client_secret. We exchange those for a 1-hour bearer token at
 * `https://zoom.us/oauth/token` per heartbeat — no user-facing OAuth
 * redirect, no callback URL to register.
 */
export default function ZoomSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [accountId, setAccountId] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const [config, setConfig] = useState<ZoomConfig | null>(null);
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [lookbackDays, setLookbackDays] = useState(7);

  const [validation, setValidation] = useState<{
    ok: boolean;
    accountEmail?: string | null;
    error?: string | null;
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingCreds, setSavingCreds] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMsg, setLastSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    void zoomGetConfig().then((cfg) => {
      setConfig(cfg);
      setCaptureEnabled(cfg.capture_enabled);
      setLookbackDays(cfg.lookback_days);
    });
  }, []);

  const credsAllStored = useMemo(() => {
    if (!config) return false;
    return (
      config.account_id_present &&
      config.client_id_present &&
      config.client_secret_present
    );
  }, [config]);

  async function handleSaveCreds() {
    if (!accountId.trim() && !clientId.trim() && !clientSecret.trim()) return;
    setSavingCreds(true);
    try {
      // Only write fields the user actually filled — don't blow away an
      // existing stored secret with an empty string.
      const writes: Promise<void>[] = [];
      if (accountId.trim()) writes.push(setSecret("ZOOM_ACCOUNT_ID", accountId.trim()));
      if (clientId.trim()) writes.push(setSecret("ZOOM_CLIENT_ID", clientId.trim()));
      if (clientSecret.trim()) writes.push(setSecret("ZOOM_CLIENT_SECRET", clientSecret.trim()));
      await Promise.all(writes);
      pushToast("success", "Zoom credentials stored.");
      setAccountId("");
      setClientId("");
      setClientSecret("");
      const cfg = await zoomGetConfig();
      setConfig(cfg);
    } catch (e) {
      pushToast("error", `Save failed: ${(e as Error).message}`);
    } finally {
      setSavingCreds(false);
    }
  }

  async function runValidation() {
    setValidating(true);
    try {
      const r = await zoomValidateCredentials();
      setValidation({
        ok: r.ok,
        accountEmail: r.account_email,
        error: r.error,
      });
    } finally {
      setValidating(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await zoomSetConfig({
        capture_enabled: captureEnabled,
        lookback_days: lookbackDays,
      });
      pushToast("success", "Zoom source configured.");
      const cfg = await zoomGetConfig();
      setConfig(cfg);
    } catch (e) {
      pushToast("error", `Save failed: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncNow() {
    setSyncing(true);
    setLastSyncMsg(null);
    try {
      const root = await resolveMemoryRoot();
      const result = await zoomCapture(root.path);
      setLastSyncMsg(
        `Wrote ${result.written} meeting${result.written === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})` : ""),
      );
      const cfg = await zoomGetConfig();
      setConfig(cfg);
    } catch (e) {
      pushToast("error", `Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  const dirty = useMemo(() => {
    if (!config) return false;
    if (config.capture_enabled !== captureEnabled) return true;
    if (config.lookback_days !== lookbackDays) return true;
    return false;
  }, [config, captureEnabled, lookbackDays]);

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Back"
          onClick={() => navigate("/memory")}
        >
          <ArrowLeft size={16} />
        </Button>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <MessageSquare size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Zoom
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Zoom</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Set up the Zoom source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Replacement capture path for users without Discord. Tangerine pulls
          your cloud recordings + auto-transcripts and writes one atom per
          meeting in <code className="font-mono text-xs">meetings/</code>.
        </p>

        {/* OAuth credentials */}
        <Card className="mt-8">
          <CardContent className="pt-6 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
                Server-to-Server OAuth credentials
              </p>
              <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
                Create a Server-to-Server OAuth app in the Zoom Marketplace.
                Required scopes: <code className="font-mono text-xs">recording:read:admin</code>{" "}
                and <code className="font-mono text-xs">user:read:admin</code>.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => openExternal("https://marketplace.zoom.us/develop/create")}
            >
              <ExternalLink size={14} /> Zoom Marketplace
            </Button>

            <div className="space-y-2">
              <Label htmlFor="zoom-account">Account ID</Label>
              <Input
                id="zoom-account"
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
                placeholder={
                  config?.account_id_present ? "(stored — paste to replace)" : "abc123XYZ"
                }
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="zoom-client-id">Client ID</Label>
              <Input
                id="zoom-client-id"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                placeholder={
                  config?.client_id_present ? "(stored — paste to replace)" : "XYZ_clientId"
                }
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="zoom-client-secret">Client Secret</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="zoom-client-secret"
                  type={showSecret ? "text" : "password"}
                  value={clientSecret}
                  onChange={(e) => setClientSecret(e.target.value)}
                  placeholder={
                    config?.client_secret_present
                      ? "(stored — paste to replace)"
                      : "•••"
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  variant="outline"
                  size="icon"
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  aria-label={showSecret ? "Hide secret" : "Show secret"}
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </Button>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Button
                onClick={handleSaveCreds}
                disabled={
                  savingCreds || (!accountId.trim() && !clientId.trim() && !clientSecret.trim())
                }
              >
                {savingCreds ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Saving
                  </>
                ) : (
                  "Save credentials"
                )}
              </Button>
              {credsAllStored && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={runValidation}
                  disabled={validating}
                >
                  {validating ? (
                    <>
                      <Loader2 size={14} className="animate-spin" /> Validating
                    </>
                  ) : (
                    "Validate"
                  )}
                </Button>
              )}
            </div>

            {validation && validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[#2D8659]">
                <CheckCircle2 size={12} /> Connected
                {validation.accountEmail ? ` — ${validation.accountEmail}` : ""}.
              </p>
            )}
            {validation && !validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[#B83232]">
                <AlertCircle size={12} /> {validation.error ?? "Validation failed."}
              </p>
            )}

            {!credsAllStored && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
                <AlertCircle size={12} /> Account ID, Client ID, and Client
                Secret all need to be saved before validation.
              </p>
            )}
          </CardContent>
        </Card>

        {/* Behavior */}
        <Card className="mt-4">
          <CardContent className="pt-6 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
              Behavior
            </p>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={captureEnabled}
                onChange={(e) => setCaptureEnabled(e.target.checked)}
                className="mt-1 accent-[var(--ti-orange-500)]"
              />
              <div>
                <p className="font-medium text-[var(--ti-ink-900)]">Capture</p>
                <p className="text-[var(--ti-ink-700)]">
                  Pull cloud recording transcripts each heartbeat.
                </p>
              </div>
            </label>

            <div className="space-y-2">
              <Label htmlFor="lookback">Lookback window (days)</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="lookback"
                  type="number"
                  min={1}
                  max={90}
                  value={lookbackDays}
                  onChange={(e) =>
                    setLookbackDays(
                      Math.max(1, Math.min(90, Number(e.target.value) || 7)),
                    )
                  }
                  className="w-24"
                />
                <span className="text-xs text-[var(--ti-ink-500)]">
                  Recordings older than this are skipped on each heartbeat. 1 –
                  90 days.
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Sync */}
        <Card className="mt-4">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
                  Sync status
                </p>
                <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
                  Last sync: {config?.last_sync ?? "never"}
                </p>
                {lastSyncMsg && (
                  <p className="mt-1 text-xs text-[var(--ti-ink-500)]">
                    {lastSyncMsg}
                  </p>
                )}
              </div>
              <Button onClick={handleSyncNow} disabled={syncing || !credsAllStored}>
                {syncing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Syncing
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} /> Sync now
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </main>

      <div className="ti-no-select fixed bottom-0 left-0 right-0 border-t border-stone-200 bg-stone-50/95 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-8 py-4">
          <span className="text-xs text-stone-500 dark:text-stone-400">
            {dirty ? "Unsaved changes." : "Up to date."}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={() => navigate("/memory")}>
              Close
            </Button>
            <Button onClick={handleSave} disabled={!dirty || saving}>
              {saving ? (
                <>
                  <Loader2 size={16} className="animate-spin" /> Applying…
                </>
              ) : (
                "Apply"
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
