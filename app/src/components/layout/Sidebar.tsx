import { NavLink } from "react-router-dom";
import { Home, Settings, HelpCircle, Activity } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "@/lib/store";

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}

// T2 will fill these in with real meeting links + Live tab visibility logic.
const ITEMS: NavItem[] = [
  { to: "/", label: "Meetings", icon: Home },
  { to: "/live", label: "Live", icon: Activity },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/help", label: "Help", icon: HelpCircle },
];

export function Sidebar() {
  const collapsed = useStore((s) => s.ui.sidebarCollapsed);

  return (
    <aside
      className={cn(
        "ti-no-select flex h-full flex-col border-r border-[var(--ti-border-faint)] bg-[var(--ti-paper-200)] transition-all duration-fast ease-ti-out",
        collapsed ? "w-16" : "w-60"
      )}
    >
      <div className="flex h-14 items-center gap-2 border-b border-[var(--ti-border-faint)] px-4">
        <div
          className="h-7 w-7 rounded-md"
          style={{ background: "var(--ti-orange-500)" }}
          aria-hidden
        />
        {!collapsed && (
          <span className="font-display text-lg leading-none text-[var(--ti-ink-900)]">
            Tangerine
          </span>
        )}
      </div>

      <nav className="flex-1 space-y-1 p-2">
        {ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-fast ease-ti-out",
                  isActive
                    ? "bg-[var(--ti-orange-50)] font-medium text-[var(--ti-orange-700)]"
                    : "text-[var(--ti-ink-700)] hover:bg-[var(--ti-paper-100)]"
                )
              }
            >
              <Icon size={18} className="shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>

      <div className="border-t border-[var(--ti-border-faint)] p-3">
        <p className={cn("text-[10px] text-[var(--ti-ink-500)]", collapsed && "hidden")}>
          v1.5.1-beta
        </p>
      </div>
    </aside>
  );
}
