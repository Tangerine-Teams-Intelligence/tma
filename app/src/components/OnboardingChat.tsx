// === wave 18 ===
/**
 * v1.10.4 — conversational onboarding agent.
 *
 * Replaces the form-based SetupWizard (Wave 11) as the default first-run
 * experience. Renders inline on /today as the primary chat input until
 * setup is "ready" (channelReady flag flips), at which point the same
 * /today input transparently switches to general-query mode (Wave 14).
 *
 * Coexistence with Wave 14:
 *   - One chat input on /today. Single mount point.
 *   - Setup mode = `setupWizardChannelReady === false` → routes intents
 *     to `onboarding_chat_turn` and renders the system primer above the
 *     input.
 *   - General mode = `setupWizardChannelReady === true` → uses the
 *     existing `coThinkerDispatch` flow (Wave 14, owned by the /today
 *     route itself). This component just stops rendering once setup
 *     is done.
 *
 * Fallback to the form wizard:
 *   - Cmd+K → "Set up LLM channel" still opens SetupWizard.tsx.
 *   - Settings → General → "Use form-based setup" link.
 *   - Typing "I want the form" / "show me the wizard" routes to the LLM
 *     which the system prompt already instructs to send the user there.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send, Sparkles } from "lucide-react";

import { onboardingChatTurn, type OnboardingChatTurn, type OnboardingAction } from "@/lib/tauri";
import {
  actionIcon,
  actionStatusColor,
  actionStatusLabel,
  actionTitle,
  completeFrontendAction,
} from "@/lib/onboarding-actions";
import { useStore } from "@/lib/store";
import { logEvent } from "@/lib/telemetry";

interface OnboardingChatProps {
  /** Optional callback for the parent route to close the chat once
   *  setupWizardChannelReady flips. Default: no-op. */
  onSetupComplete?: () => void;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  actions: OnboardingAction[];
  /** Timestamp ms — drives stable react keys when the same content is
   *  echoed back (e.g. retry). */
  ts: number;
}

/** Generate a stable per-fresh-install session id. We bind to
 *  `window.localStorage` so a hot reload doesn't spawn a new transcript;
 *  Cmd+K → "Restart setup chat" can wipe it later. */
function resolveSessionId(): string {
  if (typeof window === "undefined") return "ssr";
  try {
    const KEY = "tangerine.onboarding-chat.session-id";
    const existing = window.localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    window.localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    return `oc-${Date.now().toString(36)}`;
  }
}

export function OnboardingChat({ onSetupComplete }: OnboardingChatProps) {
  const { t } = useTranslation();
  const setupWizardChannelReady = useStore(
    (s) => s.ui.setupWizardChannelReady,
  );
  const setOnboardingChatStarted = useStore(
    (s) => s.ui.setOnboardingChatStarted,
  );
  const onboardingChatStarted = useStore(
    (s) => s.ui.onboardingChatStarted,
  );
  const onboardingMode = useStore((s) => s.ui.onboardingMode);
  const setSetupWizardOpen = useStore((s) => s.ui.setSetupWizardOpen);
  const primaryAITool = useStore((s) => s.ui.primaryAITool);
  const setSetupWizardChannelReady = useStore(
    (s) => s.ui.setSetupWizardChannelReady,
  );
  // === wave 1.13-A === — Solo/Team scope. The first prompt asks the user
  // which path they want; we skip team-roster setup entirely on solo, or
  // run the full chat-driven team setup otherwise. Persisted via
  // `ui.onboardingScope` so the answer survives cold launches.
  const onboardingScope = useStore((s) => s.ui.onboardingScope);
  const setOnboardingScope = useStore((s) => s.ui.setOnboardingScope);
  // === end wave 1.13-A ===

  const sessionId = useMemo(() => resolveSessionId(), []);
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    // === wave 1.13-A === — first-prompt copy depends on whether the
    // user has already declared their scope. Unset → Solo/Team picker;
    // set → original setup primer.
    const initialContent =
      onboardingScope === null
        ? t("onboardingChat.scopePrompt", {
            defaultValue:
              "Hi! Are you setting up just for yourself, or for a team?",
          })
        : t("onboardingChat.initialPrompt", {
            defaultValue:
              "Hi, I'm Tangerine. To set you up, I need to know two things: (a) your primary AI tool (Cursor / Claude Code / Codex / Windsurf / Ollama), and (b) optionally a GitHub repo for team sync. Just tell me in your own words — e.g. \"primary=Claude Code, repo=github.com/me/team-private\".",
          });
    return [
      {
        id: "system-primer",
        role: "system",
        content: initialContent,
        actions: [],
        ts: Date.now(),
      },
    ];
    // === end wave 1.13-A ===
  });
  const [dispatchState, setDispatchState] = useState<"idle" | "loading" | "error">("idle");
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Mark the chat as "started" the first time it mounts so the AppShell's
  // SetupWizard auto-trigger knows not to also open the form wizard. The
  // setter is idempotent — safe to call repeatedly.
  useEffect(() => {
    if (!onboardingChatStarted) {
      setOnboardingChatStarted(true);
    }
  }, [onboardingChatStarted, setOnboardingChatStarted]);

  // Auto-scroll on new messages. Cheap effect — no observer needed; the
  // dependency array fires on every list change. Defensive against jsdom
  // (no scrollIntoView) so the vitest suite doesn't trip on a polyfill gap.
  useEffect(() => {
    const el = messagesEndRef.current;
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages.length, dispatchState]);

  // Bubble the "setup complete" event to the parent if the user finishes
  // mid-conversation (e.g. after configure_mcp + git_remote_set both
  // succeeded).
  useEffect(() => {
    if (setupWizardChannelReady && onSetupComplete) {
      onSetupComplete();
    }
  }, [setupWizardChannelReady, onSetupComplete]);

  // === wave 1.13-A === — Solo/Team picker. Renders inline above the
  // textarea when the user hasn't yet picked a scope. Picking flips the
  // persisted scope, swaps the system primer to the original setup
  // prompt, and unblocks the rest of the chat-driven setup.
  const handleScopePick = (scope: "solo" | "team") => {
    setOnboardingScope(scope);
    void logEvent("onboarding_scope_picked", {
      session_id: sessionId,
      scope,
    });
    const ts = Date.now();
    setMessages((m) => [
      ...m,
      {
        id: `u-${ts}`,
        role: "user",
        content:
          scope === "solo"
            ? t("onboardingChat.scopeSoloPick", {
                defaultValue: "Just for me.",
              })
            : t("onboardingChat.scopeTeamPick", {
                defaultValue: "For a team.",
              }),
        actions: [],
        ts,
      },
      {
        id: `a-${ts + 1}`,
        role: "assistant",
        content:
          scope === "solo"
            ? t("onboardingChat.scopeSoloAck", {
                defaultValue:
                  "Got it — solo setup. Tell me your primary AI tool (Cursor / Claude Code / Codex / Windsurf / Ollama). I'll skip the team-roster step.",
              })
            : t("onboardingChat.scopeTeamAck", {
                defaultValue:
                  "Got it — team setup. Tell me your primary AI tool and a GitHub repo for the shared memory dir. E.g. \"primary=Claude Code, repo=github.com/me/team-private\".",
              }),
        actions: [],
        ts: ts + 1,
      },
    ]);
  };
  // === end wave 1.13-A ===

  const submitPrompt = async () => {
    const text = prompt.trim();
    if (!text || dispatchState === "loading") return;
    const userTs = Date.now();
    const userMsg: ChatMessage = {
      id: `u-${userTs}`,
      role: "user",
      content: text,
      actions: [],
      ts: userTs,
    };
    setMessages((m) => [...m, userMsg]);
    setPrompt("");
    setDispatchState("loading");
    setDispatchError(null);
    void logEvent("onboarding_chat_message", {
      session_id: sessionId,
      length: text.length,
    });

    try {
      const turn: OnboardingChatTurn = await onboardingChatTurn({
        userMessage: text,
        sessionId,
        primaryToolId: primaryAITool ?? undefined,
      });
      const allActions = [...turn.actions_taken, ...turn.actions_pending];
      const assistantTs = Date.now();
      const assistantMsg: ChatMessage = {
        id: `a-${assistantTs}`,
        role: "assistant",
        content: turn.content,
        actions: allActions,
        ts: assistantTs,
      };
      setMessages((m) => [...m, assistantMsg]);
      setDispatchState("idle");

      // Telemetry per executed action. The pending ones fire once the
      // user clicks the inline CTA inside the action card.
      for (const a of turn.actions_taken) {
        void logEvent("onboarding_chat_action_executed", {
          session_id: sessionId,
          kind: a.kind,
          status: a.status,
        });
      }

      // Heuristic: setup is "complete" once ANY action of kind
      // configure_mcp succeeded — the MCP bridge is live. The user can
      // keep chatting (e.g. "now set up Discord") but the chat will
      // surface the "setup complete" banner at the bottom.
      const mcpOk = turn.actions_taken.some(
        (a) => a.kind === "configure_mcp" && a.status === "succeeded",
      );
      if (mcpOk && !setupWizardChannelReady) {
        setSetupWizardChannelReady(true);
        void logEvent("onboarding_chat_completed", {
          session_id: sessionId,
        });
        // === wave 24 === — first-run via chat: auto-create today's daily note.
        try {
          const { dailyNotesEnsureToday, localTodayIso } = await import(
            "@/lib/tauri"
          );
          await dailyNotesEnsureToday({ date: localTodayIso() });
        } catch {
          /* defensive — never block setup completion */
        }
        // === end wave 24 ===
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setDispatchError(msg);
      setDispatchState("error");
    }
  };

  const onTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitPrompt();
    }
  };

  // Mode kill-switch: user / dev opted into the form wizard instead. The
  // /today route is responsible for rendering SetupWizard reachable; this
  // component just stops mounting when mode === "wizard".
  if (onboardingMode === "wizard") {
    return null;
  }

  // Setup is done — switch to general mode. Render a small "switched"
  // banner so the user knows the chat changed mode, then render nothing
  // (the /today route's Wave 14 chat takes over).
  if (setupWizardChannelReady) {
    return (
      <div
        data-testid="onboarding-chat-complete"
        className="rounded-xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-[13px] text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
      >
        {t("onboardingChat.setupComplete", {
          defaultValue:
            "Setup complete. Try asking me anything about your team — e.g. \"What did we decide about pricing last week?\"",
        })}
      </div>
    );
  }

  return (
    <div data-testid="onboarding-chat" className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-[13px] text-[var(--ti-ink-600)]">
        <Sparkles size={14} className="text-[var(--ti-orange-500)]" />
        <span className="font-mono text-[10px] uppercase tracking-wider">
          {t("onboardingChat.modeBadge", { defaultValue: "Setup mode" })}
        </span>
      </div>

      <div
        data-testid="onboarding-chat-messages"
        className="flex flex-col gap-3"
      >
        {messages.map((m) => (
          <ChatBubble key={m.id} message={m} />
        ))}
        {dispatchState === "loading" && (
          <div
            data-testid="onboarding-chat-loading"
            className="flex items-center gap-2 text-[12px] text-[var(--ti-ink-500)]"
          >
            <Loader2 size={14} className="animate-spin" />
            <span>
              {t("onboardingChat.thinking", { defaultValue: "Thinking…" })}
            </span>
          </div>
        )}
        {dispatchState === "error" && dispatchError && (
          <div
            data-testid="onboarding-chat-error"
            className="rounded-xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-[12px] text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300"
          >
            <p className="font-medium">
              {/* === wave 1.15 W1.1 === — Reword: the v1.14.6 message
                  "Ollama isn't responding" was misleading; the real
                  failure mode 95% of the time is the user has no
                  AI-tool session open at all, so MCP-sampling can't
                  borrow a channel. */}
              {t("onboardingChat.errorTitle", {
                defaultValue:
                  "Open your AI tool first (Cursor / Claude Code) so I can borrow its LLM.",
              })}
              {/* === end wave 1.15 W1.1 === */}
            </p>
            <p className="mt-1 font-mono text-[11px]">{dispatchError}</p>
            <button
              type="button"
              onClick={() => void submitPrompt()}
              data-testid="onboarding-chat-error-retry"
              className="mt-2 rounded border border-rose-300 px-2 py-0.5 text-[11px] text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:text-rose-300 dark:hover:bg-rose-900/30"
            >
              {t("onboardingChat.errorRetry", { defaultValue: "Retry" })}
            </button>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* === wave 1.13-A === — Solo/Team picker, inline above the
          textarea. Renders only on first launch (when scope is unset).
          Once picked, the buttons disappear and the original chat input
          takes over. */}
      {onboardingScope === null && (
        <div
          data-testid="onboarding-chat-scope-picker"
          className="flex flex-wrap gap-2"
        >
          <button
            type="button"
            data-testid="onboarding-chat-scope-solo"
            onClick={() => handleScopePick("solo")}
            className="rounded-md border border-stone-200 px-3 py-1.5 text-[12px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            {t("onboardingChat.scopeSoloButton", {
              defaultValue: "Just for me",
            })}
          </button>
          <button
            type="button"
            data-testid="onboarding-chat-scope-team"
            onClick={() => handleScopePick("team")}
            className="rounded-md border border-[var(--ti-orange-500)] bg-[var(--ti-orange-50)] px-3 py-1.5 text-[12px] text-[var(--ti-orange-700)] hover:bg-[var(--ti-orange-100)] dark:bg-[rgba(204,85,0,0.12)] dark:text-[var(--ti-orange-500)] dark:hover:bg-[rgba(204,85,0,0.2)]"
          >
            {t("onboardingChat.scopeTeamButton", {
              defaultValue: "For a team",
            })}
          </button>
        </div>
      )}
      {/* === end wave 1.13-A === */}

      <div
        data-testid="onboarding-chat-input"
        className="flex items-end gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2 shadow-sm dark:border-stone-800 dark:bg-stone-900"
      >
        <textarea
          ref={textareaRef}
          data-testid="onboarding-chat-textarea"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={onTextareaKeyDown}
          rows={2}
          placeholder={t("onboardingChat.inputPlaceholder", {
            defaultValue: "Tell me what you want to set up…",
          })}
          className="min-h-[44px] flex-1 resize-none bg-transparent text-[14px] leading-relaxed text-[var(--ti-ink-900)] placeholder:text-[var(--ti-ink-500)] focus:outline-none dark:text-[var(--ti-ink-900)]"
          aria-label={t("onboardingChat.inputAriaLabel", {
            defaultValue: "Tangerine onboarding chat input",
          })}
        />
        <button
          type="button"
          onClick={() => void submitPrompt()}
          disabled={dispatchState === "loading" || prompt.trim().length === 0}
          data-testid="onboarding-chat-send"
          className="flex shrink-0 items-center gap-1.5 rounded-md bg-[var(--ti-orange-500)] px-3 py-2 text-[13px] font-medium text-white transition-colors hover:bg-[var(--ti-orange-600)] disabled:cursor-not-allowed disabled:bg-stone-300 dark:disabled:bg-stone-700"
        >
          <Send size={14} />
          <span>{t("onboardingChat.sendButton", { defaultValue: "Send" })}</span>
        </button>
      </div>

      <div className="text-[11px] text-[var(--ti-ink-500)]">
        {t("onboardingChat.fallbackHint", {
          defaultValue:
            "Prefer a form? Press Cmd+K and pick \"Set up LLM channel\".",
        })}{" "}
        <button
          type="button"
          data-testid="onboarding-chat-open-wizard"
          onClick={() => setSetupWizardOpen(true)}
          className="underline-offset-2 hover:underline"
        >
          {t("onboardingChat.openWizardLink", {
            defaultValue: "Use form-based setup",
          })}
        </button>
      </div>
    </div>
  );
}

function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "system") {
    return (
      <div
        data-testid="onboarding-chat-system"
        className="rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 text-[13px] text-[var(--ti-ink-700)] dark:border-stone-800 dark:bg-stone-900/60 dark:text-[var(--ti-ink-700)]"
      >
        {message.content}
      </div>
    );
  }
  if (message.role === "user") {
    return (
      <div
        data-testid="onboarding-chat-user"
        className="self-end max-w-[80%] rounded-xl bg-[var(--ti-orange-500)] px-4 py-2 text-[13px] text-white"
      >
        {message.content}
      </div>
    );
  }
  // Assistant turn — body + inline action cards.
  return (
    <div
      data-testid="onboarding-chat-assistant"
      className="rounded-xl border border-stone-200 bg-white px-4 py-3 text-[13px] text-[var(--ti-ink-900)] shadow-sm dark:border-stone-800 dark:bg-stone-900"
    >
      <div className="leading-relaxed">{message.content}</div>
      {message.actions.length > 0 && (
        <div className="mt-3 flex flex-col gap-2" data-testid="onboarding-chat-actions">
          {message.actions.map((a, i) => (
            <ActionCard key={`${message.id}-act-${i}`} action={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionCard({ action }: { action: OnboardingAction }) {
  const { t } = useTranslation();
  const Icon = actionIcon(action.kind);
  const color = actionStatusColor(action.status);
  // === v1.13.7 round-7 === — surface a real CTA failure inline so the
  // user doesn't see a silent click no-op when openExternal /
  // downloadWhisperModel rejects (e.g. shell plugin not granted, no disk
  // space). Local state because the failure is per-card; we don't want
  // to thread a global toast for a single OAuth open click.
  const pushToast = useStore((s) => s.ui.pushToast);
  const [ctaError, setCtaError] = useState<string | null>(null);
  // === end v1.13.7 round-7 ===
  const colorClasses = (() => {
    switch (color) {
      case "green":
        return "border-emerald-300 bg-emerald-50/60 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300";
      case "yellow":
        return "border-amber-300 bg-amber-50/60 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-300";
      case "red":
        return "border-rose-300 bg-rose-50/60 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300";
      default:
        return "border-stone-200 bg-stone-50/60 text-stone-700 dark:border-stone-800 dark:bg-stone-950/30 dark:text-stone-300";
    }
  })();
  // === v1.13.7 round-7 === — await the typed result (R7 made it a
  // discriminated-union return). On `ok: false`, render an inline error
  // line + push a toast so the failure is visible across the shell.
  const handleCta = async () => {
    setCtaError(null);
    const r = await completeFrontendAction(action);
    if (!r.ok) {
      setCtaError(r.error);
      pushToast({
        kind: "error",
        msg: `Couldn't ${actionTitle(action.kind).toLowerCase()}: ${r.error}`,
        durationMs: 6000,
      });
    }
  };
  // === end v1.13.7 round-7 ===
  return (
    <div
      data-testid={`onboarding-chat-action-${action.kind}`}
      data-status={action.status}
      className={`flex items-start gap-3 rounded-md border px-3 py-2 ${colorClasses}`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium">{actionTitle(action.kind)}</span>
          <span className="font-mono text-[10px] uppercase tracking-wider opacity-75">
            {t(`onboardingChat.${action.status}`, {
              defaultValue: actionStatusLabel(action.status),
            })}
          </span>
        </div>
        <div className="mt-0.5 text-[12px] leading-snug">{action.detail}</div>
        {action.error && (
          <div className="mt-1 font-mono text-[10px] opacity-75">
            {action.error}
          </div>
        )}
        {action.status === "pending" && (
          <button
            type="button"
            data-testid={`onboarding-chat-action-cta-${action.kind}`}
            // === v1.13.7 round-7 === — handleCta is now async; void the
            // returned promise so React's onClick contract stays sync.
            onClick={() => void handleCta()}
            // === end v1.13.7 round-7 ===
            className="mt-1.5 rounded border border-current px-2 py-0.5 text-[11px] hover:bg-current/10"
          >
            {t("onboardingChat.actionCta", {
              defaultValue: "Open",
            })}
          </button>
        )}
        {/* === v1.13.7 round-7 === — inline failure line so a click that
            errored doesn't look like a silent no-op. Toast also fires
            via pushToast in handleCta for cross-route visibility. */}
        {ctaError && (
          <div
            data-testid={`onboarding-chat-action-cta-error-${action.kind}`}
            className="mt-1 font-mono text-[10px] text-rose-700 dark:text-rose-300"
          >
            {ctaError}
          </div>
        )}
        {/* === end v1.13.7 round-7 === */}
      </div>
    </div>
  );
}
// === end wave 18 ===
