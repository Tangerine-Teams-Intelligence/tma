/**
 * v1.8 Phase 4-B — Canvas surface library.
 *
 * Atom shape (markdown round-trip):
 *
 *   ---
 *   canvas_topic: v1.8 ideation
 *   canvas_project: tangerine-teams-app
 *   created_at: 2026-04-26T15:00:00Z
 *   sticky_count: 4
 *   ---
 *
 *   ## sticky-{uuid}
 *   <!-- canvas-meta: {"x":120,"y":80,...,"comments":[...]} -->
 *
 *   The actual sticky note text in markdown.
 *
 *   ### Replies
 *
 *   - **claude (AGI)** at 2026-04-26T15:01: ...
 *   - **sarah** at 2026-04-26T15:03: ...
 *
 * The `<!-- canvas-meta: {...} -->` HTML comment carries structured data
 * (position, color, author, timestamp, comment list) as JSON. The markdown
 * itself stays git-blameable — the comment is a sidecar so a human reading
 * the file via `cat` still sees the body text in order.
 *
 * Sibling P4-C (AGI peer behaviors) layers on top of this — its "canvas"
 * AGI participation reads the same sticky/comment shape and dispatches
 * via the ambient observer. Don't change the meta JSON shape without
 * coordinating with P4-C.
 */

export type StickyColor = "yellow" | "pink" | "blue" | "green" | "orange" | "purple";

export const STICKY_COLORS: StickyColor[] = [
  "yellow",
  "pink",
  "blue",
  "green",
  "orange",
  "purple",
];

export interface Comment {
  id: string;
  author: string;
  is_agi: boolean;
  created_at: string;
  body: string;
  /**
   * v1.8 Phase 4-C — when AGI's heartbeat-driven canvas peer leaves a
   * comment, this is the URL fragment (e.g. `#sticky-{stickyId}`) the
   * /co-thinker route uses to scroll to the matching `Recent reasoning`
   * entry. Optional; absent on human-authored comments and on AGI comments
   * created via the manual `agi_comment_sticky` Tauri command without a
   * reasoning anchor.
   */
  reasoning_link?: string;
}

export interface Sticky {
  id: string;
  x: number;
  y: number;
  color: StickyColor;
  author: string;
  is_agi: boolean;
  created_at: string;
  body: string;
  comments: Comment[];
}

export interface CanvasTopic {
  /** Project slug (filesystem-safe). */
  project: string;
  /** Topic slug (filesystem-safe). */
  topic: string;
  /** Display title for the topic — pulled from `canvas_topic:` frontmatter
   *  on load; falls back to the slug. */
  title: string;
  /** ISO 8601 timestamp; defaults to "now" when a fresh topic is created. */
  created_at: string;
  stickies: Sticky[];
}

// ---------------------------------------------------------------------------
// Slug helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort filesystem-safe slug. Lower-case alphanumerics, dashes for
 * any non-alphanumeric run, leading/trailing dashes stripped.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "untitled";
}

// ---------------------------------------------------------------------------
// UUID — small, opaque, no dashes (we just want a stable id, not a v4).
// ---------------------------------------------------------------------------

export function shortUuid(): string {
  // 12 hex chars from crypto.getRandomValues when available, Math.random
  // otherwise. Tests run in jsdom which has crypto.getRandomValues.
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    const buf = new Uint8Array(6);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  let out = "";
  for (let i = 0; i < 12; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Markdown round-trip
// ---------------------------------------------------------------------------

/**
 * Render a CanvasTopic as the on-disk markdown shape. Inverse of
 * `topicFromMarkdown` — the round trip is lossless modulo whitespace.
 */
export function topicToMarkdown(t: CanvasTopic): string {
  const fm = [
    "---",
    `canvas_topic: ${escapeYamlScalar(t.title)}`,
    `canvas_project: ${escapeYamlScalar(t.project)}`,
    `created_at: ${t.created_at}`,
    `sticky_count: ${t.stickies.length}`,
    "---",
    "",
  ].join("\n");

  if (t.stickies.length === 0) {
    return fm + "\n";
  }

  const sections = t.stickies.map((s) => stickyToMarkdown(s));
  return fm + "\n" + sections.join("\n\n") + "\n";
}

function stickyToMarkdown(s: Sticky): string {
  const meta = JSON.stringify({
    x: s.x,
    y: s.y,
    color: s.color,
    author: s.author,
    is_agi: s.is_agi,
    created_at: s.created_at,
    comments: s.comments,
  });
  const body = s.body.trim();
  const lines = [
    `## sticky-${s.id}`,
    `<!-- canvas-meta: ${meta} -->`,
    "",
    body || "_(empty)_",
  ];
  if (s.comments.length > 0) {
    lines.push("");
    lines.push("### Replies");
    lines.push("");
    for (const c of s.comments) {
      const who = c.is_agi ? `**${c.author} (AGI)**` : `**${c.author}**`;
      const text = c.body.trim().replace(/\n/g, " ");
      lines.push(`- ${who} at ${c.created_at}: ${text}`);
    }
  }
  return lines.join("\n");
}

/**
 * Parse the on-disk markdown shape into a CanvasTopic. Defensive:
 *
 *   - missing frontmatter → empty topic (zero stickies)
 *   - sticky section without canvas-meta → reasonable defaults
 *   - malformed JSON in canvas-meta → defaults
 *
 * `project` and `topic` are passed in by the caller (they live in the path,
 * not the file body).
 */
export function topicFromMarkdown(
  md: string,
  project: string,
  topic: string,
): CanvasTopic {
  const { frontmatter, body } = splitFrontmatter(md);

  const title =
    parseYamlField(frontmatter, "canvas_topic") ||
    parseYamlField(frontmatter, "title") ||
    topic;
  const created_at =
    parseYamlField(frontmatter, "created_at") || new Date().toISOString();

  const stickies = parseStickySections(body);

  return {
    project,
    topic,
    title,
    created_at,
    stickies,
  };
}

function splitFrontmatter(md: string): { frontmatter: string; body: string } {
  // Accept LF or CRLF, plus optional UTF-8 BOM.
  const cleaned = md.replace(/^﻿/, "");
  const lines = cleaned.split(/\r?\n/);
  if (lines.length < 2 || lines[0].trim() !== "---") {
    return { frontmatter: "", body: cleaned };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      const fm = lines.slice(1, i).join("\n");
      const body = lines.slice(i + 1).join("\n");
      return { frontmatter: fm, body };
    }
  }
  return { frontmatter: "", body: cleaned };
}

function parseYamlField(fm: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "m");
  const m = fm.match(re);
  if (!m) return null;
  let v = m[1].trim();
  // Strip a trailing comment.
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\"/g, '"');
  } else if (v.startsWith("'") && v.endsWith("'")) {
    v = v.slice(1, -1);
  }
  return v;
}

function escapeYamlScalar(s: string): string {
  // We always quote when the string contains a colon, leading/trailing
  // whitespace, or special chars so the round trip stays clean.
  if (s === "" || /[:#\n\r"']/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

const STICKY_HEADER_RE = /^##\s+sticky-([A-Za-z0-9_-]+)\s*$/;
const META_RE = /^<!--\s*canvas-meta:\s*(\{[\s\S]*?\})\s*-->\s*$/;

function parseStickySections(body: string): Sticky[] {
  const out: Sticky[] = [];
  const lines = body.split(/\r?\n/);

  // Walk the body; each ## sticky-XYZ heading starts a section that runs
  // until the next ## sticky-XYZ heading or EOF.
  let i = 0;
  while (i < lines.length) {
    const headerMatch = lines[i].match(STICKY_HEADER_RE);
    if (!headerMatch) {
      i++;
      continue;
    }
    const id = headerMatch[1];
    let j = i + 1;
    while (j < lines.length && !STICKY_HEADER_RE.test(lines[j])) {
      j++;
    }
    const sectionLines = lines.slice(i + 1, j);
    const sticky = parseOneSticky(id, sectionLines);
    if (sticky) out.push(sticky);
    i = j;
  }
  return out;
}

function parseOneSticky(id: string, sectionLines: string[]): Sticky | null {
  // Find the canvas-meta line.
  let meta: Partial<Sticky> & { comments?: Comment[] } = {};
  let metaIdx = -1;
  for (let k = 0; k < sectionLines.length; k++) {
    const m = sectionLines[k].match(META_RE);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]) as Record<string, unknown>;
        meta = {
          x: typeof parsed.x === "number" ? parsed.x : 0,
          y: typeof parsed.y === "number" ? parsed.y : 0,
          color: STICKY_COLORS.includes(parsed.color as StickyColor)
            ? (parsed.color as StickyColor)
            : "yellow",
          author: typeof parsed.author === "string" ? parsed.author : "anon",
          is_agi: parsed.is_agi === true,
          created_at:
            typeof parsed.created_at === "string"
              ? parsed.created_at
              : new Date().toISOString(),
          comments: Array.isArray(parsed.comments)
            ? (parsed.comments as Comment[]).map(normalizeComment)
            : [],
        };
        metaIdx = k;
      } catch {
        meta = {};
      }
      break;
    }
  }

  // Body = lines after meta (or 0 if no meta), excluding the trailing
  // "### Replies" block and any later content.
  const startBody = metaIdx >= 0 ? metaIdx + 1 : 0;
  let endBody = sectionLines.length;
  for (let k = startBody; k < sectionLines.length; k++) {
    if (sectionLines[k].trim() === "### Replies") {
      endBody = k;
      break;
    }
  }
  const body = sectionLines
    .slice(startBody, endBody)
    .join("\n")
    .replace(/^\s+|\s+$/g, "")
    .replace(/^_\(empty\)_$/, "");

  // Replies block (chronological; we don't try to round-trip the textual
  // form — the canvas-meta JSON is authoritative). We DO seed the comments
  // list from the textual form when canvas-meta was missing/corrupt, so a
  // hand-edited file still loads its replies.
  if ((meta.comments?.length ?? 0) === 0 && endBody < sectionLines.length) {
    const repliesText = sectionLines.slice(endBody + 1).join("\n");
    meta.comments = parseRepliesText(repliesText);
  }

  return {
    id,
    x: meta.x ?? 0,
    y: meta.y ?? 0,
    color: meta.color ?? "yellow",
    author: meta.author ?? "anon",
    is_agi: meta.is_agi ?? false,
    created_at: meta.created_at ?? new Date().toISOString(),
    body,
    comments: meta.comments ?? [],
  };
}

function normalizeComment(c: Partial<Comment>): Comment {
  return {
    id: typeof c.id === "string" ? c.id : shortUuid(),
    author: typeof c.author === "string" ? c.author : "anon",
    is_agi: c.is_agi === true,
    created_at:
      typeof c.created_at === "string" ? c.created_at : new Date().toISOString(),
    body: typeof c.body === "string" ? c.body : "",
    ...(typeof c.reasoning_link === "string" ? { reasoning_link: c.reasoning_link } : {}),
  };
}

const REPLY_LINE_RE =
  /^-\s+\*\*(?<author>[^*]+?)(?:\s*\(AGI\))?\*\*\s+at\s+(?<ts>\S+):\s*(?<body>.*)$/;

function parseRepliesText(text: string): Comment[] {
  const out: Comment[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(REPLY_LINE_RE);
    if (!m || !m.groups) continue;
    out.push({
      id: shortUuid(),
      author: m.groups.author.trim(),
      is_agi: line.includes("(AGI)"),
      created_at: m.groups.ts,
      body: m.groups.body,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Convenience constructors
// ---------------------------------------------------------------------------

/** Build a fresh sticky with sensible defaults. */
export function newSticky(args: {
  author: string;
  is_agi?: boolean;
  x?: number;
  y?: number;
  color?: StickyColor;
  body?: string;
}): Sticky {
  return {
    id: shortUuid(),
    x: args.x ?? 80,
    y: args.y ?? 80,
    color: args.color ?? (args.is_agi ? "orange" : "yellow"),
    author: args.author,
    is_agi: args.is_agi ?? false,
    created_at: new Date().toISOString(),
    body: args.body ?? "",
    comments: [],
  };
}

/** Build a fresh comment with sensible defaults. */
export function newComment(args: {
  author: string;
  is_agi?: boolean;
  body: string;
}): Comment {
  return {
    id: shortUuid(),
    author: args.author,
    is_agi: args.is_agi ?? false,
    created_at: new Date().toISOString(),
    body: args.body,
  };
}

/** Build a fresh empty topic with one starter sticky. */
export function newTopic(args: {
  project: string;
  topic: string;
  title?: string;
  author: string;
}): CanvasTopic {
  return {
    project: args.project,
    topic: args.topic,
    title: args.title ?? args.topic,
    created_at: new Date().toISOString(),
    stickies: [
      newSticky({
        author: args.author,
        body: "Drop ideas here. Tangerine joins as a peer.",
        x: 120,
        y: 100,
      }),
    ],
  };
}
