import { useEffect } from "react";
import { Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import AuthRoute from "@/routes/auth";
import MemoryRoute from "@/routes/memory";
import SourceDetailRoute from "@/routes/source-detail";
import SinkDetailRoute from "@/routes/sink-detail";
import InboxRoute from "@/routes/inbox";
import AlignmentRoute from "@/routes/alignment";
import DiscordSourceRoute from "@/routes/sources/discord";
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
  const { loading, signedIn } = useAuth();
  const location = useLocation();

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
      <div className="flex h-full w-full items-center justify-center bg-stone-50 dark:bg-stone-950">
        <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>
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
      {/* Auth screen still reachable when signed in, but redirects to memory. */}
      <Route path="/auth" element={<Navigate to="/memory" replace />} />

      {/* Legacy routes → redirect into the new shell. */}
      <Route path="/dashboard" element={<Navigate to="/memory" replace />} />
      <Route path="/skills" element={<Navigate to="/memory" replace />} />
      <Route path="/skills/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/setup" element={<Navigate to="/memory" replace />} />
      <Route path="/home" element={<Navigate to="/memory" replace />} />
      {/* Old "Meeting tool" surface — Meeting was the Discord source. */}
      <Route path="/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/meeting/setup" element={<DiscordSourceRoute />} />

      {/* Discord source setup is a full-page form — no sidebar chrome. */}
      <Route path="/sources/discord/setup" element={<DiscordSourceRoute />} />

      {/* Everything else lives inside the always-on sidebar shell. */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/memory" replace />} />

        {/* MEMORY — file tree + viewer */}
        <Route path="memory" element={<MemoryRoute />} />
        <Route path="memory/*" element={<MemoryRoute />} />

        {/* SOURCES */}
        <Route path="sources/:id" element={<SourceDetailRoute />} />

        {/* SINKS */}
        <Route path="sinks/:id" element={<SinkDetailRoute />} />

        {/* INBOX */}
        <Route path="inbox" element={<InboxRoute />} />

        {/* ALIGNMENT — v1.6 placeholder. Mock dashboard for the same-screen
            rate so the CoS direction is visible without us shipping the
            real computation yet. */}
        <Route path="alignment" element={<AlignmentRoute />} />

        {/* Meeting detail / live (kept — the Discord source's per-call view). */}
        <Route path="meeting/:id" element={<MeetingDetailPage />} />
        <Route path="meeting/:id/live" element={<LivePage />} />
        <Route path="meeting/:id/review" element={<ReviewPage />} />
        <Route path="meeting/live" element={<LivePage />} />
        <Route path="meetings" element={<Navigate to="/sources/discord" replace />} />
        <Route path="meetings/:id" element={<MeetingDetailPage />} />
        <Route path="meetings/:id/live" element={<LivePage />} />
        <Route path="meetings/:id/review" element={<ReviewPage />} />
        <Route path="live" element={<LivePage />} />

        <Route path="settings" element={<SettingsPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/memory" replace />} />
    </Routes>
  );
}
