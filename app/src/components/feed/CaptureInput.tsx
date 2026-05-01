/**
 * v1.21.0 — Operability surface B: Capture input.
 *
 * The pre-v1.21 canvas had no input surface — the user could read atoms
 * but not write them. The Capture input docks at the bottom of /feed
 * (sticky, inside the canvas-content area, NOT below the FooterHint)
 * and lets the user drop a thought / decision / note straight into the
 * timeline.
 *
 * Collapsed state: a single hairline-bordered row with a `+` glyph and
 * a placeholder. Click → expand into a 3-row textarea + tag chips
 * (decision / note / task) + Save button.
 *
 * Save path: `capture_manual_atom` Tauri command writes a markdown
 * atom to `personal/<user>/threads/manual/<utc-iso>.md` AND appends
 * a synthetic row to `timeline.json` so the next refresh of the
 * feed surfaces it without waiting for the daemon's 5-min Python
 * `index-rebuild`. The parent passes `onCaptured(event)` which it
 * uses to optimistically prepend the new row.
 *
 * Honesty (R6): save failures surface via toast with the actual Rust
 * error message (truncated to 80 chars). On success a quiet
 * `Captured ✓` toast fires + the input collapses + the textarea
 * clears.
 *
 * Keyboard:
 *   • ⌘+Enter (or Ctrl+Enter on Win/Linux) → save
 *   • Escape → collapse without saving
 *
 * Single-accent rule: Save button = `var(--ti-orange-500)`. Tag chips
 * are stone-bordered until the active tag, which gets the orange
 * border + stone bg.
 */

import { useEffect, useRef, useState } from "react";
import {
  captureManualAtom,
  type ManualAtomKind,
  type TimelineEvent,
} from "@/lib/views";
import { useStore } from "@/lib/store";

interface CaptureInputProps {
  /** Current user — drives the user/<user>/threads/manual/ path. */
  user: string;
  /** Called with the new TimelineEvent so the parent can prepend it. */
  onCaptured: (ev: TimelineEvent) => void;
}

const KINDS: { id: ManualAtomKind; label: string }[] = [
  { id: "decision", label: "decision" },
  { id: "note", label: "note" },
  { id: "task", label: "task" },
];

const COLLAPSED_PLACEHOLDER = "Type a thought, decision, or note…";

export function CaptureInput({ user, onCaptured }: CaptureInputProps) {
  const pushToast = useStore((s) => s.ui.pushToast);
  const [expanded, setExpanded] = useState(false);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<ManualAtomKind>("note");
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Auto-focus the textarea once expanded.
  useEffect(() => {
    if (expanded) {
      const id = window.setTimeout(() => taRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [expanded]);

  // ESC collapses without saving (only when expanded so we don't fight
  // /feed's other handlers).
  useEffect(() => {
    if (!expanded) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setExpanded(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  async function save() {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
      pushToast("info", "Capture is empty — type something first.");
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const out = await captureManualAtom(user, trimmed, kind, user);
      onCaptured(out.event);
      setBody("");
      setKind("note");
      setExpanded(false);
      pushToast("success", "Captured ✓");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const trimmedMsg = msg.length > 80 ? msg.slice(0, 77) + "…" : msg;
      pushToast("error", `Capture failed: ${trimmedMsg}`);
    } finally {
      setBusy(false);
    }
  }

  function onTextareaKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  }

  if (!expanded) {
    return (
      <div
        data-testid="feed-capture-input"
        data-mode="collapsed"
        className="sticky bottom-0 z-10 border-t border-stone-200 bg-stone-50/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90"
      >
        <button
          type="button"
          data-testid="feed-capture-expand"
          onClick={() => setExpanded(true)}
          className="mx-auto flex w-full max-w-2xl cursor-pointer items-center gap-3 px-8 py-3 text-left transition-colors hover:bg-stone-100 dark:hover:bg-stone-900"
        >
          <span
            aria-hidden
            className="font-mono text-[14px] text-stone-500 dark:text-stone-500"
          >
            +
          </span>
          <span className="text-[13px] text-stone-500 dark:text-stone-500">
            {COLLAPSED_PLACEHOLDER}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-testid="feed-capture-input"
      data-mode="expanded"
      className="sticky bottom-0 z-10 border-t border-stone-200 bg-stone-50/95 backdrop-blur dark:border-stone-800 dark:bg-stone-950/95"
    >
      <div className="mx-auto w-full max-w-2xl px-8 py-4">
        <p className="mb-2 text-[13px] text-stone-700 dark:text-stone-300">
          what's on your mind?
        </p>
        <textarea
          ref={taRef}
          data-testid="feed-capture-textarea"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={onTextareaKey}
          rows={3}
          maxLength={32000}
          className="w-full resize-y rounded-md border border-stone-200 bg-white px-3 py-2 text-[13px] text-stone-900 outline-none transition-colors focus:border-[var(--ti-orange-500)] dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-stone-500 dark:text-stone-500">
              tag as:
            </span>
            {KINDS.map((k) => {
              const active = kind === k.id;
              return (
                <button
                  key={k.id}
                  type="button"
                  data-testid={`feed-capture-tag-${k.id}`}
                  data-active={active ? "true" : "false"}
                  onClick={() => setKind(k.id)}
                  className={
                    "rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors " +
                    (active
                      ? "border-[var(--ti-orange-500)] bg-stone-100 text-stone-900 dark:bg-stone-900 dark:text-stone-100"
                      : "border-stone-200 text-stone-500 hover:border-stone-300 hover:text-stone-700 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-600 dark:hover:text-stone-200")
                  }
                >
                  {k.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="feed-capture-cancel"
              onClick={() => {
                setBody("");
                setExpanded(false);
              }}
              className="font-mono text-[11px] text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-300"
            >
              cancel
            </button>
            <button
              type="button"
              data-testid="feed-capture-save-btn"
              onClick={() => void save()}
              disabled={busy || body.trim().length === 0}
              className="rounded-md bg-[var(--ti-orange-500)] px-3 py-1 text-[12px] font-medium text-white transition-colors hover:bg-[var(--ti-orange-700)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Saving…" : "Save"}
              <span className="ml-2 font-mono text-[10px] opacity-80">⌘↩</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
