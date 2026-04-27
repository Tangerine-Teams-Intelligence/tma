import { FolderKanban } from "lucide-react";
import { ProjectTopology } from "@/components/graphs/ProjectTopology";

/**
 * v2.0-beta.1 — /projects/topology route. Per V2_0_SPEC §2.4.
 *
 * Wraps `<ProjectTopology />` in the standard route chrome.
 */
export default function ProjectTopologyRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /projects/topology</span>
      </header>

      <div className="mx-auto max-w-7xl px-8 py-8">
        <header className="mb-6 flex items-center gap-3">
          <FolderKanban size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">Projects</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Topology
            </h1>
            <p className="mt-1 text-[12px] text-stone-500 dark:text-stone-400">
              Roots at the top, dependents below. Status color: green
              active, red blocked, amber idle, gray done. Click a project
              to open it.
            </p>
          </div>
        </header>

        <section aria-label="Project topology">
          <ProjectTopology />
        </section>

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          Reads `team/projects/*.md` + `personal/&lt;user&gt;/projects/*.md`.
          Edges from `dependencies:` frontmatter.
        </p>
      </div>
    </div>
  );
}
