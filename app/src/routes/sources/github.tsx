/**
 * /sources/github — capture status + v1.8 Phase 2-A writeback config.
 *
 * Layout:
 *   Header (icon + title + back link)
 *   Section: Capture (read-only summary — capture lives in `sources/github/`
 *            Node package; we don't manage it here)
 *   Section: Writeback (collapsible)
 *     - Toggle: post decisions back to GitHub
 *     - Login config (writeback.github.login)
 *     - Writeback log (last 5 entries)
 *
 * The writeback toggle persists to `~/.tmi/config.yaml` under
 * `writeback.github.{enabled, login}` and ALSO calls
 * `set_writeback_watcher` so the in-process notify watcher boots
 * immediately. The next cold-launch reads the YAML and re-arms.
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
  Github,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import {
  getConfig,
  setConfig,
  setWritebackWatcher,
  readWritebackLog,
  openExternal,
  type WritebackLogEntry,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
// v1.9.0-beta.3 P3-B — first-time writeback confirm. Posting comments
// onto external PRs is irreversible (the team sees them; deleting leaves
// an audit trail). Per spec §3.4 gate the first OFF→ON apply behind a
// modal; subsequent toggles in the same session bypass.
import { logEvent } from "@/lib/telemetry";

type SectionId = "capture" | "writeback";

interface GithubWritebackConfig {
  enabled: boolean;
  login: string;
}

function emptyWritebackCfg(): GithubWritebackConfig {
  return { enabled: false, login: "" };
}

/** Pull `writeback.github.{enabled,login}` out of a YAML config blob. */
function readWritebackFromConfig(parsed: unknown): GithubWritebackConfig {
  if (!parsed || typeof parsed !== "object") return emptyWritebackCfg();
  const root = parsed as Record<string, unknown>;
  const wb = root.writeback;
  if (!wb || typeof wb !== "object") return emptyWritebackCfg();
  const gh = (wb as Record<string, unknown>).github;
  if (!gh || typeof gh !== "object") return emptyWritebackCfg();
  const g = gh as Record<string, unknown>;
  return {
    enabled: typeof g.enabled === "boolean" ? g.enabled : false,
    login: typeof g.login === "string" ? g.login : "",
  };
}

/** Merge the writeback section into an existing YAML body, preserving every
 *  other top-level key. We round-trip through JSON for dumb-but-correct YAML
 *  emit; the Rust validator only checks the required fields, not formatting. */
function mergeWritebackIntoYaml(
  existingYaml: string,
  cfg: GithubWritebackConfig
): string {
  // The existing config validator requires `schema_version`, `meetings_repo`,
  // `team`, etc. We must keep them in place. Cheapest path: do a YAML-aware
  // edit by parsing through the round-trip the Rust side already accepts.
  // Since we don't have js-yaml in deps here, append a writeback: block
  // textually, replacing any prior `writeback:` block.
  const lines = existingYaml.split("\n");
  const out: string[] = [];
  let skip = false;
  let inWriteback = false;
  for (const line of lines) {
    const isTopLevelKey = /^[a-zA-Z_][a-zA-Z0-9_]*:/.test(line);
    if (line.startsWith("writeback:")) {
      inWriteback = true;
      skip = true;
      continue;
    }
    if (inWriteback) {
      if (isTopLevelKey) {
        inWriteback = false;
        skip = false;
      } else {
        continue;
      }
    }
    if (!skip) out.push(line);
  }
  // Append the new writeback block at the end. Preserve a trailing newline.
  if (out.length > 0 && out[out.length - 1].trim() !== "") {
    out.push("");
  }
  out.push("writeback:");
  out.push("  github:");
  out.push(`    enabled: ${cfg.enabled ? "true" : "false"}`);
  out.push(`    login: ${cfg.login ? `"${cfg.login.replace(/"/g, '\\"')}"` : '""'}`);
  out.push("");
  return out.join("\n");
}

export default function GithubSourceRoute() {
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
  const [cfg, setCfg] = useState<GithubWritebackConfig>(emptyWritebackCfg());
  const [saving, setSaving] = useState(false);
  const [logEntries, setLogEntries] = useState<WritebackLogEntry[]>([]);
  const [logPath, setLogPath] = useState<string>("");
  const [logLoading, setLogLoading] = useState(false);

  // Initial load.
  useEffect(() => {
    let cancel = false;
    void (async () => {
      try {
        const raw = await getConfig();
        if (cancel) return;
        let parsedJson: unknown = null;
        let yaml = "";
        if (raw && typeof raw === "object" && "yaml" in raw && "parsed" in raw) {
          // Real Tauri shape from `get_config`.
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
      } finally {
        if (!cancel) setLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  // Refresh the log periodically so the UI surfaces watcher events without
  // needing the user to click anything. 4s cadence is fine — the writeback
  // log is tiny.
  async function refreshLog() {
    setLogLoading(true);
    try {
      const r = await readWritebackLog({ limit: 5, source: "github" });
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

  async function persistWriteback(next: GithubWritebackConfig) {
    setSaving(true);
    try {
      const newYaml = mergeWritebackIntoYaml(yamlBody, next);
      // The validator requires the original required fields — if the existing
      // yaml is empty, surface an error rather than write a partial config.
      if (!yamlBody.trim()) {
        pushToast(
          "error",
          "No ~/.tmi/config.yaml yet. Finish the Discord setup first so the schema is initialised."
        );
        return;
      }
      await setConfig(newYaml);
      setYamlBody(newYaml);
      setCfg(next);
      // Tell the in-process watcher to mirror the toggle. We only need the
      // watcher running when at least one source has writeback ON; the
      // command on the Rust side is a "set the global watcher state".
      // Future Linear toggle ORs in via the same call from its own page.
      await setWritebackWatcher(next.enabled);
      pushToast(
        "success",
        next.enabled
          ? "GitHub writeback ON. Decisions will post back automatically."
          : "GitHub writeback OFF. Capture continues unchanged."
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      pushToast("error", `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * v1.9.0-beta.3 P3-B — gate the first OFF→ON Apply behind a confirm
   * modal. Disabling is reversible (we just stop posting); re-enabling
   * after a disable in the same session skips the modal. Login-only
   * edits (no enabled change) also skip.
   */
  async function applyWriteback(next: GithubWritebackConfig): Promise<void> {
    const turningOn = next.enabled && !cfg.enabled;
    if (!turningOn) {
      await persistWriteback(next);
      // Once fully disabled again, clear the latch so a future
      // re-enable re-confirms on the user's next intentional flip.
      if (!next.enabled && firstWritebackConfirmed.has("github")) {
        unmarkWritebackConfirmed("github");
      }
      return;
    }
    if (firstWritebackConfirmed.has("github")) {
      await persistWriteback(next);
      return;
    }
    pushModal({
      id: "github-writeback-first-time",
      emoji: "🍊",
      title: "Post comments to GitHub on Tangerine's behalf?",
      body:
        "When enabled, Tangerine will post decision summaries as markdown comments on the linked PR or issue. Each comment is automated — no per-message confirm.\n\n" +
        "This is a one-time confirm. Disable any time.",
      confirmLabel: "Allow GitHub posts",
      cancelLabel: "Not now",
      onConfirm: () => {
        markWritebackConfirmed("github");
        void persistWriteback(next);
        void logEvent("accept_suggestion", {
          tier: "modal",
          template_name: "writeback_first_time_github",
        });
      },
      onCancel: () => {
        void logEvent("dismiss_suggestion", {
          surface_id: "github-writeback-first-time",
          modal_kind: "writeback_first_time_github",
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
          <Github size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          GitHub
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          / Source / Configure
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-24">
        <p className="ti-section-label">Source · GitHub</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          GitHub source
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          Pulls PR threads, review comments, and merge decisions into{" "}
          <code className="font-mono text-[13px]">memory/threads/pr-*.md</code>. With
          writeback ON, finalised decisions in{" "}
          <code className="font-mono text-[13px]">memory/decisions/</code> get posted
          back as a markdown comment on the linked PR.
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

// ============================================================
// Section wrapper (mirrors the discord.tsx pattern)
// ============================================================

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
          <span className="flex items-center gap-1 text-xs text-[var(--ti-success)]">
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

// ============================================================
// Capture section
// ============================================================

function CaptureSection() {
  return (
    <div className="space-y-3 text-sm text-[var(--ti-ink-700)]">
      <p>
        Capture for GitHub runs from the{" "}
        <code className="font-mono text-[13px]">sources/github</code> Node package
        (separate process). Once authorised it reads PRs + issues for the repos you
        opt into. This pane shows whether the connector is currently writing atoms.
      </p>
      <p className="font-mono text-[11px] text-[var(--ti-ink-500)]">
        Capture configuration lives outside this pane (per-repo cursors live in{" "}
        <code>memory/.tangerine/sources/github.config.json</code>). This page
        intentionally focuses on writeback — Phase 2-A.
      </p>
    </div>
  );
}

// ============================================================
// Writeback section
// ============================================================

interface WritebackSectionProps {
  cfg: GithubWritebackConfig;
  saving: boolean;
  onApply: (next: GithubWritebackConfig) => Promise<void>;
  logEntries: WritebackLogEntry[];
  logLoading: boolean;
  logPath: string;
  onRefreshLog: () => Promise<void>;
}

function WritebackSection(p: WritebackSectionProps) {
  const [draft, setDraft] = useState<GithubWritebackConfig>(p.cfg);
  useEffect(() => setDraft(p.cfg), [p.cfg.enabled, p.cfg.login]);
  const dirty =
    draft.enabled !== p.cfg.enabled || draft.login !== p.cfg.login;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-sm text-[var(--ti-ink-700)]">
          When ON, Tangerine watches{" "}
          <code className="font-mono text-[13px]">~/.tangerine-memory/decisions/</code>{" "}
          and posts a markdown comment on the linked PR / issue whenever a new
          decision file with{" "}
          <code className="font-mono text-[13px]">source: github</code> is written. The
          comment format is shown below — your team sees a single 🍊 message,
          unmistakably from Tangerine.
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
              Post decisions back to GitHub
            </p>
            <p className="text-xs text-[var(--ti-ink-500)]">
              Reuses your existing GitHub OAuth token. Read-only when OFF.
            </p>
          </div>
        </label>

        <div className="space-y-1">
          <Label htmlFor="github-login">GitHub login</Label>
          <Input
            id="github-login"
            type="text"
            value={draft.login}
            placeholder="daizhe"
            onChange={(e) => setDraft({ ...draft, login: e.target.value.trim() })}
            spellCheck={false}
            autoComplete="off"
          />
          <p className="text-xs text-[var(--ti-ink-500)]">
            The login we use to look up your token in the OS keychain. Defaults to
            the account you signed in with during onboarding.
          </p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            disabled={!dirty || p.saving}
            onClick={() => void p.onApply(draft)}
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
            {p.logLoading ? (
              <Loader2 size={12} className="animate-spin" />
            ) : (
              "Refresh"
            )}
          </Button>
        </div>

        {p.logEntries.length === 0 ? (
          <p className="text-xs italic text-[var(--ti-ink-500)]">
            No writebacks yet. Finalize a decision in{" "}
            <code className="font-mono">memory/decisions/</code> with{" "}
            <code className="font-mono">source: github</code> to see one here.
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
      ? "var(--ti-success)"
      : o.status === "already_done"
        ? "var(--ti-ink-500)"
        : o.status === "failed"
          ? "var(--ti-danger)"
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
          <ExternalLink size={10} /> View comment
        </button>
      )}
      {o.status === "already_done" && (
        <button
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-[var(--ti-ink-500)] hover:underline"
          onClick={() => void openExternal(o.external_url)}
        >
          <ExternalLink size={10} /> Existing comment
        </button>
      )}
      {o.status === "failed" && (
        <p className="mt-1 text-[11px] text-[var(--ti-danger)]">{o.error}</p>
      )}
      {o.status === "not_applicable" && (
        <p className="mt-1 text-[11px] italic text-[var(--ti-ink-500)]">
          {o.reason}
        </p>
      )}
    </li>
  );
}
