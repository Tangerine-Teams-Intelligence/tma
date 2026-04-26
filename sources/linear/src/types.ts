// Atom schema (Module A canonical) + Linear-specific helpers.
//
// Module A is the source of truth for the kind vocabulary. Linear events
// map onto the canonical Module A kinds:
//   issue created / state-changed / assignee-changed / priority-changed → ticket_event
//   issue commented                                                     → comment
//   issue completed (with body matching decision sniffer)               → decision
//   project status changes                                              → ticket_event
//
// The narrow upstream verb (created/updated/completed/etc) lives on
// refs.linear.action so consumers can still tell them apart.

export type AtomKind =
  | "ticket_event"
  | "comment"
  | "decision";

export type LinearAction =
  | "issue_created"
  | "issue_state_changed"
  | "issue_assignee_changed"
  | "issue_priority_changed"
  | "issue_completed"
  | "issue_canceled"
  | "comment_created"
  | "project_state_changed";

export interface AtomLinearRef {
  /** Linear team key, e.g. "ENG". */
  team_key?: string;
  /** Issue identifier, e.g. "ENG-123". */
  issue_id?: string;
  /** Linear's internal UUID for the issue. */
  issue_uuid?: string;
  /** Linear's internal UUID for the comment, if applicable. */
  comment_uuid?: string;
  /** Project UUID + slug, if applicable. */
  project_uuid?: string;
  project_name?: string;
  /** Workflow state name (e.g. "In Progress"). */
  state?: string;
  /** Issue priority, 0=no priority through 4=low. */
  priority?: number;
  url?: string;
  /** Narrow upstream verb. */
  action?: LinearAction;
}

export interface AtomRefs {
  linear?: AtomLinearRef;
  meeting: string | null;
  decisions: string[];
  people: string[];
  projects: string[];
  threads: string[];
}

export interface Atom {
  /** Canonical Module-A id: ``evt-<YYYY-MM-DD>-<10-hex>`` from
   *  sha256(source|kind|source_id|ts). Computed by ``makeAtomId``. */
  id: string;
  ts: string; // RFC 3339 UTC
  source: "linear";
  actor: string;
  actors: string[];
  kind: AtomKind;
  refs: AtomRefs;
  status: "active" | "superseded" | "archived";
  sample: boolean;
  body: string;
  /** Stable upstream identifier; goes into the id hash. */
  source_id: string;

  // === Stage 2 AGI hooks (STAGE1_AGI_HOOKS.md §1) ===
  embedding?: number[] | null;
  concepts?: string[];
  confidence?: number;
  alternatives?: Array<Record<string, unknown>>;
  source_count?: number;
  reasoning_notes?: string | null;
  sentiment?: string | null;
  importance?: number | null;
}

/** Configured team to ingest. */
export interface TeamConfig {
  /** Team UUID from Linear. */
  uuid: string;
  /** Team key, e.g. "ENG". */
  key: string;
  /** Friendly name for the CLI list output. */
  name: string;
  /** Optional projects tag(s) attached to every atom from this team. */
  projects?: string[];
  /** Most-recent updatedAt (RFC 3339 UTC) we've ingested. */
  cursor?: string;
}

export interface SourceConfig {
  schema_version: 1;
  poll_interval_sec: number;
  teams: TeamConfig[];
  /**
   * Linear label prefix that maps to a project ref. Default `project:`.
   * label "project:v1-launch" → projects: ["v1-launch"].
   */
  project_label_prefix: string;
  /**
   * Title prefix regex extracted as project. e.g. "[v1] foo" → "v1".
   * Default: `^\[([a-zA-Z0-9._-]+)\]`.
   */
  project_title_regex: string;
}

export type IdentityMap = Record<string, string>;

export function defaultConfig(): SourceConfig {
  return {
    schema_version: 1,
    poll_interval_sec: 60,
    teams: [],
    project_label_prefix: "project:",
    project_title_regex: "^\\[([a-zA-Z0-9._-]+)\\]",
  };
}
