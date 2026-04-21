import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRecurrenceEscalations, detectRecurrences } from "../../src/core/recurrence_detector.js";

describe("recurrence_detector", () => {
  it("sorts recurrences by recurrenceWeightedPriority descending", () => {
    const postmortems = [
      { expectedOutcome: "Fix infra timeout", actualOutcome: "Retried with stable network", defectChannelTag: "infra_env", lessonLearned: "infra timeout issue repeated", reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix infra timeout", actualOutcome: "Retried with stable network", defectChannelTag: "infra_env", lessonLearned: "infra timeout issue repeated", reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix infra timeout", actualOutcome: "Retried with stable network", defectChannelTag: "infra_env", lessonLearned: "infra timeout issue repeated", reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix unknown issue", actualOutcome: "Applied mitigation and verified", defectChannelTag: "unknown", lessonLearned: "generic lesson repeated often", reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix unknown issue", actualOutcome: "Applied mitigation and verified", defectChannelTag: "unknown", lessonLearned: "generic lesson repeated often", reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix unknown issue", actualOutcome: "Applied mitigation and verified", defectChannelTag: "unknown", lessonLearned: "generic lesson repeated often", reviewStatus: "learning_grade" },
    ];
    const matches = detectRecurrences(postmortems, { threshold: 2, window: 20 }) as any[];
    assert.ok(matches.length >= 2);
    assert.ok((matches[0].recurrenceWeightedPriority || 0) >= (matches[1].recurrenceWeightedPriority || 0));
  });

  it("negative path: skips duplicate-suppressed postmortems from recurrence counts", () => {
    const postmortems = [
      { expectedOutcome: "Fix governance drift", actualOutcome: "Patch deferred", defectChannelTag: "governance_drift", lessonLearned: "drift fix needed", interventionDuplicateSuppressed: true, reviewStatus: "learning_grade" },
      { expectedOutcome: "Fix governance drift", actualOutcome: "Patch deferred", defectChannelTag: "governance_drift", lessonLearned: "drift fix needed", interventionDuplicateSuppressed: false, reviewStatus: "learning_grade" },
    ];
    const matches = detectRecurrences(postmortems, { threshold: 2, window: 20 });
    assert.equal(matches.length, 0);
  });

  it("builds human-readable escalation reasons for recurrence alerts", () => {
    const escalations = buildRecurrenceEscalations([{
      pattern: "Recurring defect tag: product",
      count: 4,
      channel: "product",
      tag: "product",
      severity: "warning",
    }] as any);

    assert.equal(escalations.length, 1);
    assert.match(escalations[0].reason, /4 time\(s\)/);
    assert.match(escalations[0].reason, /channel=product/);
    assert.match(escalations[0].reason, /tag=product/);
  });
});
