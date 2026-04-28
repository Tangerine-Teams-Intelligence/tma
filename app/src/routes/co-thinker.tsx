// === wave 4-D i18n ===
// === wave 5-α ===
// === wave 9 === — split-view markdown source layout (positioning).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Brain, RotateCw, Pencil, Save, X, Eye, Columns2, FileCode } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { ErrorState } from "@/components/ErrorState";
import { useStore } from "@/lib/store";
import {
  coThinkerReadBrain,
  coThinkerWriteBrain,
  coThinkerStatus,
  coThinkerTriggerHeartbeat,
  coThinkerInitializeBrain,
  type CoThinkerStatus,
} from "@/lib/tauri";
import {
  CITATION_REGEX,
  parseSections,
  CANONICAL_SECTIONS,
} from "@/lib/co-thinker";
import { HeartbeatBadge } from "@/components/co-thinker/HeartbeatBadge";
import { CitationLink } from "@/components/co-thinker/CitationLink";
import { getAIToolConfig } from "@/lib/ai-tools-config";
// v1.9.0-beta.1 P1-A — log brain-doc edits + manual heartbeats so the
// suggestion engine can detect "user keeps editing the brain → AGI keeps
// drifting" or "user manually triggered 5 heartbeats today → cadence
// feels too slow" patterns.
import { logEvent } from "@/lib/telemetry";
// === wave 9 === — vendor color for the heartbeat ribbon + grounding
// AtomCards.
import { vendorColor } from "@/lib/vendor-colors";
import { AtomCard } from "@/components/AtomCard";

// === wave 9 === — view modes for the split layout. "split" is the
// default to telegraph design moat #2 (markdown brain transparency):
// the user always sees the raw markdown next to the rendered prose so
// they know "this is the file you can git-diff".
type BrainViewMode = "preview" | "split" | "source";

/**
 * /co-thinker — Phase 3-C real renderer.
 *
 * Tangerine's persistent AGI brain lives in
 * `~/.tangerine-memory/team/co-thinker.md` (v1.9.3+; the legacy v1.9.2
 * location was `agi/co-thinker.md` — `read_brain_doc` lazy-migrates that
 * path on first read). The daemon (P3-A) re-reads atoms every 5 minutes
 * and asks the user's primary AI tool (P3-B) to update the doc. This
 * route is the human-facing window into that doc:
 *
 *   • read-mode renders the markdown with citation links rewritten to
 *     in-app /memory routes;
 *   • edit-mode swaps in a textarea so the user can hand-correct anything
 *     before the next heartbeat re-reads it;
 *   • a manual "Trigger heartbeat now" button lets the user skip the cadence;
 *   • when the doc is empty / missing, an empty state offers a one-click
 *     "Initialize co-thinker" CTA that fires the first heartbeat.
 */
export default function CoThinkerRoute() {
  const { t } = useTranslation();
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const pushToast = useStore((s) => s.ui.pushToast);
  // === wave 11 === — heartbeat-fail toast now opens the SetupWizard
  // instead of routing to /ai-tools/cursor (which forced the user to
  // hunt for the right setup steps). The wizard is the guided path.
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  // === end wave 11 ===
  const location = useLocation();

  const [content, setContent] = useState<string>("");
  const [status, setStatus] = useState<CoThinkerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [triggerLoading, setTriggerLoading] = useState(false);
  const brainContainerRef = useRef<HTMLDivElement | null>(null);
  // === wave 9 === — view mode for split-source / preview / source-only.
  // Defaults to "split" so design moat #2 (markdown transparency) is
  // visible from the first paint without a click. Persists for the
  // session via plain useState (not URL — we don't want share-links to
  // rewrite a teammate's preference).
  const [viewMode, setViewMode] = useState<BrainViewMode>("split");

  // v1.8 Phase 4-C — when arriving via `/co-thinker#sticky-{id}` (the
  // "🍊 View AGI reasoning" affordance on a canvas sticky), scroll to the
  // matching `Recent reasoning` entry.
  //
  // The bullet shape the heartbeat writes is:
  //   - <ts> → AGI throw on canvas `<p>/<t>` — <blurb> [sticky:<p>/<t>/<id>] [canvas/<p>/<t>.md]
  //
  // We scan the rendered markdown for the first `[sticky:.../{id}]` token.
  useEffect(() => {
    if (loading || editing) return;
    if (!location.hash) return;
    const m = location.hash.match(/^#sticky-(.+)$/);
    if (!m) return;
    const id = decodeURIComponent(m[1]);
    // Defer to next tick so ReactMarkdown has emitted DOM nodes.
    const tries = [0, 50, 150, 400];
    for (const delay of tries) {
      window.setTimeout(() => {
        const root = brainContainerRef.current ?? document.body;
        const target = findReasoningElementForSticky(root, id);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("ti-sticky-reasoning-flash");
          window.setTimeout(() => target.classList.remove("ti-sticky-reasoning-flash"), 1800);
        }
      }, delay);
    }
  }, [location.hash, loading, editing, content]);

  // Look up the human label for the user's primary tool. Falls back to the
  // raw id (or "your AI tool") when the catalog doesn't know it — keeps the
  // empty-state copy useful even if the user is on a tool we haven't keyed.
  const primaryToolName = useMemo(() => {
    if (!primaryAITool) return t("coThinker.primaryToolFallback");
    return getAIToolConfig(primaryAITool)?.name ?? primaryAITool;
  }, [primaryAITool, t]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [doc, st] = await Promise.all([coThinkerReadBrain(), coThinkerStatus()]);
      setContent(doc);
      setStatus(st);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? t("coThinker.errorReadFallback"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // === wave 6 === BUG #4 — translate Rust-side "primary tool unreachable"
  // / `all_channels_exhausted` errors into a friendly toast that explains
  // exactly how the user can fix it. We treat any error containing
  // `unreachable`, `all channels`, `not_implemented`, or `borrowed` as a
  // configuration problem (not a code bug) and show the setup-help variant.
  function isLlmConfigError(err: string): boolean {
    return /unreachable|all channels|all_channels_exhausted|not_implemented|borrow|external error/i.test(
      err,
    );
  }
  function pushHeartbeatErrorToast(err: string) {
    if (isLlmConfigError(err)) {
      // === wave 11 === — open the SetupWizard instead of navigating
      // to /ai-tools/cursor. The wizard is the guided fix; a raw
      // ai-tools route deep-link makes the user puzzle out which knob
      // to turn. `onAccept` runs before dismiss so the wizard opens
      // immediately when the user clicks the CTA.
      pushToast({
        kind: "error",
        msg: `${t("setupWizard.heartbeatToastTitle")} ${t("setupWizard.heartbeatToastBody")}`,
        ctaLabel: t("setupWizard.heartbeatToastCta"),
        onAccept: () => setSetupWizardOpen(true),
      });
      // === end wave 11 ===
    } else {
      pushToast("error", `${t("coThinker.heartbeatFailed")} ${err}`);
    }
  }

  const onTrigger = useCallback(async () => {
    setTriggerLoading(true);
    // v1.9.0-beta.1 P1-A — manual heartbeat trigger. The HeartbeatBadge is
    // a pure render component, so the user-facing "Trigger heartbeat now"
    // button lives here on the route. Daemon-driven 5-min ticks fire from
    // the Rust side and don't go through this path; only manual presses
    // log telemetry.
    void logEvent("trigger_heartbeat", { manual: true });
    try {
      const outcome = await coThinkerTriggerHeartbeat(primaryAITool ?? undefined);
      if (outcome.error) {
        pushHeartbeatErrorToast(outcome.error);
      } else {
        pushToast(
          "success",
          `${t("coThinker.brainUpdated")} · ${outcome.atoms_seen} atoms · ${outcome.channel_used}`,
        );
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushHeartbeatErrorToast(msg);
    } finally {
      setTriggerLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAITool, pushToast, refresh, t]);

  // === wave 6 === BUG #2 — Initialize button writes the seed template
  // first (Rust-side `co_thinker_initialize_brain` does both the seed write
  // + the heartbeat). Even when no LLM channel is reachable, the user ends
  // up with a real co-thinker.md on disk — solving the "I clicked Initialize
  // but the file isn't there" empty-state confusion.
  const onInitialize = useCallback(async () => {
    setTriggerLoading(true);
    void logEvent("trigger_heartbeat", { manual: true, initialize: true });
    try {
      const outcome = await coThinkerInitializeBrain(primaryAITool ?? undefined);
      if (outcome.error) {
        pushHeartbeatErrorToast(outcome.error);
      } else {
        pushToast(
          "success",
          `${t("coThinker.brainUpdated")} · ${outcome.atoms_seen} atoms · ${outcome.channel_used}`,
        );
      }
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushHeartbeatErrorToast(msg);
    } finally {
      setTriggerLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAITool, pushToast, refresh, t]);

  // === wave 5-β ===
  // Auto-trigger first heartbeat when the user got here via the Cmd+K
  // "Initialize co-thinker brain" command. The palette dispatches a
  // `tangerine:co-thinker-init` window event ~50ms after navigation;
  // we listen for it and call onInitialize if the brain is currently
  // empty. Empty-only so a returning user who triggers the command
  // doesn't lose existing brain content to an unintended heartbeat.
  // === wave 6 === — switched to onInitialize so the seed lands on disk
  // (BUG #2) even if the heartbeat can't reach an LLM channel.
  useEffect(() => {
    function onInit() {
      const isCurrentlyEmpty = content.trim().length === 0;
      if (isCurrentlyEmpty && !triggerLoading) {
        void onInitialize();
      }
    }
    window.addEventListener("tangerine:co-thinker-init", onInit);
    return () =>
      window.removeEventListener("tangerine:co-thinker-init", onInit);
  }, [content, triggerLoading, onInitialize]);
  // === end wave 5-β ===

  const onEdit = useCallback(() => {
    setDraft(content);
    setEditing(true);
  }, [content]);

  const onCancelEdit = useCallback(() => {
    setEditing(false);
    setDraft("");
  }, []);

  const onSave = useCallback(async () => {
    setSaving(true);
    try {
      await coThinkerWriteBrain(draft);
      // v1.9.0-beta.1 P1-A — measure how big the user's edit was. The
      // suggestion engine uses content_diff_size to detect "user
      // re-writing huge chunks of the brain doc" → AGI is drifting from
      // their model and we should propose a re-cohering banner.
      void logEvent("co_thinker_edit", {
        content_diff_size: Math.abs(draft.length - content.length),
      });
      setContent(draft);
      setEditing(false);
      pushToast("success", t("coThinker.honorEditToast"));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `${t("coThinker.saveFailed")} ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [draft, content, pushToast, t]);

  const isEmpty = !loading && content.trim().length === 0;

  // === wave 8 === — derive "alive" state for the brain hero pulse.
  const lastBeat = status?.last_heartbeat_at ?? null;
  const isBrainAlive =
    lastBeat !== null &&
    Date.now() - new Date(lastBeat).getTime() < 10 * 60 * 1000;

  return (
    // === wave 8 === — soft gradient backdrop so the brain page reads as
    // "AI thinking" rather than "wiki page". Same hero gradient as
    // /today; consistent visual language across the two AI-forward routes.
    <div className="ti-hero-bg">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50/60 px-6 font-mono text-[11px] text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/60 dark:text-stone-400">
        <span>~ /co-thinker</span>
        <span className="ml-auto">
          {status?.observations_today != null && (
            <>{t("coThinker.obsToday", { count: status.observations_today })}</>
          )}
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-6 flex items-start gap-3 animate-ti-rise">
          {/* === wave 8 === — brain mark gets a soft circular bg + the
              alive dot when a heartbeat fired in the last 10 min. The
              orange dot keeps the brand anchor; the halo around it
              communicates "agent is thinking". */}
          <div className="relative mt-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--ti-orange-50)] dark:bg-[var(--ti-paper-200)]">
            <Brain size={20} className="text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]" />
            {isBrainAlive && (
              <span
                aria-hidden
                data-testid="co-thinker-alive-dot"
                className="ti-alive-dot absolute -right-0.5 -top-0.5"
                style={{ width: "10px", height: "10px" }}
              />
            )}
          </div>
          <div className="flex-1">
            <p className="ti-section-label">{t("coThinker.title")}</p>
            <h1 className="mt-1 text-display-md text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]">
              {t("coThinker.title")}
            </h1>
            <p className="mt-2 max-w-prose text-[13px] leading-relaxed text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
              {t("coThinker.subtitle")}
            </p>
          </div>
        </header>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-stone-200 py-3 dark:border-stone-800">
          {/* === wave 9 === — vendor color for the heartbeat ribbon dot.
              When the user has a primary AI tool set, the ribbon picks
              up that vendor's color so the page telegraphs "this brain
              was last fed via Cursor" / "via Ollama" without making the
              user click. */}
          <div className="flex flex-wrap items-center gap-3">
            <HeartbeatRibbonDot primaryAITool={primaryAITool} status={status} />
            <HeartbeatBadge status={status} />
          </div>
          <div className="flex items-center gap-2">
            {!editing && !isEmpty && (
              <ViewModeToggle viewMode={viewMode} onChange={setViewMode} />
            )}
            {!editing && !isEmpty && (
              <Button
                variant="outline"
                size="sm"
                onClick={onTrigger}
                disabled={triggerLoading}
                aria-label={t("coThinker.trigger")}
              >
                <RotateCw
                  size={13}
                  className={triggerLoading ? "animate-spin" : undefined}
                />
                {triggerLoading ? t("coThinker.triggering") : t("coThinker.trigger")}
              </Button>
            )}
            {!editing && !isEmpty && (
              <Button variant="outline" size="sm" onClick={onEdit} aria-label="Edit brain doc">
                <Pencil size={13} />
                {t("coThinker.edit")}
              </Button>
            )}
          </div>
        </div>

        {loading ? (
          // === wave 8 === — thinking-wave skeleton. The first heading
          // bar runs the green-tinted wave so the "loading" state codes
          // as "agent is thinking" rather than the generic stone bars.
          <div data-testid="co-thinker-loading" aria-busy="true" className="space-y-4">
            <div className="ti-thinking-wave h-5 w-1/3 rounded" />
            <SkeletonText lines={4} />
            <Skeleton className="h-5 w-1/4" />
            <SkeletonText lines={3} />
          </div>
        ) : error ? (
          <ErrorState
            error={error}
            title={t("coThinker.errorRead")}
            onRetry={() => void refresh()}
            retryLabel={t("coThinker.retry")}
            testId="co-thinker-error"
          />
        ) : isEmpty ? (
          <EmptyState
            primaryToolName={primaryToolName}
            onInitialize={onInitialize}
            initializing={triggerLoading}
          />
        ) : editing ? (
          <EditPane
            value={draft}
            onChange={setDraft}
            onSave={onSave}
            onCancel={onCancelEdit}
            saving={saving}
          />
        ) : (
          <div ref={brainContainerRef}>
            {/* === wave 9 === — split-view default. Renders preview-only
                / source-only / side-by-side based on the toolbar
                selection. Design moat #2 made literal: the user always
                has the raw markdown one click away. */}
            {viewMode === "preview" && <BrainView content={content} />}
            {viewMode === "source" && (
              <SourcePane content={content} testId="co-thinker-source-only" />
            )}
            {viewMode === "split" && (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div data-testid="co-thinker-split-preview">
                  <BrainView content={content} />
                </div>
                <div data-testid="co-thinker-split-source">
                  <SourcePane content={content} />
                </div>
              </div>
            )}
            {/* === wave 9 === — Cited atoms (grounding) section.
                Surfaces the atoms the brain doc references as
                AtomCards so the user sees the cross-vendor context
                explicitly, not buried inside paragraphs. */}
            <CitedAtomsSection content={content} primaryAITool={primaryAITool} />
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================
   === wave 9 === Heartbeat ribbon dot (vendor color)
   ============================================================ */

function HeartbeatRibbonDot({
  primaryAITool,
  status,
}: {
  primaryAITool: string | null;
  status: CoThinkerStatus | null;
}) {
  const last = status?.last_heartbeat_at ?? null;
  const isAlive =
    last !== null && Date.now() - new Date(last).getTime() < 10 * 60 * 1000;
  const isInFlight = false; // future: wire to a `triggerLoading` flag from parent.
  const vc = vendorColor(primaryAITool);
  const dotHex = vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc.hex;
  const tooltip = primaryAITool
    ? `Last heartbeat used: ${vc.label}`
    : "No primary AI tool set yet";
  return (
    <span
      data-testid="heartbeat-ribbon-dot"
      data-vendor={primaryAITool ?? "default"}
      title={tooltip}
      className="inline-flex h-3 w-3 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden
        className="h-2.5 w-2.5 rounded-full"
        style={{
          background: dotHex,
          // Pulse only when alive; static when stale; future "in-flight"
          // animation can swap to a faster cadence via data-state.
          animation: isAlive
            ? "ti-live-pulse 2s ease-in-out infinite"
            : isInFlight
              ? "ti-pulse 1.4s ease-in-out infinite"
              : undefined,
        }}
      />
    </span>
  );
}

/* ============================================================
   === wave 9 === View mode toggle (preview / split / source)
   ============================================================ */

function ViewModeToggle({
  viewMode,
  onChange,
}: {
  viewMode: BrainViewMode;
  onChange: (m: BrainViewMode) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Brain view mode"
      data-testid="co-thinker-view-toggle"
      className="inline-flex items-center rounded-md border border-stone-200 bg-stone-50 p-0.5 dark:border-stone-800 dark:bg-stone-900"
    >
      <ToggleButton
        active={viewMode === "preview"}
        onClick={() => onChange("preview")}
        label="Preview"
        testId="view-mode-preview"
      >
        <Eye size={12} />
      </ToggleButton>
      <ToggleButton
        active={viewMode === "split"}
        onClick={() => onChange("split")}
        label="Split"
        testId="view-mode-split"
      >
        <Columns2 size={12} />
      </ToggleButton>
      <ToggleButton
        active={viewMode === "source"}
        onClick={() => onChange("source")}
        label="Source"
        testId="view-mode-source"
      >
        <FileCode size={12} />
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  label,
  testId,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-testid={testId}
      className={
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium transition-colors duration-fast " +
        (active
          ? "bg-white text-[var(--ti-orange-700)] shadow-sm dark:bg-stone-800 dark:text-[var(--ti-orange-500)]"
          : "text-stone-500 hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-stone-800")
      }
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

/* ============================================================
   === wave 9 === Source pane — raw markdown with line numbers (iA Writer style)
   ============================================================ */

function CitedAtomsSection({
  content,
  primaryAITool,
}: {
  content: string;
  primaryAITool: string | null;
}) {
  // Pull every /memory/...md reference out of the brain doc, dedupe,
  // and render up to 6 as AtomCards. Only the primary AI tool is
  // available as a vendor proxy here (no per-atom vendor metadata yet).
  const citations = useMemo(() => {
    const out: { path: string; line: number | null }[] = [];
    const seen = new Set<string>();
    const re = new RegExp(CITATION_REGEX.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const path = m[1];
      const line = m[2] ? Number.parseInt(m[2], 10) : null;
      const k = `${path}#${line ?? ""}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ path, line });
      if (out.length >= 6) break;
    }
    return out;
  }, [content]);

  if (citations.length === 0) return null;

  return (
    <section
      data-testid="co-thinker-grounding"
      className="mt-8"
      aria-label="Cited atoms (grounding)"
    >
      <h2 className="ti-section-display mb-3">Cited atoms (grounding)</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {citations.map((c, i) => {
          // Atom basename = last path segment without `.md`.
          const slug = c.path.split("/").pop() ?? c.path;
          const title = slug.replace(/\.md$/, "").replace(/[-_]/g, " ");
          return (
            <AtomCard
              key={`grounding-${i}-${c.path}`}
              vendor={primaryAITool}
              title={title}
              sourcePath={c.path.replace(/^\/memory\//, "")}
              linkTo={c.path}
              testId={`grounding-atom-${i}`}
            />
          );
        })}
      </div>
    </section>
  );
}

function SourcePane({
  content,
  testId,
}: {
  content: string;
  testId?: string;
}) {
  // Split into lines so the CSS counter can prefix each with a line
  // number. Empty trailing line stays so the gutter renders the final
  // newline gracefully.
  const lines = content.length === 0 ? [""] : content.split("\n");
  return (
    <div
      data-testid={testId ?? "co-thinker-source-pane"}
      className="ti-md-source"
      role="textbox"
      aria-label="Raw markdown source"
      aria-readonly="true"
    >
      {lines.map((line, i) => (
        <span key={i} className="ti-md-line">
          {line || "​"}
        </span>
      ))}
    </div>
  );
}

/**
 * v1.8 Phase 4-C — locate the rendered `Recent reasoning` element whose
 * text contains the canvas-anchor token `[sticky:<p>/<t>/<id>]` for the
 * given sticky id. Returns the closest scrollable ancestor (typically a
 * `<li>`) so `scrollIntoView` lands on a meaningful row.
 */
function findReasoningElementForSticky(root: HTMLElement, stickyId: string): HTMLElement | null {
  // Match either `[sticky:<rest>/<id>]` or `[sticky:<id>]` (defensive).
  const needles = [`/${stickyId}]`, `[sticky:${stickyId}]`];
  // Walk all <li> elements first — that's where the heartbeat writes the
  // reasoning bullet.
  const lis = root.querySelectorAll<HTMLElement>("li");
  for (const li of Array.from(lis)) {
    const text = li.textContent || "";
    if (needles.some((n) => text.includes(n))) return li;
  }
  // Fallback — any element directly containing the marker text.
  const all = root.querySelectorAll<HTMLElement>("p, li, span");
  for (const el of Array.from(all)) {
    const text = el.textContent || "";
    if (needles.some((n) => text.includes(n))) return el;
  }
  return null;
}

/* ============================================================
   Empty state
   ============================================================ */

function EmptyState({
  primaryToolName,
  onInitialize,
  initializing,
}: {
  primaryToolName: string;
  onInitialize: () => void;
  initializing: boolean;
}) {
  const { t } = useTranslation();
  // Wave 4-C — first-time co-thinker explainer. Surfaced when the
  // brain doc is empty (the standard pre-init signal — heartbeats
  // populate the doc, so empty == never-fired). The 4 explainer
  // bullets unpack what "co-thinker" is so a first-time user
  // understands what "Initialize" means before they click. The
  // existing `onInitialize` button stays the primary CTA below.
  return (
    <section
      data-testid="co-thinker-empty"
      className="space-y-4"
    >
      <article
        data-testid="co-thinker-explainer"
        className="rounded-md border border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)]/40 p-6 dark:border-[var(--ti-orange-500)]/30 dark:bg-stone-900/40"
      >
        <h2 className="font-display text-xl tracking-tight text-stone-900 dark:text-stone-100">
          {t("coThinker.explainer.heading")}
        </h2>
        <p className="mt-3 max-w-prose text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          {t("coThinker.explainer.intro")}
        </p>
        <ul className="mt-4 space-y-2 text-[13px] text-stone-700 dark:text-stone-300">
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 text-[var(--ti-orange-500)]">·</span>
            <span>
              <strong className="text-stone-900 dark:text-stone-100">
                {t("coThinker.explainer.readLabel")}
              </strong>{" "}
              {t("coThinker.explainer.readBody")}
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 text-[var(--ti-orange-500)]">·</span>
            <span>
              <strong className="text-stone-900 dark:text-stone-100">
                {t("coThinker.explainer.editLabel")}
              </strong>{" "}
              {t("coThinker.explainer.editBody")}
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 text-[var(--ti-orange-500)]">·</span>
            <span>
              <strong className="text-stone-900 dark:text-stone-100">
                {t("coThinker.explainer.diffLabel")}
              </strong>{" "}
              {t("coThinker.explainer.diffBody")}
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="mt-1 text-[var(--ti-orange-500)]">·</span>
            <span>
              <strong className="text-stone-900 dark:text-stone-100">
                {t("coThinker.explainer.noSubLabel")}
              </strong>{" "}
              {t("coThinker.explainer.noSubBody")}
            </span>
          </li>
        </ul>
      </article>

      <div className="rounded-md border border-dashed border-stone-300 bg-stone-100/40 p-6 dark:border-stone-700 dark:bg-stone-900/40">
        <h2 className="font-display text-base tracking-tight text-stone-900 dark:text-stone-100">
          {t("coThinker.explainer.readyHeading")}
        </h2>
        <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-stone-600 dark:text-stone-400">
          {t("coThinker.explainer.readyBody")}
        </p>
        <div className="mt-4">
          <Button onClick={onInitialize} disabled={initializing}>
            <RotateCw size={14} className={initializing ? "animate-spin" : undefined} />
            {initializing ? t("coThinker.initializing") : t("coThinker.initialize")}
          </Button>
        </div>
        <p className="mt-3 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {t("coThinker.primaryToolLine")}{" "}
          <strong className="text-stone-700 dark:text-stone-200">{primaryToolName}</strong>
        </p>
      </div>
    </section>
  );
}
// === end wave 5-α ===

/* ============================================================
   Edit pane
   ============================================================ */

function EditPane({
  value,
  onChange,
  onSave,
  onCancel,
  saving,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section data-testid="co-thinker-editor" className="space-y-3">
      <textarea
        aria-label="Edit brain doc"
        className="block h-[60vh] w-full rounded-md border border-stone-200 bg-white p-3 font-mono text-[12px] leading-relaxed text-stone-900 outline-none focus:border-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="flex items-center gap-2">
        <Button onClick={onSave} disabled={saving}>
          <Save size={14} />
          {saving ? t("coThinker.saving") : t("coThinker.save")}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          <X size={14} />
          {t("coThinker.cancel")}
        </Button>
        <p className="ml-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {t("coThinker.honorEdit")}
        </p>
      </div>
    </section>
  );
}

/* ============================================================
   Brain view — section cards w/ citation rewriter
   ============================================================ */

function BrainView({ content }: { content: string }) {
  // Split into sections then sort canonical-first so the layout is stable
  // even if the brain doc emits sections in a different order.
  const sections = useMemo(() => {
    const parsed = parseSections(content);
    if (parsed.length === 0) {
      // No H2 headings — render the whole thing as a single anonymous block.
      return [{ heading: "", body: content }];
    }
    const canonical = CANONICAL_SECTIONS.map((h) =>
      parsed.find((s) => s.heading.toLowerCase() === h.toLowerCase()),
    ).filter((s): s is NonNullable<typeof s> => Boolean(s));
    const extras = parsed.filter(
      (s) =>
        !CANONICAL_SECTIONS.some((h) => h.toLowerCase() === s.heading.toLowerCase()),
    );
    return [...canonical, ...extras];
  }, [content]);

  return (
    <div data-testid="co-thinker-brain" className="space-y-6">
      {sections.map((s, i) => (
        <SectionCard key={`${s.heading}-${i}`} heading={s.heading} body={s.body} />
      ))}
    </div>
  );
}

function SectionCard({ heading, body }: { heading: string; body: string }) {
  return (
    <section className="rounded-md border border-stone-200 bg-white/70 p-5 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-900/70">
      {/* === wave 8 === — section headers in display serif (not all-caps
          tracked sans). Softer, more "thinking" than admin-panel. */}
      {heading && (
        <h2
          data-testid="co-thinker-section-heading"
          className="ti-section-display mb-3"
        >
          {heading}
        </h2>
      )}
      <article className="prose-tangerine outline-none" tabIndex={-1}>
        <ReactMarkdown
          components={{
            // Inline text — primary rewrite happens here so citations flowing
            // inside paragraphs / list items / blockquotes all become links.
            p: ({ children }) => (
              <p className="mt-2 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
                {rewriteCitations(children)}
              </p>
            ),
            li: ({ children }) => (
              <li className="text-sm text-stone-700 dark:text-stone-300">
                {rewriteCitations(children)}
              </li>
            ),
            ul: ({ children }) => (
              <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>
            ),
            ol: ({ children }) => (
              <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>
            ),
            h3: ({ children }) => (
              <h3 className="mt-4 font-medium text-stone-900 dark:text-stone-100">
                {children}
              </h3>
            ),
            code: ({ children }) => (
              <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[12px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">
                {children}
              </code>
            ),
            a: ({ children, href }) => (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
              >
                {children}
              </a>
            ),
          }}
        >
          {body}
        </ReactMarkdown>
      </article>
    </section>
  );
}

/* ============================================================
   Citation rewriter
   ============================================================ */

/**
 * Walk a ReactMarkdown children tree and replace every `/memory/...md` /
 * `/memory/...md L<n>` reference embedded in plain-text nodes with a
 * <CitationLink/>. Non-string children (already-rendered <code>, <a>, etc.)
 * pass through untouched.
 */
function rewriteCitations(children: ReactNode): ReactNode {
  if (children == null) return children;
  if (typeof children === "string") return rewriteString(children);
  if (Array.isArray(children)) {
    return children.map((c, i) => {
      if (typeof c === "string") {
        const out = rewriteString(c);
        // rewriteString returns either the same string or an array; React
        // is fine with either as long as the parent has a key context. We
        // wrap in a fragment with a stable key when it's an array.
        return Array.isArray(out) ? (
          <span key={i}>{out}</span>
        ) : (
          <span key={i}>{out}</span>
        );
      }
      return c;
    });
  }
  return children;
}

/**
 * Pure string → mixed nodes. Returns the original string when no citations
 * are found (cheap fast-path); otherwise returns an array of strings and
 * <CitationLink/>s in order.
 */
function rewriteString(s: string): ReactNode {
  if (!s.includes("/memory/")) return s;
  // Reset the regex each call — it's a top-level `g` regex so its
  // lastIndex is shared.
  CITATION_REGEX.lastIndex = 0;
  const out: ReactNode[] = [];
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = CITATION_REGEX.exec(s)) !== null) {
    const [full, path, lineStr] = m;
    if (m.index > lastIdx) out.push(s.slice(lastIdx, m.index));
    const line = lineStr ? Number.parseInt(lineStr, 10) : null;
    out.push(<CitationLink key={key++} path={path} line={line} />);
    lastIdx = m.index + full.length;
  }
  if (lastIdx === 0) return s;
  if (lastIdx < s.length) out.push(s.slice(lastIdx));
  return out;
}
