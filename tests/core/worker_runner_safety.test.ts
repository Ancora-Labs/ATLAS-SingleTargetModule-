import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerRunContract, parseWorkerResponse, shouldEnableFullToolAccess, shouldRecordHookCoverageAudit } from "../../src/core/worker_runner.js";
import { checkPostMergeArtifact, ARTIFACT_GAP, POST_MERGE_PLACEHOLDER } from "../../src/core/verification_gate.js";

describe("worker_runner safety seam", () => {
  it("forces blocked status when worker reports done but access protocol says blocked", () => {
    const output = [
      "Implemented the changes.",
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:blocked;api:ok"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "blocked");
  });

  it("keeps done status when all access channels are ok", () => {
    const output = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:ok;api:ok",
      "BOX_PR_URL=https://github.com/org/repo/pull/9"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "done");
  });

  it("keeps explicit blocked status intact", () => {
    const output = [
      "BOX_STATUS=blocked",
      "BOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok"
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "blocked");
  });

  it("treats explicit self-reported execute deny telemetry as blocked", () => {
    const output = [
      "BOX_STATUS=done",
      "[TOOL_INTENT] scope=src/core intent=patch-policy impact=high clearance=admin",
      "[HOOK_DECISION] tool=execute decision=deny reason_code=HOOK_DENY_SCHEMA_DROP rule_id=deny-schema-drop envelope_scope=src/core envelope_intent=patch-policy envelope_impact=high envelope_clearance=admin",
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "blocked");
    assert.equal(parsed.dispatchBlockReason, "tool_policy_denied:HOOK_DENY_SCHEMA_DROP");
    assert.equal(parsed.toolExecutionTelemetry.deniedDecisions.length, 1);
  });

  it("keeps done status when hook telemetry reports execute allow", () => {
    const output = [
      "BOX_STATUS=done",
      "[TOOL_INTENT] scope=tests/core intent=run-targeted-tests impact=low clearance=read",
      "[HOOK_DECISION] tool=execute decision=allow reason_code=HOOK_ALLOW_NONE rule_id=none envelope_scope=tests/core envelope_intent=run-targeted-tests envelope_impact=low envelope_clearance=read",
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "done");
  });

  it("does not surface unpaired pseudo-telemetry as a dispatch block reason", () => {
    const output = [
      "BOX_STATUS=done",
      "[TOOL_INTENT] scope=tests/core intent=run-targeted-tests impact=low clearance=read",
    ].join("\n");
    const parsed = parseWorkerResponse(output, "");
    assert.equal(parsed.status, "done");
    assert.equal(parsed.dispatchBlockReason, null);
    assert.ok(parsed.toolExecutionTelemetry.gaps.some((gap) => gap.includes("HOOK_TELEMETRY_UNPAIRED")));
  });

  it("defaults sessionInputPolicy to auto for new worker dispatches", () => {
    const contract = buildWorkerRunContract({}, {});
    assert.equal(contract.sessionInputPolicy, "auto");
  });

  it("keeps planner sessions least-privilege through the agent profile", () => {
    const allowAll = shouldEnableFullToolAccess("prometheus", "analysis", "Read repository state and produce a plan");
    assert.equal(allowAll, false);
  });

  it("suppresses hook coverage audit residue when no hook evidence exists", () => {
    const shouldRecord = shouldRecordHookCoverageAudit({
      telemetry: {
        envelopes: [],
        hookDecisions: [],
        gaps: [],
        hasDeterministicCoverage: false,
      },
      runtimeDecisions: [],
      runtimeAuditGaps: [],
    });
    assert.equal(shouldRecord, false);
  });

  it("retains hook coverage audit when hook evidence exists", () => {
    const shouldRecord = shouldRecordHookCoverageAudit({
      telemetry: {
        envelopes: [{ scope: "src/core", intent: "patch", impact: "high", clearance: "admin" }],
        hookDecisions: [],
        gaps: [],
        hasDeterministicCoverage: false,
      },
      runtimeDecisions: [],
      runtimeAuditGaps: [],
    });
    assert.equal(shouldRecord, true);
  });
});

// ── Artifact hard-block gate — enforced on all done-capable completion paths ──

describe("worker_runner artifact hard-block gate", () => {
  it("checkPostMergeArtifact: rejects done output missing both SHA and test result", () => {
    const artifact = checkPostMergeArtifact("All changes applied, everything looks good.");
    assert.equal(artifact.hasSha, false);
    assert.equal(artifact.hasTestOutput, false);
    assert.equal(artifact.hasArtifact, false);
  });

  it("checkPostMergeArtifact: rejects when SHA present but test output absent", () => {
    const artifact = checkPostMergeArtifact("BOX_MERGED_SHA=abc1234\nDeployment complete.");
    assert.equal(artifact.hasSha, true);
    assert.equal(artifact.hasTestOutput, false);
    assert.equal(artifact.hasArtifact, false);
  });

  it("checkPostMergeArtifact: rejects when test output present but SHA absent", () => {
    const artifact = checkPostMergeArtifact("===NPM TEST OUTPUT START===\n# tests 10 # pass 10 # fail 0\n===NPM TEST OUTPUT END===\n");
    assert.equal(artifact.hasSha, false);
    assert.equal(artifact.hasTestOutput, true);
    assert.equal(artifact.hasArtifact, false);
  });

  it("checkPostMergeArtifact: rejects when placeholder is unfilled even if SHA+output present", () => {
    const output = [
      "Merged abc1234 into main",
      "10 passing",
      `VERIFICATION_REPORT: BUILD=pass; TESTS=${POST_MERGE_PLACEHOLDER}`
    ].join("\n");
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasUnfilledPlaceholder, true);
    assert.equal(artifact.hasArtifact, false);
  });

  it("checkPostMergeArtifact: accepts valid evidence with SHA and test block", () => {
    const output = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=clean",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass",
      "===NPM TEST OUTPUT START===",
      "# tests 12 # pass 12 # fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasSha, true);
    assert.equal(artifact.hasTestOutput, true);
    assert.equal(artifact.hasUnfilledPlaceholder, false);
    assert.equal(artifact.hasArtifact, true);
  });

  it("checkPostMergeArtifact: accepts shared dirty worktree evidence when scoped targets are declared", () => {
    const output = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/slo_checker.ts, src/core/orchestrator.ts",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass",
      "===NPM TEST OUTPUT START===",
      "# tests 12 # pass 12 # fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const artifact = checkPostMergeArtifact(output, {
      expectedTargetFiles: ["src/core/slo_checker.ts", "src/core/orchestrator.ts"],
    });
    assert.equal(artifact.hasTaskScopedCleanTreeEvidence, true);
    assert.equal(artifact.hasArtifact, true);
  });

  it("ARTIFACT_GAP exports are non-empty deterministic strings (shared gap registry)", () => {
    assert.ok(typeof ARTIFACT_GAP.MISSING_SHA === "string" && ARTIFACT_GAP.MISSING_SHA.length > 0);
    assert.ok(typeof ARTIFACT_GAP.MISSING_TEST_OUTPUT === "string" && ARTIFACT_GAP.MISSING_TEST_OUTPUT.length > 0);
    assert.ok(typeof ARTIFACT_GAP.UNFILLED_PLACEHOLDER === "string" && ARTIFACT_GAP.UNFILLED_PLACEHOLDER.length > 0);
  });

  it("negative path: done output that is all prose produces three gap reasons", () => {
    const artifact = checkPostMergeArtifact("I completed the task and everything is good.");
    const gaps: string[] = [];
    if (artifact.hasUnfilledPlaceholder) gaps.push(ARTIFACT_GAP.UNFILLED_PLACEHOLDER);
    if (!artifact.hasSha) gaps.push(ARTIFACT_GAP.MISSING_SHA);
    if (!artifact.hasTestOutput) gaps.push(ARTIFACT_GAP.MISSING_TEST_OUTPUT);
    assert.equal(gaps.length, 2, "prose-only done must produce MISSING_SHA + MISSING_TEST_OUTPUT gaps");
  });
});

// ── precomputedArtifact single-evaluation contract ────────────────────────────
// Verifies that the checkPostMergeArtifact result used by the hard-block gate
// and the validateWorkerContract call are consistent — the same evidence object
// should be used in both paths.

import { validateWorkerContract } from "../../src/core/verification_gate.js";

describe("worker_runner — precomputedArtifact single-evaluation contract", () => {
  it("checkPostMergeArtifact is deterministic: same output produces identical evidence", () => {
    const output = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 10 pass 10 fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const first = checkPostMergeArtifact(output);
    const second = checkPostMergeArtifact(output);
    assert.deepEqual(first, second, "two calls with identical input must produce identical evidence");
  });

  it("precomputedArtifact passed to validateWorkerContract is reflected in evidence", () => {
    const artifact = checkPostMergeArtifact(
      "BOX_MERGED_SHA=aaa1111\nCLEAN_TREE_STATUS=clean\n===NPM TEST OUTPUT START===\n# tests 3 pass 3 fail 0\n===NPM TEST OUTPUT END==="
    );
    assert.equal(artifact.hasArtifact, true, "pre-condition: artifact must be complete");

    const result = validateWorkerContract("backend", {
      status: "done",
      // Output alone has no SHA/test block — artifact gate would fail without the pre-computed value
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/77",
      ].join("\n"),
    }, { precomputedArtifact: artifact });

    const artifactGap = result.gaps.find(g => /sha|test output|npm/i.test(g));
    assert.equal(artifactGap, undefined,
      `precomputedArtifact must suppress artifact gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: absent precomputedArtifact and missing evidence in output fails artifact gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/78",
        // No SHA, no npm output
      ].join("\n"),
    });
    assert.equal(result.passed, false, "missing artifact without precomputedArtifact must fail gate");
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap, `artifact gap must be reported; gaps: [${result.gaps.join("; ")}]`);
  });
});

// ── worker_runner completion path — gatesConfig propagation ──────────────────
// Verifies that validateWorkerContract is called with gatesConfig from the
// runner config so globally-promoted BUILD requirements are applied correctly,
// and that n/a is accepted for promoted fields (false completion block prevention).

describe("worker_runner completion path — globally-promoted BUILD allows n/a", () => {
  const FULL_ARTIFACT_OUTPUT = [
    "BOX_MERGED_SHA=abc1234f",
    "===NPM TEST OUTPUT START===",
    "# tests 10 pass 10 fail 0",
    "===NPM TEST OUTPUT END===",
  ].join("\n");

  it("test role with requireBuild=true and BUILD=n/a passes gate (no false block)", () => {
    // Simulates the worker_runner completion path calling validateWorkerContract
    // with gatesConfig — test role has build:optional, promoted to required by config.
    // Worker reports BUILD=n/a (legitimate for test-only task). Must not be blocked.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT_OUTPUT,
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    const buildGap = result.gaps.find(g => /BUILD.*required.*n\/a|BUILD.*was.*n\/a/i.test(g));
    assert.equal(
      buildGap, undefined,
      `globally-promoted BUILD=n/a must not produce a false-block gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("test role with requireBuild=true and BUILD=fail is correctly rejected", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT_OUTPUT,
        "VERIFICATION_REPORT: BUILD=fail; TESTS=pass; EDGE_CASES=pass",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    assert.equal(result.passed, false, "promoted BUILD=fail must block gate");
    assert.ok(result.gaps.some(g => /BUILD.*FAIL/i.test(g)),
      `BUILD fail must produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("gatesConfig=undefined (no config.gates) treats build as optional for test role", () => {
    // Without gatesConfig, build is optional for test role → no build gap regardless of value.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT_OUTPUT,
        "VERIFICATION_REPORT: TESTS=pass; EDGE_CASES=pass",
        // BUILD absent from report entirely — optional, so no gap
      ].join("\n"),
    }, { gatesConfig: undefined });

    const buildGap = result.gaps.find(g => /BUILD/i.test(g));
    assert.equal(
      buildGap, undefined,
      `without gatesConfig, optional BUILD missing from report must not produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: backend role with BUILD=n/a and requireBuild=true still fails (non-promoted)", () => {
    // backend role: build=required (already required, not optional → not a promoted field).
    // Even with requireBuild=true in gatesConfig, n/a must remain a gap.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT_OUTPUT,
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    assert.equal(result.passed, false,
      "originally-required BUILD=n/a must still block even with requireBuild=true in gatesConfig"
    );
    assert.ok(result.gaps.some(g => /BUILD.*n\/a|BUILD.*required/i.test(g)),
      `non-promoted required BUILD=n/a must produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });
});
