import { Link } from "react-router-dom";
import { ArrowLeft, Inbox as InboxIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * /inbox — placeholder for v1.5.
 *
 * v1.7+: when Tangerine wants to write back to your tools (Linear comments,
 * Slack thread replies, GitHub PR notes), the proposed change appears here
 * and waits for your approval before any external API call. v1.5 only
 * reads — Sources are read-only, so /inbox stays empty.
 */
export default function InboxRoute() {
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
        <div className="flex h-12 w-12 items-center justify-center rounded-md border border-stone-200 dark:border-stone-800">
          <InboxIcon size={20} className="text-stone-500" />
        </div>
        <div>
          <p className="ti-section-label">Inbox</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            Pending writes
          </h1>
          <p className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)]">
            Coming v1.7
          </p>
        </div>
      </div>

      <section className="mt-8 rounded-md border border-stone-200 p-6 dark:border-stone-800">
        <p className="ti-section-label">What lands here</p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          When Tangerine wants to write back to one of your tools — a Linear comment, a
          Slack thread reply, a GitHub PR note — the proposed change shows up here for your
          approval before any external API call.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          v1.5 only reads. Sources are strictly read-only — nothing leaves your machine
          unless you wire a Sink yourself. /inbox stays empty until v1.7.
        </p>
      </section>

      <div className="mt-6 flex items-center justify-end">
        <Link to="/memory">
          <Button variant="outline" size="sm">
            Back to memory
          </Button>
        </Link>
      </div>
    </div>
  );
}
