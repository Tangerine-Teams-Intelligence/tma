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
      // v1.17.5 — condensed from 4-section wall (uppercase header + 2-line
      // explainer + code block + button row) to a single inline row:
      // "paste this into CLAUDE.md → [import line] [copy]". Same testIds.
      className="mx-auto mt-6 flex w-full max-w-md flex-col items-stretch gap-2 rounded-md border border-stone-700 bg-stone-900/60 px-3 py-2.5 text-left"
    >
      <p className="text-[11px] leading-snug text-stone-400">
        Paste into your <code className="text-stone-300">CLAUDE.md</code> /
        Cursor rules so AI sessions inherit team memory:
      </p>
      <div className="flex items-center gap-2">
        <code
          data-testid="team-memory-hint-line"
          className="min-w-0 flex-1 truncate rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-stone-300"
        >
          {IMPORT_LINE}
        </code>
        <button
          type="button"
          data-testid="team-memory-hint-copy"
          onClick={copy}
          className="inline-flex shrink-0 items-center gap-1.5 rounded border border-stone-600 bg-stone-800/80 px-2 py-1 text-[11px] text-stone-200 hover:bg-stone-700"
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          {copied ? "Copied" : "Copy import line"}
        </button>
      </div>
      {err && (
        <span data-testid="team-memory-hint-err" className="text-[10px] text-rose-400">
          {err}
        </span>
      )}
    </div>
  );
}
