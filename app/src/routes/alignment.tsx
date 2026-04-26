import { Link } from "react-router-dom";
import { ArrowLeft, Activity, Users, Disc, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * /alignment — placeholder for v1.6.
 *
 * v1.6: a full dashboard for the Tangerine north-star metric — the
 * "same-screen rate", i.e. the share of your team (and the AI tools they
 * use) that are operating from the same up-to-date team memory. The real
 * page will pull live coverage stats from the memory dir and per-source
 * connectors.
 *
 * v1.5.6 ships only the visual mock so users can see what the Chief-of-Staff
 * direction looks like without us actually wiring the underlying
 * computation. Numbers below are illustrative.
 */
export default function AlignmentRoute() {
  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      {/* Top "this is a preview" banner — bright orange so nobody confuses
          this with a working dashboard. */}
      <div className="ti-no-select border-b border-[var(--ti-orange-500)]/30 bg-[var(--ti-orange-50)] px-6 py-2 text-xs font-medium text-[var(--ti-orange-700)] dark:bg-stone-900 dark:text-[var(--ti-orange-500)]">
        Coming v1.6 — this is a preview. Live numbers wire up next sprint.
      </div>

      <div className="mx-auto max-w-5xl px-8 py-10">
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
            <Activity size={20} className="text-stone-500" />
          </div>
          <div>
            <p className="ti-section-label">Alignment</p>
            <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
              Same-screen rate
            </h1>
            <p className="mt-1 font-mono text-[11px] text-[var(--ti-orange-500)]">
              Coming v1.6
            </p>
          </div>
        </div>

        {/* Hero metric */}
        <section className="mt-8 rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
          <p className="ti-section-label">Team alignment</p>
          <div className="mt-3 flex items-baseline gap-4">
            <span className="font-display text-6xl tracking-tight text-stone-900 dark:text-stone-100">
              78%
            </span>
            <span className="font-mono text-xs text-stone-500 dark:text-stone-400">
              ↑ 12% this week · target 90%
            </span>
          </div>
          <div className="mt-4 h-2 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
            <div
              className="h-2 rounded bg-[var(--ti-orange-500)]"
              style={{ width: "78%" }}
            />
          </div>
          <p className="mt-3 text-xs text-stone-500 dark:text-stone-400">
            Share of your team (and the AI tools they use) currently operating
            from the same up-to-date team memory. v1.6 will compute this from
            real source coverage + sink read recency.
          </p>
        </section>

        {/* Per-member coverage bars */}
        <section className="mt-6 rounded-md border border-stone-200 bg-stone-50 p-6 dark:border-stone-800 dark:bg-stone-900">
          <div className="mb-4 flex items-center gap-2">
            <Users size={14} className="text-stone-500" />
            <p className="ti-section-label">Member coverage</p>
          </div>
          <div className="space-y-3">
            <MemberBar name="daizhe" pct={92} />
            <MemberBar name="hongyu" pct={84} />
            <MemberBar name="advisor" pct={61} />
            <MemberBar name="david" pct={75} />
          </div>
        </section>

        {/* Capture stats */}
        <section className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-4">
          <CaptureCard
            icon={<Disc size={14} />}
            label="Meetings captured"
            value="14"
            sub="last 7 days"
          />
          <CaptureCard
            icon={<FileText size={14} />}
            label="Decisions extracted"
            value="9"
            sub="last 7 days"
          />
          <CaptureCard
            icon={<Users size={14} />}
            label="Active members"
            value="4 / 5"
            sub="briefed yesterday"
          />
          <CaptureCard
            icon={<Activity size={14} />}
            label="AI tool reads"
            value="123"
            sub="from Claude / Cursor"
          />
        </section>

        <div className="mt-8 flex items-center justify-end">
          <Link to="/memory">
            <Button variant="outline" size="sm">
              Back to memory
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function MemberBar({ name, pct }: { name: string; pct: number }) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-stone-700 dark:text-stone-300">@{name}</span>
        <span className="font-mono text-stone-500 dark:text-stone-400">{pct}%</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded bg-stone-200 dark:bg-stone-800">
        <div
          className="h-1.5 rounded bg-[var(--ti-orange-500)]"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function CaptureCard({
  icon,
  label,
  value,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {icon}
        {label}
      </p>
      <p className="mt-2 font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        {value}
      </p>
      <p className="mt-1 text-[10px] text-stone-500 dark:text-stone-400">{sub}</p>
    </div>
  );
}
