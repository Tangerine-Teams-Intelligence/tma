/**
 * Auto-scrolling transcript view. Used by both MD-0 (passive) and LV-0 (live).
 * Locks scroll-to-bottom when user scrolls up; resumes when they hit bottom.
 */
import { useEffect, useRef, useState } from "react";

import { tailFile, type TailHandle } from "@/lib/tauri";

interface Props {
  meetingId: string;
  initialLineCount?: number;
  /** Override path (defaults to derived path). */
  path?: string;
}

export function TranscriptTail({ meetingId, initialLineCount, path }: Props) {
  const [lines, setLines] = useState<string[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let handle: TailHandle | null = null;
    let cancelled = false;
    const target = path ?? `meetings/${meetingId}/transcript.md`;
    void tailFile(target, (line) => {
      if (cancelled) return;
      setLines((prev) => [...prev, line]);
    }).then((h) => {
      if (cancelled) {
        h.unsubscribe();
        return;
      }
      handle = h;
    });
    return () => {
      cancelled = true;
      handle?.unsubscribe();
    };
  }, [meetingId, path]);

  useEffect(() => {
    if (!autoScroll) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setAutoScroll(atBottom);
  };

  return (
    <div className="flex h-full flex-col" data-testid="transcript-tail">
      <div className="flex items-center justify-between border-b border-[var(--ti-border-faint)] pb-2 text-xs text-[var(--ti-ink-500)]">
        <span>
          {lines.length || initialLineCount || 0} line
          {(lines.length || initialLineCount || 0) === 1 ? "" : "s"}
        </span>
        {!autoScroll && (
          <button
            onClick={() => setAutoScroll(true)}
            className="text-[var(--ti-orange-700)] hover:underline"
          >
            Resume auto-scroll
          </button>
        )}
      </div>
      <div
        ref={containerRef}
        onScroll={onScroll}
        className="flex-1 overflow-auto rounded-md bg-[var(--ti-paper-100)] p-3 font-mono text-xs leading-relaxed text-[var(--ti-ink-700)]"
      >
        {lines.length === 0 ? (
          <p className="text-[var(--ti-ink-500)]">Waiting for transcript…</p>
        ) : (
          <ol className="list-decimal pl-8 space-y-0.5">
            {lines.map((l, i) => (
              <li key={i} id={`L${i + 1}`}>
                {l}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
