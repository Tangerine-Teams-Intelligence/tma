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
  /** Cmd+K command palette visibility. */
  paletteOpen: boolean;
  /** True when user chose "Skip — local memory only" on auth. */
  localOnly: boolean;
  /** True after `init_memory_with_samples` has run successfully (or no-op). */
  samplesSeeded: boolean;
  /** True after the user dismisses the in-content sample banner. */
  sampleBannerDismissed: boolean;
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
  /** Atom ids snoozed locally; cleared after 24h via setInterval. */
  snoozedAtoms: Record<string, number>;
  /** Whats-new banner state. dismissed=true hides the banner until next
   *  cursor.last_opened_at refresh. */
  whatsNewDismissed: boolean;
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
  setAgiParticipation: (v: boolean) => void;
  setAgiVolume: (v: AgiVolume) => void;
  toggleAgiChannelMute: (channel: string) => void;
  rememberDismissed: (surfaceId: string) => void;
  resetDismissedSurfaces: () => void;
  setAgiConfidenceThreshold: (n: number) => void;
  /** v1.9.0-beta.2 — flip the newcomer-onboarding latch. */
  setNewcomerOnboardingShown: (v: boolean) => void;
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
  pushBanner: (b: BannerProps) => void;
  dismissBanner: (id: string) => void;
  pushModal: (m: ModalProps) => void;
  dismissModal: (id: string) => void;
  setTheme: (t: ThemeMode) => void;
  cycleTheme: () => void;
  setMemoryRoot: (path: string) => void;
  toggleSidebar: () => void;
  setPalette: (open: boolean) => void;
  togglePalette: () => void;
  setLocalOnly: (v: boolean) => void;
  setSamplesSeeded: (v: boolean) => void;
  dismissSampleBanner: () => void;
  setMemoryConfig: (patch: Partial<MemoryConfig>) => void;
  resetMemoryConfig: () => void;
  setCurrentUser: (u: string) => void;
  dismissAtom: (atomId: string) => void;
  snoozeAtom: (atomId: string, untilMs: number) => void;
  resetDismissals: () => void;
  setWhatsNewDismissed: (v: boolean) => void;
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
        paletteOpen: false,
        localOnly: false,
        samplesSeeded: false,
        sampleBannerDismissed: false,
        // v2.0-alpha.1 — personalDirEnabled defaults to true on first launch.
        // The setMemoryConfig patch flow lets the user flip it from the
        // settings UI without disturbing repo / mode / invite fields.
        memoryConfig: { personalDirEnabled: true },
        currentUser: "me",
        dismissedAtoms: [],
        snoozedAtoms: {},
        whatsNewDismissed: false,
        primaryAITool: null,
        agiParticipation: true,
        agiVolume: "quiet",
        mutedAgiChannels: [],
        dismissedSurfaces: [],
        agiConfidenceThreshold: 0.7,
        // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
        // Persisted; flips to true after the first emit so the toast
        // never re-fires on subsequent heartbeats / launches.
        newcomerOnboardingShown: false,
        toasts: [],
        // v1.9.0-beta.1 — banner + modal queues. Not persisted — these
        // are session-scoped UI state. Counters reset on every cold launch.
        bannerStack: [],
        modalQueue: [],
        modalsShownThisSession: 0,
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
        dismissSampleBanner: () =>
          set((s) => ({ ui: { ...s.ui, sampleBannerDismissed: true } })),
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
        // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
        setNewcomerOnboardingShown: (v) =>
          set((s) => ({ ui: { ...s.ui, newcomerOnboardingShown: v } })),
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
        pushModal: (m) =>
          set((s) => {
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
            // v1.9.0-beta.2 P2-C — newcomer onboarding latch.
            newcomerOnboardingShown: s.ui.newcomerOnboardingShown,
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
                newcomerOnboardingShown?: boolean;
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
            // v1.9.0-beta.2 P2-C — newcomer onboarding latch. Once flipped
            // it stays flipped across launches so the welcome toast never
            // re-fires for the same install.
            newcomerOnboardingShown:
              p?.ui?.newcomerOnboardingShown ?? current.ui.newcomerOnboardingShown,
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
