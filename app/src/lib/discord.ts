/**
 * Discord client-side helpers. The actual API call goes through Rust to dodge
 * CORS, but we keep token validation + client_id extraction here because they
 * are pure functions and easy to unit test.
 *
 * SW-1.3 polling cadence: 5 SECONDS. Do NOT reduce to 1-2s — Discord's global
 * rate limit is 50 req/sec across all endpoints; faster polling can soft-ban
 * the user's bot.
 */

/** Discord bot tokens are 3 dot-separated base64-ish segments, 50–80 chars total. */
export const DISCORD_TOKEN_RE = /^[A-Za-z0-9_-]{20,30}\.[A-Za-z0-9_-]{5,10}\.[A-Za-z0-9_-]{20,50}$/;

export function isPlausibleBotToken(token: string): boolean {
  if (!token) return false;
  const t = token.trim();
  if (t.length < 50 || t.length > 80) return false;
  return DISCORD_TOKEN_RE.test(t);
}

/**
 * Extract the bot's application/client ID from the leading segment of a token.
 * Discord encodes the snowflake ID into the first dot-separated segment as
 * url-safe base64. Returns null if extraction fails — UI must fall back to
 * asking the user to paste the client_id manually.
 */
export function extractClientId(token: string): string | null {
  if (!isPlausibleBotToken(token)) return null;
  const head = token.split(".")[0];
  try {
    // Browser atob doesn't speak url-safe base64; normalize first.
    const padded = head.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      head.length + ((4 - (head.length % 4)) % 4),
      "="
    );
    const decoded = atob(padded);
    // Decoded value is the application's snowflake ID as ASCII digits.
    if (/^\d{17,20}$/.test(decoded)) return decoded;
    return null;
  } catch {
    return null;
  }
}

/** Build the OAuth invite URL with locked permissions per APP-INTERFACES.md §3 SW-1. */
export function buildInviteUrl(clientId: string, permissions = 2150629888): string {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "bot applications.commands",
    permissions: String(permissions),
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

/** Polling interval — LOCKED at 5 seconds per APP-INTERFACES.md §5 + T0 warning. */
export const DISCORD_POLL_INTERVAL_MS = 5000;

/** When to surface "Discord may take up to 10 seconds…" hint. */
export const DISCORD_POLL_HINT_AFTER_MS = 8000;
