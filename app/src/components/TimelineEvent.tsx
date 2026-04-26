import { Link } from "react-router-dom";
import { GitPullRequest, MessageSquare, Calendar, FileText, Ticket, Sparkles } from "lucide-react";
import type { TimelineEvent as TimelineEventT } from "@/lib/views";
import { formatClock } from "@/lib/views";

/**
 * One row in /today, /people/:alias, /projects/:slug, /threads/:topic.
 *
 * Layout (3-column grid):
 *   HH:MM · @actor · headline                 [confidence?]
 *   src · refs (chips) · file:line link
 *
 * Click → drills into the source atom file via /memory/<file>.
 *
 * Stage 2 hook §1: confidence badge surfaces only when < 1.0 (Stage 2
 * grades freshness/correctness). Stage 1 always = 1.0; badge hidden.
 */
export function TimelineEvent({
  event,
  onView,
  compact = false,
}: {
  event: TimelineEventT;
  /** Called when the user actually views the row (e.g. on click). The
   *  parent's onView handler is responsible for the cursor write. */
  onView?: (id: string) => void;
  compact?: boolean;
}) {
  const Icon = pickIcon(event.kind, event.source);
  const time = formatClock(event.ts);
  const headline = (event.body ?? "").split("\n")[0] || event.kind;
  const refs = extractRefs(event);
  const showConfidence = event.confidence < 1.0;
  const handleClick = () => {
    if (onView) onView(event.id);
  };
  const filePath = event.file
    ? `/memory/${encodeURI(event.file)}`
    : null;

  const inner = (
    <>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] tabular-nums text-stone-500 dark:text-stone-400">
          {time}
        </span>
        <Icon size={12} className="shrink-0 text-stone-400 dark:text-stone-500" />
        <span className="font-mono text-[11px] text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]">
          @{event.actor || "?"}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-stone-800 dark:text-stone-200">
          {headline}
        </span>
        {showConfidence && (
          <span
            className="shrink-0 rounded border border-amber-400/40 bg-amber-50 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-amber-700 dark:bg-stone-800 dark:text-amber-400"
            title={`AI confidence: ${(event.confidence * 100).toFixed(0)}% (Stage 2)`}
          >
            <Sparkles size={9} className="mr-0.5 inline" />
            {(event.confidence * 100).toFixed(0)}%
          </span>
        )}
      </div>
      {!compact && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 pl-[3.25rem] font-mono text-[10px] text-stone-500 dark:text-stone-400">
          <span>{event.source}</span>
          {refs.map((r) => (
            <span
              key={`${r.kind}:${r.value}`}
              className="rounded bg-stone-100 px-1.5 py-px text-stone-600 dark:bg-stone-800 dark:text-stone-300"
            >
              {r.kind}:{r.value}
            </span>
          ))}
          {event.file && event.line != null && (
            <span className="ml-auto text-stone-400 dark:text-stone-500">
              {event.file}:{event.line}
            </span>
          )}
        </div>
      )}
    </>
  );

  const className =
    "block rounded px-3 py-2 text-left transition-colors duration-fast hover:bg-stone-100 dark:hover:bg-stone-900";
  if (filePath) {
    return (
      <Link
        to={filePath}
        onClick={handleClick}
        className={className}
        data-atom-id={event.id}
      >
        {inner}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`${className} w-full`}
      data-atom-id={event.id}
    >
      {inner}
    </button>
  );
}

function pickIcon(kind: string, source: string) {
  if (kind === "pr_event") return GitPullRequest;
  if (kind === "comment") return MessageSquare;
  if (kind === "ticket_event") return Ticket;
  if (kind === "decision") return FileText;
  if (kind === "meeting_chunk" || source === "calendar") return Calendar;
  return MessageSquare;
}

function extractRefs(ev: TimelineEventT): { kind: string; value: string }[] {
  const out: { kind: string; value: string }[] = [];
  const refs = ev.refs;
  if (!refs || typeof refs !== "object") return out;
  const r = refs as Record<string, unknown>;
  const meeting = r.meeting;
  if (typeof meeting === "string" && meeting) out.push({ kind: "meeting", value: meeting });
  for (const k of ["projects", "threads", "decisions", "people"]) {
    const v = r[k];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string" && item) {
          out.push({ kind: k.slice(0, -1), value: item });
        }
      }
    }
  }
  return out.slice(0, 4);
}
