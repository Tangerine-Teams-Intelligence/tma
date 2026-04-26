import ReactMarkdown from "react-markdown";
import { Link } from "react-router-dom";
import { X } from "lucide-react";
import { useStore } from "@/lib/store";
import { parseFrontmatter } from "@/lib/memory";

interface Props {
  /** Markdown body. May be null if file not found. */
  content: string | null;
  /** Path relative to memory root, used in the provenance footer. */
  relPath: string;
  /** Optional list of provenance lines (e.g. "From: 2026-04-25 roadmap meeting, line 47"). */
  provenance?: string[];
}

/**
 * Renders a memory file as styled markdown with a provenance footer.
 *
 * v1.5.5: parses frontmatter to detect `sample: true` files and shows a
 * dismissable banner pointing the user at the Discord setup. Strips the
 * frontmatter from the rendered body so users don't see raw YAML.
 */
export function MarkdownView({ content, relPath, provenance }: Props) {
  const sampleBannerDismissed = useStore((s) => s.ui.sampleBannerDismissed);
  const dismissSampleBanner = useStore((s) => s.ui.dismissSampleBanner);

  if (content == null) {
    return (
      <div className="font-mono text-xs text-stone-500 dark:text-stone-400">
        <p>
          File <span className="text-stone-700 dark:text-stone-200">{relPath}</span> is not in
          the v1.5 memory tree yet.
        </p>
        <p className="mt-2">
          Memory files start showing up here once a Source writes to your memory dir. The
          Discord source writes <span className="text-stone-700 dark:text-stone-200">memory/meetings/*.md</span>{" "}
          per call.
        </p>
      </div>
    );
  }

  const fm = parseFrontmatter(content);
  // If we successfully parsed frontmatter, render only the body. Otherwise
  // (no leading ---), render the full content untouched.
  const bodyToRender = fm.raw ? fm.body : content;
  const showSampleBanner = fm.isSample && !sampleBannerDismissed;

  return (
    // tabIndex=-1 + outline-none stops the article from grabbing focus on
    // click, which on Windows would otherwise pop the IME candidate bar
    // when a Chinese keyboard is the active input method.
    <article className="prose-tangerine outline-none" tabIndex={-1}>
      {showSampleBanner && (
        <div className="mb-6 flex items-start gap-3 rounded-md border border-[var(--ti-orange-200,#FFD9B8)] bg-[var(--ti-orange-50,#FFF5EC)] px-4 py-3 text-[12px] dark:border-stone-700 dark:bg-stone-900">
          <span className="font-mono text-[14px]" aria-hidden>
            📌
          </span>
          <p className="flex-1 text-stone-700 dark:text-stone-300">
            This is a sample.{" "}
            <Link
              to="/sources/discord"
              className="font-medium text-[var(--ti-orange-700)] underline-offset-2 hover:underline dark:text-[var(--ti-orange-500)]"
            >
              Set up Discord →
            </Link>{" "}
            to start capturing your real meetings — Tangerine will brief your
            team and their AI from them.
          </p>
          <button
            type="button"
            onClick={dismissSampleBanner}
            className="shrink-0 rounded p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800 dark:hover:text-stone-200"
            aria-label="Dismiss sample notice"
            title="Dismiss"
          >
            <X size={12} />
          </button>
        </div>
      )}

      <ReactMarkdown
        components={{
          h1: ({ children }) => (
            <h1 className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="mt-6 font-display text-xl tracking-tight text-stone-900 dark:text-stone-100">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mt-4 font-medium text-stone-900 dark:text-stone-100">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="mt-3 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {children}
            </p>
          ),
          ul: ({ children }) => (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm text-stone-700 dark:text-stone-300">
              {children}
            </ol>
          ),
          code: ({ children }) => (
            <code className="rounded bg-stone-100 px-1 py-0.5 font-mono text-[12px] text-stone-900 dark:bg-stone-800 dark:text-stone-100">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="mt-3 overflow-x-auto rounded-md border border-stone-200 bg-stone-50 p-3 font-mono text-[12px] text-stone-900 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-100">
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-[var(--ti-orange-500)] underline-offset-2 hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {bodyToRender}
      </ReactMarkdown>

      <footer className="mt-8 border-t border-stone-200 pt-4 dark:border-stone-800">
        <p className="ti-section-label">Provenance</p>
        {provenance && provenance.length > 0 ? (
          <ul className="mt-2 space-y-1 font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {provenance.map((p, i) => (
              <li key={i}>· {p}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 font-mono text-[11px] italic text-stone-400 dark:text-stone-500">
            Per-chunk source attribution lands in v1.6 — every paragraph will trace to the
            transcript line / PR comment / issue thread it came from.
          </p>
        )}
      </footer>
    </article>
  );
}
