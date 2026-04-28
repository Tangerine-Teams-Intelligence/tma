// === wave 19 ===
/**
 * Wave 19 — Settings → Sources tab.
 *
 * Surfaces all 11 sources (was a sidebar section in v1.10.x) inside the
 * Settings page. Each row shows status (shipped / beta / coming) per the
 * Wave 7 honest labels and a "Configure" link that opens the per-source
 * detail page in the main content area. The intent is to keep sources
 * fully reachable without spending sidebar real estate on connectors —
 * connectors are configuration, not navigation.
 *
 * The /sources/:id detail routes themselves are unchanged; this tab just
 * provides the directory-level entry that used to live in the sidebar.
 */

import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { SOURCES, type SourceStatus } from "@/lib/sources";

export function SourcesSettings() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div className="flex flex-col gap-4" data-testid="settings-sources">
      <header>
        <h3 className="font-display text-lg">
          {t("sidebar.sources", { defaultValue: "Sources" })}
        </h3>
        <p className="text-xs text-[var(--ti-ink-500)]">
          {t("sidebar.subtitleSources", {
            defaultValue: "Where team comms come in",
          })}{" "}
          — {SOURCES.length}{" "}
          {t("settings.sources.connectorsLabel", {
            defaultValue: "connectors",
          })}
          .
        </p>
      </header>

      <ul
        className="divide-y divide-[var(--ti-border-faint)] rounded border border-[var(--ti-border-faint)]"
        data-testid="settings-sources-list"
      >
        {SOURCES.map((s) => {
          const Icon = s.icon;
          return (
            <li key={s.id} data-testid={`settings-sources-row-${s.id}`}>
              <button
                type="button"
                onClick={() => navigate(`/sources/${s.id}`)}
                className="flex w-full items-start gap-3 px-3 py-2.5 text-left text-sm transition-colors duration-fast hover:bg-stone-100 dark:hover:bg-stone-900"
              >
                <Icon
                  size={16}
                  className="mt-0.5 shrink-0 text-[var(--ti-ink-500)]"
                />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium text-[var(--ti-ink-900)]">
                    {s.title}
                  </span>
                  <span className="truncate text-[11px] text-[var(--ti-ink-500)]">
                    {s.blurb}
                  </span>
                </div>
                <SourceStatusBadge status={s.status} comingIn={s.comingIn} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function SourceStatusBadge({
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
        className="ml-2 shrink-0 self-center font-mono text-[10px] text-stone-500 dark:text-stone-400"
        title="Setup page is live — open it to wire up your account."
      >
        {t("sidebar.statusReady")}
      </span>
    );
  }
  if (status === "beta") {
    return (
      <span
        className="ml-2 shrink-0 self-center font-mono text-[10px] text-amber-600 dark:text-amber-400"
        title={
          comingIn
            ? `Beta — full release ${comingIn}. Try it; report issues.`
            : "Beta — try it; report issues."
        }
      >
        {t("sidebar.statusBeta")}
      </span>
    );
  }
  return (
    <span
      className="ml-2 shrink-0 self-center font-mono text-[10px] text-stone-400 dark:text-stone-500"
      title={comingIn ? `Coming ${comingIn}` : "Coming soon"}
    >
      {comingIn ?? t("sidebar.statusSoon")}
    </span>
  );
}
// === end wave 19 ===
