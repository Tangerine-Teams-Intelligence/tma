import { describe, expect, it } from "vitest";
import {
  ssoSetConfig,
  ssoGetConfig,
  ssoListConfigs,
  ssoValidateSamlResponse,
  type SSOConfig,
} from "../src/lib/tauri";

/**
 * v3.5 §5.1 — SSO SAML stub tests.
 *
 * The browser stub returns a deterministic mock assertion so the React
 * provisioning UI can demo the JIT-create-user flow with no IdP wired up.
 */

const sample: SSOConfig = {
  provider: "okta",
  metadata_url: "https://acme.okta.com/app/sso/saml/metadata",
  sp_entity_id: "urn:tangerine:acme",
  tenant: "acme",
};

describe("sso stub config", () => {
  it("ssoSetConfig echoes the supplied config", async () => {
    const out = await ssoSetConfig(sample);
    expect(out.tenant).toBe("acme");
    expect(out.provider).toBe("okta");
  });

  it("ssoGetConfig stub returns null for unknown tenants", async () => {
    const cfg = await ssoGetConfig("nope");
    expect(cfg).toBeNull();
  });

  it("ssoListConfigs stub returns empty list", async () => {
    const list = await ssoListConfigs();
    expect(Array.isArray(list)).toBe(true);
  });
});

describe("ssoValidateSamlResponse", () => {
  it("returns mock assertion with the supplied tenant", async () => {
    const a = await ssoValidateSamlResponse("acme", "<saml-response>");
    expect(a.tenant).toBe("acme");
    expect(a.email).toContain("acme");
    expect(a.roles.length).toBeGreaterThan(0);
  });
});
