/**
 * v1.17.1 — TEAM_INDEX.md import-line copy card.
 *
 * Mounted under Step 4 of the magic-moment onboarding so the user
 * leaves the wizard knowing exactly what to paste into their project's
 * CLAUDE.md (or Cursor rules / etc.) to bridge captured atoms into a
 * fresh AI session.
 *
 * Honesty: we render the static @import line + Copy button regardless
 * of whether the file exists yet. The daemon writes the file on the
 * next heartbeat (or `writeTeamIndex` fires it manually); paste-now,
 * receive-bridge-on-first-capture is a fine UX.
 */

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { writeTeamIndex } from "@/lib/tauri";

const IMPORT_LINE = "@~/.tangerine-memory/TEAM_INDEX.md";

export function TeamMemoryHint() {
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function copy() {
    setErr(null);
    // Best-effort kick the file into existence so the import resolves on
    // the user's first AI session even if the daemon heartbeat hasn't
    // fired yet. Failures here are non-fatal — the daemon will catch up.
    void writeTeamIndex().catch(() => {
      /* ignore — daemon heartbeat will rewrite */
    });
    try {
      await navigator.clipboard.writeText(IMPORT_LINE);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setErr("Couldn't copy. Select the line manually below.");
    }
  }

  return (
    <div
      data-testid="team-memory-hint"
      className="mx-auto mt-8 w-full max-w-md rounded-md border border-stone-700 bg-stone-900/60 p-4 text-left"
    >
      <p className="text-xs uppercase tracking-wider text-stone-400">
        Bridge to your AI sessions
      </p>
      <p className="mt-2 text-sm text-stone-200">
        Paste this into your project&apos;s <code>CLAUDE.md</code> (or Cursor
        rules) so any new AI session inherits your team&apos;s recent memory:
      </p>
      <div
        data-testid="team-memory-hint-line"
        className="mt-3 break-all rounded bg-black/40 px-3 py-2 font-mono text-[11px] text-stone-300"
      >
        {IMPORT_LINE}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          data-testid="team-memory-hint-copy"
          onClick={copy}
          className="inline-flex items-center gap-2 rounded-md border border-stone-600 bg-stone-800/80 px-3 py-1.5 text-xs text-stone-200 hover:bg-stone-700"
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy import line"}
        </button>
        {err && (
          <span data-testid="team-memory-hint-err" className="text-[11px] text-rose-400">
            {err}
          </span>
        )}
      </div>
    </div>
  );
}
