import { useEffect } from "react";
import { Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import AuthRoute from "@/routes/auth";
import HomeRoute from "@/routes/home";
import MeetingRoute from "@/routes/meeting";
import MeetingSetupRoute from "@/routes/meeting-setup";
import WikiRoute from "@/routes/wiki";
import TrackRoute from "@/routes/track";
import ReviewRoute from "@/routes/review";
import ScheduleRoute from "@/routes/schedule";
import LoomRoute from "@/routes/loom";
import HireRoute from "@/routes/hire";
import VoiceRoute from "@/routes/voice";
import SurveyRoute from "@/routes/survey";
import ChatRoute from "@/routes/chat";
import SetupRoute from "@/routes/setup";
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
      {/* Auth screen still reachable when signed in, but redirects to home. */}
      <Route path="/auth" element={<Navigate to="/home" replace />} />

      {/* Legacy routes → redirect into the new shell. */}
      <Route path="/dashboard" element={<Navigate to="/home" replace />} />
      <Route path="/skills" element={<Navigate to="/home" replace />} />
      <Route path="/skills/meeting" element={<Navigate to="/meeting/setup" replace />} />
      <Route path="/setup" element={<SetupRoute />} />

      {/* Meeting setup is a full-page form — no sidebar chrome. */}
      <Route path="/meeting/setup" element={<MeetingSetupRoute />} />

      {/* Everything else lives inside the always-on sidebar shell. */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/home" replace />} />
        <Route path="home" element={<HomeRoute />} />

        {/* Meeting tool */}
        <Route path="meeting" element={<MeetingRoute />} />
        <Route path="meeting/:id" element={<MeetingDetailPage />} />
        <Route path="meeting/:id/live" element={<LivePage />} />
        <Route path="meeting/:id/review" element={<ReviewPage />} />
        <Route path="meeting/live" element={<LivePage />} />

        {/* Legacy /meetings/* → keep working for any deep links / docs. */}
        <Route path="meetings" element={<Navigate to="/meeting" replace />} />
        <Route path="meetings/:id" element={<MeetingDetailPage />} />
        <Route path="meetings/:id/live" element={<LivePage />} />
        <Route path="meetings/:id/review" element={<ReviewPage />} />
        <Route path="live" element={<LivePage />} />

        {/* The 9 not-yet-shipping tools. */}
        <Route path="wiki" element={<WikiRoute />} />
        <Route path="track" element={<TrackRoute />} />
        <Route path="review" element={<ReviewRoute />} />
        <Route path="schedule" element={<ScheduleRoute />} />
        <Route path="loom" element={<LoomRoute />} />
        <Route path="hire" element={<HireRoute />} />
        <Route path="voice" element={<VoiceRoute />} />
        <Route path="survey" element={<SurveyRoute />} />
        <Route path="chat" element={<ChatRoute />} />

        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/home" replace />} />
    </Routes>
  );
}
