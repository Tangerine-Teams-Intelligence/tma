// === wave 20 ===
/**
 * Wave 20 — team brain status widget for /today.
 *
 * Reads the team brain doc (`~/.tangerine-memory/team/co-thinker.md`) and
 * the brain status snapshot in parallel. Shows:
 *   • Last sync line: "Last sync: 2m ago via cursor" (or "never" when the
 *     brain hasn't fired yet).
 *   • First ~150 chars of the brain doc body, frontmatter stripped.
 *   • [Open] action → /brain (Wave 19 alias to /co-thinker).
 *
 * Defensive: any read error renders inline. Empty brain (zero atoms
 * captured) shows a quiet "Team brain hasn't started thinking yet" line.
 */

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  coThinkerReadBrain,
  coThinkerStatus,
  type CoThinkerStatus,
} from "@/lib/tauri";
import { DashboardWidget } from "./DashboardWidget";

const BRAIN_PREVIEW_CHARS = 200;

export function BrainStatusWidget() {
  const [brainText, setBrainText] = useState<string>("");
  const [status, setStatus] = useState<CoThinkerStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [text, st] = await Promise.all([
          coThinkerReadBrain(),
          coThinkerStatus(),
        ]);
        if (cancelled) return;
        setBrainText(text);
        setStatus(st);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const preview = stripFrontmatter(brainText).slice(0, BRAIN_PREVIEW_CHARS);
  const hasBrain = preview.trim().length > 0;
  const lastSyncLabel = formatLastSync(status?.last_heartbeat_at ?? null);

  return (
    <DashboardWidget
      testId="dashboard-brain-status"
      /* === wave 20 wrap-needed === */
      title="Team brain status"
      action={{
        /* === wave 20 wrap-needed === */
        label: "Open",
        // Wave 19 added /brain alias to /co-thinker. /co-thinker URL still
        // works as a permanent fallback.
        to: "/brain",
      }}
      loading={loading}
      errorMessage={error}
    >
      <p
        data-testid="dashboard-brain-status-sync"
        className="font-mono text-[10px] uppercase tracking-wider text-[var(--ti-ink-500)]"
      >
        {/* === wave 20 wrap-needed === */}
        Last sync: {lastSyncLabel}
      </p>
      {hasBrain ? (
        <p
          data-testid="dashboard-brain-status-preview"
          className="mt-2 line-clamp-3 text-[12px] leading-relaxed text-[var(--ti-ink-900)]"
        >
          {preview}
          {brainText.length > BRAIN_PREVIEW_CHARS ? "…" : ""}
        </p>
      ) : (
        <p
          data-testid="dashboard-brain-status-empty"
          className="mt-2 text-[12px] text-[var(--ti-ink-500)]"
        >
          {/* === wave 20 wrap-needed === */}
          Team brain hasn't started thinking yet. Connect a tool to wake it
          up.
        </p>
      )}
      {/* === wave 24 === — quick link to today's daily note. Lives in the
          BrainStatusWidget rather than as a 6th sidebar item (Wave 19
          locked the sidebar at 5). The /daily route is also reachable via
          the memory tree (team/daily/) and Cmd+K. */}
      <Link
        to="/daily"
        data-testid="dashboard-brain-status-daily-link"
        className="mt-3 inline-block font-mono text-[10px] uppercase tracking-wider text-[var(--ti-orange-500)] hover:underline"
      >
        Today's daily note →
      </Link>
      {/* === end wave 24 === */}
    </DashboardWidget>
  );
}

/** Drop a leading `---\n…\n---\n` YAML frontmatter block if present so
 *  the preview shows actual brain prose, not metadata. */
function stripFrontmatter(s: string): string {
  if (!s.startsWith("---")) return s.trim();
  const end = s.indexOf("\n---", 3);
  if (end < 0) return s.trim();
  return s.slice(end + 4).trim();
}

function formatLastSync(iso: string | null): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "never";
  const dSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (dSec < 60) return `${dSec}s ago`;
  const dMin = Math.floor(dSec / 60);
  if (dMin < 60) return `${dMin}m ago`;
  const dHr = Math.floor(dMin / 60);
  if (dHr < 24) return `${dHr}h ago`;
  const dDay = Math.floor(dHr / 24);
  return `${dDay}d ago`;
}
// === end wave 20 ===
