import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Brain, RotateCw, Pencil, Save, X, AlertCircle } from "lucide-react";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { Skeleton, SkeletonText } from "@/components/ui/Skeleton";
import { useStore } from "@/lib/store";
import {
  coThinkerReadBrain,
  coThinkerWriteBrain,
  coThinkerStatus,
  coThinkerTriggerHeartbeat,
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
 * `~/.tangerine-memory/agi/co-thinker.md`. The daemon (P3-A) re-reads atoms
 * every 5 minutes and asks the user's primary AI tool (P3-B) to update the
 * doc. This route is the human-facing window into that doc:
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
    if (!primaryAITool) return "your AI tool";
    return getAIToolConfig(primaryAITool)?.name ?? primaryAITool;
  }, [primaryAITool]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [doc, st] = await Promise.all([coThinkerReadBrain(), coThinkerStatus()]);
      setContent(doc);
      setStatus(st);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not read co-thinker brain doc.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      pushToast(
        outcome.error ? "error" : "success",
        outcome.error
          ? `Heartbeat failed: ${outcome.error}`
          : `Brain updated · ${outcome.atoms_seen} atoms · ${outcome.channel_used}`,
      );
      await refresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `Heartbeat failed: ${msg}`);
    } finally {
      setTriggerLoading(false);
    }
  }, [primaryAITool, pushToast, refresh]);

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
      pushToast(
        "success",
        "Brain doc saved. The AGI honors your edit on the next heartbeat.",
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushToast("error", `Save failed: ${msg}`);
    } finally {
      setSaving(false);
    }
  }, [draft, content, pushToast]);

  const isEmpty = !loading && content.trim().length === 0;

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /co-thinker</span>
        <span className="ml-auto">
          {status?.observations_today != null && (
            <>
              {status.observations_today} observation
              {status.observations_today === 1 ? "" : "s"} today
            </>
          )}
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-8">
        <header className="mb-4 flex items-start gap-3">
          <Brain size={20} className="mt-1 text-stone-500" />
          <div className="flex-1">
            <p className="ti-section-label">Co-thinker</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Co-thinker
            </h1>
            <p className="mt-2 max-w-prose text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
              Tangerine's persistent AGI brain. Reads new atoms every few
              minutes and writes its observations into the doc below.
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
                aria-label="Trigger heartbeat now"
              >
                <RotateCw
                  size={13}
                  className={triggerLoading ? "animate-spin" : undefined}
                />
                {triggerLoading ? "Heartbeat…" : "Trigger heartbeat now"}
              </Button>
            )}
            {!editing && !isEmpty && (
              <Button variant="outline" size="sm" onClick={onEdit} aria-label="Edit brain doc">
                <Pencil size={13} />
                Edit
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
          <div
            role="alert"
            className="rounded-md border border-[var(--ti-danger)]/40 bg-[var(--ti-danger)]/5 p-6 text-center"
          >
            <AlertCircle size={20} className="mx-auto text-[var(--ti-danger)]" />
            <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
              Couldn't read the brain doc.
            </p>
            <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
              {error}
            </p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-3 rounded border border-stone-300 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              Retry
            </button>
          </div>
        ) : isEmpty ? (
          <EmptyState
            primaryToolName={primaryToolName}
            onInitialize={onTrigger}
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
  return (
    <section
      data-testid="co-thinker-empty"
      className="rounded-md border border-dashed border-stone-300 bg-stone-100/40 p-6 dark:border-stone-700 dark:bg-stone-900/40"
    >
      <h2 className="font-display text-xl tracking-tight text-stone-900 dark:text-stone-100">
        Co-thinker hasn't started thinking yet.
      </h2>
      <p className="mt-3 max-w-prose text-sm leading-relaxed text-stone-700 dark:text-stone-300">
        Tangerine's persistent AGI brain runs in the background — every 5
        minutes when the app is open. It reads new captures from your sources,
        writes its observations here, and surfaces what your team should pay
        attention to.
      </p>
      <div className="mt-5">
        <Button onClick={onInitialize} disabled={initializing}>
          <RotateCw size={14} className={initializing ? "animate-spin" : undefined} />
          {initializing ? "Initializing…" : "Initialize co-thinker"}
        </Button>
      </div>
      <p className="mt-4 font-mono text-[11px] text-stone-500 dark:text-stone-400">
        Uses your primary AI tool:{" "}
        <strong className="text-stone-700 dark:text-stone-200">{primaryToolName}</strong>
      </p>
    </section>
  );
}

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
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={saving}>
          <X size={14} />
          Cancel
        </Button>
        <p className="ml-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          The AGI will honor your edit on the next heartbeat.
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
