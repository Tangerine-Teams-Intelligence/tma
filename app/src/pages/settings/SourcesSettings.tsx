/**
 * v1.20.2 — Sources directory: Obsidian-grade visual rewrite.
 *
 * Same content (the 11 connector rows from `lib/sources.ts`) but the visual
 * layer is now pure typography — no list border, no card chrome, no lucide
 * icons. Each row: vendor name + 1-line blurb + right-aligned mono status
 * meta. Hairline (1px stone-200) between rows. The full surface follows
 * the Settings restraint sweep.
 *
 * Status meta sits inline mono 11px stone-500 (`shipped` / `beta — coming
 * v1.10` / `coming v1.10`). The orange accent is reserved for connected
 * sources (lit when the user has actually configured the connector — but
 * that runtime check still lives in the per-source detail page; this list
 * only shows the static catalog status, same contract as before).
 */

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { SOURCES, type SourceStatus } from "@/lib/sources";

export function SourcesSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div data-testid="settings-sources">
      <h2 className="text-[14px] font-medium text-stone-900 dark:text-stone-100">
        {t("sidebar.sources", { defaultValue: "External sources" })}
      </h2>
      <p className="mt-1 font-mono text-[11px] text-stone-500 dark:text-stone-500">
        {SOURCES.length}{" "}
        {t("settings.sources.connectorsLabel", { defaultValue: "connectors" })}{" "}
        · click to configure
      </p>

      <ul
        className="mt-4 divide-y divide-stone-200 dark:divide-stone-800"
        data-testid="settings-sources-list"
      >
        {SOURCES.map((s) => (
          <li key={s.id} data-testid={`settings-sources-row-${s.id}`}>
            <button
              type="button"
              onClick={() => navigate(`/sources/${s.id}`)}
              className="group flex w-full items-center gap-3 border-l-2 border-transparent py-2.5 pl-3 pr-2 text-left transition-colors hover:border-[var(--ti-orange-500)] hover:bg-stone-100 dark:hover:bg-stone-900"
            >
              <span className="flex-1 text-[14px] font-medium text-stone-900 dark:text-stone-100">
                {s.title}
              </span>
              <span className="hidden flex-1 truncate text-[12px] text-stone-500 dark:text-stone-500 sm:inline">
                {s.blurb}
              </span>
              <SourceStatusMeta status={s.status} comingIn={s.comingIn} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SourceStatusMeta({
  status,
  comingIn,
}: {
  status: SourceStatus;
  comingIn?: string;
}) {
  const { t } = useTranslation();
  if (status === "shipped") {
    return (
      <span
        className="shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-500"
        title="Setup page is live — open it to wire up your account."
      >
        {t("sidebar.statusReady", { defaultValue: "shipped" })}
      </span>
    );
  }
  if (status === "beta") {
    return (
      <span
        className="shrink-0 font-mono text-[11px] text-stone-500 dark:text-stone-500"
        title={
          comingIn
            ? `Beta — full release ${comingIn}. Try it; report issues.`
            : "Beta — try it; report issues."
        }
      >
        {comingIn
          ? `${t("sidebar.statusBeta", { defaultValue: "beta" })} · ${comingIn}`
          : t("sidebar.statusBeta", { defaultValue: "beta" })}
      </span>
    );
  }
  return (
    <span
      className="shrink-0 font-mono text-[11px] text-stone-400 dark:text-stone-600"
      title={comingIn ? `Coming ${comingIn}` : "Coming soon"}
    >
      {comingIn ?? t("sidebar.statusSoon", { defaultValue: "soon" })}
    </span>
  );
}
