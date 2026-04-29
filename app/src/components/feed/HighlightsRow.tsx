/**
 * v1.17 — Highlights row, the "Apple Photos Memories" of /feed.
 *
 * Auto-surfaces the 3-5 atoms most worth a glance. Pure heuristic, no
 * LLM (Wave 1 砍 the smart layer; this stays compatible with that
 * direction). Score components per atom:
 *
 *   +10 if the atom @-mentions the current user        (highest signal)
 *   +5  per other-actor @-mention                       (collab signal)
 *   +3  per concept tag overlap with another atom in   (cross-source signal,
 *       the same window from a *different* source       e.g. #pcb in CC + Slack)
 *   +2  if kind === "decision"                          (decision is dense info)
 *   +1  if last-24h                                    (recency tilt)
 *
 * Top 5 by score (score > 0) are rendered as a horizontal scrollable
 * row of compact cards above the timeline. The whole row is hidden
 * when no atom clears the threshold — empty rooms stay quiet.
 *
 * Rationale: Daizhe's v1.16 friction was "feed feels broken when
 * empty / I don't see the app helping me". Highlights is the
 * cheap pure-heuristic way to make Tangerine feel like it's
 * *organizing* without anything close to AI.
 */

import { useMemo } from "react";
import type { TimelineEvent } from "@/lib/views";
import { formatRelativeTime } from "@/lib/views";
import { vendorFor } from "./vendor";
import { Avatar } from "./Avatar";

const MENTION_RE = /@([a-z0-9][a-z0-9_.-]*)/gi;
const RECENT_24H_MS = 24 * 60 * 60 * 1000;
const MAX_HIGHLIGHTS = 5;
const MIN_SCORE = 1; // never surface a 0-score atom

interface HighlightsRowProps {
  events: TimelineEvent[];
  currentUser: string;
  onPick?: (atom: TimelineEvent) => void;
}

export function HighlightsRow({ events, currentUser, onPick }: HighlightsRowProps) {
  const top = useMemo(
    () => pickHighlights(events, currentUser),
    [events, currentUser],
  );
  if (top.length === 0) return null;
  return (
    <section
      data-testid="feed-highlights"
      data-count={top.length}
      aria-label="Highlights"
      className="mb-4"
    >
      <header className="mb-2 flex items-baseline gap-2">
        <h2 className="text-[12px] font-semibold uppercase tracking-wider text-stone-600 dark:text-stone-300">
          Highlights
        </h2>
        <span
          className="text-[10px] text-stone-400 dark:text-stone-500"
          title="Auto-picked: @you, cross-source topics, decisions, last 24h"
        >
          for you · auto-picked
        </span>
      </header>
      <ol
        data-testid="feed-highlights-row"
        className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2"
      >
        {top.map(({ event, score, reason }) => (
          <li key={event.id} className="shrink-0">
            <button
              type="button"
              onClick={() => onPick?.(event)}
              data-testid={`highlight-card-${event.id}`}
              data-score={score}
              data-reason={reason}
              className="flex w-72 flex-col gap-2 rounded-md border border-stone-200 bg-white p-3 text-left transition-shadow hover:shadow-sm dark:border-stone-800 dark:bg-stone-900"
            >
              <div className="flex items-center gap-2 text-[11px]">
                <Avatar alias={event.actor || "?"} size={20} />
                <span className="font-semibold text-stone-900 dark:text-stone-100">
                  {event.actor || "?"}
                </span>
                <span
                  aria-hidden
                  style={{ backgroundColor: vendorFor(event.source).color }}
                  className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
                />
                <span className="text-stone-500 dark:text-stone-400">
                  {vendorFor(event.source).display}
                </span>
                <span className="ml-auto font-mono text-[10px] text-stone-400 dark:text-stone-500">
                  {formatRelativeTime(event.ts)}
                </span>
              </div>
              <p className="line-clamp-2 text-[12px] leading-snug text-stone-800 dark:text-stone-200">
                {previewLine(event)}
              </p>
              <span
                data-testid={`highlight-reason-${event.id}`}
                className="text-[10px] text-[var(--ti-orange-700)]"
              >
                {humanReason(reason)}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface ScoredEvent {
  event: TimelineEvent;
  score: number;
  reason: string;
}

function pickHighlights(events: TimelineEvent[], currentUser: string): ScoredEvent[] {
  if (events.length === 0) return [];
  const me = currentUser.toLowerCase();
  const conceptCountBySource = countConceptsBySource(events);
  const out: ScoredEvent[] = [];
  for (const ev of events) {
    let score = 0;
    let reason = "";
    const body = ev.body ?? "";
    const mentions = extractMentions(body);
    if (mentions.includes(me)) {
      score += 10;
      reason = "mentions you";
    }
    if (mentions.length > 0 && reason === "") {
      score += Math.min(mentions.length, 3) * 5;
      reason = `mentions ${mentions[0]}`;
    }
    const ts = Date.parse(ev.ts || "");
    if (!Number.isNaN(ts) && Date.now() - ts < RECENT_24H_MS) {
      score += 1;
    }
    if (ev.kind === "decision") {
      score += 2;
      if (reason === "") reason = "decision";
    }
    // Cross-source signal — same concept tag appears under another source
    for (const c of ev.concepts ?? []) {
      const sourcesForConcept = conceptCountBySource.get(c);
      if (!sourcesForConcept) continue;
      const otherSources = [...sourcesForConcept].filter(
        (s) => s !== ev.source,
      );
      if (otherSources.length > 0) {
        score += 3;
        if (reason === "") reason = `#${c} across sources`;
        break;
      }
    }
    if (score >= MIN_SCORE) {
      out.push({ event: ev, score, reason: reason || "recent" });
    }
  }
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.event.ts || "").localeCompare(a.event.ts || "");
  });
  return out.slice(0, MAX_HIGHLIGHTS);
}

function countConceptsBySource(events: TimelineEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const ev of events) {
    for (const c of ev.concepts ?? []) {
      const set = out.get(c) ?? new Set<string>();
      set.add(ev.source || "");
      out.set(c, set);
    }
  }
  return out;
}

function extractMentions(body: string): string[] {
  if (!body) return [];
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    out.add(m[1].toLowerCase());
  }
  return [...out];
}

function previewLine(ev: TimelineEvent): string {
  const body = ev.body ?? "";
  if (body.length === 0) return ev.kind || "(no body)";
  return body.split("\n").find((l) => l.trim().length > 0) ?? body.slice(0, 80);
}

function humanReason(r: string): string {
  if (r === "mentions you") return "@you";
  if (r === "decision") return "decision";
  if (r === "recent") return "recent";
  return r;
}
