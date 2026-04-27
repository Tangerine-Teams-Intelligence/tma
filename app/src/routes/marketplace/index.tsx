// === wave 4-D i18n ===
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Search, AlertCircle, Sparkles } from "lucide-react";
import {
  marketplaceGetLaunchState,
  marketplaceListTemplates,
  type LaunchState,
  type Template,
} from "@/lib/tauri";
import { TemplateCard } from "@/components/marketplace/TemplateCard";
import { SkeletonCard } from "@/components/ui/Skeleton";

const VERTICALS = [
  "all",
  "legal",
  "sales",
  "design",
  "product",
  "ops",
  "engineering",
  "finance",
  "healthcare",
  "education",
] as const;

/**
 * /marketplace — v3.5 §1.7 marketplace landing page.
 *
 * Lists vertical templates browsable by industry / vertical / language.
 * The "Coming live when CEO triggers launch gate" banner shows when
 * `marketplace_get_launch_state.launched === false` (per spec §2 — gate
 * is 5,000 OSS installs + 1 self-shipped vertical template).
 *
 * Stub mode default: the React stub mirrors the Rust stub catalog so the
 * page renders identically with or without a Tauri shell. Real catalog
 * lights up once the launch gate is met.
 */
export default function MarketplaceRoute() {
  const { t } = useTranslation();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [launch, setLaunch] = useState<LaunchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [query, setQuery] = useState("");
  const [vertical, setVertical] = useState<(typeof VERTICALS)[number]>("all");

  useEffect(() => {
    let cancel = false;
    setLoading(true);
    setError(null);
    Promise.all([marketplaceListTemplates(), marketplaceGetLaunchState()])
      .then(([rows, state]) => {
        if (cancel) return;
        setTemplates(rows);
        setLaunch(state);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (cancel) return;
        setError(typeof e === "string" ? e : (e as Error)?.message ?? "Could not load marketplace templates.");
        setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const q = query.toLowerCase();
    return templates.filter((t) => {
      if (vertical !== "all" && t.vertical !== vertical) return false;
      if (q.length === 0) return true;
      const hay = (t.name + " " + t.description + " " + t.author).toLowerCase();
      return hay.includes(q);
    });
  }, [templates, query, vertical]);

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <header className="mb-6 space-y-2">
        <h1 className="text-[22px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {t("marketplace.title")}
        </h1>
        <p className="text-[13px] text-stone-600 dark:text-stone-400">
          {t("marketplace.subtitle")}
        </p>
      </header>

      {launch && !launch.launched && (
        <LaunchGateBanner state={launch} />
      )}

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-stone-400"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("marketplace.search")}
            className="w-full rounded-md border border-stone-200 bg-white py-1.5 pl-8 pr-3 text-[13px] text-stone-900 placeholder-stone-400 outline-none focus:border-[var(--ti-orange-500)] dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100"
            data-testid="marketplace-search"
          />
        </div>
        <select
          value={vertical}
          onChange={(e) => setVertical(e.target.value as (typeof VERTICALS)[number])}
          className="rounded-md border border-stone-200 bg-white py-1.5 px-2 text-[13px] capitalize dark:border-stone-800 dark:bg-stone-950 dark:text-stone-100"
          data-testid="marketplace-vertical-filter"
        >
          {VERTICALS.map((v) => (
            <option key={v} value={v}>
              {v === "all" ? t("marketplace.allVerticals") : v}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <ul
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"
          aria-busy="true"
          data-testid="marketplace-loading"
        >
          {Array.from({ length: 6 }).map((_, i) => (
            <li key={i}>
              <SkeletonCard />
            </li>
          ))}
        </ul>
      ) : error ? (
        <div
          role="alert"
          className="rounded-md border border-[var(--ti-danger)]/40 bg-[var(--ti-danger)]/5 p-6 text-center"
        >
          <AlertCircle size={20} className="mx-auto text-[var(--ti-danger)]" />
          <p className="mt-3 text-[12px] text-stone-700 dark:text-stone-300">
            {t("marketplace.errorLoad")}
          </p>
          <p className="mt-1 font-mono text-[10px] text-stone-500 dark:text-stone-400">
            {error}
          </p>
          <button
            type="button"
            onClick={() => setRefreshKey((k) => k + 1)}
            className="mt-3 rounded border border-stone-300 px-2 py-0.5 font-mono text-[11px] text-stone-700 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
          >
            {t("buttons.retry")}
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-dashed border-stone-300 p-8 text-center dark:border-stone-700">
          <Sparkles size={20} className="mx-auto text-stone-400" />
          <p className="mt-3 text-[13px] text-stone-700 dark:text-stone-300">
            {t("marketplace.emptyFiltered")}
          </p>
          <p className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">
            {t("marketplace.emptyFilteredHint")}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t) => (
            <li key={t.id}>
              <TemplateCard template={t} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LaunchGateBanner({ state }: { state: LaunchState }) {
  const { t } = useTranslation();
  const installPct = Math.min(
    100,
    Math.round(
      (state.gate_status.installs_30d / Math.max(1, state.gate_status.installs_required)) * 100,
    ),
  );
  return (
    <div
      className="mb-5 rounded-md border border-amber-300 bg-amber-50 p-4 dark:border-amber-900 dark:bg-amber-950/30"
      role="alert"
      data-testid="marketplace-launch-banner"
    >
      <p className="text-[13px] font-medium text-amber-900 dark:text-amber-200">
        {t("marketplace.launchTitle")}
      </p>
      <p className="mt-1 text-[12px] text-amber-800 dark:text-amber-300/80">
        {t("marketplace.launchBody")}
      </p>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <GateProgress
          label={t("marketplace.ossInstalls")}
          value={`${state.gate_status.installs_30d.toLocaleString()} / ${state.gate_status.installs_required.toLocaleString()}`}
          pct={installPct}
        />
        <GateProgress
          label={t("marketplace.selfShipped")}
          value={
            state.gate_status.self_shipped_template_validated
              ? t("marketplace.validated")
              : t("marketplace.pending")
          }
          pct={state.gate_status.self_shipped_template_validated ? 100 : 50}
        />
      </div>
    </div>
  );
}

function GateProgress({
  label,
  value,
  pct,
}: {
  label: string;
  value: string;
  pct: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-amber-900 dark:text-amber-200">
        <span>{label}</span>
        <span className="font-mono">{value}</span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-amber-200/60 dark:bg-amber-900/40">
        <div
          className="h-full bg-amber-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
