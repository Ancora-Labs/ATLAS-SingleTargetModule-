import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SLA_MS, checkClosureSLA } from "../../src/core/closure_validator.js";

describe("closure_validator", () => {
  it("should return SLA violations for unresolved stale escalations", () => {
    const now = Date.parse("2026-01-01T12:00:00.000Z");
    const escalations = [
      { title: "old", source: "queue", createdAt: "2025-12-31T00:00:00.000Z", resolved: false },
      { title: "fresh", source: "queue", createdAt: "2026-01-01T11:00:00.000Z", resolved: false },
      { title: "resolved", source: "queue", createdAt: "2025-12-30T00:00:00.000Z", resolved: true }
    ];
    const violations = checkClosureSLA(escalations, { now, slaMs: 6 * 60 * 60 * 1000 });
    assert.equal(violations.length, 1);
    assert.equal(violations[0].title, "old");
    assert.equal(violations[0].source, "queue");
    assert.match(violations[0].ageHuman, /h$/);
  });

  it("negative path: returns empty list for non-array input", () => {
    assert.deepEqual(checkClosureSLA(null as any, { slaMs: DEFAULT_SLA_MS }), []);
  });
});

