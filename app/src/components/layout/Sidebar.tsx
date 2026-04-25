import { NavLink, useNavigate } from "react-router-dom";
import { Settings, Lock } from "lucide-react";
import { TOOLS, type ToolDef } from "@/lib/tools";
import { cn } from "@/lib/utils";
import { signOut } from "@/lib/auth";

/**
 * Always-visible left rail. 10 tool icons, app logo on top, settings + lock
 * on bottom. Click a tool to navigate to that tool's route — every tool has
 * one, even the not-yet-shipping ones (those land on a "Coming v1.x" page).
 */
export function Sidebar() {
  const navigate = useNavigate();

  async function handleLock() {
    await signOut();
    navigate("/auth", { replace: true });
  }

  return (
    <aside className="ti-no-select flex h-full w-[68px] shrink-0 flex-col items-center justify-between border-r border-[var(--ti-border-faint)] bg-[var(--ti-paper-200)] py-3">
      {/* Logo */}
      <div className="flex flex-col items-center gap-3">
        <NavLink
          to="/home"
          className="group relative"
          aria-label="Home"
          title="Home"
        >
          <div
            className="h-10 w-10 rounded-lg shadow-sm transition-transform duration-fast ease-ti-out group-hover:scale-105"
            style={{ background: "var(--ti-orange-500)" }}
            aria-hidden
          />
        </NavLink>

        {/* Divider */}
        <div className="my-1 h-px w-8 bg-[var(--ti-border-default)]" />

        {/* 10 tools */}
        <nav className="flex flex-col items-center gap-2">
          {TOOLS.map((tool) => (
            <ToolButton key={tool.id} tool={tool} />
          ))}
        </nav>
      </div>

      {/* Bottom: settings + lock */}
      <div className="flex flex-col items-center gap-1.5">
        <NavLink
          to="/settings"
          className={({ isActive }) =>
            cn(
              "group relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-fast",
              isActive
                ? "bg-[var(--ti-orange-50)] text-[var(--ti-orange-700)]"
                : "text-[var(--ti-ink-500)] hover:bg-[var(--ti-paper-100)] hover:text-[var(--ti-ink-900)]",
            )
          }
          aria-label="Settings"
          title="Settings"
        >
          <Settings size={18} />
          <HoverLabel label="Settings" />
        </NavLink>
        <button
          type="button"
          onClick={handleLock}
          className="group relative flex h-10 w-10 items-center justify-center rounded-lg text-[var(--ti-ink-500)] transition-colors duration-fast hover:bg-[var(--ti-paper-100)] hover:text-[var(--ti-ink-900)]"
          aria-label="Sign out"
          title="Sign out"
        >
          <Lock size={18} />
          <HoverLabel label="Sign out" />
        </button>
      </div>
    </aside>
  );
}

function ToolButton({ tool }: { tool: ToolDef }) {
  const Icon = tool.icon;
  const coming = !!tool.comingIn;

  return (
    <NavLink
      to={tool.path}
      className={({ isActive }) =>
        cn(
          "group relative flex h-10 w-10 items-center justify-center rounded-lg transition-colors duration-fast ease-ti-out",
          isActive
            ? "bg-[var(--ti-orange-500)] text-white shadow-sm"
            : coming
              ? "text-[var(--ti-ink-300)] hover:bg-[var(--ti-paper-100)] hover:text-[var(--ti-ink-700)]"
              : "text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-100)] hover:text-[var(--ti-ink-900)]",
        )
      }
      aria-label={tool.title}
      title={tool.title}
    >
      <Icon size={18} />
      {coming && (
        <span
          className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-[var(--ti-ink-300)] group-hover:bg-[var(--ti-orange-500)]"
          aria-hidden
        />
      )}
      <HoverLabel label={tool.title} sub={tool.comingIn ? `Coming ${tool.comingIn}` : undefined} />
    </NavLink>
  );
}

function HoverLabel({ label, sub }: { label: string; sub?: string }) {
  return (
    <span className="pointer-events-none absolute left-full top-1/2 z-50 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-2.5 py-1 text-xs font-medium text-[var(--ti-ink-900)] opacity-0 shadow-md transition-opacity duration-fast ease-ti-out group-hover:opacity-100">
      {label}
      {sub && (
        <span className="ml-1.5 text-[10px] font-normal text-[var(--ti-ink-500)]">{sub}</span>
      )}
    </span>
  );
}
