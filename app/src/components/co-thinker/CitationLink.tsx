import { Link } from "react-router-dom";
import { citationToRoute } from "@/lib/co-thinker";

interface Props {
  /** The matched path, e.g. `/memory/decisions/foo.md`. */
  path: string;
  /** Optional line number from `Lnn` suffix. */
  line?: number | null;
}

/**
 * Phase 3-C — clickable citation link.
 *
 * The brain doc encodes references to memory atoms as
 *   `/memory/decisions/foo.md L23`
 * which Phase 3-C surfaces as a real router <Link>. The line-number suffix
 * is rendered as a small font-mono badge so it's visually distinct from
 * the path; future Phase 4 work can wire it through to a scroll-to-line
 * inside the markdown view.
 *
 * The path is rendered in monospace so it's recognizable as code-ish; the
 * orange underline matches the rest of the app's link styling.
 */
export function CitationLink({ path, line }: Props) {
  const to = citationToRoute(path);
  const display = line != null ? `${path} L${line}` : path;
  return (
    <Link
      to={to}
      data-testid="citation-link"
      data-citation-path={path}
      data-citation-line={line ?? undefined}
      className="font-mono text-[12px] text-[var(--ti-orange-700)] underline-offset-2 hover:underline dark:text-[var(--ti-orange-500)]"
      title={line != null ? `Open ${path} (line ${line})` : `Open ${path}`}
    >
      {display}
    </Link>
  );
}
