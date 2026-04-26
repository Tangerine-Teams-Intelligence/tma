import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
  ExternalLink,
  Loader2,
  AlertCircle,
} from "lucide-react";
import { loadAITools, type AIToolStatus } from "@/lib/ai-tools";
import { getAIToolConfig, type AIToolConfig } from "@/lib/ai-tools-config";

/**
 * /ai-tools/:id — generic per-tool setup page.
 *
 * Reads the static config from `lib/ai-tools-config.ts` and the live
 * detection verdict from the Rust `get_ai_tool_status` command on mount.
 * Renders three sections:
 *
 *   1. Status banner: detected ✅ / needs setup / not installed (with install link)
 *   2. "How to wire it up": 3 setup steps as numbered list, w/ optional code blocks
 *   3. "Test it": 3 🍊 Test Query buttons → mock answer card (Phase 1 only)
 *
 * Phase 3 will replace the mock query handler with a real session-borrowed
 * call into the upstream LLM via Tangerine's MCP / browser-ext / IDE bridge.
 */
export default function AIToolSetupPage() {
  const params = useParams();
  const id = params.id ?? "";
  const config = useMemo(() => getAIToolConfig(id), [id]);

  const [status, setStatus] = useState<AIToolStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  // Load the live detection verdict on mount. We piggy-back on `loadAITools()`
  // (which Agent 2 already wired through `lib/tauri.ts::detectAITools`) and
  // pluck out the row matching `:id`. That keeps us aligned with the sidebar
  // and avoids duplicating mock fixtures.
  useEffect(() => {
    let cancel = false;
    if (!id) return;
    setStatusLoading(true);
    setStatusError(null);
    setStatus(null);
    (async () => {
      try {
        const all = await loadAITools();
        if (cancel) return;
        const row = all.find((t) => t.id === id) ?? null;
        setStatus(row);
      } catch (e) {
        if (cancel) return;
        setStatusError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancel) setStatusLoading(false);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [id]);

  if (!config) {
    return (
      <div className="bg-stone-50 dark:bg-stone-950">
        <div className="mx-auto max-w-3xl px-8 py-10">
          <BackLink />
          <p className="mt-6 text-[12px] text-stone-500 dark:text-stone-400">
            Unknown AI tool: <code className="font-mono">{id}</code>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-stone-50 dark:bg-stone-950">
      <div className="mx-auto max-w-3xl px-8 py-10">
        <BackLink />

        <header className="mt-6">
          <p className="ti-section-label">AI tools</p>
          <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
            {config.name}
          </h1>
          <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            channel: {config.channel.replace("_", " ")}
          </p>
        </header>

        <StatusBanner
          config={config}
          status={status}
          statusLoading={statusLoading}
          statusError={statusError}
        />

        <SetupSteps config={config} />

        <TestQuerySection config={config} />

        <footer className="mt-10 border-t border-stone-200 pt-6 text-[11px] leading-relaxed text-stone-500 dark:border-stone-800 dark:text-stone-400">
          Tangerine borrows your existing {config.name} session — no API key
          needed.
        </footer>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------
// Back link
// ----------------------------------------------------------------------------

function BackLink() {
  return (
    <Link
      to="/today"
      className="inline-flex items-center gap-1 font-mono text-[11px] text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
    >
      <ArrowLeft size={12} /> /today
    </Link>
  );
}

// ----------------------------------------------------------------------------
// Status banner
// ----------------------------------------------------------------------------

function StatusBanner({
  config,
  status,
  statusLoading,
  statusError,
}: {
  config: AIToolConfig;
  status: AIToolStatus | null;
  statusLoading: boolean;
  statusError: string | null;
}) {
  if (statusLoading) {
    return (
      <div className="mt-6 flex items-center gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <Loader2
          size={14}
          className="animate-spin text-stone-500 dark:text-stone-400"
        />
        <p className="text-[12px] text-stone-600 dark:text-stone-300">
          Detecting {config.name}…
        </p>
      </div>
    );
  }

  if (statusError) {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
        <AlertCircle
          size={14}
          className="mt-0.5 text-amber-600 dark:text-amber-400"
        />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-amber-900 dark:text-amber-200">
            Couldn't run detection
          </p>
          <p className="mt-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            {statusError}
          </p>
        </div>
      </div>
    );
  }

  const verdict = status?.status ?? "not_installed";

  if (verdict === "installed") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900/50 dark:bg-emerald-950/30">
        <CheckCircle2
          size={14}
          className="mt-0.5 text-emerald-600 dark:text-emerald-400"
        />
        <div>
          <p className="text-[13px] font-medium text-emerald-900 dark:text-emerald-200">
            {config.name} detected on this machine.
          </p>
          <p className="mt-1 font-mono text-[10px] text-emerald-700 dark:text-emerald-400">
            Follow the steps below if you haven't wired Tangerine in yet.
          </p>
        </div>
      </div>
    );
  }

  if (verdict === "needs_setup") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/50 dark:bg-amber-950/30">
        <Circle
          size={14}
          className="mt-0.5 text-amber-600 dark:text-amber-400"
        />
        <div>
          <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
            {config.name} found, pending setup.
          </p>
          <p className="mt-1 font-mono text-[10px] text-amber-700 dark:text-amber-400">
            We can see the app but haven't found a Tangerine entry yet.
          </p>
        </div>
      </div>
    );
  }

  if (verdict === "browser_ext_required") {
    return (
      <div className="mt-6 flex items-start gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
        <Circle size={14} className="mt-0.5 text-stone-500" />
        <div>
          <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
            {config.name} needs the Tangerine browser extension.
          </p>
          <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
            We can't auto-detect web tools — install the extension below.
          </p>
        </div>
      </div>
    );
  }

  // not_installed
  const installUrl = status?.install_url ?? config.install_url;
  return (
    <div className="mt-6 flex items-start gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
      <Circle size={14} className="mt-0.5 text-stone-400" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
          {config.name} not installed.
        </p>
        <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
          Install it first, then come back to this page.
        </p>
      </div>
      {installUrl && (
        <a
          href={installUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded border border-stone-200 px-2 py-1 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
        >
          Install {config.name} <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------
// Setup steps
// ----------------------------------------------------------------------------

function SetupSteps({ config }: { config: AIToolConfig }) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
        How to wire it up
      </h2>
      <ol className="mt-4 space-y-4">
        {config.setup_steps.map((step, idx) => (
          <li
            key={idx}
            className="flex gap-3 rounded-md border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900"
          >
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ti-orange-500)] font-mono text-[11px] font-medium text-white">
              {idx + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-stone-900 dark:text-stone-100">
                {step.title}
              </p>
              {step.body && (
                <p className="mt-1 text-[12px] leading-relaxed text-stone-700 dark:text-stone-300">
                  {step.body}
                </p>
              )}
              {step.code && (
                <pre className="mt-2 overflow-x-auto rounded border border-stone-200 bg-stone-50 p-3 font-mono text-[11px] leading-relaxed text-stone-800 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200">
                  {step.code}
                </pre>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

// ----------------------------------------------------------------------------
// Test queries
// ----------------------------------------------------------------------------

interface TestQueryRecord {
  query: string;
  /** "loading" while the mock pretends to call upstream, "done" once we have. */
  state: "loading" | "done";
  /** Mock answer once `state === "done"`. */
  answer?: string;
}

function TestQuerySection({ config }: { config: AIToolConfig }) {
  // Per-button history. Keyed by query index so re-clicking just re-runs.
  const [results, setResults] = useState<Record<number, TestQueryRecord>>({});

  const runQuery = (idx: number, query: string) => {
    setResults((prev) => ({
      ...prev,
      [idx]: { query, state: "loading" },
    }));
    // TODO(Phase 3): wire to session borrower.
    // For Phase 1 we display a fake "Tangerine: ..." answer after ~600ms.
    window.setTimeout(() => {
      setResults((prev) => ({
        ...prev,
        [idx]: {
          query,
          state: "done",
          answer: mockAnswer(query, config.name),
        },
      }));
    }, 600);
  };

  return (
    <section className="mt-10">
      <h2 className="font-display text-base text-stone-900 dark:text-stone-100">
        Test it
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
        Click any button below to send the query through {config.name} via
        Tangerine.
      </p>

      <div className="mt-4 grid gap-2">
        {config.preset_queries.map((q, idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => runQuery(idx, q)}
            className="group flex items-center gap-3 rounded-md border border-stone-200 bg-white p-3 text-left transition-colors hover:border-[var(--ti-orange-500)] hover:bg-orange-50/40 dark:border-stone-800 dark:bg-stone-900 dark:hover:border-[var(--ti-orange-500)] dark:hover:bg-orange-950/20"
          >
            <span aria-hidden="true" className="text-base leading-none">
              🍊
            </span>
            <span className="flex-1 text-[13px] text-stone-800 dark:text-stone-200">
              {q}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-wider text-stone-400 group-hover:text-[var(--ti-orange-500)] dark:text-stone-500">
              Test query
            </span>
          </button>
        ))}
      </div>

      {/* Result cards stacked under the buttons. Most-recent click wins per slot. */}
      <div className="mt-4 space-y-3">
        {Object.entries(results).map(([key, rec]) => (
          <ResultCard key={key} record={rec} />
        ))}
      </div>
    </section>
  );
}

function ResultCard({ record }: { record: TestQueryRecord }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-4 dark:border-stone-800 dark:bg-stone-900">
      <p className="font-mono text-[10px] uppercase tracking-wider text-stone-400 dark:text-stone-500">
        Query
      </p>
      <p className="mt-1 text-[12px] text-stone-700 dark:text-stone-300">
        {record.query}
      </p>

      <div className="mt-3 border-t border-stone-200 pt-3 dark:border-stone-800">
        {record.state === "loading" ? (
          <div className="flex items-center gap-2">
            <Loader2
              size={12}
              className="animate-spin text-stone-500 dark:text-stone-400"
            />
            <p className="font-mono text-[11px] text-stone-500 dark:text-stone-400">
              Tangerine is thinking…
            </p>
          </div>
        ) : (
          <>
            <p className="text-[13px] leading-relaxed text-stone-900 dark:text-stone-100">
              <span className="font-medium text-[var(--ti-orange-500)]">
                Tangerine:{" "}
              </span>
              {record.answer}
            </p>
            <p className="mt-2 font-mono text-[10px] text-stone-400 dark:text-stone-500">
              Mock response — Phase 3 wires real LLM via session borrowing.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Fake response generator used until Phase 3 wires the real session borrower.
 * Picks a plausible-but-clearly-stub answer based on substring matches in
 * the query. Returns plain English; never a real fact.
 */
function mockAnswer(query: string, toolName: string): string {
  const q = query.toLowerCase();
  if (q.includes("上周") || q.includes("决定")) {
    return "上周共有 3 个决定 — (1) v1 scope 锁定 Discord + Claude Code 输出, (2) 周一例会强制 dogfood TMA, (3) Whisper CN 区延迟 1.2s 可接受。下次会议建议 follow-up 第三项。";
  }
  if (q.includes("david") || q.includes("david 开会")) {
    return "上次 David sync (2026-04-24) 留了一个 open question: Whisper CN 区延迟是否可接受。建议带上 latency benchmark 数据 + v1 scope decision 一并交付,避免重复讨论。";
  }
  if (q.includes("status") || q.includes("project")) {
    return "tangerine-teams-app 当前 v1.7.0-beta.3,Phase 1 backend 已 ship (commit 64cb0cc),frontend 正在并行实现 AI tools sidebar。下一里程碑:Phase 3 真实 session 借用。";
  }
  // Fallback: still tool-aware so the UI feels responsive on novel queries.
  return `(via ${toolName}) Tangerine 找到了相关上下文,但此为 Phase 1 mock 占位。Phase 3 将通过你已登录的 ${toolName} session 返回真实答案。`;
}
