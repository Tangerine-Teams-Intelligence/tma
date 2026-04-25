import { Outlet } from "react-router-dom";
import { Moon, Sun, PanelLeft } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { Button } from "@/components/ui/button";
import { useStore } from "@/lib/store";

export function AppShell() {
  const theme = useStore((s) => s.ui.theme);
  const toggleTheme = useStore((s) => s.ui.toggleTheme);
  const toggleSidebar = useStore((s) => s.ui.toggleSidebar);
  const toasts = useStore((s) => s.ui.toasts);
  const dismissToast = useStore((s) => s.ui.dismissToast);

  return (
    <div className="flex h-full w-full">
      <Sidebar />

      <div className="flex flex-1 flex-col">
        <header className="ti-no-select flex h-14 items-center justify-between border-b border-[var(--ti-border-faint)] bg-[var(--ti-paper-100)] px-4">
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="icon" onClick={toggleSidebar} aria-label="Toggle sidebar">
              <PanelLeft size={18} />
            </Button>
            <span className="text-sm text-[var(--ti-ink-500)]">Tangerine AI Teams</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              title={theme === "light" ? "Switch to dark" : "Switch to light"}
            >
              {theme === "light" ? <Moon size={18} /> : <Sun size={18} />}
            </Button>
          </div>
        </header>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* Toast layer */}
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed bottom-4 right-4 flex flex-col gap-2">
          {toasts.map((t) => (
            <div
              key={t.id}
              role="status"
              onClick={() => dismissToast(t.id)}
              className="pointer-events-auto max-w-sm cursor-pointer rounded-md border border-[var(--ti-border-default)] bg-[var(--ti-paper-50)] px-4 py-3 text-sm shadow-md animate-fade-in"
            >
              <span
                className={
                  t.kind === "success"
                    ? "text-[#2D8659]"
                    : t.kind === "error"
                      ? "text-[#B83232]"
                      : "text-[var(--ti-ink-700)]"
                }
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
