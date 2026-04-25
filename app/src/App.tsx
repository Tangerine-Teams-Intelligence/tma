import { useEffect } from "react";
import { Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import AuthRoute from "@/routes/auth";
import DashboardRoute from "@/routes/dashboard";
import SkillsMarketplaceRoute from "@/routes/skills";
import MeetingSkillRoute from "@/routes/skills/meeting";
import SetupRoute from "@/routes/setup";
import HomeRoute from "@/routes/home";
import MeetingsListPage from "@/pages/meetings";
import MeetingDetailPage from "@/pages/meetings/detail";
import LivePage from "@/pages/live";
import ReviewPage from "@/pages/review";
import SettingsPage from "@/pages/settings";
import { getConfig } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";

export default function App() {
  const setYaml = useStore((s) => s.config.setYaml);
  const markLoaded = useStore((s) => s.config.markLoaded);
  const theme = useStore((s) => s.ui.theme);
  const { loading, signedIn } = useAuth();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Best-effort: load any existing ~/.tmi/config.yaml so the live meeting UI
  // has the data it needs. We no longer block on it — the auth gate is the
  // boot gate now.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const cfg = await getConfig();
        if (cancel) return;
        if (cfg) {
          setYaml(typeof cfg === "string" ? cfg : JSON.stringify(cfg));
          markLoaded();
        }
      } catch {
        /* no-op */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setYaml, markLoaded]);

  if (loading) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--ti-paper-100)]">
        <p className="text-sm text-[var(--ti-ink-500)]">Loading…</p>
      </div>
    );
  }

  if (!signedIn) {
    // Always show auth screen when not signed in. Allow only /auth to render.
    return (
      <Routes>
        <Route path="/auth" element={<AuthRoute />} />
        <Route path="*" element={<Navigate to="/auth" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  return (
    <Routes>
      {/* Auth screen still reachable when signed in, but redirects to dashboard. */}
      <Route path="/auth" element={<Navigate to="/dashboard" replace />} />

      {/* Super-app shell routes (custom chrome). */}
      <Route path="/dashboard" element={<DashboardRoute />} />
      <Route path="/skills" element={<SkillsMarketplaceRoute />} />
      <Route path="/skills/meeting" element={<MeetingSkillRoute />} />

      {/* Legacy wizard route is now a redirect to the dashboard. */}
      <Route path="/setup" element={<SetupRoute />} />

      {/* Live meeting UI — kept under the existing AppShell layout. */}
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="meetings" element={<MeetingsListPage />} />
        <Route path="meetings/:id" element={<MeetingDetailPage />} />
        <Route path="meetings/:id/live" element={<LivePage />} />
        <Route path="meetings/:id/review" element={<ReviewPage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  );
}
