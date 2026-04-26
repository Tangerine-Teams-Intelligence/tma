import { useParams, Navigate, Link } from "react-router-dom";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findSink, type SinkId, SINKS } from "@/lib/sinks";

/**
 * /sinks/:id — every sink in v1.5 is "Coming v1.6+". Page exists so users
 * see what we're building and what shape the integration will take.
 */
export default function SinkDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/memory" replace />;

  const ids = SINKS.map((s) => s.id) as string[];
  if (!ids.includes(id)) return <Navigate to="/memory" replace />;

  const def = findSink(id as SinkId);
  const Icon = def.icon;

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <div className="mb-6">
        <Link
          to="/memory"
          className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
        >
          <ArrowLeft size={12} /> /memory
        </Link>
      </div>

      <div className="flex items-center gap-4">
        <div
          className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800"
          style={{ background: "var(--ti-paper-200)", color: "var(--ti-ink-500)" }}
        >
          <Icon size={20} />
        </div>
        <div>
          <p className="ti-section-label">Sink</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            {def.title}
          </h1>
          {def.comingIn && (
            <p className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)]">
              Coming {def.comingIn}
            </p>
          )}
        </div>
      </div>

      <section className="mt-8 rounded-md border border-stone-200 p-6 dark:border-stone-800">
        <p className="ti-section-label">What this does</p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          {def.longBlurb}
        </p>
        <p className="mt-4 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Surfaces as: {def.produces}
        </p>
      </section>

      <section className="mt-4 rounded-md border border-stone-200 p-6 dark:border-stone-800">
        <p className="ti-section-label">Why a Sink, not an LLM</p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          Tangerine never holds a model. Sinks just hand the right slices of your team
          memory to the model you already use. That keeps the bytes in your dir, the
          subscription on the model vendor, and the edge cases on us.
        </p>
      </section>

      <div className="mt-6 flex items-center justify-between">
        <p className="flex items-center gap-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          <AlertCircle size={11} /> Not yet shippable in v1.5.
        </p>
        <Link to="/memory">
          <Button variant="outline" size="sm">
            Back to memory
          </Button>
        </Link>
      </div>
    </div>
  );
}
