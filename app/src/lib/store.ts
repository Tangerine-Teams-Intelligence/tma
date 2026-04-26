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
  toasts: { id: string; kind: "info" | "success" | "error"; text: string }[];
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
  pushToast: (kind: "info" | "success" | "error", text: string) => void;
  dismissToast: (id: string) => void;
}

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
        memoryConfig: {},
        currentUser: "me",
        dismissedAtoms: [],
        snoozedAtoms: {},
        whatsNewDismissed: false,
        primaryAITool: null,
        toasts: [],
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
        pushToast: (kind, text) =>
          set((s) => ({
            ui: {
              ...s.ui,
              toasts: [...s.ui.toasts, { id: cryptoRandomId(), kind, text }],
            },
          })),
        dismissToast: (id) =>
          set((s) => ({ ui: { ...s.ui, toasts: s.ui.toasts.filter((t) => t.id !== id) } })),
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
