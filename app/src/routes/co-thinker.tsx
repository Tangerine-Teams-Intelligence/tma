import { Brain } from "lucide-react";

/**
 * /co-thinker — Phase 3 placeholder.
 *
 * The real Co-thinker is Tangerine's persistent AGI brain, exposed as a
 * markdown doc you can read to see what your AI is watching, thinking, and
 * planning. Phase 3 wires the underlying agent + write path; Phase 1 ships
 * the route + sidebar entry so users have somewhere to land.
 */
export default function CoThinkerRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /co-thinker</span>
        <span className="ml-auto text-[var(--ti-orange-500)]">Coming v1.8 Phase 3</span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="mb-6 flex items-center gap-3">
          <Brain size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">Co-thinker</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Co-thinker
            </h1>
            <p className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)]">
              Coming in Phase 3
            </p>
          </div>
        </header>

        <section className="rounded-md border border-dashed border-stone-300 p-6 dark:border-stone-700">
          <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-300">
            Tangerine's persistent AGI brain — a markdown doc you can read to
            see what your AI is watching, thinking, and planning.
          </p>
        </section>
      </div>
    </div>
  );
}
