import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Trash2, Palette } from "lucide-react";
import type { Sticky, StickyColor, Comment } from "@/lib/canvas";
import { STICKY_COLORS } from "@/lib/canvas";
import { CommentThread } from "./CommentThread";

/**
 * v1.8 Phase 4-B — One sticky note on the canvas.
 *
 * Visible structure:
 *   ┌─────────────────────────────────────┐
 *   │ ▒▒▒ drag-bar                  ✕ ⋯  │  ← grip + delete + color swatch
 *   │ author · time                       │
 *   │ ┌───────────────────────────────┐  │
 *   │ │ markdown body editor (textarea)│ │
 *   │ └───────────────────────────────┘  │
 *   │ — replies —                         │
 *   │ • alice · "go for it" · 2m ago      │
 *   │ • [textarea: reply...]              │
 *   └─────────────────────────────────────┘
 *
 * Position is absolute; CanvasView is the relatively-positioned ancestor.
 * Drag-to-reposition is mouse-only on the header bar — wheel + drag on
 * the canvas body itself is captured by CanvasView (pan/zoom).
 *
 * The body textarea carries `data-ambient-id="canvas-sticky-{uuid}"` so
 * sibling P4-A's `<AmbientInputObserver>` can react inline. P4-C wires
 * the actual AGI peer behaviors on top of these IDs — we don't dispatch
 * AGI here.
 */
export function StickyNote({
  sticky,
  scale,
  onChange,
  onDelete,
  onAppendComment,
  currentUser,
}: {
  sticky: Sticky;
  /** Current canvas zoom scale — used to make the header drag map 1:1
   *  with the cursor regardless of zoom. */
  scale: number;
  onChange: (next: Sticky) => void;
  onDelete: () => void;
  onAppendComment: (c: Comment) => void;
  currentUser: string;
}) {
  const [editing, setEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(sticky.body);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const dragStateRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);

  // Keep bodyDraft in sync if the parent re-renders the same sticky after a
  // save (so AGI updates from P4-C don't get clobbered by stale local state).
  useEffect(() => {
    if (!editing) setBodyDraft(sticky.body);
  }, [sticky.body, editing]);

  const onHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dragStateRef.current = {
      ox: e.clientX,
      oy: e.clientY,
      sx: sticky.x,
      sy: sticky.y,
    };
    const onMove = (ev: MouseEvent) => {
      const st = dragStateRef.current;
      if (!st) return;
      const dx = (ev.clientX - st.ox) / scale;
      const dy = (ev.clientY - st.oy) / scale;
      onChange({ ...sticky, x: Math.round(st.sx + dx), y: Math.round(st.sy + dy) });
    };
    const onUp = () => {
      dragStateRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const onDeleteClick = () => {
    if (window.confirm(`Delete this sticky?\n\n"${sticky.body.slice(0, 80)}"`)) {
      onDelete();
    }
  };

  const onBodyBlur = () => {
    if (!editing) return;
    setEditing(false);
    if (bodyDraft !== sticky.body) {
      onChange({ ...sticky, body: bodyDraft });
    }
  };

  const onColorPick = (c: StickyColor) => {
    onChange({ ...sticky, color: c });
    setShowColorPicker(false);
  };

  const palette = colorClasses(sticky.color);

  return (
    <div
      data-testid={`sticky-${sticky.id}`}
      className={`absolute w-[260px] rounded-md border shadow-sm ${palette.bg} ${palette.border}`}
      style={{
        left: sticky.x,
        top: sticky.y,
      }}
    >
      {/* Header / drag bar */}
      <div
        className={`flex items-center gap-2 rounded-t-md border-b px-2 py-1 ${palette.headerBg} ${palette.border} cursor-grab active:cursor-grabbing`}
        onMouseDown={onHeaderMouseDown}
        data-testid={`sticky-${sticky.id}-drag-handle`}
      >
        <span
          className={`text-[11px] font-medium truncate ${palette.headerText}`}
          aria-label="author"
        >
          {sticky.is_agi ? "🍊 " : ""}
          {sticky.author}
        </span>
        <span className="font-mono text-[10px] text-stone-500 dark:text-stone-400">
          {formatRelative(sticky.created_at)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            aria-label="Change color"
            title="Change color"
            onClick={(e) => {
              e.stopPropagation();
              setShowColorPicker((v) => !v);
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-stone-500 hover:bg-stone-200/60 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-stone-700/60 dark:hover:text-stone-200"
          >
            <Palette size={11} />
          </button>
          <button
            type="button"
            aria-label="Delete sticky"
            title="Delete sticky"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteClick();
            }}
            onMouseDown={(e) => e.stopPropagation()}
            className="rounded p-0.5 text-stone-500 hover:bg-rose-200/60 hover:text-rose-700 dark:text-stone-400 dark:hover:bg-rose-900/60 dark:hover:text-rose-200"
          >
            <Trash2 size={11} />
          </button>
        </div>
      </div>

      {/* Color picker dropdown — anchored under the palette button */}
      {showColorPicker && (
        <div
          className="absolute right-1 top-7 z-10 flex gap-1 rounded border border-stone-300 bg-white p-1 shadow-md dark:border-stone-700 dark:bg-stone-800"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {STICKY_COLORS.map((c) => {
            const swatchPalette = colorClasses(c);
            return (
              <button
                key={c}
                type="button"
                aria-label={`Set color ${c}`}
                onClick={() => onColorPick(c)}
                className={`h-4 w-4 rounded border ${swatchPalette.bg} ${swatchPalette.border} ${
                  c === sticky.color ? "ring-1 ring-[var(--ti-orange-500)]" : ""
                }`}
                title={c}
              />
            );
          })}
        </div>
      )}

      {/* Body */}
      <div className="px-2 py-2">
        {editing ? (
          <textarea
            aria-label="Sticky body"
            data-ambient-id={`canvas-sticky-${sticky.id}`}
            value={bodyDraft}
            autoFocus
            onChange={(e) => setBodyDraft(e.target.value)}
            onBlur={onBodyBlur}
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            rows={4}
            className={`block w-full rounded bg-transparent p-1 font-sans text-[12px] leading-relaxed outline-none ${palette.text}`}
          />
        ) : (
          <button
            type="button"
            className={`block w-full text-left text-[12px] leading-relaxed ${palette.text} cursor-text`}
            onClick={() => setEditing(true)}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="Edit body"
          >
            {sticky.body.trim() === "" ? (
              <span className="italic text-stone-400 dark:text-stone-500">
                (click to edit)
              </span>
            ) : (
              <ReactMarkdown
                components={{
                  p: ({ children }) => (
                    <p className="m-0 whitespace-pre-wrap">{children}</p>
                  ),
                  ul: ({ children }) => (
                    <ul className="ml-4 list-disc">{children}</ul>
                  ),
                  ol: ({ children }) => (
                    <ol className="ml-4 list-decimal">{children}</ol>
                  ),
                  a: ({ children, href }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-2 hover:underline"
                    >
                      {children}
                    </a>
                  ),
                  code: ({ children }) => (
                    <code className="rounded bg-stone-200/60 px-1 font-mono text-[11px] dark:bg-stone-700/60">
                      {children}
                    </code>
                  ),
                }}
              >
                {sticky.body}
              </ReactMarkdown>
            )}
          </button>
        )}
      </div>

      {/* Comments */}
      <div className="px-2 pb-2">
        <CommentThread
          stickyId={sticky.id}
          comments={sticky.comments}
          currentUser={currentUser}
          onAppend={onAppendComment}
        />
      </div>
    </div>
  );
}

interface ColorPalette {
  bg: string;
  headerBg: string;
  border: string;
  text: string;
  headerText: string;
}

function colorClasses(color: StickyColor): ColorPalette {
  switch (color) {
    case "yellow":
      return {
        bg: "bg-yellow-100 dark:bg-yellow-900/40",
        headerBg: "bg-yellow-200/70 dark:bg-yellow-800/60",
        border: "border-yellow-300 dark:border-yellow-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-yellow-900 dark:text-yellow-100",
      };
    case "pink":
      return {
        bg: "bg-pink-100 dark:bg-pink-900/40",
        headerBg: "bg-pink-200/70 dark:bg-pink-800/60",
        border: "border-pink-300 dark:border-pink-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-pink-900 dark:text-pink-100",
      };
    case "blue":
      return {
        bg: "bg-blue-100 dark:bg-blue-900/40",
        headerBg: "bg-blue-200/70 dark:bg-blue-800/60",
        border: "border-blue-300 dark:border-blue-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-blue-900 dark:text-blue-100",
      };
    case "green":
      return {
        bg: "bg-emerald-100 dark:bg-emerald-900/40",
        headerBg: "bg-emerald-200/70 dark:bg-emerald-800/60",
        border: "border-emerald-300 dark:border-emerald-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-emerald-900 dark:text-emerald-100",
      };
    case "orange":
      return {
        bg: "bg-orange-100 dark:bg-orange-900/40",
        headerBg: "bg-[var(--ti-orange-200,#FFD9B8)] dark:bg-orange-800/60",
        border: "border-[var(--ti-orange-400,#F0A56D)] dark:border-orange-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-[var(--ti-orange-700)] dark:text-[var(--ti-orange-500)]",
      };
    case "purple":
      return {
        bg: "bg-purple-100 dark:bg-purple-900/40",
        headerBg: "bg-purple-200/70 dark:bg-purple-800/60",
        border: "border-purple-300 dark:border-purple-700",
        text: "text-stone-900 dark:text-stone-100",
        headerText: "text-purple-900 dark:text-purple-100",
      };
  }
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(iso).toLocaleDateString();
}
