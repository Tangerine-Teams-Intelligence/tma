// === wave 1.13-B ===
/**
 * Wave 1.13-B L5 — `<CommentSidebar/>`. Slide-in panel that lists every
 * thread on the active atom, scrolled to the user's selected paragraph
 * when applicable. Top of the panel has a "new thread" input that
 * defaults to anchoring on the active paragraph (or paragraph 0 when
 * none is selected).
 *
 * The parent (typically `<MemoryPreview/>`) controls visibility via
 * `open` / `onClose`. The sidebar manages its own thread fetch + cache.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X, MessageSquare, ChevronUp, ChevronDown } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CommentInput } from "@/components/comments/CommentInput";
import { CommentThread as CommentThreadView } from "@/components/comments/CommentThread";
import {
  commentsArchive,
  commentsCreate,
  commentsList,
  commentsResolve,
  commentsUnresolve,
  paragraphFingerprint,
  type CommentThread,
  type ParagraphAnchor,
} from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { readMemoryFile, stripFrontmatter } from "@/lib/memory";
import { cn } from "@/lib/utils";

export interface CommentSidebarProps {
  atomPath: string;
  currentUser: string;
  open: boolean;
  onClose: () => void;
  /** Active paragraph index (e.g. user clicked a paragraph). When set, we
   *  scroll to the matching thread + default the new-thread anchor. */
  activeParagraph?: number;
  /** Notified after every CRUD round-trip so the parent can rerender any
   *  paragraph-highlight markers. */
  onChanged?: () => void;
}

export function CommentSidebar({
  atomPath,
  currentUser,
  open,
  onClose,
  activeParagraph,
  onChanged,
}: CommentSidebarProps) {
  const { t } = useTranslation();
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  // === v1.13.2 round-2 ===
  // Cache of paragraph fingerprints for the current atom body. Computed
  // once per `atomPath` so creating a thread can attach the fingerprint
  // without re-reading the file each time. Empty {} on initial mount; the
  // effect below populates it best-effort.
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const fingerprintsRef = useRef<Record<number, string>>({});
  useEffect(() => {
    if (!open) return;
    let cancel = false;
    void (async () => {
      try {
        const raw = await readMemoryFile(memoryRoot, atomPath);
        if (cancel) return;
        const body = stripFrontmatter(raw ?? "");
        // Paragraph split mirrors the typical markdown contract: blank
        // lines separate paragraphs. Best-effort — if the renderer disagrees,
        // the fingerprint just won't match and we fall back to index-only.
        const paragraphs = body.split(/\n\s*\n/);
        const next: Record<number, string> = {};
        paragraphs.forEach((p, i) => {
          const fp = paragraphFingerprint(p);
          if (fp) next[i] = fp;
        });
        fingerprintsRef.current = next;
      } catch {
        // Defensive — never let a fingerprint compute failure break the
        // sidebar. Comments still work index-only.
        fingerprintsRef.current = {};
      }
    })();
    return () => {
      cancel = true;
    };
  }, [memoryRoot, atomPath, open]);
  // === end v1.13.2 round-2 ===

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await commentsList(atomPath);
      setThreads(list);
    } finally {
      setLoading(false);
    }
  }, [atomPath]);

  useEffect(() => {
    if (!open) return;
    void refresh();
  }, [open, refresh]);

  // Scroll to the active paragraph's thread when activeParagraph changes.
  useEffect(() => {
    if (!open || activeParagraph == null || !listRef.current) return;
    const target = listRef.current.querySelector(
      `[data-paragraph="${activeParagraph}"]`,
    );
    if (target instanceof HTMLElement) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [activeParagraph, open, threads]);

  const filtered = useMemo(
    () => threads.filter((th) => showResolved || !th.resolved),
    [threads, showResolved],
  );

  async function newThread(body: string) {
    const idx = activeParagraph ?? 0;
    const anchor: ParagraphAnchor = {
      paragraph_index: idx,
      char_offset_start: 0,
      char_offset_end: 0,
      // === v1.13.2 round-2 === — attach fingerprint when we have one for
      // this paragraph index so future drift can fall back to fuzzy match.
      fingerprint: fingerprintsRef.current[idx] ?? null,
      // === end v1.13.2 round-2 ===
    };
    await commentsCreate(atomPath, anchor, body, currentUser);
    await refresh();
    onChanged?.();
  }

  async function reply(threadId: string, body: string) {
    const th = threads.find((t) => t.thread_id === threadId);
    const anchor = th
      ? th.anchor
      : { paragraph_index: 0, char_offset_start: 0, char_offset_end: 0 };
    await commentsCreate(atomPath, anchor, body, currentUser, threadId);
    await refresh();
    onChanged?.();
  }

  async function resolve(threadId: string) {
    await commentsResolve(atomPath, threadId, currentUser);
    await refresh();
    onChanged?.();
  }
  async function unresolve(threadId: string) {
    await commentsUnresolve(atomPath, threadId, currentUser);
    await refresh();
    onChanged?.();
  }
  async function archive(threadId: string) {
    await commentsArchive(atomPath, threadId, currentUser);
    await refresh();
    onChanged?.();
  }

  if (!open) return null;

  const openCount = threads.filter((th) => !th.resolved).length;
  const resolvedCount = threads.length - openCount;

  return (
    <aside
      data-testid="comment-sidebar"
      className={cn(
        "flex w-[360px] shrink-0 flex-col border-l border-stone-200 bg-stone-50 dark:border-stone-800 dark:bg-stone-950",
        "h-full overflow-hidden",
      )}
    >
      <header className="flex items-center justify-between border-b border-stone-200 px-3 py-2 dark:border-stone-800">
        <h2 className="flex items-center gap-1.5 text-[12px] font-medium text-stone-700 dark:text-stone-300">
          <MessageSquare size={12} />
          {t("comments.sidebarTitle", { count: openCount })}
        </h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          aria-label={t("comments.close")}
          data-testid="comment-sidebar-close"
        >
          <X size={12} />
        </Button>
      </header>

      <div className="border-b border-stone-200 px-3 py-3 dark:border-stone-800">
        <p className="mb-1 text-[10px] uppercase tracking-wide text-stone-400">
          {t("comments.newOnParagraph", {
            n: (activeParagraph ?? 0) + 1,
          })}
        </p>
        <CommentInput onSubmit={newThread} testId="comment-sidebar-new" />
      </div>

      {resolvedCount > 0 && (
        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          className="flex items-center gap-1 border-b border-stone-200 px-3 py-1.5 text-left text-[10px] text-stone-500 hover:bg-stone-100 dark:border-stone-800 dark:text-stone-400 dark:hover:bg-stone-900"
          data-testid="comment-sidebar-toggle-resolved"
        >
          {showResolved ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
          {t("comments.resolvedToggle", { count: resolvedCount })}
        </button>
      )}

      <div ref={listRef} className="flex-1 space-y-2 overflow-auto p-3">
        {loading ? (
          <p
            className="text-[12px] text-stone-400"
            data-testid="comment-sidebar-loading"
          >
            {t("comments.loading")}
          </p>
        ) : filtered.length === 0 ? (
          <p
            className="text-[12px] text-stone-400"
            data-testid="comment-sidebar-empty"
          >
            {t("comments.empty")}
          </p>
        ) : (
          filtered.map((th) => (
            <div
              key={th.thread_id}
              data-paragraph={th.anchor.paragraph_index}
            >
              <CommentThreadView
                thread={th}
                currentUser={currentUser}
                onReply={(body) => reply(th.thread_id, body)}
                onResolve={() => resolve(th.thread_id)}
                onUnresolve={() => unresolve(th.thread_id)}
                onArchive={() => archive(th.thread_id)}
                active={activeParagraph === th.anchor.paragraph_index}
              />
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
// === end wave 1.13-B ===
