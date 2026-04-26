// Auth: keytar-mocked.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setKeytarForTesting,
  setToken,
  getToken,
  hasToken,
  deleteToken,
  KEYTAR_SERVICE,
  KEYTAR_ACCOUNT_DEFAULT,
} from "../src/auth.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string) { return `${s}:${a}`; }
  async setPassword(s: string, a: string, p: string) { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string) { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string) { return this.store.delete(this.k(s, a)); }
}

describe("auth (keytar mocked)", () => {
  let fake: FakeKeytar;
  beforeEach(() => {
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
  });
  afterEach(() => setKeytarForTesting(null));

  it("uses the conventional service name", () => {
    expect(KEYTAR_SERVICE).toBe("tangerine-github");
  });

  it("hasToken returns false when nothing stored", async () => {
    expect(await hasToken()).toBe(false);
  });

  it("setToken then getToken round-trips", async () => {
    await setToken("ghp_AAAA1111");
    expect(await getToken()).toBe("ghp_AAAA1111");
    expect(await hasToken()).toBe(true);
    expect(fake.store.get(`${KEYTAR_SERVICE}:${KEYTAR_ACCOUNT_DEFAULT}`)).toBe("ghp_AAAA1111");
  });

  it("setToken trims whitespace", async () => {
    await setToken("  ghp_TRIMMED  ");
    expect(await getToken()).toBe("ghp_TRIMMED");
  });

  it("rejects empty token", async () => {
    await expect(setToken("")).rejects.toThrow();
    await expect(setToken("   ")).rejects.toThrow();
  });

  it("deleteToken removes the entry", async () => {
    await setToken("ghp_X");
    expect(await deleteToken()).toBe(true);
    expect(await getToken()).toBeNull();
    expect(await deleteToken()).toBe(false);
  });

  it("supports multi-account", async () => {
    await setToken("ghp_one", "alice");
    await setToken("ghp_two", "bob");
    expect(await getToken("alice")).toBe("ghp_one");
    expect(await getToken("bob")).toBe("ghp_two");
    expect(await getToken()).toBeNull();
  });
});
