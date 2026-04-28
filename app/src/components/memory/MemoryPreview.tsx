// === wave 21 ===
/**
 * Wave 21 — Right-pane atom preview for the Obsidian-style /memory view.
 *
 * Renders:
 *   - Frontmatter as a compact chip strip (date, author, vendor, kind)
 *   - Body via react-markdown
 *   - Backlinks section (auto-computed via `compute_backlinks`)
 *   - "Open in editor" affordance
 *
 * Soft-fails when the file is missing — shows the "select an atom" empty
 * state so the user is never left with a blank pane.
 */

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, FileText, User, Tag, Calendar, MessageSquare } from "lucide-react";
import { Link } from "react-router-dom";
import ReactMarkdown from "react-markdown";

import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  parseFrontmatter,
  readMemoryFile,
  stripFrontmatter,
} from "@/lib/memory";
import {
  commentsList,
  computeBacklinks,
  openInEditor,
  type BacklinkHit,
  type CommentThread,
} from "@/lib/tauri";
import { vendorColor } from "@/lib/vendor-colors";

// === wave 1.13-B ===
import { CommentSidebar } from "@/components/comments/CommentSidebar";
import { ProposeForReviewButton } from "@/components/review/ProposeForReviewButton";
// === end wave 1.13-B ===

interface Props {
  /** Selected file path (rel to memory root). null → empty state. */
  relPath: string | null;
}

export function MemoryPreview({ relPath }: Props) {
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const currentUser = useStore((s) => s.ui.currentUser);
  const [content, setContent] = useState<string | null>(null);
  const [backlinks, setBacklinks] = useState<BacklinkHit[]>([]);
  const [loading, setLoading] = useState(false);
  // === wave 1.13-B ===
  const [commentThreads, setCommentThreads] = useState<CommentThread[]>([]);
  const [commentSidebarOpen, setCommentSidebarOpen] = useState(false);
  const [activeParagraph, setActiveParagraph] = useState<number | undefined>(undefined);
  // === end wave 1.13-B ===

  useEffect(() => {
    let cancel = false;
    if (!relPath) {
      setContent(null);
      setBacklinks([]);
      setCommentThreads([]);
      return;
    }
    setLoading(true);
    void (async () => {
      const [body, bl, threads] = await Promise.all([
        readMemoryFile(memoryRoot, relPath),
        computeBacklinks({ atomPath: relPath }),
        commentsList(relPath).catch(() => []),
      ]);
      if (cancel) return;
      setContent(body);
      setBacklinks(bl.hits);
      setCommentThreads(threads);
      setLoading(false);
    })();
    return () => {
      cancel = true;
    };
  }, [memoryRoot, relPath]);

  // === wave 1.13-B ===
  // Set of paragraph indices that have at least one un-resolved comment
  // thread anchored to them. Used to add a yellow underline.
  const annotatedParagraphs = useMemo(() => {
    const set = new Set<number>();
    for (const th of commentThreads) {
      if (!th.resolved) set.add(th.anchor.paragraph_index);
    }
    return set;
  }, [commentThreads]);
  async function refreshThreads() {
    if (!relPath) return;
    try {
      setCommentThreads(await commentsList(relPath));
    } catch {
      // best-effort
    }
  }
  // === end wave 1.13-B ===

  const fm = useMemo(() => (content ? parseFrontmatter(content) : null), [content]);
  const body = useMemo(() => (content ? stripFrontmatter(content) : ""), [content]);

  if (!relPath) {
    return (
      <div
        data-testid="memory-preview-empty"
        className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center"
      >
        <FileText size={28} className="text-stone-300 dark:text-stone-700" />
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Pick an atom from the tree.
        </p>
      </div>
    );
  }

  if (loading || content === null) {
    return (
      <div data-testid="memory-preview-loading" className="px-8 py-8">
        <div className="h-5 w-1/3 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
        <div className="mt-3 h-4 w-2/3 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
        <div className="mt-2 h-4 w-1/2 animate-pulse rounded bg-stone-200 dark:bg-stone-800" />
      </div>
    );
  }

  const fields = fm?.fields ?? {};
  const title = fields.title || basename(relPath);
  const author = fields.author;
  const vendor = fields.vendor;
  const date = fields.date || fields.created;
  const kind = fields.kind || inferKindFromPath(relPath);
  const vc = vendor ? vendorColor(vendor) : null;
  const dotHex = vc && vc.hex.startsWith("linear-gradient") ? "#A855F7" : vc?.hex;

  // === wave 1.13-B ===
  const openThreadCount = commentThreads.filter((t) => !t.resolved).length;
  // === end wave 1.13-B ===

  return (
    <div data-testid="memory-preview" className="flex h-full flex-row overflow-hidden">
    <div className="flex h-full flex-1 flex-col overflow-auto">
      <div className="border-b border-stone-200 px-8 py-5 dark:border-stone-800">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="ti-section-label truncate font-mono text-[10px]">
              {relPath}
            </p>
            <h1 className="mt-1 font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              {title}
            </h1>
          </div>
          <div className="flex items-center gap-2">
            {/* === wave 1.13-B === */}
            <ProposeForReviewButton atomPath={relPath} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCommentSidebarOpen((v) => !v)}
              data-testid="memory-preview-toggle-comments"
            >
              <MessageSquare size={12} className="mr-1" />
              {openThreadCount > 0
                ? `Comments (${openThreadCount})`
                : "Comments"}
            </Button>
            {/* === end wave 1.13-B === */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void openInEditor(`${memoryRoot}/${relPath}`)}
              data-testid="memory-preview-open-editor"
            >
              <ExternalLink size={12} /> Open in editor
            </Button>
          </div>
        </div>

        <div
          data-testid="memory-preview-frontmatter-chips"
          className="mt-3 flex flex-wrap items-center gap-1.5"
        >
          {date && <Chip icon={<Calendar size={10} />} label={date} testId="chip-date" />}
          {author && <Chip icon={<User size={10} />} label={author} testId="chip-author" />}
          {vendor && (
            <Chip
              icon={
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{ background: dotHex ?? "#78716C" }}
                />
              }
              label={vc?.label ?? vendor}
              testId="chip-vendor"
            />
          )}
          {kind && <Chip icon={<Tag size={10} />} label={kind} testId="chip-kind" />}
        </div>
      </div>

      <div className="flex-1 px-8 py-6">
        {/* === wave 1.13-B === */}
        {/* Custom paragraph render so we can underline annotated paragraphs +
            wire click → open the comment sidebar scrolled to that paragraph. */}
        <article
          className="prose-tangerine max-w-none"
          data-testid="memory-preview-body"
        >
          <ReactMarkdown
            components={{
              p: ({ node, children }) => {
                const idx = (node as unknown as { position?: { start?: { line?: number } } })?.position?.start?.line ?? 0;
                const annotated = annotatedParagraphs.has(idx);
                const paragraphIndex = idx;
                return (
                  <p
                    data-paragraph-index={paragraphIndex}
                    data-annotated={annotated || undefined}
                    onClick={(e) => {
                      // Only react when the user clicks on whitespace/text,
                      // not on a nested link.
                      if (e.target instanceof HTMLAnchorElement) return;
                      setActiveParagraph(paragraphIndex);
                      setCommentSidebarOpen(true);
                    }}
                    className={
                      annotated
                        ? "underline decoration-amber-300 decoration-2 underline-offset-4 cursor-pointer"
                        : "cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-900"
                    }
                  >
                    {children}
                  </p>
                );
              },
            }}
          >
            {body || "_(empty)_"}
          </ReactMarkdown>
        </article>
        {/* === end wave 1.13-B === */}

        <BacklinksSection backlinks={backlinks} />
      </div>
    </div>
    {/* === wave 1.13-B === */}
    <CommentSidebar
      atomPath={relPath}
      currentUser={currentUser}
      open={commentSidebarOpen}
      onClose={() => setCommentSidebarOpen(false)}
      activeParagraph={activeParagraph}
      onChanged={() => void refreshThreads()}
    />
    {/* === end wave 1.13-B === */}
    </div>
  );
}

function Chip({
  icon,
  label,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className="inline-flex items-center gap-1 rounded-full border border-stone-200 bg-stone-50 px-2 py-0.5 font-mono text-[10px] text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300"
    >
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

function BacklinksSection({ backlinks }: { backlinks: BacklinkHit[] }) {
  if (backlinks.length === 0) {
    return (
      <section
        data-testid="memory-preview-backlinks"
        className="mt-8 border-t border-stone-200 pt-4 dark:border-stone-800"
      >
        <h2 className="ti-section-label">Backlinks (0)</h2>
        <p className="mt-2 font-mono text-[11px] text-stone-400 dark:text-stone-500">
          no atoms cite this yet
        </p>
      </section>
    );
  }
  return (
    <section
      data-testid="memory-preview-backlinks"
      className="mt-8 border-t border-stone-200 pt-4 dark:border-stone-800"
    >
      <h2 className="ti-section-label">Backlinks ({backlinks.length})</h2>
      <ul className="mt-2 space-y-2">
        {backlinks.map((b) => (
          <li
            key={b.path}
            data-testid={`memory-preview-backlink-${b.path}`}
            className="rounded border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] dark:border-stone-800 dark:bg-stone-900"
          >
            <Link
              to={`/memory/${b.path}`}
              className="font-medium text-[var(--ti-orange-700)] hover:underline dark:text-[var(--ti-orange-500)]"
            >
              {b.title}
            </Link>
            <p className="mt-0.5 font-mono text-[10px] text-stone-500 dark:text-stone-400">
              {b.path}
            </p>
            <p className="mt-1 text-stone-600 dark:text-stone-300">{b.snippet}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function basename(p: string): string {
  return p.split("/").pop()?.replace(/\.(md|markdown|mdx)$/i, "") ?? p;
}

function inferKindFromPath(p: string): string | null {
  const parts = p.split("/").filter(Boolean);
  // team/<kind>/file.md or personal/<user>/<kind>/file.md
  if (parts[0] === "team" && parts.length >= 2) return parts[1];
  if (parts[0] === "personal" && parts.length >= 3) return parts[2];
  if (parts.length >= 1) return parts[0];
  return null;
}
// === end wave 21 ===
