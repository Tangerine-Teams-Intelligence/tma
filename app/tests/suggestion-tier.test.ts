/**
 * v1.9.0-beta.1 — tier-selection engine tests.
 *
 * Covers the rule table from SUGGESTION_ENGINE_SPEC.md §3.5. Pure
 * function under test → no React, no store, no async.
 */

import { describe, it, expect } from "vitest";
import {
  selectTier,
  BANNER_CONFIDENCE_FLOOR,
  type SuggestionRequest,
} from "../src/lib/suggestion-tier";

const baseReq: SuggestionRequest = {
  template: "test_template",
  body: "hello",
  confidence: 0.9,
};

describe("selectTier", () => {
  it("returns modal for irreversible", () => {
    expect(
      selectTier({ ...baseReq, is_irreversible: true }),
    ).toBe("modal");
  });

  it("modal beats every other signal", () => {
    // Irreversibility takes priority even when surface_id + cross_route + completion are also set.
    expect(
      selectTier({
        ...baseReq,
        is_irreversible: true,
        is_completion_signal: true,
        is_cross_route: true,
        surface_id: "surf-1",
      }),
    ).toBe("modal");
  });

  it("returns toast for completion_signal", () => {
    expect(
      selectTier({ ...baseReq, is_completion_signal: true }),
    ).toBe("toast");
  });

  it("completion_signal pins to toast even with cross_route + surface_id", () => {
    expect(
      selectTier({
        ...baseReq,
        is_completion_signal: true,
        is_cross_route: true,
        surface_id: "surf-2",
      }),
    ).toBe("toast");
  });

  it("returns banner for cross_route at high confidence", () => {
    expect(
      selectTier({
        ...baseReq,
        is_cross_route: true,
        confidence: 0.85,
      }),
    ).toBe("banner");
  });

  it("returns banner exactly at the floor (≥ 0.8)", () => {
    expect(
      selectTier({
        ...baseReq,
        is_cross_route: true,
        confidence: BANNER_CONFIDENCE_FLOOR,
      }),
    ).toBe("banner");
  });

  it("demotes cross_route below confidence floor to toast", () => {
    expect(
      selectTier({
        ...baseReq,
        is_cross_route: true,
        confidence: 0.75,
      }),
    ).toBe("toast");
  });

  it("returns chip when surface_id is provided and no other tier signal fires", () => {
    expect(
      selectTier({
        ...baseReq,
        surface_id: "input-1",
      }),
    ).toBe("chip");
  });

  it("returns toast as default catch-all", () => {
    expect(selectTier(baseReq)).toBe("toast");
  });

  it("treats undefined surface_id as not-chip", () => {
    expect(
      selectTier({ ...baseReq, surface_id: undefined }),
    ).toBe("toast");
  });
});
