import { describe, expect, it } from "vitest";
import {
  marketplaceListTemplates,
  marketplaceInstallTemplate,
  marketplaceGetLaunchState,
  marketplacePublishTemplate,
  type Template,
} from "../src/lib/tauri";

/**
 * v3.5 §1 — Marketplace browser-mode stub tests.
 *
 * Outside the Tauri shell `safeInvoke` falls through to the JS mock, so
 * these tests exercise the same wire-format contract the Rust side
 * enforces: 3 sample templates with the canonical id `tangerine-legal-pack`
 * first, vertical-filtered list, install round-trip, launch-state default.
 */

describe("marketplace stub list_templates", () => {
  it("returns the seeded sample catalog (3 entries)", async () => {
    const rows = await marketplaceListTemplates();
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe("tangerine-legal-pack");
  });

  it("filters by vertical", async () => {
    const rows = await marketplaceListTemplates({ vertical: "legal" });
    expect(rows.length).toBeGreaterThan(0);
    rows.forEach((r) => expect(r.vertical).toBe("legal"));
  });

  it("filters by case-insensitive query substring", async () => {
    const rows = await marketplaceListTemplates({ query: "DESIGN" });
    expect(rows.some((r: Template) => r.id === "starter-design-pack")).toBe(true);
  });
});

describe("marketplace stub install_template", () => {
  it("applies content to team memory and returns an installation record", async () => {
    const inst = await marketplaceInstallTemplate(
      "tangerine-legal-pack",
      "team-test",
    );
    expect(inst.template_id).toBe("tangerine-legal-pack");
    expect(inst.team_id).toBe("team-test");
    expect(inst.installed_at).toMatch(/T/);
  });
});

describe("marketplace stub launch state", () => {
  it("defaults to not launched with the v3.5 §2 gate counters", async () => {
    const state = await marketplaceGetLaunchState();
    expect(state.launched).toBe(false);
    expect(state.gate_status.installs_required).toBe(5_000);
    expect(state.gate_status.self_shipped_template_validated).toBe(false);
  });
});

describe("marketplace stub publish_template", () => {
  it("echoes the supplied metadata in stub mode", async () => {
    const meta: Template = {
      id: "test-pack",
      name: "Test Pack",
      version: "0.1.0",
      author: "test",
      description: "A test template",
      vertical: "ops",
      content_url: "stub://test",
      dependencies: [],
      take_rate: 1000,
      price_cents: 4900,
      install_count: 0,
    };
    const out = await marketplacePublishTemplate(meta, [1, 2, 3]);
    expect(out.id).toBe("test-pack");
    expect(out.version).toBe("0.1.0");
  });
});
