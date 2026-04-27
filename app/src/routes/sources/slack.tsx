/**
 * /sources/slack — Slack source page (v1.8 Phase 2-B).
 *
 * The capture half of this connector lives in `sources/slack/` (TypeScript
 * package, polled by the daemon). This page focuses on the Phase 2-B
 * **writeback** controls:
 *
 *   1. Toggle: post a pre-meeting brief 5min before any calendar event that
 *      touches a memory atom.
 *   2. Toggle: post a decision summary after a meeting ends.
 *   3. Channel picker — fallback channel when an atom doesn't carry one.
 *   4. Outcome panel — last 5 writeback attempts (success / error).
 *
 * Toggle state persists to ~/.tmi/config.yaml under `sources.slack.writeback`
 * (see config.rs validator); we round-trip via the existing get_config /
 * set_config Tauri commands so the daemon reads the same source of truth.
 *
 * The route is intentionally narrower than DiscordSourceRoute — capture-side
 * setup (workspace OAuth, channel pick) is owned by a future Phase 3 wizard.
 * For now this page assumes the user already ran `tangerine-slack auth set`
 * via the CLI; the writeback toggles fail gracefully when no token is found
 * (the command surfaces `slack_token_missing` in the outcomes panel).
 */

// === wave 5-α ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  Hash,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Send,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import {
  getConfig,
  setConfig,
  slackWritebackBrief,
  slackWritebackSummary,
} from "@/lib/tauri";
// v1.9.0-beta.3 P3-B — first-time writeback confirm. Posting on the
// user's behalf to a team channel is irreversible (Slack edits the post
// permanently if we delete; the team has already seen it). Per spec §3.4
// gate the first OFF→ON flip behind a one-time modal; subsequent flips
// in the same session bypass.
import { logEvent } from "@/lib/telemetry";

type WritebackOutcome = {
  kind: "brief" | "summary";
  ok: boolean;
  message: string;
  at: string; // ISO
};

interface SlackWritebackConfig {
  postPreMeetingBrief: boolean;
  postPostMeetingSummary: boolean;
  fallbackChannelId: string;
}

function defaultConfig(): SlackWritebackConfig {
  return {
    postPreMeetingBrief: false,
    postPostMeetingSummary: false,
    fallbackChannelId: "",
  };
}

const OUTCOMES_KEY = "tangerine.slack.writeback.outcomes.v1";

function loadOutcomes(): WritebackOutcome[] {
  try {
    const raw = window.localStorage.getItem(OUTCOMES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as WritebackOutcome[];
    return Array.isArray(parsed) ? parsed.slice(0, 5) : [];
  } catch {
    return [];
  }
}

function saveOutcomes(outcomes: WritebackOutcome[]): void {
  try {
    window.localStorage.setItem(OUTCOMES_KEY, JSON.stringify(outcomes.slice(0, 5)));
  } catch {
    /* quota exceeded — drop silently, this is debugging UX only */
  }
}

export default function SlackSourceRoute() {
  const { t } = useTranslation();
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
  const [cfg, setCfg] = useState<SlackWritebackConfig>(defaultConfig);
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcomes, setOutcomes] = useState<WritebackOutcome[]>(() => loadOutcomes());
  const [testing, setTesting] = useState<null | "brief" | "summary">(null);

  // Hydrate from ~/.tmi/config.yaml on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = (await getConfig()) as ParsedConfig | null;
        if (cancelled) return;
        const wb = readSlackWriteback(r);
        if (wb) setCfg(wb);
      } catch {
        /* fresh install — keep defaults */
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function persist(next: SlackWritebackConfig) {
    setCfg(next);
    setSaving(true);
    try {
      const r = ((await getConfig()) as ParsedConfig | null) ?? {
        yaml: "",
        parsed: {},
        exists: false,
      };
      const merged = mergeSlackWriteback(r, next);
      await setConfig(merged);
    } catch (e) {
      pushToast("error", `${t("sources.slack.saveError")} ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * v1.9.0-beta.3 P3-B — gate the first OFF→ON writeback flip in this
   * session behind a confirm modal. Disabling the toggle is reversible
   * (we just stop posting), so OFF flips skip the modal. Re-enabling
   * after a disable also skips — once confirmed, stays confirmed for
   * the rest of the session.
   */
  function persistWithConfirm(next: SlackWritebackConfig) {
    const turningOn =
      (next.postPreMeetingBrief && !cfg.postPreMeetingBrief) ||
      (next.postPostMeetingSummary && !cfg.postPostMeetingSummary);
    const turningAllOff =
      !next.postPreMeetingBrief && !next.postPostMeetingSummary;
    if (!turningOn) {
      // OFF flips or fallback channel edits don't need confirm.
      void persist(next);
      // If everything is now off, clear the latch so the next re-enable
      // re-confirms (per spec — give the user a chance to re-read the
      // disclosure on every fresh enablement cycle).
      if (turningAllOff && firstWritebackConfirmed.has("slack")) {
        unmarkWritebackConfirmed("slack");
      }
      return;
    }
    if (firstWritebackConfirmed.has("slack")) {
      void persist(next);
      return;
    }
    pushModal({
      id: "slack-writeback-first-time",
      emoji: "🍊",
      title: t("sources.slack.modalTitle"),
      body: t("sources.slack.modalBody"),
      confirmLabel: t("sources.slack.modalConfirm"),
      cancelLabel: t("sources.slack.modalCancel"),
      onConfirm: () => {
        markWritebackConfirmed("slack");
        void persist(next);
        void logEvent("accept_suggestion", {
          tier: "modal",
          template_name: "writeback_first_time_slack",
        });
      },
      onCancel: () => {
        // Revert the local state so the checkbox reflects "still off".
        setCfg(cfg);
        void logEvent("dismiss_suggestion", {
          surface_id: "slack-writeback-first-time",
          modal_kind: "writeback_first_time_slack",
        });
      },
    });
  }

  function recordOutcome(o: WritebackOutcome) {
    const next = [o, ...outcomes].slice(0, 5);
    setOutcomes(next);
    saveOutcomes(next);
  }

  async function runTestBrief() {
    setTesting("brief");
    try {
      // Empty decision_path triggers the user-error path in Rust if the
      // user never wired it up; otherwise this is the integration smoke test.
      await slackWritebackBrief("", cfg.fallbackChannelId);
      recordOutcome({
        kind: "brief",
        ok: true,
        message: `Posted to ${cfg.fallbackChannelId || "(atom default)"}.`,
        at: new Date().toISOString(),
      });
      pushToast("success", t("sources.slack.briefPosted"));
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      recordOutcome({
        kind: "brief",
        ok: false,
        message: msg,
        at: new Date().toISOString(),
      });
      pushToast("error", `${t("sources.slack.briefFailed")} ${msg}`);
    } finally {
      setTesting(null);
    }
  }

  async function runTestSummary() {
    setTesting("summary");
    try {
      await slackWritebackSummary("", cfg.fallbackChannelId);
      recordOutcome({
        kind: "summary",
        ok: true,
        message: `Posted to ${cfg.fallbackChannelId || "(atom default)"}.`,
        at: new Date().toISOString(),
      });
      pushToast("success", t("sources.slack.summaryPosted"));
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      recordOutcome({
        kind: "summary",
        ok: false,
        message: msg,
        at: new Date().toISOString(),
      });
      pushToast("error", `${t("sources.slack.summaryFailed")} ${msg}`);
    } finally {
      setTesting(null);
    }
  }

  return (
    <div className="min-h-full bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-14 items-center gap-3 border-b border-stone-200 bg-stone-50 px-6 dark:border-stone-800 dark:bg-stone-950">
        <Link
          to="/today"
          className="inline-flex items-center gap-1 text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <ArrowLeft size={16} />
        </Link>
        <div
          className="flex h-7 w-7 items-center justify-center rounded-md"
          style={{ background: "var(--ti-orange-50)", color: "var(--ti-orange-700)" }}
        >
          <Hash size={14} />
        </div>
        <span className="font-display text-lg leading-none text-stone-900 dark:text-stone-100">
          {t("sources.slack.title")}
        </span>
        <span className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {t("sources.slack.headerSub")}
        </span>
      </header>

      <main className="mx-auto max-w-3xl p-8 pb-16">
        <p className="ti-section-label">{t("sources.slack.kicker")}</p>
        <h1 className="mt-1 font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
          {t("sources.slack.h1")}
        </h1>
        <p className="mt-2 text-sm text-stone-700 dark:text-stone-300">
          {t("sources.slack.intro")}
        </p>

        {!hydrated ? (
          <div className="mt-8 flex items-center gap-2 text-sm text-[var(--ti-ink-500)]">
            <Loader2 size={14} className="animate-spin" /> {t("sources.slack.loadingConfig")}
          </div>
        ) : (
          <>
            <section className="mt-8 space-y-3">
              <Card>
                <CardContent className="space-y-4 pt-6">
                  <ToggleRow
                    label={t("sources.slack.preBriefLabel")}
                    description={t("sources.slack.preBriefHint")}
                    checked={cfg.postPreMeetingBrief}
                    onChange={(v) =>
                      persistWithConfirm({ ...cfg, postPreMeetingBrief: v })
                    }
                  />
                  <ToggleRow
                    label={t("sources.slack.summaryLabel")}
                    description={t("sources.slack.summaryHint")}
                    checked={cfg.postPostMeetingSummary}
                    onChange={(v) =>
                      persistWithConfirm({ ...cfg, postPostMeetingSummary: v })
                    }
                  />
                  {saving && (
                    <p className="flex items-center gap-1 text-xs text-[var(--ti-ink-500)]">
                      <Loader2 size={12} className="animate-spin" /> {t("sources.slack.saving")}
                    </p>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-3 pt-6">
                  <Label htmlFor="slack-fallback-channel">{t("sources.slack.fallbackLabel")}</Label>
                  <p className="text-xs text-[var(--ti-ink-500)]">
                    {t("sources.slack.fallbackHint")}
                  </p>
                  <Input
                    id="slack-fallback-channel"
                    value={cfg.fallbackChannelId}
                    onChange={(e) =>
                      persist({ ...cfg, fallbackChannelId: e.target.value })
                    }
                    placeholder="C0PROJECTROADMAP"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </CardContent>
              </Card>

              <Card>
                <CardContent className="space-y-3 pt-6">
                  <p className="ti-section-label">{t("sources.slack.testHeading")}</p>
                  <p className="text-xs text-[var(--ti-ink-500)]">
                    {t("sources.slack.testHint")}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={runTestBrief}
                      disabled={testing !== null}
                    >
                      {testing === "brief" ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                      {t("sources.slack.testBrief")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={runTestSummary}
                      disabled={testing !== null}
                    >
                      {testing === "summary" ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Send size={14} />
                      )}
                      {t("sources.slack.testSummary")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </section>

            <section className="mt-6">
              <p className="ti-section-label">{t("sources.slack.outcomesHeading")}</p>
              <Card className="mt-3">
                <CardContent className="pt-6">
                  {outcomes.length === 0 ? (
                    <p className="text-xs italic text-[var(--ti-ink-500)]">
                      {t("sources.slack.outcomesEmpty")}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {outcomes.map((o, i) => (
                        <li
                          key={`${o.at}-${i}`}
                          className="flex items-start gap-2 text-sm"
                        >
                          {o.ok ? (
                            <CheckCircle2
                              size={14}
                              className="mt-0.5 shrink-0 text-[var(--ti-success)]"
                            />
                          ) : (
                            <AlertCircle
                              size={14}
                              className="mt-0.5 shrink-0 text-[var(--ti-danger)]"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-mono text-[11px] uppercase text-[var(--ti-ink-500)]">
                                {o.kind}
                              </span>
                              <span className="font-mono text-[11px] text-[var(--ti-ink-500)]">
                                {formatRelative(o.at)}
                              </span>
                            </div>
                            <p className="break-words text-xs text-[var(--ti-ink-700)]">
                              {o.message}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}

function ToggleRow({ label, description, checked, onChange }: ToggleRowProps) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <div className="flex-1">
        <p className="font-medium text-[var(--ti-ink-900)]">{label}</p>
        <p className="text-xs text-[var(--ti-ink-500)]">{description}</p>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 accent-[var(--ti-orange-500)]"
      />
    </label>
  );
}

// === end wave 5-α ===

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffSec = Math.round((Date.now() - t) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

// ----------------------------------------------------------------------
// config.yaml round-trip helpers.

interface ParsedConfig {
  yaml: string;
  parsed: { sources?: { slack?: { writeback?: SlackWritebackConfig } } };
  exists: boolean;
}

function readSlackWriteback(r: ParsedConfig | null): SlackWritebackConfig | null {
  const wb = r?.parsed?.sources?.slack?.writeback;
  if (!wb) return null;
  return {
    postPreMeetingBrief: !!wb.postPreMeetingBrief,
    postPostMeetingSummary: !!wb.postPostMeetingSummary,
    fallbackChannelId: typeof wb.fallbackChannelId === "string" ? wb.fallbackChannelId : "",
  };
}

/**
 * Merge the writeback sub-config into the existing yaml string. This is
 * deliberately string-level rather than full YAML re-emission so we don't
 * disturb formatting / comments in the user's config. We append (or
 * replace) a `# === slack writeback ===` marked block.
 */
function mergeSlackWriteback(r: ParsedConfig, wb: SlackWritebackConfig): string {
  const block = renderSlackBlock(wb);
  const yaml = r.exists ? r.yaml : minimalScaffoldYaml();
  const startMarker = "# === slack writeback (v1.8 Phase 2-B) ===";
  const endMarker = "# === end slack writeback ===";
  const startIdx = yaml.indexOf(startMarker);
  if (startIdx < 0) {
    return yaml.trimEnd() + "\n\n" + block + "\n";
  }
  const endIdx = yaml.indexOf(endMarker, startIdx);
  if (endIdx < 0) {
    return yaml.trimEnd() + "\n\n" + block + "\n";
  }
  const before = yaml.slice(0, startIdx);
  const after = yaml.slice(endIdx + endMarker.length);
  return (before.trimEnd() + "\n\n" + block + after).replace(/\n{3,}/g, "\n\n");
}

function renderSlackBlock(wb: SlackWritebackConfig): string {
  return [
    "# === slack writeback (v1.8 Phase 2-B) ===",
    "sources:",
    "  slack:",
    "    writeback:",
    `      postPreMeetingBrief: ${wb.postPreMeetingBrief}`,
    `      postPostMeetingSummary: ${wb.postPostMeetingSummary}`,
    `      fallbackChannelId: ${JSON.stringify(wb.fallbackChannelId)}`,
    "# === end slack writeback ===",
  ].join("\n");
}

function minimalScaffoldYaml(): string {
  // Minimal config that passes the existing validator (commands/config.rs).
  return [
    "schema_version: 1",
    "meetings_repo: ~/.tangerine-meetings",
    "team: []",
    "discord: {}",
    "whisper: {}",
    "claude: {}",
    "output_adapters: []",
  ].join("\n");
}
