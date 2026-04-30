/**
 * v1.16 Wave 3 Agent C1 — Magic Moment Step 1.
 *
 * 全屏单句 + ↓ prompt. ~10s. 用户按 ↓ / Enter / Space 进 Step 2.
 *
 * 不接 ESC 监听 (parent MagicMoment 统一处理 ESC → close).
 * 不持有任何 store state — 纯 presentational.
 */

interface Step1WelcomeProps {
  onAdvance: () => void;
  onSkip: () => void;
}

export function Step1Welcome({ onAdvance, onSkip }: Step1WelcomeProps) {
  return (
    <section
      data-testid="magic-step1"
      role="dialog"
      aria-label="Tangerine onboarding step 1"
      className="flex h-full w-full flex-col items-center justify-center px-6 text-center"
    >
      <h1
        data-testid="magic-step1-headline"
        // v1.17.5 — tightened from "Tangerine 自动记住你团队跟 AI 说的所有对话"
        // (consultant-flavor) to a flat statement of what the app does.
        // 24px on mobile, 32px tablet, 40px desktop.
        className="max-w-3xl text-[24px] font-semibold leading-tight text-stone-100 sm:text-[32px] md:text-[40px]"
      >
        Tangerine 自动记住你团队
        <br />
        跟 AI 说的所有对话.
      </h1>
      <p className="mt-6 max-w-md text-[13px] leading-relaxed text-stone-400">
        本地读 Cursor / Claude Code 的对话 log,
        <br />
        不上传任何东西.
      </p>
      <p className="mt-6 text-[11px] uppercase tracking-wider text-stone-500">
        ↓ press to continue · ESC to skip
      </p>
      {/* Click target also advances — useful for users who don't read
          the keyboard hint. */}
      <button
        type="button"
        data-testid="magic-step1-advance"
        onClick={onAdvance}
        aria-label="Continue to sample captures"
        className="mt-8 inline-flex items-center gap-2 rounded-md border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-500)]/10 px-5 py-2 text-sm text-[var(--ti-orange-500)] transition-colors hover:bg-[var(--ti-orange-500)]/20"
      >
        ↓ 继续
      </button>
      <button
        type="button"
        data-testid="magic-step1-skip"
        onClick={onSkip}
        className="mt-5 text-[11px] text-stone-500 underline-offset-2 hover:underline"
      >
        Skip
      </button>
    </section>
  );
}
