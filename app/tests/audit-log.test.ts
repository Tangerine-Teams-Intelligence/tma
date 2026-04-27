import { describe, expect, it } from "vitest";
import {
  auditAppend,
  auditReadWindow,
  auditReadDay,
  auditSearch,
} from "../src/lib/tauri";

/**
 * v3.5 §5.2 — Audit log stub tests.
 *
 * Browser-mode stub round-trips the append shape and stamps `region`.
 * The real append-to-disk semantics are exercised by the Rust unit tests
 * in `crate::audit_log::tests`; these are wire-format checks only.
 */

describe("audit log stub append", () => {
  it("returns the entry with region stamped", async () => {
    const entry = await auditAppend({
      user: "daizhe",
      action: "template.install",
      resource: "tangerine-legal-pack",
    });
    expect(entry.user).toBe("daizhe");
    expect(entry.action).toBe("template.install");
    expect(entry.region).toBe("us-east");
    expect(entry.ts).toMatch(/T/);
  });

  it("read_window stub returns empty array", async () => {
    const rows = await auditReadWindow(0);
    expect(Array.isArray(rows)).toBe(true);
  });

  it("read_day stub accepts YYYY-MM-DD", async () => {
    const rows = await auditReadDay("2026-04-26");
    expect(Array.isArray(rows)).toBe(true);
  });

  it("search stub returns array", async () => {
    const rows = await auditSearch("template", 7);
    expect(Array.isArray(rows)).toBe(true);
  });
});
