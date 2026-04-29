/**
 * v1.16 Wave 3 Agent C2 — animated empty-state placeholder.
 *
 * Renders 5 hardcoded sample TimelineEvents inside an AtomCard list so a
 * user who just installed Tangerine sees "this is what your captures will
 * look like" instead of a dead "No captures yet" page during the 5s gap
 * before the first real capture lands. The first card carries a subtle
 * pulse so the surface feels alive, not frozen.
 *
 * The variant prop swaps the headline copy per route (/feed /threads
 * /people) without changing the sample list — the visual lesson is the
 * same, only the contextual pitch differs.
 *
 * R6/R7/R8 honesty: every sample has `sample: true` on the underlying
 * TimelineEvent so any downstream surface that scans for `sample === true`
 * (e.g. the demo-mode banner) keeps the contract intact even though we
 * never feed these into store state — they live only inside this view.
 *
 * Coordination: Wave 3 C1 owns MagicMoment.tsx in the same folder. We
 * deliberately don't import C1 — the 5 samples are co-located here so
 * the file ships independently.
 */

import type { TimelineEvent } from "@/lib/views";
import { AtomCard } from "@/components/feed/AtomCard";

export type EmptyStateVariant = "feed" | "threads" | "people";

export interface EmptyStateAnimationProps {
  variant: EmptyStateVariant;
}

/** 5 sample atoms, hardcoded to match Wave 3 C1 step 2. Timestamps are
 *  expressed as offsets from `now` at render time so relative-time strings
 *  ("30s ago" / "2m ago") stay accurate across long-lived test runs. */
function buildSampleEvents(now: number): TimelineEvent[] {
  const minus = (ms: number) => new Date(now - ms).toISOString();
  return [
    {
      id: "sample-1",
      ts: minus(30 * 1000),
      source: "cursor",
      actor: "daizhe",
      actors: ["daizhe"],
      kind: "capture",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Designing PCB Tier-2 architecture...",
      lifecycle: null,
      sample: true,
      confidence: 1.0,
      concepts: ["pcb", "architecture"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "sample-2",
      ts: minus(2 * 60 * 1000),
      source: "claude-code",
      actor: "daizhe",
      actors: ["daizhe"],
      kind: "capture",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Drafting investor pitch deck v2...",
      lifecycle: null,
      sample: true,
      confidence: 1.0,
      concepts: ["pitch", "deck"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "sample-3",
      ts: minus(5 * 60 * 1000),
      source: "slack",
      actor: "hongyu",
      actors: ["hongyu"],
      kind: "message",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "@daizhe pricing decision needed by Friday",
      lifecycle: null,
      sample: true,
      confidence: 1.0,
      concepts: ["pricing"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "sample-4",
      ts: minus(12 * 60 * 1000),
      source: "github",
      actor: "daizhe",
      actors: ["daizhe"],
      kind: "merge",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Merged PR #42 — feed virtualization",
      lifecycle: null,
      sample: true,
      confidence: 1.0,
      concepts: ["pr", "merge"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "sample-5",
      ts: minus(30 * 60 * 1000),
      source: "email",
      actor: "daizhe",
      actors: ["daizhe"],
      kind: "email",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Re: Q2 board meeting agenda",
      lifecycle: null,
      sample: true,
      confidence: 1.0,
      concepts: ["board"],
      alternatives: [],
      source_count: 1,
    },
  ];
}

/** Variant copy. We keep the pitch tight — one short sentence + a hint
 *  that the cards below are illustrative. Bilingual ZH text mirrors the
 *  rest of the app's user-facing strings. */
const COPY: Record<EmptyStateVariant, { title: string; sub: string }> = {
  feed: {
    title: "你的 captures 5 秒内出现在这.",
    sub: "下面是示例 (5 sample atoms).",
  },
  threads: {
    title: "@mention 多的 atoms 自动 group 成 thread.",
    sub: "下面是示例.",
  },
  people: {
    title: "队友自动浮现.",
    sub: "下面是示例.",
  },
};

export function EmptyStateAnimation({ variant }: EmptyStateAnimationProps) {
  // Materialize timestamps relative to render time so the relative-time
  // strings inside each AtomCard read sensibly even on a long session.
  const samples = buildSampleEvents(Date.now());
  const copy = COPY[variant];
  return (
    <div
      data-testid={`empty-state-animation-${variant}`}
      data-variant={variant}
      className="mx-auto mt-2 max-w-3xl"
    >
      <header
        data-testid={`empty-state-animation-header-${variant}`}
        className="px-1 pb-3"
      >
        <p
          data-testid={`empty-state-animation-title-${variant}`}
          className="text-[14px] font-semibold text-stone-700 dark:text-stone-200"
        >
          {copy.title}
        </p>
        <p className="mt-1 text-[12px] text-stone-500 dark:text-stone-400">
          {copy.sub}
        </p>
      </header>
      <ol
        data-testid={`empty-state-animation-list-${variant}`}
        data-count={samples.length}
        className="space-y-2"
      >
        {samples.map((ev, idx) => {
          const isFirst = idx === 0;
          // Subtle pulse only on the first card so the page feels live
          // without flickering 5 cards at once. Tailwind's animate-pulse
          // is a 2s opacity loop — gentle, not distracting.
          const pulseClass = isFirst ? "animate-pulse" : "";
          return (
            <li
              key={ev.id}
              data-testid={`empty-state-sample-${ev.id}`}
              data-pulse={isFirst ? "true" : "false"}
              className={pulseClass}
            >
              <AtomCard event={ev} />
            </li>
          );
        })}
      </ol>
      <p
        data-testid={`empty-state-animation-cta-${variant}`}
        className="mt-4 px-1 font-mono text-[11px] text-stone-500 dark:text-stone-400"
      >
        如果 60 秒还没出现 → check Settings
      </p>
    </div>
  );
}
