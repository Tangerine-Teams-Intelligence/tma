/**
 * v1.16 Wave 2 — Story Feed atom card.
 *
 * Single visual primitive used by /feed, /threads (mini-timeline atom),
 * /people (filtered atom list). Spec:
 *   - Avatar 32px round (B3 may pass size override)
 *   - Vendor color dot 8px round
 *   - Author + source + relative time row
 *   - Body preview: first non-empty line, truncated to ~120 chars short
 *     mode (60px) or 240 chars long mode (120px) with "…" ellipsis
 *   - @mention card: left border 4px ti-orange (per Wave 2 design spec)
 *   - Click → inline expand (short, ≤200 char body) OR modal (long body)
 *
 * v1.16 Wave 5 — mobile responsive polish:
 *   - Below the Tailwind `md` breakpoint (<768px) a tap dispatches a
 *     bottom-sheet (AtomBottomSheet) instead of toggling inline expand.
 *     Inline expand stays the default for desktop because power users
 *     triage 50 atoms in a session and a sheet animation would steal
 *     flow. The new behaviour is opt-in via `bottomSheetOnMobile` so
 *     callers like /threads (`alwaysExpanded`) and /people (custom
 *     onClick) keep their existing semantics.
 *
 * R6/R7/R8 honesty: never paint a "loaded" state when source data is
 * mid-fetch. Parent passes the event already-resolved.
 */

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { TimelineEvent } from "@/lib/views";
import { formatRelativeTime } from "@/lib/views";
import { vendorFor } from "./vendor";
import { Avatar } from "./Avatar";
import { AtomBottomSheet, isMobileViewport } from "./AtomBottomSheet";

const PREVIEW_THRESHOLD_CHARS = 200;
const SHORT_PREVIEW_MAX = 120;
const LONG_PREVIEW_MAX = 240;
/** Body text matches `@<word>` for at-mention detection. Dot/dash allowed
 *  inside an alias, matching the regex in mention_extractor.rs. */
const MENTION_RE = /@([a-z0-9][a-z0-9_.-]*)/gi;

export interface AtomCardProps {
  event: TimelineEvent;
  /** Optional click handler — defaults to local expand toggle. Pass to
   *  override (e.g. /people clicks an atom → drill into atom file). */
  onClick?: (ev: TimelineEvent) => void;
  /** When true, show the full body inline regardless of length. Used by
   *  /threads mini-timeline expanded view. Default false (preview). */
  alwaysExpanded?: boolean;
  /** When true (default) and viewport < 768px, a tap opens the
   *  AtomBottomSheet instead of toggling inline expand. Desktop is
   *  unaffected. Pass false to force the legacy inline-expand path on
   *  every viewport (e.g. inside /threads expanded thread view, where
   *  we want each atom fully readable in place). */
  bottomSheetOnMobile?: boolean;
}

export function AtomCard({
  event,
  onClick,
  alwaysExpanded = false,
  bottomSheetOnMobile = true,
}: AtomCardProps) {
  const [expanded, setExpanded] = useState(alwaysExpanded);
  const [sheetOpen, setSheetOpen] = useState(false);
  const body = event.body ?? "";
  const isLong = body.length > PREVIEW_THRESHOLD_CHARS;
  const preview = body.length > 0
    ? body.split("\n").find((l) => l.trim().length > 0) ?? ""
    : event.kind || "(no body)";
  const truncated = preview.length > SHORT_PREVIEW_MAX
    ? preview.slice(0, SHORT_PREVIEW_MAX) + "…"
    : preview;
  const longPreview = body.length > LONG_PREVIEW_MAX
    ? body.slice(0, LONG_PREVIEW_MAX) + "…"
    : body;
  const vendor = vendorFor(event.source);
  const mentions = extractMentions(body);
  const isMentionCard = mentions.length > 0;
  const time = formatRelativeTime(event.ts);
  const handleClick = () => {
    if (onClick) {
      onClick(event);
      return;
    }
    // Mobile path: dispatch the bottom sheet instead of toggling inline
    // expand. Skipped when alwaysExpanded (the parent already shows the
    // full body) or when the caller opted out via bottomSheetOnMobile.
    if (bottomSheetOnMobile && !alwaysExpanded && isMobileViewport()) {
      setSheetOpen(true);
      return;
    }
    if (!isLong) setExpanded((v) => !v);
  };
  return (
    <>
    <article
      data-testid={`atom-card-${event.id}`}
      data-mention={isMentionCard ? "true" : "false"}
      data-vendor={vendor.display}
      onClick={handleClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      }}
      style={{
        borderLeftWidth: isMentionCard ? 4 : 1,
        borderLeftColor: isMentionCard ? "var(--ti-orange-500)" : "rgb(231 229 228)",
      }}
      className="cursor-pointer rounded-md border border-stone-200 bg-white p-3 transition-shadow hover:shadow-sm dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="flex items-start gap-3">
        <Avatar alias={event.actor || "?"} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="font-semibold text-stone-900 dark:text-stone-100">
              {event.actor || "?"}
            </span>
            <span
              aria-hidden
              data-testid={`vendor-dot-${vendor.display}`}
              style={{ backgroundColor: vendor.color }}
              className="inline-block h-2 w-2 shrink-0 rounded-full"
            />
            <span className="text-stone-500 dark:text-stone-400">{vendor.display}</span>
            <span className="text-stone-400 dark:text-stone-500">·</span>
            <time
              dateTime={event.ts}
              title={event.ts}
              className="font-mono text-[11px] text-stone-500 dark:text-stone-400"
            >
              {time}
            </time>
            {isMentionCard && (
              <span
                data-testid={`mention-chip-${event.id}`}
                className="ml-auto rounded bg-[var(--ti-orange-50)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--ti-orange-700)]"
              >
                @{mentions[0]}
              </span>
            )}
          </div>
          <p
            className="mt-2 text-[13px] leading-snug text-stone-800 dark:text-stone-200"
            data-testid={`atom-card-preview-${event.id}`}
          >
            {expanded && !isLong ? body : truncated}
          </p>
          {expanded && isLong && (
            <p
              data-testid={`atom-card-long-preview-${event.id}`}
              className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-stone-800 dark:text-stone-200"
            >
              {longPreview}
            </p>
          )}
          {isLong && (
            <button
              type="button"
              data-testid={`atom-card-toggle-${event.id}`}
              onClick={(e) => {
                e.stopPropagation();
                setExpanded((v) => !v);
              }}
              className="mt-2 inline-flex items-center gap-1 rounded text-[11px] font-medium text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {expanded ? "Collapse" : "Read full"}
            </button>
          )}
          {event.concepts && event.concepts.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {event.concepts.slice(0, 5).map((c) => (
                <span
                  key={c}
                  className="rounded bg-stone-100 px-1.5 py-0.5 font-mono text-[10px] text-stone-600 dark:bg-stone-800 dark:text-stone-300"
                >
                  #{c}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </article>
    {sheetOpen && (
      <AtomBottomSheet event={event} onClose={() => setSheetOpen(false)} />
    )}
    </>
  );
}

function extractMentions(body: string): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}
