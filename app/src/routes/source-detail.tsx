import { useParams, Navigate, Link } from "react-router-dom";
import { ArrowLeft, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findSource, type SourceId, SOURCES } from "@/lib/sources";
import DiscordSourceRoute from "@/routes/sources/discord";
import EmailSourceRoute from "@/routes/sources/email";
import VoiceNotesSourceRoute from "@/routes/sources/voice-notes";
// v1.8 Phase 2-C — Notion / Loom / Zoom real-wire setup pages.
import NotionSourceRoute from "@/routes/sources/notion";
import LoomSourceRoute from "@/routes/sources/loom";
import ZoomSourceRoute from "@/routes/sources/zoom";
// v1.8 Phase 2-B — Slack + Calendar writeback pages.
import SlackSourceRoute from "@/routes/sources/slack";
import CalendarSourceRoute from "@/routes/sources/calendar";
// v1.8 Phase 2-A — GitHub + Linear writeback pages.
import GithubSourceRoute from "@/routes/sources/github";
import LinearSourceRoute from "@/routes/sources/linear";

/**
 * /sources/:id — dispatch.
 *
 * Sources with a real config surface get rendered inline; everything else
 * lands on a "Coming v1.x" placeholder. v1.8 Phase 2-C added Notion / Loom /
 * Zoom; v1.8 Phase 2-D wires Email + Voice notes alongside the existing
 * Discord page.
 */
export default function SourceDetailRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/memory" replace />;

  const ids = SOURCES.map((s) => s.id) as string[];
  if (!ids.includes(id)) return <Navigate to="/memory" replace />;

  const def = findSource(id as SourceId);

  if (def.id === "discord") {
    return <DiscordSourceRoute />;
  }
  if (def.id === "notion") {
    return <NotionSourceRoute />;
  }
  if (def.id === "loom") {
    return <LoomSourceRoute />;
  }
  if (def.id === "zoom") {
    return <ZoomSourceRoute />;
  }
  if (def.id === "email") {
    return <EmailSourceRoute />;
  }
  if (def.id === "voice-notes") {
    return <VoiceNotesSourceRoute />;
  }
  if (def.id === "slack") {
    return <SlackSourceRoute />;
  }
  if (def.id === "cal") {
    return <CalendarSourceRoute />;
  }
  if (def.id === "github") {
    return <GithubSourceRoute />;
  }
  if (def.id === "linear") {
    return <LinearSourceRoute />;
  }

  return <ComingSourcePage id={def.id} />;
}

function ComingSourcePage({ id }: { id: SourceId }) {
  const def = findSource(id);
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
          <p className="ti-section-label">Source</p>
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
        <p className="ti-section-label">What this connects to</p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          {def.longBlurb}
        </p>
        <p className="mt-4 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          Writes to: {def.produces}
        </p>
      </section>

      <section className="mt-4 rounded-md border border-stone-200 p-6 dark:border-stone-800">
        <p className="ti-section-label">Why we don't run an LLM</p>
        <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
          Sources are read-only. They turn your team's work into markdown memory in your
          memory dir. The AI tools you already pay for (Claude Pro / ChatGPT / Cursor) read
          that memory through Sinks (browser extension, MCP server). Tangerine is the layer
          between — never the LLM, never the chat UI.
        </p>
      </section>

      {/* === wave 7 === v1.9.3 honesty pass: replaced "Not yet shippable
          in v1.5" hardcoded footer with status-aware copy. */}
      <div className="mt-6 flex items-center justify-between">
        <SourceStatusFooter status={def.status} comingIn={def.comingIn} />
        <Link to="/memory">
          <Button variant="outline" size="sm">
            Back to memory
          </Button>
        </Link>
      </div>
    </div>
  );
}

// === wave 7 ===
function SourceStatusFooter({
  status,
  comingIn,
}: {
  status: "shipped" | "beta" | "coming";
  comingIn?: string;
}) {
  if (status === "shipped") {
    return (
      <p className="flex items-center gap-1 font-mono text-[11px] text-emerald-600 dark:text-emerald-400">
        Available now — see setup steps above.
      </p>
    );
  }
  if (status === "beta") {
    return (
      <p className="flex items-center gap-1 font-mono text-[11px] text-amber-600 dark:text-amber-400">
        <AlertCircle size={11} /> Beta. Stable expected {comingIn ?? "v1.10"}.
      </p>
    );
  }
  return (
    <p className="flex items-center gap-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
      <AlertCircle size={11} /> Coming {comingIn ?? "in a future release"}.
    </p>
  );
}
// === end wave 7 ===
