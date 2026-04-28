// === wave 1.13-D ===
/**
 * v1.13 Wave 1.13-D — TeammatesPill.
 *
 * Top-bar pill showing "N teammates active" with a hover popover that
 * lists each teammate, their current route, and last action time.
 *
 * Mounted from `AppShell` above the `<Outlet/>` so it sits in the same
 * strip as the system banners. Self-hides when zero teammates are
 * active (single-user solo session) so we don't waste pixels.
 */

import { useState } from "react";
import { Link } from "react-router-dom";
import { usePresence } from "./PresenceProvider";
import { TeammateAvatar } from "./TeammateAvatar";

export function TeammatesPill() {
  const { teammatesActive } = usePresence();
  const [open, setOpen] = useState(false);

  if (teammatesActive.length === 0) return null;

  return (
    <div
      data-testid="presence-pill"
      style={{ position: "relative", display: "inline-block" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-stone-700 hover:border-[var(--ti-orange-500)]/40 hover:bg-[var(--ti-orange-50)] dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300"
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "#10B981", // emerald — "live"
          }}
        />
        <span>
          {teammatesActive.length}{" "}
          {teammatesActive.length === 1 ? "teammate" : "teammates"} active
        </span>
      </button>
      {open && (
        <div
          data-testid="presence-pill-popover"
          role="dialog"
          className="absolute right-0 top-full z-50 mt-1 w-64 rounded-md border border-stone-200 bg-white p-2 shadow-lg dark:border-stone-800 dark:bg-stone-950"
        >
          <ul className="flex flex-col gap-1">
            {teammatesActive.map((p) => (
              <li
                key={p.user}
                data-testid={`presence-pill-row-${p.user}`}
                className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-stone-50 dark:hover:bg-stone-900"
              >
                <TeammateAvatar presence={p} size={20} showRouteDot />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[12px] font-medium text-stone-800 dark:text-stone-200">
                    {p.user}
                  </span>
                  <Link
                    to={p.current_route}
                    className="truncate text-[10px] text-stone-500 hover:underline dark:text-stone-400"
                  >
                    {p.current_route}
                    {p.action_type ? ` · ${p.action_type}` : ""}
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
// === end wave 1.13-D ===
