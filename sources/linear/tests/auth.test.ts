// Auth: keychain-backed PAT storage. Tests use an injected fake keytar so
// no real keychain mutation occurs.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  KEYTAR_SERVICE,
  setKeytarForTesting,
  setToken,
  getToken,
  deleteToken,
  hasToken,
  type KeytarLike,
} from "../src/auth.js";

class FakeKeytar implements KeytarLike {
  store = new Map<string, string>();
  k(s: string, a: string): string { return `${s}:${a}`; }
  async setPassword(s: string, a: string, p: string): Promise<void> { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string): Promise<string | null> { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string): Promise<boolean> { return this.store.delete(this.k(s, a)); }
}

describe("auth", () => {
  let fake: FakeKeytar;
  beforeEach(() => {
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
  });
  afterEach(() => setKeytarForTesting(null));

  it("setToken stores under the expected service name", async () => {
    await setToken("lin_abc123");
    expect(fake.store.get(`${KEYTAR_SERVICE}:default`)).toBe("lin_abc123");
  });

  it("setToken trims whitespace", async () => {
    await setToken("  lin_xyz  ");
    expect(fake.store.get(`${KEYTAR_SERVICE}:default`)).toBe("lin_xyz");
  });

  it("setToken rejects empty input", async () => {
    await expect(setToken("")).rejects.toThrow();
    await expect(setToken("   ")).rejects.toThrow();
  });

  it("getToken returns null when nothing stored", async () => {
    expect(await getToken()).toBeNull();
  });

  it("getToken roundtrips", async () => {
    await setToken("lin_round");
    expect(await getToken()).toBe("lin_round");
  });

  it("hasToken reflects presence", async () => {
    expect(await hasToken()).toBe(false);
    await setToken("lin_present");
    expect(await hasToken()).toBe(true);
  });

  it("deleteToken removes stored token", async () => {
    await setToken("lin_to_delete");
    expect(await hasToken()).toBe(true);
    expect(await deleteToken()).toBe(true);
    expect(await hasToken()).toBe(false);
  });
});
