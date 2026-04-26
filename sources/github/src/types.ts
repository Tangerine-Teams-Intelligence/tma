// Atom schema (sources/README.md) + GitHub-specific helpers.

export type AtomKind =
  | "pr_opened"
  | "pr_updated"
  | "pr_review"
  | "pr_comment"
  | "pr_merged"
  | "pr_closed"
  | "issue_opened"
  | "issue_commented"
  | "issue_closed"
  | "decision";

export interface AtomGithubRef {
  repo: string; // "org/name"
  pr?: number;
  issue?: number;
  comment_id?: number;
  review_id?: number;
  url?: string;
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
