/**
 * Zustand store. Slices: ui, wizard (legacy), config, skills.
 *
 * v1.5.4 repositions Tangerine as a memory layer. The UI no longer thinks of
 * itself as a 10-tool super-app — it thinks of itself as a tree of memory
 * files plus the connectors (Sources) that feed them and the consumers (Sinks)
 * that read them. The store reflects that:
 *   - `ui.theme` now allows a `system` value (default).
 *   - `ui.memoryRoot` is the on-disk path to the user's memory dir.
 *   - The legacy `skills` slice is kept under `skills.meetingConfig` because
 *     the Discord source reuses the meeting setup form.
 *
 * The `wizard` slice is still here because the field components
 * (SW1DiscordBot, SW2LocalWhisper, SW3ClaudeDetect, SW4TeamMembers) still
 * read `wizard.collected` directly. Those moved under
 * components/sources/discord/ in v1.5.4 but their store contract is unchanged.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { defaultMemoryRoot } from "./memory";
import {
  type AgiVolume,
  type DismissEntry,
  pruneDismissed,
} from "./ambient";
import type { BannerProps } from "@/components/suggestions/Banner";
import type { ModalProps } from "@/components/suggestions/Modal";

// ---------- shared types ----------

export interface TeamMember {
  alias: string;
  displayName: string;
  discordId: string;
}

export interface WizardData {
  discordToken?: string;
  guildId?: string;
  /** "local" = bundled faster-whisper (default). "openai" = OpenAI Whisper API. */
  whisperMode?: "local" | "openai";
  /** Only set when whisperMode === "openai". */
  whisperKey?: string;
  claudeCliPath?: string;
  claudeCliVersion?: string;
  /** Path D — Node 20+ runtime is a prerequisite (we don't bundle it). */
  nodeAvailable?: boolean;
  nodeVersion?: string;
  nodePath?: string;
  targetRepo?: string;
  team?: TeamMember[];
  meetingsRepo?: string;
}

export type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

export interface MeetingConfig {
  discordToken?: string;
  guildId?: string;
  whisperMode?: "local" | "openai";
  whisperKey?: string;
  claudeCliPath?: string;
  claudeCliVersion?: string;
  nodeAvailable?: boolean;
  nodeVersion?: string;
  nodePath?: string;
  team?: TeamMember[];
}

export type ThemeMode = "light" | "dark" | "system";

/**
 * v1.6.0 team memory sync config. Shape mirrors the Rust side at
 * `commands/sync.rs::SyncStartArgs` plus the fields the React side needs
 * to remember between launches (mode, github login, clone URL, local path).
 *
 * `mode === undefined` → first-run: the /memory route opens the
 *   onboarding modal that asks the champion to pick "create new" / "use
 *   existing" / "solo".
 * `mode === "solo"` → the legacy `~/.tangerine-memory/` flow.
 * `mode === "team"` → the repo at `repoLocalPath` is the source of truth.
 *   `repoUrl` is the GitHub clone URL, `githubLogin` identifies the OAuth
 *   token in the OS keychain (the token itself never lives in the store).
 */
export interface MemoryConfig {
  mode?: "solo" | "team";
  repoUrl?: string;
  repoLocalPath?: string;
  githubLogin?: string;
  /** Filled when the champion creates a new repo so we can show the invite. */
  inviteUri?: string;
  inviteExpiresAt?: number;
  /**
   * v2.0-alpha.1 — toggle for the personal-vault layer. When true (default),
   * the sidebar tree unions `team/` + `personal/<user>/`. When false, the
   * tree only walks `team/` — useful for users who want a pure team-mode
   * view without the local-only entries cluttering the surface. Note: this
   * only hides personal entries from the read path; the writers (e.g.
   * voice notes) still write to `personal/<user>/` regardless.
   */
  personalDirEnabled?: boolean;
}

// ---------- slices ----------

interface UiSlice {
  /** "system" follows OS preference at boot; "light" / "dark" are explicit. */
  theme: ThemeMode;
  /** Resolved theme — what's actually applied to <html>. Recomputed on change. */
  resolvedTheme: "light" | "dark";
  /** Path to the user's memory dir (where source files land). */
  memoryRoot: string;
  sidebarCollapsed: boolean;
  // === wave 8 === — per-section collapse state for the sidebar.
  // === wave 14 === — drastic UX simplification. The default rail
  // collapses to 3 sections — Brain (expanded), Sources (collapsed,
  // count chip), AI tools (collapsed, count chip). Active Agents +
  // Advanced live behind the "Show advanced" toggle (they were
  // overwhelming new users with 30+ items in v1.10.3). Wave 14 adds
  // the `brain` section key.
  sidebarSections: {
    brain: boolean;
    sources: boolean;
    aiTools: boolean;
    advanced: boolean;
    activeAgents: boolean;
  };
  toggleSidebarSection: (
    key: "brain" | "sources" | "aiTools" | "advanced" | "activeAgents",
  ) => void;
  /** Cmd+K command palette visibility. */
  paletteOpen: boolean;
  /** True when user chose "Skip — local memory only" on auth. */
  localOnly: boolean;
  /** True after `init_memory_with_samples` has run successfully (or no-op). */
  samplesSeeded: boolean;
  /** True after the user dismisses the in-content sample banner.
   *  v1.13.10 round-10: kept for backward-compat persistence migration.
   *  New code reads `sampleBannerDismissedPaths` instead — see below. */
  sampleBannerDismissed: boolean;
  // === v1.13.10 round-10 ===
  /** Per-file dismissal record — keyed by atom relPath. R10 fix: the
   *  global bool above caused dismissing the banner on ONE sample file
   *  to silently hide it on ALL sample files forever, even after the
   *  user re-seeded a fresh sample set. Per-file dismiss restores user
   *  control: dismissing a sample file remembers that file only. */
  sampleBannerDismissedPaths: string[];
  // === end v1.13.10 round-10 ===
  // === wave 13 ===
  /** Wave 13 — populated-app demo flag. Flips `true` on truly-fresh first
   *  launch (memory dir missing or empty) so the user lands on a populated
   *  app instead of empty states. The DemoModeBanner reads this; "Hide"
   *  flips it false but keeps the data on disk; "Connect your real team"
   *  forwards the user into GitInitBanner / SetupWizard. */
  demoMode: boolean;
  /** Wave 13 — true once `demo_seed_install` has been attempted at least
   *  once on this install. Persisted so we don't re-trigger the demo
   *  install effect on every cold launch (the install itself is
   *  idempotent, but the side-effect of flipping `demoMode = true` should
   *  not re-fire after the user has dismissed the banner). */
  demoSeedAttempted: boolean;
  // === end wave 13 ===
  // === v1.16 Wave 1 === — Wave 1.15 W2.1 demoTourCompleted砍 (DemoTourOverlay deleted).
  /** v1.6.0 team memory sync configuration. Undefined mode → first-run. */
  memoryConfig: MemoryConfig;
  /** Current user alias used by cursor / what's-new commands. Defaults to
   *  the discord/github login when known; falls back to "me" so the cursor
   *  file path is always valid. Set explicitly during onboarding. */
  currentUser: string;
  /** Atom ids the user has dismissed locally (right-rail "x" button).
   *  Independent of cursor.atoms_acked — that one is server-trip; this is
   *  ephemeral filtering so the rail clears immediately. */
  dismissedAtoms: string[];
  // === wave 16 ===
  /** Wave 16 — right-rail ACTIVITY panel filter selection. Persisted so
   *  the user's pick survives across launches. The filter applies to the
   *  live event stream (`activity:atom_written`) AND the initial
   *  `activity_recent` hydration. */
  activityFeedFilter: "all" | "me" | "team";
  // === end wave 16 ===
  // === wave 23 ===
  /** Wave 23 — `/memory` route view mode toggle. Tree (default) renders the
   *  Wave 21 file tree + preview; Graph renders the new visual atom graph;
   *  List renders a flat sortable list of all atoms. Persisted so the
   *  user's pick survives cold launches. */
  memoryViewMode: "tree" | "graph" | "list";
  setMemoryViewMode: (m: "tree" | "graph" | "list") => void;
  // === end wave 23 ===
  /** Atom ids snoozed locally; cleared after 24h via setInterval. */
  snoozedAtoms: Record<string, number>;
  /** Whats-new banner state. dismissed=true hides the banner until next
   *  cursor.last_opened_at refresh. */
  whatsNewDismissed: boolean;
  // === v1.14.6 round-7 ===
  /** Most recent app version the user has seen the changelog for.
   *  Drives the one-shot "/whats-new-app has new entries" toast on
   *  AppShell mount after an upgrade. `null` until first visit. */
  lastSeenAppVersion: string | null;
  // === end v1.14.6 round-7 ===
  /** v1.8 Phase 1 — id of the user's "primary" AI tool (the one with the ⭐
   *  in the sidebar). `null` until first launch's auto-pick runs. The pick
   *  itself happens in components/ai-tools/AIToolsSection.tsx after
   *  `detect_ai_tools` returns; this field is the persisted choice. */
  primaryAITool: string | null;
  // ---- v1.8 Phase 4 — ambient input layer ----
  // The CEO's vision: every input is an AGI entry point, gated by these
  // three knobs. See `lib/ambient.ts::shouldShowReaction` for the policy.
  /** Master kill switch (v1.8). When false, the entire ambient AGI layer
   *  pauses on the frontend: no inline reactions, no heartbeat, no
   *  system tray surfacing. The volume / channel / threshold controls
   *  below remain in their last state but are gated by this flag. The
   *  Rust co-thinker daemon ticks on its own clock and is NOT yet
   *  gated here — that's a v1.9 backend hook. Default `true`. */
  agiParticipation: boolean;
  /** Volume band controlling how often the AGI surfaces inline reactions.
   *  Default `quiet` — high-confidence only. */
  agiVolume: AgiVolume;
  /** Per-channel mute list. Lets the user silence Canvas / Memory / Cmd+K /
   *  /today / Settings independently without flipping the global volume. */
  mutedAgiChannels: string[];
  /** Surfaces the user explicitly dismissed in the last 24h. The store
   *  prunes entries older than 24h on every write so the list stays small. */
  dismissedSurfaces: DismissEntry[];
  /** User-tunable confidence floor (0.5–0.95). Sits *on top of* the
   *  hard-coded `MIN_CONFIDENCE = 0.7`. Default 0.7. */
  agiConfidenceThreshold: number;
  // === v2.0-beta.3 settings simplify ===
  /** v2.0-beta.3 — single sensitivity slider 0–100 that replaces the
   *  fine-grained volume + threshold + channel-mute trio in the user-
   *  visible settings UI. The fine-grained fields are kept as the source
   *  of truth (the ambient policy still reads them) and `agiSensitivity`
   *  is the user-friendly knob that derives both. The mapping (set in
   *  `setAgiSensitivity`):
   *    0–30   → silent equivalent (volume=silent, threshold=0.95)
   *    30–60  → quiet  equivalent (volume=quiet,  threshold=0.7)
   *    60–90  → chatty equivalent (volume=chatty, threshold=0.6)
   *    90–100 → alerts only       (volume=quiet,  threshold=0.9)
   *  Default 50 (quiet, default threshold). Persisted; first launch on a
   *  v1.x install computes the initial value from the existing volume +
   *  threshold via `deriveSensitivity` so the user's prior knob position
   *  carries forward. */
  agiSensitivity: number;
  setAgiSensitivity: (n: number) => void;
  // === end v2.0-beta.3 settings simplify ===
  /** v1.9.0-beta.2 P2-C — newcomer onboarding latch.
   *
   *  Flipped to `true` the first time the Rust `newcomer_onboarding`
   *  template fires AND the resulting toast is pushed (or dismissed) on the
   *  frontend. Persisted so the toast never re-fires on a future launch of
   *  the same install — even if the user wipes their memory dir, the latch
   *  prevents the welcome from looping.
   *
   *  Wired to `template_match` listener in `components/layout/AppShell.tsx`:
   *  when a `newcomer_onboarding` match arrives, the listener checks this
   *  flag and silently drops the match if it's already true. Otherwise it
   *  forwards to `pushSuggestion(...)` and flips the flag. */
  newcomerOnboardingShown: boolean;
  /**
   * Wave 4-C — first-run welcome overlay latch.
   *
   * `false` on a fresh install. Flipped to `true` after the user clicks
   * "Get started in 30 seconds" (or "Skip tour") on the WelcomeOverlay.
   * Persisted so the overlay only shows once per install. Independent of
   * `newcomerOnboardingShown` (that one gates the rule-engine toast that
   * the heartbeat fires; this one gates the visual 4-card tour mounted by
   * AppShell).
   */
  welcomed: boolean;
  setWelcomed: (v: boolean) => void;
  /**
   * === wave 6 === BUG #3 — version-aware welcome tour replay.
   *
   * Tracks the app version that was running when the user dismissed the
   * WelcomeOverlay. The AppShell compares this to `__APP_VERSION__` on cold
   * launch — when the user upgrades to a build with new tour content, the
   * overlay re-shows so they catch the changes. Persisted across launches.
   *
   * Empty string on a fresh install (no prior dismissal); a recorded
   * version string ("1.9.2", "1.9.3", ...) once the user has clicked
   * Get-started or Skip-tour at least once.
   */
  lastWelcomedVersion: string;
  setLastWelcomedVersion: (v: string) => void;
  // === wave 5-α ===
  /**
   * Wave 5-α — settings progressive disclosure latch.
   *
   * `false` (default) — Settings page renders only the General / AGI /
   * Personal Agents tabs. The Adapters / Team / Advanced / Language tabs
   * stay hidden behind a "Show advanced settings" link below the tab
   * row.
   *
   * Persisted so the user's choice carries forward across launches —
   * once a power user opens the advanced tabs they don't want to keep
   * re-revealing them every cold launch.
   */
  showAdvancedSettings: boolean;
  setShowAdvancedSettings: (v: boolean) => void;
  // === end wave 5-α ===
  // === wave 10 ===
  /** v1.10 — git auto-sync mode. `unknown` is the fresh-install default; the
   *  GitInitBanner is shown until the user picks `init`, `skip`, or `later`.
   *  `init` = git-tracked + auto-sync engaged. `skip` = "I'm on Cloud,
   *  don't bother me about git" (forward-looking; Cloud isn't shipped yet).
   *  `later` = banner dismissed for this session only; will re-prompt next
   *  cold launch. Persisted (except `later` which is per-session). */
  gitMode: "unknown" | "init" | "skip" | "later";
  setGitMode: (m: "unknown" | "init" | "skip" | "later") => void;
  /** v1.10 — auto-pull interval in minutes. The Rust daemon decides the
   *  actual cadence (foreground 5m / background 15m); this knob lets the
   *  user override the upper bound. Default 15. */
  gitAutoPullIntervalMin: number;
  setGitAutoPullIntervalMin: (n: number) => void;
  /** v1.10 — auto-commit after every successful co-thinker heartbeat.
   *  Default ON. When OFF, the user has to commit by hand. */
  gitAutoCommitOnHeartbeat: boolean;
  setGitAutoCommitOnHeartbeat: (v: boolean) => void;
  /** v1.10 — auto-push after each auto-commit (only when remote configured).
   *  Default ON. */
  gitAutoPushOnCommit: boolean;
  setGitAutoPushOnCommit: (v: boolean) => void;
  // === end wave 10 ===
  // === wave 11 === — v1.10.2 first-run LLM setup wizard slice砍 in v1.16
  // Wave 1 (smart layer砍). All `setupWizard*` fields + setters removed
  // from the type / defaults / persist / merge. W2/W3 reintroduce a fresh
  // capture-only first-run surface.
  // === end wave 11 ===
  // === v1.16 Wave 1 ===
  // 砍: onboardingMode / onboardingChatStarted / onboardingScope (chat
  // primer砍), firstAtomCapturedAt / soloCloudPromptDismissedAt (Solo
  // Cloud砍). W2/W3 reintroduce a fresh onboarding latch surface.
  //
  // 保留: onboardingCompletedAt — W3 will reuse this latch with the
  // simplified hydration logic below. `null` on fresh install, epoch
  // ms once any future onboarding path stamps completion.
  onboardingCompletedAt: number | null;
  setOnboardingCompletedAt: (v: number | null) => void;
  // === end v1.16 Wave 1 ===
  // === wave 22 ===
  /** Wave 22 — first-run guided coachmark tour completion latch.
   *  Flips `true` once the user finishes or skips the 6-step tour.
   *  Persisted so the tour never re-shows on subsequent cold launches.
   *  The FirstRunTour mount in AppShell gates on
   *  `firstRunTourCompleted === false && demoMode === true`. */
  firstRunTourCompleted: boolean;
  /** Wave 22 — per-coachmark dismiss memory. A future tour or ad-hoc
   *  coachmark can be skipped individually without affecting the global
   *  tour completion latch. Set is normalized to an array on persist. */
  coachmarksDismissed: string[];
  /** Wave 22 — TryThisFAB per-card dismiss memory. Once a "Did you know?"
   *  card has been read, it never re-shows. Persisted so the rotation
   *  steers toward unread cards across cold launches. */
  tryThisDismissed: string[];
  setFirstRunTourCompleted: (v: boolean) => void;
  dismissCoachmark: (stepId: string) => void;
  resetCoachmarks: () => void;
  dismissTryThisCard: (cardId: string) => void;
  // === end wave 22 ===
  setAgiParticipation: (v: boolean) => void;
  setAgiVolume: (v: AgiVolume) => void;
  toggleAgiChannelMute: (channel: string) => void;
  rememberDismissed: (surfaceId: string) => void;
  resetDismissedSurfaces: () => void;
  setAgiConfidenceThreshold: (n: number) => void;
  /** v1.9.0-beta.2 — flip the newcomer-onboarding latch. */
  setNewcomerOnboardingShown: (v: boolean) => void;
  /**
   * v3.0 §1 + §5 — per-source personal-agent capture toggles.
   *
   * Mirror of `crate::commands::personal_agents::PersonalAgentSettings`.
   * The Rust side is the source of truth (persisted at
   * `<user_data>/personal_agents.json`); this slice carries the latest
   * known values so the Settings UI doesn't have to round-trip on every
   * keystroke. Default: ALL FALSE — the user must opt in per source
   * before any daemon-hook capture runs (spec §5.1).
   *
   * Wave 2 (v3.0 §1.7-§1.11) extends this map with `devin`, `replit`,
   * `apple_intelligence`, `ms_copilot`. Each defaults `false` and ships
   * in stub mode on the Rust side until a customer with a real
   * token/license flips a single feature flag.
   */
  personalAgentsEnabled: {
    cursor: boolean;
    claude_code: boolean;
    codex: boolean;
    windsurf: boolean;
    // === v3.0 wave 2 personal agents ===
    devin: boolean;
    replit: boolean;
    apple_intelligence: boolean;
    ms_copilot: boolean;
    // === end v3.0 wave 2 personal agents ===
  };
  /** v3.0 — replace the whole personal-agents enable map (used after
   *  a successful `personal_agents_get_settings` round-trip). */
  setPersonalAgentsEnabled: (
    next: {
      cursor: boolean;
      claude_code: boolean;
      codex: boolean;
      windsurf: boolean;
      // === v3.0 wave 2 personal agents ===
      devin: boolean;
      replit: boolean;
      apple_intelligence: boolean;
      ms_copilot: boolean;
      // === end v3.0 wave 2 personal agents ===
    },
  ) => void;
  /** v3.0 — flip a single agent toggle in the in-memory mirror. The
   *  caller is expected to also persist via `personal_agents_set_watcher`. */
  togglePersonalAgent: (
    agent:
      | "cursor"
      | "claude_code"
      | "codex"
      | "windsurf"
      // === v3.0 wave 2 personal agents ===
      | "devin"
      | "replit"
      | "apple_intelligence"
      | "ms_copilot",
    // === end v3.0 wave 2 personal agents ===
    enabled: boolean,
  ) => void;
  // === v3.5 marketplace ===
  /** v3.5 §2 — public marketplace launch state. Mirror of the Rust-side
   *  `LaunchState.launched` flag. Frontend uses this to render the
   *  "Coming live when CEO triggers launch gate" banner on /marketplace.
   *  Default `false`; the marketplace route refreshes this on mount. */
  marketplaceLaunched: boolean;
  setMarketplaceLaunched: (v: boolean) => void;
  // === end v3.5 marketplace ===
  // === v3.5 branding ===
  /** v3.5 §4 — current enterprise white-label branding override. Mirror of
   *  `crate::branding::BrandingConfig`. Default = Tangerine baseline.
   *  AppShell hydrates this from `brandingGetConfig` at boot; per-tenant
   *  enterprise tenants overlay logo / palette / domain / app name. */
  brandingConfig: {
    logo_url: string;
    primary_color: string;
    accent_color: string;
    custom_domain: string;
    app_name: string;
  };
  setBrandingConfig: (cfg: {
    logo_url: string;
    primary_color: string;
    accent_color: string;
    custom_domain: string;
    app_name: string;
  }) => void;
  // === end v3.5 branding ===
  toasts: ToastEntry[];
  // ---- v1.9.0-beta.1 — banner + modal queues ----
  /** Active banner queue. The host renders the highest-priority entry; the
   *  rest stay queued until that one is dismissed or its condition resolves.
   *  Max 1 visible at a time per route is enforced in `<BannerHost/>`. */
  bannerStack: BannerProps[];
  /** Modal FIFO queue. Max 1 visible at a time. The bus enforces the
   *  ≤1-modal-per-session budget via `modalsShownThisSession`. */
  modalQueue: ModalProps[];
  /** Session counter — incremented every time a modal is *enqueued* (not
   *  when it's confirmed/cancelled). Reset on app launch. The bus reads
   *  this to demote a second modal to a banner per spec §3.4. */
  modalsShownThisSession: number;
  /**
   * v1.9.0-beta.3 P3-B — per-source first-writeback confirm latch.
   *
   * Each source page (slack / github / linear / calendar) gates its
   * "post on the user's behalf" toggle behind a one-time modal. Once the
   * user clicks "Allow", the source name is added here and subsequent
   * toggles in the same session bypass the modal. NOT persisted — every
   * cold launch re-confirms (per spec §3.4 modals are session-scoped).
   *
   * Stored as a `Set<string>` so membership tests are O(1). The reducers
   * always return a *new* Set so zustand's strict-equality check still
   * fires re-renders.
   */
  firstWritebackConfirmedThisSession: Set<string>;
  /** Mark a writeback source as confirmed for this session — skips modal
   *  on subsequent toggles. */
  markWritebackConfirmed: (source: string) => void;
  /** Clear the latch so the next enable triggers the modal again. Used
   *  for "disable + re-enable" cycles where the user may want to re-read
   *  the policy disclosure. */
  unmarkWritebackConfirmed: (source: string) => void;
  pushBanner: (b: BannerProps) => void;
  dismissBanner: (id: string) => void;
  pushModal: (m: ModalProps) => void;
  dismissModal: (id: string) => void;
  /**
   * v1.9.0 P4-A — replace a suggestion's body in place after Stage 2
   * LLM enrichment. Searches `bannerStack` / `modalQueue` / `toasts`
   * for an entry whose `match_id` equals the supplied id and updates
   * `body` (or the equivalent text field — `msg` for toasts) without
   * popping/re-pushing.
   *
   * Also flips `enriched: true` so the renderer can play a 200ms
   * ti-pulse animation as a "got smarter" cue. The flag clears the
   * next time the entry is touched (re-render path) so a stale
   * pulse doesn't replay.
   *
   * If no entry matches the id (e.g. user dismissed in the gap
   * between rule emit and enrichment), this is a silent no-op.
   */
  updateSuggestion: (matchId: string, newBody: string) => void;
  setTheme: (t: ThemeMode) => void;
  cycleTheme: () => void;
  setMemoryRoot: (path: string) => void;
  toggleSidebar: () => void;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
  setLocalOnly: (v: boolean) => void;
  setSamplesSeeded: (v: boolean) => void;
  /** v1.13.10 round-10: optional `path` arg dismisses just that file.
   *  No-arg call kept for backward compat — flips the legacy global. */
  dismissSampleBanner: (path?: string) => void;
  // === wave 13 ===
  /** Wave 13 — flip the populated-app demo flag. True = banner shown,
   *  false = user explicitly dismissed (or replaced sample data with real). */
  setDemoMode: (v: boolean) => void;
  /** Wave 13 — record that the demo seed install has been attempted on
   *  this install (independent of success). Persisted. */
  setDemoSeedAttempted: (v: boolean) => void;
  // === end wave 13 ===
  // === wave 1.15 W2.1 === — `setDemoTourCompleted` setter砍 in v1.16
  // Wave 1 (DemoTourOverlay deleted). The persisted `demoTourCompleted`
  // boolean was already砍 from defaults / persist / merge.
  // === end wave 1.15 W2.1 ===
  setMemoryConfig: (patch: Partial<MemoryConfig>) => void;
  resetMemoryConfig: () => void;
  setCurrentUser: (u: string) => void;
  dismissAtom: (atomId: string) => void;
  // === wave 16 ===
  /** Wave 16 — set the right-rail ACTIVITY filter selection. */
  setActivityFeedFilter: (f: "all" | "me" | "team") => void;
  // === end wave 16 ===
  snoozeAtom: (atomId: string, untilMs: number) => void;
  resetDismissals: () => void;
  setWhatsNewDismissed: (v: boolean) => void;
  // === v1.14.6 round-7 ===
  setLastSeenAppVersion: (v: string | null) => void;
  // === end v1.14.6 round-7 ===
  setPrimaryAITool: (id: string | null) => void;
  /** v1.9.0-beta.1 — extended pushToast.
   *
   * Two call shapes are supported:
   *   - `pushToast("info", "hello")`         → legacy v1.8 system toast
   *   - `pushToast({ kind, msg, ... })`      → v1.9 rich toast (suggestion
   *                                            tier, with optional CTA +
   *                                            duration override)
   * The legacy 2-arg form is kept so existing call sites (∼12 of them)
   * keep compiling without churn. */
  pushToast: PushToastFn;
  dismissToast: (id: string) => void;

  // === v2.5 auth + billing ===
  // v2.5 §2 + §3 — auth mode + billing snapshot. `authMode === "stub"` is the
  // default (sibling auth.ts continues to work); flips to "real" once a real
  // Supabase session is bound. `billingStatus` carries the latest known
  // subscription status from `billing_status` polls; the AppShell trial-gate
  // effect re-reads it every hour. `trialExpiry` is a UNIX-seconds timestamp
  // (0 when no trial). The setters below are the only writers — components
  // never mutate these directly.
  authMode: "stub" | "real";
  billingStatus: "trialing" | "active" | "past_due" | "canceled" | "none";
  trialExpiry: number;
  setAuthMode: (m: "stub" | "real") => void;
  setBillingSnapshot: (
    snapshot: {
      status: "trialing" | "active" | "past_due" | "canceled" | "none";
      trialExpiry: number;
    },
  ) => void;
  // === end v2.5 auth + billing ===

  // === v2.5 cloud_sync ===
  /** v2.5 §5 — managed cloud sync config (stub mode). Persisted via Tauri
   *  command `cloud_sync_set_config`; this slice is the in-memory mirror so
   *  the Settings page doesn't round-trip on every keystroke. Real network
   *  transport is deferred to v2.5 production. */
  cloudSyncConfig: {
    enabled: boolean;
    repo_url: string;
    branch: string;
    sync_interval_min: number;
  };
  setCloudSyncConfig: (next: {
    enabled: boolean;
    repo_url: string;
    branch: string;
    sync_interval_min: number;
  }) => void;
  // === end v2.5 cloud_sync ===
}

/** Every toast in `ui.toasts`. `kind === "suggestion"` denotes a v1.9
 *  AGI-sourced toast; the AppShell renderer decorates it with a 🍊 dot
 *  and surfaces the optional CTA. The legacy `text` field is kept as an
 *  alias for `msg` so v1.8 code reading `t.text` keeps compiling. */
export interface ToastEntry {
  id: string;
  kind: "info" | "success" | "error" | "suggestion";
  msg: string;
  /** Legacy alias for msg — kept so `t.text` callers don't break. */
  text: string;
  // suggestion-only fields (undefined for system toasts):
  template?: string;
  ctaLabel?: string;
  ctaHref?: string;
  onAccept?: () => void;
  /** Auto-dismiss after this many ms. Default 4000 for suggestion toasts;
   *  undefined → never auto-dismiss (system errors stay until clicked). */
  durationMs?: number;
  /** v1.9.0 P4-A — Rust-side `TemplateMatch.match_id`. Stamped on
   *  rule-emit so the Stage 2 enrichment pass can find this entry by
   *  id and replace `msg`/`text` in place via `updateSuggestion`.
   *  Undefined for system toasts (never enriched). */
  match_id?: string;
  /** v1.9.0 P4-A — set briefly to `true` after `updateSuggestion`
   *  swaps the body, so the renderer can play a 200ms ti-pulse to
   *  signal "enriched". Cleared by the renderer's effect on a timer. */
  enriched?: boolean;
}

/** Rich toast input. Either form is accepted. */
export type PushToastInput =
  | {
      kind: "info" | "success" | "error" | "suggestion";
      msg: string;
      template?: string;
      ctaLabel?: string;
      ctaHref?: string;
      onAccept?: () => void;
      durationMs?: number;
      /** v1.9.0 P4-A — match_id from the Rust side, plumbed end-to-end
       *  through the bus → toast surface. Used by `updateSuggestion`. */
      match_id?: string;
    };

export type PushToastFn = {
  (kind: "info" | "success" | "error", text: string): void;
  (input: PushToastInput): void;
};

interface WizardSlice {
  step: WizardStep;
  collected: WizardData;
  setStep: (s: WizardStep) => void;
  next: () => void;
  back: () => void;
  setField: <K extends keyof WizardData>(key: K, value: WizardData[K]) => void;
  reset: () => void;
}

interface ConfigSlice {
  yaml: string | null;
  loaded: boolean;
  setYaml: (yaml: string | null) => void;
  markLoaded: () => void;
}

interface SkillsSlice {
  /** Per-source config. Only `meetingConfig` (Discord source) is meaningful. */
  meetingConfig: MeetingConfig;
  setMeetingConfig: (patch: Partial<MeetingConfig>) => void;
  resetMeetingConfig: () => void;
}

interface Store {
  ui: UiSlice;
  wizard: WizardSlice;
  config: ConfigSlice;
  skills: SkillsSlice;
}

// ---------- helpers ----------

/** Discord source is "configured" when every required field is filled. */
export function isMeetingConfigured(m: MeetingConfig): boolean {
  const teamOk = !!m.team && m.team.length > 0 && m.team.every((t) => t.alias && t.displayName);
  const transcriptionOk =
    m.whisperMode === "local" ||
    (m.whisperMode === "openai" && !!m.whisperKey);
  return !!m.discordToken && !!m.guildId && transcriptionOk && !!m.claudeCliPath && teamOk;
}

// === v2.0-beta.3 settings simplify ===
/**
 * Map the 0–100 sensitivity slider to the underlying volume band +
 * confidence threshold pair that the ambient policy already understands.
 * Exported so tests + the AGISettings UI's preview line stay in lockstep.
 *
 * Bucket layout (per V2_0_SPEC §4 / build prompt):
 *   0–30   → silent equivalent (volume=silent, threshold=0.95)
 *   30–60  → quiet  equivalent (volume=quiet,  threshold=0.7) — default
 *   60–90  → chatty equivalent (volume=chatty, threshold=0.6)
 *   90–100 → alerts only       (volume=quiet,  threshold=0.9) — only the
 *            very-high-confidence reactions reach the user, even though
 *            the volume itself is the moderate band.
 *
 * The boundary values land in the *upper* bucket on the seam (30 → quiet,
 * 60 → chatty, 90 → alerts) so the slider's snap-points feel intuitive.
 */
export function sensitivityToVolumeThreshold(n: number): {
  volume: AgiVolume;
  threshold: number;
} {
  const clamped = Math.max(0, Math.min(100, n));
  if (clamped < 30) return { volume: "silent", threshold: 0.95 };
  if (clamped < 60) return { volume: "quiet", threshold: 0.7 };
  if (clamped < 90) return { volume: "chatty", threshold: 0.6 };
  return { volume: "quiet", threshold: 0.9 };
}

/**
 * Reverse-map a (volume, threshold) pair back into a sensitivity score
 * for users migrating from v1.x where the two were separate knobs. Picks
 * the canonical centre of each bucket so a flip-flop on the slider
 * doesn't shift the underlying state. silent → 15, quiet → 45 (default
 * band centre), chatty → 75, "alerts only" (quiet + ≥0.85 threshold) →
 * 95.
 */
export function deriveSensitivity(
  volume: AgiVolume,
  threshold: number,
): number {
  if (volume === "silent") return 15;
  if (volume === "chatty") return 75;
  // volume === "quiet" — split on the threshold to detect "alerts only".
  if (threshold >= 0.85) return 95;
  return 45;
}
// === end v2.0-beta.3 settings simplify ===

function osPrefersDark(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolveTheme(t: ThemeMode): "light" | "dark" {
  if (t === "system") return osPrefersDark() ? "dark" : "light";
  return t;
}

function applyTheme(t: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = t;
  if (t === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

// ---------- store ----------

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ui: {
        theme: "system",
        resolvedTheme: resolveTheme("system"),
        memoryRoot: defaultMemoryRoot(),
        sidebarCollapsed: false,
        // === wave 8 === — see slice doc above for default rationale.
        // === wave 14 === — sidebar default is now Brain expanded,
        // Sources + AI tools collapsed (count chips visible), Advanced
        // hidden behind "Show advanced" toggle. Active Agents stays
        // false until real captures land.
        sidebarSections: {
          brain: true,
          sources: false,
          aiTools: false,
          advanced: false,
          activeAgents: false,
        },
        toggleSidebarSection: (key) =>
          set((s) => ({
            ui: {
              ...s.ui,
              sidebarSections: {
                ...s.ui.sidebarSections,
                [key]: !s.ui.sidebarSections[key],
              },
            },
          })),
        paletteOpen: false,
        localOnly: false,
        samplesSeeded: false,
        sampleBannerDismissed: false,
        // === v1.13.10 round-10 ===
        sampleBannerDismissedPaths: [],
        // === end v1.13.10 round-10 ===
        // === wave 13 ===
        // Wave 13 — populated-app demo flag. Defaults false so an existing
        // install without the migration doesn't suddenly show the banner.
        // The AppShell first-launch effect flips this true after a
        // successful `demo_seed_install` on a truly-fresh memory root.
        demoMode: false,
        demoSeedAttempted: false,
        // === end wave 13 ===
        // === v1.16 Wave 1 === — demoTourCompleted砍.
        // v2.0-alpha.1 — personalDirEnabled defaults to true on first launch.
        // The setMemoryConfig patch flow lets the user flip it from the
        // settings UI without disturbing repo / mode / invite fields.
        memoryConfig: { personalDirEnabled: true },
        currentUser: "me",
        dismissedAtoms: [],
        // === wave 16 ===
        // Default = "all" so first-launch users see every captured atom.
        activityFeedFilter: "all",
        // === end wave 16 ===
        // === wave 23 ===
        // Default = "tree" so first-launch matches the Wave 21 layout users
        // already know. Toggling to "graph" / "list" persists.
        memoryViewMode: "tree",
        // === end wave 23 ===
        snoozedAtoms: {},
        whatsNewDismissed: false,
        // === v1.14.6 round-7 ===
        lastSeenAppVersion: null,
        // === end v1.14.6 round-7 ===
        primaryAITool: null,
        agiParticipation: true,
        agiVolume: "quiet",
        mutedAgiChannels: [],
        dismissedSurfaces: [],
        agiConfidenceThreshold: 0.7,
        // v2.0-beta.3 — single sensitivity slider. Default 50 = quiet +
        // 0.7 floor. The mapping is applied on every write via
        // `setAgiSensitivity` so the legacy fields stay in sync.
        agiSensitivity: 50,
        // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
        // Persisted; flips to true after the first emit so the toast
        // never re-fires on subsequent heartbeats / launches.
        newcomerOnboardingShown: false,
        // Wave 4-C — first-run welcome overlay latch. Persisted; flips
        // once the user clicks "Get started" or "Skip tour" so the
        // overlay never re-mounts on a future launch.
        welcomed: false,
        // === wave 6 === BUG #3 — last app version for which the user
        // dismissed the welcome tour. Empty string on first install.
        lastWelcomedVersion: "",
        // === wave 5-α ===
        // Settings progressive disclosure. False by default so first-time
        // users see only General / AGI / Personal Agents. Persisted so
        // returning power users don't have to re-reveal the advanced
        // tabs on every launch.
        showAdvancedSettings: false,
        // === end wave 5-α ===
        // === wave 10 === — v1.10 git auto-sync defaults.
        gitMode: "unknown",
        gitAutoPullIntervalMin: 15,
        gitAutoCommitOnHeartbeat: true,
        gitAutoPushOnCommit: true,
        // === end wave 10 ===
        // === wave 11 === — setup-wizard defaults砍 (smart layer砍 v1.16 W1).
        // === v1.16 Wave 1 === — onboardingMode / onboardingChatStarted /
        // onboardingScope / firstAtomCapturedAt / soloCloudPromptDismissedAt
        // 砍. onboardingCompletedAt 保留 (W3 重做用).
        onboardingCompletedAt: null,
        // === end v1.16 Wave 1 ===
        // === wave 22 ===
        // Wave 22 — first-run guided tour + TryThisFAB dismiss memory.
        // All three default to "fresh install" values. The FirstRunTour
        // self-mounts only when `firstRunTourCompleted === false` AND
        // `demoMode === true` (sample data present), so users with real
        // memory dirs never see the tour, and the AppShell never bothers
        // to render the wrapper for returning users.
        firstRunTourCompleted: false,
        coachmarksDismissed: [],
        tryThisDismissed: [],
        // === end wave 22 ===
        // v3.0 §1 + §5 — personal-agent capture flags. ALL FALSE by default
        // — opt-in per source. Hydrated from `personal_agents_get_settings`
        // on Settings page mount; the flag map mirrors the Rust persisted
        // file so reducers don't have to round-trip on every keystroke.
        // Wave 2 (v3.0 §1.7-§1.11) added devin/replit/apple_intelligence/
        // ms_copilot — each ships in stub mode on the Rust side and stays
        // off until the user explicitly opts in.
        personalAgentsEnabled: {
          cursor: false,
          claude_code: false,
          codex: false,
          windsurf: false,
          // === v3.0 wave 2 personal agents ===
          devin: false,
          replit: false,
          apple_intelligence: false,
          ms_copilot: false,
          // === end v3.0 wave 2 personal agents ===
        },
        // === v3.5 marketplace ===
        marketplaceLaunched: false,
        // === end v3.5 marketplace ===
        // === v3.5 branding ===
        brandingConfig: {
          logo_url: "",
          primary_color: "#CC5500",
          accent_color: "#1A1A2E",
          custom_domain: "",
          app_name: "Tangerine",
        },
        // === end v3.5 branding ===
        toasts: [],
        // v1.9.0-beta.1 — banner + modal queues. Not persisted — these
        // are session-scoped UI state. Counters reset on every cold launch.
        bannerStack: [],
        modalQueue: [],
        modalsShownThisSession: 0,
        // v1.9.0-beta.3 P3-B — per-source first-writeback confirm latch.
        // Always a fresh Set on cold launch so the user re-confirms once
        // per app launch per spec §3.4.
        firstWritebackConfirmedThisSession: new Set<string>(),
        // v2.5 §2 + §3 — auth mode + billing snapshot (defaults match
        // backend stub-mode shape so the UI never reads `undefined`).
        authMode: "stub",
        billingStatus: "none",
        trialExpiry: 0,
        setAuthMode: (m) => set((s) => ({ ui: { ...s.ui, authMode: m } })),
        setBillingSnapshot: (snapshot) =>
          set((s) => ({
            ui: {
              ...s.ui,
              billingStatus: snapshot.status,
              trialExpiry: snapshot.trialExpiry,
            },
          })),
        // v2.5 §5 — managed cloud sync stub. Defaults match the Rust
        // `CloudSyncConfig::default()` shape so first paint is consistent
        // even before the get_config round-trip completes.
        cloudSyncConfig: {
          enabled: false,
          repo_url: "",
          branch: "main",
          sync_interval_min: 5,
        },
        setCloudSyncConfig: (next) =>
          set((s) => ({ ui: { ...s.ui, cloudSyncConfig: next } })),
        setTheme: (t) => {
          const resolved = resolveTheme(t);
          set((s) => ({ ui: { ...s.ui, theme: t, resolvedTheme: resolved } }));
          applyTheme(resolved);
        },
        cycleTheme: () => {
          const cur = get().ui.theme;
          const next: ThemeMode =
            cur === "system" ? "light" : cur === "light" ? "dark" : "system";
          get().ui.setTheme(next);
        },
        setMemoryRoot: (path) =>
          set((s) => ({ ui: { ...s.ui, memoryRoot: path } })),
        // === wave 11 === — setup-wizard setters砍 (smart layer砍 v1.16 W1).
        // === v1.16 Wave 1 === — first-launch latch setter (only).
        // Callers: SetupWizard "Done" / "Skip" / Demo "Try with sample
        // data" CTA. W2/W3 will rewire callers when the new onboarding
        // surface ships.
        setOnboardingCompletedAt: (v) =>
          set((s) => ({ ui: { ...s.ui, onboardingCompletedAt: v } })),
        // === end v1.16 Wave 1 ===
        // === wave 22 ===
        // Wave 22 — coachmark + tour + try-this reducers. Each one is a
        // pure idempotent set so re-firing the same dismiss is a no-op
        // (telemetry can spam the call without churning the state).
        setFirstRunTourCompleted: (v) =>
          set((s) => ({ ui: { ...s.ui, firstRunTourCompleted: v } })),
        dismissCoachmark: (stepId) =>
          set((s) => ({
            ui: {
              ...s.ui,
              coachmarksDismissed: s.ui.coachmarksDismissed.includes(stepId)
                ? s.ui.coachmarksDismissed
                : [...s.ui.coachmarksDismissed, stepId],
            },
          })),
        resetCoachmarks: () =>
          set((s) => ({
            ui: {
              ...s.ui,
              coachmarksDismissed: [],
              firstRunTourCompleted: false,
            },
          })),
        dismissTryThisCard: (cardId) =>
          set((s) => ({
            ui: {
              ...s.ui,
              tryThisDismissed: s.ui.tryThisDismissed.includes(cardId)
                ? s.ui.tryThisDismissed
                : [...s.ui.tryThisDismissed, cardId],
            },
          })),
        // === end wave 22 ===
        toggleSidebar: () =>
          set((s) => ({ ui: { ...s.ui, sidebarCollapsed: !s.ui.sidebarCollapsed } })),
        setPalette: (open) =>
          set((s) => ({ ui: { ...s.ui, paletteOpen: open } })),
        togglePalette: () =>
          set((s) => ({ ui: { ...s.ui, paletteOpen: !s.ui.paletteOpen } })),
        setLocalOnly: (v) =>
          set((s) => ({ ui: { ...s.ui, localOnly: v } })),
        setSamplesSeeded: (v) =>
          set((s) => ({ ui: { ...s.ui, samplesSeeded: v } })),
        // === v1.13.10 round-10 ===
        // Per-file dismiss when `path` is passed; legacy global flip when
        // not. The MarkdownView always passes a path now; the no-arg form
        // is preserved for any external caller that hasn't been updated.
        dismissSampleBanner: (path?: string) =>
          set((s) => {
            if (path) {
              if (s.ui.sampleBannerDismissedPaths.includes(path)) {
                return s;
              }
              return {
                ui: {
                  ...s.ui,
                  sampleBannerDismissedPaths: [
                    ...s.ui.sampleBannerDismissedPaths,
                    path,
                  ],
                },
              };
            }
            return { ui: { ...s.ui, sampleBannerDismissed: true } };
          }),
        // === end v1.13.10 round-10 ===
        // === wave 13 ===
        setDemoMode: (v) =>
          set((s) => ({ ui: { ...s.ui, demoMode: v } })),
        setDemoSeedAttempted: (v) =>
          set((s) => ({ ui: { ...s.ui, demoSeedAttempted: v } })),
        // === end wave 13 ===
        // === v1.16 Wave 1 === — setDemoTourCompleted砍.
        setMemoryConfig: (patch) =>
          set((s) => ({
            ui: {
              ...s.ui,
              memoryConfig: { ...s.ui.memoryConfig, ...patch },
            },
          })),
        resetMemoryConfig: () =>
          set((s) => ({ ui: { ...s.ui, memoryConfig: {} } })),
        setCurrentUser: (u) =>
          set((s) => ({ ui: { ...s.ui, currentUser: u } })),
        dismissAtom: (atomId) =>
          set((s) => ({
            ui: {
              ...s.ui,
              dismissedAtoms: s.ui.dismissedAtoms.includes(atomId)
                ? s.ui.dismissedAtoms
                : [...s.ui.dismissedAtoms, atomId],
            },
          })),
        // === wave 16 ===
        setActivityFeedFilter: (f) =>
          set((s) => ({ ui: { ...s.ui, activityFeedFilter: f } })),
        // === end wave 16 ===
        // === wave 23 ===
        setMemoryViewMode: (m) =>
          set((s) => ({ ui: { ...s.ui, memoryViewMode: m } })),
        // === end wave 23 ===
        snoozeAtom: (atomId, untilMs) =>
          set((s) => ({
            ui: {
              ...s.ui,
              snoozedAtoms: { ...s.ui.snoozedAtoms, [atomId]: untilMs },
            },
          })),
        resetDismissals: () =>
          set((s) => ({
            ui: { ...s.ui, dismissedAtoms: [], snoozedAtoms: {} },
          })),
        setWhatsNewDismissed: (v) =>
          set((s) => ({ ui: { ...s.ui, whatsNewDismissed: v } })),
        // === v1.14.6 round-7 ===
        setLastSeenAppVersion: (v) =>
          set((s) => ({ ui: { ...s.ui, lastSeenAppVersion: v } })),
        // === end v1.14.6 round-7 ===
        setPrimaryAITool: (id) =>
          set((s) => ({ ui: { ...s.ui, primaryAITool: id } })),
        // ---- v1.8 Phase 4 ambient input layer ----
        setAgiParticipation: (v) =>
          set((s) => ({ ui: { ...s.ui, agiParticipation: v } })),
        setAgiVolume: (v) =>
          set((s) => ({ ui: { ...s.ui, agiVolume: v } })),
        toggleAgiChannelMute: (channel) =>
          set((s) => ({
            ui: {
              ...s.ui,
              mutedAgiChannels: s.ui.mutedAgiChannels.includes(channel)
                ? s.ui.mutedAgiChannels.filter((c) => c !== channel)
                : [...s.ui.mutedAgiChannels, channel],
            },
          })),
        rememberDismissed: (surfaceId) =>
          set((s) => {
            // Prune stale + add the new entry. Replace if surface already
            // exists so the 24h window restarts on every dismiss.
            const now = Date.now();
            const next = pruneDismissed(s.ui.dismissedSurfaces, now).filter(
              (e) => e.surfaceId !== surfaceId,
            );
            next.push({ surfaceId, dismissedAt: now });
            return { ui: { ...s.ui, dismissedSurfaces: next } };
          }),
        resetDismissedSurfaces: () =>
          set((s) => ({ ui: { ...s.ui, dismissedSurfaces: [] } })),
        setAgiConfidenceThreshold: (n) =>
          set((s) => ({
            ui: {
              ...s.ui,
              // Clamp to the documented slider range so a malformed
              // persisted value can't bypass the hard floor.
              agiConfidenceThreshold: Math.max(0.5, Math.min(0.95, n)),
            },
          })),
        // === v2.0-beta.3 settings simplify ===
        // Single sensitivity slider 0–100. Writes propagate to the legacy
        // volume + threshold fields so the ambient policy keeps working
        // unchanged — the simplified UI is purely a user-facing collapse.
        setAgiSensitivity: (n) =>
          set((s) => {
            const clamped = Math.max(0, Math.min(100, Math.round(n)));
            const { volume, threshold } = sensitivityToVolumeThreshold(clamped);
            return {
              ui: {
                ...s.ui,
                agiSensitivity: clamped,
                agiVolume: volume,
                agiConfidenceThreshold: threshold,
              },
            };
          }),
        // === end v2.0-beta.3 settings simplify ===
        // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
        setNewcomerOnboardingShown: (v) =>
          set((s) => ({ ui: { ...s.ui, newcomerOnboardingShown: v } })),
        // Wave 4-C — welcome overlay latch.
        setWelcomed: (v) =>
          set((s) => ({ ui: { ...s.ui, welcomed: v } })),
        // === wave 6 === BUG #3 — record the version at dismissal time.
        setLastWelcomedVersion: (v) =>
          set((s) => ({ ui: { ...s.ui, lastWelcomedVersion: v } })),
        // === wave 5-α ===
        setShowAdvancedSettings: (v) =>
          set((s) => ({ ui: { ...s.ui, showAdvancedSettings: v } })),
        // === end wave 5-α ===
        // === wave 10 === — v1.10 git auto-sync setters.
        setGitMode: (m) => set((s) => ({ ui: { ...s.ui, gitMode: m } })),
        setGitAutoPullIntervalMin: (n) =>
          set((s) => ({
            ui: {
              ...s.ui,
              // Clamp to a sane band — anything below 1 min would hammer the
              // remote, anything above 60 min loses the "auto" point.
              gitAutoPullIntervalMin: Math.max(1, Math.min(60, Math.round(n))),
            },
          })),
        setGitAutoCommitOnHeartbeat: (v) =>
          set((s) => ({ ui: { ...s.ui, gitAutoCommitOnHeartbeat: v } })),
        setGitAutoPushOnCommit: (v) =>
          set((s) => ({ ui: { ...s.ui, gitAutoPushOnCommit: v } })),
        // === end wave 10 ===
        // v3.0 §1 — personal-agent capture flag mirror.
        setPersonalAgentsEnabled: (next) =>
          set((s) => ({
            ui: { ...s.ui, personalAgentsEnabled: { ...next } },
          })),
        togglePersonalAgent: (agent, enabled) =>
          set((s) => ({
            ui: {
              ...s.ui,
              personalAgentsEnabled: {
                ...s.ui.personalAgentsEnabled,
                [agent]: enabled,
              },
            },
          })),
        // === v3.5 marketplace ===
        setMarketplaceLaunched: (v) =>
          set((s) => ({ ui: { ...s.ui, marketplaceLaunched: v } })),
        // === end v3.5 marketplace ===
        // === v3.5 branding ===
        setBrandingConfig: (cfg) =>
          set((s) => ({ ui: { ...s.ui, brandingConfig: { ...cfg } } })),
        // === end v3.5 branding ===
        pushToast: ((
          kindOrInput: "info" | "success" | "error" | PushToastInput,
          text?: string,
        ) => {
          // Legacy v1.8 2-arg form: ("info", "hello")
          if (typeof kindOrInput === "string") {
            const kind = kindOrInput;
            const msg = text ?? "";
            set((s) => ({
              ui: {
                ...s.ui,
                toasts: [
                  ...s.ui.toasts,
                  {
                    id: cryptoRandomId(),
                    kind,
                    msg,
                    text: msg,
                  } satisfies ToastEntry,
                ],
              },
            }));
            return;
          }
          // v1.9 rich form: ({ kind, msg, template?, ctaLabel?, ... })
          const input = kindOrInput;
          const id = cryptoRandomId();
          // Default duration: 4s for suggestions, undefined (sticky) for
          // errors, 4s for info/success. Errors should NOT auto-dismiss.
          const defaultDuration =
            input.kind === "error" ? undefined : 4000;
          set((s) => ({
            ui: {
              ...s.ui,
              toasts: [
                ...s.ui.toasts,
                {
                  id,
                  kind: input.kind,
                  msg: input.msg,
                  text: input.msg,
                  template: input.template,
                  ctaLabel: input.ctaLabel,
                  ctaHref: input.ctaHref,
                  onAccept: input.onAccept,
                  durationMs: input.durationMs ?? defaultDuration,
                  // v1.9.0 P4-A — plumb match_id end-to-end so
                  // `updateSuggestion` can find this toast on
                  // enrichment.
                  match_id: input.match_id,
                } satisfies ToastEntry,
              ],
            },
          }));
        }) as PushToastFn,
        dismissToast: (id) =>
          set((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
        // ---- v1.9.0-beta.1 banner queue ----
        pushBanner: (b) =>
          set((s) => {
            // De-dupe by id — re-pushing the same banner refreshes its
            // entry (callers can update `body` / `priority` over time).
            const filtered = s.ui.bannerStack.filter((x) => x.id !== b.id);
            return {
              ui: {
                ...s.ui,
                bannerStack: [...filtered, b],
              },
            };
          }),
        dismissBanner: (id) =>
          set((s) => ({
            ui: {
              ...s.ui,
              bannerStack: s.ui.bannerStack.filter((b) => b.id !== id),
            },
          })),
        // ---- v1.9.0-beta.1 modal queue (FIFO, ≤ 1 visible) ----
        // v1.9.0-beta.3 P3-B — hard ceiling at 3 modals/session. The bus
        // already demotes the *second* modal of a session to a banner
        // (§3.4 budget = 1), so a 4th push only happens if a caller
        // bypasses the bus (direct `pushModal(...)` from a click handler).
        // Drop + log telemetry so we see if any flow is hammering the
        // user with confirms.
        pushModal: (m) =>
          set((s) => {
            if (s.ui.modalsShownThisSession >= 3) {
              // Fire-and-forget — telemetry must never block the render
              // path. Lazy-import logEvent so the store stays decoupled
              // from the telemetry module's tauri dependency at hydrate
              // time (vitest jsdom has no tauri bridge).
              void (async () => {
                try {
                  const { logEvent } = await import("./telemetry");
                  void logEvent("modal_budget_exceeded", { dropped: m.id });
                } catch {
                  // No telemetry available — silent drop is correct.
                }
              })();
              return s;
            }
            const filtered = s.ui.modalQueue.filter((x) => x.id !== m.id);
            return {
              ui: {
                ...s.ui,
                modalQueue: [...filtered, m],
                modalsShownThisSession: s.ui.modalsShownThisSession + 1,
              },
            };
          }),
        dismissModal: (id) =>
          set((s) => ({
            ui: {
              ...s.ui,
              modalQueue: s.ui.modalQueue.filter((m) => m.id !== id),
            },
          })),
        // ---- v1.9.0 P4-A — Stage 2 enrichment body swap ----
        // The frontend listener for `template_match_enriched` calls
        // this with the rule emit's `match_id`. We walk all three
        // suggestion surfaces and update the first entry whose
        // `match_id` matches. Returning state unchanged (when nothing
        // matches) is the silent-skip contract — the user may have
        // already dismissed, in which case the late enrichment is
        // moot.
        updateSuggestion: (matchId, newBody) =>
          set((s) => {
            const banners = s.ui.bannerStack;
            const modals = s.ui.modalQueue;
            const toasts = s.ui.toasts;

            const bannerIdx = banners.findIndex(
              (b) => b.match_id === matchId,
            );
            if (bannerIdx >= 0) {
              const next = banners.slice();
              next[bannerIdx] = {
                ...next[bannerIdx],
                body: newBody,
                enriched: true,
              };
              return { ui: { ...s.ui, bannerStack: next } };
            }

            const modalIdx = modals.findIndex(
              (m) => m.match_id === matchId,
            );
            if (modalIdx >= 0) {
              const next = modals.slice();
              next[modalIdx] = {
                ...next[modalIdx],
                body: newBody,
                enriched: true,
              };
              return { ui: { ...s.ui, modalQueue: next } };
            }

            const toastIdx = toasts.findIndex(
              (t) => t.match_id === matchId,
            );
            if (toastIdx >= 0) {
              const next = toasts.slice();
              const t = next[toastIdx];
              next[toastIdx] = {
                ...t,
                msg: newBody,
                text: newBody,
                enriched: true,
              };
              return { ui: { ...s.ui, toasts: next } };
            }

            // No match — silent no-op. Documented above.
            return s;
          }),
        // ---- v1.9.0-beta.3 P3-B writeback confirm latch ----
        markWritebackConfirmed: (source) =>
          set((s) => {
            const next = new Set(s.ui.firstWritebackConfirmedThisSession);
            next.add(source);
            return {
              ui: { ...s.ui, firstWritebackConfirmedThisSession: next },
            };
          }),
        unmarkWritebackConfirmed: (source) =>
          set((s) => {
            const next = new Set(s.ui.firstWritebackConfirmedThisSession);
            next.delete(source);
            return {
              ui: { ...s.ui, firstWritebackConfirmedThisSession: next },
            };
          }),
      },

      wizard: {
        step: 0,
        collected: {},
        setStep: (s) => set((st) => ({ wizard: { ...st.wizard, step: s } })),
        next: () =>
          set((st) => ({
            wizard: { ...st.wizard, step: Math.min(5, st.wizard.step + 1) as WizardStep },
          })),
        back: () =>
          set((st) => ({
            wizard: { ...st.wizard, step: Math.max(0, st.wizard.step - 1) as WizardStep },
          })),
        setField: (key, value) =>
          set((st) => ({
            wizard: { ...st.wizard, collected: { ...st.wizard.collected, [key]: value } },
          })),
        reset: () => set((st) => ({ wizard: { ...st.wizard, step: 0, collected: {} } })),
      },

      config: {
        yaml: null,
        loaded: false,
        setYaml: (yaml) => set((s) => ({ config: { ...s.config, yaml } })),
        markLoaded: () => set((s) => ({ config: { ...s.config, loaded: true } })),
      },

      skills: {
        meetingConfig: {},
        setMeetingConfig: (patch) =>
          set((st) => ({
            skills: {
              ...st.skills,
              meetingConfig: { ...st.skills.meetingConfig, ...patch },
            },
          })),
        resetMeetingConfig: () =>
          set((st) => ({ skills: { ...st.skills, meetingConfig: {} } })),
      },
    }),
    {
      name: "tangerine.skills",
      storage: createJSONStorage(() =>
        typeof window !== "undefined" ? window.localStorage : (undefined as unknown as Storage),
      ),
      // Persist the meeting config + the user's theme + memory root choice
      // + the sample-seed/banner flags + memoryConfig (v1.6.0 team mode) so
      // we don't re-prompt the champion every launch.
      partialize: (s) =>
        ({
          ui: {
            theme: s.ui.theme,
            memoryRoot: s.ui.memoryRoot,
            samplesSeeded: s.ui.samplesSeeded,
            sampleBannerDismissed: s.ui.sampleBannerDismissed,
            // === v1.13.10 round-10 ===
            sampleBannerDismissedPaths: s.ui.sampleBannerDismissedPaths,
            // === end v1.13.10 round-10 ===
            // === wave 13 ===
            demoMode: s.ui.demoMode,
            demoSeedAttempted: s.ui.demoSeedAttempted,
            // === end wave 13 ===
            // === v1.16 Wave 1 === — demoTourCompleted砍 from persist.
            memoryConfig: s.ui.memoryConfig,
            currentUser: s.ui.currentUser,
            dismissedAtoms: s.ui.dismissedAtoms,
            snoozedAtoms: s.ui.snoozedAtoms,
            primaryAITool: s.ui.primaryAITool,
            // v1.8 Phase 4 ambient
            agiParticipation: s.ui.agiParticipation,
            agiVolume: s.ui.agiVolume,
            mutedAgiChannels: s.ui.mutedAgiChannels,
            // Dismiss memory is pruned on hydrate via the merge fn — we
            // still persist the raw list here so very recent dismisses
            // survive a restart (e.g. user dismisses, app crashes 5
            // minutes later, reopens — entry is still inside the 24h
            // window and respected).
            dismissedSurfaces: s.ui.dismissedSurfaces,
            agiConfidenceThreshold: s.ui.agiConfidenceThreshold,
            // v2.0-beta.3 — single sensitivity slider. Persisted so
            // returning users keep their preferred knob position.
            agiSensitivity: s.ui.agiSensitivity,
            // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
            newcomerOnboardingShown: s.ui.newcomerOnboardingShown,
            // Wave 4-C — welcome overlay latch.
            welcomed: s.ui.welcomed,
            // === wave 6 === BUG #3 — version that was running when the
            // user dismissed the tour. Compared against `__APP_VERSION__`
            // on app load to re-show the overlay after upgrades.
            lastWelcomedVersion: s.ui.lastWelcomedVersion,
            // === wave 5-α ===
            showAdvancedSettings: s.ui.showAdvancedSettings,
            // === end wave 5-α ===
            // v3.0 §1 — personal-agent capture flags. Persisted so the
            // Settings UI renders the user's last opt-in choices on cold
            // launch without waiting for the first
            // `personal_agents_get_settings` round-trip.
            personalAgentsEnabled: s.ui.personalAgentsEnabled,
            // v2.5 §2 + §3 — auth mode + billing snapshot. Persisted so
            // the trial-gate effect can compute "is the trial expired"
            // immediately on cold-launch without waiting for the first
            // `billing_status` round-trip.
            authMode: s.ui.authMode,
            billingStatus: s.ui.billingStatus,
            trialExpiry: s.ui.trialExpiry,
            // === wave 8 === — sidebar collapse state. Persisted so
            // the user's section preferences carry forward across
            // launches (a power user collapses Sources once → stays
            // that way).
            sidebarSections: s.ui.sidebarSections,
            // === wave 10 === — git auto-sync settings. Persisted so the
            // user's choices (init/skip + intervals + toggles) survive
            // cold launches and the GitInitBanner respects "skip" forever.
            gitMode: s.ui.gitMode,
            gitAutoPullIntervalMin: s.ui.gitAutoPullIntervalMin,
            gitAutoCommitOnHeartbeat: s.ui.gitAutoCommitOnHeartbeat,
            gitAutoPushOnCommit: s.ui.gitAutoPushOnCommit,
            // === end wave 10 ===
            // === wave 11 === — setup-wizard persist砍 (smart layer砍 v1.16 W1).
            // === v1.16 Wave 1 === — first-launch latch persists. Other
            // onboarding chat / scope / activation keys砍 from persist.
            onboardingCompletedAt: s.ui.onboardingCompletedAt,
            // === end v1.16 Wave 1 ===
            // === wave 16 === — right-rail ACTIVITY filter pick.
            activityFeedFilter: s.ui.activityFeedFilter,
            // === end wave 16 ===
            // === wave 23 === — /memory route view mode pick (tree/graph/list).
            memoryViewMode: s.ui.memoryViewMode,
            // === end wave 23 ===
            // === wave 22 ===
            // Persist tour + coachmark + try-this dismiss memory so a
            // returning user who finished the tour never sees it again.
            firstRunTourCompleted: s.ui.firstRunTourCompleted,
            coachmarksDismissed: s.ui.coachmarksDismissed,
            tryThisDismissed: s.ui.tryThisDismissed,
            // === end wave 22 ===
          },
          skills: { meetingConfig: s.skills.meetingConfig },
        }) as unknown as Store,
      merge: (persisted, current) => {
        const p = persisted as
          | {
              ui?: {
                theme?: ThemeMode;
                memoryRoot?: string;
                samplesSeeded?: boolean;
                sampleBannerDismissed?: boolean;
                // === v1.13.10 round-10 ===
                sampleBannerDismissedPaths?: string[];
                // === end v1.13.10 round-10 ===
                // === wave 13 ===
                demoMode?: boolean;
                demoSeedAttempted?: boolean;
                // === end wave 13 ===
                // === v1.16 Wave 1 === — demoTourCompleted砍.
                memoryConfig?: MemoryConfig;
                currentUser?: string;
                dismissedAtoms?: string[];
                snoozedAtoms?: Record<string, number>;
                primaryAITool?: string | null;
                agiParticipation?: boolean;
                agiVolume?: AgiVolume;
                mutedAgiChannels?: string[];
                dismissedSurfaces?: DismissEntry[];
                agiConfidenceThreshold?: number;
                agiSensitivity?: number;
                newcomerOnboardingShown?: boolean;
                welcomed?: boolean;
                lastWelcomedVersion?: string;
                showAdvancedSettings?: boolean;
                personalAgentsEnabled?: {
                  cursor: boolean;
                  claude_code: boolean;
                  codex: boolean;
                  windsurf: boolean;
                  // === v3.0 wave 2 personal agents ===
                  // Persisted-state read may pre-date wave 2; the merge
                  // function below back-fills missing fields with `false`
                  // so a v3.0-alpha.1 install upgrades cleanly.
                  devin?: boolean;
                  replit?: boolean;
                  apple_intelligence?: boolean;
                  ms_copilot?: boolean;
                  // === end v3.0 wave 2 personal agents ===
                };
                authMode?: "stub" | "real";
                billingStatus?:
                  | "trialing"
                  | "active"
                  | "past_due"
                  | "canceled"
                  | "none";
                trialExpiry?: number;
                // === wave 23 ===
                memoryViewMode?: "tree" | "graph" | "list";
                // === end wave 23 ===
              };
              skills?: { meetingConfig?: MeetingConfig };
            }
          | undefined;
        const theme = p?.ui?.theme ?? current.ui.theme;
        const resolved = resolveTheme(theme);
        return {
          ...current,
          ui: {
            ...current.ui,
            theme,
            resolvedTheme: resolved,
            memoryRoot: p?.ui?.memoryRoot ?? current.ui.memoryRoot,
            samplesSeeded: p?.ui?.samplesSeeded ?? current.ui.samplesSeeded,
            sampleBannerDismissed:
              p?.ui?.sampleBannerDismissed ?? current.ui.sampleBannerDismissed,
            // === v1.13.10 round-10 ===
            sampleBannerDismissedPaths:
              p?.ui?.sampleBannerDismissedPaths ?? current.ui.sampleBannerDismissedPaths,
            // === end v1.13.10 round-10 ===
            // === wave 13 ===
            demoMode: p?.ui?.demoMode ?? current.ui.demoMode,
            demoSeedAttempted:
              p?.ui?.demoSeedAttempted ?? current.ui.demoSeedAttempted,
            // === end wave 13 ===
            // === v1.16 Wave 1 === — demoTourCompleted砍 from hydration.
            memoryConfig: p?.ui?.memoryConfig ?? current.ui.memoryConfig,
            currentUser: p?.ui?.currentUser ?? current.ui.currentUser,
            dismissedAtoms: p?.ui?.dismissedAtoms ?? current.ui.dismissedAtoms,
            snoozedAtoms: p?.ui?.snoozedAtoms ?? current.ui.snoozedAtoms,
            primaryAITool: p?.ui?.primaryAITool ?? current.ui.primaryAITool,
            // v1.8 Phase 4 ambient — prune any persisted dismiss entries
            // older than 24h so a long-paused install doesn't carry a
            // forever-dismissed surface forward.
            agiParticipation:
              p?.ui?.agiParticipation ?? current.ui.agiParticipation,
            agiVolume: p?.ui?.agiVolume ?? current.ui.agiVolume,
            mutedAgiChannels:
              p?.ui?.mutedAgiChannels ?? current.ui.mutedAgiChannels,
            dismissedSurfaces: pruneDismissed(
              p?.ui?.dismissedSurfaces ?? current.ui.dismissedSurfaces,
            ),
            agiConfidenceThreshold:
              p?.ui?.agiConfidenceThreshold ?? current.ui.agiConfidenceThreshold,
            // v2.0-beta.3 — sensitivity slider. If the persisted state
            // pre-dates this field (v1.x install), derive an initial
            // value from the existing volume + threshold so the user's
            // prior knob position carries forward without resetting to
            // 50. New installs default to 50 (quiet + 0.7).
            agiSensitivity:
              p?.ui?.agiSensitivity ??
              deriveSensitivity(
                p?.ui?.agiVolume ?? current.ui.agiVolume,
                p?.ui?.agiConfidenceThreshold ??
                  current.ui.agiConfidenceThreshold,
              ),
            // v1.9.0-beta.2 P2-C — newcomer onboarding latch. Once flipped
            // it stays flipped across launches so the welcome toast never
            // re-fires for the same install.
            newcomerOnboardingShown:
              p?.ui?.newcomerOnboardingShown ?? current.ui.newcomerOnboardingShown,
            // Wave 4-C — welcome overlay latch.
            welcomed: p?.ui?.welcomed ?? current.ui.welcomed,
            // === wave 6 === BUG #3 — last-welcomed version. Default to ""
            // (current.ui default) so a v1.9.2-and-earlier persisted state
            // upgrades cleanly: if `welcomed: true` came forward but
            // `lastWelcomedVersion` is missing, the cold-launch effect in
            // AppShell will detect the empty string vs `__APP_VERSION__`
            // mismatch and re-show the overlay so the user catches new
            // tour content.
            lastWelcomedVersion:
              p?.ui?.lastWelcomedVersion ?? current.ui.lastWelcomedVersion,
            // === wave 5-α ===
            showAdvancedSettings:
              p?.ui?.showAdvancedSettings ?? current.ui.showAdvancedSettings,
            // === end wave 5-α ===
            // === wave 10 === — git auto-sync hydration. `later` is a
            // per-session value (banner re-prompts next launch), so a
            // persisted `later` collapses back to `unknown`.
            gitMode: ((): "unknown" | "init" | "skip" | "later" => {
              const persisted = (p?.ui as { gitMode?: string } | undefined)
                ?.gitMode;
              if (persisted === "init" || persisted === "skip") return persisted;
              return current.ui.gitMode;
            })(),
            gitAutoPullIntervalMin:
              (p?.ui as { gitAutoPullIntervalMin?: number } | undefined)
                ?.gitAutoPullIntervalMin ?? current.ui.gitAutoPullIntervalMin,
            gitAutoCommitOnHeartbeat:
              (p?.ui as { gitAutoCommitOnHeartbeat?: boolean } | undefined)
                ?.gitAutoCommitOnHeartbeat ?? current.ui.gitAutoCommitOnHeartbeat,
            gitAutoPushOnCommit:
              (p?.ui as { gitAutoPushOnCommit?: boolean } | undefined)
                ?.gitAutoPushOnCommit ?? current.ui.gitAutoPushOnCommit,
            // === end wave 10 ===
            // === wave 11 === — setup-wizard merge砍 (smart layer砍 v1.16 W1).
            // === v1.16 Wave 1 === — first-launch latch hydration.
            //
            // Simplified from the v1.15.1 hard-evidence-prestamp scheme.
            // Wave 1 砍 the chat onboarding flow that produced the
            // chicken-and-egg deadlock that motivated the original
            // healing logic, so the latch can go back to a plain
            // pass-through: persisted value if present, else null.
            // W3 will reintroduce richer pre-stamp criteria when the
            // new onboarding surface ships.
            onboardingCompletedAt: ((): number | null => {
              const persisted = (
                p?.ui as { onboardingCompletedAt?: number | null } | undefined
              )?.onboardingCompletedAt;
              if (typeof persisted === "number") return persisted;
              return current.ui.onboardingCompletedAt;
            })(),
            // === end v1.16 Wave 1 ===
            // v3.0 §1 — personal-agent capture flags. Persisted; the
            // Settings page also calls `personal_agents_get_settings`
            // on mount to reconcile with the Rust source of truth.
            // Wave 2 (v3.0 §1.7-§1.11) adds devin/replit/apple_intelligence/
            // ms_copilot — back-fill missing keys with `false` so a v3.0-alpha
            // install (only the wave 1 keys persisted) upgrades cleanly.
            personalAgentsEnabled: {
              cursor:
                p?.ui?.personalAgentsEnabled?.cursor ??
                current.ui.personalAgentsEnabled.cursor,
              claude_code:
                p?.ui?.personalAgentsEnabled?.claude_code ??
                current.ui.personalAgentsEnabled.claude_code,
              codex:
                p?.ui?.personalAgentsEnabled?.codex ??
                current.ui.personalAgentsEnabled.codex,
              windsurf:
                p?.ui?.personalAgentsEnabled?.windsurf ??
                current.ui.personalAgentsEnabled.windsurf,
              // === v3.0 wave 2 personal agents ===
              devin:
                p?.ui?.personalAgentsEnabled?.devin ??
                current.ui.personalAgentsEnabled.devin,
              replit:
                p?.ui?.personalAgentsEnabled?.replit ??
                current.ui.personalAgentsEnabled.replit,
              apple_intelligence:
                p?.ui?.personalAgentsEnabled?.apple_intelligence ??
                current.ui.personalAgentsEnabled.apple_intelligence,
              ms_copilot:
                p?.ui?.personalAgentsEnabled?.ms_copilot ??
                current.ui.personalAgentsEnabled.ms_copilot,
              // === end v3.0 wave 2 personal agents ===
            },
            // v2.5 §2 + §3 — auth mode + billing snapshot. Persisted so
            // the trial-gate check on cold launch sees the prior expiry
            // immediately without waiting on a Tauri round-trip.
            authMode: p?.ui?.authMode ?? current.ui.authMode,
            billingStatus: p?.ui?.billingStatus ?? current.ui.billingStatus,
            trialExpiry: p?.ui?.trialExpiry ?? current.ui.trialExpiry,
            // === wave 8 === — sidebar collapse state. Back-fill any
            // missing keys with the current default so a v1.x install
            // (no `sidebarSections` persisted) upgrades cleanly.
            // === wave 14 === — added `brain` key for the new top
            // section. Defaults to current.ui.sidebarSections.brain
            // (true) so a v1.10.3 user lands on an expanded Brain
            // section after upgrade.
            sidebarSections: {
              brain:
                (p?.ui as { sidebarSections?: { brain?: boolean } } | undefined)
                  ?.sidebarSections?.brain ??
                current.ui.sidebarSections.brain,
              sources:
                (p?.ui as { sidebarSections?: { sources?: boolean } } | undefined)
                  ?.sidebarSections?.sources ??
                current.ui.sidebarSections.sources,
              aiTools:
                (p?.ui as { sidebarSections?: { aiTools?: boolean } } | undefined)
                  ?.sidebarSections?.aiTools ??
                current.ui.sidebarSections.aiTools,
              advanced:
                (p?.ui as { sidebarSections?: { advanced?: boolean } } | undefined)
                  ?.sidebarSections?.advanced ??
                current.ui.sidebarSections.advanced,
              activeAgents:
                (p?.ui as { sidebarSections?: { activeAgents?: boolean } } | undefined)
                  ?.sidebarSections?.activeAgents ??
                current.ui.sidebarSections.activeAgents,
            },
            // === wave 16 === — right-rail ACTIVITY filter pick. Persisted
            // so a power user's "team only" choice carries forward across
            // launches. Default = "all" when absent (fresh install or
            // v1.10.3-and-earlier upgrade with no persisted key).
            activityFeedFilter: ((): "all" | "me" | "team" => {
              const v = (p?.ui as { activityFeedFilter?: string } | undefined)
                ?.activityFeedFilter;
              if (v === "all" || v === "me" || v === "team") return v;
              return current.ui.activityFeedFilter;
            })(),
            // === end wave 16 ===
            // === wave 23 === — /memory route view mode pick (tree/graph/list).
            memoryViewMode: ((): "tree" | "graph" | "list" => {
              const v = p?.ui?.memoryViewMode;
              if (v === "tree" || v === "graph" || v === "list") return v;
              return current.ui.memoryViewMode;
            })(),
            // === end wave 23 ===
            // === wave 22 ===
            // Wave 22 — coachmark / tour / try-this dismiss memory.
            // Bare casts so a v1.10-and-earlier persisted state (which
            // pre-dates these keys) upgrades cleanly to the defaults.
            firstRunTourCompleted:
              (p?.ui as { firstRunTourCompleted?: boolean } | undefined)
                ?.firstRunTourCompleted ?? current.ui.firstRunTourCompleted,
            coachmarksDismissed:
              (p?.ui as { coachmarksDismissed?: string[] } | undefined)
                ?.coachmarksDismissed ?? current.ui.coachmarksDismissed,
            tryThisDismissed:
              (p?.ui as { tryThisDismissed?: string[] } | undefined)
                ?.tryThisDismissed ?? current.ui.tryThisDismissed,
            // === end wave 22 ===
          },
          skills: {
            ...current.skills,
            meetingConfig: p?.skills?.meetingConfig ?? current.skills.meetingConfig,
          },
        };
      },
    },
  ),
);

// Re-apply on hydrate so the initial paint matches the persisted theme.
if (typeof window !== "undefined") {
  applyTheme(resolveTheme(useStore.getState().ui.theme));
  // Listen for OS theme changes when in "system" mode.
  if (window.matchMedia) {
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (useStore.getState().ui.theme === "system") {
        const next = resolveTheme("system");
        useStore.setState((s) => ({ ui: { ...s.ui, resolvedTheme: next } }));
        applyTheme(next);
      }
    };
    mql.addEventListener?.("change", onChange);
  }
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
