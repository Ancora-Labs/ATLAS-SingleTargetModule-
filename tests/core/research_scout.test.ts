import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildTargetIntentResearchSection,
  buildTargetResearchCoverageSection,
  buildTargetResearchSessionStamp,
  deriveTargetResearchCoveragePlan,
} from "../../src/core/research_scout.js";

describe("research_scout target intent context", () => {
  it("formats the clarified target intent for scout prompt injection", () => {
    const sectionText = buildTargetIntentResearchSection({
      intent: {
        status: "ready_for_planning",
        summary: "repoState=existing | goal=restaurant admin panel | users=staff | scope=booking dashboard | protect=payments | success=booking flow works end-to-end",
        planningMode: "shadow",
        productType: "restaurant admin panel",
        targetUsers: ["staff"],
        mustHaveFlows: ["booking dashboard"],
        scopeIn: ["booking dashboard"],
        scopeOut: ["payment redesign"],
        protectedAreas: ["payments"],
        successCriteria: ["booking flow works end-to-end"],
        openQuestions: [],
      },
    });

    assert.ok(sectionText.includes("## TARGET INTENT CONTRACT"));
    assert.ok(sectionText.includes("Intent status: ready_for_planning"));
    assert.ok(sectionText.includes("Planning mode: shadow"));
    assert.ok(sectionText.includes("Protected areas: payments"));
    assert.ok(sectionText.includes("Success criteria: booking flow works end-to-end"));
  });

  it("stamps empty-repo sessions as discovery research", () => {
    const stamp = buildTargetResearchSessionStamp({
      projectId: "target_restaurant",
      sessionId: "sess_123",
      currentStage: "shadow",
      intent: {
        status: "ready_for_planning",
        repoState: "empty",
        planningMode: "shadow",
      },
    });

    assert.deepEqual(stamp, {
      projectId: "target_restaurant",
      sessionId: "sess_123",
      currentStage: "shadow",
      repoState: "empty",
      intentStatus: "ready_for_planning",
      planningMode: "shadow",
      researchMode: "empty_repo_discovery",
    });
  });

  it("derives adaptive coverage obligations for visual-first targets", () => {
    const plan = deriveTargetResearchCoveragePlan({
      intent: {
        repoState: "empty",
        productType: "premium food landing page",
        summary: "Goal is a premium food landing page with strong images, trust, and mobile polish.",
        mustHaveFlows: ["hero CTA", "menu preview", "reservation flow"],
        successCriteria: ["looks premium on mobile and desktop"],
      },
    });

    assert.equal(plan.adaptive, true);
    assert.ok(plan.obligations.includes("visual_design"));
    assert.ok(plan.obligations.includes("media_surfaces"));
    assert.ok(plan.obligations.includes("responsive_experience"));
    assert.ok(plan.obligations.includes("trust_signals"));
    assert.ok(plan.recommendedSourceTypes.includes("visual exemplars"));
    assert.ok(plan.targetSourceCount >= 10);
  });

  it("builds a generic coverage section without hardcoded domain gates", () => {
    const sectionText = buildTargetResearchCoverageSection({
      intent: {
        repoState: "existing",
        productType: "admin dashboard",
        summary: "Improve a staff dashboard flow safely.",
        mustHaveFlows: ["booking edits", "status filters"],
        successCriteria: ["flow remains clear and usable"],
      },
    });

    assert.ok(sectionText.includes("## TARGET RESEARCH COVERAGE PLAN"));
    assert.ok(sectionText.includes("Coverage obligations:"));
    assert.ok(sectionText.includes("implementation_patterns"));
    assert.ok(!sectionText.toLowerCase().includes("food gate"));
  });
});