/**
 * Tests for T-026: Pre-mortem generation before risky changes.
 *
 * Covers:
 *   AC1:  High-risk interventions include a pre-mortem section before dispatch.
 *   AC2:  Pre-mortem has explicit detection signals and guardrails.
 *   AC3:  Athena review validates pre-mortem completeness.
 *   AC4:  Missing pre-mortem blocks execution of high-risk task (negative path).
 *   AC5:  Pre-mortem quality scored post-cycle (scorePremortemQuality rubric).
 *   AC8:  Pre-mortem schema is defined with required fields and explicit enums.
 *   AC9:  Validation distinguishes missing input from invalid input (reason codes).
 *   AC10: No silent fallback — degraded behavior sets explicit status and reason.
 *   AC11: Pre-mortem schema with required fields, types, enums.
 *   AC12: Risk threshold is "high" only (not medium).
 *   AC13: Pre-mortem completeness rules are explicit.
 *   AC14: Scoring rubric defined; storage path is state/premortem_scores.json.
 *   AC15: self_improvement.js uses scoreAndStorePremortemQuality (post-cycle).
 *   AC16: Risk level gating uses "high" only — dispatch pipeline gating.
 *   AC17: Specific test inputs/outputs for deterministic pass/fail evidence.
 *
 * Negative paths:
 *   - null/undefined pre-mortem → BLOCKED, MISSING_FIELD
 *   - riskLevel not "high" → BLOCKED, WRONG_RISK_LEVEL
 *   - incomplete fields → INCOMPLETE, INVALID_FIELD
 *   - high-risk plan with no pre-mortem → checkPlanPremortemGate returns violation
 *   - scorePremortemQuality with null → score=0, status=blocked
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  PREMORTEM_RISK_LEVEL,
  PREMORTEM_STATUS,
  PREMORTEM_VALIDATION_REASON,
  PREMORTEM_REQUIRED_FIELDS,
  validatePremortem,
  checkPlanPremortemGate
} from "../../src/core/athena_reviewer.js";

import {
  PREMORTEM_RISK_THRESHOLD,
  buildPremortemScaffold
} from "../../src/core/prometheus.js";

import {
  PREMORTEM_QUALITY_RUBRIC,
  PREMORTEM_MAX_SCORE,
  scorePremortemQuality,
  scoreAndStorePremortemQuality
} from "../../src/core/self_improvement.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** A fully-valid pre-mortem satisfying all schema requirements. */
const VALID_PREMORTEM = {
  riskLevel: "high",
  scenario: "Refactoring the dispatch pipeline could silently drop task events if the new queue buffer is not flushed before process exit.",
  failurePaths: [
    "Buffer not flushed on SIGTERM → tasks silently lost",
    "New schema not backward-compatible → old workers reject messages"
  ],
  mitigations: [
    "Add process.on('SIGTERM') flush handler before exit",
    "Deploy schema migration with dual-write period"
  ],
  detectionSignals: [
    "task_queue.length > 0 when worker count drops to 0",
    "old_worker_rejection_count metric increases post-deploy"
  ],
  guardrails: [
    "Integration test verifies queue drains within 5s of SIGTERM",
    "Canary deployment with 10% traffic before full rollout"
  ],
  rollbackPlan: "Revert to previous queue implementation via git revert + redeploy in under 10 minutes"
};

/** Minimal valid pre-mortem (passes schema but with minimum viable content). */
const MINIMAL_VALID_PREMORTEM = {
  riskLevel: "high",
  scenario: "This is a minimum-length scenario to test the schema.",
  failurePaths: ["failure-path-one"],
  mitigations: ["mitigation-one"],
  detectionSignals: ["detection-signal-one"],
  guardrails: ["guardrail-one"],
  rollbackPlan: "Roll back changes"
};

/** Minimal valid plan with high risk and valid pre-mortem. */
function makeHighRiskPlan(overrides = {}) {
  return {
    role: "evolution-worker",
    task: "Refactor dispatch pipeline",
    riskLevel: "high",
    verification: "npm test",
    premortem: VALID_PREMORTEM,
    ...overrides
  };
}

/** Build a config pointing at a temp stateDir. */
function makeConfig(stateDir) {
  return {
    selfImprovement: { enabled: true },
    paths: { stateDir }
  };
}

async function writeTestJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

// ── AC11: Pre-mortem schema enums ────────────────────────────────────────────

describe("PREMORTEM_RISK_LEVEL enum (AC8, AC11, AC12, AC16)", () => {
  it("exports only 'high' as the risk level (not medium)", () => {
    assert.equal(PREMORTEM_RISK_LEVEL.HIGH, "high");
    assert.ok(Object.isFrozen(PREMORTEM_RISK_LEVEL), "must be frozen");
    // Only "high" is the trigger — medium is NOT included (Athena hardening decision)
    assert.ok(!("MEDIUM" in PREMORTEM_RISK_LEVEL), "MEDIUM must not be in PREMORTEM_RISK_LEVEL — high-only gate");
  });
});

describe("PREMORTEM_STATUS enum (AC8, AC11)", () => {
  it("exports PASS, INCOMPLETE, BLOCKED with correct values", () => {
    assert.equal(PREMORTEM_STATUS.PASS, "pass");
    assert.equal(PREMORTEM_STATUS.INCOMPLETE, "incomplete");
    assert.equal(PREMORTEM_STATUS.BLOCKED, "blocked");
    assert.ok(Object.isFrozen(PREMORTEM_STATUS), "must be frozen");
  });
});

describe("PREMORTEM_VALIDATION_REASON enum (AC8, AC9, AC11)", () => {
  it("exports OK, MISSING_FIELD, INVALID_FIELD, WRONG_RISK_LEVEL", () => {
    assert.equal(PREMORTEM_VALIDATION_REASON.OK, "OK");
    assert.equal(PREMORTEM_VALIDATION_REASON.MISSING_FIELD, "MISSING_FIELD");
    assert.equal(PREMORTEM_VALIDATION_REASON.INVALID_FIELD, "INVALID_FIELD");
    assert.equal(PREMORTEM_VALIDATION_REASON.WRONG_RISK_LEVEL, "WRONG_RISK_LEVEL");
    assert.ok(Object.isFrozen(PREMORTEM_VALIDATION_REASON), "must be frozen");
  });
});

describe("PREMORTEM_REQUIRED_FIELDS (AC11, AC13)", () => {
  it("exports all required field names as a frozen array", () => {
    assert.ok(Array.isArray(PREMORTEM_REQUIRED_FIELDS), "must be an array");
    assert.ok(Object.isFrozen(PREMORTEM_REQUIRED_FIELDS), "must be frozen");
    for (const field of ["scenario", "failurePaths", "mitigations", "detectionSignals", "guardrails", "rollbackPlan", "riskLevel"]) {
      assert.ok(PREMORTEM_REQUIRED_FIELDS.includes(field), `must include required field: ${field}`);
    }
  });
});

// ── validatePremortem — missing input paths (AC9, AC10) ──────────────────────

describe("validatePremortem — missing input (AC9, AC10)", () => {
  it("returns BLOCKED/MISSING_FIELD for null input", () => {
    const r = validatePremortem(null);
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED, "null must block execution");
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.MISSING_FIELD, "reason must be MISSING_FIELD, not INVALID_FIELD");
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0, "errors must be populated");
  });

  it("returns BLOCKED/MISSING_FIELD for undefined input", () => {
    const r = validatePremortem(undefined);
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.MISSING_FIELD);
  });

  it("returns BLOCKED/MISSING_FIELD for non-object input (string)", () => {
    const r = validatePremortem("not-an-object");
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.MISSING_FIELD);
  });

  it("returns BLOCKED/MISSING_FIELD for non-object input (number)", () => {
    const r = validatePremortem(42);
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.MISSING_FIELD);
  });
});

// ── validatePremortem — wrong risk level (AC9, AC10, AC12) ───────────────────

describe("validatePremortem — wrong riskLevel (AC9, AC10, AC12)", () => {
  it("returns BLOCKED/WRONG_RISK_LEVEL when riskLevel='medium' (medium not accepted)", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, riskLevel: "medium" });
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED,
      "medium riskLevel must block — only 'high' is accepted");
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.WRONG_RISK_LEVEL);
    assert.ok(r.errors[0].includes("high"), "error message must reference 'high'");
  });

  it("returns BLOCKED/WRONG_RISK_LEVEL when riskLevel='low'", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, riskLevel: "low" });
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.WRONG_RISK_LEVEL);
  });

  it("returns BLOCKED/MISSING_FIELD when riskLevel field is absent", () => {
    const { riskLevel: _, ...rest } = VALID_PREMORTEM;
    const r = validatePremortem(rest);
    assert.equal(r.status, PREMORTEM_STATUS.BLOCKED);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.MISSING_FIELD);
  });
});

// ── validatePremortem — incomplete/invalid fields (AC9, AC13) ────────────────

describe("validatePremortem — invalid/incomplete fields (AC9, AC10, AC13)", () => {
  it("returns INCOMPLETE/INVALID_FIELD when scenario is too short", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, scenario: "too short" });
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE,
      "short scenario must be INCOMPLETE, not BLOCKED");
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("scenario")), "errors must mention 'scenario'");
  });

  it("returns INCOMPLETE/INVALID_FIELD when failurePaths is empty array", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, failurePaths: [] });
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("failurePaths")));
  });

  it("returns INCOMPLETE/INVALID_FIELD when mitigations is empty array", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, mitigations: [] });
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("mitigations")));
  });

  it("returns INCOMPLETE/INVALID_FIELD when detectionSignals is missing", () => {
    const { detectionSignals: _, ...rest } = VALID_PREMORTEM;
    const r = validatePremortem(rest);
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("detectionSignals")));
  });

  it("returns INCOMPLETE/INVALID_FIELD when guardrails is missing", () => {
    const { guardrails: _, ...rest } = VALID_PREMORTEM;
    const r = validatePremortem(rest);
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("guardrails")));
  });

  it("returns INCOMPLETE/INVALID_FIELD when rollbackPlan is too short", () => {
    const r = validatePremortem({ ...VALID_PREMORTEM, rollbackPlan: "undo it" });
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.INVALID_FIELD);
    assert.ok(r.errors.some(e => e.includes("rollbackPlan")));
  });

  it("can accumulate multiple field errors in one validation pass", () => {
    const r = validatePremortem({
      riskLevel: "high",
      scenario: "short",
      failurePaths: [],
      mitigations: [],
      detectionSignals: [],
      guardrails: [],
      rollbackPlan: "no"
    });
    assert.equal(r.status, PREMORTEM_STATUS.INCOMPLETE);
    assert.ok(r.errors.length >= 3, "must report all failing fields");
  });
});

// ── validatePremortem — valid input (AC1, AC2) ────────────────────────────────

describe("validatePremortem — valid input (AC1, AC2, AC8)", () => {
  it("returns PASS/OK for a fully-populated pre-mortem with detection signals and guardrails", () => {
    const r = validatePremortem(VALID_PREMORTEM);
    assert.equal(r.status, PREMORTEM_STATUS.PASS, "fully valid pre-mortem must return PASS");
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.OK);
    assert.deepEqual(r.errors, [], "no errors on valid pre-mortem");
  });

  it("returns PASS/OK for minimal valid pre-mortem", () => {
    const r = validatePremortem(MINIMAL_VALID_PREMORTEM);
    assert.equal(r.status, PREMORTEM_STATUS.PASS);
    assert.equal(r.reason, PREMORTEM_VALIDATION_REASON.OK);
  });

  it("valid pre-mortem includes detectionSignals (AC2 — explicit detection signals required)", () => {
    const r = validatePremortem(VALID_PREMORTEM);
    assert.equal(r.status, PREMORTEM_STATUS.PASS);
    // Confirm detectionSignals is part of what was validated (it appears in REQUIRED_FIELDS)
    assert.ok(PREMORTEM_REQUIRED_FIELDS.includes("detectionSignals"),
      "detectionSignals must be a required field");
  });

  it("valid pre-mortem includes guardrails (AC2 — explicit guardrails required)", () => {
    const r = validatePremortem(VALID_PREMORTEM);
    assert.equal(r.status, PREMORTEM_STATUS.PASS);
    assert.ok(PREMORTEM_REQUIRED_FIELDS.includes("guardrails"),
      "guardrails must be a required field");
  });
});

// ── checkPlanPremortemGate — AC4 (blocks high-risk tasks without pre-mortem) ─

describe("checkPlanPremortemGate — execution gate (AC1, AC4, AC16)", () => {
  it("returns empty array when no plans are high-risk", () => {
    const plans = [
      { role: "worker", task: "low-risk task", riskLevel: "low" },
      { role: "worker", task: "medium-risk task", riskLevel: "medium" }
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.deepEqual(violations, [], "low/medium risk plans must not trigger pre-mortem gate");
  });

  it("returns empty array when high-risk plan has a valid pre-mortem", () => {
    const plans = [makeHighRiskPlan()];
    const violations = checkPlanPremortemGate(plans);
    assert.deepEqual(violations, [],
      "high-risk plan with valid pre-mortem must not produce violations");
  });

  it("returns violation when high-risk plan has NO pre-mortem (AC4 negative path)", () => {
    const plans = [
      { role: "evolution-worker", task: "Risky pipeline change", riskLevel: "high" }
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.ok(violations.length === 1,
      "missing pre-mortem on high-risk plan must produce exactly one violation");
    assert.ok(violations[0].includes("plan[0]"),
      "violation must reference the plan index");
    assert.ok(violations[0].includes("high-risk"),
      "violation message must mention 'high-risk'");
  });

  it("returns violation when high-risk plan has an INCOMPLETE pre-mortem", () => {
    const plans = [
      makeHighRiskPlan({
        premortem: { riskLevel: "high", scenario: "short", failurePaths: [], mitigations: [], detectionSignals: [], guardrails: [], rollbackPlan: "no" }
      })
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.ok(violations.length === 1, "incomplete pre-mortem must produce a violation");
    assert.ok(violations[0].includes("incomplete") || violations[0].toLowerCase().includes("pre-mortem"));
  });

  it("returns multiple violations for multiple missing pre-mortems", () => {
    const plans = [
      { role: "worker-1", task: "Task A", riskLevel: "high" },
      { role: "worker-2", task: "Task B", riskLevel: "high" }
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.equal(violations.length, 2, "must produce one violation per missing pre-mortem");
  });

  it("skips non-high-risk plans even when premortem is absent", () => {
    const plans = [
      { role: "worker", task: "Safe refactor", riskLevel: "low" },
      makeHighRiskPlan()
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.deepEqual(violations, [],
      "low-risk plans without pre-mortem must not trigger violations");
  });

  it("returns empty array for null/non-array input (defensive)", () => {
    assert.deepEqual(checkPlanPremortemGate(null), []);
    assert.deepEqual(checkPlanPremortemGate(undefined), []);
    assert.deepEqual(checkPlanPremortemGate("not-an-array"), []);
  });
});

// ── prometheus.js: PREMORTEM_RISK_THRESHOLD and buildPremortemScaffold ────────

describe("PREMORTEM_RISK_THRESHOLD (prometheus.js, AC12, AC16)", () => {
  it("equals 'high' — only high-risk plans trigger pre-mortem requirement", () => {
    assert.equal(PREMORTEM_RISK_THRESHOLD, "high",
      "risk threshold must be 'high' — not 'medium' (Athena hardening decision)");
  });
});

describe("buildPremortemScaffold (prometheus.js, AC1, AC11)", () => {
  it("returns an object with all required pre-mortem schema fields", () => {
    const scaffold = buildPremortemScaffold({ task: "risky change" });
    assert.equal(scaffold.riskLevel, "high");
    assert.ok("scenario" in scaffold, "scaffold must include scenario");
    assert.ok("failurePaths" in scaffold, "scaffold must include failurePaths");
    assert.ok("mitigations" in scaffold, "scaffold must include mitigations");
    assert.ok("detectionSignals" in scaffold, "scaffold must include detectionSignals");
    assert.ok("guardrails" in scaffold, "scaffold must include guardrails");
    assert.ok("rollbackPlan" in scaffold, "scaffold must include rollbackPlan");
  });

  it("returns empty arrays for array fields (scaffold is unfilled)", () => {
    const scaffold = buildPremortemScaffold({});
    assert.deepEqual(scaffold.failurePaths, []);
    assert.deepEqual(scaffold.mitigations, []);
    assert.deepEqual(scaffold.detectionSignals, []);
    assert.deepEqual(scaffold.guardrails, []);
  });

  it("scaffold does NOT pass validatePremortem (it is intentionally unfilled)", () => {
    const scaffold = buildPremortemScaffold({});
    const r = validatePremortem(scaffold);
    assert.notEqual(r.status, PREMORTEM_STATUS.PASS,
      "an empty scaffold must NOT pass validation — it requires AI population");
  });

  it("builds scaffold for null plan without throwing", () => {
    const scaffold = buildPremortemScaffold(null);
    assert.equal(scaffold.riskLevel, "high");
    assert.equal(scaffold.rollbackPlan, "");
  });
});

// ── PREMORTEM_QUALITY_RUBRIC and scorePremortemQuality (AC5, AC14) ────────────

describe("PREMORTEM_QUALITY_RUBRIC (self_improvement.js, AC5, AC14)", () => {
  it("defines all six scoring criteria with maxPoints summing to PREMORTEM_MAX_SCORE", () => {
    const totalMax = Object.values(PREMORTEM_QUALITY_RUBRIC).reduce(
      (sum, r) => sum + r.maxPoints, 0
    );
    assert.equal(totalMax, PREMORTEM_MAX_SCORE,
      `rubric maxPoints must sum to ${PREMORTEM_MAX_SCORE}`);
  });

  it("includes scenario, failurePaths, mitigations, detectionSignals, guardrails, rollbackPlan", () => {
    for (const key of ["scenario", "failurePaths", "mitigations", "detectionSignals", "guardrails", "rollbackPlan"]) {
      assert.ok(key in PREMORTEM_QUALITY_RUBRIC, `rubric must include: ${key}`);
      assert.ok(typeof PREMORTEM_QUALITY_RUBRIC[key].maxPoints === "number",
        `${key}.maxPoints must be a number`);
      assert.ok(typeof PREMORTEM_QUALITY_RUBRIC[key].description === "string",
        `${key}.description must be a string`);
    }
  });

  it("is frozen (immutable rubric)", () => {
    assert.ok(Object.isFrozen(PREMORTEM_QUALITY_RUBRIC));
  });
});

describe("PREMORTEM_MAX_SCORE (AC5, AC14)", () => {
  it("equals 10", () => {
    assert.equal(PREMORTEM_MAX_SCORE, 10);
  });
});

describe("scorePremortemQuality — positive paths (AC5, AC14, AC17)", () => {
  it("returns score=10, status=complete for fully-populated pre-mortem", () => {
    const r = scorePremortemQuality(VALID_PREMORTEM);
    assert.equal(r.score, 10, "fully valid pre-mortem must score 10/10");
    assert.equal(r.maxScore, 10);
    assert.equal(r.scorePercent, 100);
    assert.equal(r.status, "complete");
    assert.ok(Array.isArray(r.details), "details must be an array");
    assert.equal(r.details.length, 6, "details must have one entry per rubric criterion");
  });

  it("all detail entries for fully-valid pre-mortem have pass=true", () => {
    const r = scorePremortemQuality(VALID_PREMORTEM);
    for (const detail of r.details) {
      assert.equal(detail.pass, true, `criterion '${detail.key}' must pass for valid pre-mortem`);
    }
  });

  it("returns adequate status for partial pre-mortem (score=6-9)", () => {
    // Exactly 7 pts: all pass except failurePaths (need >=2, only 1 → 0 pts) and mitigations (0 pts)
    // scenario(2)+detectionSignals(1)+guardrails(1)+rollbackPlan(2)=6 pts
    const partial = {
      riskLevel: "high",
      scenario: "This is a long enough scenario description for the test.",
      failurePaths: ["only-one-path"],  // fails: needs >= 2
      mitigations: ["one-mitigation"],  // passes: >= max(1,1)=1
      detectionSignals: ["a signal"],
      guardrails: ["a guardrail"],
      rollbackPlan: "Roll back the deployment"
    };
    const r = scorePremortemQuality(partial);
    // scenario=2, failurePaths=0 (only 1), mitigations=2(>=1), detectionSignals=1, guardrails=1, rollbackPlan=2 = 8
    assert.ok(r.score >= 6 && r.score < 10, `score must be 6-9, got ${r.score}`);
    assert.equal(r.status, "adequate");
  });

  it("returns inadequate status for weak pre-mortem (score < 6)", () => {
    const weak = {
      riskLevel: "high",
      scenario: "too short",          // fails: < 20 chars → 0 pts
      failurePaths: [],               // fails: empty → 0 pts
      mitigations: [],                // fails: empty → 0 pts
      detectionSignals: ["signal"],   // passes → 1 pt
      guardrails: ["guardrail"],      // passes → 1 pt
      rollbackPlan: "no"              // fails: < 10 chars → 0 pts
    };
    const r = scorePremortemQuality(weak);
    assert.equal(r.score, 2, "weak pre-mortem must score 2 (only detectionSignals+guardrails pass)");
    assert.equal(r.status, "inadequate");
  });
});

describe("scorePremortemQuality — negative paths (AC5, AC9, AC10, AC17)", () => {
  it("returns score=0, status=blocked for null input", () => {
    const r = scorePremortemQuality(null);
    assert.equal(r.score, 0, "null input must score 0");
    assert.equal(r.maxScore, PREMORTEM_MAX_SCORE);
    assert.equal(r.scorePercent, 0);
    assert.equal(r.status, "blocked", "null input must set status=blocked — no silent fallback");
    assert.deepEqual(r.details, [], "details must be empty for blocked input");
  });

  it("returns score=0, status=blocked for undefined input", () => {
    const r = scorePremortemQuality(undefined);
    assert.equal(r.score, 0);
    assert.equal(r.status, "blocked");
  });

  it("returns score=0, status=blocked for non-object input (string)", () => {
    const r = scorePremortemQuality("not-a-premortem");
    assert.equal(r.score, 0);
    assert.equal(r.status, "blocked");
  });

  it("each detail entry has key, pass, points, maxPoints fields", () => {
    const r = scorePremortemQuality(VALID_PREMORTEM);
    for (const detail of r.details) {
      assert.ok(typeof detail.key === "string", "detail.key must be a string");
      assert.ok(typeof detail.pass === "boolean", "detail.pass must be a boolean");
      assert.ok(typeof detail.points === "number", "detail.points must be a number");
      assert.ok(typeof detail.maxPoints === "number", "detail.maxPoints must be a number");
      assert.ok(detail.points <= detail.maxPoints, "points must not exceed maxPoints");
    }
  });
});

// ── scoreAndStorePremortemQuality — storage (AC5, AC14, AC15) ─────────────────

describe("scoreAndStorePremortemQuality — storage (AC5, AC14, AC15)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t026-score-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty scores when no high-risk plans are present", async () => {
    const prometheusAnalysis = {
      plans: [
        { role: "worker", task: "low task", riskLevel: "low" },
        { role: "worker", task: "medium task", riskLevel: "medium" }
      ]
    };
    const result = await scoreAndStorePremortemQuality(makeConfig(tmpDir), prometheusAnalysis);
    assert.deepEqual(result.scores, [], "no high-risk plans → no scores");
    assert.equal(result.averageScore, null);
  });

  it("scores high-risk plans with pre-mortems and writes to premortem_scores.json", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t026-write-"));
    try {
      const prometheusAnalysis = {
        plans: [
          { ...makeHighRiskPlan(), task: "Risky change A", premortem: VALID_PREMORTEM },
          { role: "worker", task: "Safe change", riskLevel: "low" }
        ]
      };
      const result = await scoreAndStorePremortemQuality(makeConfig(dir), prometheusAnalysis);

      assert.equal(result.scores.length, 1, "must score exactly 1 high-risk plan");
      assert.equal(result.scores[0].score, 10, "fully valid pre-mortem must score 10");
      assert.equal(result.averageScore, 10);

      // Verify storage
      const stored = JSON.parse(await fs.readFile(path.join(dir, "premortem_scores.json"), "utf8"));
      assert.ok(Array.isArray(stored.scores), "storage must have a scores array");
      assert.equal(stored.scores.length, 1, "storage must have 1 score entry");
      assert.ok(typeof stored.lastScoredAt === "string", "storage must have lastScoredAt");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("each stored score entry has required schema fields", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t026-schema-"));
    try {
      const prometheusAnalysis = {
        plans: [makeHighRiskPlan({ task: "Risky change for schema check" })]
      };
      await scoreAndStorePremortemQuality(makeConfig(dir), prometheusAnalysis);
      const stored = JSON.parse(await fs.readFile(path.join(dir, "premortem_scores.json"), "utf8"));
      const entry = stored.scores[0];

      for (const field of ["planIndex", "taskId", "score", "maxScore", "scorePercent", "status", "details", "scoredAt"]) {
        assert.ok(field in entry, `stored score entry must include field: ${field}`);
      }
      assert.equal(entry.maxScore, PREMORTEM_MAX_SCORE);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("appends scores across multiple calls (state persists)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t026-append-"));
    try {
      const analysis = { plans: [makeHighRiskPlan({ task: "change-1" })] };
      await scoreAndStorePremortemQuality(makeConfig(dir), analysis);
      await scoreAndStorePremortemQuality(makeConfig(dir), analysis);
      const stored = JSON.parse(await fs.readFile(path.join(dir, "premortem_scores.json"), "utf8"));
      assert.equal(stored.scores.length, 2, "scores must accumulate across calls");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("returns scores=[] and averageScore=null for null prometheusAnalysis", async () => {
    const result = await scoreAndStorePremortemQuality(makeConfig(tmpDir), null);
    assert.deepEqual(result.scores, []);
    assert.equal(result.averageScore, null);
  });

  it("handles high-risk plan without premortem field gracefully (skips non-premortem high-risk)", async () => {
    // A plan is high-risk but has no premortem — it should not be scored (not present)
    const analysis = { plans: [{ role: "w", task: "risky", riskLevel: "high" }] };
    const result = await scoreAndStorePremortemQuality(makeConfig(tmpDir), analysis);
    assert.deepEqual(result.scores, [], "high-risk plan without premortem field must not be scored");
  });
});

// ── Integration: checkPlanPremortemGate blocks high-risk plan without pre-mortem ─

describe("AC4 integration: gate blocks execution of high-risk task without pre-mortem", () => {
  it("rejects plan array with high-risk item and no pre-mortem (deterministic block)", () => {
    const plans = [
      { role: "evolution-worker", task: "Critical pipeline refactor", riskLevel: "high" }
      // No premortem field
    ];
    const violations = checkPlanPremortemGate(plans);
    assert.ok(violations.length > 0,
      "EXECUTION BLOCK: high-risk plan without pre-mortem must be rejected by the gate");
    assert.ok(violations[0].toLowerCase().includes("pre-mortem") || violations[0].includes("premortem"));
  });

  it("does not block a valid high-risk plan with complete pre-mortem (AC1 positive path)", () => {
    const plans = [makeHighRiskPlan()];
    const violations = checkPlanPremortemGate(plans);
    assert.deepEqual(violations, [],
      "high-risk plan with valid pre-mortem must NOT be blocked");
  });
});
