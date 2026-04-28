// === wave 4-D i18n ===
// === wave 5-α ===
// === wave 8 === Polish pass — hero header + heartbeat for /today.
// === wave 9 === — Brain visualization hero on /today (positioning).
// === wave 14 === — DRASTIC UX SIMPLIFICATION: chat-first hero.
// === wave 18 === — Conversational onboarding takes over the hero
//   while in setup mode (setupWizardChannelReady === false).
// === wave 20 === — Dashboard rewrite. CEO ratified vision: /today is
//   the home dashboard with a prominent search hero PLUS widget cards
//   (Linear-style), not chat-only. Search stays as the hero, but is now
//   followed by 4 widget cards: Recent decisions / Today's activity /
//   Team brain status / Connected tools. Setup mode still hides every-
//   thing under OnboardingChat. The Wave-9 BrainVizHero is removed —
//   the dashboard widgets carry the cross-vendor signal now, the giant
//   orb double-anchored the page.
import { Component, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Calendar, Send, Loader2 } from "lucide-react";
import { useStore } from "@/lib/store";
import { TangerineNotes } from "@/components/TangerineNotes";
import {
  readTimelineToday,
  type TimelineSlice,
  type TangerineNote,
} from "@/lib/views";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
import {
  coThinkerDispatch,
  type LlmResponse,
  activityRecent,
} from "@/lib/tauri";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";
import ReactMarkdown from "react-markdown";
import { OnboardingChat } from "@/components/OnboardingChat";
// === wave 20 === — dashboard widget cards. Each owns its own data
// fetch + loading / error / empty state.
import { DashboardWidget } from "@/components/dashboard/DashboardWidget";
import { RecentDecisionsWidget } from "@/components/dashboard/RecentDecisionsWidget";
import { TodaysActivityWidget } from "@/components/dashboard/TodaysActivityWidget";
import { BrainStatusWidget } from "@/components/dashboard/BrainStatusWidget";
import { ConnectedToolsWidget } from "@/components/dashboard/ConnectedToolsWidget";

/**
 * /today — the home dashboard.
 *
 * === wave 20 === layout (top to bottom):
 *
 *   ┌──────────────────────────────────────────────┐
 *   │ Stat strip: date · atoms · watched · tools  │
 *   ├──────────────────────────────────────────────┤
 *   │ Hero: "Today" eyebrow + chat input + Send    │
 *   ├──────────────────────────────────────────────┤
 *   │ Widget 1 — Recent decisions (3)              │
 *   │ Widget 2 — Today's activity (10)             │
 *   │ Widget 3 — Team brain status                 │
 *   │ Widget 4 — Connected tools                   │
 *   └──────────────────────────────────────────────┘
 *
 * Setup mode (`setupWizardChannelReady === false`): the stat strip
 * disappears, the hero + every widget is hidden, and OnboardingChat
 * takes the full content area. Once setup completes, the dashboard
 * appears in place.
 */
export default function TodayRoute() {
  const { t } = useTranslation();
  const today = todayIso();
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const setupWizardChannelReady = useStore(
    (s) => s.ui.setupWizardChannelReady,
  );
  const onboardingMode = useStore((s) => s.ui.onboardingMode);
  const inSetupMode =
    onboardingMode === "chat" && !setupWizardChannelReady;

  // === wave 20 === — stat strip data. Pulled in parallel on mount.
  const [statAtoms, setStatAtoms] = useState<number>(0);
  const [statTools, setStatTools] = useState<number>(0);
  const [statWatched, setStatWatched] = useState<number>(0);
  const [statError, setStatError] = useState<boolean>(false);

  const [notes, setNotes] = useState<TangerineNote[]>([]);
  const [now, setNow] = useState(() => new Date().toLocaleTimeString());

  // === wave 14 === chat hero state — kept verbatim except for the
  // surrounding layout.
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<LlmResponse | null>(null);
  const [dispatchState, setDispatchState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Hydrate notes (route-bound TangerineNotes) on mount + on memory
  // refresh events from AppShell.
  useEffect(() => {
    let cancel = false;
    const refresh = () => {
      void readTimelineToday(today).then((s: TimelineSlice) => {
        if (!cancel) setNotes(s.notes ?? []);
      });
    };
    refresh();
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
    const id = setInterval(
      () => setNow(new Date().toLocaleTimeString()),
      60_000,
    );
    return () => clearInterval(id);
  }, []);

  // === wave 20 === — stat strip parallel fetch. Each call has a soft
  // mock fallback (vitest / browser dev returns []) so this resolves
  // even outside Tauri.
  useEffect(() => {
    if (inSetupMode) return; // Setup mode hides the strip.
    let cancelled = false;
    void (async () => {
      try {
        const [activity, tools] = await Promise.all([
          activityRecent({ limit: 100 }),
          loadAITools(),
        ]);
        if (cancelled) return;
        setStatAtoms(activity.length);
        const installed = tools.filter(
          (x: AIToolStatus) => x.status === "installed",
        );
        setStatTools(installed.length);
        // "Watched" = unique authors observed in the recent buffer.
        const authors = new Set<string>();
        for (const ev of activity) {
          if (ev.author) authors.add(ev.author);
        }
        setStatWatched(authors.size);
        setStatError(false);
      } catch {
        if (!cancelled) setStatError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inSetupMode]);

  // === wave 14 === — submit the chat hero prompt.
  // === wave 22 === — accept an optional `override` string so the sample
  // query chips can submit a fresh value without waiting for React state
  // to flush. Falls back to the live `prompt` state for the textarea
  // path so existing keyboard / Send-button behavior is untouched.
  const submitPrompt = async (override?: string) => {
    const text = (override ?? prompt).trim();
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

  const onTextareaKeyDown = (
    e: React.KeyboardEvent<HTMLTextAreaElement>,
  ) => {
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

  // === wave 18 === — setup-mode early return. OnboardingChat owns the
  // full content area; widgets / hero / stat strip are not rendered at
  // all so React doesn't waste a fetch cycle on data the user can't see.
  if (inSetupMode) {
    return (
      <div className="ti-hero-bg">
        <header
          className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50/60 px-6 font-mono text-[11px] text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/60 dark:text-stone-400"
          data-testid="today-header"
        >
          <span>~ /today</span>
          <span className="ml-auto">
            {t("today.now")}{" "}
            <span className="text-stone-700 dark:text-stone-300">{now}</span>
          </span>
        </header>
        <div className="mx-auto max-w-3xl px-8 py-8" data-testid="today-setup">
          {/* Smoke-test contract (`findByText(/^Today$/i)`) — keep an
              h1-shaped element with the literal "Today" text reachable
              even in setup mode so routes.smoke.test.tsx stays green. */}
          <p className="ti-section-label flex items-center gap-2">
            <Calendar size={14} className="text-[var(--ti-orange-500)]" />
            <span>{t("today.title")}</span>
          </p>
          <OnboardingChat />
        </div>
      </div>
    );
  }

  return (
    <div className="ti-hero-bg">
      <header
        className="ti-no-select flex h-9 items-center gap-2 border-b border-stone-200 bg-stone-50/60 px-6 font-mono text-[11px] text-stone-500 backdrop-blur-sm dark:border-stone-800 dark:bg-stone-950/60 dark:text-stone-400"
        data-testid="today-header"
      >
        <span>~ /today</span>
        <span className="ml-auto">
          {t("today.now")}{" "}
          <span className="text-stone-700 dark:text-stone-300">{now}</span>
        </span>
      </header>

      <div className="mx-auto max-w-4xl px-8 py-8">
        <TangerineNotes notes={notes} route="today" />

        {/* === wave 20 === — Stat strip. Compact one-row summary at the
            top: today's date · atoms today · authors watched · tools
            active. Lives above the search hero so the user sees the
            shape of "what happened today" before deciding whether to
            search or scroll. */}
        <div
          data-testid="today-stat-strip"
          className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          <span data-testid="today-stat-date">
            Today, {prettyDate(today)}
          </span>
          <span aria-hidden className="text-[var(--ti-ink-400)]">
            ·
          </span>
          <span data-testid="today-stat-atoms">
            {/* === wave 20 wrap-needed === */}
            {statAtoms} atoms
          </span>
          <span aria-hidden className="text-[var(--ti-ink-400)]">
            ·
          </span>
          <span data-testid="today-stat-watched">
            {/* === wave 20 wrap-needed === */}
            {statWatched} watched
          </span>
          <span aria-hidden className="text-[var(--ti-ink-400)]">
            ·
          </span>
          <span data-testid="today-stat-tools">
            {/* === wave 20 wrap-needed === */}
            {statTools} tools active
          </span>
          {statError && (
            <span
              data-testid="today-stat-error"
              className="text-rose-500"
              title="Couldn't reach the activity bus"
            >
              {/* === wave 20 wrap-needed === */}
              · stats unavailable
            </span>
          )}
        </div>

        {/* === wave 20 === — Hero search. Slimmer than Wave 14: the H1
            is now an eyebrow + a single-line "Today" anchor (smoke-test
            contract preserved), and the textarea is the focal point.
            BrainVizHero is gone — see file-level comment. */}
        <header
          data-testid="today-hero"
          className="mb-8 animate-ti-rise"
        >
          <p className="ti-section-label flex items-center gap-2">
            <Calendar size={14} className="text-[var(--ti-orange-500)]" />
            <span>{t("today.title")}</span>
          </p>
          <h1
            data-testid="today-hero-h1"
            className="mt-2 font-display text-[28px] leading-tight tracking-tight text-[var(--ti-ink-900)]"
          >
            {/* === wave 20 wrap-needed === */}
            Search team memory or ask anything.
          </h1>

          <div
            data-testid="today-chat-input"
            className="mt-4 flex items-end gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 shadow-sm dark:border-stone-800 dark:bg-stone-900"
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
              placeholder="Search team memory or ask anything…"
              className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[var(--ti-ink-900)] placeholder:text-[var(--ti-ink-500)] focus:outline-none dark:text-[var(--ti-ink-900)]"
              aria-label="Search team memory or ask anything"
            />
            <button
              type="button"
              onClick={() => void submitPrompt()}
              disabled={
                dispatchState === "loading" || prompt.trim().length === 0
              }
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

          {/* === wave 22 === — sample query chips. Render only when the
              user hasn't typed anything yet AND there's no response on
              screen — once they engage the chips would feel patronising.
              Click fills the textarea + auto-submits so the round-trip
              feels instant; this is the "first 60 sec wow" hook. */}
          {prompt.trim().length === 0 && !response && dispatchState !== "loading" && (
            <div
              data-testid="today-sample-queries"
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--ti-ink-500)]">
                {t("coachmark.samples.label")}
              </span>
              {[
                { id: "decided", labelKey: "coachmark.samples.decided" as const },
                { id: "personRecent", labelKey: "coachmark.samples.personRecent" as const },
                { id: "lastWeek", labelKey: "coachmark.samples.lastWeek" as const },
              ].map((q) => (
                <button
                  key={q.id}
                  type="button"
                  data-testid={`today-sample-query-${q.id}`}
                  onClick={() => {
                    const text = t(q.labelKey);
                    setPrompt(text);
                    // Pass the text directly so we don't race React's
                    // pending setPrompt — submitPrompt's `override`
                    // parameter wins over the stale `prompt` state.
                    void submitPrompt(text);
                  }}
                  className="inline-flex items-center rounded-full border border-[var(--ti-orange-300)] bg-[var(--ti-orange-50)] px-2.5 py-1 text-[11px] text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-100)] dark:border-stone-600 dark:bg-stone-800 dark:text-[var(--ti-orange-500)] dark:hover:bg-stone-700"
                >
                  {t(q.labelKey)}
                </button>
              ))}
            </div>
          )}
          {/* === end wave 22 === */}

          {response && dispatchState !== "loading" && (
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
          {dispatchState === "error" && dispatchError && (
            <div
              data-testid="today-chat-error"
              className="mt-4 rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
            >
              {/* === wave 14 wrap-needed === */}
              <p className="font-medium">Couldn't reach an AI tool.</p>
              <p className="mt-1 font-mono text-[11px]">{dispatchError}</p>
            </div>
          )}
        </header>

        {/* === wave 20 === — Widget stack. Single column, full-width
            within the page padding. Order top → bottom: decisions,
            activity, brain, tools — most actionable first. */}
        <div
          data-testid="today-widget-stack"
          className="space-y-4"
        >
          <ErrorBoundaryShell label="Recent decisions">
            <RecentDecisionsWidget />
          </ErrorBoundaryShell>
          <ErrorBoundaryShell label="Today's activity">
            <TodaysActivityWidget />
          </ErrorBoundaryShell>
          <ErrorBoundaryShell label="Team brain status">
            <BrainStatusWidget />
          </ErrorBoundaryShell>
          <ErrorBoundaryShell label="Connected tools">
            <ConnectedToolsWidget />
          </ErrorBoundaryShell>
        </div>

        <p className="mt-12 text-center font-mono text-[10px] text-stone-400 dark:text-stone-500">
          {t("today.footer")}
        </p>
      </div>
    </div>
  );
}

// === wave 20 ===
/**
 * Per-widget render guard. We keep this tiny + local — the global
 * ErrorBoundary covers the whole route, but a widget that crashes during
 * render (e.g. a bad fetch result shape) shouldn't take down the dashboard.
 * One render-throw → inline message via DashboardWidget's errorMessage
 * shape, the other three widgets keep mounting.
 */
interface ErrorBoundaryShellProps {
  label: string;
  children: ReactNode;
}
interface ErrorBoundaryShellState {
  message: string | null;
}
class ErrorBoundaryShell extends Component<
  ErrorBoundaryShellProps,
  ErrorBoundaryShellState
> {
  state: ErrorBoundaryShellState = { message: null };
  static getDerivedStateFromError(err: unknown): ErrorBoundaryShellState {
    return { message: err instanceof Error ? err.message : String(err) };
  }
  render() {
    if (this.state.message !== null) {
      return (
        <DashboardWidget
          testId={`today-widget-fallback-${slug(this.props.label)}`}
          title={this.props.label}
          errorMessage={this.state.message}
        >
          {null}
        </DashboardWidget>
      );
    }
    return this.props.children;
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
// === end wave 20 ===

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
    month: "short",
    day: "numeric",
  });
}
