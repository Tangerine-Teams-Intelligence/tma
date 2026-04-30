/**
 * v1.16 Wave 3 Agent C1 — Magic Moment Step 4.
 *
 * Confirmation. Click "进入 Tangerine →" → router push to /feed +
 * close the magic moment (parent flips welcomed=true).
 *
 * v1.17.5 — chrome diet: dropped the giant 🎉 emoji + "设置完成" headline
 * (consultant-flavor) and condensed `<TeamMemoryHint/>` into a single
 * inline import-line block. The whole step is now a 1-screen
 * "what's listening / paste this / enter" card instead of a 4-section wall.
 */

import { TeamMemoryHint } from "./TeamMemoryHint";

interface Step4DoneProps {
  onEnter: () => void;
}

export function Step4Done({ onEnter }: Step4DoneProps) {
  return (
    <section
      data-testid="magic-step4"
      role="dialog"
      aria-label="Tangerine onboarding step 4"
      className="flex h-full w-full flex-col items-center justify-center px-4 text-center md:px-6"
    >
      <h2
        data-testid="magic-step4-headline"
        className="max-w-xl text-[20px] font-semibold leading-tight text-stone-100 md:text-[24px]"
      >
        监听已开始.
      </h2>
      <p className="mt-3 max-w-md text-[13px] leading-relaxed text-stone-400">
        下一次开 Cursor / Claude Code 就有 capture.
      </p>
      <TeamMemoryHint />
      <button
        type="button"
        data-testid="magic-step4-enter"
        onClick={onEnter}
        className="mt-6 inline-flex items-center gap-2 rounded-md border border-[var(--ti-orange-500)]/50 bg-[var(--ti-orange-500)]/15 px-5 py-2.5 text-sm font-medium text-[var(--ti-orange-500)] transition-colors hover:bg-[var(--ti-orange-500)]/25"
      >
        进入 Tangerine →
      </button>
    </section>
  );
}
