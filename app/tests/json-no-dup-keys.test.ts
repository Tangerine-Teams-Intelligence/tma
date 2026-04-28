// === v1.14.3 round-4 ===
// CI guard against duplicate JSON keys.
//
// The R4-class bug we're protecting against: an i18n PR added a second
// `"sources": { ... }` block at the root of `locales/{en,zh}/common.json`.
// `JSON.parse` silently keeps the second one and drops the first, which
// killed ~110 translation entries — caught only by manual audit. This test
// raw-parses every JSON file under `src/locales/` (and `src-tauri/` configs)
// with a duplicate-detecting tokenizer and fails if any key is repeated
// inside the same object.
//
// We re-parse rather than rely on `JSON.parse` because `JSON.parse` is the
// thing that loses the data. The tokenizer handles strings (with escapes),
// nested objects/arrays, and tracks the JSON-pointer path of each key so
// failures point straight at the offending location.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_APP_ROOT = resolve(__dirname, "..");

/** Walk a directory tree and yield every `.json` file path. */
function walkJson(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      // Skip generated / vendored trees that aren't our JSON to lint.
      if (name === "node_modules" || name === "target" || name === "dist" || name === "gen") continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile() && name.endsWith(".json")) out.push(full);
    }
  }
  return out;
}

/**
 * Tokenize a JSON document, returning every duplicate key path. Each
 * returned entry is a `/`-joined JSON pointer plus the duplicated key.
 *
 * We do a proper character walk instead of regex because regex can't
 * track nesting depth. The state machine handles:
 *   - string literals with `\"` escapes (so `"a\":` doesn't look like a key)
 *   - object vs array context (only objects have keys)
 *   - nested containers with a path stack
 */
export function findDuplicateJsonKeys(src: string): string[] {
  type Frame = { type: "object" | "array"; keys: Set<string>; pathSegment: string };
  const dups: string[] = [];
  const stack: Frame[] = [];
  let i = 0;
  let pendingKey: string | null = null;
  // True when the next string literal is a key (we just entered an object
  // or just saw a comma at object-level). False when it's a value.
  let expectKey = false;
  let arrayIndex = 0;

  function currentPath(): string {
    return stack
      .map((f) => f.pathSegment)
      .filter((s) => s.length > 0)
      .join("/");
  }

  while (i < src.length) {
    const ch = src[i];

    // Skip whitespace.
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }

    if (ch === "{") {
      const segment = pendingKey ?? (stack.length > 0 && stack[stack.length - 1].type === "array" ? String(arrayIndex++) : "");
      stack.push({ type: "object", keys: new Set(), pathSegment: segment });
      pendingKey = null;
      expectKey = true;
      i++;
      continue;
    }

    if (ch === "[") {
      const segment = pendingKey ?? (stack.length > 0 && stack[stack.length - 1].type === "array" ? String(arrayIndex++) : "");
      stack.push({ type: "array", keys: new Set(), pathSegment: segment });
      pendingKey = null;
      expectKey = false;
      arrayIndex = 0;
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      stack.pop();
      // After closing, the parent expects either a comma or its own close.
      // If parent is object, the next token after `,` is a key.
      expectKey = false;
      pendingKey = null;
      i++;
      continue;
    }

    if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top && top.type === "object") expectKey = true;
      pendingKey = null;
      i++;
      continue;
    }

    if (ch === ":") {
      // After the colon, the next string literal is a value, not a key.
      expectKey = false;
      i++;
      continue;
    }

    if (ch === '"') {
      // Read string literal with escape handling.
      let j = i + 1;
      let s = "";
      while (j < src.length) {
        const c = src[j];
        if (c === "\\") {
          // Preserve the escaped char literally — the exact value of the
          // string doesn't matter, only its identity. Skip both chars.
          s += c;
          if (j + 1 < src.length) s += src[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') break;
        s += c;
        j++;
      }
      i = j + 1;

      const top = stack[stack.length - 1];
      if (expectKey && top && top.type === "object") {
        if (top.keys.has(s)) {
          const path = currentPath();
          dups.push(path ? `${path}/${s}` : s);
        } else {
          top.keys.add(s);
        }
        pendingKey = s;
        expectKey = false;
      }
      continue;
    }

    // Numbers, true/false/null — not keys, not containers. Skip the token.
    i++;
  }

  return dups;
}

function relPath(p: string): string {
  return relative(REPO_APP_ROOT, p).replace(/\\/g, "/");
}

describe("JSON no duplicate keys (v1.14.3 round-4 CI guard)", () => {
  // Targets:
  //   - src/locales/**         — i18n bundles (R4 bug surface)
  //   - src-tauri/capabilities — tauri ACL declarations
  //   - src-tauri/tauri.conf.json — single file
  // Skip src-tauri/gen (generated) and target/ (build).
  const localesRoot = resolve(REPO_APP_ROOT, "src/locales");
  const capRoot = resolve(REPO_APP_ROOT, "src-tauri/capabilities");
  const tauriConf = resolve(REPO_APP_ROOT, "src-tauri/tauri.conf.json");

  const files = [
    ...walkJson(localesRoot),
    ...walkJson(capRoot),
    tauriConf,
  ].filter((p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  });

  it("scans at least one JSON file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${relPath(file)} has no duplicate keys`, () => {
      const src = readFileSync(file, "utf-8");
      const dups = findDuplicateJsonKeys(src);
      expect(dups, `duplicate keys in ${relPath(file)}: ${dups.join(", ")}`).toEqual([]);
    });
  }

  // Self-test: confirm the detector would catch the exact R4 bug pattern
  // (a second top-level "sources" block silently dropping the first one).
  it("detector catches the R4 bug pattern (synthetic fixture)", () => {
    const fixture = `{
      "sidebar": { "sources": "Sources" },
      "sources": { "rss": "RSS" },
      "settings": { "tab": "Settings" },
      "sources": { "podcast": "Podcast" }
    }`;
    const dups = findDuplicateJsonKeys(fixture);
    expect(dups).toContain("sources");
  });

  it("detector ignores same key in sibling objects (false-positive guard)", () => {
    const fixture = `{
      "a": { "sources": "x" },
      "b": { "sources": "y" }
    }`;
    const dups = findDuplicateJsonKeys(fixture);
    expect(dups).toEqual([]);
  });

  it("detector handles escaped quotes inside strings", () => {
    const fixture = `{
      "msg": "say \\"hi\\"",
      "msg": "duplicate"
    }`;
    const dups = findDuplicateJsonKeys(fixture);
    expect(dups).toContain("msg");
  });
});
// === end v1.14.3 round-4 ===
