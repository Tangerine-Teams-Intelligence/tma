/**
 * Wave 3 cross-cut — i18n bootstrap.
 *
 * Per OBSERVABILITY_SPEC §6:
 *   - 中文 + English are day-1. Daizhe is a Chinese founder; design partners
 *     include Chinese factories. Other languages defer to post-v3.5.
 *   - Lib: i18next + react-i18next with a tiny resource bundle. Picked over
 *     react-intl because i18next has cheaper runtime locale switching and a
 *     smaller bundle footprint.
 *   - Default detection: navigator.language matches `zh-*` → `zh`, otherwise
 *     `en`. User override persisted to localStorage under `tangerine.locale`
 *     so Settings → Language survives reload.
 *
 * Scope of this stub (intentional):
 *   - One namespace: `common`. Spec mentions `errors` / `sources` / `agi` /
 *     `settings`; those land as feature work picks up the pattern. Mass
 *     conversion is out of scope (risky, expensive, low signal until a
 *     Chinese pilot actually asks for it).
 *   - About 50 high-frequency UI strings extracted to JSON resources for
 *     en + zh — sidebar views, onboarding, common buttons, settings tabs,
 *     empty states, error templates. Sidebar.tsx is the demo touch-point so
 *     the React+i18n pipe is proven end-to-end.
 *
 * Side-effect import safe — `init` runs once at module load; subsequent
 * imports return the same singleton.
 */
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import en from "@/locales/en/common.json";
import zh from "@/locales/zh/common.json";

const STORAGE_KEY = "tangerine.locale";

/** Resolve initial locale: persisted > navigator > en. */
function resolveInitialLocale(): "en" | "zh" {
  if (typeof window !== "undefined") {
    try {
      const persisted = window.localStorage.getItem(STORAGE_KEY);
      if (persisted === "en" || persisted === "zh") return persisted;
    } catch {
      // Storage may be blocked (private browsing); fall through.
    }
    const nav = (typeof navigator !== "undefined" && navigator.language) || "";
    if (/^zh\b/i.test(nav)) return "zh";
  }
  return "en";
}

/**
 * Initialise i18next exactly once. Calling `setupI18n()` from `main.tsx`
 * before `ReactDOM.createRoot` ensures the first render sees translations.
 */
export function setupI18n(): typeof i18n {
  if (i18n.isInitialized) return i18n;
  void i18n
    .use(initReactI18next)
    .init({
      resources: {
        en: { common: en },
        zh: { common: zh },
      },
      lng: resolveInitialLocale(),
      fallbackLng: "en",
      defaultNS: "common",
      ns: ["common"],
      interpolation: { escapeValue: false },
      // No Suspense — keeps the React tree synchronous for the existing
      // `<React.StrictMode>` mount. Translations are baked in at init.
      react: { useSuspense: false },
    });
  return i18n;
}

/**
 * Switch the active locale at runtime + persist the choice. Used by
 * Settings → Language. Returns the locale that was actually applied.
 */
export async function setLocale(lang: "en" | "zh"): Promise<"en" | "zh"> {
  if (!i18n.isInitialized) setupI18n();
  await i18n.changeLanguage(lang);
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      // Quota / private mode — runtime change still applies; just won't
      // survive reload.
    }
  }
  return lang;
}

/** Read the active locale (post-init). */
export function activeLocale(): "en" | "zh" {
  if (!i18n.isInitialized) setupI18n();
  const l = i18n.language || "en";
  return l.startsWith("zh") ? "zh" : "en";
}

export default i18n;
