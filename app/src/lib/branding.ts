/**
 * v3.5 §4 — Frontend wrapper around the branding Tauri commands.
 *
 * Reads the persisted `BrandingConfig` and injects it as CSS variables on
 * `<html>`. The variable names match the design-system tokens documented
 * in `VISUAL_DESIGN_SPEC.md`:
 *
 *   --ti-brand-primary  → primary brand color (default Tangerine #CC5500)
 *   --ti-brand-accent   → accent brand color  (default Tangerine #1A1A2E)
 *   --ti-brand-name     → product display name (default "Tangerine")
 *   --ti-brand-logo-url → logo url (empty string ⇒ bundled Tangerine logo)
 *
 * Components that want to reflect tenant branding should read these CSS
 * variables instead of hard-coding `--ti-orange-500` / "Tangerine"
 * strings. The default config keeps the existing Tangerine baseline so
 * unbranded users see no visual change.
 *
 * v3.5 stub mode: writing through `brandingApply` validates hex colors on
 * the Rust side; reading through `brandingGetConfig` falls back to the
 * Tangerine default outside Tauri.
 */

import {
  brandingApply,
  brandingGetConfig,
  brandingResetToDefault,
  brandingValidateLicense,
  TANGERINE_DEFAULT_BRANDING,
  type BrandingConfig,
  type LicenseValidation,
} from "@/lib/tauri";

export type { BrandingConfig, LicenseValidation };
export {
  brandingApply,
  brandingGetConfig,
  brandingResetToDefault,
  brandingValidateLicense,
  TANGERINE_DEFAULT_BRANDING,
};

/**
 * Returns true iff the supplied config matches the Tangerine baseline.
 * Components that conditionally render the "Powered by Tangerine"
 * attribution can branch on this.
 */
export function isDefaultBranding(cfg: BrandingConfig): boolean {
  return (
    cfg.logo_url === TANGERINE_DEFAULT_BRANDING.logo_url &&
    cfg.primary_color === TANGERINE_DEFAULT_BRANDING.primary_color &&
    cfg.accent_color === TANGERINE_DEFAULT_BRANDING.accent_color &&
    cfg.custom_domain === TANGERINE_DEFAULT_BRANDING.custom_domain &&
    cfg.app_name === TANGERINE_DEFAULT_BRANDING.app_name
  );
}

/**
 * Inject the branding config as CSS variables on `<html>`. Idempotent —
 * safe to call on every `useEffect` tick. Outside the browser (vitest
 * jsdom + no `document.documentElement`), this is a no-op.
 */
export function applyBrandingCssVars(cfg: BrandingConfig): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const root = document.documentElement;
  root.style.setProperty("--ti-brand-primary", cfg.primary_color);
  root.style.setProperty("--ti-brand-accent", cfg.accent_color);
  root.style.setProperty("--ti-brand-name", JSON.stringify(cfg.app_name));
  root.style.setProperty("--ti-brand-logo-url", cfg.logo_url);
  root.dataset.brandingMode = isDefaultBranding(cfg) ? "default" : "custom";
}

/**
 * Drop every brand CSS variable. Use after `brandingResetToDefault` so
 * the page reflects the Tangerine baseline immediately, without a reload.
 */
export function clearBrandingCssVars(): void {
  if (typeof document === "undefined" || !document.documentElement) return;
  const root = document.documentElement;
  root.style.removeProperty("--ti-brand-primary");
  root.style.removeProperty("--ti-brand-accent");
  root.style.removeProperty("--ti-brand-name");
  root.style.removeProperty("--ti-brand-logo-url");
  root.dataset.brandingMode = "default";
}

/**
 * Read the current branding config and inject it as CSS variables. Returns
 * the config so callers can also pin it in store state.
 */
export async function loadAndApplyBranding(): Promise<BrandingConfig> {
  const cfg = await brandingGetConfig();
  applyBrandingCssVars(cfg);
  return cfg;
}
