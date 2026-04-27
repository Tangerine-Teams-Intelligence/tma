import { Users } from "lucide-react";
import { SocialGraph } from "@/components/graphs/SocialGraph";

/**
 * v2.0-beta.1 — /people/social route. Per V2_0_SPEC §2.3.
 *
 * Wraps `<SocialGraph />` in the standard route chrome.
 */
export default function SocialGraphRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /people/social</span>
      </header>

      <div className="mx-auto max-w-7xl px-8 py-8">
        <header className="mb-6 flex items-center gap-3">
          <Users size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">People</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Social graph
            </h1>
            <p className="mt-1 text-[12px] text-stone-500 dark:text-stone-400">
              Mention frequency over the last 30 days, decay-weighted at
              7-day half-life. Edge thickness = strength of co-mention.
              Click a node to open that person.
            </p>
          </div>
        </header>

        <section aria-label="Social graph">
          <SocialGraph />
        </section>

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          Scans every atom body for @mentions + co-occurrence. Capped at
          500 atoms per render so first paint stays under 500ms.
        </p>
      </div>
    </div>
  );
}
