// === wave 1.13-A ===
/**
 * Wave 1.13-A — extract `@username` mentions from a markdown body.
 *
 * Rules (kept narrow on purpose; Wave 1.13-C ships fuzzy AI extraction
 * separately):
 *   * Match `@<alias>` where `<alias>` is `[a-z0-9_-]+`.
 *   * Case-insensitive; aliases are lowercased on emit so they match the
 *     `personal/<alias>/` directory naming convention.
 *   * Skip mentions inside fenced code blocks (```...```) and inline code
 *     (`...`) so a `@username` in a snippet doesn't accidentally fire a
 *     notification.
 *   * Skip emails — `foo@bar.com` is NOT a mention.
 *   * De-duplicate within a single body (a user mentioned 3 times → one
 *     event, not three).
 *
 * Returns an array of unique aliases in first-occurrence order.
 */

const MENTION_RE = /(^|[\s,.!?;:(\[])@([a-zA-Z0-9_-]+)(?=[\s,.!?;:)\]]|$)/g;

export function extractMentions(markdown: string): string[] {
  if (!markdown) return [];
  // Mask out fenced code blocks first.
  let text = markdown.replace(/```[\s\S]*?```/g, (m) => " ".repeat(m.length));
  // Mask out inline code.
  text = text.replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));

  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = MENTION_RE.exec(text)) !== null) {
    const alias = m[2].toLowerCase();
    if (alias.length === 0) continue;
    if (seen.has(alias)) continue;
    seen.add(alias);
    out.push(alias);
  }
  return out;
}

/**
 * Test helper — strip a leading `@` from a string. Useful for the
 * autocomplete dropdown that wants the bare alias.
 */
export function stripAt(token: string): string {
  return token.startsWith("@") ? token.slice(1) : token;
}
// === end wave 1.13-A ===
