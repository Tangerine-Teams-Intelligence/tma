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
  Video,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  openExternal,
  setSecret,
  loomGetConfig,
  loomSetConfig,
  loomValidateToken,
  loomCapture,
  loomPullTranscript,
  resolveMemoryRoot,
  type LoomConfig,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";

export default function LoomSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [validation, setValidation] = useState<{
    ok: boolean;
    workspace?: string | null;
    error?: string | null;
  } | null>(null);
  const [validating, setValidating] = useState(false);

  const [config, setConfig] = useState<LoomConfig | null>(null);
  const [folders, setFolders] = useState<string[]>([""]);
  const [captureEnabled, setCaptureEnabled] = useState(true);

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMsg, setLastSyncMsg] = useState<string | null>(null);

  const [testUrl, setTestUrl] = useState("");
  const [testTranscript, setTestTranscript] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    void loomGetConfig().then((cfg) => {
      setConfig(cfg);
      setTokenSaved(cfg.token_present);
      setCaptureEnabled(cfg.capture_enabled);
      setFolders(cfg.watched_folders.length > 0 ? cfg.watched_folders : [""]);
    });
  }, []);

  async function handleSaveToken() {
    if (!token.trim()) return;
    await setSecret("LOOM_API_TOKEN", token.trim());
    setTokenSaved(true);
    setToken("");
    pushToast("success", "Loom token stored.");
    void runValidation();
  }

  async function runValidation() {
    setValidating(true);
    try {
      const r = await loomValidateToken();
      setValidation({ ok: r.ok, workspace: r.workspace, error: r.error });
    } finally {
      setValidating(false);
    }
  }

  function updateFolder(i: number, v: string) {
    setFolders((rows) => rows.map((r, idx) => (idx === i ? v : r)));
  }
  function addFolder() {
    setFolders((rows) => [...rows, ""]);
  }
  function removeFolder(i: number) {
    setFolders((rows) => (rows.length === 1 ? [""] : rows.filter((_, idx) => idx !== i)));
  }

  async function handleSave() {
    setSaving(true);
    try {
      const cleanFolders = folders.map((f) => f.trim()).filter(Boolean);
      await loomSetConfig({
        watched_folders: cleanFolders,
        capture_enabled: captureEnabled,
      });
      pushToast("success", "Loom source configured.");
      const cfg = await loomGetConfig();
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
      const result = await loomCapture(root.path);
      setLastSyncMsg(
        `Wrote ${result.written} video${result.written === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})` : ""),
      );
      const cfg = await loomGetConfig();
      setConfig(cfg);
    } catch (e) {
      pushToast("error", `Sync failed: ${(e as Error).message}`);
    } finally {
      setSyncing(false);
    }
  }

  async function handleTestTranscript() {
    if (!testUrl.trim()) return;
    setTesting(true);
    setTestTranscript(null);
    try {
      const r = await loomPullTranscript(testUrl.trim());
      setTestTranscript(r.transcript || "(empty transcript)");
    } catch (e) {
      pushToast("error", `Transcript fetch failed: ${(e as Error).message}`);
    } finally {
      setTesting(false);
    }
  }

  const dirty = useMemo(() => {
    if (!config) return false;
    if (config.capture_enabled !== captureEnabled) return true;
    const cleanFolders = folders.map((f) => f.trim()).filter(Boolean);
    if (cleanFolders.length !== config.watched_folders.length) return true;
    return cleanFolders.join("|") !== config.watched_folders.join("|");
  }, [config, captureEnabled, folders]);

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
          <Video size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Loom
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Loom</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Set up the Loom source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Tangerine pulls transcripts from your workspace's Loom videos and
          stores each as an atom in <code className="font-mono text-xs">threads/loom/</code>.
        </p>

        {/* Token */}
        <Card className="mt-8">
          <CardContent className="pt-6 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
                Loom API token
              </p>
              <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
                Available on Loom Business / Enterprise plans. Generate one in
                Workspace Settings → Developers → API.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openExternal("https://www.loom.com/settings/workspace")
              }
            >
              <ExternalLink size={14} /> Workspace settings
            </Button>

            <Label htmlFor="loom-token">Token</Label>
            <div className="flex items-center gap-2">
              <Input
                id="loom-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenSaved ? "(stored — paste again to replace)" : "ll_..."}
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                variant="outline"
                size="icon"
                type="button"
                onClick={() => setShowToken(!showToken)}
                aria-label={showToken ? "Hide token" : "Show token"}
              >
                {showToken ? <EyeOff size={16} /> : <Eye size={16} />}
              </Button>
              <Button onClick={handleSaveToken} disabled={!token.trim()}>
                Save
              </Button>
            </div>
            {tokenSaved && (
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
            {validation && validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
                <CheckCircle2 size={12} /> Connected
                {validation.workspace ? ` — ${validation.workspace}` : ""}.
              </p>
            )}
            {validation && !validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
                <AlertCircle size={12} /> {validation.error ?? "Validation failed."}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Folders */}
        <Card className="mt-4">
          <CardContent className="pt-6 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
              Watched folders
            </p>
            <p className="text-sm text-[var(--ti-ink-700)]">
              Optional — leave blank to walk the whole workspace. Folder IDs are
              the path segment after <code className="font-mono text-xs">/folder/</code> in a Loom URL.
            </p>
            {folders.map((f, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  placeholder="folder id"
                  value={f}
                  onChange={(e) => updateFolder(i, e.target.value)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => removeFolder(i)}
                  aria-label="Remove folder"
                >
                  <X size={16} />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" onClick={addFolder}>
              <Plus size={14} /> Add folder
            </Button>
          </CardContent>
        </Card>

        {/* Toggles */}
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
                  Walk the workspace each heartbeat and write atoms.
                </p>
              </div>
            </label>
          </CardContent>
        </Card>

        {/* Test transcript */}
        <Card className="mt-4">
          <CardContent className="pt-6 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
              Test a Loom URL
            </p>
            <div className="flex items-center gap-2">
              <Input
                placeholder="https://www.loom.com/share/..."
                value={testUrl}
                onChange={(e) => setTestUrl(e.target.value)}
              />
              <Button
                onClick={handleTestTranscript}
                disabled={testing || !testUrl.trim() || !tokenSaved}
              >
                {testing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Pulling
                  </>
                ) : (
                  "Pull transcript"
                )}
              </Button>
            </div>
            {testTranscript !== null && (
              <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-200)] p-3 font-mono text-xs text-[var(--ti-ink-900)]">
                {testTranscript}
              </pre>
            )}
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
              <Button onClick={handleSyncNow} disabled={syncing || !tokenSaved}>
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
