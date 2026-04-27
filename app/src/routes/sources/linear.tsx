/**
 * /sources/linear — capture status + v1.8 Phase 2-A writeback config.
 *
 * Mirrors the GitHub page exactly except:
 *   - The auth field is `LINEAR_API_KEY` (Bearer key, not OAuth) — read
 *     from the existing `.env` allowlist via `setSecret` / `getSecret`.
 *     We never round-trip the key through React state for display; the
 *     UI shows only "configured" / "missing".
 *   - Writeback target is a fresh "decision recorded" issue in the
 *     team's project (state Done, label `tangerine-decision`).
 *
 * Toggle persists to `~/.tmi/config.yaml` under `writeback.linear.enabled`.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Eye,
  EyeOff,
  GitBranch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  getConfig,
  setConfig,
  getSecret,
  setSecret,
  setWritebackWatcher,
  readWritebackLog,
  openExternal,
  type WritebackLogEntry,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
// v1.9.0-beta.3 P3-B — first-time writeback confirm. Opening Linear
// issues on the user's behalf is irreversible (the team is notified).
// Per spec §3.4 gate the first OFF→ON apply behind a modal.
import { logEvent } from "@/lib/telemetry";

type SectionId = "capture" | "writeback";

interface LinearWritebackConfig {
  enabled: boolean;
}

function emptyWritebackCfg(): LinearWritebackConfig {
  return { enabled: false };
}

function readWritebackFromConfig(parsed: unknown): LinearWritebackConfig {
  if (!parsed || typeof parsed !== "object") return emptyWritebackCfg();
  const root = parsed as Record<string, unknown>;
  const wb = root.writeback;
  if (!wb || typeof wb !== "object") return emptyWritebackCfg();
  const lin = (wb as Record<string, unknown>).linear;
  if (!lin || typeof lin !== "object") return emptyWritebackCfg();
  const l = lin as Record<string, unknown>;
  return {
    enabled: typeof l.enabled === "boolean" ? l.enabled : false,
  };
}

function mergeLinearWritebackIntoYaml(
  existingYaml: string,
  cfg: LinearWritebackConfig,
  /** Preserve the github stanza we may have written from the github page. */
  githubBlock: string | null
): string {
  const lines = existingYaml.split("\n");
  const out: string[] = [];
  let inWriteback = false;
  for (const line of lines) {
    const isTopLevelKey = /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line);
    if (line.startsWith("writeback:")) {
      inWriteback = true;
      continue;
    }
    if (inWriteback) {
      if (isTopLevelKey) {
        inWriteback = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }
  if (out.length > 0 && out[out.length - 1].trim() !== "") {
    out.push("");
  }
  out.push("writeback:");
  if (githubBlock) {
    out.push(githubBlock);
  }
  out.push("  linear:");
  out.push(`    enabled: ${cfg.enabled ? "true" : "false"}`);
  out.push("");
  return out.join("\n");
}

/** Pull the existing github writeback block (raw, indented two spaces). */
function extractGithubWritebackBlock(yaml: string): string | null {
  const lines = yaml.split("\n");
  const writebackIdx = lines.findIndex((l) => l.startsWith("writeback:"));
  if (writebackIdx < 0) return null;
  const out: string[] = [];
  let inGithub = false;
  for (let i = writebackIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const isTopLevelKey = /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line);
    if (isTopLevelKey) break;
    if (line.startsWith("  github:")) {
      inGithub = true;
      out.push(line);
      continue;
    }
    if (inGithub) {
      // Stop when we hit another `  <something>:` sibling under writeback.
      if (/^  [a-zA-Z_]/.test(line) && !line.startsWith("  github:")) break;
      out.push(line);
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

export default function LinearSourceRoute() {
  const pushToast = useStore((s) => s.ui.pushToast);
  const pushModal = useStore((s) => s.ui.pushModal);
  const firstWritebackConfirmed = useStore(
    (s) => s.ui.firstWritebackConfirmedThisSession,
  );
  const markWritebackConfirmed = useStore(
    (s) => s.ui.markWritebackConfirmed,
  );
  const unmarkWritebackConfirmed = useStore(
    (s) => s.ui.unmarkWritebackConfirmed,
  );

  const [openSection, setOpenSection] = useState<SectionId | null>("writeback");
  const [loading, setLoading] = useState(true);
  const [yamlBody, setYamlBody] = useState<string>("");
  const [cfg, setCfg] = useState<LinearWritebackConfig>(emptyWritebackCfg());
  const [saving, setSaving] = useState(false);

  // API key state. We only ever know whether the key is set or unset; the
  // value lives in the .env file managed by the Rust side.
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [keyDraft, setKeyDraft] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [logEntries, setLogEntries] = useState<WritebackLogEntry[]>([]);
  const [logPath, setLogPath] = useState<string>("");
  const [logLoading, setLogLoading] = useState(false);

  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const raw = await getConfig();
        if (cancel) return;
        let parsedJson: unknown = null;
        let yaml = "";
        if (raw && typeof raw === "object" && "yaml" in raw && "parsed" in raw) {
          const r = raw as { yaml: string; parsed: unknown };
          yaml = r.yaml;
          parsedJson = r.parsed;
        } else if (typeof raw === "string") {
          yaml = raw;
        } else if (raw && typeof raw === "object") {
          parsedJson = raw;
        }
        setYamlBody(yaml);
        setCfg(readWritebackFromConfig(parsedJson));

        const k = await getSecret("LINEAR_API_KEY");
        if (cancel) return;
        setKeyConfigured(!!k && k.length > 0);
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  async function refreshLog() {
    setLogLoading(true);
    try {
      const r = await readWritebackLog({ limit: 5, source: "linear" });
      setLogEntries(r.entries);
      setLogPath(r.log_path);
    } finally {
      setLogLoading(false);
    }
  }
  useEffect(() => {
    let alive = true;
    void refreshLog();
    const t = window.setInterval(() => {
      if (!alive) return;
      void refreshLog();
    }, 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  async function persistWriteback(
    next: LinearWritebackConfig,
    nextKey: string | null,
  ) {
    setSaving(true);
    try {
      if (!yamlBody.trim()) {
        pushToast(
          "error",
          "No ~/.tmi/config.yaml yet. Finish the Discord setup first so the schema is initialised."
        );
        return;
      }
      const githubBlock = extractGithubWritebackBlock(yamlBody);
      const newYaml = mergeLinearWritebackIntoYaml(yamlBody, next, githubBlock);
      await setConfig(newYaml);
      setYamlBody(newYaml);
      setCfg(next);

      if (nextKey !== null && nextKey.length > 0) {
        await setSecret("LINEAR_API_KEY", nextKey);
        setKeyConfigured(true);
        setKeyDraft("");
      }

      // The Rust watcher is global (covers github + linear). Turn it on
      // when *either* source is enabled. We don't have the github toggle
      // value in scope here — so when turning ON, just call enabled=true,
      // and on OFF, leave the watcher state alone (the Apply button on
      // the github page will manage its own toggle). Pragmatic compromise:
      // call set_writeback_watcher with the current Linear toggle so at
      // least the Linear side is honored immediately.
      await setWritebackWatcher(next.enabled);
      pushToast(
        "success",
        next.enabled
          ? "Linear writeback ON. Decisions will open issues automatically."
          : "Linear writeback OFF. Capture continues unchanged."
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      pushToast("error", `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * v1.9.0-beta.3 P3-B — first OFF→ON gets the confirm modal. Pure
   * key-only updates (no enabled change) still skip; OFF flips skip and
   * clear the latch.
   */
  async function applyWriteback(
    next: LinearWritebackConfig,
    nextKey: string | null,
  ): Promise<void> {
    const turningOn = next.enabled && !cfg.enabled;
    if (!turningOn) {
      await persistWriteback(next, nextKey);
      if (!next.enabled && firstWritebackConfirmed.has("linear")) {
        unmarkWritebackConfirmed("linear");
      }
      return;
    }
    if (firstWritebackConfirmed.has("linear")) {
      await persistWriteback(next, nextKey);
      return;
    }
    pushModal({
      id: "linear-writeback-first-time",
      emoji: "🍊",
      title: "Open Linear issues on Tangerine's behalf?",
      body:
        "When enabled, Tangerine will open a fresh \"decision recorded\" issue (state Done, label tangerine-decision) in the team for every finalized decision. Each issue is automated — no per-message confirm.\n\n" +
        "This is a one-time confirm. Disable any time.",
      confirmLabel: "Allow Linear issues",
      cancelLabel: "Not now",
      onConfirm: () => {
        markWritebackConfirmed("linear");
        void persistWriteback(next, nextKey);
        void logEvent("accept_suggestion", {
          tier: "modal",
          template_name: "writeback_first_time_linear",
        });
      },
      onCancel: () => {
        void logEvent("dismiss_suggestion", {
          surface_id: "linear-writeback-first-time",
          modal_kind: "writeback_first_time_linear",
        });
      },
    });
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Link
          to="/memory"
          aria-label="Back"
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-stone-700 hover:bg-stone-200 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          <ArrowLeft size={16} />
        </Link>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-paper-200)", color: "var(--ti-ink-500)" }}
        >
          <GitBranch size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          Linear
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Configure
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · Linear</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          Linear source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Pulls issues, comments, and project state into{" "}
          <code className="font-mono text-[13px]">memory/threads/linear-*.md</code>.
          With writeback ON, finalised decisions in{" "}
          <code className="font-mono text-[13px]">memory/decisions/</code> open a fresh
          "decision recorded" issue (state Done, label{" "}
          <code className="font-mono text-[13px]">tangerine-decision</code>) in the
          team the original issue belongs to.
        </p>

        {loading ? (
          <p className="mt-6 flex items-center gap-2 text-sm text-stone-500 dark:text-stone-400">
            <Loader2 size={14} className="animate-spin" /> Loading config…
          </p>
        ) : (
          <div className="mt-8 space-y-3">
            <Section
              id="capture"
              title="Capture"
              done={true}
              open={openSection === "capture"}
              onToggle={() =>
                setOpenSection(openSection === "capture" ? null : "capture")
              }
            >
              <CaptureSection />
            </Section>

            <Section
              id="writeback"
              title="Writeback"
              done={cfg.enabled}
              open={openSection === "writeback"}
              onToggle={() =>
                setOpenSection(openSection === "writeback" ? null : "writeback")
              }
            >
              <WritebackSection
                cfg={cfg}
                saving={saving}
                onApply={applyWriteback}
                keyConfigured={keyConfigured}
                keyDraft={keyDraft}
                setKeyDraft={setKeyDraft}
                showKey={showKey}
                setShowKey={setShowKey}
                logEntries={logEntries}
                logLoading={logLoading}
                logPath={logPath}
                onRefreshLog={refreshLog}
              />
            </Section>
          </div>
        )}
      </main>
    </div>
  );
}

interface SectionProps {
  id: SectionId;
  title: string;
  done: boolean;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}

function Section({ title, done, open, onToggle, children }: SectionProps) {
  return (
    <Card>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 px-6 py-4 text-left"
      >
        <div className="flex items-center gap-3">
          {open ? (
            <ChevronDown size={16} className="text-[var(--ti-ink-500)]" />
          ) : (
            <ChevronRight size={16} className="text-[var(--ti-ink-500)]" />
          )}
          <span className="font-medium text-[var(--ti-ink-900)]">{title}</span>
        </div>
        {done ? (
          <span className="flex items-center gap-1 text-xs text-[#2D8659]">
            <CheckCircle2 size={14} /> On
          </span>
        ) : (
          <span className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
            <AlertCircle size={14} /> Off
          </span>
        )}
      </button>
      {open && <CardContent className="pt-0 pb-6">{children}</CardContent>}
    </Card>
  );
}

function CaptureSection() {
  return (
    <div className="space-y-3 text-sm text-[var(--ti-ink-700)]">
      <p>
        Capture for Linear runs from the{" "}
        <code className="font-mono text-[13px]">sources/linear</code> Node package
        (separate process). Issues, comments, and project state changes become
        atoms in your memory dir.
      </p>
      <p className="font-mono text-[11px] text-[var(--ti-ink-500)]">
        Per-team cursors live in{" "}
        <code>memory/.tangerine/sources/linear.config.json</code>. This page focuses
        on writeback — Phase 2-A.
      </p>
    </div>
  );
}

interface WritebackSectionProps {
  cfg: LinearWritebackConfig;
  saving: boolean;
  onApply: (next: LinearWritebackConfig, nextKey: string | null) => Promise<void>;
  keyConfigured: boolean;
  keyDraft: string;
  setKeyDraft: (s: string) => void;
  showKey: boolean;
  setShowKey: (b: boolean) => void;
  logEntries: WritebackLogEntry[];
  logLoading: boolean;
  logPath: string;
  onRefreshLog: () => Promise<void>;
}

function WritebackSection(p: WritebackSectionProps) {
  const [draft, setDraft] = useState<LinearWritebackConfig>(p.cfg);
  useEffect(() => setDraft(p.cfg), [p.cfg.enabled]);
  const dirty = draft.enabled !== p.cfg.enabled || p.keyDraft.length > 0;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm text-[var(--ti-ink-700)]">
          When ON, Tangerine watches{" "}
          <code className="font-mono text-[13px]">~/.tangerine-memory/decisions/</code>{" "}
          and creates a Linear issue whenever a new decision file with{" "}
          <code className="font-mono text-[13px]">source: linear</code> is written.
          Issue title comes from the decision's <code className="font-mono">title</code>{" "}
          frontmatter; body is the full decision markdown.
        </p>

        <label className="flex items-start gap-3">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
            className="mt-1 h-4 w-4 accent-[var(--ti-orange-500)]"
          />
          <div>
            <p className="font-medium text-[var(--ti-ink-900)]">
              Post decisions back to Linear
            </p>
            <p className="text-xs text-[var(--ti-ink-500)]">
              Reuses your{" "}
              <code className="font-mono text-[13px]">LINEAR_API_KEY</code>. Read-only
              when OFF.
            </p>
          </div>
        </label>

        <div className="space-y-1">
          <Label htmlFor="linear-key">Linear API key</Label>
          <div className="flex items-center gap-2">
            <Input
              id="linear-key"
              type={p.showKey ? "text" : "password"}
              value={p.keyDraft}
              onChange={(e) => p.setKeyDraft(e.target.value.trim())}
              placeholder={
                p.keyConfigured
                  ? "(configured — leave blank to keep)"
                  : "lin_api_…"
              }
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              variant="outline"
              size="icon"
              type="button"
              onClick={() => p.setShowKey(!p.showKey)}
              aria-label={p.showKey ? "Hide key" : "Show key"}
            >
              {p.showKey ? <EyeOff size={16} /> : <Eye size={16} />}
            </Button>
          </div>
          <p className="text-xs text-[var(--ti-ink-500)]">
            {p.keyConfigured
              ? "Key is set in your .env. Replace it by typing a new key here."
              : "Get a personal API key from Linear → Settings → API."}{" "}
            <button
              className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
              onClick={() => openExternal("https://linear.app/settings/api")}
              type="button"
            >
              Open Linear API settings <ExternalLink size={10} className="inline" />
            </button>
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            disabled={!dirty || p.saving}
            onClick={() =>
              void p.onApply(draft, p.keyDraft.length > 0 ? p.keyDraft : null)
            }
          >
            {p.saving ? (
              <>
                <Loader2 size={14} className="animate-spin" /> Saving…
              </>
            ) : (
              "Apply"
            )}
          </Button>
          {dirty && !p.saving && (
            <span className="text-xs text-[var(--ti-ink-500)]">
              Unsaved changes
            </span>
          )}
        </div>
      </div>

      <div className="space-y-2 border-t border-stone-200 pt-4 dark:border-stone-800">
        <div className="flex items-center justify-between">
          <p className="ti-section-label">Writeback log (last 5)</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void p.onRefreshLog()}
            disabled={p.logLoading}
          >
            {p.logLoading ? <Loader2 size={12} className="animate-spin" /> : "Refresh"}
          </Button>
        </div>

        {p.logEntries.length === 0 ? (
          <p className="text-xs italic text-[var(--ti-ink-500)]">
            No writebacks yet. Finalize a decision in{" "}
            <code className="font-mono">memory/decisions/</code> with{" "}
            <code className="font-mono">source: linear</code> to see one here.
          </p>
        ) : (
          <ul className="space-y-2">
            {p.logEntries.map((e, i) => (
              <LogRow key={`${e.ts}-${i}`} entry={e} />
            ))}
          </ul>
        )}

        {p.logPath && (
          <p className="font-mono text-[10px] text-[var(--ti-ink-500)]">
            log: {p.logPath}
          </p>
        )}
      </div>
    </div>
  );
}

function LogRow({ entry }: { entry: WritebackLogEntry }) {
  const o = entry.outcome;
  const colour =
    o.status === "posted"
      ? "#2D8659"
      : o.status === "already_done"
        ? "var(--ti-ink-500)"
        : o.status === "failed"
          ? "#B83232"
          : "var(--ti-ink-500)";
  return (
    <li className="rounded-md border border-stone-200 bg-white px-3 py-2 text-xs dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px]" style={{ color: colour }}>
          {o.status}
        </span>
        <span className="font-mono text-[10px] text-[var(--ti-ink-500)]">
          {new Date(entry.ts).toLocaleTimeString()}
        </span>
      </div>
      <div className="mt-1 truncate font-mono text-[11px] text-[var(--ti-ink-700)]">
        {entry.decision_path}
      </div>
      {o.status === "posted" && (
        <button
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--ti-orange-500)] hover:underline"
          onClick={() => void openExternal(o.external_url)}
        >
          <ExternalLink size={10} /> View issue
        </button>
      )}
      {o.status === "already_done" && (
        <button
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--ti-ink-500)] hover:underline"
          onClick={() => void openExternal(o.external_url)}
        >
          <ExternalLink size={10} /> Existing issue
        </button>
      )}
      {o.status === "failed" && (
        <p className="mt-1 text-[11px] text-[#B83232]">{o.error}</p>
      )}
      {o.status === "not_applicable" && (
        <p className="mt-1 text-[11px] italic text-[var(--ti-ink-500)]">
          {o.reason}
        </p>
      )}
    </li>
  );
}
