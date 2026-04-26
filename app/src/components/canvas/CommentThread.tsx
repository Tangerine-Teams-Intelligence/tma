import { useState } from "react";
import ReactMarkdown from "react-markdown";
import type { Comment } from "@/lib/canvas";
import { newComment } from "@/lib/canvas";
import { Button } from "@/components/ui/button";

/**
 * v1.8 Phase 4-B — Comment thread for one sticky.
 *
 * Comments render chronologically (oldest first) — feels more like a
 * discussion thread than a feed. AGI comments are styled with an italic
 * 🍊 prefix on the author label so the user can tell at a glance who
 * said what.
 *
 * The reply textarea uses `data-ambient-id="canvas-reply-{stickyId}"` so
 * sibling P4-A's `<AmbientInputObserver>` can react inline. We do NOT
 * dispatch AGI behaviors directly here — that's automatic via the
 * observer.
 */
export function CommentThread({
  stickyId,
  comments,
  currentUser,
  onAppend,
}: {
  stickyId: string;
  comments: Comment[];
  currentUser: string;
  onAppend: (c: Comment) => void;
}) {
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSubmitting(true);
    onAppend(newComment({ author: currentUser, body: trimmed }));
    setDraft("");
    setSubmitting(false);
  };

  return (
    <section
      className="border-t border-stone-200/70 pt-2 dark:border-stone-700/70"
      data-testid={`comment-thread-${stickyId}`}
    >
      {comments.length > 0 && (
        <ul className="mb-2 space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="text-[12px]">
              <div className="flex items-baseline gap-2">
                <span
                  className={
                    c.is_agi
                      ? "italic font-medium text-[var(--ti-orange-600)] dark:text-[var(--ti-orange-500)]"
                      : "font-medium text-stone-800 dark:text-stone-200"
                  }
                >
                  {c.is_agi ? "🍊 " : ""}
                  {c.author}
                </span>
                <span className="font-mono text-[10px] text-stone-400 dark:text-stone-500">
                  {formatRelative(c.created_at)}
                </span>
              </div>
              <div className="mt-0.5 leading-snug text-stone-700 dark:text-stone-300">
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="m-0">{children}</p>,
                    a: ({ children, href }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--ti-orange-600)] underline-offset-2 hover:underline"
                      >
                        {children}
                      </a>
                    ),
                    code: ({ children }) => (
                      <code className="rounded bg-stone-200/80 px-1 font-mono text-[11px] text-stone-900 dark:bg-stone-700/80 dark:text-stone-100">
                        {children}
                      </code>
                    ),
                  }}
                >
                  {c.body}
                </ReactMarkdown>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-col gap-1.5">
        <textarea
          aria-label="Reply"
          placeholder="Reply…"
          data-ambient-id={`canvas-reply-${stickyId}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          rows={2}
          className="block w-full rounded border border-stone-300/70 bg-white/70 p-1.5 font-mono text-[11px] leading-snug text-stone-900 outline-none placeholder:text-stone-400 focus:border-[var(--ti-orange-500)] dark:border-stone-600/70 dark:bg-stone-800/70 dark:text-stone-100"
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={submit}
            disabled={submitting || draft.trim().length === 0}
            aria-label="Post reply"
          >
            Reply
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Coarse relative-time. Same look the rest of the app uses. */
function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diffMs = Date.now() - t;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}
