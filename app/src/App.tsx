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
// v1.8 Phase 2-C — Notion / Loom / Zoom real-wire setup pages.
import NotionSourceRoute from "@/routes/sources/notion";
import LoomSourceRoute from "@/routes/sources/loom";
import ZoomSourceRoute from "@/routes/sources/zoom";
// v1.8 Phase 2-D — Email + Voice notes (new sources, ingest only).
import EmailSourceRoute from "@/routes/sources/email";
import VoiceNotesSourceRoute from "@/routes/sources/voice-notes";
// v3.0 §2 — Layer 6 external world capture (RSS / podcast / YouTube / article).
import ExternalSourceRoute from "@/routes/sources/external";
import OnboardingTeamRoute from "@/routes/onboarding-team";
import JoinTeamRoute from "@/routes/join-team";
import MeetingDetailPage from "@/pages/meetings/detail";
import LivePage from "@/pages/live";
import ReviewPage from "@/pages/review";
import SettingsPage from "@/pages/settings";
// Stage 1 Wave 3 — Chief of Staff views.
import TodayRoute from "@/routes/today";
import ThisWeekRoute from "@/routes/this-week";
// === v1.16 Wave 2 === — Story Feed, the new default landing surface.
// Replaces /today as the v1.16 entry point. /today still works (legacy
// muscle memory) until v1.17 drops it.
import FeedRoute from "@/routes/feed";
// === wave 24 ===
import DailyRoute from "@/routes/daily";
// === end wave 24 ===
import PeopleListRoute from "@/routes/people";
import PersonDetailRoute from "@/routes/people/detail";
import ProjectsListRoute from "@/routes/projects";
import ProjectDetailRoute from "@/routes/projects/detail";
import ThreadsListRoute from "@/routes/threads";
import ThreadDetailRoute from "@/routes/threads/detail";
// === v1.16 Wave 1 === — AI Tools setup page + /setup/connect onboarding
// step砍. Personal AI capture is now configured inline from
// settings/PersonalAgents → no per-tool setup route needed. Canvas +
// Co-thinker route imports砍 (smart layer gone).
// === v2.5 billing route ===
import BillingRoute from "@/routes/billing";
// === end v2.5 billing route ===
// === v2.5 reviews route ===
import ReviewsRoute from "@/routes/reviews";
// === end v2.5 reviews route ===
// === v3.5 marketplace ===
import MarketplaceRoute from "@/routes/marketplace/index";
import MarketplaceDetailRoute from "@/routes/marketplace/[id]";
// === end v3.5 marketplace ===
// === v1.14.6 round-7 === — in-app version changelog (different from
// /what's-new which surfaces ATOMS since last view).
import WhatsNewAppRoute from "@/routes/whats-new-app";
// === end v1.14.6 round-7 ===
// === v2.0-beta.1 graphs ===
// V2_0_SPEC §2.2-§2.4 — three sibling graph surfaces sitting next to
// /today's WorkflowGraph. Each is a thin wrapper over the matching
// reactflow component in components/graphs/. No backend wiring — they
// read the same `list_atoms` Tauri command the home graph already uses.
import DecisionLineageRoute from "@/routes/decisions/lineage";
import SocialGraphRoute from "@/routes/people/social";
import ProjectTopologyRoute from "@/routes/projects/topology";
// === end v2.0-beta.1 graphs ===
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
      {/* === v1.16 Wave 1 === — /setup/connect 砍. /setup keeps the
          fall-through redirect for any old bookmark. */}
      <Route path="/setup/*" element={<Navigate to="/today" replace />} />
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

      {/* v1.8 Phase 2-C — Notion / Loom / Zoom setup pages (full-page forms). */}
      <Route path="/sources/notion/setup" element={<NotionSourceRoute />} />
      <Route path="/sources/loom/setup" element={<LoomSourceRoute />} />
      <Route path="/sources/zoom/setup" element={<ZoomSourceRoute />} />

      {/* v1.8 Phase 2-D — Email + Voice notes setup pages (full-page). */}
      <Route path="/sources/email/setup" element={<EmailSourceRoute />} />
      <Route path="/sources/voice-notes/setup" element={<VoiceNotesSourceRoute />} />

      {/* v3.0 §2 — External world (RSS / podcast / YouTube / article) setup. */}
      <Route path="/sources/external" element={<ExternalSourceRoute />} />

      {/* Everything else lives inside the always-on sidebar shell. */}
      <Route element={<AppShell />}>
        {/* v1.16 Wave 2 — /feed is the new default landing. /today
            remains reachable for muscle memory but the index now lands
            on Feed. */}
        <Route index element={<Navigate to="/feed" replace />} />

        <Route path="feed" element={<FeedRoute />} />

        {/* v1.16 Wave 6 dogfood — every legacy primary surface that was
            replaced by /feed redirects there. /today (Wave-3 dashboard
            with Search team memory + Recent decisions widgets) is dead;
            the LLM-shaped widgets it rendered were砍 alongside the
            smart layer. /this-week + /daily roll up into /feed's day
            separator. /co-thinker, /canvas, /brain, /alignment all 砍.
            Keep TodayRoute import alive only because it's referenced
            by some test fixtures — but route is unmounted. */}
        <Route path="today" element={<Navigate to="/feed" replace />} />
        <Route path="this-week" element={<Navigate to="/feed" replace />} />
        <Route path="daily" element={<Navigate to="/feed" replace />} />
        <Route path="brain" element={<Navigate to="/feed" replace />} />
        <Route path="co-thinker" element={<Navigate to="/feed" replace />} />
        <Route path="canvas" element={<Navigate to="/feed" replace />} />
        <Route path="alignment" element={<Navigate to="/feed" replace />} />
        <Route path="inbox" element={<Navigate to="/threads" replace />} />
        <Route path="people" element={<PeopleListRoute />} />
        {/* === v2.0-beta.1 graphs ===
            Static graph routes MUST sit above the param routes; otherwise
            `:alias` / `:slug` swallow them. */}
        <Route path="people/social" element={<SocialGraphRoute />} />
        <Route path="projects/topology" element={<ProjectTopologyRoute />} />
        <Route path="decisions/lineage" element={<DecisionLineageRoute />} />
        {/* === end v2.0-beta.1 graphs === */}
        <Route path="people/:alias" element={<PersonDetailRoute />} />
        <Route path="projects" element={<ProjectsListRoute />} />
        <Route path="projects/:slug" element={<ProjectDetailRoute />} />
        <Route path="threads" element={<ThreadsListRoute />} />
        <Route path="threads/:topic" element={<ThreadDetailRoute />} />

        {/* === v1.16 Wave 1 === — Canvas + Co-thinker (+ /brain alias)
            routes 砍. Old bookmarks fall through to the / catch-all
            `Navigate to /today`. Wave 2 may reuse /brain for a Memory
            tree; until then no route owns those URLs. */}

        {/* === v2.5 reviews route === */}
        <Route path="reviews" element={<ReviewsRoute />} />
        {/* === end v2.5 reviews route === */}

        {/* MEMORY — file tree + viewer (still reachable, no longer default) */}
        <Route path="memory" element={<MemoryRoute />} />
        <Route path="memory/*" element={<MemoryRoute />} />

        {/* SOURCES */}
        <Route path="sources/:id" element={<SourceDetailRoute />} />

        {/* SINKS */}
        <Route path="sinks/:id" element={<SinkDetailRoute />} />

        {/* === v1.16 Wave 1 === — AI Tools per-tool setup route砍. The
            sidebar entry now points at settings/PersonalAgents. Old links
            fall through to the / → /today catch-all. */}

        {/* v1.16 — /inbox + /alignment redirects mounted earlier above
            (inbox → /threads since both are @mention surfaces;
            alignment → /feed since alignment was an LLM-shaped surface). */}

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

        {/* === v2.5 billing route === */}
        <Route path="billing" element={<BillingRoute />} />
        {/* === end v2.5 billing route === */}

        {/* === v3.5 marketplace === */}
        <Route path="marketplace" element={<MarketplaceRoute />} />
        <Route path="marketplace/:id" element={<MarketplaceDetailRoute />} />
        {/* === end v3.5 marketplace === */}

        {/* === v1.14.6 round-7 === — in-app version changelog. */}
        <Route path="whats-new-app" element={<WhatsNewAppRoute />} />
        {/* === end v1.14.6 round-7 === */}
      </Route>

      <Route path="*" element={<Navigate to="/today" replace />} />
    </Routes>
  );
}
