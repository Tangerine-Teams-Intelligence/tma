import { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { Copy, ExternalLink, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  emptyCoverage,
  readMemoryFile,
  readMemoryTree,
  type CoverageStats,
} from "@/lib/memory";
import { MarkdownView } from "@/components/MarkdownView";
import { SOURCES } from "@/lib/sources";
import { openExternal, initMemoryWithSamples, resolveMemoryRoot } from "@/lib/tauri";

/**
 * Default landing surface after auth: 3-pane shape.
 *
 *   Left   sidebar (file tree, lives in <Sidebar/>)
 *   Center coverage stats when nothing is selected, or markdown render when
 *          a file is in the URL (/memory/<path>)
 *   Right  rail with "Copy to AI prompt" + "Open in editor"
 *
 * The route handles both /memory and /memory/<*> via a single component
 * (path comes from useParams("*")).
 */
export default function MemoryRoute() {
  const params = useParams();
  const relPath = params["*"] ?? "";
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const setMemoryRoot = useStore((s) => s.ui.setMemoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const setSamplesSeeded = useStore((s) => s.ui.setSamplesSeeded);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [content, setContent] = useState<string | null>(null);
  const [coverage] = useState<CoverageStats>(() => {
    const stats = emptyCoverage();
    stats.activeSources = SOURCES.filter((s) => s.status === "active").map((s) => s.title);
    stats.comingSources = SOURCES.filter((s) => s.status === "coming").map((s) => s.title);
    return stats;
  });

  // First-launch seed: if the memory dir is empty AND samples haven't been
  // seeded yet, copy bundled samples in so the user sees a populated tree
  // immediately. Idempotent — Rust no-ops if dir is non-empty.
  useEffect(() => {
    if (samplesSeeded) return;
    let cancel = false;
    void (async () => {
      // Resolve real path from Rust if we still have the placeholder.
      const info = await resolveMemoryRoot();
      if (cancel) return;
      if (info.path && info.path !== memoryRoot && !info.path.startsWith("~")) {
        setMemoryRoot(info.path);
      }
      if (!info.is_empty) {
        // Dir already has user content — skip sample seeding entirely.
        setSamplesSeeded(true);
        return;
      }
      const tree = await readMemoryTree(info.path || memoryRoot);
      if (cancel) return;
      const hasFiles = tree.some((n) => n.kind === "file" || (n.children && n.children.length > 0));
      if (!hasFiles) {
        const r = await initMemoryWithSamples();
        if (cancel) return;
        if (r.path && !r.path.startsWith("~")) {
          setMemoryRoot(r.path);
        }
      }
      setSamplesSeeded(true);
    })();
    return () => {
      cancel = true;
    };
  }, [memoryRoot, samplesSeeded, setMemoryRoot, setSamplesSeeded]);

  useEffect(() => {
    let cancel = false;
    if (!relPath) {
      setContent(null);
      return;
    }
    void readMemoryFile(memoryRoot, relPath).then((c) => {
      if (!cancel) setContent(c);
    });
    return () => {
      cancel = true;
    };
  }, [memoryRoot, relPath]);

  async function copyAsPrompt() {
    const md =
      content ??
      `# ${relPath || "Tangerine memory"}

(this file is empty in v1.5 — Sources will write here once wired)`;
    const wrapped = `# Team memory for ${relPath || "Tangerine"}\n\n${md}\n\n---\n_Pasted from Tangerine memory._`;
    try {
      await navigator.clipboard.writeText(wrapped);
      pushToast("success", "Copied to clipboard. Paste into ChatGPT / Claude.");
    } catch {
      pushToast("error", "Clipboard access denied.");
    }
  }

  function openInEditor() {
    // v1.5: best-effort — opens the memory file via Tauri's open_external
    // shell command, which on most OS falls through to the user's default
    // editor for .md. v1.6 will let users pick an editor command in Settings.
    void openExternal(`file://${memoryRoot}/${relPath}`);
  }

  return (
    <div className="flex h-full">
      {/* Center pane */}
      <section className="flex-1 overflow-auto">
        <Breadcrumb relPath={relPath} memoryRoot={memoryRoot} />

        <div className="mx-auto max-w-3xl px-8 py-8">
          {!relPath ? (
            <CoverageView coverage={coverage} />
          ) : (
            <MarkdownView content={content} relPath={relPath} />
          )}
        </div>
      </section>

      {/* Right rail */}
      <aside className="hidden w-[260px] shrink-0 border-l border-stone-200 px-4 py-6 dark:border-stone-800 lg:block">
        <p className="ti-section-label">Use this memory</p>
        <div className="mt-3 space-y-2">
          <Button
            variant="default"
            size="sm"
            onClick={copyAsPrompt}
            className="w-full justify-start"
          >
            <Copy size={14} /> Copy to AI prompt
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={openInEditor}
            className="w-full justify-start"
          >
            <ExternalLink size={14} /> Open in editor
          </Button>
        </div>

        <div className="mt-8">
          <p className="ti-section-label">Memory dir</p>
          <p className="mt-2 break-all font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {memoryRoot}
          </p>
        </div>

        <div className="mt-8">
          <p className="ti-section-label">How this works</p>
          <p className="mt-2 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
            Tangerine never runs an LLM. We capture what your team does, structure it as
            markdown memory in your own dir, and ship that memory into the AI tools you
            already use — Claude Pro, ChatGPT, Cursor, Claude Code. The browser extension
            (v1.6) and MCP server (v1.6) are how memory leaves this app.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Breadcrumb({ relPath, memoryRoot }: { relPath: string; memoryRoot: string }) {
  const parts = relPath ? relPath.split("/").filter(Boolean) : [];
  return (
    <div className="ti-no-select flex h-9 items-center gap-1 border-b border-stone-200 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
      <Link to="/memory" className="hover:text-stone-900 dark:hover:text-stone-100">
        {memoryRoot}
      </Link>
      {parts.map((p, i) => {
        const path = parts.slice(0, i + 1).join("/");
        return (
          <span key={path} className="flex items-center gap-1">
            <ChevronRight size={11} />
            <Link
              to={`/memory/${path}`}
              className="hover:text-stone-900 dark:hover:text-stone-100"
            >
              {p}
            </Link>
          </span>
        );
      })}
    </div>
  );
}

function CoverageView({ coverage }: { coverage: CoverageStats }) {
  return (
    <div>
      <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
        Your team's memory
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
        Tangerine captures what your team does and structures it as memory your AI tools
        can read. Pick a file from the tree, or wire a Source below to start filling it.
      </p>

      {/* Coverage strip */}
      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat n={coverage.meetings} label="meetings" />
        <Stat n={coverage.decisions} label="decisions" />
        <Stat n={coverage.people} label="people" />
        <Stat n={coverage.projects} label="projects" />
        <Stat n={coverage.threads} label="threads" />
      </div>
      <p className="mt-3 font-mono text-[11px] text-stone-500 dark:text-stone-400">
        Your AI sees {coverage.meetings} meetings · {coverage.decisions} decisions ·{" "}
        {coverage.people} people · 0% of Slack / Linear / Notion (Sources land v1.6+).
      </p>

      {/* Sources active / coming */}
      <div className="mt-10">
        <p className="ti-section-label">Sources active</p>
        {coverage.activeSources.length === 0 ? (
          <p className="mt-2 text-sm italic text-stone-400 dark:text-stone-500">
            None wired yet. Set up Discord in the sidebar to start.
          </p>
        ) : (
          <ul className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
            {coverage.activeSources.map((s) => (
              <li
                key={s}
                className="rounded border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-emerald-700 dark:border-emerald-700/60 dark:bg-emerald-950/40 dark:text-emerald-400"
              >
                {s}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6">
        <p className="ti-section-label">Sources coming</p>
        <ul className="mt-2 flex flex-wrap gap-2 font-mono text-[11px]">
          {coverage.comingSources.map((s) => (
            <li
              key={s}
              className="rounded border border-stone-200 bg-stone-100 px-2 py-0.5 text-stone-500 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-400"
            >
              {s}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  return (
    <div className="rounded-md border border-stone-200 bg-stone-50 p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        {n}
      </p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
        {label}
      </p>
    </div>
  );
}
