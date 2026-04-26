// Atom schema (sources/README.md + Module A SCHEMA.md) + GitHub-specific helpers.
//
// Module A is the source of truth for the kind vocabulary. GitHub events map
// onto the canonical Module A kinds:
//   pr_opened / pr_merged / pr_closed / pr_review → pr_event
//   pr_comment / issue_commented                  → comment
//   issue_opened / issue_closed                   → ticket_event
//   bodies that pass the decision sniffer         → decision
//
// The narrow upstream verb (opened/merged/closed/etc) lives in body markdown
// + refs.github.action so consumers can still tell them apart.

export type AtomKind =
  | "pr_event"
  | "comment"
  | "ticket_event"
  | "decision";

/** GitHub-side action verb — preserved on refs.github.action so the kind
 *  vocabulary stays narrow per Module A but downstream UX still knows whether
 *  a pr_event was open / merge / close / review. */
export type GithubAction =
  | "opened"
  | "merged"
  | "closed"
  | "review_approved"
  | "review_changes_requested"
  | "review_dismissed"
  | "review_commented"
  | "comment_created"
  | "issue_opened"
  | "issue_closed";

export interface AtomGithubRef {
  repo: string; // "org/name"
  pr?: number;
  issue?: number;
  comment_id?: number;
  review_id?: number;
  url?: string;
  /** Narrow upstream verb (preserved on the atom so we don't lose pr_opened
   *  vs pr_merged distinction when collapsing into Module A's `pr_event`). */
  action?: GithubAction;
}

export interface AtomRefs {
  github?: AtomGithubRef;
  meeting: string | null;
  decisions: string[];
  people: string[];
  projects: string[];
  threads: string[];
}

export interface Atom {
  /** Canonical Module-A id: ``evt-<YYYY-MM-DD>-<10-hex>`` from sha256(source|kind|source_id|ts).
   *  Computed by ``makeAtomId`` in normalize.ts. */
  id: string;
  ts: string; // RFC 3339 UTC
  source: "github";
  actor: string;
  actors: string[];
  kind: AtomKind;
  refs: AtomRefs;
  status: "active" | "superseded" | "archived";
  sample: boolean;
  body: string; // markdown body (no frontmatter delimiters)
  /** Stable source-side identifier that goes into the id hash. The Module A
   *  contract is sha256(source|kind|source_id|ts) — keeping the source_id on
   *  the atom lets the Python emit-atom recompute the same id deterministically. */
  source_id: string;

  // === Stage 2 AGI hooks (STAGE1_AGI_HOOKS.md §1) — Stage 1 ships defaults ===
  // Module A's validate_atom() injects these if absent, but we set them here
  // so the connector's atoms read identically before and after the hop.
  embedding?: number[] | null;
  concepts?: string[];
  confidence?: number;
  alternatives?: Array<Record<string, unknown>>;
  source_count?: number;
  reasoning_notes?: string | null;
  sentiment?: string | null;
  importance?: number | null;
}

/** Repo configuration entry. */
export interface RepoConfig {
  name: string; // "org/name"
  /** Optional project tag(s) to attach to every atom from this repo. */
  projects?: string[];
  /** Most-recent ts (RFC 3339 UTC) we've ingested for this repo. */
  cursor?: string;
}

export interface SourceConfig {
  schema_version: 1;
  poll_interval_sec: number;
  repos: RepoConfig[];
  /**
   * GitHub label prefix that maps to a project ref. e.g. label
   * "project:v1-launch" with prefix "project:" → projects: ["v1-launch"].
   */
  project_label_prefix: string;
  /**
   * Title prefix regex extracted as project. e.g. "[v1] foo" → "v1".
   * Default: `^\[([a-zA-Z0-9._-]+)\]`.
   */
  project_title_regex: string;
}

export type IdentityMap = Record<string, string>;

/** Default config for a fresh install. */
export function defaultConfig(): SourceConfig {
  return {
    schema_version: 1,
    poll_interval_sec: 60,
    repos: [],
    project_label_prefix: "project:",
    project_title_regex: "^\\[([a-zA-Z0-9._-]+)\\]",
  };
}
