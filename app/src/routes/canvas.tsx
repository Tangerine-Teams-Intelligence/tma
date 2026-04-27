// === wave 4-D i18n ===
// === wave 5-α ===
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Layers, FolderKanban } from "lucide-react";
import { canvasListProjects } from "@/lib/tauri";
import { CanvasView } from "@/components/canvas/CanvasView";
import { AgiPeer } from "@/components/canvas/AgiPeer";
import { AgiStickyAffordances } from "@/components/canvas/AgiStickyAffordances";
import { Skeleton } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/EmptyState";
import { ErrorState } from "@/components/ErrorState";

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
  const { t } = useTranslation();
  const [projects, setProjects] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    canvasListProjects()
      .then((p) => {
        if (cancel) return;
        setProjects(p);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not list canvases.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
        <span>~ /canvas</span>
        <span className="ml-auto">
          {projects.length === 1
            ? t("canvas.countOne")
            : t("canvas.countOther", { count: projects.length })}
        </span>
      </header>

      <div className="mx-auto max-w-3xl px-8 py-10">
        <header className="mb-6 flex items-center gap-3">
          <Layers size={20} className="text-stone-500" />
          <div>
            <p className="ti-section-label">{t("canvas.title")}</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              {t("canvas.title")}
            </h1>
            <p className="mt-1 max-w-prose text-[12px] leading-relaxed text-stone-500 dark:text-stone-400">
              {t("canvas.subtitle")}
            </p>
          </div>
        </header>

        {loading ? (
          <ul
            className="grid grid-cols-1 gap-3 sm:grid-cols-2"
            aria-busy="true"
            data-testid="canvas-index-loading"
          >
            {Array.from({ length: 4 }).map((_, i) => (
              <li
                key={i}
                className="rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
              >
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="mt-2 h-3 w-1/3" />
              </li>
            ))}
          </ul>
        ) : error ? (
          <ErrorState
            error={error}
            title={t("canvas.errorList")}
            onRetry={() => setRefreshKey((k) => k + 1)}
            retryLabel={t("buttons.retry")}
            testId="canvas-error"
          />
        ) : projects.length === 0 ? (
          <EmptyIndex />
        ) : (
          <section>
            <p className="ti-section-label mb-3">{t("canvas.indexHeading")}</p>
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <EmptyState
      icon={<FolderKanban size={32} />}
      title={t("canvas.emptyTitle")}
      description={t("canvas.emptyBody")}
      primaryAction={{
        label: t("canvas.browseProjects"),
        onClick: () => navigate("/projects"),
      }}
      testId="canvas-index-empty"
    />
  );
}
// === end wave 5-α ===
