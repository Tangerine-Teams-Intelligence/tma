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
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  openExternal,
  setSecret,
  notionGetConfig,
  notionSetConfig,
  notionValidateToken,
  notionListDatabases,
  notionCapture,
  resolveMemoryRoot,
  type NotionConfig,
  type NotionDb,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * Notion source setup. Layout mirrors discord.tsx so the user gets a
 * familiar setup affordance: token first, validation, then per-row picker
 * for databases (capture + writeback target), then toggles + sync now.
 */
export default function NotionSourceRoute() {
  const navigate = useNavigate();
  const pushToast = useStore((s) => s.ui.pushToast);

  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<{
    ok: boolean;
    botName?: string | null;
    error?: string | null;
  } | null>(null);

  const [config, setConfig] = useState<NotionConfig | null>(null);
  const [databases, setDatabases] = useState<NotionDb[]>([]);
  const [selectedDbs, setSelectedDbs] = useState<string[]>([]);
  const [decisionsDb, setDecisionsDb] = useState<string>("");
  const [captureEnabled, setCaptureEnabled] = useState(true);
  const [writebackEnabled, setWritebackEnabled] = useState(false);

  const [loadingDbs, setLoadingDbs] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncMsg, setLastSyncMsg] = useState<string | null>(null);

  // Initial load.
  useEffect(() => {
    // === v1.13.8 round-8 === — see loom.tsx: notionGetConfig now throws
    notionGetConfig()
      .then((cfg) => {
        setConfig(cfg);
        setSelectedDbs(cfg.database_ids);
        setDecisionsDb(cfg.decisions_db_id ?? "");
        setCaptureEnabled(cfg.capture_enabled);
        setWritebackEnabled(cfg.writeback_enabled);
        setTokenSaved(cfg.token_present);
      })
      .catch((e) => {
        pushToast("error", `Couldn't read Notion config: ${(e as Error).message}`);
      });
  }, [pushToast]);

  async function handleSaveToken() {
    if (!token.trim().startsWith("secret_") && !token.trim().startsWith("ntn_")) {
      pushToast(
        "error",
        "Notion integration tokens start with 'secret_' or 'ntn_'.",
      );
      return;
    }
    await setSecret("NOTION_API_TOKEN", token.trim());
    setTokenSaved(true);
    setToken("");
    pushToast("success", "Notion token stored.");
    // Auto-validate after save.
    void runValidation();
  }

  async function runValidation() {
    setValidating(true);
    try {
      const r = await notionValidateToken();
      setValidation({ ok: r.ok, botName: r.bot_name, error: r.error });
      if (r.ok) {
        await loadDatabases();
      }
    } finally {
      setValidating(false);
    }
  }

  async function loadDatabases() {
    setLoadingDbs(true);
    try {
      const dbs = await notionListDatabases();
      setDatabases(dbs);
    } finally {
      setLoadingDbs(false);
    }
  }

  function toggleDb(id: string) {
    setSelectedDbs((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      await notionSetConfig({
        database_ids: selectedDbs,
        decisions_db_id: decisionsDb || null,
        capture_enabled: captureEnabled,
        writeback_enabled: writebackEnabled,
      });
      pushToast("success", "Notion source configured.");
      const cfg = await notionGetConfig();
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
      const result = await notionCapture({ memory_root: root.path });
      setLastSyncMsg(
        `Wrote ${result.written} page${result.written === 1 ? "" : "s"}` +
          (result.errors.length > 0 ? ` (${result.errors.length} error${result.errors.length === 1 ? "" : "s"})` : ""),
      );
      const cfg = await notionGetConfig();
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
    if (config.writeback_enabled !== writebackEnabled) return true;
    if ((config.decisions_db_id ?? "") !== decisionsDb) return true;
    if (config.database_ids.length !== selectedDbs.length) return true;
    const a = [...config.database_ids].sort().join(",");
    const b = [...selectedDbs].sort().join(",");
    return a !== b;
  }, [config, captureEnabled, writebackEnabled, decisionsDb, selectedDbs]);

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
          <FileText size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Notion
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Set up
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Notion</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Set up the Notion source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Tangerine reads pages from databases you authorize. Each page lands as
          a markdown atom in <code className="font-mono text-xs">projects/{`{project}`}/notion/</code>.
          Decisions can optionally write back to a designated decisions database.
        </p>

        {/* Token */}
        <Card className="mt-8">
          <CardContent className="pt-6 space-y-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
                Notion API token
              </p>
              <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
                Create an internal integration in your Notion workspace, copy the
                "Internal Integration Token", and paste it below. Then share each
                database with the integration from the database "•••" menu.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                openExternal("https://www.notion.so/my-integrations")
              }
            >
              <ExternalLink size={14} /> My integrations
            </Button>

            <Label htmlFor="notion-token">Token</Label>
            <div className="flex items-center gap-2">
              <Input
                id="notion-token"
                type={showToken ? "text" : "password"}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={tokenSaved ? "(stored — paste again to replace)" : "secret_..."}
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
            {tokenSaved && !validation && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
                <CheckCircle2 size={12} /> Token stored.{" "}
                <button
                  className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
                  onClick={runValidation}
                  type="button"
                >
                  Validate
                </button>
              </p>
            )}
            {validation && validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
                <CheckCircle2 size={12} /> Connected
                {validation.botName ? ` — ${validation.botName}` : ""}.
              </p>
            )}
            {validation && !validation.ok && (
              <p className="flex items-center gap-1 text-xs text-[var(--ti-danger)]">
                <AlertCircle size={12} /> {validation.error ?? "Validation failed."}
              </p>
            )}
          </CardContent>
        </Card>

        {/* Databases */}
        <Card className="mt-4">
          <CardContent className="pt-6 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-[var(--ti-ink-500)]">
                  Linked databases
                </p>
                <p className="mt-1 text-sm text-[var(--ti-ink-700)]">
                  Pick the databases Tangerine should walk on each heartbeat.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={loadDatabases}
                disabled={loadingDbs || !tokenSaved}
              >
                {loadingDbs ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> Loading
                  </>
                ) : (
                  <>
                    <RefreshCw size={14} /> Refresh
                  </>
                )}
              </Button>
            </div>

            {databases.length === 0 ? (
              <p className="text-xs italic text-[var(--ti-ink-500)]">
                {tokenSaved
                  ? "No databases visible to the integration yet — share at least one from Notion's '•••' menu, then refresh."
                  : "Save a token first."}
              </p>
            ) : (
              <div className="space-y-1">
                {databases.map((db) => {
                  const checked = selectedDbs.includes(db.id);
                  return (
                    <label
                      key={db.id}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors duration-fast",
                        checked
                          ? "border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)]"
                          : "border-[var(--ti-border-default)] hover:bg-[var(--ti-paper-200)]",
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleDb(db.id)}
                        className="accent-[var(--ti-orange-500)]"
                      />
                      <span className="font-medium">{db.title}</span>
                      <span className="ml-auto font-mono text-[11px] text-[var(--ti-ink-500)]">
                        {db.id.slice(0, 8)}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            {selectedDbs.length > 0 && (
              <div className="mt-2 space-y-2">
                <Label htmlFor="decisions-db">Decisions writeback target (optional)</Label>
                <select
                  id="decisions-db"
                  className="w-full rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-200)] px-3 py-2 font-mono text-xs text-[var(--ti-ink-900)]"
                  value={decisionsDb}
                  onChange={(e) => setDecisionsDb(e.target.value)}
                >
                  <option value="">— none —</option>
                  {databases
                    .filter((db) => selectedDbs.includes(db.id))
                    .map((db) => (
                      <option key={db.id} value={db.id}>
                        {db.title}
                      </option>
                    ))}
                </select>
              </div>
            )}
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
                  Walk the linked databases each heartbeat and write atoms.
                </p>
              </div>
            </label>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={writebackEnabled}
                onChange={(e) => setWritebackEnabled(e.target.checked)}
                disabled={!decisionsDb}
                className="mt-1 accent-[var(--ti-orange-500)]"
              />
              <div>
                <p className="font-medium text-[var(--ti-ink-900)]">
                  Writeback decisions
                </p>
                <p className="text-[var(--ti-ink-700)]">
                  When a decision atom is finalised, create a row in the chosen
                  decisions database. Idempotent — repeated calls are skipped.
                </p>
              </div>
            </label>
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
