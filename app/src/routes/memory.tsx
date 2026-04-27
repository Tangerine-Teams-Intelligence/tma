// === wave 4-D i18n ===
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  Copy,
  ExternalLink,
  ChevronRight,
  Activity,
  Calendar,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";
import {
  countMemoryByFolder,
  emptyCoverage,
  findSampleMeetingPath,
  readMemoryFile,
  readMemoryTree,
  type CoverageStats,
  type MemoryNode,
} from "@/lib/memory";
import { MarkdownView } from "@/components/MarkdownView";
import { SOURCES } from "@/lib/sources";
import { openExternal } from "@/lib/tauri";
import { MEMORY_REFRESHED_EVENT } from "@/components/layout/AppShell";
// v1.9.0-beta.1 P1-A — log every atom open so the suggestion engine can
// detect "user opens decisions/foo.md every morning" → maybe surface a
// daily brief banner. There's no editable save handler in this read-only
// view today; `edit_atom` lands when /memory ships an inline editor.
import { logEvent } from "@/lib/telemetry";

/**
 * Default landing surface after auth: 3-pane shape.
 *
 *   Left   sidebar (file tree, lives in <Sidebar/>)
 *   Center coverage stats when nothing is selected, or markdown render when
 *          a file is in the URL (/memory/<path>)
 *   Right  rail with "Copy to AI prompt" + "Open in editor" + v1.6 CoS
 *          placeholder cards
 *
 * The route handles both /memory and /memory/<*> via a single component
 * (path comes from useParams("*")).
 *
 * v1.5.6 changes:
 *   - Walk the tree on mount + on focus to keep the stat-card counts live.
 *   - Auto-select the bundled sample meeting on first paint when no file
 *     is in the URL — gives the user the "30-second oh shit" moment.
 *   - Add v1.6 placeholder cards (same-screen rate, daily brief,
 *     pre-meeting brief) so the Chief-of-Staff direction is visible.
 *   - Drop the duplicate Sources active / Sources coming bottom strip
 *     (sidebar already shows that).
 */
export default function MemoryRoute() {
  const { t } = useTranslation();
  const params = useParams();
  const navigate = useNavigate();
  const relPath = params["*"] ?? "";
  const memoryRoot = useStore((s) => s.ui.memoryRoot);
  const samplesSeeded = useStore((s) => s.ui.samplesSeeded);
  const memoryConfigMode = useStore((s) => s.ui.memoryConfig.mode);
  const pushToast = useStore((s) => s.ui.pushToast);

  const [content, setContent] = useState<string | null>(null);
  const [tree, setTree] = useState<MemoryNode[]>([]);
  const [autoSelected, setAutoSelected] = useState(false);

  // v1.6.0: gate the onboarding modal. First time the user lands here we
  // route them through "where will your team's memory live?" instead of
  // showing an empty memory tree.
  useEffect(() => {
    if (memoryConfigMode === undefined) {
      navigate("/onboarding-team", { replace: true });
    }
  }, [memoryConfigMode, navigate]);

  const folderCounts = useMemo(() => countMemoryByFolder(tree), [tree]);
  const coverage: CoverageStats = useMemo(() => {
    const stats = emptyCoverage();
    // === wave 7 ===
    // v1.9.3 honesty pass: SourceStatus changed from "active" to
    // "shipped" / "beta" / "coming". Memory cover counts both shipped
    // and beta as "available now" (their setup pages are live), and
    // coming as future. The previous "active" filter excluded beta
    // surfaces — now they roll up so the user sees an honest catalog count.
    stats.activeSources = SOURCES.filter(
      (s) => s.status === "shipped" || s.status === "beta",
    ).map((s) => s.title);
    stats.comingSources = SOURCES.filter((s) => s.status === "coming").map((s) => s.title);
    // === end wave 7 ===
    stats.meetings = folderCounts.meetings;
    stats.decisions = folderCounts.decisions;
    stats.people = folderCounts.people;
    stats.projects = folderCounts.projects;
    stats.threads = folderCounts.threads;
    return stats;
  }, [folderCounts]);

  // First-launch sample seed lives in <AppShell> now (v1.7.0-beta.2). Moved
  // there because v1.7 changed the default landing route from /memory to
  // /today, so a /memory-only seed effect would never fire for a fresh user
  // who never navigates to /memory. AppShell also uses a smarter
  // user-facing-folders-empty check that ignores daemon sidecars.

  // Walk the memory tree on mount + on focus so the stat cards stay accurate
  // as the Discord bot writes new files. Mirror the sidebar's focus-refresh
  // pattern so the home + sidebar stay in sync. Also re-walk on
  // MEMORY_REFRESHED_EVENT so the fresh-install seed shows up here without
  // a route nav.
  useEffect(() => {
    let cancel = false;
    const refresh = () =>
      readMemoryTree(memoryRoot).then((t) => {
        if (!cancel) setTree(t);
      });
    void refresh();
    const onFocus = () => void refresh();
    const onRefreshed = () => void refresh();
    if (typeof window !== "undefined") {
      window.addEventListener("focus", onFocus);
      window.addEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
    }
    return () => {
      cancel = true;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener(MEMORY_REFRESHED_EVENT, onRefreshed);
      }
    };
  }, [memoryRoot, samplesSeeded]);

  // Auto-select the sample meeting on first landing — gives users an
  // instantly populated app without having to discover the tree. Only fires
  // when (a) no file in the URL, (b) samples have been seeded, (c) we
  // haven't already auto-selected this session.
  useEffect(() => {
    if (autoSelected) return;
    if (relPath) return;
    if (!samplesSeeded) return;
    if (tree.length === 0) return;
    const sample = findSampleMeetingPath(tree);
    if (!sample) return;
    setAutoSelected(true);
    navigate(`/memory/${sample}`, { replace: true });
  }, [autoSelected, navigate, relPath, samplesSeeded, tree]);

  useEffect(() => {
    let cancel = false;
    if (!relPath) {
      setContent(null);
      return;
    }
    // v1.9.0-beta.1 P1-A — fire open_atom on every relPath change. We
    // stamp before the read returns so the engine sees the open even if
    // the file is missing or unreadable (the user still tried).
    void logEvent("open_atom", { atom_path: relPath });
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
      pushToast("success", t("memory.copiedToast"));
    } catch {
      pushToast("error", t("memory.copyDeniedToast"));
    }
  }

  function openInEditor() {
    // v1.5: best-effort — opens the memory file via Tauri's open_external
    // shell command, which on most OS falls through to the user's default
    // editor for .md. v1.6 will let users pick an editor command in Settings.
    void openExternal(`file://${memoryRoot}/${relPath}`);
  }

  return (
    <div className="flex h-full bg-stone-50 dark:bg-stone-950">
      {/* Center pane. tabIndex={-1} prevents the scroll container from
          stealing focus on click, which on Windows would pop the IME
          candidate bar for Chinese keyboard users. */}
      <section className="flex-1 overflow-auto outline-none" tabIndex={-1}>
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
      <aside className="hidden w-[260px] shrink-0 border-l border-stone-200 bg-stone-50 px-4 py-6 dark:border-stone-800 dark:bg-stone-950 lg:block">
        <p className="ti-section-label">{t("memory.useThisMemory")}</p>
        <div className="mt-3 space-y-2">
          <Button
            variant="default"
            size="sm"
            onClick={copyAsPrompt}
            className="w-full justify-start"
          >
            <Copy size={14} /> {t("memory.copyToPrompt")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={openInEditor}
            className="w-full justify-start"
          >
            <ExternalLink size={14} /> {t("memory.openInEditor")}
          </Button>
        </div>

        <div className="mt-6 rounded-md border border-dashed border-stone-300 bg-stone-100/40 p-3 dark:border-stone-700 dark:bg-stone-900/40">
          <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-stone-500 dark:text-stone-400">
            {t("memory.preMeetingBrief")}
            <span className="rounded border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)] px-1.5 py-px font-mono text-[9px] tracking-normal text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
              v1.6
            </span>
          </p>
          <p className="mt-2 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
            {t("memory.preMeetingBriefBody")}
          </p>
        </div>

        <div className="mt-8">
          <p className="ti-section-label">{t("memory.memoryDir")}</p>
          <p className="mt-2 break-all font-mono text-[11px] text-stone-500 dark:text-stone-400">
            {memoryRoot}
          </p>
        </div>

        <div className="mt-8">
          <p className="ti-section-label">{t("memory.howItWorks")}</p>
          <p className="mt-2 text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
            <strong className="text-stone-700 dark:text-stone-300">
              {t("memory.howItWorksTitle")}
            </strong>{" "}
            — {t("memory.howItWorksBody")}
          </p>
        </div>
      </aside>
    </div>
  );
}

function Breadcrumb({ relPath, memoryRoot }: { relPath: string; memoryRoot: string }) {
  const parts = relPath ? relPath.split("/").filter(Boolean) : [];
  return (
    <div className="ti-no-select flex h-9 items-center gap-1 border-b border-stone-200 bg-stone-50 px-6 font-mono text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-400">
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
  const { t } = useTranslation();
  const navigate = useNavigate();
  const noSourcesActive = coverage.activeSources.length === 0;

  return (
    <div>
      <h1 className="font-display text-3xl tracking-tight text-stone-900 dark:text-stone-100">
        {t("memory.title")}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-stone-700 dark:text-stone-300">
        {t("memory.subtitle")}
      </p>

      <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
        <ComingCard
          icon={<Activity size={14} />}
          label={t("memory.sameScreenRate")}
          value="0%"
          hint={t("memory.comingV16Sameset")}
          onClick={() => navigate("/alignment")}
        />
        <ComingCard
          icon={<Calendar size={14} />}
          label={t("memory.dailyBrief")}
          value="—"
          hint={t("memory.comingV16Brief")}
          onClick={() => navigate("/inbox")}
        />
        <ComingCard
          icon={<Sparkles size={14} />}
          label={t("memory.autoCoS")}
          value="—"
          hint={t("memory.comingV16AutoCoS")}
          onClick={() => navigate("/alignment")}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat n={coverage.meetings} label={t("memory.labelMeetings")} />
        <Stat n={coverage.decisions} label={t("memory.labelDecisions")} />
        <Stat n={coverage.people} label={t("memory.labelPeople")} />
        <Stat n={coverage.projects} label={t("memory.labelProjects")} />
        <Stat n={coverage.threads} label={t("memory.labelThreads")} />
      </div>
      {noSourcesActive ? (
        <p className="mt-3 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {t("memory.noSourceCta")}
        </p>
      ) : (
        <p className="mt-3 font-mono text-[11px] text-stone-500 dark:text-stone-400">
          {t("memory.withSourceCta", {
            meetings: coverage.meetings,
            decisions: coverage.decisions,
            people: coverage.people,
          })}
        </p>
      )}
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

/**
 * Stat card for v1.6 features that don't exist yet. Same shape as <Stat/>
 * but with a "Coming v1.6" pill badge and a click handler that navigates
 * to a placeholder route.
 */
function ComingCard({
  icon,
  label,
  value,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-md border border-stone-300 bg-stone-50 p-3 text-left transition-colors duration-fast hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-stone-500 dark:text-stone-400">
          {icon}
          {label}
        </span>
        <span className="rounded border border-[var(--ti-orange-500)]/40 bg-[var(--ti-orange-50)] px-1.5 py-px font-mono text-[9px] uppercase tracking-wide text-[var(--ti-orange-700)] dark:bg-stone-800 dark:text-[var(--ti-orange-500)]">
          v1.6
        </span>
      </div>
      <p className="mt-2 font-display text-2xl tracking-tight text-stone-900 dark:text-stone-100">
        {value}
      </p>
      <p className="mt-1 text-[10px] leading-tight text-stone-500 dark:text-stone-400">
        {hint}
      </p>
    </button>
  );
}
