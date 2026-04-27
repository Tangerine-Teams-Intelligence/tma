import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  TANGERINE_DEFAULT_BRANDING,
  brandingGetConfig,
  brandingApply,
  brandingResetToDefault,
  brandingValidateLicense,
} from "../src/lib/tauri";
import {
  applyBrandingCssVars,
  clearBrandingCssVars,
  isDefaultBranding,
} from "../src/lib/branding";

/**
 * v3.5 §4 — branding stub tests.
 *
 * Outside Tauri the wrappers fall through to the JS mock so these tests
 * verify the contract: default config matches Tangerine baseline, override
 * round-trips, license validator accepts the documented prefixes, CSS
 * variable injection writes the expected style properties.
 */

describe("branding default config", () => {
  it("matches the Tangerine baseline", () => {
    expect(TANGERINE_DEFAULT_BRANDING.app_name).toBe("Tangerine");
    expect(TANGERINE_DEFAULT_BRANDING.primary_color).toBe("#CC5500");
    expect(TANGERINE_DEFAULT_BRANDING.accent_color).toBe("#1A1A2E");
  });

  it("brandingGetConfig stub returns the default", async () => {
    const cfg = await brandingGetConfig();
    expect(isDefaultBranding(cfg)).toBe(true);
  });
});

describe("brandingApply override", () => {
  it("round-trips an override through the wrapper", async () => {
    const next = await brandingApply({
      logo_url: "https://acme.com/logo.svg",
      primary_color: "#0066FF",
      accent_color: "#FF6600",
      custom_domain: "tangerine.acme.com",
      app_name: "Acme-AGI",
    });
    expect(next.app_name).toBe("Acme-AGI");
    expect(isDefaultBranding(next)).toBe(false);
  });

  it("brandingResetToDefault returns the Tangerine baseline", async () => {
    const cfg = await brandingResetToDefault();
    expect(isDefaultBranding(cfg)).toBe(true);
  });
});

describe("brandingValidateLicense", () => {
  it("rejects empty key", async () => {
    const v = await brandingValidateLicense("");
    expect(v.valid).toBe(false);
  });

  it("accepts trial prefix", async () => {
    const v = await brandingValidateLicense("tangerine-trial-acme");
    expect(v.valid).toBe(true);
    expect(v.tier).toBe("trial");
    expect(v.tenant).toBe("acme");
  });

  it("accepts full license prefix", async () => {
    const v = await brandingValidateLicense("tangerine-license-enterprise-megacorp");
    expect(v.valid).toBe(true);
    expect(v.tier).toBe("enterprise");
    expect(v.tenant).toBe("megacorp");
  });

  it("rejects unknown prefix", async () => {
    const v = await brandingValidateLicense("foobar");
    expect(v.valid).toBe(false);
  });
});

describe("applyBrandingCssVars", () => {
  beforeEach(() => {
    clearBrandingCssVars();
  });
  afterEach(() => {
    clearBrandingCssVars();
  });

  it("default branding sets default CSS vars", () => {
    applyBrandingCssVars(TANGERINE_DEFAULT_BRANDING);
    expect(document.documentElement.style.getPropertyValue("--ti-brand-primary")).toBe(
      "#CC5500",
    );
    expect(document.documentElement.dataset.brandingMode).toBe("default");
  });

  it("override updates CSS vars", () => {
    applyBrandingCssVars({
      logo_url: "https://acme.com/logo.svg",
      primary_color: "#0066FF",
      accent_color: "#FF6600",
      custom_domain: "tangerine.acme.com",
      app_name: "Acme-AGI",
    });
    expect(document.documentElement.style.getPropertyValue("--ti-brand-primary")).toBe(
      "#0066FF",
    );
    expect(document.documentElement.dataset.brandingMode).toBe("custom");
  });

  it("clearBrandingCssVars wipes the props", () => {
    applyBrandingCssVars({
      ...TANGERINE_DEFAULT_BRANDING,
      primary_color: "#0066FF",
    });
    clearBrandingCssVars();
    expect(document.documentElement.style.getPropertyValue("--ti-brand-primary")).toBe(
      "",
    );
    expect(document.documentElement.dataset.brandingMode).toBe("default");
  });
});
