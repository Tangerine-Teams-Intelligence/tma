/**
 * v1.16 Wave 3 Agent C1 — Magic Moment Step 2.
 *
 * 5 sample captures auto-scrub animation. 每张 atom 1.5s, 完成停在
 * "this is what your team's memory will look like" + "继续 →" button.
 *
 * Reuses `AtomCard` (Wave 2 B1) — no clones. The samples are 5
 * hardcoded `TimelineEvent`s, one per primary vendor (Cursor / Claude
 * Code / Slack / GitHub / Email), so the user sees the visual variety
 * the feed will actually deliver.
 */

import { useEffect, useState } from "react";
import { AtomCard } from "@/components/feed/AtomCard";
import type { TimelineEvent } from "@/lib/views";

interface Step2AnimationProps {
  onAdvance: () => void;
  onSkip: () => void;
}

// v1.17.5 — was 1500ms × 5 = 7.5s of forced waiting on every fresh install.
// Daizhe ("ux太差了") flagged the wait as friction. Trimmed to 500ms × 5 = 2.5s
// total — fast enough to feel like a flourish, slow enough that the eye still
// reads each card landing. Tests use fake timers so the timing is free to drop.
const SAMPLE_INTERVAL_MS = 500;

/** 5 hardcoded sample atoms. Static `ts` strings (Date.now-relative is
 *  intentionally avoided so the test snapshot is deterministic). The
 *  AtomCard's relative-time formatter just renders these as a recent
 *  human-readable string; the wall-clock value isn't load-bearing for
 *  the magic moment. */
function makeSamples(nowMs: number): TimelineEvent[] {
  const min = (n: number) => new Date(nowMs - n * 60_000).toISOString();
  return [
    {
      id: "magic-sample-1",
      ts: min(2),
      source: "cursor",
      actor: "you",
      actors: ["you"],
      kind: "capture",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "改 BOM 第 3 项. 决定用 0402 而不是 0603, 板厚 1.6mm 不变.",
      lifecycle: null,
      sample: false,
      confidence: 1.0,
      concepts: ["pcb", "bom"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "magic-sample-2",
      ts: min(7),
      source: "claude-code",
      actor: "you",
      actors: ["you"],
      kind: "decision",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Tier-2 PCB 厂客户, 不接 prototyping. anchor = 兴森/依顿/胜宏.",
      lifecycle: null,
      sample: false,
      confidence: 1.0,
      concepts: ["gtm"],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "magic-sample-3",
      ts: min(15),
      source: "slack",
      actor: "hongyu",
      actors: ["hongyu"],
      kind: "message",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "@you 看一下 nRF54L15 的 spec, 我觉得 PPG 那个引脚要换",
      lifecycle: null,
      sample: false,
      confidence: 1.0,
      concepts: [],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "magic-sample-4",
      ts: min(28),
      source: "github",
      actor: "you",
      actors: ["you"],
      kind: "commit",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "feat: wave3-c1 magic moment 4-step onboarding",
      lifecycle: null,
      sample: false,
      confidence: 1.0,
      concepts: [],
      alternatives: [],
      source_count: 1,
    },
    {
      id: "magic-sample-5",
      ts: min(42),
      source: "email",
      actor: "investor",
      actors: ["investor"],
      kind: "thread",
      refs: {},
      status: "open",
      file: null,
      line: null,
      body: "Re: SAFE terms — happy with $5M cap, can wire $80K next week.",
      lifecycle: null,
      sample: false,
      confidence: 1.0,
      concepts: ["fundraising"],
      alternatives: [],
      source_count: 1,
    },
  ];
}

export function Step2Animation({ onAdvance, onSkip }: Step2AnimationProps) {
  // Visible-up-to index. Starts at 0 (only first card visible) and
  // ticks up every SAMPLE_INTERVAL_MS until all 5 land. Once
  // `visibleCount === SAMPLES.length` we expose the "继续 →" button.
  const [visibleCount, setVisibleCount] = useState(1);
  const [done, setDone] = useState(false);
  const samples = makeSamples(Date.now());

  useEffect(() => {
    if (visibleCount >= samples.length) {
      setDone(true);
      return;
    }
    const t = setTimeout(() => {
      setVisibleCount((c) => c + 1);
    }, SAMPLE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [visibleCount, samples.length]);

  return (
    <section
      data-testid="magic-step2"
      role="dialog"
      aria-label="Tangerine onboarding step 2"
      className="flex h-full w-full flex-col items-center justify-center px-3 md:px-6"
    >
      <div
        data-testid="magic-step2-stack"
        data-visible-count={visibleCount}
        // v1.16 Wave 5 — full width on mobile so 5 atoms aren't squeezed
        // into a narrow center column; max-w-xl returns at md:.
        className="flex w-full flex-col-reverse gap-2 md:max-w-xl"
      >
        {samples.map((ev, i) => {
          const visible = i < visibleCount;
          return (
            <div
              key={ev.id}
              data-testid={`magic-sample-${ev.id}`}
              data-visible={visible ? "true" : "false"}
              style={{
                opacity: visible ? 1 : 0,
                transform: visible ? "translateY(0)" : "translateY(8px)",
                transition: "opacity 400ms ease, transform 400ms ease",
              }}
            >
              <AtomCard event={ev} />
            </div>
          );
        })}
      </div>
      {done ? (
        <div data-testid="magic-step2-done" className="mt-10 text-center">
          <p className="text-sm text-stone-300">
            this is what your team's memory will look like
          </p>
          <button
            type="button"
            data-testid="magic-step2-advance"
            onClick={onAdvance}
            className="mt-4 inline-flex items-center gap-2 rounded-md border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-500)]/10 px-4 py-2 text-sm text-[var(--ti-orange-500)] transition-colors hover:bg-[var(--ti-orange-500)]/20"
          >
            继续 →
          </button>
        </div>
      ) : (
        <p
          data-testid="magic-step2-progress"
          className="mt-10 font-mono text-[11px] tracking-wider text-stone-500"
        >
          {visibleCount} / {samples.length}
        </p>
      )}
      <button
        type="button"
        data-testid="magic-step2-skip"
        onClick={onSkip}
        className="mt-6 text-[11px] text-stone-500 underline-offset-2 hover:underline"
      >
        Skip
      </button>
    </section>
  );
}
