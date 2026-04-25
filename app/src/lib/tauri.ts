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
    // Likely "command not registered" while T3 is still wiring things up.
    // Surface in console but don't break the wizard flow.
    // eslint-disable-next-line no-console
    console.warn(`[tauri] ${cmd} failed, using mock:`, e);
    return await mock();
  }
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
  if (data.whisperKey) {
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

  return `# Generated by Tangerine AI Teams setup wizard.
schema_version: 1
discord:
  bot_token_env: DISCORD_BOT_TOKEN
  guild_id: ${d.guildId ? quote(d.guildId) : "null"}
whisper:
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
