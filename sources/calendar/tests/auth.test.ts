// Auth — Google token storage. iCal needs no token (URL itself is the secret).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setKeytarForTesting,
  setGoogleToken,
  getGoogleToken,
  deleteGoogleToken,
  hasGoogleToken,
  KEYTAR_SERVICE,
} from "../src/auth.js";

class FakeKeytar {
  store = new Map<string, string>();
  k(s: string, a: string) { return `${s}::${a}`; }
  async setPassword(s: string, a: string, p: string) { this.store.set(this.k(s, a), p); }
  async getPassword(s: string, a: string) { return this.store.get(this.k(s, a)) ?? null; }
  async deletePassword(s: string, a: string) { return this.store.delete(this.k(s, a)); }
}

describe("Google OAuth token storage", () => {
  let fake: FakeKeytar;
  beforeEach(() => {
    fake = new FakeKeytar();
    setKeytarForTesting(fake);
  });
  afterEach(() => setKeytarForTesting(null));

  it("rejects empty token", async () => {
    await expect(setGoogleToken("cal-1", "")).rejects.toThrow("non-empty");
  });
  it("setGoogleToken / getGoogleToken roundtrip", async () => {
    expect(await hasGoogleToken("cal-1")).toBe(false);
    await setGoogleToken("cal-1", "1//refresh-token");
    expect(await hasGoogleToken("cal-1")).toBe(true);
    expect(await getGoogleToken("cal-1")).toBe("1//refresh-token");
  });
  it("namespaces by calendar id", async () => {
    await setGoogleToken("cal-A", "tok-A");
    await setGoogleToken("cal-B", "tok-B");
    expect(await getGoogleToken("cal-A")).toBe("tok-A");
    expect(await getGoogleToken("cal-B")).toBe("tok-B");
    expect(fake.store.get(`${KEYTAR_SERVICE}::google:cal-A`)).toBe("tok-A");
    expect(fake.store.get(`${KEYTAR_SERVICE}::google:cal-B`)).toBe("tok-B");
  });
  it("delete removes one without affecting the other", async () => {
    await setGoogleToken("cal-A", "tok-A");
    await setGoogleToken("cal-B", "tok-B");
    expect(await deleteGoogleToken("cal-A")).toBe(true);
    expect(await getGoogleToken("cal-A")).toBeNull();
    expect(await getGoogleToken("cal-B")).toBe("tok-B");
  });
  it("trims whitespace", async () => {
    await setGoogleToken("cal-1", "  tok-trim  ");
    expect(await getGoogleToken("cal-1")).toBe("tok-trim");
  });
});
