// Token storage for the GitHub source connector.
//
// PAT mode (Stage 1, this file): user provides a Personal Access Token. We
// store it in the OS keychain via `keytar` so it never lives on disk in
// plaintext. Service name follows the source-connector convention:
// `tangerine-github`. Account name is `default` since v1 doesn't yet support
// multi-account workflows; future multi-account work can plug in here.
//
// OAuth mode (Stage 2, NOT IMPLEMENTED): client_id `Ov23ligLHtDAlzPt48bG`
// (the bake-in for the Tangerine GitHub App registered by the CEO) is reserved
// here for later. PAT is enough for first ship.
//
// keytar is dynamically imported so unit tests on CI can stub it without
// requiring the native binary to install. See `loadKeytar()` for the indirection.

export const KEYTAR_SERVICE = "tangerine-github";
export const KEYTAR_ACCOUNT_DEFAULT = "default";

/** Reserved for Stage 2 OAuth flow — DO NOT use yet. */
export const OAUTH_CLIENT_ID = "Ov23ligLHtDAlzPt48bG";

export interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let injectedKeytar: KeytarLike | null = null;

/**
 * Tests inject a fake keytar via this hook. Production code never calls this.
 * Pass `null` to revert to the real keytar.
 */
export function setKeytarForTesting(impl: KeytarLike | null): void {
  injectedKeytar = impl;
}

async function loadKeytar(): Promise<KeytarLike> {
  if (injectedKeytar) return injectedKeytar;
  // Dynamic import — keytar is a native module, so we don't want it in the
  // import graph of every file (and tests can avoid it entirely).
  const mod = await import("keytar");
  // keytar's CJS export comes in differently depending on bundler; coerce:
  const k = (mod as unknown as { default?: KeytarLike }).default ?? (mod as unknown as KeytarLike);
  return k;
}

/** Persist a PAT in the OS keychain. Overwrites any existing token. */
export async function setToken(token: string, account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw new Error("token must be a non-empty string");
  }
  const k = await loadKeytar();
  await k.setPassword(KEYTAR_SERVICE, account, token.trim());
}

/** Read the stored PAT. Returns null if no token is set. */
export async function getToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<string | null> {
  const k = await loadKeytar();
  return k.getPassword(KEYTAR_SERVICE, account);
}

/** Remove the stored PAT. Returns true if a token was present. */
export async function deleteToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<boolean> {
  const k = await loadKeytar();
  return k.deletePassword(KEYTAR_SERVICE, account);
}

/** Has-token convenience. */
export async function hasToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<boolean> {
  const t = await getToken(account);
  return !!t && t.length > 0;
}

/**
 * Smoke-validate a PAT by hitting `GET /user`. We import the client lazily
 * to avoid a cycle (client.ts imports auth for its own bootstrap).
 */
export async function validateToken(token: string): Promise<{ ok: true; login: string } | { ok: false; reason: string }> {
  const { makeClient } = await import("./client.js");
  try {
    const c = makeClient(token);
    const res = await c.request("GET /user");
    const login = (res.data as { login?: string }).login;
    if (!login) {
      return { ok: false, reason: "GitHub returned no login" };
    }
    return { ok: true, login };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}
