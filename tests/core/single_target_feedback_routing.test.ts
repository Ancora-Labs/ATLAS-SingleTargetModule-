import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifySingleTargetAthenaFeedback } from "../../src/core/orchestrator.js";
import { isResearchArtifactAlignedToTargetSession } from "../../src/core/prometheus.js";

describe("single target feedback routing", () => {
  it("routes empty-repo stack uncertainty back into research refresh", () => {
    const category = classifySingleTargetAthenaFeedback({
      reason: {
        code: "LOW_PLAN_QUALITY",
        message: "Need stronger stack and architecture evidence before bootstrap planning",
      },
      corrections: ["Gather framework and hosting evidence for the MVP"],
    }, {
      repoProfile: { repoState: "empty" },
      intent: { repoState: "empty" },
    });

    assert.equal(category, "research");
  });

  it("routes unclear target intent back into clarification", () => {
    const category = classifySingleTargetAthenaFeedback({
      reason: {
        code: "LOW_PLAN_QUALITY",
        message: "User intent is still unclear and scope is ambiguous",
      },
      corrections: ["Clarify primary user and success criteria"],
    }, {
      repoProfile: { repoState: "empty" },
      intent: { repoState: "empty" },
    });

    assert.equal(category, "intent");
  });
});

describe("single target research alignment", () => {
  it("accepts aligned artifacts for the active target session", () => {
    assert.equal(isResearchArtifactAlignedToTargetSession({
      targetSession: {
        projectId: "target_restaurant",
        sessionId: "sess_123",
      },
    }, {
      projectId: "target_restaurant",
      sessionId: "sess_123",
    }), true);
  });

  it("rejects mismatched artifacts for the active target session", () => {
    assert.equal(isResearchArtifactAlignedToTargetSession({
      targetSession: {
        projectId: "target_restaurant",
        sessionId: "sess_old",
      },
    }, {
      projectId: "target_restaurant",
      sessionId: "sess_new",
    }), false);
  });
});