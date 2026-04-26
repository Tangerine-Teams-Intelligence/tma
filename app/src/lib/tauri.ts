/**
 * Typed wrappers around Tauri `invoke()`.
 *
 * T3 owns the Rust implementations. While T3 ships its real handlers, every
 * call here goes through `safeInvoke()`, which transparently falls back to
 * mock implementations when:
 *   - we're running outside Tauri (e.g. `vite dev` in a browser, vitest), or
 *   - the Rust handler isn't registered yet.
 *
 * All command names + payload shapes are LOCKED per APP-INTERFACES.md §4.
 * T3: do not rename these. If you need a new command, add it; don't repurpose.
 */

import type { TeamMember, WizardData } from "./store";

// Detect Tauri environment without crashing in the browser/test runner.
const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function realInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function safeInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    return await realInvoke<T>(cmd, args);
  } catch (e) {
    // In Tauri context, an invoke failure is a real bug — log loudly so it's
    // visible in DevTools instead of being swallowed by the mock. We still
    // fall back to the mock so the UI doesn't crash, but the console.error
    // gives engineers something to grep for.
    // eslint-disable-next-line no-console
    console.error(`[tauri] invoke "${cmd}" failed:`, e, "args=", args);
    return await mock();
  }
}

// ============================================================
// Memory layer (sample seeding + root resolution)
// ============================================================

export interface MemoryRootInfo {
  /** Absolute path to `<home>/.tangerine-memory/`. */
  path: string;
  /** True when the dir exists on disk. */
  exists: boolean;
  /** True when the dir is missing OR empty. */
  is_empty: boolean;
}

export interface InitMemoryResult {
  /** Resolved memory root. */
  path: string;
  /** True when sample files were just copied; false when dir was already populated. */
  seeded: boolean;
  /** Number of files copied. 0 when `seeded` is false. */
  copied: number;
  /** Optional error when the seed attempt failed; we still return a path. */
  error: string | null;
}

/**
 * Resolve the absolute path to the user's memory dir. Mock returns the
 * `~/.tangerine-memory` placeholder so the UI's breadcrumb shows something
 * sensible outside Tauri.
 */
export async function resolveMemoryRoot(): Promise<MemoryRootInfo> {
  return safeInvoke("resolve_memory_root", undefined, () => ({
    path: "~/.tangerine-memory",
    exists: false,
    is_empty: true,
  }));
}

/**
 * Copy bundled sample files into the user's memory dir. Idempotent — only
 * seeds when the dir is empty. Mock returns a no-op so vitest doesn't try to
 * touch the real filesystem.
 */
export async function initMemoryWithSamples(): Promise<InitMemoryResult> {
  return safeInvoke("init_memory_with_samples", undefined, () => ({
    path: "~/.tangerine-memory",
    seeded: false,
    copied: 0,
    error: null,
  }));
}

// ============================================================
// System / external
// ============================================================

export async function openExternal(url: string): Promise<void> {
  return safeInvoke("open_external", { url }, async () => {
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener");
  });
}

export async function showInFolder(path: string): Promise<void> {
  return safeInvoke("show_in_folder", { path }, () => {
    console.info("[mock] show_in_folder", path);
  });
}

export async function systemNotify(title: string, body: string): Promise<void> {
  return safeInvoke("system_notify", { title, body }, () => {
    console.info("[mock] system_notify", title, body);
  });
}

// ============================================================
// Wizard-specific
// ============================================================

export interface ClaudeDetectResult {
  found: boolean;
  path: string | null;
  version: string | null;
}

export async function detectClaudeCli(): Promise<ClaudeDetectResult> {
  return safeInvoke("detect_claude_cli", undefined, () => ({
    found: true,
    path: "C:\\Users\\you\\AppData\\Local\\claude\\claude.exe",
    version: "0.4.2 (mock)",
  }));
}

export interface NodeRuntimeResult {
  found: boolean;
  path: string | null;
  version: string | null;
  major: number | null;
  meets_min: boolean;
}

/**
 * Path D — pkg-based Node bundling was dropped because pkg@5.8.1 does not
 * support Node 20+. We require the user to have Node 20+ on PATH, same model
 * as their Claude Code subscription. SW3 surfaces this as a prerequisite check.
 */
export async function detectNodeRuntime(): Promise<NodeRuntimeResult> {
  return safeInvoke("detect_node_runtime", undefined, () => ({
    found: true,
    path: "C:\\Program Files\\nodejs\\node.exe",
    version: "v20.11.1 (mock)",
    major: 20,
    meets_min: true,
  }));
}

export interface RepoValidationResult {
  ok: boolean;
  has_claude_md: boolean;
  has_knowledge: boolean;
  has_cursorrules: boolean;
  error?: string;
}

export async function validateTargetRepo(path: string): Promise<RepoValidationResult> {
  return safeInvoke("validate_target_repo", { path }, () => ({
    ok: true,
    has_claude_md: true,
    has_knowledge: true,
    has_cursorrules: false,
  }));
}

export async function validateWhisperKey(key: string): Promise<{ ok: boolean; error?: string }> {
  return safeInvoke("validate_whisper_key", { key }, () => {
    const ok = key.startsWith("sk-") && key.length >= 40;
    return ok ? { ok } : { ok: false, error: "Mock: key must start with sk- and be 40+ chars." };
  });
}

// ============================================================
// Local Whisper model (faster-whisper) — bundled, first-run download
// ============================================================

export interface WhisperModelStatus {
  state: "unknown" | "missing" | "ready";
  path: string | null;
  /** Bytes on disk (best-effort). */
  bytes: number;
}

export async function getWhisperModelStatus(): Promise<WhisperModelStatus> {
  return safeInvoke("get_whisper_model_status", undefined, () => ({
    state: "missing" as const,
    path: null,
    bytes: 0,
  }));
}

export type WhisperDownloadEvent =
  | { event: "start"; model: string; dest: string }
  | { event: "progress"; downloaded: number; total: number | null; percent: number | null }
  | { event: "done"; path: string }
  | { event: "error"; message: string };

export interface WhisperDownloadHandle {
  unsubscribe: () => void;
  /** Resolves to final status when the Python downloader exits. */
  completion: Promise<WhisperModelStatus>;
}

/**
 * Spawn the bundled `python -m tmi.model_download` and stream progress events.
 * Resolves a handle whose `completion` promise settles when the download
 * subprocess exits (success or failure).
 *
 * Real impl emits events on channel `whisper:download:<download_id>` from Rust.
 */
export async function downloadWhisperModel(
  size: "small" | "base" | "medium",
  onEvent: (e: WhisperDownloadEvent) => void,
): Promise<WhisperDownloadHandle> {
  if (!inTauri()) {
    // Mock: simulate progress.
    let bytes = 0;
    const total = 244 * 1024 * 1024;
    onEvent({ event: "start", model: size, dest: "(mock)" });
    let resolveDone: (s: WhisperModelStatus) => void = () => {};
    const completion = new Promise<WhisperModelStatus>((r) => (resolveDone = r));
    const t = setInterval(() => {
      bytes += 12 * 1024 * 1024;
      if (bytes >= total) {
        bytes = total;
        clearInterval(t);
        onEvent({ event: "progress", downloaded: bytes, total, percent: 100 });
        onEvent({ event: "done", path: "(mock)" });
        resolveDone({ state: "ready", path: "(mock)", bytes: total });
      } else {
        onEvent({
          event: "progress",
          downloaded: bytes,
          total,
          percent: (bytes / total) * 100,
        });
      }
    }, 250);
    return {
      unsubscribe: () => clearInterval(t),
      completion,
    };
  }
  const { listen } = await import("@tauri-apps/api/event");
  let downloadId: string;
  try {
    const r = await realInvoke<{ download_id: string }>("download_whisper_model", { size });
    downloadId = r.download_id;
  } catch (e) {
    // Surface the underlying Rust AppError to the UI instead of silently
    // returning a never-completing handle.
    // eslint-disable-next-line no-console
    console.error("[tauri] download_whisper_model failed to start:", e);
    onEvent({ event: "error", message: errorMessage(e) });
    throw e instanceof Error ? e : new Error(errorMessage(e));
  }
  const channel = `whisper:download:${downloadId}`;
  let resolveDone: (s: WhisperModelStatus) => void = () => {};
  const completion = new Promise<WhisperModelStatus>((r) => (resolveDone = r));
  const un = await listen<WhisperDownloadEvent>(channel, (msg) => {
    onEvent(msg.payload);
    if (msg.payload.event === "done") {
      void getWhisperModelStatus().then(resolveDone);
    } else if (msg.payload.event === "error") {
      resolveDone({ state: "missing", path: null, bytes: 0 });
    }
  });
  return {
    unsubscribe: () => {
      un();
      void realInvoke("cancel_whisper_download", { download_id: downloadId }).catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[tauri] cancel_whisper_download failed:", e);
      });
    },
    completion,
  };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface DiscordGuild {
  id: string;
  name: string;
}

export async function pollDiscordBotPresence(token: string): Promise<{ guilds: DiscordGuild[] }> {
  // Real implementation goes via Rust to avoid CORS in the webview.
  return safeInvoke("poll_discord_bot_presence", { token }, async () => {
    // Browser/dev fallback: simulate detection after a few polls.
    await new Promise((r) => setTimeout(r, 250));
    if (Math.random() > 0.6) {
      return { guilds: [{ id: "123456789012345678", name: "Tangerine Team (mock)" }] };
    }
    return { guilds: [] };
  });
}

// ============================================================
// v1.8 Phase 1 — AI tools detection
// ============================================================

/**
 * Wraps the Rust `detect_ai_tools` command. Generic over the row shape so
 * the canonical `AIToolStatus` type can live in `lib/ai-tools.ts` (UI-side
 * concerns) without forcing a circular import here.
 *
 * `mockFallback` is required: it's the fixture used in browser-dev / vitest
 * (no Tauri bridge) so the sidebar still renders during local development.
 */
export async function detectAITools<T>(mockFallback: T[]): Promise<T[]> {
  return safeInvoke<T[]>("detect_ai_tools", undefined, () => mockFallback);
}

// ============================================================
// v1.8 Phase 3-A — Session borrowing (co-thinker LLM dispatch)
// ============================================================
//
// Tangerine borrows the user's existing AI tool sessions instead of running
// its own LLM. The dispatcher (Rust: `crate::agi::session_borrower::dispatch`)
// routes a request to the right channel based on:
//   - the user-selected primary tool from `ui.primaryAITool` (Settings)
//   - falling back through `AI_TOOL_PRIORITY` if the primary is unreachable
//
// Phase 3 ships:
//   * MCP sampling channel — STUBBED (200ms canned response per tool)
//   * Browser-ext channel — NotImplemented (wires in Phase 4)
//   * Ollama channel — REAL HTTP call to localhost:11434
//
// The AI tool setup page's "Test query" buttons are the first consumers.

export interface LlmRequest {
  system_prompt: string;
  user_prompt: string;
  /** Defaults to 2000 in Rust if omitted. */
  max_tokens?: number;
  /** Defaults to 0.4 in Rust if omitted. */
  temperature?: number;
}

export interface LlmResponse {
  text: string;
  /** "mcp_sampling" | "ollama" | "browser_ext" */
  channel_used: string;
  /** Upstream tool that actually answered ("cursor", "ollama", ...). */
  tool_id: string;
  latency_ms: number;
  tokens_estimate: number;
}

/**
 * Dispatch one LLM request through the session borrower. Outside Tauri we
 * return a clearly-marked mock so the AI tool setup page still renders
 * something during `vite dev` / vitest.
 *
 * Throws when every channel fails (the underlying Rust returns `AppError`
 * with code `all_channels_exhausted`).
 */
export async function coThinkerDispatch(
  req: LlmRequest,
  primaryToolId?: string,
): Promise<LlmResponse> {
  return safeInvoke<LlmResponse>(
    "co_thinker_dispatch",
    { request: req, primaryToolId: primaryToolId ?? null },
    () => ({
      text: `(mock) Tangerine heard "${req.user_prompt.slice(0, 80)}". Real dispatch needs the Tauri bridge.`,
      channel_used: "mcp_sampling",
      tool_id: primaryToolId ?? "cursor",
      latency_ms: 0,
      tokens_estimate: 16,
    }),
  );
}

// ============================================================
// Config + secrets
// ============================================================

export async function getConfig(): Promise<unknown | null> {
  return safeInvoke("get_config", undefined, () => {
    // Test/dev seam: e2e tests can pre-populate window.__TMI_MOCK__.config to
    // skip the setup wizard and land on the meetings list.
    if (typeof window !== "undefined") {
      const w = window as unknown as { __TMI_MOCK__?: { config?: unknown } };
      if (w.__TMI_MOCK__?.config !== undefined) return w.__TMI_MOCK__.config;
    }
    return null;
  });
}

export async function setConfig(yaml: string): Promise<void> {
  return safeInvoke("set_config", { yaml }, () => {
    console.info("[mock] set_config\n", yaml);
  });
}

export async function getSecret(name: string): Promise<string | null> {
  return safeInvoke("get_secret", { name }, () => null);
}

export async function setSecret(name: string, value: string): Promise<void> {
  return safeInvoke("set_secret", { name, value }, () => {
    console.info(`[mock] set_secret ${name} = (${value.length} chars)`);
  });
}

// ============================================================
// Wizard finalization (called from SW-5)
// ============================================================

export async function finishWizard(data: WizardData): Promise<void> {
  // Persist secrets to HKCU\Environment via Rust.
  if (data.discordToken) {
    await setSecret("DISCORD_BOT_TOKEN", data.discordToken);
  }
  // OpenAI key is only relevant when the user opted into the cloud Whisper path.
  if (data.whisperMode === "openai" && data.whisperKey) {
    await setSecret("OPENAI_API_KEY", data.whisperKey);
  }

  // Build config.yaml. Schema mirrors INTERFACES.md §3.
  const yaml = buildConfigYaml(data);
  await setConfig(yaml);

  // Run `tmi init` via T3's run_tmi command. Best-effort here — T3 wires the
  // real handler. In the mock path we just log.
  await safeInvoke(
    "run_tmi",
    {
      subcommand: "init",
      args: data.meetingsRepo ? ["--meetings-repo", data.meetingsRepo] : [],
    },
    () => ({ run_id: "mock-init" })
  );
}

function buildConfigYaml(d: WizardData): string {
  const team = (d.team ?? [])
    .map(
      (m: TeamMember) =>
        `  - alias: ${m.alias}\n    display_name: ${quote(m.displayName)}\n    discord_id: ${m.discordId || "null"}`
    )
    .join("\n");

  const provider = d.whisperMode ?? "local";
  return `# Generated by Tangerine AI Teams setup wizard.
schema_version: 1
discord:
  bot_token_env: DISCORD_BOT_TOKEN
  guild_id: ${d.guildId ? quote(d.guildId) : "null"}
whisper:
  provider: ${provider}
  api_key_env: OPENAI_API_KEY
  model: whisper-1
  chunk_seconds: 10
claude:
  cli_path: ${d.claudeCliPath ? quote(d.claudeCliPath) : "null"}
  default_timeout_sec: 300
output_adapters:
  - kind: claude_code
    target_repo: ${d.targetRepo ? quote(d.targetRepo) : "null"}
team:
${team || "  []"}
meetings_repo: ${d.meetingsRepo ? quote(d.meetingsRepo) : "null"}
logging:
  level: info
`;
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ============================================================
// T2 additions — meetings + review IPC
// All have mock fallbacks; T3 will replace the Rust handlers.
// ============================================================

export type MeetingStateName =
  | "created"
  | "prepped"
  | "live"
  | "ended"
  | "wrapped"
  | "reviewed"
  | "merged"
  | "failed_bot"
  | "failed_observer"
  | "failed_wrap"
  | "failed_apply";

export interface MeetingListItem {
  id: string;
  title: string;
  state: MeetingStateName;
  date: string;        // YYYY-MM-DD
  participants: string[]; // aliases
  transcript_lines: number;
}

export interface DiffBlockJson {
  id: number;
  target_file: string;
  action: "append" | "insert" | "replace" | "create";
  insert_anchor: string | null;
  reason: string;
  transcript_refs: string[];
  body: string;
  status: "pending" | "approved" | "rejected" | "edited";
}

export interface ReviewJson {
  meeting_id: string;
  state: MeetingStateName;
  blocks: DiffBlockJson[];
}

export interface MeetingDetail {
  id: string;
  title: string;
  state: MeetingStateName;
  date: string;
  participants: { alias: string; display_name: string }[];
  transcript_lines: number;
  intents: { alias: string; ready: boolean; markdown?: string }[];
  observations_md?: string;
  summary_md?: string | null;
  diff_md?: string | null;
  errors: { component: string; code: string; detail: string; at: string }[];
}

// ----- mock fixture (used in vitest + browser dev) -----

const _mockMeetings: MeetingListItem[] = [
  {
    id: "2026-04-24-david-sync",
    title: "David sync",
    state: "wrapped",
    date: "2026-04-24",
    participants: ["daizhe", "hongyu"],
    transcript_lines: 142,
  },
  {
    id: "2026-04-22-weekly-standup",
    title: "Weekly standup",
    state: "merged",
    date: "2026-04-22",
    participants: ["daizhe", "hongyu", "advisor"],
    transcript_lines: 87,
  },
  {
    id: "2026-04-25-design-review",
    title: "Design review",
    state: "created",
    date: "2026-04-25",
    participants: ["daizhe", "hongyu"],
    transcript_lines: 0,
  },
];

const _mockReview: ReviewJson = {
  meeting_id: "2026-04-24-david-sync",
  state: "wrapped",
  blocks: [
    {
      id: 1,
      target_file: "knowledge/session-state.md",
      action: "append",
      insert_anchor: null,
      reason: "Decision on v1 scope (David sync, 2026-04-24, Topic 1)",
      transcript_refs: ["L47", "L52", "L58"],
      body:
        "+ ### 2026-04-24 — David sync\n+ - v1 scope locked to Discord input + Claude Code output\n+ - Decided by daizhe; hongyu agreed after L52 exchange",
      status: "pending",
    },
    {
      id: 2,
      target_file: "CLAUDE.md",
      action: "insert",
      insert_anchor: "## Workflow rules",
      reason: "Weekly TMA dogfood commitment from Topic 2",
      transcript_refs: ["L112"],
      body:
        "+ ### Meeting discipline\n+ - Run every Monday standup through TMA (prep -> start -> wrap -> review)\n+ - Owner: @daizhe",
      status: "pending",
    },
    {
      id: 3,
      target_file: "knowledge/whisper-latency.md",
      action: "create",
      insert_anchor: null,
      reason: "New fact surfaced by advisor (L141)",
      transcript_refs: ["L141"],
      body:
        "# Whisper API latency observations\n\n- CN-region: ~1.2s per 10s chunk\n- Acceptable for live transcript use case",
      status: "pending",
    },
  ],
};

// Test seam: vitest can swap fixtures via window.__TMI_MOCK__.
function _fixture<K extends keyof typeof _defaultFixtures>(key: K): (typeof _defaultFixtures)[K] {
  if (typeof window !== "undefined") {
    const w = window as unknown as { __TMI_MOCK__?: Partial<typeof _defaultFixtures> };
    const override = w.__TMI_MOCK__?.[key];
    if (override !== undefined) return override as (typeof _defaultFixtures)[K];
  }
  return _defaultFixtures[key];
}

const _defaultFixtures = {
  meetings: _mockMeetings,
  review: _mockReview,
};

// ----- meetings -----

export async function listMeetings(filter?: {
  state?: string;
  query?: string;
}): Promise<MeetingListItem[]> {
  return safeInvoke(
    "list_meetings",
    { state_filter: filter?.state, query: filter?.query },
    () => {
      let rows = _fixture("meetings").slice();
      if (filter?.state) rows = rows.filter((r) => r.state === filter.state);
      if (filter?.query) {
        const q = filter.query.toLowerCase();
        rows = rows.filter(
          (r) =>
            r.title.toLowerCase().includes(q) ||
            r.id.toLowerCase().includes(q) ||
            r.participants.some((p) => p.toLowerCase().includes(q))
        );
      }
      return rows;
    }
  );
}

export async function readMeeting(meetingId: string): Promise<MeetingDetail> {
  return safeInvoke("read_meeting", { meeting_id: meetingId }, () => {
    const list = _fixture("meetings");
    const found = list.find((m) => m.id === meetingId) ?? list[0];
    return {
      id: found.id,
      title: found.title,
      state: found.state,
      date: found.date,
      participants: found.participants.map((alias) => ({
        alias,
        display_name: alias[0].toUpperCase() + alias.slice(1),
      })),
      transcript_lines: found.transcript_lines,
      intents: found.participants.map((alias) => ({
        alias,
        ready: true,
        markdown: `# Intent — ${alias}\n\n## Topics\n\n- v1 scope decision\n- Whisper latency follow-up\n\n## Questions\n\n- Are we OK with the 1.2s p50?\n`,
      })),
      observations_md:
        "## L52 · disagreement-resolved\nL45..L52: scope debate\nResolved by daizhe overruling.\n\n## L141 · new-fact\nAdvisor reported Whisper CN latency.\n",
      summary_md: found.state === "wrapped" || found.state === "reviewed" || found.state === "merged"
        ? "# Summary — David sync\n\n## Decisions\n\n- v1 scope locked to Discord + Claude Code\n- Weekly TMA dogfood discipline\n\n## Action items\n\n- @daizhe ship Discord prototype by 2026-04-28\n"
        : null,
      diff_md: null,
      errors: [],
    };
  });
}

export async function createMeeting(args: {
  title: string;
  participants: string[];
  scheduled?: string;
  target?: string;
}): Promise<{ meeting_id: string }> {
  return safeInvoke(
    "run_tmi",
    {
      subcommand: "new",
      args: [
        args.title,
        "--participants",
        args.participants.join(","),
        ...(args.scheduled ? ["--scheduled", args.scheduled] : []),
        ...(args.target ? ["--target", args.target] : []),
      ],
    },
    () => {
      const slug = args.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
      const today = new Date().toISOString().slice(0, 10);
      return { meeting_id: `${today}-${slug}` };
    }
  );
}

// ----- review (RV-0) -----

export async function getReviewJson(meetingId: string): Promise<ReviewJson> {
  return safeInvoke(
    "run_tmi",
    { subcommand: "review", args: [meetingId, "--json"], capture: true },
    () => ({ ..._fixture("review"), meeting_id: meetingId })
  );
}

export async function applyReviewDecisions(
  meetingId: string,
  decisions: { approved: number[]; rejected: number[]; edited: Record<number, string> }
): Promise<void> {
  return safeInvoke(
    "apply_review_decisions",
    { meeting_id: meetingId, decisions },
    () => {
      console.info("[mock] apply_review_decisions", meetingId, decisions);
    }
  );
}

export async function applyMeeting(meetingId: string): Promise<{ commit_sha: string; written: number }> {
  return safeInvoke(
    "run_tmi",
    { subcommand: "apply", args: [meetingId] },
    async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { commit_sha: "abc1234", written: 3 };
    }
  );
}

// ----- transcript / observation tail (LV-0) -----

export interface TailHandle {
  unsubscribe: () => void;
}

export async function tailFile(
  path: string,
  onLine: (line: string) => void
): Promise<TailHandle> {
  if (!inTauri()) {
    // Mock streaming
    const fixtures = [
      "[2026-04-24 14:01:02] daizhe: alright let's start",
      "[2026-04-24 14:01:18] hongyu: ok intent locked",
      "[2026-04-24 14:01:42] daizhe: topic 1 — v1 scope",
    ];
    let i = 0;
    const t = setInterval(() => {
      if (i < fixtures.length) onLine(fixtures[i++]);
      else clearInterval(t);
    }, 600);
    return { unsubscribe: () => clearInterval(t) };
  }
  const { listen } = await import("@tauri-apps/api/event");
  const { tail_id } = await realInvoke<{ tail_id: string }>("tail_file", { path });
  const un = await listen<{ line: string }>(`fs:tail:${tail_id}`, (e) => onLine(e.payload.line));
  return {
    unsubscribe: () => {
      un();
      void realInvoke("untail_file", { tail_id });
    },
  };
}

// ----- prep streaming (PR-0) -----

export interface RunHandle {
  runId: string;
  send: (text: string) => Promise<void>;
  kill: () => Promise<void>;
  onStdout: (cb: (line: string) => void) => () => void;
  onStderr: (cb: (line: string) => void) => () => void;
  onExit: (cb: (code: number) => void) => () => void;
}

export async function runTmiInteractive(
  subcommand: string,
  args: string[]
): Promise<RunHandle> {
  if (!inTauri()) {
    const stdoutCbs: Array<(l: string) => void> = [];
    const exitCbs: Array<(c: number) => void> = [];
    setTimeout(() => stdoutCbs.forEach((c) => c("[mock prep] hi — what's the meeting about?")), 200);
    return {
      runId: `mock-${Math.random().toString(36).slice(2)}`,
      send: async (t) => {
        setTimeout(() => stdoutCbs.forEach((c) => c(`[mock] echo: ${t}`)), 100);
        if (t.trim() === "done") {
          setTimeout(() => exitCbs.forEach((c) => c(0)), 200);
        }
      },
      kill: async () => exitCbs.forEach((c) => c(130)),
      onStdout: (cb) => {
        stdoutCbs.push(cb);
        return () => {
          const i = stdoutCbs.indexOf(cb);
          if (i >= 0) stdoutCbs.splice(i, 1);
        };
      },
      onStderr: () => () => {
        /* noop in mock */
      },
      onExit: (cb) => {
        exitCbs.push(cb);
        return () => {
          const i = exitCbs.indexOf(cb);
          if (i >= 0) exitCbs.splice(i, 1);
        };
      },
    };
  }
  const { listen } = await import("@tauri-apps/api/event");
  const { run_id } = await realInvoke<{ run_id: string }>("run_tmi", { subcommand, args });
  return {
    runId: run_id,
    send: async (text) => {
      await realInvoke("run_tmi_send_stdin", { run_id, text });
    },
    kill: async () => {
      await realInvoke("run_tmi_kill", { run_id, signal: "TERM" });
    },
    onStdout: (cb) => {
      let unsub: (() => void) | null = null;
      void listen<{ line: string }>(`tmi:stdout:${run_id}`, (e) => cb(e.payload.line)).then(
        (u) => (unsub = u)
      );
      return () => unsub?.();
    },
    onStderr: (cb) => {
      let unsub: (() => void) | null = null;
      void listen<{ line: string }>(`tmi:stderr:${run_id}`, (e) => cb(e.payload.line)).then(
        (u) => (unsub = u)
      );
      return () => unsub?.();
    },
    onExit: (cb) => {
      let unsub: (() => void) | null = null;
      void listen<{ code: number }>(`tmi:exit:${run_id}`, (e) => cb(e.payload.code)).then(
        (u) => (unsub = u)
      );
      return () => unsub?.();
    },
  };
}

// ----- system: export debug bundle -----

export async function exportDebugBundle(destPath: string): Promise<{ zip_path: string; file_count: number }> {
  return safeInvoke("export_debug_bundle", { dest_path: destPath }, () => ({
    zip_path: destPath,
    file_count: 7,
  }));
}

// ============================================================
// v1.8 Phase 2-C — Notion / Loom / Zoom (read-side connectors)
// ============================================================
//
// Each setup page reads its config via the *_get_config wrapper, validates
// the bearer secret via *_validate_*, then writes the editable fields via
// *_set_config. The actual ingest is invoked by the daemon heartbeat (see
// app/src-tauri/src/daemon.rs) — these wrappers also expose a manual
// *_capture entry the UI uses for "Sync now" buttons.

export interface NotionConfig {
  token_present: boolean;
  database_ids: string[];
  decisions_db_id?: string | null;
  capture_enabled: boolean;
  writeback_enabled: boolean;
  last_sync?: string | null;
}

export interface NotionDb {
  id: string;
  title: string;
}

export interface NotionAtom {
  path: string;
  page_id: string;
  database_id: string;
  title: string;
  last_edited_time: string;
  preview: string;
}

export async function notionGetConfig(): Promise<NotionConfig> {
  return safeInvoke("notion_get_config", undefined, () => ({
    token_present: false,
    database_ids: [],
    decisions_db_id: null,
    capture_enabled: true,
    writeback_enabled: false,
    last_sync: null,
  }));
}

export async function notionSetConfig(args: {
  database_ids: string[];
  decisions_db_id?: string | null;
  capture_enabled: boolean;
  writeback_enabled: boolean;
}): Promise<void> {
  return safeInvoke("notion_set_config", args, () => {
    console.info("[mock] notion_set_config", args);
  });
}

export async function notionValidateToken(): Promise<{
  ok: boolean;
  bot_name?: string | null;
  error?: string | null;
}> {
  return safeInvoke("notion_validate_token", undefined, () => ({
    ok: false,
    bot_name: null,
    error: "no Tauri bridge",
  }));
}

export async function notionListDatabases(): Promise<NotionDb[]> {
  return safeInvoke("notion_list_databases", undefined, () => []);
}

export async function notionCapture(args: {
  memory_root: string;
  project?: string;
}): Promise<{
  written: number;
  atoms: NotionAtom[];
  errors: string[];
}> {
  return safeInvoke("notion_capture", args, () => ({
    written: 0,
    atoms: [],
    errors: ["no Tauri bridge"],
  }));
}

export async function notionWritebackDecision(args: {
  atom_path: string;
  db_id?: string | null;
}): Promise<{
  created: boolean;
  page_id?: string | null;
  idempotent_hit: boolean;
}> {
  return safeInvoke("notion_writeback_decision", args, () => ({
    created: false,
    page_id: null,
    idempotent_hit: false,
  }));
}

// ----- Loom -----

export interface LoomConfig {
  token_present: boolean;
  watched_folders: string[];
  capture_enabled: boolean;
  last_sync?: string | null;
}

export interface LoomAtom {
  path: string;
  video_id: string;
  url: string;
  title: string;
  created_at: string;
  transcript_chars: number;
}

export async function loomGetConfig(): Promise<LoomConfig> {
  return safeInvoke("loom_get_config", undefined, () => ({
    token_present: false,
    watched_folders: [],
    capture_enabled: true,
    last_sync: null,
  }));
}

export async function loomSetConfig(args: {
  watched_folders: string[];
  capture_enabled: boolean;
}): Promise<void> {
  return safeInvoke("loom_set_config", args, () => {
    console.info("[mock] loom_set_config", args);
  });
}

export async function loomValidateToken(): Promise<{
  ok: boolean;
  workspace?: string | null;
  error?: string | null;
}> {
  return safeInvoke("loom_validate_token", undefined, () => ({
    ok: false,
    workspace: null,
    error: "no Tauri bridge",
  }));
}

export async function loomPullTranscript(loom_url: string): Promise<{
  video_id: string;
  transcript: string;
}> {
  return safeInvoke("loom_pull_transcript", { loom_url }, () => ({
    video_id: "mock",
    transcript: "(mock transcript)",
  }));
}

export async function loomCapture(memory_root: string): Promise<{
  written: number;
  atoms: LoomAtom[];
  errors: string[];
}> {
  return safeInvoke("loom_capture", { memory_root }, () => ({
    written: 0,
    atoms: [],
    errors: ["no Tauri bridge"],
  }));
}

// ----- Zoom -----

export interface ZoomConfig {
  account_id_present: boolean;
  client_id_present: boolean;
  client_secret_present: boolean;
  capture_enabled: boolean;
  lookback_days: number;
  last_sync?: string | null;
}

export interface ZoomMeetingAtom {
  path: string;
  meeting_id: string;
  topic: string;
  start_time: string;
  duration_min: number;
  transcript_chars: number;
}

export async function zoomGetConfig(): Promise<ZoomConfig> {
  return safeInvoke("zoom_get_config", undefined, () => ({
    account_id_present: false,
    client_id_present: false,
    client_secret_present: false,
    capture_enabled: true,
    lookback_days: 7,
    last_sync: null,
  }));
}

export async function zoomSetConfig(args: {
  capture_enabled: boolean;
  lookback_days?: number;
}): Promise<void> {
  return safeInvoke("zoom_set_config", args, () => {
    console.info("[mock] zoom_set_config", args);
  });
}

export async function zoomValidateCredentials(): Promise<{
  ok: boolean;
  account_email?: string | null;
  error?: string | null;
}> {
  return safeInvoke("zoom_validate_credentials", undefined, () => ({
    ok: false,
    account_email: null,
    error: "no Tauri bridge",
  }));
}

export async function zoomCapture(memory_root: string): Promise<{
  written: number;
  atoms: ZoomMeetingAtom[];
  errors: string[];
}> {
  return safeInvoke("zoom_capture", { memory_root }, () => ({
    written: 0,
    atoms: [],
    errors: ["no Tauri bridge"],
  }));
}

// ============================================================
// v1.8 Phase 2-D — Email source (IMAP digest) + Voice notes
// ============================================================

export interface EmailConfig {
  provider: "gmail" | "outlook" | "imap";
  username: string;
  app_password?: string | null;
  fetch_lookback_days?: number;
  host?: string | null;
  port?: number | null;
}

export interface EmailTestConnectionResult {
  ok: boolean;
  host: string;
  port: number;
  error: string | null;
  stored_password: boolean;
}

export interface EmailFetchResult {
  threads_written: number;
  messages_seen: number;
  provider: string;
}

/**
 * Validate the IMAP credentials and store the app password in the OS
 * keychain on success. Returns a structured `{ok, error}` result rather
 * than throwing — the UI surfaces the error inline.
 */
export async function emailTestConnection(
  config: EmailConfig
): Promise<EmailTestConnectionResult> {
  return safeInvoke("email_test_connection", { config }, () => ({
    ok: false,
    host: config.host ?? "",
    port: config.port ?? 993,
    error: "no Tauri bridge",
    stored_password: false,
  }));
}

/**
 * Manual fetch trigger — the daemon already runs this once a day. Useful
 * for the "fetch now" button in the email setup page.
 */
export async function emailFetchRecent(config: EmailConfig): Promise<EmailFetchResult> {
  return safeInvoke("email_fetch_recent", { config }, () => ({
    threads_written: 0,
    messages_seen: 0,
    provider: config.provider,
  }));
}

export interface VoiceAtom {
  recorded_at: string;
  duration_sec: number;
  transcript: string;
  source: string;
  mime_type: string;
  file_path: string;
}

export interface VoiceListItem {
  slug: string;
  recorded_at: string;
  duration_sec: number;
  path: string;
}

/**
 * Decode the base64 audio blob, run it through the bundled Whisper, and
 * write a markdown atom under `~/.tangerine-memory/threads/voice/`.
 * Returns the atom (with `file_path`) so the recorder can navigate to it.
 */
export async function voiceNotesRecordAndTranscribe(
  audio_b64: string,
  mime_type: string
): Promise<VoiceAtom> {
  return safeInvoke(
    "voice_notes_record_and_transcribe",
    { audio_b64, mime_type },
    () => ({
      recorded_at: new Date().toISOString(),
      duration_sec: 0,
      transcript: "(mock transcript — Tauri bridge not available)",
      source: "voice-notes",
      mime_type,
      file_path: "~/.tangerine-memory/threads/voice/mock.md",
    })
  );
}

export async function voiceNotesListRecent(): Promise<VoiceListItem[]> {
  return safeInvoke("voice_notes_list_recent", undefined, () => []);
}

// ============================================================
// v1.8 Phase 2-B — Slack + Calendar writeback
// ============================================================
//
// All three commands are fire-and-forget from the React side: success
// returns void, errors surface via the global toast pipeline. The Rust side
// is the single point that knows about the keychain-stored Slack bot token
// and Google OAuth refresh token; we never round-trip secrets through here.

/**
 * Post a pre-meeting brief to Slack for the meeting whose decision atom
 * lives at `decisionPath`. Pass an empty `channelId` to fall back to the
 * channel encoded in the atom's `slack_channel` frontmatter.
 */
export async function slackWritebackBrief(
  decisionPath: string,
  channelId: string
): Promise<void> {
  return safeInvoke(
    "slack_writeback_brief",
    { decisionPath, channelId },
    () => {
      // eslint-disable-next-line no-console
      console.info("[mock] slack_writeback_brief", { decisionPath, channelId });
    }
  );
}

/** Post a finalized-meeting summary (decisions + action items) to Slack. */
export async function slackWritebackSummary(
  meetingPath: string,
  channelId: string
): Promise<void> {
  return safeInvoke(
    "slack_writeback_summary",
    { meetingPath, channelId },
    () => {
      // eslint-disable-next-line no-console
      console.info("[mock] slack_writeback_summary", { meetingPath, channelId });
    }
  );
}

/**
 * Append a `Meeting summary (Tangerine)` block to the original Google
 * Calendar event description. Idempotent — the Rust side detects the
 * sentinel and skips a second append.
 */
export async function calendarWritebackSummary(
  meetingPath: string,
  eventId: string
): Promise<void> {
  return safeInvoke(
    "calendar_writeback_summary",
    { meetingPath, eventId },
    () => {
      // eslint-disable-next-line no-console
      console.info("[mock] calendar_writeback_summary", { meetingPath, eventId });
    }
  );
}

// ============================================================
// v1.8 Phase 2-A — Writeback (GitHub + Linear)
// ============================================================

/**
 * Result shape returned by both `writeback_decision` and the auto-watcher's
 * `writeback:event` event payload. Tagged union — the discriminator is
 * `status`. Mirrors `crate::sources::WritebackOutcome` exactly.
 */
export type WritebackOutcome =
  | { status: "posted"; external_url: string; kind: string }
  | { status: "already_done"; external_url: string }
  | { status: "not_applicable"; reason: string }
  | { status: "disabled" }
  | { status: "failed"; error: string };

export interface WritebackLogEntry {
  decision_path: string;
  source: string;
  external_id: string;
  outcome: WritebackOutcome;
  ts: string;
}

export interface ReadWritebackLogResult {
  entries: WritebackLogEntry[];
  log_path: string;
}

/**
 * Trigger writeback for one decision file. Path may be absolute or
 * relative to the memory root (`decisions/<file>.md`). Idempotent — a
 * second call for the same decision returns `already_done`.
 */
export async function writebackDecision(decisionPath: string): Promise<WritebackOutcome> {
  return safeInvoke(
    "writeback_decision",
    { args: { decision_path: decisionPath } },
    () => ({
      status: "not_applicable" as const,
      reason: "Tauri bridge not available — mock writeback skipped.",
    })
  );
}

/** Read the most-recent writeback log entries. Default limit 5. */
export async function readWritebackLog(args: {
  limit?: number;
  source?: "github" | "linear";
}): Promise<ReadWritebackLogResult> {
  return safeInvoke(
    "read_writeback_log",
    { args: { limit: args.limit ?? 5, source: args.source ?? null } },
    () => ({ entries: [], log_path: "(mock)" })
  );
}

/**
 * Toggle the filesystem watcher that automatically posts writebacks when
 * decisions land. Returns the resulting `running` state. The Sources/<source>
 * page calls this whenever the user flips the per-source toggle AND ALSO
 * persists the change to `~/.tmi/config.yaml` so cold launches restore it.
 */
export async function setWritebackWatcher(enabled: boolean): Promise<{ running: boolean }> {
  return safeInvoke(
    "set_writeback_watcher",
    { args: { enabled } },
    () => ({ running: enabled })
  );
}

// ============================================================
// Phase 3-C: co-thinker consumers
// ============================================================
//
// MERGE-WATCH: P3-B (sibling agent) owns the Rust handlers for these four
// commands. While P3-B is in flight, the safeInvoke fallbacks below keep the
// UI compiling and the empty/error states actionable. Once P3-B lands, the
// real handlers take over transparently — no UI change required.
//
// All four commands operate on `~/.tangerine-memory/agi/co-thinker.md`,
// the single brain doc the AGI heartbeat writes / re-reads each tick.

/**
 * Status snapshot of the co-thinker brain. `last_heartbeat_at` may be `null`
 * on a fresh install where no heartbeat has fired yet — the UI uses that as
 * the cue to render the "Initialize co-thinker" empty state.
 */
export interface CoThinkerStatus {
  /** ISO 8601 timestamp of the most recent heartbeat write. */
  last_heartbeat_at: string | null;
  /** ISO 8601 timestamp of the next scheduled heartbeat. */
  next_heartbeat_at: string | null;
  /** Size of `co-thinker.md` on disk, in bytes. */
  brain_doc_size: number;
  /** Number of new atoms observed since UTC midnight. */
  observations_today: number;
}

/**
 * Per-heartbeat outcome. `error` is non-null when the upstream AI tool
 * surfaced a failure (rate-limit, broker disconnect, etc.); the UI surfaces
 * it via toast.
 */
export interface HeartbeatOutcome {
  /** Atoms the brain ingested this tick (approximated from cursor delta). */
  atoms_seen: number;
  /** True when the brain doc was rewritten this tick. */
  brain_updated: boolean;
  /** Number of `proposals/` atoms the brain emitted this tick. */
  proposals_created: number;
  /** Channel used for the upstream call ("mcp", "browser_ext", "ide_plugin", "local_http"). */
  channel_used: string;
  /** Wall-clock latency of the heartbeat round trip, in milliseconds. */
  latency_ms: number;
  /** Surface-level error string when the heartbeat failed; null on success. */
  error: string | null;
}

/**
 * Read the brain doc as a single markdown string. Returns "" when the file
 * doesn't exist yet (fresh install) — the UI uses an empty return as the
 * empty-state trigger. P3-B handler is `co_thinker_read_brain`.
 */
export async function coThinkerReadBrain(): Promise<string> {
  return safeInvoke("co_thinker_read_brain", undefined, () => "");
}

/**
 * Persist a manual edit of the brain doc. The next heartbeat reads this
 * back as authoritative state. P3-B handler is `co_thinker_write_brain`.
 */
export async function coThinkerWriteBrain(content: string): Promise<void> {
  return safeInvoke("co_thinker_write_brain", { content }, () => {
    // eslint-disable-next-line no-console
    console.info("[mock] co_thinker_write_brain", `${content.length} chars`);
  });
}

/**
 * Manually fire a heartbeat now (out-of-band; the daemon usually owns the
 * 5-min cadence). `primaryToolId` lets the UI pin the brain to the user's
 * starred tool so the channel doesn't drift mid-session. P3-B handler is
 * `co_thinker_trigger_heartbeat`.
 */
export async function coThinkerTriggerHeartbeat(
  primaryToolId?: string,
): Promise<HeartbeatOutcome> {
  return safeInvoke(
    "co_thinker_trigger_heartbeat",
    { primary_tool_id: primaryToolId ?? null },
    () => ({
      atoms_seen: 0,
      brain_updated: false,
      proposals_created: 0,
      channel_used: "(mock)",
      latency_ms: 0,
      error:
        "Co-thinker bridge isn't wired yet — Phase 3 backend (P3-B) hasn't landed.",
    }),
  );
}

/**
 * Read the brain status (last/next heartbeat, doc size, today's observation
 * count). P3-B handler is `co_thinker_status`. Returns a "never-fired"
 * snapshot in the mock path so the UI can render the empty state.
 */
export async function coThinkerStatus(): Promise<CoThinkerStatus> {
  return safeInvoke("co_thinker_status", undefined, () => ({
    last_heartbeat_at: null,
    next_heartbeat_at: null,
    brain_doc_size: 0,
    observations_today: 0,
  }));
}
