// === wave 4-D i18n ===
// === wave 5-α ===
// === wave 8 === Polish pass — hero header + heartbeat for /today.
// === wave 9 === — Brain visualization hero on /today (positioning).
// === wave 14 === — DRASTIC UX SIMPLIFICATION:
//   • /today landing leads with a ChatGPT-style search input (not the
//     200px brain orb). User has zero clear next action with the brain
//     orb hero — feels like an admin dashboard, not a work tool.
//   • Hero is now: H1 "Ask anything about your team" + multiline
//     textarea + orange Send button → calls coThinkerDispatch and renders
//     the response inline as a chat bubble.
//   • BrainVizHero is demoted to a small (compact) viz in the top-right
//     corner — kept as aesthetic / status anchor, not the primary CTA.
//   • Recent activity stays as AtomCards (now no vendor border-l per
//     wave-14 vendor-color removal).
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Calendar, Inbox, Send, Loader2 } from "lucide-react";
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
import { coThinkerStatus, coThinkerDispatch, type CoThinkerStatus, type LlmResponse } from "@/lib/tauri";
// === v2.0-alpha.2 workflow graph ===
// Per V2_0_SPEC §1.1 — the graph is the head pillar of the home dashboard.
// `/today` swaps its chronological event list for `<WorkflowGraph />` as
// the main content, keeping the daily brief + activity as small secondary
// cards. The chronological list reachable via /this-week is unchanged.
import { WorkflowGraph } from "@/components/graphs/WorkflowGraph";
// === end v2.0-alpha.2 workflow graph ===
// === wave 9 === — brain visualization hero, vendor logo row for empty
// state, and AtomCard for recent activity.
// === wave 14 === — BrainVizHero is rendered in compact mode as a
// secondary anchor (not the main hero). VendorLogoRow stays for the
// empty-state hint when no AI tools are wired up yet.
import { BrainVizHero, BrainVizEmpty } from "@/components/BrainVizHero";
import { VendorLogoRow } from "@/components/VendorLogoRow";
import { AtomCard } from "@/components/AtomCard";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";
// === wave 14 === — light markdown renderer for the chat response
// bubble. We don't reuse MarkdownView (designed for memory files with
// frontmatter + provenance footer); ReactMarkdown directly is simpler
// here.
import ReactMarkdown from "react-markdown";
// === wave 18 === — conversational onboarding agent. Replaces the
// Wave 14 chat input (in setup mode only) so first-run users describe
// what they want in natural language instead of being walked through a
// form wizard. Once `setupWizardChannelReady` flips, the OnboardingChat
// surface returns null and the existing /today chat input takes over
// for general queries — same DOM slot, mode-switched contents.
import { OnboardingChat } from "@/components/OnboardingChat";

/**
 * /today — default landing surface for the Chief of Staff UX.
 *
 * === wave 14 === layout (top to bottom):
 *
 *   [BrainVizHero compact, top-right] [TangerineNotes]
 *   H1 "What's on your team's mind?"
 *   <textarea> (autoresize) + orange Send button
 *   <chat bubble inline result> (after submit)
 *   ─────────
 *   Recent team notes (AtomCards, last 3-5)
 *   ─────────
 *   Workflow + Brief + Activity rail (existing v2 layout, demoted)
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
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  // === wave 18 === — drives the setup-mode-vs-general-mode swap on the
  // shared /today chat input slot. Setup mode renders OnboardingChat;
  // general mode renders the Wave 14 ChatGPT-style input below.
  const setupWizardChannelReady = useStore(
    (s) => s.ui.setupWizardChannelReady,
  );
  const onboardingMode = useStore((s) => s.ui.onboardingMode);
  const inSetupMode =
    onboardingMode === "chat" && !setupWizardChannelReady;
  // === end wave 18 ===
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

  // === wave 14 === — chat-style hero state. `prompt` is the textarea
  // input, `response` is the latest LlmResponse rendered as a chat
  // bubble below the input. `dispatchState` is "idle" | "loading" |
  // "error" — drives the spinner and the inline error block.
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<LlmResponse | null>(null);
  const [dispatchState, setDispatchState] = useState<"idle" | "loading" | "error">("idle");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

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
  const brainState: "empty" | "alive" | "idle" = useMemo(() => {
    const installedCount = installedTools.filter(
      (t) => t.status === "installed",
    ).length;
    if (heroNumbers.atomsToday === 0 && installedCount === 0) return "empty";
    if (heroNumbers.isAlive) return "alive";
    return "idle";
  }, [heroNumbers, installedTools]);

  // === wave 9 === — vendors that are "active" today (the particles
  // that drift inward).
  const activeVendors = useMemo(
    () =>
      installedTools
        .filter((t) => t.status === "installed")
        .map((t) => t.id),
    [installedTools],
  );

  // === wave 9 === — the cross-vendor empty-state vendor row.
  const awakeVendors = activeVendors;

  const onAtomViewed = (atomId: string) => {
    void markAtomViewed(currentUser, atomId);
  };

  const onMarkBriefRead = () => {
    if (briefAcked) return;
    setBriefAcked(true);
    const briefAtomId = synthesizeBriefAtomId(today);
    void markAtomAcked(currentUser, briefAtomId);
  };

  // === wave 14 === — submit the chat hero prompt.
  const submitPrompt = async () => {
    const text = prompt.trim();
    if (!text || dispatchState === "loading") return;
    setDispatchState("loading");
    setDispatchError(null);
    setResponse(null);
    try {
      const resp = await coThinkerDispatch(
        {
          // === wave 14 wrap-needed ===
          system_prompt:
            "You are Tangerine, a team-memory assistant. Answer the user's question using the team's memory dir as your primary source. Be terse and concrete.",
          user_prompt: text,
        },
        primaryAITool ?? undefined,
      );
      setResponse(resp);
      setDispatchState("idle");
    } catch (e) {
      setDispatchError(String(e));
      setDispatchState("error");
    }
  };

  // === wave 14 === — Enter submits, Shift+Enter inserts newline.
  // Multi-line textarea grows on input (lib/utils not needed — manual
  // resize via scrollHeight to stay simple).
  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitPrompt();
    }
  };
  const onTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  };

  return (
    <div className="ti-hero-bg">
      <header className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50/60 px-6 font-mono text-[11px] text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/60 dark:text-stone-400">
        <span>~ /today</span>
        <span className="ml-auto">
          {t("today.now")} <span className="text-stone-700 dark:text-stone-300">{now}</span>
        </span>
      </header>

      <div className="mx-auto max-w-7xl px-8 py-8">
        <TangerineNotes notes={notes} route="today" />

        {/* === wave 14 === — ChatGPT-style hero. Big H1 + multiline
            textarea + orange Send button. Demoted brain viz floats at
            top-right as a small status anchor (not the primary CTA).
            The eyebrow "Today" + date keep the smoke-test contract
            (`findByText(/^Today$/i)`). */}
        <header
          data-testid="today-hero"
          className="mb-10 animate-ti-rise"
        >
          <div className="flex flex-col items-start gap-6 lg:flex-row lg:items-start lg:justify-between">
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
                <span className="ml-2 font-mono text-[10px] text-[var(--ti-ink-500)]">
                  {prettyDate(today)}
                </span>
              </p>
              {/* === wave 14 === — Hero H1. */}
              <h1
                data-testid="today-hero-h1"
                className="mt-3 font-display text-[44px] leading-tight tracking-tight text-[var(--ti-ink-900)] dark:text-[var(--ti-ink-900)]"
              >
                {/* === wave 14 wrap-needed === */}
                Ask anything about your team.
              </h1>
              <p className="mt-2 text-[13px] text-[var(--ti-ink-500)]">
                {/* === wave 14 wrap-needed === */}
                Tangerine searches every meeting, decision, and thread your
                team's AI tools have captured.
              </p>

              {/* === wave 18 === — single chat input slot. Setup mode
                  routes intents to onboarding_chat_turn; general mode
                  uses the Wave 14 coThinkerDispatch flow. Same visual
                  position; mode-switched contents. */}
              {inSetupMode ? (
                <div className="mt-5">
                  <OnboardingChat />
                </div>
              ) : (
              <div
                data-testid="today-chat-input"
                className="mt-5 flex items-end gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 shadow-sm dark:border-stone-800 dark:bg-stone-900"
              >
                <textarea
                  ref={textareaRef}
                  data-testid="today-chat-textarea"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={onTextareaKeyDown}
                  onInput={onTextareaInput}
                  rows={2}
                  /* === wave 14 wrap-needed === */
                  placeholder="Ask your team brain… e.g. 'What did we decide about pricing last week?'"
                  className="min-h-[52px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[var(--ti-ink-900)] placeholder:text-[var(--ti-ink-500)] focus:outline-none dark:text-[var(--ti-ink-900)]"
                  aria-label="Ask your team brain"
                />
                <button
                  type="button"
                  onClick={() => void submitPrompt()}
                  disabled={dispatchState === "loading" || prompt.trim().length === 0}
                  data-testid="today-chat-send"
                  className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--ti-orange-500)] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--ti-orange-600)] disabled:cursor-not-allowed disabled:bg-stone-300 dark:disabled:bg-stone-700"
                >
                  {dispatchState === "loading" ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      {/* === wave 14 wrap-needed === */}
                      <span>Thinking…</span>
                    </>
                  ) : (
                    <>
                      <Send size={14} />
                      {/* === wave 14 wrap-needed === */}
                      <span>Send</span>
                    </>
                  )}
                </button>
              </div>
              )}
              {/* === end wave 18 === */}

              {/* === wave 14 === — Inline result bubble.
                  === wave 18 === gated on !inSetupMode so the
                  OnboardingChat owns the bubble area while setup is
                  in progress. */}
              {!inSetupMode && response && dispatchState !== "loading" && (
                <div
                  data-testid="today-chat-response"
                  className="mt-4 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 dark:border-stone-800 dark:bg-stone-900/60"
                >
                  <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-[var(--ti-ink-500)]">
                    {/* === wave 14 wrap-needed === */}
                    <span>Tangerine answered via {response.tool_id}</span>
                    <span className="text-[var(--ti-ink-400)]">·</span>
                    <span>{response.latency_ms}ms</span>
                  </div>
                  <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[var(--ti-ink-900)] dark:prose-invert">
                    <ReactMarkdown>{response.text}</ReactMarkdown>
                  </div>
                </div>
              )}
              {!inSetupMode && dispatchState === "error" && dispatchError && (
                <div
                  data-testid="today-chat-error"
                  className="mt-4 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
                >
                  {/* === wave 14 wrap-needed === */}
                  <p className="font-medium">Couldn't reach an AI tool.</p>
                  <p className="mt-1 font-mono text-[11px]">{dispatchError}</p>
                  <p className="mt-2 text-[11px] text-rose-600 dark:text-rose-400">
                    {/* === wave 14 wrap-needed === */}
                    Connect at least one AI tool in the sidebar to enable team
                    search.
                  </p>
                </div>
              )}

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

            {/* === wave 14 === — Demoted compact brain viz. Lives
                top-right as a status anchor; doesn't dominate. The
                BrainVizHero contract is unchanged (still emits the
                wave-9 testids); only the size is reduced via the new
                `compact` prop. */}
            <div
              className="hidden shrink-0 self-start lg:block"
              data-testid="today-brain-viz-secondary"
            >
              {brainState === "empty" ? (
                <BrainVizEmpty />
              ) : (
                <BrainVizHero
                  state={brainState}
                  activeVendors={activeVendors}
                  atomsToday={heroNumbers.atomsToday}
                  compact
                />
              )}
            </div>
          </div>
        </header>

        {/* === wave 14 === — Recent team notes (renamed from "Cross-vendor
            activity"). User-language label per Wave 12 spec. Cards now
            render without vendor border-l (showVendorColor=false default). */}
        {slice && slice.events.length > 0 && (
          <section
            data-testid="today-recent-notes"
            className="mt-6"
            aria-label="Recent team notes"
          >
            <p className="ti-section-label">
              {/* === wave 14 wrap-needed === */}
              {t("today.recentNotes", {
                defaultValue: "Recent team notes",
              })}
            </p>
            <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {slice.events.slice(0, 5).map((ev) => (
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

        {/* Existing v2 workflow + brief + activity rail demoted below
            the new chat hero. Kept intact so /this-week + brief flows
            don't regress; just no longer the first thing users see. */}
        <div className="mt-10 grid grid-cols-1 gap-6 lg:grid-cols-[2fr_1fr]">
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
