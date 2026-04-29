/**
 * v1.16 Wave 2 — top tab nav across the 3 core view modes (Feed /
 * Threads / People). Spec: glanceable horizontal tabs, brand orange
 * underline on active, keyboard accessible (←/→ arrow keys move focus,
 * Enter activates).
 *
 * Used by /feed, /threads, /people. Mounts via NavLink so React Router
 * handles the routing — we never imperatively `window.history.pushState`.
 */

import { NavLink } from "react-router-dom";

interface TabSpec {
  to: string;
  label: string;
  testId: string;
}

const TABS: TabSpec[] = [
  { to: "/feed", label: "Feed", testId: "view-tabs-feed" },
  { to: "/threads", label: "Threads", testId: "view-tabs-threads" },
  { to: "/people", label: "People", testId: "view-tabs-people" },
];

export function ViewTabs() {
  return (
    <nav
      role="tablist"
      data-testid="view-tabs"
      className="border-b border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-950"
    >
      {/* v1.16 Wave 5 — narrower horizontal padding on mobile so all 3
          tabs fit a 375px viewport without wrapping. */}
      <div className="mx-auto flex max-w-3xl items-center gap-1 px-2 md:px-3">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            role="tab"
            data-testid={t.testId}
            className={({ isActive }) =>
              "relative px-2 py-2 text-[13px] font-medium transition-colors md:px-3 " +
              (isActive
                ? "text-[var(--ti-orange-700)]"
                : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-100")
            }
          >
            {({ isActive }) => (
              <>
                <span>{t.label}</span>
                {isActive && (
                  <span
                    aria-hidden
                    data-testid={`${t.testId}-underline`}
                    className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--ti-orange-500)]"
                  />
                )}
              </>
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
