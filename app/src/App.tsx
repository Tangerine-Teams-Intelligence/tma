import { useEffect } from "react";
import { Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import AuthRoute from "@/routes/auth";
import MemoryRoute from "@/routes/memory";
import SourceDetailRoute from "@/routes/source-detail";
import SinkDetailRoute from "@/routes/sink-detail";
import InboxRoute from "@/routes/inbox";
import AlignmentRoute from "@/routes/alignment";
import DiscordSourceRoute from "@/routes/sources/discord";
import OnboardingTeamRoute from "@/routes/onboarding-team";
import JoinTeamRoute from "@/routes/join-team";
import MeetingDetailPage from "@/pages/meetings/detail";
import LivePage from "@/pages/live";
import ReviewPage from "@/pages/review";
import SettingsPage from "@/pages/settings";
// Stage 1 Wave 3 — Chief of Staff views.
import TodayRoute from "@/routes/today";
import ThisWeekRoute from "@/routes/this-week";
import PeopleListRoute from "@/routes/people";
import PersonDetailRoute from "@/routes/people/detail";
import ProjectsListRoute from "@/routes/projects";
import ProjectDetailRoute from "@/routes/projects/detail";
import ThreadsListRoute from "@/routes/threads";
import ThreadDetailRoute from "@/routes/threads/detail";
import { getConfig } from "@/lib/tauri";
import { useStore } from "@/lib/store";
import { useAuth } from "@/lib/auth";
import { onDeepLinkJoin, syncStart } from "@/lib/git";

export default function App() {
  const setYaml = useStore((s) => s.config.setYaml);
  const markLoaded = useStore((s) => s.config.markLoaded);
  const memoryConfig = useStore((s) => s.ui.memoryConfig);
  const { loading, signedIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

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

  // v1.6.0: subscribe to tangerine:// deep links. The single-instance handler
  // emits `deeplink://join` whenever the OS routes a URI into the running
  // app — we navigate to /join with the URI in the query so JoinTeamRoute
  // can parse + accept it.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    void onDeepLinkJoin((uri) => {
      navigate(`/join?uri=${encodeURIComponent(uri)}`);
    }).then((u) => {
      unsub = u;
    });
    return () => {
      unsub?.();
    };
  }, [navigate]);

  // v1.6.0: when memoryConfig is in team mode but the sync ticker isn't
  // running yet (cold launch), kick it off so the indicator goes green.
  useEffect(() => {
    if (memoryConfig.mode !== "team") return;
    if (!memoryConfig.repoLocalPath || !memoryConfig.githubLogin) return;
    void syncStart({
      repoPath: memoryConfig.repoLocalPath,
      login: memoryConfig.githubLogin,
    });
  }, [memoryConfig.mode, memoryConfig.repoLocalPath, memoryConfig.githubLogin]);

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

  // v1.6.0: deep-link landing + first-run team onboarding are full-page
  // routes (no sidebar). We render them BEFORE the auth gate so a click on a
  // tangerine:// link in another app (where Tangerine isn't yet signed in)
  // still gets parsed — JoinTeamRoute redirects to /auth as needed.
  // The team onboarding fires the first time the user reaches /memory and
  // hasn't picked a mode; we redirect from /memory there in MemoryRoute itself.

  return (
    <Routes>
      {/* Auth screen still reachable when signed in, but redirects to /today. */}
      <Route path="/auth" element={<Navigate to="/today" replace />} />

      {/* Legacy routes → redirect into the new shell. /memory is still
          reachable for the file tree, but the default landing is now
          /today (Stage 1 Wave 3). */}
      <Route path="/dashboard" element={<Navigate to="/today" replace />} />
      <Route path="/skills" element={<Navigate to="/today" replace />} />
      <Route path="/skills/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/setup" element={<Navigate to="/today" replace />} />
      <Route path="/home" element={<Navigate to="/today" replace />} />
      {/* Old "Meeting tool" surface — Meeting was the Discord source. */}
      <Route path="/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/meeting/setup" element={<DiscordSourceRoute />} />

      {/* v1.6.0 — full-page routes (no sidebar). */}
      <Route path="/onboarding-team" element={<OnboardingTeamRoute />} />
      <Route path="/join" element={<JoinTeamRoute />} />

      {/* Discord source setup is a full-page form — no sidebar chrome. */}
      <Route path="/sources/discord/setup" element={<DiscordSourceRoute />} />

      {/* Everything else lives inside the always-on sidebar shell. */}
      <Route element={<AppShell />}>
        <Route index element={<Navigate to="/today" replace />} />

        {/* Stage 1 Wave 3 — Chief of Staff views (default landing). */}
        <Route path="today" element={<TodayRoute />} />
        <Route path="this-week" element={<ThisWeekRoute />} />
        <Route path="people" element={<PeopleListRoute />} />
        <Route path="people/:alias" element={<PersonDetailRoute />} />
        <Route path="projects" element={<ProjectsListRoute />} />
        <Route path="projects/:slug" element={<ProjectDetailRoute />} />
        <Route path="threads" element={<ThreadsListRoute />} />
        <Route path="threads/:topic" element={<ThreadDetailRoute />} />

        {/* MEMORY — file tree + viewer (still reachable, no longer default) */}
        <Route path="memory" element={<MemoryRoute />} />
        <Route path="memory/*" element={<MemoryRoute />} />

        {/* SOURCES */}
        <Route path="sources/:id" element={<SourceDetailRoute />} />

        {/* SINKS */}
        <Route path="sinks/:id" element={<SinkDetailRoute />} />

        {/* INBOX — real implementation; reads briefs/pending.md */}
        <Route path="inbox" element={<InboxRoute />} />

        {/* ALIGNMENT — real implementation; reads alignment.json */}
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

      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}
