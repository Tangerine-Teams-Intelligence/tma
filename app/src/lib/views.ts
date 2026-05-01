/**
 * Stage 1 Wave 3 — typed wrappers for the view-layer Tauri commands.
 *
 * Mirrors `app/src-tauri/src/commands/views.rs`. Outside Tauri (vitest, vite
 * dev) every wrapper falls back to a deterministic mock so the UI shape stays
 * usable without a running daemon.
 *
 * Stage 2 hook §5: every response carries a `notes` array. Stage 1 = `[]`
 * — the reasoning loop fills these in Stage 2 with proactive insights
 * surfaced in the UI's <TangerineNotes/> reserved area.
 */

const inTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function realInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

async function safeInvoke<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T,
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    return await realInvoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tauri/views] invoke "${cmd}" failed:`, e, "args=", args);
    return await mock();
  }
}

// === v1.13.8 round-8 ===
// Round 8 audit: views.ts hosts every primary read for /today, /this-week,
// /alignment, /people, /projects, /threads, the /people|projects|threads
// detail pages, ProjectTopology, and WhatsNewBanner. The original
// `safeInvoke` swallowed Tauri-side errors and silently returned mock
// shapes (zero events, empty rosters, fake timeline rows featuring
// "daizhe / hongyu / v1-launch" — the exact same fake fingerprint R7
// caught in atoms.ts). Six of those callers already had `.catch` /
// `setError` UIs that were dead code in production for the same reason
// the graphs' error UIs were dead in R7: the wrapper never threw.
//
// `invokeOrViewError` re-throws inside Tauri so those error UIs actually
// fire; outside Tauri (vitest / vite dev) the mock still runs so the
// dev surface stays usable. Best-effort writes (mark_atom_viewed /
// mark_atom_acked / mark_user_opened) keep `safeInvoke` — a cursor
// write failure shouldn't take down the route the user is reading.
async function invokeOrViewError<T>(
  cmd: string,
  args: Record<string, unknown> | undefined,
  mock: () => Promise<T> | T,
): Promise<T> {
  if (!inTauri()) return await mock();
  try {
    return await realInvoke<T>(cmd, args);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`[tauri/views] invoke "${cmd}" failed:`, e, "args=", args);
    // Re-throw so the load-bearing route .catch handlers (people/index,
    // projects/index, threads/index, alignment, projects/detail, etc.)
    // render their honest error state instead of empty mock data.
    throw e;
  }
}
// === end v1.13.8 round-8 ===

// ---------- shared types ----------

export interface TimelineEvent {
  id: string;
  ts: string;
  source: string;
  actor: string;
  actors: string[];
  kind: string;
  refs: {
    meeting?: string;
    decisions?: string[];
    people?: string[];
    projects?: string[];
    threads?: string[];
  } | Record<string, unknown>;
  status: string;
  file?: string | null;
  line?: number | null;
  body?: string | null;
  lifecycle?: Record<string, unknown> | null;
  sample: boolean;
  /** Stage 2 hooks. Stage 1 default = 1.0; we hide the badge when 1.0. */
  confidence: number;
  concepts: string[];
  alternatives: unknown[];
  source_count: number;
}

export interface TangerineNote {
  id: string;
  text: string;
  severity?: "info" | "warn" | "alert";
  cta?: { label: string; href?: string };
}

// ---------- timeline reads ----------

export interface TimelineSlice {
  date: string;
  events: TimelineEvent[];
  notes: TangerineNote[];
}

export async function readTimelineToday(date?: string): Promise<TimelineSlice> {
  // === v1.13.8 round-8 === — load-bearing: feeds /today notes + activity feed
  return invokeOrViewError("read_timeline_today", { date }, () => ({
    date: date ?? new Date().toISOString().slice(0, 10),
    events: mockTodayEvents(),
    notes: [],
  }));
}

export interface TimelineRecent {
  events: TimelineEvent[];
  notes: TangerineNote[];
}

export async function readTimelineRecent(limit?: number): Promise<TimelineRecent> {
  // === v1.13.8 round-8 === — load-bearing: /this-week + /alignment
  return invokeOrViewError("read_timeline_recent", { limit }, () => ({
    events: mockRecentEvents(),
    notes: [],
  }));
}

// ---------- briefs ----------

export interface BriefData {
  date: string;
  markdown: string | null;
  exists: boolean;
  notes: TangerineNote[];
}

export async function readBrief(date?: string): Promise<BriefData> {
  // === v1.13.8 round-8 === — load-bearing: daily brief content
  return invokeOrViewError("read_brief", { date }, () => ({
    date: date ?? new Date().toISOString().slice(0, 10),
    markdown: null,
    exists: false,
    notes: [],
  }));
}

// ---------- alignment ----------

export interface AlignmentSnapshot {
  computed_at: string | null;
  users: string[];
  total_atoms: number;
  shared_viewed: number;
  rate: number;
  per_user_seen: Record<string, number>;
}

export interface AlignmentData {
  latest: AlignmentSnapshot;
  history: AlignmentSnapshot[];
  notes: TangerineNote[];
}

export async function readAlignment(): Promise<AlignmentData> {
  // === v1.13.8 round-8 === — load-bearing: /alignment is a primary trust surface
  return invokeOrViewError("read_alignment", undefined, () => ({
    latest: {
      computed_at: null,
      users: [],
      total_atoms: 0,
      shared_viewed: 0,
      rate: 0,
      per_user_seen: {},
    },
    history: [],
    notes: [],
  }));
}

// ---------- pending alerts (inbox) ----------

export interface PendingAlert {
  id: string;
  kind: string;
  title: string;
  body: string;
  created_at?: string | null;
  due_at?: string | null;
  severity?: string | null;
}

export interface PendingAlertsData {
  alerts: PendingAlert[];
  notes: TangerineNote[];
}

export async function readPendingAlerts(): Promise<PendingAlertsData> {
  // === v1.13.8 round-8 === — load-bearing: silently empty alerts = "all clear" lie
  return invokeOrViewError("read_pending_alerts", undefined, () => ({
    alerts: [],
    notes: [],
  }));
}

// ---------- people ----------

export interface PersonRow {
  alias: string;
  last_active: string | null;
  atom_count: number;
  same_screen_rate: number | null;
}

export interface PeopleListData {
  people: PersonRow[];
  notes: TangerineNote[];
}

export async function readPeopleList(): Promise<PeopleListData> {
  // === v1.13.8 round-8 === — load-bearing: /people index has armed setError UI
  return invokeOrViewError("read_people_list", undefined, () => ({
    people: [],
    notes: [],
  }));
}

export interface PersonDetailData {
  alias: string;
  recent_events: TimelineEvent[];
  mentioned_projects: string[];
  mentioned_threads: string[];
  notes: TangerineNote[];
}

export async function readPerson(alias: string): Promise<PersonDetailData> {
  // === v1.13.8 round-8 === — load-bearing: detail page
  return invokeOrViewError("read_person", { alias }, () => ({
    alias,
    recent_events: [],
    mentioned_projects: [],
    mentioned_threads: [],
    notes: [],
  }));
}

// ---------- projects ----------

export interface ProjectRow {
  slug: string;
  last_active: string | null;
  atom_count: number;
  member_count: number;
}

export interface ProjectListData {
  projects: ProjectRow[];
  notes: TangerineNote[];
}

export async function readProjectsList(): Promise<ProjectListData> {
  // === v1.13.8 round-8 === — load-bearing: /projects index has armed setError UI
  return invokeOrViewError("read_projects_list", undefined, () => ({
    projects: [],
    notes: [],
  }));
}

export interface ProjectDetailData {
  slug: string;
  recent_events: TimelineEvent[];
  members: string[];
  threads: string[];
  notes: TangerineNote[];
}

export async function readProject(slug: string): Promise<ProjectDetailData> {
  // === v1.13.8 round-8 === — load-bearing: detail page
  return invokeOrViewError("read_project", { slug }, () => ({
    slug,
    recent_events: [],
    members: [],
    threads: [],
    notes: [],
  }));
}

// ---------- threads ----------

export interface ThreadRow {
  topic: string;
  last_active: string | null;
  atom_count: number;
}

export interface ThreadListData {
  threads: ThreadRow[];
  notes: TangerineNote[];
}

export async function readThreadsList(): Promise<ThreadListData> {
  // === v1.13.8 round-8 === — load-bearing: /threads index has armed setError UI
  return invokeOrViewError("read_threads_list", undefined, () => ({
    threads: [],
    notes: [],
  }));
}

export interface ThreadDetailData {
  topic: string;
  events: TimelineEvent[];
  members: string[];
  notes: TangerineNote[];
}

export async function readThread(topic: string): Promise<ThreadDetailData> {
  // === v1.13.8 round-8 === — load-bearing: detail page
  return invokeOrViewError("read_thread", { topic }, () => ({
    topic,
    events: [],
    members: [],
    notes: [],
  }));
}

// ---------- cursor writes ----------

export interface CursorSummary {
  user: string;
  last_opened_at: string | null;
  atoms_viewed_count: number;
  atoms_acked_count: number;
}

export async function markAtomViewed(
  user: string,
  atomId: string,
): Promise<CursorSummary> {
  return safeInvoke(
    "mark_atom_viewed",
    { user, atom_id: atomId },
    () => ({
      user,
      last_opened_at: null,
      atoms_viewed_count: 1,
      atoms_acked_count: 0,
    }),
  );
}

export async function markAtomAcked(
  user: string,
  atomId: string,
): Promise<CursorSummary> {
  return safeInvoke(
    "mark_atom_acked",
    { user, atom_id: atomId },
    () => ({
      user,
      last_opened_at: null,
      atoms_viewed_count: 1,
      atoms_acked_count: 1,
    }),
  );
}

export async function markUserOpened(user: string): Promise<CursorSummary> {
  return safeInvoke("mark_user_opened", { user }, () => ({
    user,
    last_opened_at: new Date().toISOString(),
    atoms_viewed_count: 0,
    atoms_acked_count: 0,
  }));
}

export interface CursorSnapshot {
  user: string;
  last_opened_at: string | null;
  viewed: string[];
  acked: string[];
  deferred: string[];
  preferences: Record<string, unknown>;
}

export async function readCursor(user: string): Promise<CursorSnapshot> {
  return safeInvoke("read_cursor", { user }, () => ({
    user,
    last_opened_at: null,
    viewed: [],
    acked: [],
    deferred: [],
    preferences: {
      brief_style: "default",
      brief_time: "08:00",
      notification_channels: ["os", "email"],
      topics_of_interest: [],
      topics_to_skip: [],
    },
  }));
}

// ---------- v1.21.0 manual capture (Operability surface B) ----------

export type ManualAtomKind = "decision" | "note" | "task";

export interface CaptureManualAtomOut {
  event: TimelineEvent;
  path: string;
}

/**
 * Write a user-typed thought / decision / note into the timeline. The
 * Tauri command writes a markdown atom to disk and synthesises a row
 * onto `timeline.json` so the next `readTimelineRecent` reload surfaces
 * it without waiting for the daemon's 5-min Python `index-rebuild`.
 *
 * Outside Tauri (vitest / vite dev) the wrapper synthesises a fake
 * event so the UI reload still reflects the optimistic prepend.
 */
export async function captureManualAtom(
  user: string,
  body: string,
  kind: ManualAtomKind,
  actor?: string,
): Promise<CaptureManualAtomOut> {
  return invokeOrViewError(
    "capture_manual_atom",
    { user, body, kind, actor },
    () => {
      const now = new Date();
      const id = `evt-${now.toISOString().slice(0, 10)}-${
        Math.random().toString(16).slice(2, 14)
      }`;
      const safeIso = now.toISOString().replace(/:/g, "-").replace(/\+/g, "_");
      const event: TimelineEvent = {
        id,
        ts: now.toISOString(),
        source: "manual",
        actor: actor ?? user,
        actors: [actor ?? user],
        kind,
        refs: {},
        status: "active",
        file: `personal/${user}/threads/manual/${safeIso}.md`,
        line: null,
        body: body.split("\n").slice(0, 8).join("\n"),
        sample: false,
        confidence: 1,
        concepts: [],
        alternatives: [],
        source_count: 1,
      };
      return { event, path: event.file ?? "" };
    },
  );
}

// ---------- whats-new diff ----------

export interface WhatsNewData {
  since: string | null;
  new_events: TimelineEvent[];
  count: number;
  notes: TangerineNote[];
}

export async function readWhatsNew(user: string): Promise<WhatsNewData> {
  // === v1.13.8 round-8 === — load-bearing: WhatsNewBanner gates startup banner
  return invokeOrViewError("read_whats_new", { user }, () => ({
    since: null,
    new_events: [],
    count: 0,
    notes: [],
  }));
}

// ---------- formatting helpers (used by components + tested directly) ----------

/** "just now" / "5 min ago" / "2 hr ago" / "3 d ago". Tiny, no deps. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "recently";
  const seconds = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (seconds < 30) return "just now";
  if (seconds < 90) return "1 min ago";
  if (seconds < 60 * 60) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 60 * 60 * 24) return `${Math.floor(seconds / 3600)} hr ago`;
  return `${Math.floor(seconds / (60 * 60 * 24))} d ago`;
}

/** "HH:MM" extracted from an ISO/RFC3339 timestamp; "??:??" on parse fail. */
export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "??:??";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (!m) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "??:??";
    return d.toISOString().slice(11, 16);
  }
  return `${m[1]}:${m[2]}`;
}

/** Bucket events by date (YYYY-MM-DD) for the activity feed grouping. */
export function bucketByDate(events: TimelineEvent[]): { date: string; events: TimelineEvent[] }[] {
  const buckets: Record<string, TimelineEvent[]> = {};
  for (const ev of events) {
    const d = (ev.ts || "").slice(0, 10) || "unknown";
    (buckets[d] ??= []).push(ev);
  }
  const dates = Object.keys(buckets).sort((a, b) => b.localeCompare(a));
  return dates.map((d) => ({ date: d, events: buckets[d] }));
}

/** Aggregations used by /this-week. */
export interface WeekStats {
  meetings: number;
  decisions: number;
  prs: number;
  comments: number;
  tickets: number;
  total: number;
  by_member: Record<string, number>;
}

export function computeWeekStats(events: TimelineEvent[]): WeekStats {
  const stats: WeekStats = {
    meetings: 0,
    decisions: 0,
    prs: 0,
    comments: 0,
    tickets: 0,
    total: 0,
    by_member: {},
  };
  for (const ev of events) {
    if (ev.sample) continue;
    stats.total += 1;
    if (ev.kind === "meeting_chunk") stats.meetings += 1;
    else if (ev.kind === "decision") stats.decisions += 1;
    else if (ev.kind === "pr_event") stats.prs += 1;
    else if (ev.kind === "comment") stats.comments += 1;
    else if (ev.kind === "ticket_event") stats.tickets += 1;
    const seen = new Set<string>();
    if (ev.actor) seen.add(ev.actor);
    for (const a of ev.actors) seen.add(a);
    for (const a of seen) {
      stats.by_member[a] = (stats.by_member[a] ?? 0) + 1;
    }
  }
  return stats;
}

// ---------- mocks ----------

function mockTodayEvents(): TimelineEvent[] {
  const today = new Date().toISOString().slice(0, 10);
  return [
    {
      id: `evt-${today}-mock000001`,
      ts: `${today}T09:30:15Z`,
      source: "github",
      actor: "eric",
      actors: ["eric"],
      kind: "pr_event",
      refs: { projects: ["v1-launch"], threads: ["pr-47"] },
      status: "active",
      file: `timeline/${today}.md`,
      line: 1,
      body: "merged PR #47 — postgres-migration → main",
      sample: false,
      confidence: 1,
      concepts: [],
      alternatives: [],
      source_count: 1,
    },
    {
      id: `evt-${today}-mock000002`,
      ts: `${today}T10:15:42Z`,
      source: "discord",
      actor: "daizhe",
      actors: ["daizhe", "hongyu"],
      kind: "meeting_chunk",
      refs: { meeting: `${today}-david-sync`, projects: ["rms"] },
      status: "active",
      file: `timeline/${today}.md`,
      line: 12,
      body: "Cursor session: stage 1 wave 3 ux build",
      sample: false,
      confidence: 1,
      concepts: [],
      alternatives: [],
      source_count: 1,
    },
    {
      id: `evt-${today}-mock000003`,
      ts: `${today}T11:00:01Z`,
      source: "linear",
      actor: "sarah",
      actors: ["sarah"],
      kind: "ticket_event",
      refs: { projects: ["rms"] },
      status: "active",
      file: `timeline/${today}.md`,
      line: 26,
      body: "Closed 3 tickets in TM-RMS sprint",
      sample: false,
      confidence: 1,
      concepts: [],
      alternatives: [],
      source_count: 1,
    },
  ];
}

function mockRecentEvents(): TimelineEvent[] {
  const today = mockTodayEvents();
  const yest = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const yesterday: TimelineEvent = {
    id: `evt-${yest}-mock000099`,
    ts: `${yest}T17:42:00Z`,
    source: "slack",
    actor: "advisor",
    actors: ["advisor", "daizhe"],
    kind: "comment",
    refs: { threads: ["pricing"] },
    status: "active",
    file: `timeline/${yest}.md`,
    line: 47,
    body: "agreed: hold pricing at $99/mo through Q2",
    sample: false,
    confidence: 1,
    concepts: [],
    alternatives: [],
    source_count: 1,
  };
  return [...today.reverse(), yesterday];
}
