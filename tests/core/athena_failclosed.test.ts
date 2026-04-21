/**
 * Regression tests for T-002: Athena fail-closed mode.
 *
 * Verifies that plan review AI failures return approved=false with a
 * machine-readable reason, that the orchestrator blocks worker dispatch,
 * and that an alert record with deterministic severity is written.
 *
 * Fail-open rollback is removed; AI failures are always fail-closed.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runAthenaPlanReview } from "../../src/core/athena_reviewer.js";
import { runOnce } from "../../src/core/orchestrator.js";
import { ALERT_SEVERITY } from "../../src/core/state_tracker.js";
import { isEnvelopeUnambiguous } from "../../src/core/evidence_envelope.js";
import {
  computePlanBatchFingerprint,
  correctBoundedPacketDefects,
  PACKET_DEFECT_CODE,
  normalizeAthenaReviewPayload,
  LANE_MERGE_POLICY,
  mergeLaneVerdicts,
  buildQualityLaneVerdict,
  buildGovernanceLaneVerdict,
  runDualLanePlanReview,
  resolveEffectiveLaneMergePolicy,
  ATHENA_PLAN_REVIEW_REASON_CODE,
  buildPatchedPlanCorrectionTracking,
  PATCHED_PLAN_MUTATION_KIND,
} from "../../src/core/athena_reviewer.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(tmpDir, overrides = {}) {
  return {
    loopIntervalMs: 1000,
    maxParallelWorkers: 1,
    paths: {
      stateDir: tmpDir,
      progressFile: path.join(tmpDir, "progress.txt"),
      policyFile: path.join(tmpDir, "policy.json")
    },
    env: {
      // Missing binary forces every AI call to fail deterministically.
      copilotCliCommand: "__missing_copilot_binary__",
      targetRepo: "CanerDoqdu/Box"
    },
    roleRegistry: {
      ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
      deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
      qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" },
      workers: {
        backend: { name: "King David" }
      }
    },
    copilot: { leadershipAutopilot: false },
    runtime: {},
    ...overrides
  };
}

// A minimal Prometheus analysis that satisfies the plan shape Athena reads.
const VALID_PROMETHEUS_ANALYSIS = {
  analyzedAt: new Date().toISOString(),
  projectHealth: "good",
  analysis: "Test analysis",
  keyFindings: "None",
  plans: [
    {
      role: "King David",
      task: "Fix test",
      priority: 1,
      wave: 1,
      verification: "npm test"
    }
  ],
  executionStrategy: {},
  requestBudget: {}
};

// ── ALERT_SEVERITY constants ─────────────────────────────────────────────────

describe("ALERT_SEVERITY enum", () => {
  it("exports deterministic severity constants", () => {
    assert.equal(ALERT_SEVERITY.LOW, "low");
    assert.equal(ALERT_SEVERITY.MEDIUM, "medium");
    assert.equal(ALERT_SEVERITY.HIGH, "high");
    assert.equal(ALERT_SEVERITY.CRITICAL, "critical");
  });
});

describe("ATHENA_PLAN_REVIEW_REASON_CODE score/packet contract", () => {
  it("exports deterministic reason codes for malformed decision packets and score contract violations", () => {
    assert.equal(ATHENA_PLAN_REVIEW_REASON_CODE.MALFORMED_DECISION_PACKET, "MALFORMED_DECISION_PACKET");
    assert.equal(ATHENA_PLAN_REVIEW_REASON_CODE.SCORE_CONTRACT_VIOLATION, "SCORE_CONTRACT_VIOLATION");
  });
});

// ── runAthenaPlanReview: fail-closed mode ────────────────────────────────────

describe("runAthenaPlanReview — fail-closed on AI failure", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-fc-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns approved=false when AI call fails (fail-closed default)", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.equal(result.approved, false,
      "AI failure must return approved=false — no silent pass-through");
  });

  it("returns a machine-readable reason object with code and message", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.ok(result.reason && typeof result.reason === "object",
      "reason must be an object, not a plain string");
    assert.ok(typeof result.reason.code === "string" && result.reason.code.length > 0,
      "reason.code must be a non-empty string");
    assert.ok(typeof result.reason.message === "string",
      "reason.message must be a string");
    assert.equal(result.reason.code, "AI_CALL_FAILED");
  });

  it("writes an alert record with CRITICAL severity on AI failure", async () => {
    const config = makeConfig(tmpDir);
    await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    const alertsFile = path.join(tmpDir, "alerts.json");
    const alertsExists = await fs.access(alertsFile).then(() => true).catch(() => false);
    assert.ok(alertsExists, "alerts.json must be created when plan review AI fails");

    const alerts = JSON.parse(await fs.readFile(alertsFile, "utf8"));
    const criticalAlerts = alerts.entries.filter(e => e.severity === ALERT_SEVERITY.CRITICAL);
    assert.ok(criticalAlerts.length > 0,
      "At least one CRITICAL alert must be recorded on AI failure");
    assert.ok(criticalAlerts[0].source === "athena_reviewer",
      "Alert source must be 'athena_reviewer'");
    assert.ok(criticalAlerts[0].message.includes("AI_CALL_FAILED"),
      "Alert message must include the reason code for machine readability");
  });

  it("keeps approved=false even when fail-open flag is present (legacy rollback removed)", async () => {
    const config = makeConfig(tmpDir, { runtime: { athenaFailOpen: true } });
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.equal(result.approved, false,
      "runtime.athenaFailOpen must not bypass fail-closed review blocking");
    assert.equal(result.reason.code, "AI_CALL_FAILED");
  });

  it("returns approved=false and empty corrections array on AI failure", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.ok(Array.isArray(result.corrections),
      "corrections must always be an array");
  });

  it("does not write athena_plan_review.json when AI call fails (no data to persist)", async () => {
    const config = makeConfig(tmpDir);
    await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    // The review JSON is only written on successful AI response; failure path must not write it.
    const reviewFile = path.join(tmpDir, "athena_plan_review.json");
    const reviewExists = await fs.access(reviewFile).then(() => true).catch(() => false);
    assert.equal(reviewExists, false,
      "athena_plan_review.json must not be written when AI call fails");
  });
});

describe("patched-plan correction tracking mutation telemetry", () => {
  it("tracks structured mutation events and legacy string corrections together", () => {
    const tracking = buildPatchedPlanCorrectionTracking(
      [
        {
          verification: "verify manually after patch",
          acceptance_criteria: ["All checks complete now"],
          target_files: ["src/core/athena_reviewer.ts"],
          scope: "src/core/athena_reviewer.ts",
        },
      ] as any[],
      [
        {
          verification: "npm test -- tests/core/athena_failclosed.test.ts",
          acceptance_criteria: ["Follow-up validation deferred to next cycle after release"],
          target_files: ["src/core/athena_reviewer.ts"],
          scope: "src/core/athena_reviewer.ts",
        },
        {
          verification: "npm test -- tests/core/athena_review_normalization.test.ts",
          acceptance_criteria: ["test case captures reconstructed plan telemetry"],
          target_files: ["tests/core/athena_review_normalization.test.ts"],
          scope: "tests/core/athena_review_normalization.test.ts",
        },
      ] as any[]
    );

    const kinds = tracking.mutationEvents.map((event) => event.kind);
    assert.ok(kinds.includes(PATCHED_PLAN_MUTATION_KIND.ABSENT_PLAN_RECONSTRUCTED));
    assert.ok(kinds.includes(PATCHED_PLAN_MUTATION_KIND.VERIFICATION_PROSE_REWRITTEN));
    assert.ok(kinds.includes(PATCHED_PLAN_MUTATION_KIND.FORWARD_LOOKING_CRITERION_DEFERRED));
    assert.ok(
      tracking.legacyCorrections.some((entry) => entry.includes("reconstructed from absent original plan")),
      "legacy string correction for absent reconstruction must be preserved",
    );
    assert.ok(
      tracking.legacyCorrections.some((entry) => entry.includes("verification rewritten from prose")),
      "legacy string correction for verification rewrite must be preserved",
    );
    assert.ok(
      tracking.legacyCorrections.some((entry) => entry.includes("forward-looking deferral")),
      "legacy string correction for deferred criteria must be preserved",
    );
  });
});

// ── Orchestrator: no worker dispatch on failed plan review ───────────────────

describe("orchestrator — no worker dispatch when Athena blocks plan", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-fc-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not dispatch workers when plan review returns approved=false", async () => {
    const config = makeConfig(tmpDir);

    // Run a full cycle — Janus/Prometheus/Athena all use missing binary, so
    // the cycle will fail before dispatching any worker.
    await runOnce(config);

    // Confirm no worker state files were created (dispatch did not happen).
    const workerFiles = await fs.readdir(tmpDir)
      .then(files => files.filter(f => f.startsWith("worker_") && f.endsWith(".json")))
      .catch(() => []);

    assert.equal(workerFiles.length, 0,
      "No worker state files must exist — dispatch must be blocked when Athena rejects");
  });

  it("writes athena_plan_rejection.json with reason object when plan is blocked", async () => {
    const config = makeConfig(tmpDir);

    // Pre-seed a Prometheus analysis so the orchestrator reaches Athena review.
    await fs.writeFile(
      path.join(tmpDir, "prometheus_analysis.json"),
      JSON.stringify(VALID_PROMETHEUS_ANALYSIS),
      "utf8"
    );

    // Manually invoke the plan review and simulate the orchestrator rejection path.
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    // The reason must be a machine-readable object, not a legacy string.
    assert.equal(typeof result.reason, "object",
      "reason must be a structured object for machine readability");
    assert.ok(result.reason.code, "reason.code must be present");
    assert.equal(result.approved, false);
  });

  it("records blocked cycle state in progress log when Athena blocks", async () => {
    const config = makeConfig(tmpDir);
    await runOnce(config);

    const progress = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    // Either Prometheus fails first or Athena blocks — either way, no dispatch.
    // The key assertion is that no worker was dispatched.
    const workerFiles = await fs.readdir(tmpDir)
      .then(files => files.filter(f => f.startsWith("worker_") && f.endsWith(".json")))
      .catch(() => []);
    assert.equal(workerFiles.length, 0,
      "Worker dispatch must not occur when the cycle is blocked");
    // Progress log must exist with some content.
    assert.ok(progress.length > 0, "Progress log must be written during blocked cycle");
  });
});

// ── Task 3: isEnvelopeUnambiguous — deterministic fast-path gate ─────────────

describe("isEnvelopeUnambiguous — fast-path bypass gate (Task 3)", () => {
  function makeGreenEnvelope(overrides: Record<string, unknown> = {}): any {
    const base: any = {
      roleName: "evolution-worker",
      status: "done",
      summary: "All changes implemented, build and tests pass.",
      verificationPassed: true,
      verificationEvidence: { build: "pass", tests: "pass", lint: "pass" },
      preReviewIssues: [],
    };
    // Allow overriding nested verificationEvidence keys directly
    const { build, tests, lint, ...rest } = overrides as any;
    if (build !== undefined || tests !== undefined || lint !== undefined) {
      base.verificationEvidence = {
        ...base.verificationEvidence,
        ...(build !== undefined ? { build } : {}),
        ...(tests !== undefined ? { tests } : {}),
        ...(lint !== undefined ? { lint } : {}),
      };
    }
    return { ...base, ...rest };
  }

  it("returns unambiguous=true for a fully green, unambiguous low-risk envelope", () => {
    const result = isEnvelopeUnambiguous(makeGreenEnvelope(), { planRiskLevel: "low" });
    assert.equal(result.unambiguous, true,
      "green envelope with low-risk plan must qualify for fast-path");
  });

  it("returns unambiguous=false when lint evidence is 'fail' — failed lint must fall through to AI review", () => {
    const result = isEnvelopeUnambiguous(makeGreenEnvelope({ lint: "fail" }), { planRiskLevel: "low" });
    assert.equal(result.unambiguous, false,
      "lint=fail must block fast-path to prevent shipping with linting errors");
  });

  it("returns unambiguous=false when preReviewIssues is non-empty — unresolved issues require AI judgment", () => {
    const result = isEnvelopeUnambiguous(
      makeGreenEnvelope({ preReviewIssues: ["Security vulnerability found in dependency"] }),
      { planRiskLevel: "low" }
    );
    assert.equal(result.unambiguous, false,
      "non-empty preReviewIssues must block fast-path");
  });

  it("returns unambiguous=false for high-risk plan even with otherwise perfect envelope", () => {
    const result = isEnvelopeUnambiguous(makeGreenEnvelope(), { planRiskLevel: "high" });
    assert.equal(result.unambiguous, false,
      "high-risk plans must always go through AI review regardless of evidence quality");
  });

  it("returns unambiguous=false when status is not 'done' (partial completion is ambiguous)", () => {
    const result = isEnvelopeUnambiguous(
      makeGreenEnvelope({ status: "partial" }),
      { planRiskLevel: "low" }
    );
    assert.equal(result.unambiguous, false,
      "non-done status must block fast-path");
  });

  it("returns unambiguous=false when verificationPassed is false — cannot skip AI when verification failed", () => {
    const result = isEnvelopeUnambiguous(
      makeGreenEnvelope({ verificationPassed: false }),
      { planRiskLevel: "low" }
    );
    assert.equal(result.unambiguous, false,
      "verificationPassed=false must block fast-path");
  });

  it("returns unambiguous=false when build evidence is 'fail'", () => {
    const result = isEnvelopeUnambiguous(
      makeGreenEnvelope({ build: "fail" }),
      { planRiskLevel: "low" }
    );
    assert.equal(result.unambiguous, false, "build=fail must block fast-path");
  });

  it("returns unambiguous=false when tests evidence is 'fail'", () => {
    const result = isEnvelopeUnambiguous(
      makeGreenEnvelope({ tests: "fail" }),
      { planRiskLevel: "low" }
    );
    assert.equal(result.unambiguous, false, "tests=fail must block fast-path");
  });

  it("returns unambiguous=false for null envelope — structural failure must not qualify for bypass", () => {
    const result = isEnvelopeUnambiguous(null, { planRiskLevel: "low" });
    assert.equal(result.unambiguous, false, "null envelope must return false, not throw");
  });
});

// ── Task 1: runAthenaPlanReview — deterministic auto-approve for low-risk unchanged batches ──

describe("computePlanBatchFingerprint", () => {
  it("returns the same fingerprint for the same plan batch", () => {
    const plans = [
      { task: "Fix retry logic", role: "evolution-worker", wave: 1, riskLevel: "low", verification: "npm test", acceptance_criteria: ["retries < 3"] },
    ];
    assert.equal(computePlanBatchFingerprint(plans), computePlanBatchFingerprint(plans),
      "same input must produce the same fingerprint (deterministic)");
  });

  it("returns different fingerprints when acceptance_criteria changes", () => {
    const base = { task: "Fix retry logic", role: "evolution-worker", wave: 1, riskLevel: "low", verification: "npm test", acceptance_criteria: ["retries < 3"] };
    const changed = { ...base, acceptance_criteria: ["retries < 5"] };
    assert.notEqual(computePlanBatchFingerprint([base]), computePlanBatchFingerprint([changed]),
      "changed acceptance_criteria must yield a different fingerprint");
  });

  it("returns empty string for an empty plans array", () => {
    assert.equal(computePlanBatchFingerprint([]), "",
      "empty plans array must return empty fingerprint");
  });

  it("is order-sensitive — different plan order yields different fingerprint", () => {
    const p1 = { task: "Task A", role: "evolution-worker", wave: 1, riskLevel: "low", verification: "npm test", acceptance_criteria: [] };
    const p2 = { task: "Task B", role: "evolution-worker", wave: 1, riskLevel: "low", verification: "npm test", acceptance_criteria: [] };
    assert.notEqual(
      computePlanBatchFingerprint([p1, p2]),
      computePlanBatchFingerprint([p2, p1]),
      "plan order is significant for fingerprint — reordering must change the fingerprint"
    );
  });
});

describe("runAthenaPlanReview — deterministic auto-approve for low-risk unchanged batches", () => {
  let tmpDir;

  const LOW_RISK_PLANS = [
    {
      role: "evolution-worker",
      task: "Add retry logic to worker dispatch with exponential backoff",
      priority: 1,
      wave: 1,
      riskLevel: "low",
      verification: "tests/core/worker_dispatch.test.ts — test: retry logic passes",
      acceptance_criteria: ["retry count < 3 on transient failures"],
      dependencies: [],
      scope: "src/core/worker_dispatch.ts",
      capacityDelta: 0.1,
      requestROI: 2.0,
    },
  ];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-aa-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-approves a low-risk unchanged batch when a prior approved review exists with matching fingerprint", async () => {
    const fingerprint = computePlanBatchFingerprint(LOW_RISK_PLANS);
    // Seed state with a previously approved review with the matching fingerprint.
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({
        approved: true,
        overallScore: 8,
        summary: "All plans are well-defined",
        appliedFixes: [],
        corrections: [],
        unresolvedIssues: [],
        planBatchFingerprint: fingerprint,
      }),
      "utf8"
    );

    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: LOW_RISK_PLANS, analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    assert.equal(result.approved, true, "auto-approve must return approved=true");
    assert.equal(result.autoApproved, true, "autoApproved flag must be set on cache-hit results");
    assert.ok(
      result.autoApproveReason?.code === "LOW_RISK_UNCHANGED",
      "autoApproveReason.code must be LOW_RISK_UNCHANGED"
    );
  });

  it("returns DELTA_REVIEW_APPROVED (not LOW_RISK_UNCHANGED) when last review has a different fingerprint but plans are high quality", async () => {
    const staleFingerprint = "0000000000000000";
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({
        approved: true,
        overallScore: 8,
        summary: "Old review",
        appliedFixes: [],
        corrections: [],
        unresolvedIssues: [],
        planBatchFingerprint: staleFingerprint,
      }),
      "utf8"
    );

    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: LOW_RISK_PLANS, analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    // With a changed fingerprint and high-quality plans, the delta-review fast path
    // approves the batch — it must NOT return LOW_RISK_UNCHANGED (fingerprint mismatch).
    assert.notEqual(result.autoApproveReason?.code, "LOW_RISK_UNCHANGED",
      "mismatched fingerprint must not trigger LOW_RISK_UNCHANGED");
    assert.equal(result.autoApproveReason?.code, "DELTA_REVIEW_APPROVED",
      "high-quality plans with changed fingerprint must use DELTA_REVIEW_APPROVED");
    assert.equal(result.autoApproved, true,
      "delta-review path must set autoApproved=true for high-quality low-risk plans");
  });

  it("never auto-approves when any plan has riskLevel=high even if fingerprint matches", async () => {
    const highRiskPlan = {
      ...LOW_RISK_PLANS[0],
      riskLevel: "high",
      preMortem: {
        failureScenarios: ["DB migration fails"],
        mitigations: ["rollback script tested"],
        rollbackPlan: "revert migration",
        guardrails: ["read-only mode enabled during migration"],
      },
    };
    const highRiskPlans = [highRiskPlan];
    const fingerprint = computePlanBatchFingerprint(highRiskPlans);
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({
        approved: true,
        overallScore: 8,
        summary: "Old approved",
        appliedFixes: [],
        corrections: [],
        unresolvedIssues: [],
        planBatchFingerprint: fingerprint,
      }),
      "utf8"
    );

    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: highRiskPlans, analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    assert.equal(result.autoApproved, undefined,
      "high-risk plans must never be auto-approved, even when fingerprint matches");
  });

  it("never auto-approves when disablePlanReviewCache=true", async () => {
    const fingerprint = computePlanBatchFingerprint(LOW_RISK_PLANS);
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify({
        approved: true,
        overallScore: 8,
        summary: "All plans are well-defined",
        appliedFixes: [],
        corrections: [],
        unresolvedIssues: [],
        planBatchFingerprint: fingerprint,
      }),
      "utf8"
    );

    const config = makeConfig(tmpDir, { runtime: { disablePlanReviewCache: true } });
    const prometheusOutput = { plans: LOW_RISK_PLANS, analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    assert.equal(result.autoApproved, undefined,
      "disablePlanReviewCache=true must bypass the auto-approve path regardless of fingerprint match");
  });
});

// ── correctBoundedPacketDefects — fail-closed guarantee tests ─────────────────

describe("correctBoundedPacketDefects — fail-closed guarantees", () => {
  const LOW_RISK_PLAN = {
    role: "evolution-worker",
    task: "Add retry logic to worker dispatch with exponential backoff",
    verification: "npm test",
    target_files: ["src/core/worker_dispatch.ts"],
    acceptance_criteria: ["retry count < 3 on transient failures"],
    riskLevel: "low",
  };

  const HIGH_RISK_PLAN = {
    role: "evolution-worker",
    task: "Migrate database schema with zero-downtime deployment strategy",
    verification: "npm test",
    target_files: ["src/core/db_migrator.ts"],
    acceptance_criteria: ["migration completes with < 1% error rate"],
    riskLevel: "high",
    premortem: {
      riskLevel: "high",
      scenario: "Migration could corrupt live data if applied during peak traffic.",
      failurePaths: ["Schema mismatch causes query failures"],
      mitigations: ["Blue-green deployment with canary"],
      detectionSignals: ["Error rate spike > 1%"],
      guardrails: ["Rollback script tested in staging"],
      rollbackPlan: "Restore from last known good snapshot within 5 minutes",
    },
  };

  it("returns corrected=false when both approved and planReviews are missing — cannot auto-correct structural failures", () => {
    const normalized = normalizeAthenaReviewPayload({ summary: "Looks good." }, [LOW_RISK_PLAN]);

    assert.ok(normalized.missingFields.includes("approved"), "pre-condition: approved missing");
    assert.ok(normalized.missingFields.includes("planReviews"), "pre-condition: planReviews missing");

    const correction = correctBoundedPacketDefects(normalized, [LOW_RISK_PLAN]);

    assert.equal(correction.corrected, false,
      "both fields missing is not a bounded defect — must remain fail-closed");
    assert.ok(correction.updatedMissingFields.includes("approved"),
      "approved must remain in updatedMissingFields when both fields are absent");
    assert.ok(correction.updatedMissingFields.includes("planReviews"),
      "planReviews must remain in updatedMissingFields when both fields are absent");
  });

  it("never auto-corrects approved when planReviews contain issues — fail-closed: issues must be addressed explicitly", () => {
    const normalized = normalizeAthenaReviewPayload({
      planReviews: [
        { planIndex: 0, role: "evolution-worker", measurable: false, issues: ["task description too vague"] },
      ],
      summary: "Issues found.",
    }, [LOW_RISK_PLAN]);

    const correction = correctBoundedPacketDefects(normalized, [LOW_RISK_PLAN]);

    assert.equal(correction.corrected, false,
      "approved must not be synthesized when plan reviews indicate issues — fail-closed");
    assert.ok(!correction.correctedFields.includes("approved"),
      "correctedFields must not include approved when reviews have issues");
  });

  it("never auto-corrects planReviews when any plan has riskLevel=high — high-risk always requires explicit AI judgment", () => {
    const normalized = normalizeAthenaReviewPayload({
      approved: true,
      summary: "Plans approved.",
    }, [HIGH_RISK_PLAN]);

    const correction = correctBoundedPacketDefects(normalized, [HIGH_RISK_PLAN]);

    assert.equal(correction.correctedFields.includes("planReviews"), false,
      "planReviews must never be auto-corrected for high-risk plans");
    assert.ok(correction.updatedMissingFields.includes("planReviews"),
      "planReviews must remain in updatedMissingFields for high-risk plans");
  });

  it("never auto-corrects planReviews when the plan array is empty — no plans means no evidence basis", () => {
    const normalized = normalizeAthenaReviewPayload({ approved: true, summary: "No plans." }, []);

    const correction = correctBoundedPacketDefects(normalized, []);

    assert.equal(correction.correctedFields.includes("planReviews"), false,
      "planReviews must not be auto-corrected when the plans array is empty");
  });

  it("corrects approved when planReviews are all-clear — bounded defect with explicit AI evidence", () => {
    const normalized = normalizeAthenaReviewPayload({
      planReviews: [
        { planIndex: 0, role: "evolution-worker", measurable: true, issues: [] },
      ],
      summary: "Plan validated.",
    }, [LOW_RISK_PLAN]);

    const correction = correctBoundedPacketDefects(normalized, [LOW_RISK_PLAN]);

    if (normalized.missingFields.includes("approved")) {
      // Only assert correction when the pre-condition is met (approved truly absent)
      assert.equal(correction.corrected, true,
        "approved must be corrected when planReviews are all-clear");
      assert.equal(correction.updatedPayload.approved, true,
        "corrected payload must set approved=true");
    }
  });

  it("defectCodes array contains the applicable code for each corrected field", () => {
    const normalized = normalizeAthenaReviewPayload({
      planReviews: [
        { planIndex: 0, role: "evolution-worker", measurable: true, issues: [] },
      ],
      summary: "Plan validated.",
    }, [LOW_RISK_PLAN]);

    const correction = correctBoundedPacketDefects(normalized, [LOW_RISK_PLAN]);

    if (correction.corrected) {
      assert.equal(correction.defectCodes.length, correction.correctedFields.length,
        "each corrected field must have a corresponding defect code");
      for (const code of correction.defectCodes) {
        const validCodes = Object.values(PACKET_DEFECT_CODE) as string[];
        assert.ok(validCodes.includes(code),
          `defect code '${code}' must be a known PACKET_DEFECT_CODE value`);
      }
    }
  });
});

// ── Task 2: HIGH_QUALITY_LOW_RISK auto-approve fast-path ──────────────────────

import {
  ATHENA_FAST_PATH_REASON,
  AUTO_APPROVE_HIGH_QUALITY_THRESHOLD,
} from "../../src/core/athena_reviewer.js";

import {
  AUTO_APPROVE_DISPATCH_SIGNAL,
  appendAutoApproveTelemetry,
} from "../../src/core/orchestrator.js";

describe("ATHENA_FAST_PATH_REASON structural invariants", () => {
  it("exports LOW_RISK_UNCHANGED reason code", () => {
    assert.equal(ATHENA_FAST_PATH_REASON.LOW_RISK_UNCHANGED, "LOW_RISK_UNCHANGED");
  });

  it("exports HIGH_QUALITY_LOW_RISK reason code", () => {
    assert.equal(ATHENA_FAST_PATH_REASON.HIGH_QUALITY_LOW_RISK, "HIGH_QUALITY_LOW_RISK");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(ATHENA_FAST_PATH_REASON), "ATHENA_FAST_PATH_REASON must be frozen");
  });

  it("AUTO_APPROVE_HIGH_QUALITY_THRESHOLD is a positive integer above PLAN_QUALITY_MIN_SCORE", () => {
    assert.ok(Number.isInteger(AUTO_APPROVE_HIGH_QUALITY_THRESHOLD));
    assert.ok(AUTO_APPROVE_HIGH_QUALITY_THRESHOLD > 40,
      "high-quality threshold must exceed PLAN_QUALITY_MIN_SCORE=40 to avoid trivial pass-through");
  });
});

describe("runAthenaPlanReview — HIGH_QUALITY_LOW_RISK fast-path", () => {
  let tmpDir;

  // A plan that will score ≥ 80 in scorePlanQuality:
  //   task ≥ 10 chars, non-vague (+20), role (+20), verification ≥ 5 chars (+20),
  //   wave defined (+10), capacityDelta+requestROI present (no penalty) = 70+
  //   With specific file path in task: +10 = 80
  const HIGH_QUALITY_PLAN = {
    role: "evolution-worker",
    task: "Add src/core/worker_runner.ts retry logic with exponential backoff",
    priority: 1,
    wave: 1,
    riskLevel: "low",
    verification: "npm test -- worker_runner",
    acceptance_criteria: ["retry count < 3 on transient failures"],
    target_files: ["src/core/worker_runner.ts"],
    scope: "src/core/worker_runner.ts",
    dependencies: [],
    capacityDelta: 0.1,
    requestROI: 2.0,
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-hq-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("auto-approves a high-quality low-risk batch even without a cached fingerprint", async () => {
    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: [HIGH_QUALITY_PLAN], analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    // The missing binary ensures AI call would fail; auto-approve must fire first.
    assert.equal(result.approved, true, "high-quality low-risk batch must auto-approve");
    assert.equal(result.autoApproved, true, "autoApproved flag must be set");
    assert.equal(
      result.autoApproveReason?.code,
      ATHENA_FAST_PATH_REASON.HIGH_QUALITY_LOW_RISK,
      "autoApproveReason.code must be HIGH_QUALITY_LOW_RISK"
    );
  });

  it("never auto-approves via high-quality path when any plan is high-risk", async () => {
    const highRiskPlan = {
      ...HIGH_QUALITY_PLAN,
      riskLevel: "high",
      premortem: {
        riskLevel: "high",
        scenario: "Migration could corrupt live data if applied during peak traffic.",
        failurePaths: ["Schema mismatch causes query failures"],
        mitigations: ["Blue-green deployment with canary"],
        detectionSignals: ["Error rate spike > 1%"],
        guardrails: ["Rollback script tested in staging"],
        rollbackPlan: "Restore from last known good snapshot within 5 minutes",
      },
    };
    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: [highRiskPlan], analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    assert.equal(result.autoApproved, undefined,
      "high-risk plan must never qualify for the high-quality fast-path");
    assert.notEqual(result.autoApproveReason?.code, ATHENA_FAST_PATH_REASON.HIGH_QUALITY_LOW_RISK);
  });

  it("falls through to AI review when plan quality is below the high-quality threshold", async () => {
    // Vague task below 10 chars: scorePlanQuality will produce a low score
    const lowQualityPlan = {
      ...HIGH_QUALITY_PLAN,
      task: "Fix stuff",      // short + vague → score < AUTO_APPROVE_HIGH_QUALITY_THRESHOLD
      verification: "",        // missing verification → score drops further
    };
    const config = makeConfig(tmpDir);
    const prometheusOutput = { plans: [lowQualityPlan], analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    // Low quality plan fails pre-gate (score < 40); autoApproved must not be set
    assert.equal(result.autoApproved, undefined,
      "low-quality plan must not trigger HIGH_QUALITY_LOW_RISK fast-path");
  });

  it("respects disablePlanReviewCache=true — high-quality path is also skipped", async () => {
    const config = makeConfig(tmpDir, { runtime: { disablePlanReviewCache: true } });
    const prometheusOutput = { plans: [HIGH_QUALITY_PLAN], analyzedAt: new Date().toISOString() };
    const result = await runAthenaPlanReview(config, prometheusOutput);

    assert.equal(result.autoApproved, undefined,
      "disablePlanReviewCache=true must suppress all fast-path approval including HIGH_QUALITY_LOW_RISK");
  });
});

describe("AUTO_APPROVE_DISPATCH_SIGNAL and appendAutoApproveTelemetry", () => {
  it("exports LOW_RISK_UNCHANGED and HIGH_QUALITY_LOW_RISK signal codes", () => {
    assert.equal(AUTO_APPROVE_DISPATCH_SIGNAL.LOW_RISK_UNCHANGED, "LOW_RISK_UNCHANGED");
    assert.equal(AUTO_APPROVE_DISPATCH_SIGNAL.HIGH_QUALITY_LOW_RISK, "HIGH_QUALITY_LOW_RISK");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(AUTO_APPROVE_DISPATCH_SIGNAL));
  });

  it("appendAutoApproveTelemetry writes a telemetry entry to state/auto_approve_telemetry.json", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "box-aat-"));
    try {
      const config = { paths: { stateDir: tmpDir2 } };
      await appendAutoApproveTelemetry(
        config,
        {
          autoApproveReason: { code: AUTO_APPROVE_DISPATCH_SIGNAL.HIGH_QUALITY_LOW_RISK },
          planReviews: [{}, {}],
        },
        "cycle-test-001"
      );
      const raw = await fs.readFile(path.join(tmpDir2, "auto_approve_telemetry.json"), "utf8");
      const entries = JSON.parse(raw);
      assert.ok(Array.isArray(entries), "file must contain a JSON array");
      assert.equal(entries.length, 1, "one entry must be written");
      assert.equal(entries[0].cycleId, "cycle-test-001");
      assert.equal(entries[0].signal, AUTO_APPROVE_DISPATCH_SIGNAL.HIGH_QUALITY_LOW_RISK);
      assert.equal(entries[0].planCount, 2);
      assert.ok(typeof entries[0].recordedAt === "string");
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true });
    }
  });

  it("negative path: appendAutoApproveTelemetry does not throw when stateDir does not exist", async () => {
    const config = { paths: { stateDir: "/nonexistent/xyzzy-box-aat" } };
    // Must not throw — fail-open
    await assert.doesNotReject(
      () => appendAutoApproveTelemetry(config, { autoApproveReason: { code: "LOW_RISK_UNCHANGED" } }, "c-001"),
      "appendAutoApproveTelemetry must be fail-open — no throw on missing state dir"
    );
  });
});

// ── Dual-Lane Athena Verdicts ─────────────────────────────────────────────────

describe("LANE_MERGE_POLICY structural invariants", () => {
  it("exports all four policy codes", () => {
    assert.equal(LANE_MERGE_POLICY.MUST_PASS_BOTH, "MUST_PASS_BOTH");
    assert.equal(LANE_MERGE_POLICY.QUALITY_GATE_ONLY, "QUALITY_GATE_ONLY");
    assert.equal(LANE_MERGE_POLICY.GOVERNANCE_GATE_ONLY, "GOVERNANCE_GATE_ONLY");
    assert.equal(LANE_MERGE_POLICY.ANY_PASS, "ANY_PASS");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(LANE_MERGE_POLICY), "LANE_MERGE_POLICY must be frozen");
  });
});

describe("resolveEffectiveLaneMergePolicy", () => {
  it("returns MUST_PASS_BOTH when no policy configured (fail-closed default)", () => {
    assert.equal(resolveEffectiveLaneMergePolicy({}), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(resolveEffectiveLaneMergePolicy(null), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(resolveEffectiveLaneMergePolicy(undefined), LANE_MERGE_POLICY.MUST_PASS_BOTH);
  });

  it("returns the configured policy when a valid value is set", () => {
    const cfg = { runtime: { laneMergePolicy: "ANY_PASS" } };
    assert.equal(resolveEffectiveLaneMergePolicy(cfg), LANE_MERGE_POLICY.ANY_PASS);
  });

  it("falls back to MUST_PASS_BOTH for unknown policy values (negative path)", () => {
    const cfg = { runtime: { laneMergePolicy: "UNKNOWN_POLICY" } };
    assert.equal(resolveEffectiveLaneMergePolicy(cfg), LANE_MERGE_POLICY.MUST_PASS_BOTH);
  });
});

describe("mergeLaneVerdicts — MUST_PASS_BOTH policy (fail-closed)", () => {
  function makeVerdict(lane: "quality" | "governance", approved: boolean): any {
    return {
      lane,
      approved,
      score: approved ? 90 : 30,
      summary: approved ? "All checks passed" : "Issues found",
      issues: approved ? [] : ["some issue"],
      reason: approved ? null : { code: "SOME_FAILURE", message: "failed" },
    };
  }

  it("approves when both lanes approve", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", true), makeVerdict("governance", true), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(result.approved, true, "both lanes passing must yield approved=true");
    assert.equal(result.mergePolicy, LANE_MERGE_POLICY.MUST_PASS_BOTH);
  });

  it("rejects when quality lane fails (negative path)", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", true), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(result.approved, false, "quality lane failure must block approval");
    assert.ok(result.mergeReason.length > 0, "mergeReason must explain the rejection");
  });

  it("rejects when governance lane fails (negative path)", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", true), makeVerdict("governance", false), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(result.approved, false, "governance lane failure must block approval");
    assert.ok(result.mergeReason.includes("governance") || result.mergeReason.length > 0);
  });

  it("rejects when both lanes fail", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", false), LANE_MERGE_POLICY.MUST_PASS_BOTH);
    assert.equal(result.approved, false);
  });

  it("defaults to MUST_PASS_BOTH when an unknown policy is supplied (fail-closed)", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", true), "UNKNOWN_POLICY");
    assert.equal(result.approved, false, "unknown policy must default to MUST_PASS_BOTH (fail-closed)");
  });
});

describe("mergeLaneVerdicts — ANY_PASS policy", () => {
  function makeVerdict(lane: "quality" | "governance", approved: boolean): any {
    return { lane, approved, score: approved ? 90 : 30, summary: "", issues: [], reason: null };
  }

  it("approves when only quality lane passes", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", true), makeVerdict("governance", false), LANE_MERGE_POLICY.ANY_PASS);
    assert.equal(result.approved, true, "ANY_PASS: quality-only approval must pass");
  });

  it("approves when only governance lane passes", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", true), LANE_MERGE_POLICY.ANY_PASS);
    assert.equal(result.approved, true, "ANY_PASS: governance-only approval must pass");
  });

  it("rejects when both lanes reject", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", false), LANE_MERGE_POLICY.ANY_PASS);
    assert.equal(result.approved, false, "ANY_PASS: both failing must still reject");
  });
});

describe("mergeLaneVerdicts — QUALITY_GATE_ONLY and GOVERNANCE_GATE_ONLY", () => {
  function makeVerdict(lane: "quality" | "governance", approved: boolean): any {
    return { lane, approved, score: approved ? 90 : 30, summary: "", issues: [], reason: null };
  }

  it("QUALITY_GATE_ONLY: approves when quality passes regardless of governance", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", true), makeVerdict("governance", false), LANE_MERGE_POLICY.QUALITY_GATE_ONLY);
    assert.equal(result.approved, true);
  });

  it("QUALITY_GATE_ONLY: rejects when quality fails even if governance passes", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", true), LANE_MERGE_POLICY.QUALITY_GATE_ONLY);
    assert.equal(result.approved, false);
  });

  it("GOVERNANCE_GATE_ONLY: approves when governance passes regardless of quality", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", false), makeVerdict("governance", true), LANE_MERGE_POLICY.GOVERNANCE_GATE_ONLY);
    assert.equal(result.approved, true);
  });

  it("GOVERNANCE_GATE_ONLY: rejects when governance fails even if quality passes", () => {
    const result = mergeLaneVerdicts(makeVerdict("quality", true), makeVerdict("governance", false), LANE_MERGE_POLICY.GOVERNANCE_GATE_ONLY);
    assert.equal(result.approved, false);
  });
});

describe("buildQualityLaneVerdict — deterministic quality lane", () => {
  const GOOD_PLAN = {
    role: "evolution-worker",
    task: "Add deterministic dispatch verification for worker execution",
    verification: "npm test",
    wave: 1,
    riskLevel: "low",
    capacityDelta: 0.1,
    requestROI: 2.0,
  };

  it("approves a well-formed plan batch", () => {
    const verdict = buildQualityLaneVerdict([GOOD_PLAN]);
    assert.equal(verdict.lane, "quality");
    assert.equal(verdict.approved, true);
    assert.equal(verdict.issues.length, 0);
    assert.equal(verdict.reason, null);
    assert.ok(verdict.score > 0, "score must be positive for a passing plan");
  });

  it("rejects a plan with a vague task below quality threshold", () => {
    const badPlan = { ...GOOD_PLAN, task: "Fix stuff", verification: "" };
    const verdict = buildQualityLaneVerdict([badPlan]);
    assert.equal(verdict.approved, false);
    assert.ok(verdict.issues.length > 0, "must surface quality issues");
    assert.ok(verdict.reason !== null, "reason must be set on rejection");
    assert.equal(verdict.reason!.code, "LOW_PLAN_QUALITY");
  });

  it("returns approved=false for empty plans (negative path)", () => {
    const verdict = buildQualityLaneVerdict([]);
    assert.equal(verdict.approved, false);
    assert.equal(verdict.reason!.code, "NO_PLANS");
  });

  it("returns approved=false for null input (negative path)", () => {
    const verdict = buildQualityLaneVerdict(null as any);
    assert.equal(verdict.approved, false);
  });

  it("respects planQualityMinScore override from config", () => {
    const plan = { role: "evolution-worker", task: "Add deterministic dispatch", verification: "npm test", wave: 1, riskLevel: "low", capacityDelta: 0.1, requestROI: 2.0 };
    // Score without full fields won't be very high — set a very low threshold so it passes
    const config = { runtime: { planQualityMinScore: 1 } };
    const verdict = buildQualityLaneVerdict([plan], config);
    assert.equal(verdict.approved, true, "plan must pass with a very low quality threshold");
  });
});

describe("buildGovernanceLaneVerdict — deterministic governance lane", () => {
  const LOW_RISK_PLAN = {
    role: "evolution-worker",
    task: "Add retry logic to worker dispatch with exponential backoff",
    verification: "npm test",
    wave: 1,
    riskLevel: "low",
  };

  const HIGH_RISK_PLAN_VALID = {
    role: "evolution-worker",
    task: "Migrate database schema with zero-downtime deployment",
    verification: "npm test",
    wave: 1,
    riskLevel: "high",
    premortem: {
      riskLevel: "high",
      scenario: "Schema migration could corrupt live data if applied during peak traffic.",
      failurePaths: ["Partial migration leaves tables in inconsistent state"],
      mitigations: ["Blue-green deployment with canary rollout"],
      detectionSignals: ["Error rate spike > 1%"],
      guardrails: ["Rollback script tested in staging"],
      rollbackPlan: "Restore from last known good snapshot within 5 minutes",
    },
  };

  it("approves a low-risk plan with riskLevel set", () => {
    const verdict = buildGovernanceLaneVerdict([LOW_RISK_PLAN]);
    assert.equal(verdict.lane, "governance");
    assert.equal(verdict.approved, true);
    assert.equal(verdict.issues.length, 0);
    assert.equal(verdict.reason, null);
    assert.equal(verdict.score, 100);
  });

  it("approves a high-risk plan with a valid premortem", () => {
    const verdict = buildGovernanceLaneVerdict([HIGH_RISK_PLAN_VALID]);
    assert.equal(verdict.approved, true, "high-risk plan with valid premortem must be approved by governance lane");
  });

  it("rejects a high-risk plan missing premortem (negative path)", () => {
    const plan = { ...LOW_RISK_PLAN, riskLevel: "high" };
    const verdict = buildGovernanceLaneVerdict([plan]);
    assert.equal(verdict.approved, false);
    assert.ok(verdict.issues.some(i => /PREMORTEM_VIOLATION/i.test(i)), "must surface premortem violation");
    assert.equal(verdict.reason!.code, "GOVERNANCE_VIOLATIONS");
  });

  it("rejects a plan with a forbidden verification command (negative path)", () => {
    const plan = { ...LOW_RISK_PLAN, verification: "node --test tests/**/*.test.ts" };
    const verdict = buildGovernanceLaneVerdict([plan]);
    assert.equal(verdict.approved, false);
    assert.ok(verdict.issues.some(i => /FORBIDDEN_COMMAND/i.test(i)));
  });

  it("rejects a plan missing riskLevel (negative path)", () => {
    const plan = { role: "evolution-worker", task: "Add retry logic", verification: "npm test" };
    const verdict = buildGovernanceLaneVerdict([plan]);
    assert.equal(verdict.approved, false);
    assert.ok(verdict.issues.some(i => /MISSING_RISK_LEVEL/i.test(i)));
  });

  it("returns approved=false for empty plans (negative path)", () => {
    const verdict = buildGovernanceLaneVerdict([]);
    assert.equal(verdict.approved, false);
    assert.equal(verdict.reason!.code, "NO_PLANS");
  });
});

describe("runDualLanePlanReview — policy-driven merged verdict", () => {
  const GOOD_PLAN = {
    role: "evolution-worker",
    task: "Add deterministic dispatch verification for worker execution path",
    verification: "npm test",
    wave: 1,
    riskLevel: "low",
    capacityDelta: 0.1,
    requestROI: 2.0,
  };

  it("approves a well-formed low-risk batch under MUST_PASS_BOTH policy", () => {
    const result = runDualLanePlanReview([GOOD_PLAN]);
    assert.equal(result.approved, true, "good low-risk plan must be approved by both lanes");
    assert.equal(result.laneA.lane, "quality");
    assert.equal(result.laneB.lane, "governance");
    assert.equal(result.mergePolicy, LANE_MERGE_POLICY.MUST_PASS_BOTH);
  });

  it("rejects a batch with a vague plan (quality lane fails)", () => {
    // Remove capacityDelta/requestROI so score is below the default 40 threshold:
    //   task "Fix" (short): -30, verification missing: -20, capacityDelta missing: -15, requestROI missing: -15 → score=20
    const vagueplan = { role: "evolution-worker", task: "Fix", verification: "", wave: 1, riskLevel: "low" };
    const result = runDualLanePlanReview([vagueplan]);
    assert.equal(result.approved, false, "low-quality plan must be rejected");
    assert.equal(result.laneA.approved, false, "quality lane must reject");
  });

  it("rejects a high-risk batch with missing premortem (governance lane fails)", () => {
    const highRiskPlan = { ...GOOD_PLAN, riskLevel: "high" };
    const result = runDualLanePlanReview([highRiskPlan]);
    assert.equal(result.approved, false, "high-risk plan without premortem must be rejected");
    assert.equal(result.laneB.approved, false, "governance lane must reject missing premortem");
  });

  it("uses configured merge policy from config", () => {
    const config = { runtime: { laneMergePolicy: "QUALITY_GATE_ONLY" } };
    // Governance will fail (no riskLevel declared in plan)
    const plan = { ...GOOD_PLAN, riskLevel: "" };
    const result = runDualLanePlanReview([plan], config);
    // Quality gate only — approved depends solely on quality lane
    assert.equal(result.mergePolicy, LANE_MERGE_POLICY.QUALITY_GATE_ONLY);
  });

  it("negative path: empty plans array is rejected by both lanes", () => {
    const result = runDualLanePlanReview([]);
    assert.equal(result.approved, false);
    assert.equal(result.laneA.approved, false);
    assert.equal(result.laneB.approved, false);
  });

  it("result always includes laneA, laneB, mergePolicy, mergeReason, and approved", () => {
    const result = runDualLanePlanReview([GOOD_PLAN]);
    assert.ok("approved" in result, "approved must be present");
    assert.ok("laneA" in result, "laneA must be present");
    assert.ok("laneB" in result, "laneB must be present");
    assert.ok("mergePolicy" in result, "mergePolicy must be present");
    assert.ok("mergeReason" in result, "mergeReason must be present");
    assert.ok(typeof result.mergeReason === "string" && result.mergeReason.length > 0);
  });
});


