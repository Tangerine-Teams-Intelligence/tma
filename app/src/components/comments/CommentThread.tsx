// === wave 1.13-B ===
/**
 * Wave 1.13-B L5 — `<CommentThread/>`. Renders one paragraph-anchored
 * thread: list of comments + reply input + resolve / archive actions.
 *
 * Pure presentation — the parent (`<CommentSidebar/>`) owns the network
 * round-trips and re-renders on `onChanged()`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Archive, RotateCcw, MessageCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommentInput } from "@/components/comments/CommentInput";
import { cn } from "@/lib/utils";
import type { CommentThread as CommentThreadModel } from "@/lib/tauri";

export interface CommentThreadProps {
  thread: CommentThreadModel;
  currentUser: string;
  onReply: (body: string) => Promise<void> | void;
  onResolve: () => Promise<void> | void;
  onUnresolve: () => Promise<void> | void;
  onArchive: () => Promise<void> | void;
  /** When true the thread is the one currently scrolled-to in the sidebar
   *  (e.g. user clicked a paragraph that anchors here) — we add a subtle
   *  ring so the focus is visible. */
  active?: boolean;
}

export function CommentThread({
  thread,
  currentUser,
  onReply,
  onResolve,
  onUnresolve,
  onArchive,
  active = false,
}: CommentThreadProps) {
  const { t } = useTranslation();
  const [showReply, setShowReply] = useState(false);

  return (
    <article
      data-testid={`comment-thread-${thread.thread_id}`}
      data-thread-id={thread.thread_id}
      className={cn(
        "rounded border bg-white p-3 transition dark:bg-stone-900",
        thread.resolved
          ? "border-stone-200 opacity-70 dark:border-stone-800"
          : "border-amber-200 dark:border-amber-900/40",
        active && "ring-2 ring-[var(--ti-orange-500)]",
      )}
    >
      <header className="mb-2 flex items-center justify-between text-[10px] text-stone-500 dark:text-stone-400">
        <span className="font-mono">
          {t("comments.anchorParagraph", { n: thread.anchor.paragraph_index + 1 })}
        </span>
        <span className="flex items-center gap-1">
          {thread.resolved ? (
            <button
              type="button"
              onClick={() => void onUnresolve()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
              data-testid={`comment-thread-unresolve-${thread.thread_id}`}
            >
              <RotateCcw size={10} />
              {t("comments.unresolve")}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void onResolve()}
              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
              data-testid={`comment-thread-resolve-${thread.thread_id}`}
            >
              <Check size={10} />
              {t("comments.resolve")}
            </button>
          )}
          <button
            type="button"
            onClick={() => void onArchive()}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-stone-100 dark:hover:bg-stone-800"
            data-testid={`comment-thread-archive-${thread.thread_id}`}
          >
            <Archive size={10} />
            {t("comments.archive")}
          </button>
        </span>
      </header>

      <ul className="space-y-2">
        {thread.comments.map((c) => (
          <li
            key={c.id}
            className="rounded bg-stone-50 px-2 py-1.5 text-[12px] dark:bg-stone-950"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-medium text-stone-800 dark:text-stone-200">
                {c.author}
                {c.author === currentUser && (
                  <span className="ml-1 text-[9px] text-stone-400">
                    {t("comments.youSuffix")}
                  </span>
                )}
              </span>
              <time className="text-[10px] text-stone-400 dark:text-stone-500">
                {new Date(c.created_at).toLocaleString()}
              </time>
            </div>
            <p className="mt-1 whitespace-pre-wrap text-stone-700 dark:text-stone-300">
              {renderBody(c.body)}
            </p>
          </li>
        ))}
      </ul>

      {!thread.resolved &&
        (showReply ? (
          <div className="mt-2">
            <CommentInput
              variant="reply"
              autoFocus
              onSubmit={async (body) => {
                await onReply(body);
                setShowReply(false);
              }}
              testId={`comment-reply-${thread.thread_id}`}
            />
            <button
              type="button"
              onClick={() => setShowReply(false)}
              className="mt-1 text-[10px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
            >
              {t("comments.cancelReply")}
            </button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowReply(true)}
            className="mt-1"
            data-testid={`comment-thread-reply-${thread.thread_id}`}
          >
            <MessageCircle size={12} className="mr-1" />
            {t("comments.reply")}
          </Button>
        ))}
    </article>
  );
}

/**
 * Highlight `@username` mentions inline. Keep it minimal — no markdown,
 * just a colour bump on the mention token so the user can see who was
 * tagged.
 */
function renderBody(body: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(^|\s)@([A-Za-z0-9_-]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(body)) !== null) {
    const startOfMention = m.index + m[1].length;
    if (startOfMention > last) parts.push(body.slice(last, startOfMention));
    parts.push(
      <span
        key={key++}
        className="rounded bg-amber-50 px-0.5 font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
      >
        @{m[2]}
      </span>,
    );
    last = startOfMention + m[2].length + 1; // +1 for the `@`
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts.length > 0 ? parts : body;
}
// === end wave 1.13-B ===
