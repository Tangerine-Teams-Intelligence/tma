// Token storage for the Slack source connector.
//
// Stage 1 supports both auth shapes:
//   - Bot token  (xoxb-...) — default, what `tangerine-slack auth set` writes.
//   - User token (xoxp-...) — opt-in via `--mode=user` on `auth set`.
//
// Both flow through the same `keytar` service (`tangerine-slack`); we use the
// account name to disambiguate (`bot` vs `user`). Future multi-workspace
// support can extend the account namespace (e.g. `bot:<team_id>`).
//
// keytar is dynamically imported so unit tests can stub it without requiring
// the native binary to install. See `loadKeytar()`.

export const KEYTAR_SERVICE = "tangerine-slack";
export const KEYTAR_ACCOUNT_BOT = "bot";
export const KEYTAR_ACCOUNT_USER = "user";

/** Reserved for the OAuth flow once the CEO registers the Slack app. */
export const OAUTH_CLIENT_ID = "PLACEHOLDER_SLACK_OAUTH_CLIENT_ID";

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
  const mod = await import("keytar");
  const k = (mod as unknown as { default?: KeytarLike }).default ?? (mod as unknown as KeytarLike);
  return k;
}

function accountFor(mode: "bot" | "user"): string {
  return mode === "user" ? KEYTAR_ACCOUNT_USER : KEYTAR_ACCOUNT_BOT;
}

/** Persist a Slack token in the OS keychain. Overwrites any existing token. */
export async function setToken(
  token: string,
  mode: "bot" | "user" = "bot",
): Promise<void> {
  if (!token || token.trim().length === 0) {
    throw new Error("token must be a non-empty string");
  }
  const t = token.trim();
  if (mode === "bot" && !t.startsWith("xoxb-")) {
    throw new Error("bot tokens must start with `xoxb-` (use --mode=user for xoxp- tokens)");
  }
  if (mode === "user" && !t.startsWith("xoxp-")) {
    throw new Error("user tokens must start with `xoxp-`");
  }
  const k = await loadKeytar();
  await k.setPassword(KEYTAR_SERVICE, accountFor(mode), t);
}

/** Read the stored Slack token. Returns null if no token is set. */
export async function getToken(
  mode: "bot" | "user" = "bot",
): Promise<string | null> {
  const k = await loadKeytar();
  return k.getPassword(KEYTAR_SERVICE, accountFor(mode));
}

/** Remove the stored token. Returns true if a token was present. */
export async function deleteToken(
  mode: "bot" | "user" = "bot",
): Promise<boolean> {
  const k = await loadKeytar();
  return k.deletePassword(KEYTAR_SERVICE, accountFor(mode));
}

/** Has-token convenience. */
export async function hasToken(mode: "bot" | "user" = "bot"): Promise<boolean> {
  const t = await getToken(mode);
  return !!t && t.length > 0;
}

/**
 * Smoke-validate a Slack token by hitting `auth.test`. We import the client
 * lazily to avoid a cycle (client.ts imports auth for its own bootstrap).
 */
export async function validateToken(
  token: string,
): Promise<{ ok: true; team: string; user: string } | { ok: false; reason: string }> {
  const { makeClient } = await import("./client.js");
  try {
    const c = makeClient(token);
    const res = (await c.auth.test()) as { ok: boolean; error?: string; team?: string; user?: string };
    if (!res.ok) {
      return { ok: false, reason: res.error ?? "unknown auth.test failure" };
    }
    return {
      ok: true,
      team: res.team ?? "unknown-team",
      user: res.user ?? "unknown-user",
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: msg };
  }
}
