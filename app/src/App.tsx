import { useEffect } from "react";
import { Route, Routes, Navigate, useLocation, useNavigate } from "react-router-dom";
import { AppShell } from "@/components/layout/AppShell";
import AuthRoute from "@/routes/auth";
import MemoryRoute from "@/routes/memory";
import SourceDetailRoute from "@/routes/source-detail";
import SinkDetailRoute from "@/routes/sink-detail";
import DiscordSourceRoute from "@/routes/sources/discord";
import NotionSourceRoute from "@/routes/sources/notion";
import LoomSourceRoute from "@/routes/sources/loom";
import ZoomSourceRoute from "@/routes/sources/zoom";
import EmailSourceRoute from "@/routes/sources/email";
import VoiceNotesSourceRoute from "@/routes/sources/voice-notes";
import ExternalSourceRoute from "@/routes/sources/external";
import OnboardingTeamRoute from "@/routes/onboarding-team";
import JoinTeamRoute from "@/routes/join-team";
import MeetingDetailPage from "@/pages/meetings/detail";
import LivePage from "@/pages/live";
import ReviewPage from "@/pages/review";
import SettingsPage from "@/pages/settings";
// === v1.19.0 Round 1 === — FeedRoute is the single canvas surface.
// All legacy routes (today / this-week / daily / canvas / people / threads /
// inbox / alignment / brain / co-thinker / memory) redirect to /, with the
// internal view selector (T/H/P/R) cycling between time / heatmap / people
// / replay. The legacy route components stay on disk; they're just not
// wired into the route table any more.
import FeedRoute from "@/routes/feed";
import PersonDetailRoute from "@/routes/people/detail";
import ProjectsListRoute from "@/routes/projects";
import ProjectDetailRoute from "@/routes/projects/detail";
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
      {/* Auth screen still reachable when signed in, but redirects to /. */}
      <Route path="/auth" element={<Navigate to="/" replace />} />

      {/* === v1.19.0 Round 1 === — All legacy routes funnel into the
          single canvas surface. The single canvas (mounted at /) is
          the time-density list; H/P/R single-keys cycle the view
          internally. Heatmap / People / Replay no longer have their
          own URLs. */}
      <Route path="/dashboard" element={<Navigate to="/" replace />} />
      <Route path="/skills" element={<Navigate to="/" replace />} />
      <Route path="/skills/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/setup/*" element={<Navigate to="/" replace />} />
      <Route path="/setup" element={<Navigate to="/" replace />} />
      <Route path="/home" element={<Navigate to="/" replace />} />
      <Route path="/meeting" element={<Navigate to="/sources/discord" replace />} />
      <Route path="/meeting/setup" element={<DiscordSourceRoute />} />

      {/* Full-page routes (no sidebar / no shell). */}
      <Route path="/onboarding-team" element={<OnboardingTeamRoute />} />
      <Route path="/join" element={<JoinTeamRoute />} />
      <Route path="/sources/discord/setup" element={<DiscordSourceRoute />} />
      <Route path="/sources/notion/setup" element={<NotionSourceRoute />} />
      <Route path="/sources/loom/setup" element={<LoomSourceRoute />} />
      <Route path="/sources/zoom/setup" element={<ZoomSourceRoute />} />
      <Route path="/sources/email/setup" element={<EmailSourceRoute />} />
      <Route path="/sources/voice-notes/setup" element={<VoiceNotesSourceRoute />} />
      <Route path="/sources/external" element={<ExternalSourceRoute />} />

      <Route element={<AppShell />}>
        {/* v1.19.0 — / is the single canvas surface. */}
        <Route index element={<FeedRoute />} />

        {/* All v1.16-v1.18 primary surfaces redirect to /. The single-key
            shortcuts T/H/P/R inside AppShell handle view switching. */}
        <Route path="feed" element={<Navigate to="/" replace />} />
        <Route path="today" element={<Navigate to="/" replace />} />
        <Route path="this-week" element={<Navigate to="/" replace />} />
        <Route path="daily" element={<Navigate to="/" replace />} />
        <Route path="brain" element={<Navigate to="/" replace />} />
        <Route path="co-thinker" element={<Navigate to="/" replace />} />
        <Route path="canvas" element={<Navigate to="/" replace />} />
        <Route path="alignment" element={<Navigate to="/" replace />} />
        <Route path="inbox" element={<Navigate to="/" replace />} />
        <Route path="people" element={<Navigate to="/" replace />} />
        <Route path="threads" element={<Navigate to="/" replace />} />
        <Route path="memory" element={<Navigate to="/" replace />} />

        {/* Power-user / detail surfaces still reachable by direct URL —
            v1.19 doesn't ship UI links to them, but Cmd+K + bookmarks
            keep working. The graph routes are kept for the same reason. */}
        <Route path="people/social" element={<SocialGraphRoute />} />
        <Route path="projects/topology" element={<ProjectTopologyRoute />} />
        <Route path="decisions/lineage" element={<DecisionLineageRoute />} />
        <Route path="people/:alias" element={<PersonDetailRoute />} />
        <Route path="projects" element={<ProjectsListRoute />} />
        <Route path="projects/:slug" element={<ProjectDetailRoute />} />
        <Route path="threads/:topic" element={<ThreadDetailRoute />} />
        <Route path="reviews" element={<ReviewsRoute />} />
        <Route path="memory/*" element={<MemoryRoute />} />
        <Route path="sources/:id" element={<SourceDetailRoute />} />
        <Route path="sinks/:id" element={<SinkDetailRoute />} />

        {/* Meeting detail / live (per-call Discord views — preserved). */}
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
        <Route path="billing" element={<BillingRoute />} />
        <Route path="marketplace" element={<MarketplaceRoute />} />
        <Route path="marketplace/:id" element={<MarketplaceDetailRoute />} />
        <Route path="whats-new-app" element={<WhatsNewAppRoute />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
