import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRankedLessonShortlists } from "../../src/core/lesson_halflife.js";

describe("buildRankedLessonShortlists", () => {
  it("returns deterministic top-10 slices across recent/high-impact/unresolved buckets", () => {
    const entries = [
      { lessonLearned: "recent resolved", reviewedAt: "2026-04-04T00:00:00.000Z", severity: "info", followUpNeeded: false },
      { lessonLearned: "critical unresolved", reviewedAt: "2026-04-03T00:00:00.000Z", severity: "critical", followUpNeeded: true },
      { lessonLearned: "older medium", reviewedAt: "2026-03-10T00:00:00.000Z", severity: "medium", followUpNeeded: false },
    ];
    const result = buildRankedLessonShortlists(entries, { now: Date.parse("2026-04-05T00:00:00.000Z"), limit: 10 });
    assert.equal(result.recentTop10.length, 3);
    assert.equal(result.highImpactTop10[0].lesson, "critical unresolved");
    assert.equal(result.unresolvedTop10[0].lesson, "critical unresolved");
    assert.ok(result.combinedTop10.length >= 1);
  });

  it("negative path: returns empty buckets for invalid input", () => {
    const result = buildRankedLessonShortlists(null as any);
    assert.deepEqual(result.recentTop10, []);
    assert.deepEqual(result.highImpactTop10, []);
    assert.deepEqual(result.unresolvedTop10, []);
    assert.deepEqual(result.combinedTop10, []);
  });
});
