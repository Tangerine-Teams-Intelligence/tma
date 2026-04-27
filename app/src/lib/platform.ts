/**
 * Platform-aware UI helpers.
 *
 * The app responds to both Cmd+K and Ctrl+K (see AppShell), but the on-screen
 * hint should match the actual chord the user types on their OS:
 *   - macOS         → ⌘K
 *   - Windows/Linux → Ctrl+K
 *
 * We detect the OS via `navigator.platform` (with a userAgent fallback for
 * newer engines that have started returning `""` from `platform`). Pure read
 * — no side effects, safe to call from any render path.
 */

function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (platform) {
    return /Mac|iPhone|iPad|iPod/i.test(platform);
  }
  // Fallback for browsers that hide `navigator.platform` behind privacy.
  const ua = navigator.userAgent || "";
  return /Mac|iPhone|iPad|iPod/i.test(ua);
}

// === wave 5-γ ===
/**
 * Detect Windows via `navigator.platform` / `userAgent`. Used by the AI-tool
 * setup pages to show `%USERPROFILE%\.cursor\mcp.json` instead of the macOS
 * `~/.cursor/mcp.json` the static config defaults to. Pure read — no side
 * effects.
 *
 * Windows-side fallback note: in Tauri the embedded WebView2 chrome reports
 * `"Win32"` in `navigator.platform` even on 64-bit hosts (legacy quirk), and
 * newer Edge/Chrome have started privacy-shielding `platform`. The userAgent
 * fallback catches both.
 */
function isWindowsPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (platform) {
    return /Win/i.test(platform);
  }
  const ua = navigator.userAgent || "";
  return /Windows/i.test(ua);
}

/**
 * Returns the display string for the cmd-k chord. macOS shows the Apple
 * command symbol; everything else gets a literal "Ctrl+K" since `^` and `Ctrl`
 * are easy to mis-read.
 */
export function kbdShortcut(key: string): string {
  return isMacPlatform() ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

/** True when the app is running on a Mac. Exposed for any extra UI tweaks. */
export function isMac(): boolean {
  return isMacPlatform();
}

// === wave 5-γ ===
/** True when the app is running on Windows. Used for path display. */
export function isWindows(): boolean {
  return isWindowsPlatform();
}

// === wave 5-γ ===
/**
 * Translate a POSIX-flavoured config-file path placeholder
 * (`~/.cursor/mcp.json`) into the OS-correct display string.
 *
 *   macOS / Linux : `~/.cursor/mcp.json`            (unchanged)
 *   Windows       : `%USERPROFILE%\.cursor\mcp.json`
 *
 * The Tangerine MCP catalog stores POSIX paths because the source-of-truth
 * docs target macOS (where most early users live). This helper lets the UI
 * stay honest on Windows without forking the catalog. Returns the input
 * unchanged for paths that don't start with `~/` (e.g. the Windsurf
 * `Settings → MCP` placeholder, which is already OS-neutral).
 *
 * The clipboard JSON snippet itself is OS-neutral and is NOT touched here —
 * the Cursor / Claude Code / Codex MCP loaders all accept the same JSON on
 * Windows and macOS.
 */
export function mcpConfigDisplayPath(posixPath: string): string {
  if (!posixPath.startsWith("~/")) return posixPath;
  const rest = posixPath.slice(2); // drop "~/"
  if (isWindowsPlatform()) {
    return `%USERPROFILE%\\${rest.replace(/\//g, "\\")}`;
  }
  return posixPath;
}
