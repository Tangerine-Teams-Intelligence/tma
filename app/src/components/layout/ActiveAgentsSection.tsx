import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot,
  Code2,
  GitBranch,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { getActiveAgents, type AgentActivity } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/**
 * ACTIVE AGENTS — v2.0-beta.2 sidebar section. Cross-team visibility into
 * each member's currently-running personal AI agents (Cursor, Devin,
 * Claude Code, Replit, Apple Intelligence).
 *
 * v2.0-beta.2 ships against a 3-row Rust stub (`get_active_agents`); the
 * real per-source capture orchestrator lands in v3.0 alongside the personal
 * vault. See V2_0_SPEC.md §3.1 / §3.2.
 *
 * Polling cadence:
 *   * Active route (sidebar visible + window focused): 10s
 *   * Background (window blurred): 60s
 * The component flips cadence on the `focus` / `blur` window events without
 * remounting, so the displayed list never blanks during the transition.
 *
 * Click a row → navigate to `/people/{user}` so the user sees that team
 * member's recent atoms in context.
 */
export function ActiveAgentsSection() {
  const [agents, setAgents] = useState<AgentActivity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track focus in a ref so the polling loop reads the latest value without
  // tearing down the interval on every focus flip.
  const isFocusedRef = useRef<boolean>(
    typeof document === "undefined" ? true : document.hasFocus(),
  );

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const next = await getActiveAgents();
        if (cancelled) return;
        setAgents(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.error("[active-agents] fetch failed", e);
        setError(e instanceof Error ? e.message : String(e));
      }
    };

    void refresh();

    // Cadence: 10s when focused, 60s when blurred. We restart the timer on
    // focus flips so the cadence change takes effect immediately rather than
    // after the next scheduled tick.
    let timer: ReturnType<typeof setInterval> | null = null;
    const startTimer = () => {
      if (timer !== null) clearInterval(timer);
      const cadenceMs = isFocusedRef.current ? 10_000 : 60_000;
      timer = setInterval(() => void refresh(), cadenceMs);
    };
    startTimer();

    const onFocus = () => {
      isFocusedRef.current = true;
      startTimer();
      // Refresh immediately so a returning user sees current state.
      void refresh();
    };
    const onBlur = () => {
      isFocusedRef.current = false;
      startTimer();
    };
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
    }

    return () => {
      cancelled = true;
      if (timer !== null) clearInterval(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      }
    };
  }, []);

  // Order matters: surface the error state BEFORE the loading state so a
  // first-fetch failure doesn't leave the UI stuck on "loading…".
  if (error !== null) {
    return (
      <ul>
        <li
          data-testid="active-agents-error"
          className="px-2 py-1 font-mono text-[10px] text-rose-500 dark:text-rose-400"
          title={error}
        >
          error
        </li>
      </ul>
    );
  }

  if (agents === null) {
    return (
      <ul>
        <li
          data-testid="active-agents-loading"
          className="px-2 py-1 font-mono text-[10px] text-stone-400 dark:text-stone-500"
        >
          loading…
        </li>
      </ul>
    );
  }

  if (agents.length === 0) {
    return (
      <ul>
        <li
          data-testid="active-agents-empty"
          className="px-2 py-1 font-mono text-[10px] text-stone-400 dark:text-stone-500"
        >
          no active agents
        </li>
      </ul>
    );
  }

  return (
    <ul data-testid="active-agents-list">
      {agents.map((a, i) => (
        <li key={`${a.user}-${a.agent}-${i}`}>
          <ActiveAgentRow agent={a} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Single row in the feed. Renders:
 *   [user-avatar] [agent-icon] {agent name · user} [status-dot] [last_active]
 * Click → `/people/{user}` so we land on the team-mate's atom feed.
 */
function ActiveAgentRow({ agent }: { agent: AgentActivity }) {
  const navigate = useNavigate();
  const Icon = agentIcon(agent.agent);

  const onClick = () => {
    // The People route owns per-user atom views — see v1.8 Wave 3.
    navigate(`/people/${encodeURIComponent(agent.user)}`);
  };

  const subtitle = agent.task ?? "(idle)";
  const tooltip = `${agent.agent} · ${agent.user} · ${subtitle} · ${agent.last_active} ago`;

  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`active-agent-row-${agent.user}-${agent.agent}`}
      title={tooltip}
      className={cn(
        "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[12px]",
        "text-stone-700 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-900",
      )}
    >
      <UserAvatar user={agent.user} />
      <Icon size={12} className="shrink-0 text-stone-500 dark:text-stone-400" />
      <span className="min-w-0 flex-1 truncate">
        <span className="truncate">{agent.agent}</span>
        <span className="ml-1 font-mono text-[10px] text-stone-400 dark:text-stone-500">
          @{agent.user}
        </span>
      </span>
      <StatusDot status={agent.status} />
      <span className="shrink-0 font-mono text-[10px] text-stone-400 dark:text-stone-500">
        {agent.last_active}
      </span>
    </button>
  );
}

/**
 * Tiny circular avatar — just the first letter of the user's alias on a
 * tinted background. Real avatars land with the personal vault in v3.0.
 */
function UserAvatar({ user }: { user: string }) {
  const initial = (user[0] ?? "?").toUpperCase();
  return (
    <span
      aria-hidden
      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-stone-200 font-mono text-[9px] font-medium text-stone-600 dark:bg-stone-800 dark:text-stone-300"
    >
      {initial}
    </span>
  );
}

/** Map an agent kind to a `lucide-react` icon. Falls back to `Sparkles`. */
function agentIcon(agent: string): LucideIcon {
  switch (agent) {
    case "Cursor":
      return Code2;
    case "Claude Code":
      return Terminal;
    case "Devin":
      return Bot;
    case "Replit":
      return GitBranch;
    default:
      return Sparkles;
  }
}

/**
 * Tri-state dot:
 *   running → green
 *   idle    → grey
 *   error   → red
 */
function StatusDot({ status }: { status: AgentActivity["status"] }) {
  if (status === "running") {
    return (
      <span
        className="ti-live-dot h-1.5 w-1.5 shrink-0"
        title="Running"
        aria-label="Running"
        data-testid="status-dot-running"
      />
    );
  }
  if (status === "error") {
    return (
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-rose-500 dark:bg-rose-400"
        title="Error"
        aria-label="Error"
        data-testid="status-dot-error"
      />
    );
  }
  return (
    <span
      className="h-1.5 w-1.5 shrink-0 rounded-full bg-stone-300 dark:bg-stone-700"
      title="Idle"
      aria-label="Idle"
      data-testid="status-dot-idle"
    />
  );
}
