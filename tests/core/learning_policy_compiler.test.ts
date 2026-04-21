import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compileLessonsToPolicies,
  validatePlanAgainstPolicies,
  COMPILABLE_PATTERNS,
  hardGateRecurrenceToPolicies,
  checkCarryForwardGate,
  deriveRoutingAdjustments,
  buildPromptHardConstraints,
  REASON_CODES,
  compileCurriculumToPolicies,
  CURRICULUM_PROMOTION_THRESHOLD,
  buildInterventionRubricScore,
  decidePolicyMutationsFromEvidenceWindow,
  evaluatePolicyLifecycleWindow,
  reconcilePolicyLifecycleByLineageWindow,
  LEARNED_POLICY_UPLIFT_SIGNAL,
  POLICY_MUTATION_EVIDENCE_WINDOW,
  POLICY_MUTATION_RETIRE_COMBINED_SCORE,
  retireLowYieldPolicyFamilies,
  LOW_YIELD_IMPACT_THRESHOLD,
  LOW_YIELD_MIN_EVIDENCE_RECORDS,
  buildPromptTruthMaintenanceSnapshot,
  resolveStructuredTruthRetirement,
} from "../../src/core/learning_policy_compiler.js";

describe("learning_policy_compiler", () => {
  describe("compileLessonsToPolicies", () => {
    it("returns empty for null input", () => {
      assert.deepEqual(compileLessonsToPolicies(null), []);
    });

    it("returns empty for postmortems with no lessons", () => {
      const pms = [{ lessonLearned: "" }, { lessonLearned: "short" }];
      assert.deepEqual(compileLessonsToPolicies(pms), []);
    });

    it("compiles glob-related lesson to policy", () => {
      const pms = [
        { lessonLearned: "The node --test tests/**/*.test.ts glob pattern fails on Windows due to path expansion issues" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.length > 0);
      assert.ok(policies.some(p => p.id === "glob-false-fail"));
    });

    it("compiles test-related lesson", () => {
      const pms = [
        { lessonLearned: "The module was shipped without any test coverage, causing a regression that went undetected" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.some(p => p.id === "missing-test"));
    });

    it("compiles lint-related lesson", () => {
      const pms = [
        { lessonLearned: "ESLint flagged an unused import that should have been caught before merge" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.some(p => p.id === "lint-failure"));
    });

    it("deduplicates policies from multiple matching lessons", () => {
      const pms = [
        { lessonLearned: "The glob pattern expansion failed again on Windows systems" },
        { lessonLearned: "Another glob wildcard issue in test command" },
      ];
      const policies = compileLessonsToPolicies(pms);
      const globPolicies = policies.filter(p => p.id === "glob-false-fail");
      assert.equal(globPolicies.length, 1);
    });

    it("excludes existing policies", () => {
      const pms = [
        { lessonLearned: "The glob pattern failed on Windows" }
      ];
      const policies = compileLessonsToPolicies(pms, { existingPolicies: ["glob-false-fail"] });
      assert.equal(policies.filter(p => p.id === "glob-false-fail").length, 0);
    });

    it("sets severity and source lesson", () => {
      const pms = [
        { lessonLearned: "Syntax error in new code was pushed without checking", reviewedAt: "2026-01-01T00:00:00Z" }
      ];
      const policies = compileLessonsToPolicies(pms);
      const policy = policies.find(p => p.id === "syntax-error");
      assert.ok(policy);
      assert.equal(policy.severity, "critical");
      assert.ok(policy.sourceLesson.length > 0);
      assert.equal(policy.detectedAt, "2026-01-01T00:00:00Z");
      assert.equal(typeof (policy as any).interventionKind, "string");
      assert.equal((policy as any).optimizationMode, "impact-attributed-loop");
      assert.equal((policy as any).impactAttribution?.evidenceType, "postmortem_lesson");
      assert.equal((policy as any).retirementCriteria?.mode, "measured_uplift_window");
    });
  });

  describe("validatePlanAgainstPolicies", () => {
    it("returns ok for null inputs", () => {
      assert.deepEqual(validatePlanAgainstPolicies(null, []), { ok: true, violations: [] });
    });

    it("detects glob false-fail violation", () => {
      const plan = { task: "Run tests", verification: "node --test tests/**/*.test.ts" };
      const policies = [{ id: "glob-false-fail", assertion: "Use npm test", severity: "critical" }];
      const result = validatePlanAgainstPolicies(plan, policies);
      assert.equal(result.ok, false);
      assert.ok(result.violations.length > 0);
    });

    it("passes clean plan", () => {
      const plan = { task: "Review config", verification: "npm test" };
      const policies = [{ id: "glob-false-fail", assertion: "Use npm test", severity: "critical" }];
      const result = validatePlanAgainstPolicies(plan, policies);
      assert.equal(result.ok, true);
    });
  });

  describe("COMPILABLE_PATTERNS", () => {
    it("has unique IDs", () => {
      const ids = COMPILABLE_PATTERNS.map(p => p.id);
      assert.equal(ids.length, new Set(ids).size);
    });

    it("all patterns have required fields", () => {
      for (const p of COMPILABLE_PATTERNS) {
        assert.ok(p.id, "pattern must have id");
        assert.ok(p.pattern instanceof RegExp, "pattern must have regex");
        assert.ok(p.assertion, "pattern must have assertion");
        assert.ok(["critical", "warning"].includes(p.severity), "severity must be critical or warning");
      }
    });
  });

  describe("hardGateRecurrenceToPolicies (Packet 15)", () => {
    it("returns empty for no postmortems", () => {
      const result = hardGateRecurrenceToPolicies([], []);
      assert.deepEqual(result.newPolicies, []);
      assert.deepEqual(result.escalations, []);
    });

    it("auto-compiles recurring unresolved lesson into policy", () => {
      const pms = [
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 2 });
      assert.ok(result.newPolicies.length > 0);
      assert.ok(result.newPolicies[0].severity === "critical" || result.newPolicies[0].severity === "warning");
    });

    it("excludes already existing policy IDs", () => {
      const pms = [
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
      ];
      const first = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 2 });
      if (first.newPolicies.length > 0) {
        const firstId = first.newPolicies[0].id;
        const second = hardGateRecurrenceToPolicies(pms, [firstId], { maxRecurrences: 2 });
        assert.ok(!second.newPolicies.some(p => p.id === firstId));
      }
    });
  });

  describe("checkCarryForwardGate (Packet 16)", () => {
    it("detects unresolved lessons across cycles", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "a" },
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "b" },
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "c" },
      ];
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 2 });
      assert.ok(result.unresolvedLessons.length > 0);
    });

    it("returns empty unresolvedLessons when count below threshold", () => {
      const pms = [{ followUpNeeded: true, followUpTask: "One-off issue", lessonLearned: "minor" }];
      const result = checkCarryForwardGate(pms, []);
      assert.equal(result.unresolvedLessons.length, 0);
    });

    it("validates mandatoryCarryForward items against current plans", () => {
      const pms = [];
      const plans = [{ task: "Must do X exactly" }];
      const result = checkCarryForwardGate(pms, plans, { mandatoryCarryForward: ["Must do X exactly", "Must do Y"] });
      assert.ok(Array.isArray(result.missingMandatory));
      assert.ok(result.missingMandatory.includes("Must do Y"));
    });

    it("returns empty missingMandatory when all mandatory items in plans", () => {
      const pms = [];
      const plans = [{ task: "Must do X" }, { task: "Must do Y" }];
      const result = checkCarryForwardGate(pms, plans, { mandatoryCarryForward: ["Must do X", "Must do Y"] });
      assert.equal(result.missingMandatory.length, 0);
    });

    // ── Hard admission blocker tests (Task 2) ──────────────────────────────

    it("sets shouldBlock=true when lesson recurs past threshold and plans don't address it", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Recurring unresolved blocker", lessonLearned: "x" },
        { followUpNeeded: true, followUpTask: "Recurring unresolved blocker", lessonLearned: "y" },
        { followUpNeeded: true, followUpTask: "Recurring unresolved blocker", lessonLearned: "z" },
      ];
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 2 });
      assert.equal(result.shouldBlock, true, "shouldBlock must be true when threshold is exceeded");
    });

    it("sets shouldBlock=false when count is exactly at threshold (not over)", () => {
      // threshold default is 3; count must be >= threshold to block
      const pms = [
        { followUpNeeded: true, followUpTask: "Edge case lesson", lessonLearned: "a" },
        { followUpNeeded: true, followUpTask: "Edge case lesson", lessonLearned: "b" },
      ];
      // maxUnresolvedCycles: 3; count=2 < 3 → should NOT block
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 3 });
      assert.equal(result.shouldBlock, false, "shouldBlock must be false when count is below threshold");
    });

    it("unblocks when current plans address the recurring lesson", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Fix critical thing in scope", lessonLearned: "a" },
        { followUpNeeded: true, followUpTask: "Fix critical thing in scope", lessonLearned: "b" },
        { followUpNeeded: true, followUpTask: "Fix critical thing in scope", lessonLearned: "c" },
      ];
      // A plan that explicitly addresses the recurring lesson
      const plans = [{ task: "Fix critical thing in scope" }];
      const result = checkCarryForwardGate(pms, plans, { maxUnresolvedCycles: 2 });
      assert.equal(result.shouldBlock, false, "shouldBlock must be false when plans address the recurring lesson");
    });

    it("reason string is non-empty when shouldBlock=true", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Persistent unresolved issue", lessonLearned: "1" },
        { followUpNeeded: true, followUpTask: "Persistent unresolved issue", lessonLearned: "2" },
        { followUpNeeded: true, followUpTask: "Persistent unresolved issue", lessonLearned: "3" },
      ];
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 2 });
      assert.ok(result.shouldBlock);
      assert.ok(result.reason.length > 0, "reason must describe the block when shouldBlock=true");
    });

    it("negative: empty postmortems never block", () => {
      const result = checkCarryForwardGate([], [], { maxUnresolvedCycles: 1 });
      assert.equal(result.shouldBlock, false);
    });
  });

  // ── Task 9: routing and prompt constraint feedback from recurring postmortems ─

  describe("deriveRoutingAdjustments", () => {
    it("returns empty array for null input", () => {
      assert.deepEqual(deriveRoutingAdjustments(null), []);
    });

    it("returns empty array for empty policies", () => {
      assert.deepEqual(deriveRoutingAdjustments([]), []);
    });

    it("maps known policy IDs to correct modelOverride values", () => {
      const policies = [
        { id: "glob-false-fail", severity: "critical" },
        { id: "syntax-error", severity: "critical" },
      ];
      const result = deriveRoutingAdjustments(policies);
      assert.equal(result.length, 2);
      const sonnet = result.find((r) => r.policyId === "glob-false-fail");
      const opus = result.find((r) => r.policyId === "syntax-error");
      assert.equal(sonnet?.modelOverride, "force-sonnet");
      assert.equal(opus?.modelOverride, "block-opus");
    });

    it("produces unique adjustments even with duplicate policy IDs", () => {
      const policies = [
        { id: "lint-failure", severity: "warning" },
        { id: "lint-failure", severity: "warning" },
      ];
      const result = deriveRoutingAdjustments(policies);
      assert.equal(result.length, 1);
    });

    it("ignores unknown policy IDs without throwing", () => {
      const policies = [{ id: "completely-unknown-policy", severity: "warning" }];
      const result = deriveRoutingAdjustments(policies);
      assert.equal(result.length, 0);
    });

    it("handles hard-gated custom-recurrence- policies with force-sonnet default", () => {
      const policies = [{ id: "custom-recurrence-abc", severity: "critical", _hardGated: true }];
      const result = deriveRoutingAdjustments(policies);
      assert.equal(result.length, 1);
      assert.equal(result[0].modelOverride, "force-sonnet");
    });

    it("does not emit routing adjustment for custom-recurrence policy that is NOT hard-gated", () => {
      const policies = [{ id: "custom-recurrence-abc", severity: "warning", _hardGated: false }];
      const result = deriveRoutingAdjustments(policies);
      assert.equal(result.length, 0);
    });
  });

  describe("buildPromptHardConstraints", () => {
    it("returns empty array for null input", () => {
      assert.deepEqual(buildPromptHardConstraints(null), []);
    });

    it("returns empty array for empty policies", () => {
      assert.deepEqual(buildPromptHardConstraints([]), []);
    });

    it("maps known policy IDs to correct constraint strings", () => {
      const policies = [{ id: "missing-test", severity: "critical" }];
      const result = buildPromptHardConstraints(policies);
      assert.equal(result.length, 1);
      assert.ok(result[0].constraint.startsWith("HARD CONSTRAINT:"));
      assert.equal(result[0].blocking, true);
    });

    it("blocking flag matches the mapping definition (hardcoded-path is non-blocking)", () => {
      const policies = [{ id: "hardcoded-path", severity: "warning" }];
      const result = buildPromptHardConstraints(policies);
      assert.equal(result.length, 1);
      assert.equal(result[0].blocking, false);
    });

    it("produces unique constraints for duplicate policy IDs", () => {
      const policies = [
        { id: "lint-failure", severity: "warning" },
        { id: "lint-failure", severity: "warning" },
      ];
      const result = buildPromptHardConstraints(policies);
      assert.equal(result.length, 1);
    });

    it("generates generic constraint for hard-gated custom-recurrence policy", () => {
      const policies = [{ id: "custom-recurrence-xyz", severity: "critical", _hardGated: true, assertion: "Never delete state files" }];
      const result = buildPromptHardConstraints(policies);
      assert.equal(result.length, 1);
      assert.ok(result[0].constraint.includes("Never delete state files"));
      assert.equal(result[0].blocking, true, "critical severity must set blocking=true");
    });

    it("negative: non-hard-gated custom-recurrence policy does not produce a constraint", () => {
      const policies = [{ id: "custom-recurrence-xyz", severity: "warning", _hardGated: false }];
      const result = buildPromptHardConstraints(policies);
      assert.equal(result.length, 0);
    });
  });

  describe("truth reconciliation", () => {
    it("retires explicitly closed historical items even when the text still sounds active", () => {
      const retirement = resolveStructuredTruthRetirement(
        {
          id: "hist-1",
          status: "closed",
          finding: "Critical worker isolation gap still needs urgent follow-up",
        },
        "Critical worker isolation gap still needs urgent follow-up",
      );
      assert.ok(retirement);
      assert.match(retirement!.reason, /closed despite stale active wording/i);
    });

    it("keeps active items when no closure metadata exists", () => {
      const retirement = resolveStructuredTruthRetirement(
        {
          id: "active-1",
          status: "pending",
          finding: "Keep verification telemetry active",
        },
        "Keep verification telemetry active",
      );
      assert.equal(retirement, null);
    });

    it("demotes closed lessons and priorities into retired historical context", () => {
      const snapshot = buildPromptTruthMaintenanceSnapshot({
        signals: {
          latestMainCiConclusion: "failure",
          latestMainCiHealthy: false,
          athenaTrackedFieldsDeepEquality: false,
          preDispatchGovernanceGate: false,
          preDispatchLaneDiversityGate: false,
        },
        lessons: [
          { id: "lesson-closed", lesson: "Patch missing retry guard", status: "closed" },
          { id: "lesson-open", lesson: "Keep worker retries bounded" },
        ],
        leadershipPriorities: [
          { description: "Demote stale capability gap", lifecycleState: "resolved" },
          { description: "Protect active verifier coverage" },
        ],
      });

      assert.deepEqual(snapshot.lessons.activeText, ["Keep worker retries bounded"]);
      assert.equal(snapshot.lessons.retired.length, 1);
      assert.deepEqual(snapshot.priorities.activeText, ["Protect active verifier coverage"]);
      assert.equal(snapshot.priorities.retired.length, 1);
    });
  });

  // ── Early promotion + reason codes (Task: promote repeated unresolved lessons earlier) ─

  describe("REASON_CODES", () => {
    it("exports all required reason code constants", () => {
      assert.equal(typeof REASON_CODES.RECURRENCE_HARD_GATE, "string");
      assert.equal(typeof REASON_CODES.EARLY_RECURRENCE_WARNING, "string");
      assert.equal(typeof REASON_CODES.CARRY_FORWARD_UNRESOLVED, "string");
      assert.equal(typeof REASON_CODES.MANDATORY_ITEM_MISSING, "string");
      assert.equal(typeof REASON_CODES.PLAN_VIOLATION, "string");
    });

    it("all reason code values are unique", () => {
      const values = Object.values(REASON_CODES);
      assert.equal(values.length, new Set(values).size);
    });
  });

  describe("hardGateRecurrenceToPolicies — early promotion", () => {
    it("emits early-warning policy at earlyGateThreshold before hard gate fires", () => {
      // maxRecurrences=3, earlyGateThreshold=2. count=2 → early warning, not hard gate.
      const pms = [
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 3, earlyGateThreshold: 2 });
      assert.ok(result.newPolicies.length > 0, "at least one early-warning policy must be emitted");
      const earlyPolicy = result.newPolicies[0];
      assert.ok(earlyPolicy.id.endsWith("-early-warning"), `ID must end with -early-warning, got: ${earlyPolicy.id}`);
      assert.equal(earlyPolicy._hardGated, false);
      assert.equal(earlyPolicy.reasonCode, REASON_CODES.EARLY_RECURRENCE_WARNING);
    });

    it("emits hard-gate policy (critical, canonical ID) at maxRecurrences threshold", () => {
      const pms = [
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 3 });
      assert.ok(result.newPolicies.length > 0);
      const hardPolicy = result.newPolicies.find((p) => !p.id.endsWith("-early-warning"));
      assert.ok(hardPolicy, "must have a canonical (non-early-warning) hard gate policy");
      assert.equal(hardPolicy.severity, "critical");
      assert.equal(hardPolicy._hardGated, true);
      assert.equal(hardPolicy.reasonCode, REASON_CODES.RECURRENCE_HARD_GATE);
    });

    it("custom pattern emits early-warning escalation message when below hard threshold", () => {
      // A lesson that matches no known COMPILABLE_PATTERN → falls to custom-recurrence path.
      const pms = [
        { lessonLearned: "Unique custom problem with zorp configuration setting", followUpNeeded: true },
        { lessonLearned: "Unique custom problem with zorp configuration setting", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 3, earlyGateThreshold: 2 });
      assert.ok(result.newPolicies.length > 0);
      const earlyPolicy = result.newPolicies[0];
      assert.ok(earlyPolicy.id.endsWith("-early-warning"));
      assert.equal(earlyPolicy.reasonCode, REASON_CODES.EARLY_RECURRENCE_WARNING);
      assert.ok(result.escalations.some((e) => e.includes("approaching")), "escalation must mention approaching threshold");
    });

    it("default earlyGateThreshold is one below maxRecurrences", () => {
      // maxRecurrences=4, default earlyGateThreshold should be 3.
      const pms = Array.from({ length: 3 }, () => ({
        lessonLearned: "The glob pattern expansion fails on Windows systems",
        followUpNeeded: true,
      }));
      // count=3, maxRecurrences=4 → earlyGateThreshold=3 → should emit early warning
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 4 });
      assert.ok(result.newPolicies.some((p) => p.id.endsWith("-early-warning")));
      assert.ok(!result.newPolicies.some((p) => p._hardGated === true), "hard gate must not fire below maxRecurrences");
    });

    it("negative: count below earlyGateThreshold emits nothing", () => {
      const pms = [
        { lessonLearned: "The glob pattern expansion fails on Windows systems", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 3, earlyGateThreshold: 2 });
      assert.equal(result.newPolicies.length, 0);
    });

    it("early-warning and hard-gate policies coexist when existing list contains only the early-warning ID", () => {
      // Simulate: early warning was added last cycle; this cycle count hits maxRecurrences.
      const lesson = "The glob pattern expansion fails on Windows systems";
      const earlyWarningId = "glob-false-fail-early-warning";
      const pms = Array.from({ length: 3 }, () => ({ lessonLearned: lesson, followUpNeeded: true }));
      // Existing list already has the early-warning policy
      const result = hardGateRecurrenceToPolicies(pms, [earlyWarningId], { maxRecurrences: 3, earlyGateThreshold: 2 });
      // Hard gate must still be emitted
      assert.ok(result.newPolicies.some((p) => p.id === "glob-false-fail" && p._hardGated === true));
      // Early warning must NOT be duplicated
      assert.ok(!result.newPolicies.some((p) => p.id === earlyWarningId));
    });
  });

  describe("checkCarryForwardGate — reason codes", () => {
    it("returns CARRY_FORWARD_UNRESOLVED reason code when unresolved lessons block", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Fix the recurring blocker issue", lessonLearned: "a" },
        { followUpNeeded: true, followUpTask: "Fix the recurring blocker issue", lessonLearned: "b" },
        { followUpNeeded: true, followUpTask: "Fix the recurring blocker issue", lessonLearned: "c" },
      ];
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 2 });
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reasonCode, REASON_CODES.CARRY_FORWARD_UNRESOLVED);
    });

    it("returns MANDATORY_ITEM_MISSING reason code when only mandatory items are missing", () => {
      const result = checkCarryForwardGate([], [], { mandatoryCarryForward: ["Must fix thing X now"] });
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reasonCode, REASON_CODES.MANDATORY_ITEM_MISSING);
    });

    it("returns null reasonCode when shouldBlock is false", () => {
      const result = checkCarryForwardGate([], []);
      assert.equal(result.shouldBlock, false);
      assert.equal(result.reasonCode, null);
    });

    it("CARRY_FORWARD_UNRESOLVED takes priority when both unresolved and mandatory issues exist", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Persistent issue that must be fixed today", lessonLearned: "1" },
        { followUpNeeded: true, followUpTask: "Persistent issue that must be fixed today", lessonLearned: "2" },
        { followUpNeeded: true, followUpTask: "Persistent issue that must be fixed today", lessonLearned: "3" },
      ];
      const result = checkCarryForwardGate(pms, [], {
        maxUnresolvedCycles: 2,
        mandatoryCarryForward: ["Mandatory item not in plans at all"],
      });
      assert.equal(result.shouldBlock, true);
      assert.equal(result.reasonCode, REASON_CODES.CARRY_FORWARD_UNRESOLVED);
    });
  });

  describe("validatePlanAgainstPolicies — reason codes", () => {
    it("violation includes PLAN_VIOLATION reason code", () => {
      const plan = { task: "Run tests", verification: "node --test tests/**/*.test.ts" };
      const policies = [{ id: "glob-false-fail", assertion: "Use npm test", severity: "critical" }];
      const result = validatePlanAgainstPolicies(plan, policies);
      assert.equal(result.ok, false);
      assert.equal(result.violations[0].reasonCode, REASON_CODES.PLAN_VIOLATION);
    });
  });
});

// ── Task: closure evidence and retirement criteria ─────────────────────────────

import {
  buildPolicyClosureEvidence,
  evaluateRetirementEligibility,
  filterRetiredPolicies,
  RETIREMENT_MIN_CLOSURES,
  RETIREMENT_MIN_CLEAN_CYCLES,
  buildPolicyImpactAttribution,
  applyPolicyHalfLifeRetirement,
} from "../../src/core/learning_policy_compiler.js";

describe("buildPolicyClosureEvidence", () => {
  it("creates a closure evidence record with required fields", () => {
    const evidence = buildPolicyClosureEvidence("glob-false-fail", "Issue resolved by switching to npm test");
    assert.equal(evidence.policyId, "glob-false-fail");
    assert.equal(typeof evidence.resolvedAt, "string");
    assert.equal(evidence.resolvedBy, "manual");
    assert.ok(evidence.evidence.includes("npm test"));
  });

  it("accepts resolvedBy and cycleId overrides", () => {
    const evidence = buildPolicyClosureEvidence("lint-failure", "Lint fixed", { resolvedBy: "health-audit", cycleId: "cycle-001" });
    assert.equal(evidence.resolvedBy, "health-audit");
    assert.equal(evidence.cycleId, "cycle-001");
  });

  it("truncates evidence to 500 characters", () => {
    const long = "x".repeat(600);
    const evidence = buildPolicyClosureEvidence("lint-failure", long);
    assert.ok(evidence.evidence.length <= 500);
  });

  it("negative: throws when policyId is empty", () => {
    assert.throws(() => buildPolicyClosureEvidence("", "evidence"), /policyId is required/);
  });
});

describe("evaluateRetirementEligibility", () => {
  it("returns eligible=false when no closure evidence exists", () => {
    const result = evaluateRetirementEligibility("glob-false-fail", [], [], {});
    assert.equal(result.eligible, false);
    assert.ok(result.reason.includes("Insufficient closure evidence"));
    assert.equal(result.closureCount, 0);
  });

  it("returns eligible=false when not enough clean cycles have passed", () => {
    const closure = buildPolicyClosureEvidence("glob-false-fail", "Fixed");
    // Only 1 clean postmortem after closure (minCleanCycles=3 by default)
    const pms = [{ lessonLearned: "unrelated lesson", reviewedAt: new Date().toISOString() }];
    const result = evaluateRetirementEligibility("glob-false-fail", [closure], pms, {});
    assert.equal(result.eligible, false);
    assert.ok(result.reason.includes("Insufficient clean cycles"));
  });

  it("returns eligible=true when closure evidence and enough clean cycles exist", () => {
    // Create a closure in the past
    const past = new Date(Date.now() - 10_000).toISOString();
    const closure = { policyId: "lint-failure", resolvedAt: past, resolvedBy: "manual", evidence: "fixed" };
    // 3 clean postmortems after closure (matching the minCleanCycles default)
    const pms = Array.from({ length: 3 }, (_, i) => ({
      lessonLearned: "Improved documentation coverage",
      reviewedAt: new Date(Date.now() - (9_000 - i * 100)).toISOString(),
    }));
    const result = evaluateRetirementEligibility("lint-failure", [closure], pms, { minCleanCycles: 3 });
    assert.equal(result.eligible, true);
    assert.equal(result.closureCount, 1);
    assert.equal(result.cyclesSinceClosure, 3);
  });

  it("returns eligible=false when lesson recurs after closure", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const closure = { policyId: "glob-false-fail", resolvedAt: past, resolvedBy: "manual", evidence: "fixed" };
    // A postmortem AFTER closure that triggers the glob pattern
    const pms = [
      { lessonLearned: "The glob pattern fails on Windows again", reviewedAt: new Date(Date.now() - 5_000).toISOString() },
    ];
    const result = evaluateRetirementEligibility("glob-false-fail", [closure], pms, { minCleanCycles: 1 });
    assert.equal(result.eligible, false);
    assert.ok(result.reason.includes("recurrence"));
  });

  it("negative: no postmortems after closure counts zero clean cycles", () => {
    const closure = buildPolicyClosureEvidence("syntax-error", "Fixed");
    const result = evaluateRetirementEligibility("syntax-error", [closure], [], { minCleanCycles: 1 });
    assert.equal(result.eligible, false);
    assert.equal(result.cyclesSinceClosure, 0);
  });

  it("RETIREMENT_MIN_CLOSURES defaults are exported as positive integers", () => {
    assert.ok(RETIREMENT_MIN_CLOSURES >= 1);
    assert.ok(RETIREMENT_MIN_CLEAN_CYCLES >= 1);
  });
});

describe("filterRetiredPolicies", () => {
  it("returns all active when no closure evidence exists", () => {
    const policies = [
      { id: "glob-false-fail", severity: "critical" },
      { id: "lint-failure", severity: "warning" },
    ];
    const { active, retired } = filterRetiredPolicies(policies, [], []);
    assert.equal(active.length, 2);
    assert.equal(retired.length, 0);
  });

  it("moves eligible policy to retired list", () => {
    const past = new Date(Date.now() - 10_000).toISOString();
    const closure = { policyId: "lint-failure", resolvedAt: past, resolvedBy: "manual", evidence: "fixed" };
    const pms = Array.from({ length: 3 }, (_, i) => ({
      lessonLearned: "Improved documentation coverage",
      reviewedAt: new Date(Date.now() - (9_000 - i * 100)).toISOString(),
    }));
    const policies = [{ id: "lint-failure", severity: "warning" }];
    const { active, retired } = filterRetiredPolicies(policies, [closure], pms, { minCleanCycles: 3 });
    assert.equal(retired.length, 1, "lint-failure must be retired");
    assert.equal(active.length, 0);
    assert.ok(retired[0]._retiredAt, "_retiredAt must be set");
    assert.ok(typeof retired[0]._retirementReason === "string");
  });

  it("negative: returns empty active and retired for non-array input", () => {
    const { active, retired } = filterRetiredPolicies(null as any, [], []);
    assert.deepEqual(active, []);
    assert.deepEqual(retired, []);
  });
});

describe("buildPolicyImpactAttribution", () => {
  it("builds improved attribution with half-life metrics", () => {
    const attribution = buildPolicyImpactAttribution(
      { id: "glob-false-fail", _inactiveCycles: 0 },
      { policyId: "glob-false-fail", improvementRate: 0.8 } as any,
      0.4,
      0.6,
      { cycleId: "cycle-1", halfLifeCycles: 3 },
    );
    assert.equal(attribution.policyId, "glob-false-fail");
    assert.equal(attribution.cycleId, "cycle-1");
    assert.equal(attribution.improved, true);
    assert.equal(attribution.inactiveCycles, 0);
    assert.ok(attribution.halfLifeWeight > 0);
    assert.ok(attribution.decayedEffectiveness > 0);
    assert.equal(attribution.shouldRetire, false);
  });

  it("negative: marks policy for retirement when ineffective over inactive cycles", () => {
    const attribution = buildPolicyImpactAttribution(
      { id: "lint-failure", _inactiveCycles: 3 },
      { policyId: "lint-failure", improvementRate: 0.1 } as any,
      0.7,
      0.69,
      { minEffectiveness: 0.2, minInactiveCycles: 2, halfLifeCycles: 2 },
    );
    assert.equal(attribution.improved, false);
    assert.ok(attribution.inactiveCycles >= 4);
    assert.equal(attribution.shouldRetire, true);
  });
});

describe("applyPolicyHalfLifeRetirement", () => {
  it("adds _halfLifeWeight on active policies", () => {
    const result = applyPolicyHalfLifeRetirement(
      [{ id: "policy-a", _inactiveCycles: 1 }],
      [{ policyId: "policy-a", improvementRate: 0.9 } as any],
      { halfLifeCycles: 3, minEffectiveness: 0.1, minInactiveCycles: 3 },
    );
    assert.equal(result.retired.length, 0);
    assert.equal(result.active.length, 1);
    assert.ok(typeof result.active[0]._halfLifeWeight === "number");
    assert.ok(typeof result.active[0]._decayedEffectiveness === "number");
  });
});

// ── Curriculum-based policy promotion ─────────────────────────────────────────

describe("compileCurriculumToPolicies", () => {
  it("returns empty array for null input", () => {
    assert.deepEqual(compileCurriculumToPolicies(null as any), []);
  });

  it("returns empty array for empty curriculum", () => {
    assert.deepEqual(compileCurriculumToPolicies([]), []);
  });

  it("exports CURRICULUM_PROMOTION_THRESHOLD as a number >= 0 and <= 1", () => {
    assert.equal(typeof CURRICULUM_PROMOTION_THRESHOLD, "number");
    assert.ok(CURRICULUM_PROMOTION_THRESHOLD >= 0 && CURRICULUM_PROMOTION_THRESHOLD <= 1);
  });

  it("compiles a glob-matching curriculum item to a curriculum-prefixed policy", () => {
    const items = [
      { lesson: "The glob pattern expansion fails on Windows due to path issues", weight: 0.8, researchBacked: false, reviewedAt: "2026-01-01T00:00:00Z" },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0, "at least one policy must be emitted");
    const p = policies[0];
    assert.ok(p.id.startsWith("curriculum-"), `ID must start with 'curriculum-', got: ${p.id}`);
    assert.equal(typeof p.assertion, "string");
    assert.ok(["critical", "warning"].includes(p.severity));
  });

  it("promotes research-backed items to critical severity", () => {
    const items = [
      { lesson: "The glob pattern expansion fails on Windows", weight: 0.6, researchBacked: true, reviewedAt: "2026-01-01T00:00:00Z" },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0);
    assert.equal(policies[0].severity, "critical", "research-backed items must be promoted to critical");
    assert.equal(policies[0]._researchBacked, true);
  });

  it("non-research-backed items keep pattern severity (not forced to critical)", () => {
    const items = [
      { lesson: "Run npm run lint before shipping to catch unused imports", weight: 0.5, researchBacked: false },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0);
    // lint-failure pattern has severity "warning" — should NOT be forced to critical
    assert.equal(policies[0].severity, "warning");
    assert.equal(policies[0]._researchBacked, false);
  });

  it("produces generic curriculum-custom- policy when no pattern matches", () => {
    const items = [
      { lesson: "Always validate zorp configuration schema before deployment", weight: 0.7, researchBacked: false },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0);
    assert.ok(policies[0].id.startsWith("curriculum-custom-"), `expected curriculum-custom- prefix, got: ${policies[0].id}`);
    assert.ok(policies[0].assertion.includes("Curriculum lesson"));
  });

  it("deduplicates policies when two items match the same pattern", () => {
    const items = [
      { lesson: "The glob pattern fails on Windows again", weight: 0.8, researchBacked: false },
      { lesson: "Another glob wildcard issue in test command output", weight: 0.6, researchBacked: false },
    ];
    const policies = compileCurriculumToPolicies(items);
    const ids = policies.map(p => p.id);
    assert.equal(ids.length, new Set(ids).size, "policy IDs must be unique");
  });

  it("excludes items already in existingPolicyIds", () => {
    const items = [
      { lesson: "The glob pattern expansion fails on Windows", weight: 0.8, researchBacked: false },
    ];
    // Pre-populate the existing set with the expected curriculum-prefixed ID
    const policies = compileCurriculumToPolicies(items, { existingPolicyIds: ["curriculum-glob-false-fail"] });
    const ids = policies.map(p => p.id);
    assert.ok(!ids.includes("curriculum-glob-false-fail"), "already-existing policy must not be re-emitted");
  });

  it("emits RECURRENCE_HARD_GATE reasonCode on all curriculum policies", () => {
    const items = [
      { lesson: "The glob pattern expansion fails", weight: 0.9, researchBacked: true },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0);
    assert.equal(policies[0].reasonCode, REASON_CODES.RECURRENCE_HARD_GATE);
  });

  it("attaches _curriculumWeight to emitted policies", () => {
    const items = [
      { lesson: "The glob pattern expansion fails on Windows", weight: 0.75, researchBacked: false },
    ];
    const policies = compileCurriculumToPolicies(items);
    assert.ok(policies.length > 0);
    assert.equal(policies[0]._curriculumWeight, 0.75);
  });

  it("negative: skips items with lesson shorter than 5 characters", () => {
    const items = [{ lesson: "hi", weight: 0.9, researchBacked: true }];
    assert.deepEqual(compileCurriculumToPolicies(items), []);
  });
});

describe("policy mutation evidence window", () => {
  it("requires full 3-cycle evidence window before mutating", () => {
    const policies = [{ id: "glob-false-fail", severity: "critical" }];
    const evidence = [
      buildInterventionRubricScore("inv-1", "cycle-1", "glob-false-fail", {
        architecture: 0.7,
        speed: 0.7,
        "task-quality": 0.7,
        "prompt-quality": 0.7,
        "parser-quality": 0.7,
        "worker-specialization": 0.7,
        "model-task-fit": 0.7,
        "learning-loop": 0.7,
        "cost-efficiency": 0.7,
        security: 0.7,
      }, 0.8),
      buildInterventionRubricScore("inv-2", "cycle-2", "glob-false-fail", {
        architecture: 0.8,
        speed: 0.8,
        "task-quality": 0.8,
        "prompt-quality": 0.8,
        "parser-quality": 0.8,
        "worker-specialization": 0.8,
        "model-task-fit": 0.8,
        "learning-loop": 0.8,
        "cost-efficiency": 0.8,
        security: 0.8,
      }, 0.8),
    ];
    const result = decidePolicyMutationsFromEvidenceWindow(policies, evidence);
    assert.equal(result.routed.length, 0);
    assert.equal(result.promptConstraints.length, 0);
    assert.equal(result.deferred.length, 1);
    assert.ok(result.deferred[0].reason.includes("insufficient_evidence_window"));
  });

  it("mutates only after 3-cycle evidence window passes threshold", () => {
    const policies = [{ id: "glob-false-fail", severity: "critical" }];
    const evidence = [
      buildInterventionRubricScore("inv-1", "cycle-1", "glob-false-fail", {
        architecture: 0.8,
        speed: 0.8,
        "task-quality": 0.8,
        "prompt-quality": 0.8,
        "parser-quality": 0.8,
        "worker-specialization": 0.8,
        "model-task-fit": 0.8,
        "learning-loop": 0.8,
        "cost-efficiency": 0.8,
        security: 0.8,
      }, 0.8),
      buildInterventionRubricScore("inv-2", "cycle-2", "glob-false-fail", {
        architecture: 0.7,
        speed: 0.7,
        "task-quality": 0.7,
        "prompt-quality": 0.7,
        "parser-quality": 0.7,
        "worker-specialization": 0.7,
        "model-task-fit": 0.7,
        "learning-loop": 0.7,
        "cost-efficiency": 0.7,
        security: 0.7,
      }, 0.8),
      buildInterventionRubricScore("inv-3", "cycle-3", "glob-false-fail", {
        architecture: 0.7,
        speed: 0.7,
        "task-quality": 0.7,
        "prompt-quality": 0.7,
        "parser-quality": 0.7,
        "worker-specialization": 0.7,
        "model-task-fit": 0.7,
        "learning-loop": 0.7,
        "cost-efficiency": 0.7,
        security: 0.7,
      }, 0.7),
    ];
    const result = decidePolicyMutationsFromEvidenceWindow(
      policies,
      evidence,
      { evidenceWindowCycles: POLICY_MUTATION_EVIDENCE_WINDOW },
    );
    assert.equal(result.deferred.length, 0);
    assert.equal(result.routed.length, 1);
    assert.equal(result.promptConstraints.length, 1);
    assert.equal(result.decisions[0].mutate, true);
  });
});

// ── retireLowYieldPolicyFamilies ──────────────────────────────────────────────

describe("retireLowYieldPolicyFamilies", () => {
  it("retires policies with avg effectiveness below threshold when sufficient evidence exists", () => {
    const policies = [{ id: "glob-false-fail", severity: "critical" }];
    const attributions = [
      { policyId: "glob-false-fail", decayedEffectiveness: 0.05 },
      { policyId: "glob-false-fail", decayedEffectiveness: 0.08 },
    ];
    const { active, retired } = retireLowYieldPolicyFamilies(policies, attributions);
    assert.equal(retired.length, 1, "low-yield policy must be retired");
    assert.equal(active.length, 0);
    assert.ok(retired[0]._retirementReason.includes("Low-yield"));
    assert.ok(typeof retired[0]._avgDecayedEffectiveness === "number");
  });

  it("keeps policies with avg effectiveness above threshold", () => {
    const policies = [{ id: "lint-failure", severity: "warning" }];
    const attributions = [
      { policyId: "lint-failure", decayedEffectiveness: 0.8 },
      { policyId: "lint-failure", decayedEffectiveness: 0.9 },
    ];
    const { active, retired } = retireLowYieldPolicyFamilies(policies, attributions);
    assert.equal(active.length, 1, "effective policy must remain active");
    assert.equal(retired.length, 0);
  });

  it("keeps policies with fewer than minEvidenceRecords records", () => {
    const policies = [{ id: "import-error", severity: "critical" }];
    const attributions = [
      { policyId: "import-error", decayedEffectiveness: 0.02 },
      // only 1 record, below default min of 2
    ];
    const { active, retired } = retireLowYieldPolicyFamilies(policies, attributions, { minEvidenceRecords: 2 });
    assert.equal(active.length, 1, "insufficient evidence must not trigger retirement");
    assert.equal(retired.length, 0);
  });

  it("respects retireOnlySeverities filter", () => {
    const policies = [
      { id: "glob-false-fail", severity: "critical" },
      { id: "lint-failure", severity: "warning" },
    ];
    const attributions = [
      { policyId: "glob-false-fail", decayedEffectiveness: 0.02 },
      { policyId: "glob-false-fail", decayedEffectiveness: 0.03 },
      { policyId: "lint-failure", decayedEffectiveness: 0.02 },
      { policyId: "lint-failure", decayedEffectiveness: 0.03 },
    ];
    // Only retire warnings, not criticals
    const { active, retired } = retireLowYieldPolicyFamilies(policies, attributions, {
      retireOnlySeverities: ["warning"],
    });
    assert.equal(retired.length, 1, "only warning severity must be retired");
    assert.equal(retired[0].id, "lint-failure");
    assert.ok(active.some((p: any) => p.id === "glob-false-fail"), "critical must remain active");
  });

  it("negative: returns all active for empty attribution records", () => {
    const policies = [{ id: "state-corruption", severity: "critical" }];
    const { active, retired } = retireLowYieldPolicyFamilies(policies, []);
    assert.equal(active.length, 1);
    assert.equal(retired.length, 0);
  });

  it("LOW_YIELD_IMPACT_THRESHOLD is a small positive number", () => {
    assert.ok(LOW_YIELD_IMPACT_THRESHOLD > 0);
    assert.ok(LOW_YIELD_IMPACT_THRESHOLD < 0.5);
  });

  it("LOW_YIELD_MIN_EVIDENCE_RECORDS is at least 1", () => {
    assert.ok(LOW_YIELD_MIN_EVIDENCE_RECORDS >= 1);
  });
});

// ── Task 4: uplift binding — evidence window gates policy mutation ─────────────

describe("decidePolicyMutationsFromEvidenceWindow — uplift binding", () => {
  it("negative path: returns empty routed when evidence window is insufficient", () => {
    const policies = [{ id: "low-signal-policy", severity: "warning" }];
    // Only 1 evidence record — below the POLICY_MUTATION_EVIDENCE_WINDOW threshold.
    const evidence = [
      buildInterventionRubricScore("inv-1", "cycle-1", "low-signal-policy", {
        architecture: 0.6, speed: 0.6, "task-quality": 0.6,
      }, 0.7),
    ];
    const result = decidePolicyMutationsFromEvidenceWindow(policies, evidence);
    assert.equal(result.routed.length, 0,
      "insufficient evidence window must NOT produce policy mutations");
    assert.equal(result.deferred.length, 1,
      "policy with insufficient evidence must be deferred, not routed");
  });

  it("POLICY_MUTATION_EVIDENCE_WINDOW is exported as a positive integer", () => {
    assert.ok(typeof POLICY_MUTATION_EVIDENCE_WINDOW === "number",
      "POLICY_MUTATION_EVIDENCE_WINDOW must be a number");
    assert.ok(POLICY_MUTATION_EVIDENCE_WINDOW >= 1,
      "evidence window must be at least 1 cycle");
    assert.ok(Number.isInteger(POLICY_MUTATION_EVIDENCE_WINDOW),
      "evidence window must be an integer");
  });

  it("buildInterventionRubricScore returns a record with required fields", () => {
    const score = buildInterventionRubricScore("inv-x", "cycle-x", "policy-x", {
      architecture: 0.75, speed: 0.8,
    }, 0.9);
    assert.equal(score.interventionId, "inv-x", "interventionId must match");
    assert.equal(score.policyId, "policy-x", "policyId must match");
    assert.ok(typeof score.rubricScore === "number", "rubricScore must be a number");
    assert.ok(typeof score.combinedScore === "number", "combinedScore must be a number");
    assert.ok(typeof score.scoredAt === "string", "scoredAt must be an ISO string");
  });

  it("records explicit no-signal intervention evidence for later retirement windows", () => {
    const score = buildInterventionRubricScore("inv-no-signal", "cycle-y", "policy-y", {
      architecture: 0.7,
      speed: 0.7,
    }, 0.35, {
      closureMode: "no_signal",
      decisionMode: "retry_review",
      lineageId: "lineage-1",
      interventionType: "retry_intervention",
    });
    assert.equal(score.outcomeStatus, "no_signal");
    assert.equal(score.noSignalOutcome, true);
    assert.equal(score.decisionMode, "retry_review");
    assert.equal(score.lineageId, "lineage-1");
    assert.equal(score.interventionType, "retry_intervention");
  });
});

describe("impact-attributed policy loop", () => {
  it("records improved policy evidence with reversible metadata", () => {
    const attribution = buildPolicyImpactAttribution(
      { id: "glob-false-fail", _inactiveCycles: 0 },
      { policyId: "glob-false-fail", totalMeasurements: 3, improvedCount: 2, ineffectiveCount: 1, improvementRate: 0.667, lastDelta: 0.08, lastMeasuredAt: "2026-04-01T00:00:00.000Z" } as any,
      0.4,
      0.62,
      { cycleId: "cycle-impact-1", minImprovementDelta: 0.05 },
    );
    assert.equal(attribution.outcomeStatus, "improved");
    assert.equal(attribution.shouldRetire, false);
    assert.equal(attribution.reversible, true);
    assert.ok(attribution.reactivateWhen.includes("delta >="));
  });

  it("marks a policy as should_retire after a full low-signal evidence window", () => {
    const policies = [{ id: "lint-failure", severity: "warning" }];
    const evidence = [
      buildInterventionRubricScore("inv-1", "cycle-1", "lint-failure", { architecture: 0.3 }, 0.1, { outcomeStatus: "should_retire" }),
      buildInterventionRubricScore("inv-2", "cycle-2", "lint-failure", { architecture: 0.2 }, 0.15, { outcomeStatus: "should_retire" }),
      buildInterventionRubricScore("inv-3", "cycle-3", "lint-failure", { architecture: 0.2 }, 0.2, { outcomeStatus: "should_retire" }),
    ];
    const result = decidePolicyMutationsFromEvidenceWindow(policies, evidence, {
      evidenceWindowCycles: 3,
      retireCombinedScore: POLICY_MUTATION_RETIRE_COMBINED_SCORE,
    });
    assert.equal(result.decisions.length, 1);
    assert.equal(result.decisions[0].outcomeStatus, "should_retire");
    assert.equal(result.decisions[0].shouldRetire, true);
    assert.equal(result.decisions[0].mutate, false);
    assert.equal(result.decisions[0].reversible, true);
    assert.ok(result.decisions[0].reactivateWhen.includes("improved evidence point"));
  });

  it("attaches reversible retirement ledger metadata to low-yield retired policies", () => {
    const policies = [{ id: "policy-z", severity: "warning" }];
    const attributions = [
      { policyId: "policy-z", decayedEffectiveness: 0.05 },
      { policyId: "policy-z", decayedEffectiveness: 0.04 },
      { policyId: "policy-z", decayedEffectiveness: 0.03 },
    ];
    const result = retireLowYieldPolicyFamilies(policies, attributions as any, {
      minEvidenceRecords: 3,
      lowYieldThreshold: 0.1,
    });
    assert.equal(result.retired.length, 1);
    assert.equal(result.retired[0]._impactOutcomeStatus, "should_retire");
    assert.equal(result.retired[0]._retirementReversible, true);
    assert.ok(result.retired[0]._retirementLedger);
    assert.ok(result.retired[0]._reactivateWhen.includes("improved evidence point"));
  });
});

describe("lineage-backed learned policy lifecycle", () => {
  it("persists active policies while the verified lineage window is still open", () => {
    const decision = evaluatePolicyLifecycleWindow(
      { id: "glob-false-fail", retirementCriteria: { minEvidenceWindow: 3 } },
      [
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l1", outcomeStatus: "no_signal", outcomeScore: 0.4, recordedAt: "2026-04-15T00:00:00.000Z" },
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l2", outcomeStatus: "no_signal", outcomeScore: 0.45, recordedAt: "2026-04-15T01:00:00.000Z" },
      ],
    );

    assert.equal(decision.shouldRetire, false);
    assert.equal(decision.upliftSignal, LEARNED_POLICY_UPLIFT_SIGNAL.AWAITING_VERIFIED_OUTCOME_WINDOW);
  });

  it("retires active policies from a verified low-yield lineage window", () => {
    const result = reconcilePolicyLifecycleByLineageWindow(
      [{ id: "glob-false-fail", severity: "critical" }],
      [],
      [
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l1", outcomeStatus: "should_retire", outcomeScore: 0.1, recordedAt: "2026-04-15T00:00:00.000Z" },
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l2", outcomeStatus: "should_retire", outcomeScore: 0.12, recordedAt: "2026-04-15T01:00:00.000Z" },
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l3", outcomeStatus: "should_retire", outcomeScore: 0.15, recordedAt: "2026-04-15T02:00:00.000Z" },
      ],
    );

    assert.equal(result.active.length, 0);
    assert.equal(result.retired.length, 1);
    assert.equal(result.retired[0].upliftSignal, LEARNED_POLICY_UPLIFT_SIGNAL.VERIFIED_RETIRED);
    assert.equal(result.retired[0]._retirementStrategy, "lineage_verified_window");
  });

  it("reactivates retired policies after consecutive improved lineage-backed outcomes", () => {
    const result = reconcilePolicyLifecycleByLineageWindow(
      [],
      [{ id: "glob-false-fail", severity: "critical", _retiredAt: "2026-04-14T00:00:00.000Z" }],
      [
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l4", outcomeStatus: "improved", outcomeScore: 0.8, recordedAt: "2026-04-15T00:00:00.000Z" },
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l5", outcomeStatus: "improved", outcomeScore: 0.85, recordedAt: "2026-04-15T01:00:00.000Z" },
        { policyId: "glob-false-fail", lineageJoinKey: "lineage:l6", outcomeStatus: "improved", outcomeScore: 0.9, recordedAt: "2026-04-15T02:00:00.000Z" },
      ],
    );

    assert.equal(result.reactivated.length, 1);
    assert.equal(result.active.length, 1);
    assert.equal(result.active[0].upliftSignal, LEARNED_POLICY_UPLIFT_SIGNAL.VERIFIED_REACTIVATED);
  });
});
