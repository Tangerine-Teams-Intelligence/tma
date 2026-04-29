/**
 * v1.16 Wave 3 Agent C1 — Magic Moment Step 4.
 *
 * Confirmation. Click "进入 Tangerine →" → router push to /feed +
 * close the magic moment (parent flips welcomed=true).
 */

interface Step4DoneProps {
  onEnter: () => void;
}

export function Step4Done({ onEnter }: Step4DoneProps) {
  return (
    <section
      data-testid="magic-step4"
      role="dialog"
      aria-label="Tangerine onboarding step 4"
      className="flex h-full w-full flex-col items-center justify-center px-6 text-center"
    >
      <div className="text-6xl" aria-hidden>
        🎉
      </div>
      <h2
        data-testid="magic-step4-headline"
        className="mt-6 max-w-xl text-3xl font-semibold text-stone-100"
      >
        设置完成
      </h2>
      <p className="mt-4 max-w-md text-sm leading-relaxed text-stone-400">
        Tangerine 现在监听你的 AI 工具.
        <br />第一个 capture 出现后会自动跳转 /feed.
      </p>
      <button
        type="button"
        data-testid="magic-step4-enter"
        onClick={onEnter}
        className="mt-10 inline-flex items-center gap-2 rounded-md border border-[var(--ti-orange-500)]/50 bg-[var(--ti-orange-500)]/15 px-5 py-2.5 text-sm font-medium text-[var(--ti-orange-500)] transition-colors hover:bg-[var(--ti-orange-500)]/25"
      >
        进入 Tangerine →
      </button>
    </section>
  );
}
