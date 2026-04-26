// Auth — token storage + validation. Stubs out keytar with an in-memory map.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setKeytarForTesting,
  setToken,
  getToken,
  deleteToken,
  hasToken,
  validateToken,
  KEYTAR_SERVICE,
} from "../src/auth.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string) { return `${s}::${a}`; }
  async setPassword(s: string, a: string, p: string) { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string) { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string) { return this.store.delete(this.k(s, a)); }
}

describe("auth — keytar wrapper", () => {
  let fake: FakeKeytar;
  beforeEach(() => {
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
  });
  afterEach(() => setKeytarForTesting(null));

  it("setToken bot rejects empty input", async () => {
    await expect(setToken("")).rejects.toThrow("non-empty");
  });
  it("setToken bot rejects xoxp- token", async () => {
    await expect(setToken("xoxp-1-user-token")).rejects.toThrow("xoxb-");
  });
  it("setToken user rejects xoxb- token", async () => {
    await expect(setToken("xoxb-1-bot-token", "user")).rejects.toThrow("xoxp-");
  });
  it("setToken bot stores under 'bot' account", async () => {
    await setToken("xoxb-1-foo");
    expect(fake.store.get(`${KEYTAR_SERVICE}::bot`)).toBe("xoxb-1-foo");
  });
  it("setToken user stores under 'user' account", async () => {
    await setToken("xoxp-1-foo", "user");
    expect(fake.store.get(`${KEYTAR_SERVICE}::user`)).toBe("xoxp-1-foo");
  });
  it("getToken/hasToken roundtrip", async () => {
    expect(await hasToken()).toBe(false);
    await setToken("xoxb-tok");
    expect(await hasToken()).toBe(true);
    expect(await getToken()).toBe("xoxb-tok");
  });
  it("deleteToken removes", async () => {
    await setToken("xoxb-tok");
    expect(await deleteToken()).toBe(true);
    expect(await deleteToken()).toBe(false);
    expect(await getToken()).toBeNull();
  });
  it("trims whitespace", async () => {
    await setToken("  xoxb-trimmed  ");
    expect(await getToken()).toBe("xoxb-trimmed");
  });
});

describe("validateToken", () => {
  it("returns ok=false when client throws", async () => {
    const v = await validateToken("xoxb-bogus-no-network");
    // We don't have network access in unit; the slack web-api client will
    // throw or return an error. Either way ok=false is the contract.
    expect(v.ok).toBe(false);
  });
});
