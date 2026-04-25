import { useEffect, useState } from "react";
import { Route, Routes, Navigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import SetupRoute from "@/routes/setup";
import HomeRoute from "@/routes/home";
import MeetingsListPage from "@/pages/meetings";
import MeetingDetailPage from "@/pages/meetings/detail";
import LivePage from "@/pages/live";
import ReviewPage from "@/pages/review";
import SettingsPage from "@/pages/settings";
import { getConfig } from "@/lib/tauri";
import { useStore } from "@/lib/store";

export default function App() {
  const configLoaded = useStore((s) => s.config.loaded);
  const setYaml = useStore((s) => s.config.setYaml);
  const markLoaded = useStore((s) => s.config.markLoaded);
  const theme = useStore((s) => s.ui.theme);

  const [bootChecked, setBootChecked] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Sync theme to <html> on first mount.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Check whether ~/.tmi/config.yaml exists. Empty / null → wizard.
  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const cfg = await getConfig();
        if (cancel) return;
        if (!cfg) {
          setNeedsSetup(true);
        } else {
          setYaml(typeof cfg === "string" ? cfg : JSON.stringify(cfg));
          markLoaded();
        }
      } catch {
        if (!cancel) setNeedsSetup(true);
      } finally {
        if (!cancel) setBootChecked(true);
      }
    })();
    return () => {
      cancel = true;
    };
  }, [setYaml, markLoaded]);

  if (!bootChecked) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-[var(--ti-paper-100)]">
        <p className="text-sm text-[var(--ti-ink-500)]">Loading…</p>
      </div>
    );
  }

  if (needsSetup && !configLoaded) {
    return <SetupRoute />;
  }

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRoute />} />
        <Route path="meetings" element={<MeetingsListPage />} />
        <Route path="meetings/:id" element={<MeetingDetailPage />} />
        <Route path="meetings/:id/live" element={<LivePage />} />
        <Route path="meetings/:id/review" element={<ReviewPage />} />
        <Route path="live" element={<LivePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="setup" element={<SetupRoute />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
