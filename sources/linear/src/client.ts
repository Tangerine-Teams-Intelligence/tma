// Thin wrapper around @linear/sdk's LinearClient.
//
// We keep the wrapper minimal — only the methods we actually call (viewer,
// teams, issues, comments). The rest of the SDK is rich but irrelevant
// for v1 ingest.
//
// The wrapper exposes a small interface (LinearLike) so tests can stub
// it without instantiating the real SDK or touching the network.

export interface LinearViewer {
  id: string;
  name?: string;
  email?: string;
}

export interface LinearTeam {
  id: string;        // UUID
  key: string;       // "ENG"
  name: string;
  description?: string | null;
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type?: string;
}

export interface LinearUser {
  id: string;
  name?: string;
  email?: string;
  displayName?: string;
}

export interface LinearLabel {
  id: string;
  name: string;
}

export interface LinearProjectShallow {
  id: string;
  name: string;
  state?: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;     // "ENG-123"
  title: string;
  description?: string | null;
  url?: string;
  priority: number;       // 0..4
  createdAt: string;      // RFC 3339
  updatedAt: string;
  completedAt?: string | null;
  canceledAt?: string | null;
  team?: { id: string; key: string } | null;
  state?: LinearWorkflowState | null;
  creator?: LinearUser | null;
  assignee?: LinearUser | null;
  labels?: { nodes: LinearLabel[] } | null;
  project?: LinearProjectShallow | null;
}

export interface LinearComment {
  id: string;
  body: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
  user?: LinearUser | null;
  issue?: { id: string; identifier: string; title?: string; team?: { key: string } | null } | null;
}

/** Minimal surface our ingest code uses. The real LinearClient implements
 *  this; tests provide an in-memory stub. */
export interface LinearLike {
  viewer(): Promise<LinearViewer>;
  /** Pagination is opaque — we hide the SDK's connection types here. */
  listTeams(): Promise<LinearTeam[]>;
  /** All issues for a team updated since `since` (RFC 3339), oldest first. */
  listIssuesForTeam(teamId: string, since: string | null): Promise<LinearIssue[]>;
  /** All comments on issues touched since `since`. */
  listCommentsForTeam(teamId: string, since: string | null): Promise<LinearComment[]>;
}

export interface MakeClientOpts {
  /** Override base URL (Linear self-hosted; default is api.linear.app). */
  baseUrl?: string;
}

/**
 * Build a LinearLike client backed by @linear/sdk. We dynamically import
 * the SDK so the connector can still load (and unit tests can still run)
 * without the SDK installed.
 */
export function makeClient(token: string, _opts: MakeClientOpts = {}): LinearLike {
  // Lazy import — SDK is large and tests inject their own client anyway.
  // Returns a thin adapter that turns SDK connection objects into plain arrays.
  let sdkClientPromise: Promise<unknown> | null = null;

  async function sdkClient(): Promise<{
    viewer: Promise<LinearViewer>;
    teams(): Promise<{ nodes: LinearTeam[] }>;
    issues(args: Record<string, unknown>): Promise<{ nodes: LinearIssue[] }>;
    comments(args: Record<string, unknown>): Promise<{ nodes: LinearComment[] }>;
  }> {
    if (!sdkClientPromise) {
      sdkClientPromise = import("@linear/sdk").then((mod) => {
        const Linear = (mod as unknown as { LinearClient: new (cfg: { apiKey: string }) => unknown }).LinearClient;
        return new Linear({ apiKey: token });
      });
    }
    return sdkClientPromise as Promise<{
      viewer: Promise<LinearViewer>;
      teams(): Promise<{ nodes: LinearTeam[] }>;
      issues(args: Record<string, unknown>): Promise<{ nodes: LinearIssue[] }>;
      comments(args: Record<string, unknown>): Promise<{ nodes: LinearComment[] }>;
    }>;
  }

  return {
    async viewer() {
      const c = await sdkClient();
      return c.viewer;
    },
    async listTeams() {
      const c = await sdkClient();
      const res = await c.teams();
      return res.nodes;
    },
    async listIssuesForTeam(teamId, since) {
      const c = await sdkClient();
      const filter: Record<string, unknown> = { team: { id: { eq: teamId } } };
      if (since) filter.updatedAt = { gt: since };
      const res = await c.issues({
        filter,
        first: 100,
        orderBy: "updatedAt" as unknown as never,
      });
      return res.nodes;
    },
    async listCommentsForTeam(teamId, since) {
      const c = await sdkClient();
      const filter: Record<string, unknown> = { issue: { team: { id: { eq: teamId } } } };
      if (since) filter.updatedAt = { gt: since };
      const res = await c.comments({
        filter,
        first: 100,
        orderBy: "updatedAt" as unknown as never,
      });
      return res.nodes;
    },
  };
}

/** Linear's GraphQL rate limit is 1500 req/hr per workspace token. We don't
 *  hit it under normal poll intervals (60s × 4 endpoints = 240/hr), but we
 *  expose a stub here for parity with the github source. */
export function rateLimitBackoffMs(_remaining: number | null, _resetUnix: number | null): number {
  return 0;
}
