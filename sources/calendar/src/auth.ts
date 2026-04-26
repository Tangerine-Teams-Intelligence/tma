// Token storage for the Calendar source connector.
//
// Stage 1 supports:
//   - iCal feed URLs — NO auth needed; URL itself is the secret. Stored in
//     calendar.config.json, not the keychain.
//   - Google Calendar OAuth — Stage 2 / bonus. The OAuth flow stores both
//     access_token and refresh_token in the OS keychain via keytar, namespaced
//     by the calendar id.
//
// keytar is dynamically imported so unit tests can stub it without requiring
// the native binary to install.

export const KEYTAR_SERVICE = "tangerine-calendar";

/** Reserved for the Google OAuth flow once the CEO registers the OAuth app. */
export const OAUTH_CLIENT_ID = "PLACEHOLDER_GOOGLE_OAUTH_CLIENT_ID";

export interface KeytarLike {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let injectedKeytar: KeytarLike | null = null;

export function setKeytarForTesting(impl: KeytarLike | null): void {
  injectedKeytar = impl;
}

async function loadKeytar(): Promise<KeytarLike> {
  if (injectedKeytar) return injectedKeytar;
  const mod = await import("keytar");
  const k = (mod as unknown as { default?: KeytarLike }).default ?? (mod as unknown as KeytarLike);
  return k;
}

/** Persist a Google OAuth refresh token (Stage 2). */
export async function setGoogleToken(calendarId: string, refreshToken: string): Promise<void> {
  if (!refreshToken || refreshToken.trim().length === 0) {
    throw new Error("refresh token must be a non-empty string");
  }
  const k = await loadKeytar();
  await k.setPassword(KEYTAR_SERVICE, `google:${calendarId}`, refreshToken.trim());
}

export async function getGoogleToken(calendarId: string): Promise<string | null> {
  const k = await loadKeytar();
  return k.getPassword(KEYTAR_SERVICE, `google:${calendarId}`);
}

export async function deleteGoogleToken(calendarId: string): Promise<boolean> {
  const k = await loadKeytar();
  return k.deletePassword(KEYTAR_SERVICE, `google:${calendarId}`);
}

export async function hasGoogleToken(calendarId: string): Promise<boolean> {
  const t = await getGoogleToken(calendarId);
  return !!t && t.length > 0;
}
