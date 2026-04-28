// === wave 4-D i18n ===
// === wave 5-α ===
// === wave 8 === Polish pass — hero header + heartbeat for /today.
// === wave 9 === — Brain visualization hero on /today (positioning).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Calendar, Inbox } from "lucide-react";
import {
  readBrief,
  readTimelineToday,
  markAtomViewed,
  markAtomAcked,
  type BriefData,
  type TimelineSlice,
  type TangerineNote,
} from "@/lib/views";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import { DailyBriefCard } from "@/components/DailyBriefCard";
import { TimelineEvent } from "@/components/TimelineEvent";
import { EmptyState } from "@/components/EmptyState";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
// === wave 8 === — hero needs the brain status so the heartbeat dot can
// be live without a separate route. `coThinkerStatus()` is the same
// command the HomeStrip uses; cheap to call once on mount + every 30s.
import { coThinkerStatus, type CoThinkerStatus } from "@/lib/tauri";
// === v2.0-alpha.2 workflow graph ===
// Per V2_0_SPEC §1.1 — the graph is the head pillar of the home dashboard.
// `/today` swaps its chronological event list for `<WorkflowGraph />` as
// the main content, keeping the daily brief + activity as small secondary
// cards. The chronological list reachable via /this-week is unchanged.
import { WorkflowGraph } from "@/components/graphs/WorkflowGraph";
// === end v2.0-alpha.2 workflow graph ===
// === wave 9 === — brain visualization hero, vendor logo row for empty
// state, and AtomCard for recent activity. These swap in the upper half
// of /today so the page opens with a positioning anchor (the AGI
// brain) instead of a list of timestamps.
import { BrainVizHero, BrainVizEmpty } from "@/components/BrainVizHero";
import { VendorLogoRow } from "@/components/VendorLogoRow";
import { AtomCard } from "@/components/AtomCard";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";

/**
 * /today — default landing surface for the Chief of Staff UX.
 *
 * Layout (center pane only — sidebar + activity rail come from AppShell):
 *
 *   <TangerineNotes>            (Hook 5 — Stage 1 = empty, Stage 2 fills)
 *   Today · Friday Apr 25
 *   <DailyBriefCard>            (collapsible markdown brief)
 *   ─────────
 *   <chronological events>      (clickable; cursor.atoms_viewed updates)
 *   ─────────
 *   Now <time>                  (clock footer)
 *
 * Reads:
 *   • read_brief(today)         → daily brief markdown
 *   • read_timeline_today(today)→ chronological event list
 *
 * Writes (cursor):
 *   • mark_atom_viewed when an event row is clicked (drill-down)
 *   • mark_atom_acked when "Mark read" on the brief
 */
export default function TodayRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const today = todayIso();
  const currentUser = useStore((s) => s.ui.currentUser);
  // === wave 8 === — agiParticipation gates the brain-status fetch + the
  // hero pulse. Pulled here so the hero stays consistent with HomeStrip
  // (master switch off → no green pulse, no observation count).
  const agiParticipation = useStore((s) => s.ui.agiParticipation);
  const [brief, setBrief] = useState<BriefData | null>(null);
  const [slice, setSlice] = useState<TimelineSlice | null>(null);
  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [briefAcked, setBriefAcked] = useState(false);
  const [now, setNow] = useState(() => new Date().toLocaleTimeString());
  // === wave 8 === — co-thinker brain status for the hero pulse.
  const [brainStatus, setBrainStatus] = useState<CoThinkerStatus | null>(null);
  // === wave 9 === — track which AI tools are installed so the brain
  // particle ring can light up the right vendor colors. Refreshed once
  // on mount; the sidebar's loadAITools call already polls this on
  // focus, so we don't need a second poller here.
  const [installedTools, setInstalledTools] = useState<AIToolStatus[]>([]);

  useEffect(() => {
    let cancel = false;
    const refresh = () => {
      void readBrief(today).then((b) => {
        if (!cancel) setBrief(b);
      });
      void readTimelineToday(today).then((s) => {
        if (!cancel) {
          setSlice(s);
          // Stage 2 hook: notes per route. Stage 1 always [].
          setNotes(s.notes ?? []);
        }
      });
    };
    refresh();
    // AppShell dispatches MEMORY_REFRESHED_EVENT after the first-launch
    // sample-seed so the timeline + brief surface re-read the just-written
    // files immediately, no page reload needed.
    const onRefreshed = () => refresh();
    if (typeof window !== "undefined") {
      window.addEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
      }
    };
  }, [today]);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date().toLocaleTimeString()), 60_000);
    return () => clearInterval(id);
  }, []);

  // === wave 9 === — load AI tools once for the brain particle ring.
  useEffect(() => {
    let cancel = false;
    void loadAITools().then((t) => {
      if (!cancel) setInstalledTools(t);
    });
    return () => {
      cancel = true;
    };
  }, []);

  // === wave 8 === — hydrate brain status for the hero pulse. Polls every
  // 30s like HomeStrip so the "X observations" hero number stays fresh.
  // No-op when AGI participation is off — the master switch unmounts
  // anything that depends on the AGI being live.
  useEffect(() => {
    if (!agiParticipation) {
      setBrainStatus(null);
      return;
    }
    let cancel = false;
    const fetchStatus = async () => {
      try {
        const s = await coThinkerStatus();
        if (!cancel) setBrainStatus(s);
      } catch {
        // Bridge unavailable (vitest / browser dev) — leave whatever we
        // had before in place so the hero stays stable.
      }
    };
    void fetchStatus();
    const id = window.setInterval(fetchStatus, 30_000);
    return () => {
      cancel = true;
      window.clearInterval(id);
    };
  }, [agiParticipation]);

  // === wave 8 === — derived hero numbers. Atom count comes from the
  // timeline slice (events seen today), brain observation count from
  // status. Both have safe fallbacks when the daemon hasn't fired.
  const heroNumbers = useMemo(() => {
    const atomsToday = slice?.events.length ?? 0;
    const observations = brainStatus?.observations_today ?? 0;
    const lastBeat = brainStatus?.last_heartbeat_at ?? null;
    const isAlive =
      agiParticipation && lastBeat !== null &&
      Date.now() - new Date(lastBeat).getTime() < 10 * 60 * 1000;
    return { atomsToday, observations, isAlive };
  }, [slice, brainStatus, agiParticipation]);

  // === wave 9 === — derive brain state for the hero composition.
  // - empty: no atoms today and no installed tools yet (first run)
  // - alive: heartbeat in last 10 min
  // - idle:  has atoms but no recent heartbeat
  const brainState: "empty" | "alive" | "idle" = useMemo(() => {
    const installedCount = installedTools.filter(
      (t) => t.status === "installed",
    ).length;
    if (heroNumbers.atomsToday === 0 && installedCount === 0) return "empty";
    if (heroNumbers.isAlive) return "alive";
    return "idle";
  }, [heroNumbers, installedTools]);

  // === wave 9 === — vendors that are "active" today (the particles
  // that drift inward). For now we conservatively map this to "all
  // installed tools" since the daemon doesn't yet emit per-vendor atom
  // counts. When v3.0 ships per-source telemetry, swap this for
  // `brainStatus.vendors_recently_active`.
  const activeVendors = useMemo(
    () =>
      installedTools
        .filter((t) => t.status === "installed")
        .map((t) => t.id),
    [installedTools],
  );

  // === wave 9 === — the cross-vendor empty-state vendor row. Lights
  // up logos that have at least one installed parser; greys out the
  // rest. Same source-of-truth as activeVendors.
  const awakeVendors = activeVendors;

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  const onMarkBriefRead = () => {
    if (briefAcked) return;
    setBriefAcked(true);
    // The brief atom id format mirrors `Event::id` for kind=brief. We
    // synthesize the same shape from the date so the cursor tracks acks
    // even when the daemon hasn't tagged the file with a stable atom id
    // yet (Stage 1 brief generator writes only the markdown).
    const briefAtomId = synthesizeBriefAtomId(today);
    void markAtomAcked(currentUser, briefAtomId);
  };

  return (
    // === wave 8 === — `ti-hero-bg` adds a subtle warm gradient backdrop so
    // /today no longer looks like Notion's blank canvas. The gradient is
    // cheap enough that we apply it to the route container; it scrolls
    // with the content and degrades gracefully when reduced-motion is on.
    <div className="ti-hero-bg">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50/60 px-6 font-mono text-[11px] text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/60 dark:text-stone-400">
        <span>~ /today</span>
        <span className="ml-auto">
          {t("today.now")} <span className="text-stone-700 dark:text-stone-300">{now}</span>
        </span>
      </header>

      <div className="mx-auto max-w-7xl px-8 py-8">
        <TangerineNotes notes={notes} route="today" />

        {/* === wave 8 === — hero header. Display serif, bigger than the
            prior 3xl, with co-located hero numbers (atoms today + brain
            observations) so /today opens with a real visual anchor
            instead of a row of icons. */}
        {/* === wave 9 === — flex layout pairs the textual hero (left)
            with the brain visualization (right) on wide screens, stacking
            on narrow. The brain is the dominant visual anchor; the
            heading "Today" preserves the prior smoke-test contract. */}
        <header
          data-testid="today-hero"
          className="mb-10 animate-ti-rise"
        >
          <div className="flex flex-col items-start gap-8 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0 flex-1">
              <p className="ti-section-label flex items-center gap-2">
                <Calendar size={14} className="text-[var(--ti-orange-500)]" />
                <span>{t("today.title")}</span>
                {heroNumbers.isAlive && (
                  <span className="flex items-center gap-1.5 text-[var(--ti-green-500)]">
                    <span aria-hidden className="ti-alive-dot" />
                    <span className="font-mono text-[10px] uppercase tracking-wider">live</span>
                  </span>
                )}
              </p>
              <h1 className="mt-2 text-display-lg text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]">
                {prettyDate(today)}
              </h1>
              <div
                data-testid="today-hero-numbers"
                className="mt-4 flex flex-wrap items-baseline gap-x-8 gap-y-2 font-mono text-[11px] uppercase tracking-wider text-[var(--ti-ink-500)]"
              >
                <span className="flex items-baseline gap-2">
                  <span className="text-display-md text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]">
                    {heroNumbers.atomsToday}
                  </span>
                  <span>atoms today</span>
                </span>
                {agiParticipation && brainStatus && (
                  <span className="flex items-baseline gap-2">
                    <span className="text-display-md text-[var(--ti-blue-700)] dark:text-[var(--ti-blue-500)]">
                      {heroNumbers.observations}
                    </span>
                    <span>watched by co-thinker</span>
                  </span>
                )}
                <span className="flex items-baseline gap-2">
                  <span className="text-display-md text-[var(--ti-ink-700)] dark:text-[var(--ti-ink-300)]">
                    {activeVendors.length}
                  </span>
                  <span>AI tools active</span>
                </span>
              </div>
              {brainState === "empty" && (
                <div
                  className="mt-6"
                  data-testid="today-empty-vendor-row"
                >
                  <p className="mb-3 text-[12px] leading-relaxed text-[var(--ti-ink-600)] dark:text-[var(--ti-ink-500)]">
                    {t("today.brainAsleep", {
                      defaultValue:
                        "Your team's AGI is sleeping. Connect at least one AI tool to wake it up.",
                    })}
                  </p>
                  <VendorLogoRow awakeVendors={awakeVendors} />
                </div>
              )}
            </div>
            {/* === wave 9 === — the brain orb + particle ring. Empty
                state renders a dim grey orb with "?" placeholders; alive
                / idle states use the full vendor-color particle ring. */}
            <div className="shrink-0 self-center">
              {brainState === "empty" ? (
                <BrainVizEmpty />
              ) : (
                <BrainVizHero
                  state={brainState}
                  activeVendors={activeVendors}
                  atomsToday={heroNumbers.atomsToday}
                />
              )}
            </div>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
          <section aria-label={t("today.workflowAria")}>
            <p className="ti-section-label">{t("today.workflow")}</p>
            <div className="mt-3">
              <WorkflowGraph />
            </div>
          </section>

          <aside className="space-y-4" aria-label={t("today.summaryAria")}>
            <div>
              <p className="ti-section-label">{t("today.dailyBrief")}</p>
              <div className="mt-3">
                <DailyBriefCard
                  date={today}
                  markdown={brief?.markdown ?? null}
                  exists={brief?.exists ?? false}
                  acked={briefAcked}
                  onMarkRead={onMarkBriefRead}
                />
              </div>
            </div>

            <div>
              <p className="ti-section-label">{t("today.activity")}</p>
              {slice && slice.events.length === 0 ? (
                <div className="mt-3">
                  <EmptyState
                    icon={<Inbox size={28} />}
                    title={t("today.nothingToday")}
                    description={t("memory.noSourceCta")}
                    primaryAction={{
                      label: t("sidebar.sources"),
                      onClick: () => navigate("/sources/external"),
                    }}
                    testId="today-empty"
                  />
                </div>
              ) : (
                <ul className="mt-3 max-h-[420px] divide-y divide-stone-200 overflow-y-auto pr-1 dark:divide-stone-800">
                  {slice?.events.slice(0, 8).map((ev) => (
                    <li key={ev.id}>
                      <TimelineEvent event={ev} onView={onAtomViewed} compact />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>

        {/* === wave 9 === — Cross-vendor recent activity. Renders the
            latest 5 atoms as AtomCards so the user can scan the "which
            AI did what" picture in one column. Inferred vendor comes
            from each event's `source` (legacy) or null (we colorize the
            border anyway via the default fallback). */}
        {slice && slice.events.length > 0 && (
          <section
            data-testid="today-cross-vendor"
            className="mt-10"
            aria-label="Cross-vendor recent activity"
          >
            <p className="ti-section-label">
              {t("today.crossVendor", {
                defaultValue: "Cross-vendor activity",
              })}
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {slice.events.slice(0, 6).map((ev) => (
                <AtomCard
                  key={`atom-${ev.id}`}
                  vendor={inferVendorFromSource(ev.source, ev.actor)}
                  title={(ev.body ?? "").split("\n")[0] || ev.kind}
                  body={ev.body}
                  sourcePath={ev.file ?? null}
                  timestamp={ev.ts}
                  linkTo={ev.file ? `/memory/${ev.file}` : null}
                  onClick={() => onAtomViewed(ev.id)}
                  testId={`today-atom-${ev.id}`}
                />
              ))}
            </div>
          </section>
        )}

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          {t("today.footer")}
        </p>
      </div>
    </div>
  );
}

function todayIso(): string {
  // YYYY-MM-DD in local time so the brief lookup matches the daemon's
  // Local::now() write.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

// === wave 9 ===
/**
 * Best-effort vendor inference for AtomCards on /today.
 *
 * The TimelineEvent shape doesn't yet carry a `vendor` field — atoms
 * come from many sources (cursor, claude code, discord, github, etc.)
 * and the existing `source` string is the only signal. We look at both
 * `source` and `actor` for keywords matching our known vendor ids; if
 * nothing matches we return null and the card falls back to the
 * default-grey vendor color. This is a placeholder until v3.0 adds
 * per-atom vendor metadata to the timeline.
 */
function inferVendorFromSource(
  source: string,
  actor: string,
): string | null {
  const haystack = `${source ?? ""} ${actor ?? ""}`.toLowerCase();
  const candidates = [
    "cursor",
    "claude-code",
    "claude_code",
    "claude.ai",
    "claude",
    "chatgpt",
    "gpt",
    "codex",
    "windsurf",
    "gemini",
    "copilot",
    "ollama",
    "v0",
    "devin",
    "replit",
  ];
  for (const c of candidates) {
    if (haystack.includes(c)) {
      // Normalize aliases.
      if (c === "claude_code") return "claude-code";
      if (c === "claude.ai") return "claude-ai";
      if (c === "claude") return "claude-ai";
      if (c === "gpt") return "chatgpt";
      return c;
    }
  }
  return null;
}
// === end wave 9 ===

/** Synthesize a stable atom-id-shaped value for today's brief so cursor
 *  acks have something to write against even before the brief generator
 *  emits a real atom. Stage 2 will read these atoms_acked entries to
 *  learn the user's reading cadence. */
function synthesizeBriefAtomId(date: string): string {
  // 10 hex chars from the date string — deterministic so re-acks land
  // on the same id.
  let h = 0;
  for (const c of `brief|${date}`) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  const hex = h.toString(16).padStart(10, "0").slice(0, 10);
  return `evt-${date}-${hex}`;
}
