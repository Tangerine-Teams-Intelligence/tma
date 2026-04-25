/**
 * Zustand store. Slices: ui, wizard (legacy), config, skills.
 *
 * v1.5 super-app shell adds the `skills` slice for the marketplace + per-skill
 * config. The legacy `wizard` slice is kept because the field components
 * (SW1DiscordBot, SW2LocalWhisper, SW3ClaudeDetect, SW4TeamMembers) still read
 * `wizard.collected` directly — the meeting skill config form reuses those
 * components by mirroring its values into wizard.collected.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

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

/** Skill ids. Only "meeting" is shipping in v1.5. */
export type SkillId =
  | "meeting"
  | "wiki"
  | "track"
  | "review"
  | "schedule"
  | "loom"
  | "hire"
  | "voice"
  | "survey"
  | "chat";

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

// ---------- slices ----------

interface UiSlice {
  theme: "light" | "dark";
  sidebarCollapsed: boolean;
  toasts: { id: string; kind: "info" | "success" | "error"; text: string }[];
  setTheme: (t: "light" | "dark") => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
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
  /** Per-skill config. Only `meeting` is meaningful in v1.5. */
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

// ---------- store ----------

/** A skill is "installed" when its required config fields are filled. */
export function isSkillInstalled(id: SkillId, m: MeetingConfig): boolean {
  if (id !== "meeting") return false;
  const teamOk = !!m.team && m.team.length > 0 && m.team.every((t) => t.alias && t.displayName);
  const transcriptionOk =
    m.whisperMode === "local" ||
    (m.whisperMode === "openai" && !!m.whisperKey);
  return !!m.discordToken && !!m.guildId && transcriptionOk && !!m.claudeCliPath && teamOk;
}

export function listInstalledSkills(m: MeetingConfig): SkillId[] {
  return (["meeting"] as SkillId[]).filter((id) => isSkillInstalled(id, m));
}

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      ui: {
        theme: "light",
        sidebarCollapsed: false,
        toasts: [],
        setTheme: (t) => {
          set((s) => ({ ui: { ...s.ui, theme: t } }));
          if (typeof document !== "undefined") {
            document.documentElement.dataset.theme = t;
          }
        },
        toggleTheme: () => {
          const next = get().ui.theme === "light" ? "dark" : "light";
          get().ui.setTheme(next);
        },
        toggleSidebar: () =>
          set((s) => ({ ui: { ...s.ui, sidebarCollapsed: !s.ui.sidebarCollapsed } })),
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
      // Only persist the skills slice. UI / wizard / config are ephemeral or
      // owned by the Tauri side.
      partialize: (s) => ({ skills: { meetingConfig: s.skills.meetingConfig } }) as unknown as Store,
      merge: (persisted, current) => {
        const p = persisted as { skills?: { meetingConfig?: MeetingConfig } } | undefined;
        return {
          ...current,
          skills: {
            ...current.skills,
            meetingConfig: p?.skills?.meetingConfig ?? current.skills.meetingConfig,
          },
        };
      },
    },
  ),
);

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
