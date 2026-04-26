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
