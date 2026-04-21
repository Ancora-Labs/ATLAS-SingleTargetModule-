/**
 * catastrophe_detector.test.ts
 *
 * Tests for src/core/catastrophe_detector.js
 *
 * Coverage:
 *   AC #1  — alert includes scenarioId, confidence, firstSeenAt
 *   AC #2  — all 6 scenarios are detected
 *   AC #3  — detectCatastrophes() completes in < overheadBudgetMs (10ms)
 *   AC #4  — guardrails have defined schema (action, urgency, description)
 *   AC #5  — false-positive rate < falsePositiveRateThreshold against labeled fixtures
 *   AC #7  — negative path: invalid/missing input handled deterministically
 *   AC #8  — alert schema includes all required fields with correct types/enums
 *   AC #9  — validation distinguishes MISSING_INPUT from INVALID_INPUT
 *   AC #10 — runCatastropheDetection returns explicit status + reason on failure
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  detectCatastrophes,
  validateDetectionContext,
  runCatastropheDetection,
  loadCatastropheState,
  CATASTROPHE_SCENARIO,
  CATASTROPHE_STATUS,
  CATASTROPHE_DEFAULTS,
  CATASTROPHE_DETECTOR_SCHEMA_VERSION,
  GUARDRAIL_ACTION,
  GUARDRAIL_URGENCY,
  DETECTOR_REASON_CODE,
} from "../../src/core/catastrophe_detector.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "../fixtures/catastrophe_scenarios");

// ── helpers ───────────────────────────────────────────────────────────────────

function healthy() {
  return {
    retryCount:                0,
    totalTasks:                3,
    blockedTasks:              0,
    janusDirectiveAgeMs:       300_000,
    prometheusAnalysisAgeMs:   300_000,
    parseFailureCount:         0,
    consecutiveBudgetBreaches: 0,
    consecutiveSloBreaches:    0,
  };
}

function loadFixture(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function listFixtures(subdir) {
  const dir = join(FIXTURES_DIR, subdir);
  return readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => ({ file: f, data: loadFixture(join(dir, f)) }));
}

// Strip metadata fields (_label, _scenario, _description) before passing to detector
function stripMeta(fixture) {
  const { _label: _l, _scenario: _s, _description: _d, ...ctx } = fixture;
  return ctx;
}

// ── AC #9 — validateDetectionContext ─────────────────────────────────────────

describe("validateDetectionContext", () => {
  it("returns MISSING_INPUT for null", () => {
    const r = validateDetectionContext(null);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.MISSING_INPUT);
  });

  it("returns MISSING_INPUT for undefined", () => {
    const r = validateDetectionContext(undefined);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.MISSING_INPUT);
  });

  it("returns INVALID_INPUT for array input", () => {
    const r = validateDetectionContext([]);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.INVALID_INPUT);
  });

  it("returns INVALID_INPUT (MISSING_FIELD) when retryCount absent", () => {
    const ctx = { ...healthy() };
    delete ctx.retryCount;
    const r = validateDetectionContext(ctx);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.INVALID_INPUT);
    assert.match(r.message, /retryCount/);
  });

  it("returns INVALID_INPUT (INVALID_FIELD) when retryCount is negative", () => {
    const r = validateDetectionContext({ ...healthy(), retryCount: -1 });
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.INVALID_INPUT);
    assert.match(r.message, /retryCount/);
  });

  it("returns INVALID_INPUT (INVALID_FIELD) when a field is NaN", () => {
    const r = validateDetectionContext({ ...healthy(), parseFailureCount: NaN });
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.INVALID_INPUT);
  });

  it("returns OK for valid context", () => {
    const r = validateDetectionContext(healthy());
    assert.equal(r.ok, true);
    assert.equal(r.code, DETECTOR_REASON_CODE.OK);
  });
});

// ── AC #7 (negative path) — detectCatastrophes with invalid input ─────────────

describe("detectCatastrophes — negative paths", () => {
  it("returns ok=false for null context", () => {
    const r = detectCatastrophes(null);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.MISSING_INPUT);
    assert.deepEqual(r.detections, []);
  });

  it("returns ok=false for missing required field", () => {
    const ctx = { ...healthy() };
    delete ctx.consecutiveSloBreaches;
    const r = detectCatastrophes(ctx);
    assert.equal(r.ok, false);
    assert.equal(r.code, DETECTOR_REASON_CODE.INVALID_INPUT);
    assert.deepEqual(r.detections, []);
  });

  it("returns empty detections for all-healthy context", () => {
    const r = detectCatastrophes(healthy());
    assert.equal(r.ok, true);
    assert.deepEqual(r.detections, []);
  });

  it("does not detect RUNAWAY_RETRIES at exactly threshold - 1", () => {
    const ctx = { ...healthy(), retryCount: CATASTROPHE_DEFAULTS.runawayRetryThreshold - 1 };
    const r = detectCatastrophes(ctx);
    assert.equal(r.ok, true);
    assert.equal(r.detections.filter(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES).length, 0);
  });

  it("does not detect MASS_BLOCKED_TASKS when blockedRatio === threshold exactly", () => {
    // ratio must be STRICTLY greater than threshold
    const ctx = { ...healthy(), totalTasks: 2, blockedTasks: 1 }; // ratio = 0.5, threshold = 0.5
    const r = detectCatastrophes(ctx);
    assert.equal(r.detections.filter(d => d.scenarioId === CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS).length, 0);
  });

  it("does not detect STALE_CRITICAL_STATE below threshold", () => {
    const ctx = { ...healthy(), janusDirectiveAgeMs: CATASTROPHE_DEFAULTS.staleCriticalStateAgeMs - 1 };
    const r = detectCatastrophes(ctx);
    assert.equal(r.detections.filter(d => d.scenarioId === CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE).length, 0);
  });
});

// ── AC #2 — All 6 scenarios are detected ─────────────────────────────────────

describe("detectCatastrophes — all 6 scenarios", () => {
  it("detects RUNAWAY_RETRIES when retryCount >= threshold", () => {
    const ctx = { ...healthy(), retryCount: CATASTROPHE_DEFAULTS.runawayRetryThreshold };
    const r = detectCatastrophes(ctx);
    assert.equal(r.ok, true);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES);
    assert.ok(found, "RUNAWAY_RETRIES not detected");
  });

  it("detects MASS_BLOCKED_TASKS when blocked/total > threshold", () => {
    const ctx = { ...healthy(), totalTasks: 4, blockedTasks: 3 };
    const r = detectCatastrophes(ctx);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.MASS_BLOCKED_TASKS);
    assert.ok(found, "MASS_BLOCKED_TASKS not detected");
  });

  it("detects STALE_CRITICAL_STATE when state exceeds staleness threshold", () => {
    const ctx = { ...healthy(), janusDirectiveAgeMs: CATASTROPHE_DEFAULTS.staleCriticalStateAgeMs + 1 };
    const r = detectCatastrophes(ctx);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE);
    assert.ok(found, "STALE_CRITICAL_STATE not detected");
  });

  it("detects REPEATED_AI_PARSE_FAILURES when parseFailureCount >= threshold", () => {
    const ctx = { ...healthy(), parseFailureCount: CATASTROPHE_DEFAULTS.repeatedParseFailureThreshold };
    const r = detectCatastrophes(ctx);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.REPEATED_AI_PARSE_FAILURES);
    assert.ok(found, "REPEATED_AI_PARSE_FAILURES not detected");
  });

  it("detects BUDGET_EXHAUSTION_SPIRAL when consecutiveBudgetBreaches >= threshold", () => {
    const ctx = { ...healthy(), consecutiveBudgetBreaches: CATASTROPHE_DEFAULTS.budgetExhaustionConsecutive };
    const r = detectCatastrophes(ctx);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.BUDGET_EXHAUSTION_SPIRAL);
    assert.ok(found, "BUDGET_EXHAUSTION_SPIRAL not detected");
  });

  it("detects SLO_CASCADING_BREACH when consecutiveSloBreaches >= threshold", () => {
    const ctx = { ...healthy(), consecutiveSloBreaches: CATASTROPHE_DEFAULTS.sloCascadingBreachConsecutive };
    const r = detectCatastrophes(ctx);
    const found = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.SLO_CASCADING_BREACH);
    assert.ok(found, "SLO_CASCADING_BREACH not detected");
  });
});

// ── AC #1 — Alert includes scenarioId, confidence, firstSeenAt ───────────────

describe("detectCatastrophes — alert field contract (AC #1)", () => {
  it("every alert includes scenarioId, confidence, and firstSeenAt", () => {
    const ctx = {
      ...healthy(),
      retryCount:                CATASTROPHE_DEFAULTS.runawayRetryThreshold + 2,
      consecutiveSloBreaches:    CATASTROPHE_DEFAULTS.sloCascadingBreachConsecutive,
    };
    const r = detectCatastrophes(ctx);
    assert.ok(r.detections.length >= 2);
    for (const alert of r.detections) {
      assert.ok(typeof alert.scenarioId === "string" && alert.scenarioId.length > 0,
        `scenarioId missing in ${JSON.stringify(alert)}`);
      assert.ok(typeof alert.confidence === "number" && alert.confidence >= 0 && alert.confidence <= 1,
        `confidence out of range in ${alert.scenarioId}`);
      assert.ok(typeof alert.firstSeenAt === "string" && !isNaN(Date.parse(alert.firstSeenAt)),
        `firstSeenAt invalid in ${alert.scenarioId}`);
    }
  });
});

// ── AC #8 — CatastropheAlert schema ──────────────────────────────────────────

describe("detectCatastrophes — alert schema (AC #8)", () => {
  it("alert has all required schema fields with correct types", () => {
    const ctx = { ...healthy(), retryCount: 10 };
    const r = detectCatastrophes(ctx);
    assert.ok(r.detections.length > 0);
    const alert = r.detections[0];

    assert.equal(alert.schemaVersion, CATASTROPHE_DETECTOR_SCHEMA_VERSION);
    assert.ok(Object.values(CATASTROPHE_SCENARIO).includes(alert.scenarioId),
      `scenarioId "${alert.scenarioId}" not in enum`);
    assert.ok(typeof alert.confidence === "number");
    assert.ok(typeof alert.firstSeenAt === "string");
    assert.ok(typeof alert.detectedAt === "string");
    assert.ok(Object.values(CATASTROPHE_STATUS).includes(alert.status),
      `status "${alert.status}" not in CATASTROPHE_STATUS`);
    assert.ok(alert.evidence && typeof alert.evidence === "object");
    assert.ok(Array.isArray(alert.guardrails) && alert.guardrails.length >= 1);
  });

  it("alert.evidence is a non-empty object with scenario-specific fields", () => {
    const ctx = { ...healthy(), retryCount: 10 };
    const r = detectCatastrophes(ctx);
    const alert = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES);
    assert.ok(alert);
    assert.ok(Object.keys(alert.evidence).length > 0);
    assert.equal(alert.evidence.retryCount, 10);
    assert.equal(alert.evidence.threshold, CATASTROPHE_DEFAULTS.runawayRetryThreshold);
  });
});

// ── AC #4 — Guardrail schema ──────────────────────────────────────────────────

describe("detectCatastrophes — guardrail schema (AC #4)", () => {
  it("every guardrail has action, urgency, and description fields", () => {
    const ctx = { ...healthy(), retryCount: 10, consecutiveSloBreaches: 4, parseFailureCount: 5 };
    const r = detectCatastrophes(ctx);
    assert.ok(r.detections.length > 0);

    for (const alert of r.detections) {
      assert.ok(Array.isArray(alert.guardrails) && alert.guardrails.length >= 1,
        `${alert.scenarioId}: guardrails must have at least one entry`);
      for (const g of alert.guardrails) {
        assert.ok(Object.values(GUARDRAIL_ACTION).includes(g.action),
          `${alert.scenarioId}: guardrail.action "${g.action}" not in GUARDRAIL_ACTION`);
        assert.ok(Object.values(GUARDRAIL_URGENCY).includes(g.urgency),
          `${alert.scenarioId}: guardrail.urgency "${g.urgency}" not in GUARDRAIL_URGENCY`);
        assert.ok(typeof g.description === "string" && g.description.length > 0,
          `${alert.scenarioId}: guardrail.description must be a non-empty string`);
      }
    }
  });

  it("every scenario has at least one IMMEDIATE guardrail or one DEFERRED guardrail", () => {
    const scenarios = [
      { retryCount: 10 },
      { totalTasks: 4, blockedTasks: 3 },
      { janusDirectiveAgeMs: 9_000_000 },
      { parseFailureCount: 5 },
      { consecutiveBudgetBreaches: 3 },
      { consecutiveSloBreaches: 4 },
    ];
    for (const overrides of scenarios) {
      const r = detectCatastrophes({ ...healthy(), ...overrides });
      for (const alert of r.detections) {
        const urgencies = alert.guardrails.map(g => g.urgency);
        assert.ok(
          urgencies.includes(GUARDRAIL_URGENCY.IMMEDIATE) || urgencies.includes(GUARDRAIL_URGENCY.DEFERRED),
          `${alert.scenarioId}: must have at least one guardrail with a valid urgency`
        );
      }
    }
  });
});

// ── AC #3 — Overhead bound < 10ms per cycle ───────────────────────────────────

describe("detectCatastrophes — overhead bound (AC #3)", () => {
  it(`completes in < ${CATASTROPHE_DEFAULTS.overheadBudgetMs}ms with all 6 scenarios triggering`, () => {
    const ctx = {
      retryCount:                100,
      totalTasks:                5,
      blockedTasks:              4,
      janusDirectiveAgeMs:       10_000_000,
      prometheusAnalysisAgeMs:   10_000_000,
      parseFailureCount:         10,
      consecutiveBudgetBreaches: 5,
      consecutiveSloBreaches:    5,
    };

    // Warm up (eliminate JIT first-call cost)
    detectCatastrophes(ctx);

    const iterations = 100;
    const t0 = performance.now();
    for (let i = 0; i < iterations; i++) {
      detectCatastrophes(ctx);
    }
    const t1 = performance.now();
    const avgMs = (t1 - t0) / iterations;

    assert.ok(
      avgMs < CATASTROPHE_DEFAULTS.overheadBudgetMs,
      `Average overhead ${avgMs.toFixed(3)}ms exceeds budget ${CATASTROPHE_DEFAULTS.overheadBudgetMs}ms`
    );
  });
});

// ── AC #5 — False-positive rate < configured threshold ───────────────────────

describe("Replay harness — false-positive rate (AC #5)", () => {
  it("all positive fixtures trigger at least one detection (recall = 100%)", () => {
    const positives = listFixtures("positive");
    for (const { file, data } of positives) {
      const ctx = stripMeta(data);
      const r = detectCatastrophes(ctx);
      assert.ok(r.ok, `${file}: detectCatastrophes returned ok=false`);
      assert.ok(r.detections.length > 0,
        `${file}: expected at least one detection for scenario "${data._scenario}" but got 0`);

      // Each positive fixture has a _scenario field — verify that specific scenario is detected
      if (data._scenario) {
        const found = r.detections.find(d => d.scenarioId === data._scenario);
        assert.ok(found,
          `${file}: expected scenario "${data._scenario}" to be detected; got: ${r.detections.map(d => d.scenarioId).join(", ")}`);
      }
    }
  });

  it(`false-positive rate on negative fixtures is below ${CATASTROPHE_DEFAULTS.falsePositiveRateThreshold * 100}%`, () => {
    const negatives = listFixtures("negative");
    assert.ok(negatives.length > 0, "No negative fixtures found");

    let falsePositives = 0;
    for (const { file, data } of negatives) {
      const ctx = stripMeta(data);
      const r = detectCatastrophes(ctx);
      if (r.detections.length > 0) {
        falsePositives += 1;
        // Log for diagnostics — test still fails below
        console.error(`False positive in ${file}: ${r.detections.map(d => d.scenarioId).join(", ")}`);
      }
    }

    const rate = falsePositives / negatives.length;
    assert.ok(
      rate < CATASTROPHE_DEFAULTS.falsePositiveRateThreshold,
      `False-positive rate ${rate.toFixed(3)} (${falsePositives}/${negatives.length}) exceeds threshold ${CATASTROPHE_DEFAULTS.falsePositiveRateThreshold}`
    );
  });
});

// ── AC #10 — runCatastropheDetection returns explicit status on failure ────────

describe("runCatastropheDetection — degraded path (AC #10)", () => {
  it("returns ok=false, status=degraded, with reason when cycleData is null", async () => {
    const config = { paths: { stateDir: "/nonexistent/state" } };
    const result = await runCatastropheDetection(config, null);
    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
    assert.ok(typeof result.reason === "string" && result.reason.length > 0);
    assert.match(result.reason, /MISSING_INPUT/);
  });

  it("returns ok=false, status=degraded, with reason when cycleData is invalid type", async () => {
    const config = { paths: { stateDir: "/nonexistent/state" } };
    const result = await runCatastropheDetection(config, "not-an-object");
    assert.equal(result.ok, false);
    assert.equal(result.status, "degraded");
    assert.match(result.reason, /INVALID_INPUT/);
  });
});

// ── Threshold override tests ──────────────────────────────────────────────────

describe("detectCatastrophes — threshold overrides", () => {
  it("respects custom runawayRetryThreshold override", () => {
    // With default threshold (5), retryCount=3 would NOT trigger
    // With override of 2, it SHOULD trigger
    const ctx = { ...healthy(), retryCount: 3 };
    const r = detectCatastrophes(ctx, { runawayRetryThreshold: 2 });
    assert.ok(r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES),
      "Expected RUNAWAY_RETRIES with custom threshold override");
  });

  it("respects custom staleCriticalStateAgeMs override", () => {
    const ctx = { ...healthy(), janusDirectiveAgeMs: 1_000_000 }; // 1000s, default 7200s → no detect
    const r1 = detectCatastrophes(ctx);
    assert.equal(r1.detections.filter(d => d.scenarioId === CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE).length, 0);

    // Override threshold to 500_000ms — now should detect
    const r2 = detectCatastrophes(ctx, { staleCriticalStateAgeMs: 500_000 });
    assert.ok(r2.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.STALE_CRITICAL_STATE));
  });
});

// ── firstSeenTimestamps persistence across calls ──────────────────────────────

describe("detectCatastrophes — firstSeenAt persistence", () => {
  it("preserves firstSeenAt from firstSeenTimestamps when scenario re-detected", () => {
    const PAST_ISO = "2025-01-01T00:00:00.000Z";
    const ctx = {
      ...healthy(),
      retryCount: 10,
      firstSeenTimestamps: {
        [CATASTROPHE_SCENARIO.RUNAWAY_RETRIES]: PAST_ISO,
      },
    };
    const r = detectCatastrophes(ctx);
    const alert = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES);
    assert.ok(alert);
    assert.equal(alert.firstSeenAt, PAST_ISO, "firstSeenAt should be preserved from prior detection");
  });

  it("uses current timestamp as firstSeenAt when scenario is newly detected", () => {
    const before = Date.now();
    const ctx = { ...healthy(), retryCount: 10 };
    const r = detectCatastrophes(ctx);
    const alert = r.detections.find(d => d.scenarioId === CATASTROPHE_SCENARIO.RUNAWAY_RETRIES);
    const alertTs = Date.parse(alert.firstSeenAt);
    assert.ok(alertTs >= before, "firstSeenAt should be >= test start time");
  });
});

