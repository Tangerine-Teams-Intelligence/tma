// === wave 4-D i18n ===
// === wave 5-α ===
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";
import { Brain, RotateCw, Pencil, Save, X } from "lucide-react";
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
      pushToast({
        kind: "error",
        msg: `${t("welcome.heartbeatNoChannelTitle")} ${t("welcome.heartbeatNoChannelBody")}`,
        ctaLabel: t("welcome.heartbeatNoChannelCta"),
        ctaHref: "/ai-tools/cursor",
      });
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

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /co-thinker</span>
        <span className="ml-auto">
          {status?.observations_today != null && (
            <>{t("coThinker.obsToday", { count: status.observations_today })}</>
          )}
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-4 flex items-start gap-3">
          <Brain size={20} className="mt-1 text-stone-500" />
          <div className="flex-1">
            <p className="ti-section-label">{t("coThinker.title")}</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {t("coThinker.title")}
            </h1>
            <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
              {t("coThinker.subtitle")}
            </p>
          </div>
        </header>

        <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-y border-stone-200 py-3 dark:border-stone-800">
          <HeartbeatBadge status={status} />
          <div className="flex items-center gap-2">
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
          <div data-testid="co-thinker-loading" aria-busy="true" className="space-y-4">
            <Skeleton className="h-5 w-1/3" />
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
            <BrainView content={content} />
          </div>
        )}
      </div>
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
    <section className="rounded-md border border-stone-200 bg-white p-5 dark:border-stone-800 dark:bg-stone-900">
      {heading && (
        <h2 className="ti-section-label mb-3 text-stone-900 dark:text-stone-100">
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
