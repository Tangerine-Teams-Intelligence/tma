import { Layers } from "lucide-react";

/**
 * /canvas — Phase 4 placeholder.
 *
 * The real Canvas is a per-project ideation surface where the team's
 * Tangerine AGI participates as a peer alongside humans. Phase 4 wires the
 * underlying CRDT + AGI peer; Phase 1 ships the route + sidebar entry so
 * users can see what's coming.
 */
export default function CanvasRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /canvas</span>
        <span className="ml-auto text-[var(--ti-orange-500)]">Coming v1.8 Phase 4</span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="mb-6 flex items-center gap-3">
          <Layers size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">Canvas</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Canvas
            </h1>
            <p className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)]">
              Coming in Phase 4
            </p>
          </div>
        </header>

        <section className="rounded-md border border-dashed border-stone-300 p-6 dark:border-stone-700">
          <p className="text-sm leading-relaxed text-stone-700 dark:text-stone-300">
            Per-project ideation surface. Sticky notes you and your team throw,
            with Tangerine AGI participating as a peer.
          </p>
        </section>
      </div>
    </div>
  );
}
