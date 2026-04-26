// Token storage for the Linear source connector.
//
// PAT mode (Stage 1): user provides a Linear Personal API Key. We store it
// in the OS keychain via keytar so it never lives on disk in plaintext.
// Service name follows the source-connector convention: `tangerine-linear`.
// Account name is `default` since v1 doesn't yet support multi-workspace
// workflows; future multi-workspace work can plug in here.
//
// To create a PAT:
//   1. Visit https://linear.app/<workspace>/settings/api
//   2. Click "Create new key"
//   3. Copy the value and paste into `tangerine-linear auth set`
//
// The key carries all of the user's permissions, so anything the user can
// see in the Linear UI is readable through this token. No OAuth dance
// required — keep this simple for Stage 1.
//
// keytar is dynamically imported so unit tests on CI can stub it without
// requiring the native binary to install. See `loadKeytar()`.

export const KEYTAR_SERVICE = "tangerine-linear";
export const KEYTAR_ACCOUNT_DEFAULT = "default";

export interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let injectedKeytar: KeytarLike | null = null;

/** Tests inject a fake keytar via this hook. Pass `null` to revert. */
export function setKeytarForTesting(impl: KeytarLike | null): void {
  injectedKeytar = impl;
}

async function loadKeytar(): Promise<KeytarLike> {
  if (injectedKeytar) return injectedKeytar;
  const mod = await import("keytar");
  const k = (mod as unknown as { default?: KeytarLike }).default ?? (mod as unknown as KeytarLike);
  return k;
}

export async function setToken(token: string, account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw new Error("token must be a non-empty string");
  }
  const k = await loadKeytar();
  await k.setPassword(KEYTAR_SERVICE, account, token.trim());
}

export async function getToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<string | null> {
  const k = await loadKeytar();
  return k.getPassword(KEYTAR_SERVICE, account);
}

export async function deleteToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<boolean> {
  const k = await loadKeytar();
  return k.deletePassword(KEYTAR_SERVICE, account);
}

export async function hasToken(account: string = KEYTAR_ACCOUNT_DEFAULT): Promise<boolean> {
  const t = await getToken(account);
  return !!t && t.length > 0;
}

/**
 * Smoke-validate a PAT by querying the viewer (current user). We import the
 * client lazily to avoid a cycle.
 */
export async function validateToken(token: string): Promise<{ ok: true; user: string } | { ok: false; reason: string }> {
  const { makeClient } = await import("./client.js");
  try {
    const c = makeClient(token);
    const me = await c.viewer();
    if (!me?.email && !me?.name) {
      return { ok: false, reason: "Linear returned no viewer details" };
    }
    return { ok: true, user: me.email ?? me.name ?? "unknown" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}
