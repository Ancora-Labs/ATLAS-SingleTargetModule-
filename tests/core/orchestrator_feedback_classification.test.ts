import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifySingleTargetAthenaFeedback } from "../../src/core/orchestrator.js";

describe("classifySingleTargetAthenaFeedback", () => {
  it("treats target-stage contract violations as planning feedback, not intent clarification", () => {
    const category = classifySingleTargetAthenaFeedback({
      reason: {
        code: "TARGET_STAGE_CONTRACT_VIOLATION",
        message: "Target stage contract rejected 5 plan issue(s) — plan[1] shadow mode only allows low-risk task kinds; received implementation",
      },
      corrections: [
        "plan[1]: shadow mode only allows low-risk task kinds; received implementation",
      ],
    }, {
      intent: {
        repoState: "existing",
      },
      repoProfile: {
        repoState: "existing",
      },
    });

    assert.equal(category, "planning");
  });
});