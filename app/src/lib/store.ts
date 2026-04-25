/**
 * Zustand store. Three slices: ui, wizard, config.
 * Meetings + currentMeeting slices are owned by T2 — they will extend this file.
 *
 * Slice names are LOCKED. T2 + T3 should expect:
 *   useStore.getState().ui.theme
 *   useStore.getState().wizard.collected
 *   useStore.getState().config.yaml
 */

import { create } from "zustand";

// ---------- shared types ----------

export interface TeamMember {
  alias: string;
  displayName: string;
  discordId: string;
}

export interface WizardData {
  discordToken?: string;
  guildId?: string;
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

interface Store {
  ui: UiSlice;
  wizard: WizardSlice;
  config: ConfigSlice;
}

// ---------- store ----------

export const useStore = create<Store>((set, get) => ({
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
}));

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
}
