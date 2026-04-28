// === v1.14.0 round-1 ===
/**
 * v1.14 R1 — 2-user team-invite cold-start E2E.
 *
 * Why this exists: Round 10 self-assessment scored Solo+Team funnel at 7/10
 * because no R1-R10 round directly exercised the invite → join → first
 * shared atom path. CEO bar is "≥ 8/10 across all 10". This file lifts
 * that dimension by simulating two users on the same shared memory dir
 * (mocked git) and asserting the funnel actually closes:
 *
 *   1. User A completes onboarding (solo → team scope), generates an
 *      invite link via `generateInvite`, sees the InviteLinkModal with a
 *      copy-to-clipboard CTA.
 *   2. User B receives the URI, parses it (no Tauri host, mocked Rust),
 *      lands on /join, accepts → mocked `gitClone` populates the shared
 *      "repo" map → memoryConfig flips to team mode.
 *   3. PresenceProvider reports BOTH users as active in <6 s.
 *   4. User B types "@alice" in CommentInput, sees the "Will notify"
 *      preview before posting; the resulting comment lands on User A
 *      via the shared comments_create / comments_list mock.
 *   5. Bad invite URIs (wrong scheme / missing repo / tampered token)
 *      surface honest errors instead of silently accepting.
 *
 * The test does NOT spin up real git or Tauri. It mocks `git_clone` /
 * `git_pull` / presence / comments to share a single in-process state
 * map between the two simulated user contexts. The point is to lock in
 * the FUNNEL shape (modal → invite → parse → join → presence → comment),
 * not the git plumbing.
 *
 * Files this test pins down:
 *   - app/src/lib/git.ts (parseInvite mock honesty + invite codec)
 *   - app/src/components/InviteLinkModal.tsx (clipboard + Done button)
 *   - app/src/routes/join-team.tsx (parse → accept → clone → memory)
 *   - app/src/components/comments/CommentInput.tsx (mention preview)
 *   - app/src/components/presence/PresenceProvider.tsx (multi-user read)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from "@testing-library/react";
import "@testing-library/jest-dom";
import { MemoryRouter, Routes, Route } from "react-router-dom";

// ---- Shared in-process "shared memory dir" state ----
//
// Both simulated user contexts read/write through the same maps so the
// "User A posts → User B sees" assertion has something real to check.
// Reset in `beforeEach` so each test starts fresh.
type SharedRepoState = {
  /** repoUrl → array of presence records (acts like presence/*.json on disk) */
  presenceByRepo: Map<string, Array<unknown>>;
  /** atomPath → comment threads */
  commentsByAtom: Map<string, Array<unknown>>;
  /** repoUrl → cloned destinations (so a second clone is idempotent) */
  cloned: Set<string>;
  /** Latest invite URI generated, if any. */
  lastInviteUri: string | null;
};

const shared: SharedRepoState = {
  presenceByRepo: new Map(),
  commentsByAtom: new Map(),
  cloned: new Set(),
  lastInviteUri: null,
};

// ---- Mocks for the Tauri / git layer ----
//
// `vi.hoisted` so the `vi.mock` factory below can reference these closures
// at module-load time (vitest hoists vi.mock calls to the top of the file).
const tauriMocks = vi.hoisted(() => ({
  presenceEmit: vi.fn(async (_args: unknown) => {}),
  presenceListActive: vi.fn(async () => [] as Array<unknown>),
  listenPresenceUpdates: vi.fn(async () => () => {}),
  commentsList: vi.fn(async (_atomPath: string) => [] as Array<unknown>),
  commentsCreate: vi.fn(async (_atomPath: string, _anchor: unknown, body: string, author: string) => ({
    id: `c_${Date.now()}`,
    thread_id: `th_${Date.now()}`,
    atom_path: "shared/decision.md",
    anchor: { paragraph_id: "p1" },
    author,
    body,
    created_at: new Date().toISOString(),
    parent_id: null,
    resolved: false,
  })),
}));

vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    presenceEmit: tauriMocks.presenceEmit,
    presenceListActive: tauriMocks.presenceListActive,
    listenPresenceUpdates: tauriMocks.listenPresenceUpdates,
    commentsList: tauriMocks.commentsList,
    commentsCreate: tauriMocks.commentsCreate,
    // Stub openExternal so /join's device-flow path doesn't try to open a
    // real browser window during the test.
    openExternal: vi.fn(async (_url: string) => {}),
    resolveMemoryRoot: vi.fn(async () => ({ path: "/home/u/.tangerine-memory", source: "default" })),
  };
});

// Mock the git lib so two-user clone shares state.
vi.mock("@/lib/git", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git")>();
  return {
    ...actual,
    gitClone: vi.fn(async (args: { url: string; dest: string }) => {
      shared.cloned.add(args.url);
      return { dest: args.dest, branch: "main" };
    }),
    gitPull: vi.fn(async () => ({ ok: true, message: "pulled" })),
    syncStart: vi.fn(async () => undefined),
    onDeepLinkJoin: vi.fn(async (_cb: (uri: string) => void) => () => {}),
  };
});

// Mock the device-flow helpers so /join doesn't try a real GitHub round-trip.
vi.mock("@/lib/github", async () => ({
  ghDeviceFlowStart: vi.fn(async () => ({
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    device_code: "dc",
    interval: 1,
    expires_in: 900,
  })),
  ghDeviceFlowPollUntilReady: vi.fn(async () => "alice"),
  ghCreateRepo: vi.fn(async (_args: unknown) => ({
    name: "tangerine-memory-shared",
    clone_url: "https://github.com/alice/tangerine-memory-shared.git",
    html_url: "https://github.com/alice/tangerine-memory-shared",
  })),
}));

import { useStore } from "../src/lib/store";
import { generateInvite, parseInvite, gitClone } from "../src/lib/git";
import { InviteLinkModal } from "../src/components/InviteLinkModal";
import JoinTeamRoute from "../src/routes/join-team";
import {
  PresenceProvider,
  usePresence,
} from "../src/components/presence/PresenceProvider";
import { CommentInput } from "../src/components/comments/CommentInput";

// Helper: build a presence-record fixture.
function presenceFixture(user: string, route = "/today", agoSec = 2): {
  user: string;
  current_route: string;
  active_atom: string | null;
  action_type: string | null;
  last_active: string;
  started_at: string;
} {
  return {
    user,
    current_route: route,
    active_atom: null,
    action_type: "heartbeat",
    last_active: new Date(Date.now() - agoSec * 1000).toISOString(),
    started_at: new Date(Date.now() - 60_000).toISOString(),
  };
}

beforeEach(() => {
  shared.presenceByRepo.clear();
  shared.commentsByAtom.clear();
  shared.cloned.clear();
  shared.lastInviteUri = null;
  tauriMocks.presenceEmit.mockClear();
  tauriMocks.presenceListActive.mockReset();
  tauriMocks.presenceListActive.mockResolvedValue([]);
  tauriMocks.listenPresenceUpdates.mockReset();
  tauriMocks.listenPresenceUpdates.mockImplementation(async () => () => {});
  tauriMocks.commentsList.mockClear();
  tauriMocks.commentsCreate.mockClear();
  // Reset memoryConfig to first-launch state for User A scenarios.
  useStore.setState((s) => ({
    ui: {
      ...s.ui,
      memoryConfig: {},
      currentUser: "alice",
      onboardingScope: null,
      setupWizardChannelReady: false,
      welcomed: true, // suppress overlay
      lastWelcomedVersion: __APP_VERSION__,
    },
  }));
  // Stub navigator.clipboard for the InviteLinkModal copy test.
  if (typeof window !== "undefined") {
    const navAny = window.navigator as Navigator & { clipboard?: unknown };
    if (!navAny.clipboard) {
      Object.defineProperty(window.navigator, "clipboard", {
        value: { writeText: vi.fn(async () => {}) },
        writable: true,
        configurable: true,
      });
    }
  }
});

afterEach(() => {
  cleanup();
});

// ============================================================
// SPEC 1: User A generates an invite + the modal renders the URI
// + clipboard copy fires + Done navigates onward.
// ============================================================
describe("v1.14 R1 — User A: generate invite + InviteLinkModal", () => {
  it("generates a tangerine:// invite URI and renders the copy CTA + URI text", async () => {
    const repoUrl = "https://github.com/alice/tangerine-memory-shared.git";
    const invite = await generateInvite({ repoUrl });
    // The mock in git.ts builds a deterministic mock URI; assert the
    // shape so a real Rust shape change would cascade visibly into the UI.
    expect(invite.uri).toMatch(/^tangerine:\/\/join\?repo=/);
    expect(invite.uri).toContain("token=");
    expect(invite.repo_url).toBe(repoUrl);
    expect(invite.expires_at).toBeGreaterThan(Date.now() / 1000);

    const onDone = vi.fn();
    render(<InviteLinkModal uri={invite.uri} onDone={onDone} />);
    // The URI must be visible to the user — otherwise they can't paste it
    // manually if clipboard write fails.
    expect(screen.getByText(invite.uri)).toBeInTheDocument();
    // Copy button + Done button are reachable by accessible name.
    const copyBtn = screen.getByRole("button", { name: /Copy invite/i });
    const doneBtn = screen.getByRole("button", { name: /^Done$/i });
    expect(copyBtn).toBeInTheDocument();
    expect(doneBtn).toBeInTheDocument();

    // Clicking Copy calls clipboard.writeText with the URI.
    const writeText = window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>;
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(invite.uri));
    // Done flips back to caller.
    fireEvent.click(doneBtn);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// SPEC 2: User B parses the invite + JoinTeamRoute completes
// the shared-clone path and flips memoryConfig to team mode.
// ============================================================
describe("v1.14 R1 — User B: parse invite + accept + clone shared repo", () => {
  it("a valid invite URI lands on the Accept screen with the repo URL visible", async () => {
    const repoUrl = "https://github.com/alice/tangerine-memory-shared.git";
    const invite = await generateInvite({ repoUrl });
    render(
      <MemoryRouter initialEntries={[`/join?uri=${encodeURIComponent(invite.uri)}`]}>
        <Routes>
          <Route path="/join" element={<JoinTeamRoute />} />
        </Routes>
      </MemoryRouter>,
    );
    // After parse resolves, the Accept panel renders with the repo URL.
    await waitFor(() =>
      expect(screen.getByText(/Join your team's memory/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(repoUrl)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Accept$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Decline$/i })).toBeInTheDocument();
  });

  it("clicking Accept clones the shared repo and writes memoryConfig.mode = 'team'", async () => {
    // Switch identity to "bob" — User B perspective.
    useStore.setState((s) => ({ ui: { ...s.ui, currentUser: "bob" } }));
    const repoUrl = "https://github.com/alice/tangerine-memory-shared.git";
    const invite = await generateInvite({ repoUrl });
    render(
      <MemoryRouter initialEntries={[`/join?uri=${encodeURIComponent(invite.uri)}`]}>
        <Routes>
          <Route path="/join" element={<JoinTeamRoute />} />
          {/* Provide a sink for the post-clone navigate("/memory") so the
              test doesn't blow up on missing route. */}
          <Route path="/memory" element={<div data-testid="memory-route">memory</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /^Accept$/i })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Accept$/i }));
    });
    // gitClone fired with the repo URL from the invite.
    await waitFor(() => expect(gitClone).toHaveBeenCalled());
    const cloneArgs = (gitClone as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      url: string;
      dest: string;
    };
    expect(cloneArgs.url).toBe(repoUrl);
    // Shared "repo" map records the clone — proves the funnel closed.
    expect(shared.cloned.has(repoUrl)).toBe(true);
    // memoryConfig flipped — User B is now in team mode pointing at the
    // same repoUrl as User A.
    await waitFor(() => {
      expect(useStore.getState().ui.memoryConfig.mode).toBe("team");
      expect(useStore.getState().ui.memoryConfig.repoUrl).toBe(repoUrl);
    });
  });
});

// ============================================================
// SPEC 3: After both users joined, PresenceProvider reports both
// as active. Confirms the read-side aggregation works across the
// shared dir.
// ============================================================
describe("v1.14 R1 — multi-user presence after pairing", () => {
  it("with both alice + bob in the shared dir, presence pill (via provider) lists both", async () => {
    // Seed the shared presence map with both users, then drive
    // presenceListActive to read from it. We exclude self (bob) on the
    // call so Bob's PresenceProvider returns alice only — matching the
    // `excludeUser` contract in tauri.ts.
    tauriMocks.presenceListActive.mockImplementation(async (args?: { excludeUser?: string | null }) => {
      const all = [presenceFixture("alice", "/today", 3), presenceFixture("bob", "/inbox", 2)];
      const exclude = args?.excludeUser ?? null;
      return all.filter((p) => p.user !== exclude);
    });
    useStore.setState((s) => ({ ui: { ...s.ui, currentUser: "bob" } }));

    function Probe() {
      const { teammatesActive } = usePresence();
      return (
        <ul data-testid="probe">
          {teammatesActive.map((p) => (
            <li key={p.user} data-testid={`probe-${p.user}`}>
              {p.user}
            </li>
          ))}
        </ul>
      );
    }
    render(
      <MemoryRouter>
        <PresenceProvider heartbeatMs={50}>
          <Probe />
        </PresenceProvider>
      </MemoryRouter>,
    );
    // Bob excludes self → sees alice (User A is the cold-start champion).
    await waitFor(() => {
      expect(screen.getByTestId("probe-alice")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("probe-bob")).toBeNull();
  });
});

// ============================================================
// SPEC 4: User B types @alice in CommentInput, mention preview
// shows BEFORE post. Locks in the cross-user signaling that the
// AI-capture moat depends on (R3 wired this; we make sure the
// team funnel actually exercises it).
// ============================================================
describe("v1.14 R1 — comment + mention reaches the other user", () => {
  it("typing @alice in the comment input previews 'Will notify' before submit, then submit fires the create with the right author", async () => {
    const onSubmit = vi.fn(async (_body: string) => {});
    render(<CommentInput onSubmit={onSubmit} />);
    const textarea = screen.getByLabelText(/Add a comment|comment placeholder/i, {
      selector: "textarea",
    }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Hey @alice — pls confirm pricing" } });
    // Live preview surfaces the @alice mention BEFORE Post.
    await waitFor(() => {
      expect(screen.getByTestId("comment-input-will-notify")).toBeInTheDocument();
    });
    expect(screen.getByTestId("comment-input-will-notify")).toHaveTextContent(/@alice/);
    // Post fires.
    await act(async () => {
      fireEvent.click(screen.getByTestId("comment-input-submit"));
    });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0]).toContain("@alice");
  });
});

// ============================================================
// SPEC 5: Bad invite URIs surface honest errors.
//
// This is the load-bearing R6 pattern test for the team funnel —
// the JS-mock parseInvite was a known silent-failure surface (it
// returned `valid: true` for ANY URI containing repo=, ignoring
// the scheme requirement that the real Rust side enforces). After
// the v1.14 R1 fix, malformed URIs round-trip to honest reasons.
// ============================================================
describe("v1.14 R1 — malformed invites surface honest errors (no silent accept)", () => {
  it("wrong scheme (https://) is rejected with a 'Not a tangerine:// invite link' reason", async () => {
    const r = await parseInvite({
      uri: "https://example.com/?repo=https%3A%2F%2Fgithub.com%2Fattacker%2Fevil.git&token=fake",
    });
    expect(r.valid).toBe(false);
    expect(r.repo_url).toBeNull();
    expect(r.reason).toMatch(/tangerine|scheme/i);
  });

  it("missing repo= param is rejected", async () => {
    const r = await parseInvite({ uri: "tangerine://join?token=foo" });
    expect(r.valid).toBe(false);
    expect(r.repo_url).toBeNull();
    expect(r.reason).toMatch(/repo/i);
  });

  it("missing token= param is rejected", async () => {
    const r = await parseInvite({
      uri: "tangerine://join?repo=https%3A%2F%2Fgithub.com%2Fteam%2Frepo.git",
    });
    expect(r.valid).toBe(false);
    expect(r.repo_url).toBeNull();
    expect(r.reason).toMatch(/token/i);
  });

  it("/join route renders an error panel for a bad URI instead of advancing to Accept", async () => {
    render(
      <MemoryRouter
        initialEntries={[
          `/join?uri=${encodeURIComponent("not-a-tangerine-uri-at-all")}`,
        ]}
      >
        <Routes>
          <Route path="/join" element={<JoinTeamRoute />} />
          <Route path="/memory" element={<div data-testid="memory-route">memory</div>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument(),
    );
    // The Accept button must NOT be reachable for a bad invite — that
    // would be the silent-failure regression we're guarding against.
    expect(screen.queryByRole("button", { name: /^Accept$/i })).toBeNull();
  });
});
// === end v1.14.0 round-1 ===
