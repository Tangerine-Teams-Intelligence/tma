import { Diamond } from "lucide-react";
import { DecisionLineageTree } from "@/components/graphs/DecisionLineageTree";

/**
 * v2.0-beta.1 — /decisions/lineage route. Per V2_0_SPEC §2.2.
 *
 * Wraps `<DecisionLineageTree />` in the standard route chrome (header +
 * section label) used by `/today`. The graph itself owns its own loading
 * + empty + error states; this file is just framing.
 */
export default function DecisionLineageRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /decisions/lineage</span>
      </header>

      <div className="mx-auto max-w-7xl px-8 py-8">
        <header className="mb-6 flex items-center gap-3">
          <Diamond size={20} className="text-[var(--ti-orange-500,#CC5500)]" />
          <div>
            <p className="ti-section-label">Decisions</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Lineage
            </h1>
            <p className="mt-1 text-[12px] text-stone-500 dark:text-stone-400">
              Source meetings + threads → decision atom → writeback targets
              (PR, Linear, Slack). Click any node to drill in.
            </p>
          </div>
        </header>

        <section aria-label="Decision lineage tree">
          <DecisionLineageTree />
        </section>

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          Reads `source_provenance:` + `writeback:` frontmatter on every
          decision atom. Missing fields render as a lone diamond — that's
          fine.
        </p>
      </div>
    </div>
  );
}
