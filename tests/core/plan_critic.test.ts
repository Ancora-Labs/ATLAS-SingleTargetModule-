import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { critiquePlan, runCriticPass, CRITIC_DIMENSION, CRITIC_PASS_THRESHOLD, evaluateACRichness, repairPlan, dualPassCriticRepair, AC_RICHNESS_THRESHOLD, scoreCandidateSetWithGates, selectBestCandidateSet } from "../../src/core/plan_critic.js";
import { MAX_ACCEPTANCE_CRITERIA_PER_TASK, MAX_FILES_IN_SCOPE_PER_TASK } from "../../src/core/plan_contract_validator.js";

describe("plan_critic", () => {
  describe("critiquePlan", () => {
    it("returns failed for null plan", () => {
      const result = critiquePlan(null);
      assert.equal(result.passed, false);
      assert.equal(result.score, 0);
    });

    it("passes a well-formed plan", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes; npm run lint passes",
        context: "src/core/config.js needs input validation",
        dependencies: ["setup-tests"],
        riskLevel: "low",
      };
      const result = critiquePlan(plan);
      assert.equal(result.passed, true);
      assert.ok(result.score >= CRITIC_PASS_THRESHOLD);
      assert.ok(result.issues.length === 0 || result.score > 0);
    });

    it("flags vague task", () => {
      const plan = { task: "Improve things", verification: "" };
      const result = critiquePlan(plan);
      assert.ok(result.issues.some(i => /vague/i.test(i)));
      assert.equal(result.dimensions[CRITIC_DIMENSION.NO_VAGUE_TASK], 0);
    });

    it("flags missing verification", () => {
      const plan = { task: "Add feature to src/core/foo.js", verification: "" };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION], 0);
    });

    it("scores partial credit for text-only verification", () => {
      const plan = {
        task: "Update src/core/logger.js formatting",
        verification: "Manually verify that logs are properly formatted after the change",
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION], 0.5);
    });

    it("detects scope from file extensions", () => {
      const plan = { task: "Update schema_registry.js exports" };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE], 1.0);
    });

    it("scores HAS_LEVERAGE_RANK=1.0 when leverage_rank is non-empty", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes",
        leverage_rank: ["task-quality", "architecture"],
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_LEVERAGE_RANK], 1.0);
      assert.ok(!result.issues.some(i => /leverage_rank/i.test(i)));
    });

    it("scores HAS_LEVERAGE_RANK=0.3 when leverage_rank is missing", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes",
        // no leverage_rank
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_LEVERAGE_RANK], 0.3);
      assert.ok(result.issues.some(i => /leverage_rank/i.test(i)));
    });

    it("scores HAS_LEVERAGE_RANK=0.3 when leverage_rank is an empty array", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes",
        leverage_rank: [],
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_LEVERAGE_RANK], 0.3);
    });

    it("scores BALANCED_DIMENSIONS > 0 when leverage_rank maps to canonical dimensions", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes",
        leverage_rank: ["quality", "learning loop", "routing"],
        capacityDelta: 0.2,
        requestROI: 2.2,
      };
      const result = critiquePlan(plan);
      assert.ok(result.dimensions[CRITIC_DIMENSION.BALANCED_DIMENSIONS] > 0);
      assert.equal(result.dimensions[CRITIC_DIMENSION.CAPACITY_FIRST], 1.0);
    });

    it("penalizes defensive-only rigid tasks", () => {
      const plan = {
        task: "Block all risky worker actions with hard gate",
        verification: "npm test passes",
        leverage_rank: ["security"],
        capacityDelta: 0.2,
        requestROI: 2.0,
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.NON_RIGID_PLAN], 0.0);
      assert.ok(result.issues.some(i => /rigid/i.test(i)));
    });

    it("negative path: missing capacity-first fields fails CAPACITY_FIRST dimension", () => {
      const plan = {
        task: "Implement parser improvements in src/core/parser.ts",
        verification: "npm test passes",
        leverage_rank: ["parser-quality"],
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.CAPACITY_FIRST], 0.0);
    });

    it("flags redundant packets without implementation evidence", () => {
      const plan = {
        task: "Already implemented parser hardening task",
        verification: "npm test passes",
        implementationStatus: "implemented_correctly",
        capacityDelta: 0.2,
        requestROI: 2.0,
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.IMPLEMENTATION_EVIDENCE], 0.0);
      assert.ok(result.issues.some(i => /implementationEvidence/i.test(i)));
    });

    it("passes implementation-evidence dimension when redundant packet includes evidence and capacity-first metrics", () => {
      const plan = {
        task: "Already implemented parser hardening task",
        verification: "npm test passes",
        implementationStatus: "implemented_correctly",
        implementationEvidence: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
        capacityDelta: 0.2,
        requestROI: 2.0,
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.IMPLEMENTATION_EVIDENCE], 1.0);
    });
  });

  describe("runCriticPass", () => {
    it("returns empty for non-array input", () => {
      const result = runCriticPass(null);
      assert.deepEqual(result, { approved: [], rejected: [], results: [] });
    });

    it("separates approved and rejected plans", () => {
      const plans = [
        { task: "Add test for src/core/foo.js", verification: "npm test passes", riskLevel: "low", dependencies: ["a"] },
        { task: "Improve", verification: "" },
      ];
      const result = runCriticPass(plans);
      assert.equal(result.approved.length + result.rejected.length, 2);
      assert.equal(result.results.length, 2);
    });

    it("uses custom threshold", () => {
      const plans = [{ task: "Update src/core/foo.js", verification: "short" }];
      const result = runCriticPass(plans, { threshold: 0.01 });
      assert.equal(result.approved.length, 1);
    });
  });

  describe("evaluateACRichness (Packet 9)", () => {
    it("returns score 0 for plan with no AC", () => {
      const result = evaluateACRichness({ task: "Something" });
      assert.equal(result.score, 0);
      assert.equal(result.passed, false);
    });

    it("returns score 0 for empty AC array", () => {
      const result = evaluateACRichness({ acceptance_criteria: [] });
      assert.equal(result.score, 0);
      assert.equal(result.passed, false);
    });

    it("returns positive score for rich AC", () => {
      const result = evaluateACRichness({
        acceptance_criteria: ["npm test passes with 0 failures", "Build completes without errors"],
        verification: "npm test",
      });
      assert.ok(result.score > 0);
    });

    it("scores higher for measurable AC", () => {
      const richResult = evaluateACRichness({
        acceptance_criteria: ["npm test passes with 0 failures", "Coverage > 80%"],
        verification: "npm test && npm run coverage",
      });
      const poorResult = evaluateACRichness({
        acceptance_criteria: ["looks good"],
      });
      assert.ok(richResult.score > poorResult.score);
    });
  });

  describe("repairPlan (Packet 7)", () => {
    it("returns repaired plan object", () => {
      const plan = { task: "Fix src/core/foo.js error handling" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan);
      assert.ok(typeof result.repaired === "boolean");
      assert.ok(Array.isArray(result.repairs));
    });

    it("does not overwrite existing AC when they pass", () => {
      const plan = { task: "Fix something in src/core/foo.js", acceptance_criteria: ["All tests pass"], verification: "npm test" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan.acceptance_criteria.includes("All tests pass"));
    });

    it("adds verification when missing", () => {
      const plan = { task: "Fix src/core/foo.js logic" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan.verification);
    });
  });

  describe("dualPassCriticRepair (Packet 7)", () => {
    it("returns repaired plans array", () => {
      const plans = [
        { task: "Valid plan with detail here", verification: "npm test", acceptance_criteria: ["pass"] },
        { task: "Vague plan without any details" },
      ];
      const result = dualPassCriticRepair(plans);
      assert.ok(Array.isArray(result.plans));
      assert.equal(result.plans.length, 2);
    });

    it("attaches critic scores", () => {
      const plans = [{ task: "Add feature to src/core/foo.js", verification: "npm test", acceptance_criteria: ["ok"] }];
      const result = dualPassCriticRepair(plans);
      assert.ok(typeof result.plans[0]._criticScore === "number");
    });
  });

  describe("candidate-set gate-aware scoring", () => {
    const strongPlan = {
      task: "Wire bounded candidate selection into src/core/prometheus.ts",
      verification: "npm test -- tests/core/prometheus_parse.test.ts",
      context: "src/core/prometheus.ts selects a gated candidate plan set before repair",
      leverage_rank: ["task-quality", "worker-specialization"],
      capacityDelta: 0.2,
      requestROI: 1.4,
      acceptance_criteria: ["candidate selection keeps >= 1 dispatchable plan", "stale candidates are demoted with 0 regressions"],
      target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
      riskLevel: "low",
    };

    it("reduces effectiveScore when freshness penalty and viability loss are present", () => {
      const base = scoreCandidateSetWithGates([strongPlan]);
      const gated = scoreCandidateSetWithGates([strongPlan], {
        contractPassRate: 0.5,
        viablePlanCount: 0,
        freshnessPenalty: 0.4,
      });
      assert.ok(gated.effectiveScore < base.effectiveScore);
      assert.equal(gated.contractPassRate, 0.5);
      assert.equal(gated.viableRatio, 0);
      assert.equal(gated.freshnessPenalty, 0.4);
    });

    it("prefers the candidate with stronger gate metrics when critic scores are close", () => {
      const candidateA = [{ ...strongPlan, task: "Candidate A" }];
      const candidateB = [{ ...strongPlan, task: "Candidate B" }];
      const result = selectBestCandidateSet([candidateA, candidateB], {
        gateMetricsByCandidate: [
          { contractPassRate: 0.5, viablePlanCount: 1, freshnessPenalty: 0.3 },
          { contractPassRate: 1, viablePlanCount: 1, freshnessPenalty: 0 },
        ],
      });
      assert.equal(result.bestCandidates, candidateB);
      assert.ok(result.score > 0);
    });

    it("prefers the higher-capacity candidate when structure is otherwise comparable", () => {
      const lowCapacity = [{
        ...strongPlan,
        task: "Low-capacity patch packet",
        capacityDelta: 0.05,
        requestROI: 1.05,
      }];
      const highCapacity = [{
        ...strongPlan,
        task: "Master-plan packet",
        capacityDelta: 0.3,
        requestROI: 2.2,
      }];
      const result = selectBestCandidateSet([lowCapacity, highCapacity], {
        gateMetricsByCandidate: [
          { contractPassRate: 1, viablePlanCount: 1, freshnessPenalty: 0 },
          { contractPassRate: 1, viablePlanCount: 1, freshnessPenalty: 0 },
        ],
      });
      assert.equal(result.bestCandidates, highCapacity);
    });
  });

  describe("AC_RICHNESS_THRESHOLD", () => {
    it("is a positive number", () => {
      assert.ok(AC_RICHNESS_THRESHOLD > 0);
      assert.ok(AC_RICHNESS_THRESHOLD <= 1);
    });
  });

  describe("PACKET_SIZE_COMPLIANT dimension (hard admission for oversized packets)", () => {
    it("scores 1.0 for a plan within AC and file caps", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes",
        acceptance_criteria: Array.from({ length: 5 }, (_, i) => `AC ${i}`),
        target_files: ["src/core/config.js", "src/core/other.js"],
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT], 1.0);
    });

    it("scores 0.0 and flags issue when AC count exceeds MAX_ACCEPTANCE_CRITERIA_PER_TASK", () => {
      const plan = {
        task: "Implement deterministic parser contract for src/core/prometheus.ts output",
        verification: "npm test passes",
        acceptance_criteria: Array.from({ length: 11 }, (_, i) => `Criterion ${i + 1}`),
        target_files: ["src/core/prometheus.ts"],
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT], 0.0,
        "oversized AC must score 0 on PACKET_SIZE_COMPLIANT");
      assert.ok(result.issues.some(i => /oversized packet/i.test(i)),
        "must flag oversized packet in issues");
    });

    it("scores 0.0 when target_files exceeds MAX_FILES_IN_SCOPE_PER_TASK", () => {
      const plan = {
        task: "Implement deterministic parser contract for src/core/prometheus.ts output",
        verification: "npm test passes",
        acceptance_criteria: ["AC 1"],
        target_files: Array.from({ length: 31 }, (_, i) => `src/file${i}.ts`),
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT], 0.0,
        "oversized file count must score 0 on PACKET_SIZE_COMPLIANT");
    });

    it("negative path: PACKET_SIZE_COMPLIANT is 1.0 when filesInScope is exactly at cap", () => {
      const plan = {
        task: "Implement deterministic parser contract for src/core/prometheus.ts output",
        verification: "npm test passes",
        acceptance_criteria: Array.from({ length: MAX_ACCEPTANCE_CRITERIA_PER_TASK }, (_, i) => `Criterion ${i}`),
        target_files: Array.from({ length: MAX_FILES_IN_SCOPE_PER_TASK }, (_, i) => `src/file${i}.ts`),
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT], 1.0,
        "exactly-at-cap values must not trigger PACKET_SIZE_COMPLIANT=0");
    });

    it("PACKET_SIZE_COMPLIANT is in CRITIC_DIMENSION export", () => {
      assert.equal(typeof CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT, "string");
      assert.equal(CRITIC_DIMENSION.PACKET_SIZE_COMPLIANT, "PACKET_SIZE_COMPLIANT");
    });
  });

  describe("NO_TOPIC_NAME_DRIFT dimension", () => {
    it("NO_TOPIC_NAME_DRIFT is exported in CRITIC_DIMENSION", () => {
      assert.equal(typeof CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT, "string");
      assert.equal(CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT, "NO_TOPIC_NAME_DRIFT");
    });

    it("scores 0.0 and flags drift when task only references quarantined research topics", () => {
      const plan = {
        task: "Implement improvements based on research completed on topics — all topics failed density check",
        context: "All research topics failed actionable density. Degraded planning mode active.",
        verification: "",
      };
      const result = critiquePlan(plan);
      assert.equal(
        result.dimensions[CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT],
        0.0,
        "topic-name-only drift must score 0.0"
      );
      assert.ok(
        result.issues.some(i => /topic.*(name|drift|evidence)/i.test(i)),
        "must flag topic-name drift in issues"
      );
    });

    it("scores 1.0 when plan has concrete file evidence despite topic mentions", () => {
      const plan = {
        task: "Fix failing tests in src/core/state_tracker.ts (research flagged stale trace writes)",
        context: "File src/core/state_tracker.ts line 923 needs updated error handling",
        verification: "npm test -- tests/core/state_tracker.test.ts",
      };
      const result = critiquePlan(plan);
      assert.equal(
        result.dimensions[CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT],
        1.0,
        "plan with file references must NOT be flagged as topic-name drift"
      );
    });

    it("negative path: plan with no topic framing and no file refs scores 1.0 (not a drift)", () => {
      const plan = {
        task: "Optimize loop performance",
        context: "general optimization request",
        verification: "",
      };
      const result = critiquePlan(plan);
      assert.equal(
        result.dimensions[CRITIC_DIMENSION.NO_TOPIC_NAME_DRIFT],
        1.0,
        "non-topic-framed plan must not be penalized by drift detector"
      );
    });
  });

  describe("candidate-set gate scoring", () => {
    const strongPlan = {
      task: "Wire bounded candidate selection into src/core/prometheus.ts",
      scope: "src/core/prometheus.ts",
      target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
      acceptance_criteria: ["candidate selection picks a dispatchable set", "blocked candidate sets score zero"],
      verification: "npm test -- tests/core/prometheus_parse.test.ts",
      leverage_rank: ["task-quality", "cost efficiency"],
      capacityDelta: 0.2,
      requestROI: 1.5,
      riskLevel: "medium",
    };

    const viablePlan = {
      ...strongPlan,
      task: "Keep dispatchable candidate plans ahead of blocked sets",
      target_files: ["src/core/plan_critic.ts", "tests/core/plan_critic.test.ts"],
    };

    it("zeroes effective score when a candidate set is fully blocked by gates", () => {
      const result = scoreCandidateSetWithGates([strongPlan], {
        contractPassRate: 0,
        viablePlanCount: 0,
        freshnessPenalty: 0,
        allPlansBlocked: true,
      });
      assert.equal(result.allPlansBlocked, true);
      assert.equal(result.effectiveScore, 0);
    });

    it("prefers a dispatchable candidate set over a higher-rubric blocked set", () => {
      const result = selectBestCandidateSet([[strongPlan], [viablePlan]], {
        gateMetricsByCandidate: [
          { contractPassRate: 0, viablePlanCount: 0, freshnessPenalty: 0, allPlansBlocked: true },
          { contractPassRate: 1, viablePlanCount: 1, freshnessPenalty: 0, allPlansBlocked: false },
        ],
      });
      assert.deepEqual(result.bestCandidates, [viablePlan]);
      assert.match(result.reason, /clear_winner|tie_break_applied/);
    });
  });
});
