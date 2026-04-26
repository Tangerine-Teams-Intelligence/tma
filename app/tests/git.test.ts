import { describe, it, expect, beforeEach } from "vitest";
import {
  gitCheck,
  gitClone,
  gitPull,
  gitStatus,
  gitCommitAll,
  generateInvite,
  parseInvite,
  syncStatus,
  syncStart,
  syncStop,
  syncKick,
} from "../src/lib/git";

// These tests run outside Tauri so every wrapper falls through to its mock.
// The point is to lock in the (camelCase TS) → (snake_case Rust) shape so a
// silent rename doesn't break the IPC contract.

describe("git wrappers (mock fallback)", () => {
  it("gitCheck returns the available shape", async () => {
    const r = await gitCheck();
    expect(r).toMatchObject({
      available: expect.any(Boolean),
      install_url: expect.stringContaining("git-scm.com"),
    });
  });

  it("gitClone echoes dest + branch", async () => {
    const r = await gitClone({ url: "https://github.com/x/y.git", dest: "/tmp/y" });
    expect(r.dest).toBe("/tmp/y");
    expect(r.branch).toBe("main");
  });

  it("gitPull / gitCommitAll return ok=true mock", async () => {
    expect((await gitPull({ repo: "/tmp/y" })).ok).toBe(true);
    expect((await gitCommitAll({ repo: "/tmp/y", message: "x" })).ok).toBe(true);
  });

  it("gitStatus returns clean tree shape", async () => {
    const r = await gitStatus({ repo: "/tmp/y" });
    expect(r).toMatchObject({
      clean: expect.any(Boolean),
      branch: expect.any(String),
      ahead: expect.any(Number),
      behind: expect.any(Number),
      changed: expect.any(Array),
    });
  });
});

describe("invite codec wrappers", () => {
  it("generateInvite produces a tangerine:// URI", async () => {
    const r = await generateInvite({ repoUrl: "https://github.com/x/y.git" });
    expect(r.uri.startsWith("tangerine://join?")).toBe(true);
    expect(r.uri).toContain(encodeURIComponent("https://github.com/x/y.git"));
  });

  it("parseInvite round-trips a mock URI", async () => {
    const r = await parseInvite({
      uri: "tangerine://join?repo=https%3A%2F%2Fgithub.com%2Fx%2Fy.git&token=abc",
    });
    expect(r.valid).toBe(true);
    expect(r.repo_url).toBe("https://github.com/x/y.git");
    expect(r.expired).toBe(false);
  });

  it("parseInvite rejects malformed URI", async () => {
    const r = await parseInvite({ uri: "not-a-uri" });
    expect(r.valid).toBe(false);
    expect(r.repo_url).toBeNull();
  });
});

describe("sync ticker wrappers", () => {
  beforeEach(() => {
    // No-op in mock land — we just want to ensure the shape stays stable.
  });

  it("syncStatus returns the running=false default", async () => {
    const s = await syncStatus();
    expect(s.running).toBe(false);
    expect(s.pending_changes).toBe(0);
  });

  it("syncStart / syncKick / syncStop are non-throwing void", async () => {
    await expect(syncStart({ repoPath: "/tmp/r", login: "daizhe" })).resolves.toBeUndefined();
    await expect(syncKick()).resolves.toBeUndefined();
    await expect(syncStop()).resolves.toBeUndefined();
  });
});
