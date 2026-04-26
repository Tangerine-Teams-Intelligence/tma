import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Layers, FolderKanban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { canvasListProjects } from "@/lib/tauri";
import { CanvasView } from "@/components/canvas/CanvasView";
import { AgiPeer } from "@/components/canvas/AgiPeer";
import { AgiStickyAffordances } from "@/components/canvas/AgiStickyAffordances";

/**
 * /canvas — v1.8 Phase 4-B canvas surface entry point.
 *
 * Two modes, gated by the `:project` route param:
 *
 *   /canvas              → list of project canvases the user has on disk.
 *   /canvas/:project     → render <CanvasView project={slug} />.
 *
 * The on-disk shape is `~/.tangerine-memory/canvas/<project>/<topic>.md`;
 * `<CanvasView/>` owns sticky notes + threading + pan/zoom. AGI peer
 * behaviors land on top via sibling P4-C — Phase 4-B builds the inert
 * surface and P4-A's ambient observer + P4-C's heartbeat compose AGI
 * participation.
 */
export default function CanvasRoute() {
  const { project } = useParams();

  if (project) {
    // v1.8 Phase 4-C — overlay AGI peer behaviors on top of P4-B's CanvasView
    // without modifying it. AgiPeer = top-right presence chip; the
    // affordances component portals into each rendered sticky to add the
    // 🍊 dot + propose-lock button.
    return (
      <div className="relative flex h-full flex-col">
        <CanvasView project={project} />
        <AgiPeer project={project} />
        <AgiStickyAffordances project={project} />
      </div>
    );
  }
  return <CanvasIndex />;
}

function CanvasIndex() {
  const [projects, setProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancel = false;
    void canvasListProjects().then((p) => {
      if (cancel) return;
      setProjects(p);
      setLoading(false);
    });
    return () => {
      cancel = true;
    };
  }, []);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /canvas</span>
        <span className="ml-auto">
          {projects.length} canvas{projects.length === 1 ? "" : "es"}
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="mb-6 flex items-center gap-3">
          <Layers size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">Canvas</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Canvas
            </h1>
            <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
              Per-project ideation surface. Sticky notes you and your team throw,
              with Tangerine joining as a peer.
            </p>
          </div>
        </header>

        {loading ? (
          <p className="font-mono text-[12px] text-stone-500 dark:text-stone-400">
            Loading canvases…
          </p>
        ) : projects.length === 0 ? (
          <EmptyIndex />
        ) : (
          <section>
            <p className="ti-section-label mb-3">Project canvases</p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {projects.map((slug) => (
                <li key={slug}>
                  <Link
                    to={`/canvas/${encodeURIComponent(slug)}`}
                    className="group block rounded-md border border-stone-200 bg-white p-4 transition-colors hover:border-[var(--ti-orange-300)] hover:bg-[var(--ti-orange-50)] dark:border-stone-800 dark:bg-stone-900 dark:hover:border-[var(--ti-orange-500)] dark:hover:bg-stone-800"
                    data-testid={`canvas-project-card-${slug}`}
                  >
                    <div className="flex items-start gap-3">
                      <FolderKanban
                        size={16}
                        className="mt-0.5 text-stone-400 group-hover:text-[var(--ti-orange-700)] dark:text-stone-500 dark:group-hover:text-[var(--ti-orange-500)]"
                      />
                      <div>
                        <p className="font-mono text-[13px] text-stone-900 dark:text-stone-100">
                          {slug}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] text-stone-400 dark:text-stone-500">
                          /canvas/{slug}
                        </p>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

function EmptyIndex() {
  return (
    <section
      data-testid="canvas-index-empty"
      className="rounded-md border border-dashed border-stone-300 bg-stone-100/40 p-8 text-center dark:border-stone-700 dark:bg-stone-900/40"
    >
      <h2 className="font-display text-xl tracking-tight text-stone-900 dark:text-stone-100">
        No canvases yet.
      </h2>
      <p className="mt-3 max-w-prose text-[13px] leading-relaxed text-stone-600 dark:text-stone-400">
        Each canvas is per-project. Pick a project and open its canvas — sticky
        notes you and your team throw show up here, with Tangerine as a peer.
      </p>
      <div className="mt-5 flex items-center justify-center gap-2">
        <Link to="/projects">
          <Button variant="outline" size="sm">
            Browse projects
          </Button>
        </Link>
      </div>
      <p className="mt-4 font-mono text-[11px] text-stone-500 dark:text-stone-400">
        Open a project, then come back here — its canvas slug will appear.
      </p>
    </section>
  );
}
