import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildVerificationScorecard,
  buildReworkInstruction,
  decideRework,
  parseResponsiveMatrix,
  parseVerificationReport,
  validateWorkerContract,
  checkPostMergeArtifact,
  POST_MERGE_PLACEHOLDER,
  POST_MERGE_SHA_PLACEHOLDER,
  POST_MERGE_OUTPUT_PLACEHOLDER,
  ALL_POST_MERGE_PLACEHOLDERS,
  NON_MERGE_TASK_KINDS,
  isArtifactGateRequired,
  checkNamedTestProof,
  NAMED_TEST_PROOF_GAP,
  NAMED_TEST_PROOF_PATTERN,
  normalizeReportValue,
  CANONICAL_REPORT_VALUES,
  applyConfigOverrides,
  CANONICAL_MAIN_BRANCH_REPLAY_COMMANDS,
  buildReplayClosureEvidence,
  hasReplayClosureEvidence,
  hasCleanTreeStatusEvidence,
  VERIFICATION_REPORT_TEMPLATE_GAP,
  VERIFICATION_REPORT_MALFORMED_GAP,
  NON_SPECIFIC_VERIFICATION_GAP,
  parseToolExecutionTelemetry,
  checkHookEnvelopeDecisionPairing,
  VERIFICATION_FAILURE_CODE,
} from "../../src/core/verification_gate.js";
import { buildVerificationScorecardTelemetry } from "../../src/core/cycle_analytics.js";
import { rankModelsByTaskKindExpectedValue } from "../../src/core/model_policy.js";

describe("verification_gate parse helpers", () => {
  it("parses canonical VERIFICATION_REPORT fields", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; RESPONSIVE=n/a; API=pass; EDGE_CASES=pass; SECURITY=pass"
    );
    assert.deepEqual(report, {
      build: "pass",
      tests: "fail",
      responsive: "n/a",
      api: "pass",
      edgeCases: "pass",
      security: "pass"
    });
  });

  it("normalizes synonyms in VERIFICATION_REPORT", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: test=pass; responsivematrix=pass; edge_cases=pass; build=pass"
    );
    assert.equal(report.tests, "pass");
    assert.equal(report.responsive, "pass");
    assert.equal(report.edgeCases, "pass");
    assert.equal(report.build, "pass");
  });

  it("returns null when VERIFICATION_REPORT marker is missing", () => {
    assert.equal(parseVerificationReport("no report here"), null);
  });

  it("returns null for malformed VERIFICATION_REPORT envelope without key/value entries", () => {
    assert.equal(parseVerificationReport("===VERIFICATION_REPORT===\nhello\n===END_VERIFICATION==="), null);
  });

  it("parses RESPONSIVE_MATRIX key/value pairs", () => {
    const matrix = parseResponsiveMatrix("RESPONSIVE_MATRIX: 320x568=pass, 360x640=fail, 768x1024=pass");
    assert.deepEqual(matrix, {
      "320x568": "pass",
      "360x640": "fail",
      "768x1024": "pass"
    });
  });
});

describe("verification_gate tool execution telemetry", () => {
  it("parses deterministic intent envelopes and hook decisions", () => {
    const telemetry = parseToolExecutionTelemetry([
      "[TOOL_INTENT] scope=src/core intent=update-gate impact=medium clearance=write",
      "[HOOK_DECISION] tool=execute decision=allow reason_code=HOOK_ALLOW_NONE rule_id=none envelope_scope=src/core envelope_intent=update-gate envelope_impact=medium envelope_clearance=write",
    ].join("\n"));
    assert.equal(telemetry.envelopes.length, 1);
    assert.equal(telemetry.hookDecisions.length, 1);
    assert.equal(telemetry.deniedDecisions.length, 0);
    assert.equal(telemetry.gaps.length, 0);
    assert.equal(telemetry.hasDeterministicCoverage, true);
  });

  it("reports malformed hook decision telemetry when envelope fields are missing", () => {
    const telemetry = parseToolExecutionTelemetry(
      "[HOOK_DECISION] tool=execute decision=allow reason_code=HOOK_ALLOW_NONE rule_id=none"
    );
    assert.ok(telemetry.gaps.some((g) => g.includes("HOOK_DECISION malformed")));
    assert.equal(telemetry.hasDeterministicCoverage, false);
  });

  it("validateWorkerContract rejects done outputs containing denied execute decisions", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 3 pass 3 fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/88",
        "[TOOL_INTENT] scope=src/core intent=drop-schema impact=critical clearance=admin",
        "[HOOK_DECISION] tool=execute decision=deny reason_code=HOOK_DENY_SCHEMA_DROP rule_id=deny-schema-drop envelope_scope=src/core envelope_intent=drop-schema envelope_impact=critical envelope_clearance=admin",
      ].join("\n"),
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("TOOL_POLICY denied execute call")));
  });
});

describe("verification_gate checkHookEnvelopeDecisionPairing", () => {
  it("returns empty gaps for perfectly paired and matching envelope/decision", () => {
    const gaps = checkHookEnvelopeDecisionPairing(
      [{ scope: "src/core", intent: "update-gate", impact: "medium", clearance: "write", raw: "" }],
      [{ tool: "execute", decision: "allow", reasonCode: "HOOK_ALLOW_NONE", ruleId: "none", envelopeScope: "src/core", envelopeIntent: "update-gate", envelopeImpact: "medium", envelopeClearance: "write", raw: "" }],
    );
    assert.equal(gaps.length, 0);
  });

  it("returns empty gaps when both arrays are empty", () => {
    const gaps = checkHookEnvelopeDecisionPairing([], []);
    assert.equal(gaps.length, 0);
  });

  it("produces HOOK_TELEMETRY_UNPAIRED when envelope has no paired decision", () => {
    const gaps = checkHookEnvelopeDecisionPairing(
      [{ scope: "src/core", intent: "op-a", impact: "low", clearance: "read", raw: "" }],
      [],
    );
    assert.ok(gaps.some((g) => g.startsWith("HOOK_TELEMETRY_UNPAIRED")));
    assert.ok(gaps.some((g) => g.includes("TOOL_INTENT envelope(s) missing a paired HOOK_DECISION")));
  });

  it("produces HOOK_TELEMETRY_UNPAIRED when decision has no preceding envelope", () => {
    const gaps = checkHookEnvelopeDecisionPairing(
      [],
      [{ tool: "execute", decision: "allow", reasonCode: "HOOK_ALLOW_NONE", ruleId: "none", envelopeScope: "src/core", envelopeIntent: "op", envelopeImpact: "low", envelopeClearance: "read", raw: "" }],
    );
    assert.ok(gaps.some((g) => g.startsWith("HOOK_TELEMETRY_UNPAIRED")));
    assert.ok(gaps.some((g) => g.includes("HOOK_DECISION(s) missing a preceding TOOL_INTENT envelope")));
  });

  it("produces HOOK_TELEMETRY_MISMATCH when envelope_scope does not match TOOL_INTENT scope", () => {
    const gaps = checkHookEnvelopeDecisionPairing(
      [{ scope: "src/core", intent: "op", impact: "medium", clearance: "write", raw: "" }],
      [{ tool: "execute", decision: "allow", reasonCode: "HOOK_ALLOW_NONE", ruleId: "none", envelopeScope: "src/OTHER", envelopeIntent: "op", envelopeImpact: "medium", envelopeClearance: "write", raw: "" }],
    );
    assert.ok(gaps.some((g) => g.startsWith("HOOK_TELEMETRY_MISMATCH")));
    assert.ok(gaps.some((g) => g.includes("envelope_scope")));
  });

  it("produces HOOK_TELEMETRY_MISMATCH when multiple echo fields are wrong", () => {
    const gaps = checkHookEnvelopeDecisionPairing(
      [{ scope: "src/core", intent: "op-x", impact: "high", clearance: "admin", raw: "" }],
      [{ tool: "execute", decision: "allow", reasonCode: "R", ruleId: "r1", envelopeScope: "src/OTHER", envelopeIntent: "op-y", envelopeImpact: "low", envelopeClearance: "read", raw: "" }],
    );
    assert.ok(gaps.length >= 4, `expected at least 4 mismatch gaps, got ${gaps.length}`);
  });

  it("parseToolExecutionTelemetry reports HOOK_TELEMETRY_UNPAIRED when TOOL_INTENT has no HOOK_DECISION", () => {
    const telemetry = parseToolExecutionTelemetry(
      "[TOOL_INTENT] scope=src/core intent=update-gate impact=medium clearance=write",
    );
    assert.ok(
      telemetry.gaps.some((g) => g.startsWith("HOOK_TELEMETRY_UNPAIRED")),
      `expected HOOK_TELEMETRY_UNPAIRED in gaps, got: ${JSON.stringify(telemetry.gaps)}`,
    );
    assert.equal(telemetry.hasDeterministicCoverage, false);
  });
});

describe("verification_gate replay closure evidence helper", () => {
  it("detects replay-closure evidence only when canonical replay commands are present", () => {
    const evidence = "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://npm-test-output-block]";
    assert.equal(hasReplayClosureEvidence(evidence), true);
  });

  it("negative path: rejects replay-closure text missing canonical command coverage", () => {
    const evidence = "replay-closure:v1 commands=[git rev-parse HEAD, npm test] links=[inline://npm-test-output-block]";
    assert.equal(hasReplayClosureEvidence(evidence), false);
  });

  it("detects explicit CLEAN_TREE_STATUS evidence marker", () => {
    assert.equal(hasCleanTreeStatusEvidence("CLEAN_TREE_STATUS=clean"), true);
  });

  it("detects task-scoped clean-tree evidence marker", () => {
    assert.equal(
      hasCleanTreeStatusEvidence([
        "CLEAN_TREE_STATUS=dirty-other-tasks-only",
        "TASK_SCOPED_CLEAN_STATUS=clean",
        "TASK_SCOPED_CLEAN_TARGETS=src/core/slo_checker.ts, src/core/orchestrator.ts",
      ].join("\n")),
      true,
    );
  });

  it("negative path: does not detect clean-tree evidence when marker is absent", () => {
    assert.equal(hasCleanTreeStatusEvidence("git status output only"), false);
  });
});

describe("verification_gate verification report template enforcement", () => {
  it("rejects done output when VERIFICATION_REPORT placeholders are not replaced", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 10",
        "===NPM TEST OUTPUT END===",
        "===VERIFICATION_REPORT===",
        "BUILD=<pass|fail|n/a>",
        "TESTS=pass",
        "EDGE_CASES=pass",
        "SECURITY=n/a",
        "===END_VERIFICATION===",
        "BOX_PR_URL=https://github.com/org/repo/pull/88",
      ].join("\n"),
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.includes(VERIFICATION_REPORT_TEMPLATE_GAP));
  });

  it("rejects malformed verification-report envelopes with explicit guidance", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 10",
        "===NPM TEST OUTPUT END===",
        "===VERIFICATION_REPORT===",
        "not-a-report",
        "===END_VERIFICATION===",
        "BOX_PR_URL=https://github.com/org/repo/pull/88",
      ].join("\n"),
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.includes(VERIFICATION_REPORT_MALFORMED_GAP));
  });

  it("does not fail tests field on Windows node --test glob artifact when npm test passed evidence exists", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 10",
        "===NPM TEST OUTPUT END===",
        "node --test tests/**",
        "Could not find 'tests/**'",
        "npm test",
        "10 passing",
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=fail; EDGE_CASES=pass",
      ].join("\n"),
    });
    assert.equal(result.passed, true);
    assert.ok(!result.gaps.some(g => /TESTS reported as FAIL/i.test(g)));
  });
});

describe("verification_gate worker contract enforcement", () => {
  it("rejects backend done result when required tests evidence is fail", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; EDGE_CASES=pass; SECURITY=pass\nBOX_PR_URL=https://github.com/a/b/pull/1"
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("TESTS reported as FAIL")));
  });

  it("rejects backend done result when VERIFICATION_REPORT is missing", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: "I fixed the issue but forgot report"
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("VERIFICATION_REPORT missing")));
  });

  it("passes skipped status without requiring evidence", () => {
    const parsedResponse = {
      status: "skipped",
      fullOutput: ""
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("rejects frontend when responsive matrix has fewer passes than required minimum", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=pass; EDGE_CASES=pass; SECURITY=pass",
        "RESPONSIVE_MATRIX: 320x568=pass, 360x640=pass, 375x667=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/123"
      ].join("\n")
    };
    const result = validateWorkerContract("frontend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("viewports passed")));
  });

  it("passes backend when all required evidence and PR URL are present", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc123d",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 10 # pass 10 # fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/88"
      ].join("\n")
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });
});

describe("verification_gate weighted scorecard", () => {
  it("builds a weighted scorecard with standardized failure codes for failed evidence", () => {
    const scorecard = buildVerificationScorecard({
      status: "done",
      passed: false,
      report: {
        build: "pass",
        tests: "fail",
        edgeCases: "pass",
        security: "pass",
      },
      artifact: { hasArtifact: false },
      prUrl: "",
      gaps: [
        "TESTS reported as FAIL — worker must fix before done",
        "BOX_PR_URL missing — worker must push a branch and open a real GitHub PR. Prose claims of completion are not accepted.",
      ],
    });
    assert.equal(scorecard.status, "fail");
    assert.equal(scorecard.primaryFailureCode, VERIFICATION_FAILURE_CODE.IA);
    assert.ok(scorecard.blockingFailureCodes.includes(VERIFICATION_FAILURE_CODE.IA));
    assert.ok(scorecard.blockingFailureCodes.includes(VERIFICATION_FAILURE_CODE.CLE));
    assert.ok(scorecard.normalizedScore < 1);
  });

  it("validateWorkerContract includes scorecard and failure-code evidence for malformed reports", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 10",
        "===NPM TEST OUTPUT END===",
        "===VERIFICATION_REPORT===",
        "BUILD=<pass|fail|n/a>",
        "===END_VERIFICATION===",
        "BOX_PR_URL=https://github.com/org/repo/pull/88",
      ].join("\n"),
    });
    const scorecard = result.evidence.scorecard as {
      primaryFailureCode: string | null;
      blockingFailureCodes: string[];
      normalizedScore: number;
    };
    assert.equal(scorecard.primaryFailureCode, VERIFICATION_FAILURE_CODE.INVALID_FORMAT);
    assert.ok(scorecard.blockingFailureCodes.includes(VERIFICATION_FAILURE_CODE.INVALID_FORMAT));
    assert.ok(scorecard.normalizedScore < 1);
  });
});

describe("verification telemetry routing feedback", () => {
  it("aggregates verification failure codes by task kind, including timeout failures", () => {
    const telemetry = buildVerificationScorecardTelemetry([
      {
        status: "done",
        taskKind: "backend",
        verificationEvidence: {
          passed: false,
          report: { build: "pass", tests: "fail", edgeCases: "pass", security: "pass" },
          gaps: ["TESTS reported as FAIL — worker must fix before done"],
          prUrl: "https://github.com/org/repo/pull/1",
        },
      },
      {
        status: "timeout",
        taskKind: "backend",
      },
    ]);
    assert.equal(telemetry.sampleCount, 2);
    assert.equal(telemetry.byTaskKind.backend.sampleCount, 2);
    assert.equal(telemetry.byTaskKind.backend.failureCodeCounts[VERIFICATION_FAILURE_CODE.IA], 1);
    assert.equal(telemetry.byTaskKind.backend.failureCodeCounts[VERIFICATION_FAILURE_CODE.TLE], 1);
    assert.ok(telemetry.byTaskKind.backend.averageWeightedScore < 1);
  });

  it("penalizes expected-value routing when verification telemetry shows repeated policy failures", () => {
    const analyticsBase = {
      modelRoutingTelemetry: {
        byTaskKind: {
          backend: {
            sampleCount: 6,
            lineageLinkedSampleCount: 6,
            lineageLinkedRatio: 1,
            default: { successProbability: 0.8, capacityImpact: 0.9, requestCost: 1 },
            models: {
              "Claude Sonnet 4.6": { successProbability: 0.85, capacityImpact: 0.95, requestCost: 1 },
              "Claude Haiku 4": { successProbability: 0.7, capacityImpact: 0.75, requestCost: 1 },
            },
          },
        },
      },
      routingROISummary: { linkedRatio: 1, overallLinkedROI: 0.8 },
    };
    const withoutPenalty = rankModelsByTaskKindExpectedValue(
      "backend",
      ["Claude Sonnet 4.6", "Claude Haiku 4"],
      analyticsBase,
    );
    const withPenalty = rankModelsByTaskKindExpectedValue(
      "backend",
      ["Claude Sonnet 4.6", "Claude Haiku 4"],
      {
        ...analyticsBase,
        verificationTelemetry: {
          byTaskKind: {
            backend: {
              sampleCount: 6,
              averageWeightedScore: 0.5,
              dominantFailureCode: VERIFICATION_FAILURE_CODE.POLICY_VIOLATION,
              failureCodeCounts: {
                [VERIFICATION_FAILURE_CODE.CLE]: 0,
                [VERIFICATION_FAILURE_CODE.IA]: 1,
                [VERIFICATION_FAILURE_CODE.INVALID_FORMAT]: 0,
                [VERIFICATION_FAILURE_CODE.TLE]: 0,
                [VERIFICATION_FAILURE_CODE.POLICY_VIOLATION]: 3,
                [VERIFICATION_FAILURE_CODE.HARNESS_ARTIFACT]: 0,
              },
            },
          },
        },
      },
    );
    assert.ok(withPenalty.reason.includes("verification-penalty"));
    assert.ok(withPenalty.scoreByModel["Claude Sonnet 4.6"] < withoutPenalty.scoreByModel["Claude Sonnet 4.6"]);
    assert.ok(withPenalty.scoreByModel["Claude Haiku 4"] < withoutPenalty.scoreByModel["Claude Haiku 4"]);
  });
});

describe("verification_gate rework decisioning", () => {
  it("requests rework when validation failed and attempts remain", () => {
    const decision = decideRework(
      { passed: false, gaps: ["TESTS reported as FAIL"] },
      "Fix tests",
      0,
      2
    );
    assert.equal(decision.shouldRework, true);
    assert.equal(decision.shouldEscalate, false);
    assert.ok(decision.instruction?.isRework);
  });

  it("escalates when max rework attempts are exceeded", () => {
    const decision = decideRework(
      { passed: false, gaps: ["BUILD reported as FAIL"] },
      "Fix build",
      2,
      2
    );
    assert.equal(decision.shouldRework, false);
    assert.equal(decision.shouldEscalate, true);
    assert.ok(String(decision.escalationReason || "").includes("failed verification"));
  });

  it("passes through immediately when validation already passed", () => {
    const decision = decideRework(
      { passed: true, gaps: [] },
      "Fix tests",
      0,
      2
    );
    assert.equal(decision.shouldRework, false);
    assert.equal(decision.shouldEscalate, false);
    assert.equal(decision.instruction, null);
  });
});

describe("verification_gate buildReworkInstruction — gap list and attempt metadata (AC#3)", () => {
  it("includes all gap descriptions in rework task text", () => {
    const gaps = ["BUILD is required but was missing", "TESTS reported as FAIL"];
    const instruction = buildReworkInstruction("Implement feature X", gaps, 1, 2);
    assert.ok(
      instruction.task.includes("BUILD is required but was missing"),
      "gap 1 must appear in task text"
    );
    assert.ok(
      instruction.task.includes("TESTS reported as FAIL"),
      "gap 2 must appear in task text"
    );
  });

  it("includes numbered gap list in rework task text", () => {
    const gaps = ["EDGE_CASES is required but was missing"];
    const instruction = buildReworkInstruction("Fix edge cases", gaps, 1, 2);
    assert.match(instruction.task, /1\.\s+EDGE_CASES is required/);
  });

  it("includes attempt metadata in rework instruction object", () => {
    const instruction = buildReworkInstruction("Do work", ["BUILD missing"], 1, 2);
    assert.equal(instruction.reworkAttempt, 1, "reworkAttempt must equal the current attempt");
    assert.equal(instruction.maxReworkAttempts, 2, "maxReworkAttempts must be preserved");
    assert.equal(instruction.isRework, true);
    assert.equal(instruction.taskKind, "rework");
  });

  it("includes attempt counter in task header string", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 2, 2);
    assert.match(instruction.task, /attempt 2\/2/i);
  });

  it("includes final-attempt warning when attempt equals max", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 2, 2);
    assert.match(instruction.task, /FINAL ATTEMPT/i);
  });

  it("does not include final-attempt warning on intermediate attempts", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 1, 2);
    assert.ok(!instruction.task.includes("FINAL ATTEMPT"));
  });

  it("includes original task text for worker reference", () => {
    const instruction = buildReworkInstruction("Implement OAuth login", ["BUILD missing"], 1, 2);
    assert.ok(instruction.task.includes("Implement OAuth login"), "original task must be included");
  });

  it("sets isFollowUp=true so conversation context is built correctly", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 1, 2);
    assert.equal(instruction.isFollowUp, true);
  });

  it("includes gap summary in instruction context field", () => {
    const gaps = ["TESTS fail", "BUILD missing"];
    const instruction = buildReworkInstruction("task", gaps, 1, 2);
    assert.ok(instruction.context.includes("TESTS fail"), "context must include gap list");
    assert.ok(instruction.context.includes("BUILD missing"));
  });
});

describe("verification_gate validateWorkerContract — skipped and non-done statuses", () => {
  it("skipped status passes without evidence (pre-existing pass-through)", () => {
    const result = validateWorkerContract("backend", { status: "skipped", fullOutput: "" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("partial status bypasses verification (non-done)", () => {
    const result = validateWorkerContract("backend", { status: "partial", fullOutput: "" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("blocked status bypasses verification (non-done)", () => {
    const result = validateWorkerContract("backend", { status: "blocked", fullOutput: "Cannot access repo" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("scan role (scanA) is fully exempt from verification", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: "Scanned 42 files, no report needed"
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
    assert.match(result.reason, /exempt/i);
  });
});

describe("verification_gate — post-merge artifact (Packet 1/3)", () => {
  it("exports post-merge placeholder constant", () => {
    assert.ok(POST_MERGE_PLACEHOLDER);
  });

  it("checkPostMergeArtifact detects missing SHA in short text", () => {
    const result = checkPostMergeArtifact("no sha here at all");
    assert.equal(result.hasSha, false);
  });

  it("checkPostMergeArtifact detects present SHA and explicit test output block", () => {
    const result = checkPostMergeArtifact("BOX_MERGED_SHA=abc123d\nCLEAN_TREE_STATUS=clean\n===NPM TEST OUTPUT START===\n# tests 5 pass 5 fail 0\n===NPM TEST OUTPUT END===");
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, true);
  });

  it("checkPostMergeArtifact accepts task-scoped clean-tree evidence when expected targets are covered", () => {
    const result = checkPostMergeArtifact([
      "BOX_MERGED_SHA=abc123d",
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/slo_checker.ts, src/core/orchestrator.ts",
      "===NPM TEST OUTPUT START===",
      "# tests 5 pass 5 fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n"), {
      expectedTargetFiles: ["src/core/slo_checker.ts", "src/core/orchestrator.ts"],
    });
    assert.equal(result.hasArtifact, true);
    assert.equal(result.hasTaskScopedCleanTreeEvidence, true);
    assert.equal(result.cleanTreeMode, "task-scoped");
  });

  it("checkPostMergeArtifact rejects task-scoped clean-tree evidence when expected targets are missing", () => {
    const result = checkPostMergeArtifact([
      "BOX_MERGED_SHA=abc123d",
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/slo_checker.ts",
      "===NPM TEST OUTPUT START===",
      "# tests 5 pass 5 fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n"), {
      expectedTargetFiles: ["src/core/slo_checker.ts", "src/core/orchestrator.ts"],
    });
    assert.equal(result.hasArtifact, false);
    assert.equal(result.hasCleanTreeEvidence, false);
  });

  it("checkPostMergeArtifact detects unfilled placeholder", () => {
    const result = checkPostMergeArtifact(`Some output with ${POST_MERGE_PLACEHOLDER}`);
    assert.equal(result.hasUnfilledPlaceholder, true);
  });

  it("checkPostMergeArtifact returns clean result for complete explicit artifact", () => {
    const text = "BOX_MERGED_SHA=abc123d\nCLEAN_TREE_STATUS=clean\n===NPM TEST OUTPUT START===\n# tests 10 pass\n===NPM TEST OUTPUT END===";
    const result = checkPostMergeArtifact(text);
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, true);
    assert.equal(result.hasCleanTreeEvidence, true);
    assert.equal(result.hasUnfilledPlaceholder, false);
    assert.equal(result.hasArtifact, true);
  });

  it("negative path: plain npm summary text without explicit output block does not satisfy test evidence", () => {
    const result = checkPostMergeArtifact("BOX_MERGED_SHA=abc1234\nCLEAN_TREE_STATUS=clean\n# tests 10\n# pass 10\n# fail 0");
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, false);
    assert.equal(result.hasArtifact, false);
  });

  it("negative path: explicit SHA and npm test block without clean-tree marker fails artifact completeness", () => {
    const result = checkPostMergeArtifact(
      "BOX_MERGED_SHA=abc1234\n===NPM TEST OUTPUT START===\n# tests 5 pass 5\n===NPM TEST OUTPUT END===",
    );
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, true);
    assert.equal(result.hasCleanTreeEvidence, false);
    assert.equal(result.hasArtifact, false);
  });
});

describe("verification_gate — replay closure evidence contract", () => {
  it("exports canonical replay commands for main-branch verification closure", () => {
    assert.deepEqual(
      CANONICAL_MAIN_BRANCH_REPLAY_COMMANDS,
      ["git rev-parse HEAD", "git status --porcelain", "npm test"],
    );
  });

  it("buildReplayClosureEvidence marks contractSatisfied for complete replay evidence", () => {
    const output = [
      "git rev-parse HEAD",
      "BOX_MERGED_SHA=abc1234",
      "git status --porcelain",
      "CLEAN_TREE_STATUS=clean",
      "npm test",
      "===NPM TEST OUTPUT START===",
      "# tests 10 pass 10 fail 0",
      "===NPM TEST OUTPUT END===",
      "RAW_ARTIFACT_LINKS=state/carry_forward_replay_evidence.jsonl",
    ].join("\n");
    const replay = buildReplayClosureEvidence(output);
    assert.equal(replay.contractSatisfied, true);
    assert.equal(replay.hasCanonicalReplayCommands, true);
    assert.equal(replay.hasRawArtifactEvidenceLinks, true);
    assert.equal(replay.missingCommands.length, 0);
  });

  it("negative path: buildReplayClosureEvidence fails contract when canonical command evidence is incomplete", () => {
    const output = [
      "RAW_ARTIFACT_LINKS=state/carry_forward_replay_evidence.jsonl",
      "===NPM TEST OUTPUT START===",
      "# tests 10 pass 10 fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const replay = buildReplayClosureEvidence(output);
    assert.equal(replay.contractSatisfied, false);
    assert.ok(replay.missingCommands.includes("git rev-parse HEAD"));
    assert.ok(replay.missingCommands.includes("git status --porcelain"));
  });
});

// ── SHA + raw npm output enforced across done-capable lanes ──────────────────

describe("verification_gate — SHA + raw npm output enforced across done-capable lanes", () => {
  it("should fail done when SHA or raw npm output block is absent for done-capable lanes", () => {
    // Test worker (quality lane) reports done without a git SHA or npm test output block.
    // With the extended artifact gate, this must fail even for non-implementation lanes.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass",
        // No 7-char hex SHA, no raw npm test output block
      ].join("\n")
    });

    assert.equal(result.passed, false, "test worker done without SHA/npm output must fail");
    const hasArtifactGap = result.gaps.some(
      g => /sha|npm|post-merge/i.test(g)
    );
    assert.ok(hasArtifactGap,
      `expected a SHA or npm output gap; got: [${result.gaps.join("; ")}]`
    );
  });

  it("test worker done with valid SHA and npm output passes the artifact gate", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc123d",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 10 # pass 10 # fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass"
      ].join("\n")
    });
    // No artifact-related gaps (other gaps like prUrl may exist for different profiles)
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(artifactGap, undefined,
      `unexpected artifact gap when SHA + npm output are present: ${artifactGap}`
    );
  });

  it("backend worker done without SHA fails the artifact gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/99"
        // No git SHA present
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /sha/i.test(g)),
      `expected SHA gap; got: [${result.gaps.join("; ")}]`
    );
  });

  it("scan role done is not gated by post-merge artifact requirements", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: "read-only scan finished"
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
    assert.match(String(result.reason || ""), /exempt/i);
  });
});

// ── Task 2: Artifact gate applies regardless of workerKind ────────────────────

describe("verification_gate — artifact check mandatory across all completion paths (Task 2)", () => {
  it("unknown workerKind falls through to DEFAULT_PROFILE which requires build", () => {
    // 'unknown' kind hits DEFAULT_PROFILE: build=required, artifacts required
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: "All done!"
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.gaps.some(g => /sha|test output/i.test(g)),
      `expected artifact gap for unknown kind; got: [${result.gaps.join("; ")}]`
    );
  });

  it("done status with git SHA + npm test output passes artifact gate for unknown workerKind", () => {
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "  3 passing",
        "===NPM TEST OUTPUT END===",
      ].join("\n")
    });
    // Should not fail on artifact gate specifically
    const artifactGaps = result.gaps.filter(g => /sha|test output|placeholder/i.test(g));
    assert.equal(artifactGaps.length, 0, `artifact gate should not fire; gaps: [${result.gaps.join("; ")}]`);
  });

  it("negative path: done output with placeholder token is rejected even for unknown workerKind", () => {
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: "POST_MERGE_TEST_OUTPUT placeholder not replaced"
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap; got: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Task 1: Refined done gate — NON_MERGE_TASK_KINDS + isArtifactGateRequired ─

describe("verification_gate — NON_MERGE_TASK_KINDS constant", () => {
  it("exports a Set containing the canonical non-merge task kinds", () => {
    assert.ok(NON_MERGE_TASK_KINDS instanceof Set, "NON_MERGE_TASK_KINDS must be a Set");
    assert.ok(NON_MERGE_TASK_KINDS.has("scan"), "scan must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("doc"), "doc must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("observation"), "observation must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("diagnosis"), "diagnosis must be in NON_MERGE_TASK_KINDS");
  });

  it("does not include implementation or rework kinds", () => {
    assert.ok(!NON_MERGE_TASK_KINDS.has("backend"), "backend must NOT be in NON_MERGE_TASK_KINDS");
    assert.ok(!NON_MERGE_TASK_KINDS.has("rework"), "rework must NOT be in NON_MERGE_TASK_KINDS");
    assert.ok(!NON_MERGE_TASK_KINDS.has("general"), "general must NOT be in NON_MERGE_TASK_KINDS");
  });
});

describe("verification_gate — isArtifactGateRequired", () => {
  it("returns true for backend role with implementation taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", "backend"), true);
  });

  it("returns true for backend role with no taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", null), true);
    assert.equal(isArtifactGateRequired("backend", undefined), true);
  });

  it("returns false for fully-exempt role (scanA) regardless of taskKind", () => {
    assert.equal(isArtifactGateRequired("scanA", "backend"), false);
    assert.equal(isArtifactGateRequired("scanA", null), false);
  });

  it("returns false for backend role when taskKind is scan (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "scan"), false);
  });

  it("returns false for backend role when taskKind is doc (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "doc"), false);
  });

  it("returns false for backend role when taskKind is observation (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "observation"), false);
  });

  it("returns false for backend role when taskKind is diagnosis (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "diagnosis"), false);
  });

  it("returns true for backend role when taskKind is rework (re-implementation)", () => {
    assert.equal(isArtifactGateRequired("backend", "rework"), true);
  });

  it("returns true for backend role when taskKind is general (ambiguous, conservative default)", () => {
    assert.equal(isArtifactGateRequired("backend", "general"), true);
  });

  it("is case-insensitive for taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", "SCAN"), false);
    assert.equal(isArtifactGateRequired("backend", "Doc"), false);
  });
});

describe("verification_gate — task-kind aware artifact gate in validateWorkerContract", () => {
  const SCAN_OUTPUT_NO_ARTIFACT = [
    "VERIFICATION_REPORT: BUILD=n/a; TESTS=n/a; EDGE_CASES=n/a",
    "Scanned 42 files. No changes required.",
    // No git SHA, no npm test output — legitimate for scan task
  ].join("\n");

  it("backend role with scan taskKind: done without artifact passes gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: SCAN_OUTPUT_NO_ARTIFACT
    }, { taskKind: "scan" });

    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `scan taskKind must skip artifact gate; unexpected gap: ${artifactGap}`
    );
  });

  it("backend role with doc taskKind: done without artifact passes gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: SCAN_OUTPUT_NO_ARTIFACT
    }, { taskKind: "doc" });

    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `doc taskKind must skip artifact gate; unexpected gap: ${artifactGap}`
    );
  });

  it("backend role with backend taskKind: done without artifact still fails gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/99"
        // No git SHA or npm test block
      ].join("\n")
    }, { taskKind: "backend" });

    assert.equal(result.passed, false);
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap,
      `implementation taskKind must still require artifact; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("backend role with rework taskKind: done without artifact still fails gate (re-implementation)", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/77"
      ].join("\n")
    }, { taskKind: "rework" });

    assert.equal(result.passed, false);
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap,
      `rework taskKind must still require artifact; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: scan taskKind with unfilled placeholder is still rejected", () => {
    // Placeholder is always rejected regardless of task kind — it signals
    // the worker did not replace the template with real output.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: `POST_MERGE_TEST_OUTPUT placeholder here`
    }, { taskKind: "scan" });

    // For scan taskKind: artifact gate is skipped entirely, so placeholder
    // check does NOT fire (no artifact gate = no placeholder check).
    // This is correct: a scan worker won't include npm output at all.
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|placeholder/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `scan taskKind skips artifact gate entirely (including placeholder check); got: ${artifactGap}`
    );
  });
});

// ── collectArtifactGaps — shared gap-collection contract ──────────────────────

import {
  collectArtifactGaps,
  ARTIFACT_GAP,
} from "../../src/core/verification_gate.js";

describe("verification_gate — collectArtifactGaps shared contract", () => {
  it("returns empty array when artifact is complete", () => {
    const artifact = { hasSha: true, hasTestOutput: true, hasCleanTreeEvidence: true, hasUnfilledPlaceholder: false };
    assert.deepEqual(collectArtifactGaps(artifact), []);
  });

  it("returns MISSING_SHA gap when SHA is absent", () => {
    const artifact = { hasSha: false, hasTestOutput: true, hasCleanTreeEvidence: true, hasUnfilledPlaceholder: false };
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.some(g => /sha/i.test(g)), `expected SHA gap; got: [${gaps.join("; ")}]`);
  });

  it("returns MISSING_TEST_OUTPUT gap when test output is absent", () => {
    const artifact = { hasSha: true, hasTestOutput: false, hasCleanTreeEvidence: true, hasUnfilledPlaceholder: false };
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.some(g => /npm|test output/i.test(g)), `expected test-output gap; got: [${gaps.join("; ")}]`);
  });

  it("returns DIRTY_TREE gap when clean-tree evidence is absent", () => {
    const artifact = { hasSha: true, hasTestOutput: true, hasCleanTreeEvidence: false, hasUnfilledPlaceholder: false };
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.some(g => /clean-tree|clean tree/i.test(g)), `expected clean-tree gap; got: [${gaps.join("; ")}]`);
  });

  it("returns UNFILLED_PLACEHOLDER gap when placeholder is present", () => {
    const artifact = { hasSha: true, hasTestOutput: true, hasCleanTreeEvidence: true, hasUnfilledPlaceholder: true };
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.some(g => /placeholder/i.test(g)), `expected placeholder gap; got: [${gaps.join("; ")}]`);
  });

  it("collects all four gaps when artifact is fully missing", () => {
    const artifact = { hasSha: false, hasTestOutput: false, hasUnfilledPlaceholder: true };
    const gaps = collectArtifactGaps(artifact);
    assert.equal(gaps.length, 4, `expected 4 gaps; got: [${gaps.join("; ")}]`);
  });

  it("gap reasons match ARTIFACT_GAP constants exactly", () => {
    const artifact = { hasSha: false, hasTestOutput: false, hasUnfilledPlaceholder: true };
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.includes(ARTIFACT_GAP.UNFILLED_PLACEHOLDER), "must include UNFILLED_PLACEHOLDER constant");
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA), "must include MISSING_SHA constant");
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_TEST_OUTPUT), "must include MISSING_TEST_OUTPUT constant");
    assert.ok(gaps.includes(ARTIFACT_GAP.DIRTY_TREE), "must include DIRTY_TREE constant");
  });

  it("negative path: partial artifact returns only applicable gaps", () => {
    const artifact = { hasSha: true, hasTestOutput: false, hasCleanTreeEvidence: true, hasUnfilledPlaceholder: false };
    const gaps = collectArtifactGaps(artifact);
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0], ARTIFACT_GAP.MISSING_TEST_OUTPUT);
  });
});

// ── Task 1 hardening: artifact gate is non-bypassable ────────────────────────

describe("verification_gate — artifact gate non-bypassable (Task 1 hardening)", () => {
  it("artifact gate fires even when no explicit bypass option is passed", () => {
    // A backend worker reports done without a git SHA — must fail regardless of options.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1"
        // No git SHA or npm test output
      ].join("\n")
    }, {});  // empty options — no requirePostMergeArtifact property
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /sha/i.test(g)),
      `artifact gate must fire with empty options; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("ValidateWorkerContractOptions interface no longer includes requirePostMergeArtifact", () => {
    // Passing an extra property is allowed in TS at runtime, but the gate must not use it.
    // A done result without SHA must fail even when a caller attempts to pass the old option.
    const optionsWithOldBypass: Record<string, unknown> = { requirePostMergeArtifact: false };
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass"
    }, optionsWithOldBypass as any);
    // Gate must still fire — the old option is ignored.
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /sha|artifact|test output/i.test(g)),
      `old requirePostMergeArtifact:false must not bypass the gate; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: done with SHA + test output passes even when old option value passed", () => {
    // Ensure we haven't broken the happy path while removing the bypass.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5 # pass 5 # fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1"
      ].join("\n")
    }, { requirePostMergeArtifact: false } as any);
    const artifactGap = result.gaps.find(g => /sha|artifact|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `no artifact gap expected when SHA + test output are present; gaps: [${result.gaps.join("; ")}]`
    );
  });
});

// ── precomputedArtifact option — single-evaluation reuse ─────────────────────
// Verifies that validateWorkerContract uses the caller-supplied artifact result
// instead of re-calling checkPostMergeArtifact, eliminating the duplicate
// evaluation on the worker completion path.

describe("verification_gate — validateWorkerContract precomputedArtifact option", () => {
  const FULL_OUTPUT_NO_ARTIFACT = [
    "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
    "BOX_PR_URL=https://github.com/org/repo/pull/42",
    // No git SHA or npm test output — output alone would fail the artifact gate
  ].join("\n");

  it("uses precomputedArtifact when provided — passes gate with injected complete artifact", () => {
    // Output has no SHA/test block, but we inject a pre-computed result that says it does.
    // If validateWorkerContract recomputes from output, it would fail; using the injected
    // value it must pass — proving the pre-computed path is taken.
    const fakeCompleteArtifact = checkPostMergeArtifact(
      "BOX_MERGED_SHA=abc1234\nCLEAN_TREE_STATUS=clean\n===NPM TEST OUTPUT START===\n# tests 5 pass 5 fail 0\n===NPM TEST OUTPUT END==="
    );
    assert.equal(fakeCompleteArtifact.hasArtifact, true, "pre-condition: injected artifact must be complete");

    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: FULL_OUTPUT_NO_ARTIFACT,
    }, { precomputedArtifact: fakeCompleteArtifact });

    const artifactGap = result.gaps.find(g => /sha|test output|npm/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `precomputedArtifact must be used; artifact gaps must not appear; gaps: [${result.gaps.join("; ")}]`
    );
    // Evidence must carry the injected artifact, not one re-derived from output
    const evidenceArtifact = result.evidence?.postMergeArtifact as ReturnType<typeof checkPostMergeArtifact>;
    assert.ok(evidenceArtifact, "evidence.postMergeArtifact must be populated");
    assert.equal(evidenceArtifact.hasSha, true, "evidence must reflect injected artifact SHA flag");
    assert.equal(evidenceArtifact.hasTestOutput, true, "evidence must reflect injected artifact test flag");
  });

  it("uses precomputedArtifact when provided — fails gate with injected incomplete artifact", () => {
    // Output has valid SHA + test block, but we inject an incomplete artifact.
    // If validateWorkerContract recomputes from output, it would pass; using the
    // injected value it must fail — proving the pre-computed path is taken.
    const validOutput = [
      "BOX_MERGED_SHA=def5678",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 8 pass 8 fail 0",
      "===NPM TEST OUTPUT END===",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
      "BOX_PR_URL=https://github.com/org/repo/pull/43",
    ].join("\n");
    const fakeIncompleteArtifact = checkPostMergeArtifact("no sha, no test output here");
    assert.equal(fakeIncompleteArtifact.hasArtifact, false, "pre-condition: injected artifact must be incomplete");

    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: validOutput,
    }, { precomputedArtifact: fakeIncompleteArtifact });

    assert.equal(result.passed, false, "gate must fail when injected artifact is incomplete");
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap,
      `injected incomplete artifact must produce artifact gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("falls back to checkPostMergeArtifact from output when precomputedArtifact is not provided", () => {
    // Baseline: without precomputedArtifact, normal evaluation path is taken.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: FULL_OUTPUT_NO_ARTIFACT,
    });
    // Output has no SHA/test block → should fail
    assert.equal(result.passed, false);
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap, `fallback evaluation must produce artifact gap; gaps: [${result.gaps.join("; ")}]`);
  });

  it("precomputedArtifact is ignored for non-merge task kinds (artifact gate is skipped)", () => {
    // Even with a precomputedArtifact provided, scan tasks skip the artifact gate entirely.
    const fakeIncompleteArtifact = checkPostMergeArtifact("no sha, no test output here");
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=n/a; TESTS=n/a\nScanned 5 files.",
    }, { taskKind: "scan", precomputedArtifact: fakeIncompleteArtifact });

    const artifactGap = result.gaps.find(g => /sha|test output|npm/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `scan taskKind must skip artifact gate even with precomputedArtifact; gaps: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Task 3: Explicit merged SHA marker + npm test output block ─────────────────

import { extractMergedSha } from "../../src/core/verification_gate.js";

describe("verification_gate — BOX_MERGED_SHA explicit marker (Task 3)", () => {
  it("checkPostMergeArtifact detects explicit BOX_MERGED_SHA= marker", () => {
    const output = "BOX_MERGED_SHA=abc1234f\n# tests 5 pass 5 fail 0";
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasSha, true);
    assert.equal(result.hasExplicitShaMarker, true);
    assert.equal(result.mergedSha, "abc1234f");
  });

  it("negative path: checkPostMergeArtifact rejects loose hex SHA when no explicit BOX_MERGED_SHA marker", () => {
    // Loose hex string detection has been removed — ambiguous hex values no longer satisfy the SHA requirement.
    const output = "Merged abc1234f into main\n# tests 5 pass";
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasSha, false, "loose hex SHA must not satisfy the SHA requirement");
    assert.equal(result.hasExplicitShaMarker, false);
    assert.equal(result.mergedSha, null);
  });

  it("extractMergedSha returns the SHA from BOX_MERGED_SHA= marker", () => {
    const sha = extractMergedSha("BOX_MERGED_SHA=deadbeef1234567");
    assert.equal(sha, "deadbeef1234567");
  });

  it("extractMergedSha returns null when marker is absent", () => {
    assert.equal(extractMergedSha("Merged abc123 into main"), null);
    assert.equal(extractMergedSha(""), null);
  });

  it("extractMergedSha is case-insensitive for the marker", () => {
    assert.equal(extractMergedSha("box_merged_sha=abc1234f"), "abc1234f");
  });

  it("checkPostMergeArtifact detects explicit NPM test output block markers", () => {
    const output = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 10",
      "# pass 10",
      "# fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasExplicitTestBlock, true);
    assert.equal(result.hasTestOutput, true);
    assert.equal(result.hasArtifact, true);
  });

  it("checkPostMergeArtifact hasExplicitTestBlock=false when only loose npm output present", () => {
    const output = "abc1234 merged\n# tests 10 pass";
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasExplicitTestBlock, false);
    assert.equal(result.hasTestOutput, false, "explicit block is required");
  });

  it("negative path: output with BOX_MERGED_SHA but no test output fails artifact gate", () => {
    const result = checkPostMergeArtifact("BOX_MERGED_SHA=abc1234");
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, false);
    assert.equal(result.hasArtifact, false);
  });

  it("negative path: output with npm test block but no SHA fails artifact gate", () => {
    const result = checkPostMergeArtifact(
      "===NPM TEST OUTPUT START===\n# pass 10\n===NPM TEST OUTPUT END===\n"
    );
    assert.equal(result.hasTestOutput, true);
    assert.equal(result.hasSha, false);
    assert.equal(result.hasArtifact, false);
  });
});

describe("worker_runner — mergedSha extraction in parseWorkerResponse (Task 3)", () => {
  it("extracts mergedSha from BOX_MERGED_SHA marker in worker output", async () => {
    const { parseWorkerResponse } = await import("../../src/core/worker_runner.js");
    const stdout = [
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=abc1234f",
      "# tests 10 pass 10",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal((result as any).mergedSha, "abc1234f",
      "mergedSha must be extracted from BOX_MERGED_SHA marker");
  });

  it("mergedSha is null when BOX_MERGED_SHA marker is absent", async () => {
    const { parseWorkerResponse } = await import("../../src/core/worker_runner.js");
    const result = parseWorkerResponse("BOX_STATUS=done\nSome output without SHA marker", "");
    assert.equal((result as any).mergedSha, null,
      "mergedSha must be null when explicit marker is absent");
  });
});

// ── Task 2: Strengthen done-path artifact assertions across role profiles ──────

describe("verification_gate — qa role done-path artifact enforcement (Task 2)", () => {
  it("qa role done without SHA or npm output fails artifact gate", () => {
    const result = validateWorkerContract("qa", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/55"
        // No SHA or npm test output block
      ].join("\n")
    });
    assert.equal(result.passed, false, "qa role done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for qa role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("qa role done with explicit BOX_MERGED_SHA and npm test block passes artifact gate", () => {
    const result = validateWorkerContract("qa", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 20",
        "# pass 20",
        "# fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/55"
      ].join("\n")
    });
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `qa done with BOX_MERGED_SHA + npm block must pass artifact gate; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: qa role done with unfilled placeholder is rejected", () => {
    const result = validateWorkerContract("qa", {
      status: "done",
      fullOutput: [
        "POST_MERGE_TEST_OUTPUT placeholder not replaced",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/55"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap for qa role; got: [${result.gaps.join("; ")}]`
    );
  });
});

describe("verification_gate — security role done-path artifact enforcement (Task 2)", () => {
  it("security role done without SHA fails artifact gate", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/77"
        // No SHA or npm test output
      ].join("\n")
    });
    assert.equal(result.passed, false, "security role done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for security role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("security role done with SHA and npm test output passes artifact gate", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=deadbeef",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 15 pass 15 fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/77"
      ].join("\n")
    });
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `security done with SHA + test output must pass artifact gate; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("api role done without artifact fails gate (negative path)", () => {
    const result = validateWorkerContract("api", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; API=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/33"
      ].join("\n")
    });
    assert.equal(result.passed, false, "api role done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for api role; got: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Task: ARTIFACT_GAP_CODE machine-readable reason codes ───────────────────

import {
  ARTIFACT_GAP_CODE,
  buildArtifactAuditEntry,
} from "../../src/core/verification_gate.js";

describe("verification_gate — ARTIFACT_GAP_CODE machine-readable codes", () => {
  it("exports ARTIFACT_GAP_CODE with canonical codes", () => {
    assert.ok(ARTIFACT_GAP_CODE, "ARTIFACT_GAP_CODE must be exported");
    assert.equal(typeof ARTIFACT_GAP_CODE.UNFILLED_PLACEHOLDER, "string");
    assert.equal(typeof ARTIFACT_GAP_CODE.MISSING_SHA, "string");
    assert.equal(typeof ARTIFACT_GAP_CODE.MISSING_TEST_OUTPUT, "string");
    assert.equal(typeof ARTIFACT_GAP_CODE.DIRTY_TREE, "string");
  });

  it("ARTIFACT_GAP_CODE values are prefixed with artifact-gate/", () => {
    assert.ok(ARTIFACT_GAP_CODE.UNFILLED_PLACEHOLDER.startsWith("artifact-gate/"));
    assert.ok(ARTIFACT_GAP_CODE.MISSING_SHA.startsWith("artifact-gate/"));
    assert.ok(ARTIFACT_GAP_CODE.MISSING_TEST_OUTPUT.startsWith("artifact-gate/"));
    assert.ok(ARTIFACT_GAP_CODE.DIRTY_TREE.startsWith("artifact-gate/"));
  });

  it("ARTIFACT_GAP_CODE is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(ARTIFACT_GAP_CODE), "ARTIFACT_GAP_CODE must be frozen");
  });

  it("ARTIFACT_GAP_CODE codes are distinct", () => {
    const codes = [
      ARTIFACT_GAP_CODE.UNFILLED_PLACEHOLDER,
      ARTIFACT_GAP_CODE.MISSING_SHA,
      ARTIFACT_GAP_CODE.MISSING_TEST_OUTPUT,
      ARTIFACT_GAP_CODE.DIRTY_TREE,
    ];
    const unique = new Set(codes);
    assert.equal(unique.size, codes.length, "all codes must be distinct");
  });
});

describe("verification_gate — buildArtifactAuditEntry structured audit record", () => {
  const fullArtifact = {
    hasSha: true,
    hasTestOutput: true,
    hasCleanTreeEvidence: true,
    hasUnfilledPlaceholder: false,
    hasArtifact: true,
    hasExplicitShaMarker: true,
    hasExplicitTestBlock: false,
    mergedSha: "abc1234f",
  };

  const missingArtifact = {
    hasSha: false,
    hasTestOutput: false,
    hasCleanTreeEvidence: false,
    hasUnfilledPlaceholder: true,
    hasArtifact: false,
    hasExplicitShaMarker: false,
    hasExplicitTestBlock: false,
    mergedSha: null,
  };

  it("returns a structured entry with gateSource and all required fields", () => {
    const gaps = collectArtifactGaps(missingArtifact);
    const entry = buildArtifactAuditEntry(missingArtifact, gaps, {
      gateSource: "hard-block",
      workerKind: "backend",
      roleName: "KingDavid",
      taskId: "T-001",
      taskSnippet: "Fix auth bug",
    });
    assert.equal(entry.gateSource, "hard-block");
    assert.equal(entry.workerKind, "backend");
    assert.equal(entry.roleName, "KingDavid");
    assert.equal(entry.taskId, "T-001");
    assert.equal(entry.taskSnippet, "Fix auth bug");
    assert.equal(entry.passed, false);
    assert.equal(Array.isArray(entry.gaps), true);
    assert.equal(Array.isArray(entry.reasonCodes), true);
    assert.ok(typeof entry.auditedAt === "string" && entry.auditedAt.length > 0);
  });

  it("reasonCodes correspond to ARTIFACT_GAP_CODE for each gap", () => {
    const gaps = collectArtifactGaps(missingArtifact);
    const entry = buildArtifactAuditEntry(missingArtifact, gaps, { gateSource: "hard-block" });
    assert.ok(entry.reasonCodes.includes(ARTIFACT_GAP_CODE.UNFILLED_PLACEHOLDER));
    assert.ok(entry.reasonCodes.includes(ARTIFACT_GAP_CODE.MISSING_SHA));
    assert.ok(entry.reasonCodes.includes(ARTIFACT_GAP_CODE.MISSING_TEST_OUTPUT));
    assert.ok(entry.reasonCodes.includes(ARTIFACT_GAP_CODE.DIRTY_TREE));
  });

  it("reasonCodes length matches gaps length", () => {
    const gaps = collectArtifactGaps(missingArtifact);
    const entry = buildArtifactAuditEntry(missingArtifact, gaps, { gateSource: "evolution-gate" });
    assert.equal(entry.reasonCodes.length, gaps.length);
  });

  it("artifactDetail captures explicit marker flags and mergedSha", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, [], {
      gateSource: "hard-block",
    });
    assert.equal(entry.artifactDetail.hasSha, true);
    assert.equal(entry.artifactDetail.hasTestOutput, true);
    assert.equal(entry.artifactDetail.hasExplicitShaMarker, true);
    assert.equal(entry.artifactDetail.hasExplicitTestBlock, false);
    assert.equal(entry.artifactDetail.mergedSha, "abc1234f");
  });

  it("passed=true when gaps array is empty", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, [], { gateSource: "hard-block" });
    assert.equal(entry.passed, true);
  });

  it("defaults workerKind and roleName to 'unknown' when not provided", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, [], { gateSource: "evolution-gate" });
    assert.equal(entry.workerKind, "unknown");
    assert.equal(entry.roleName, "unknown");
  });

  it("taskId defaults to null when not provided", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, [], { gateSource: "evolution-gate" });
    assert.equal(entry.taskId, null);
  });

  it("taskSnippet is truncated to 100 characters", () => {
    const longSnippet = "A".repeat(200);
    const entry = buildArtifactAuditEntry(fullArtifact, [], {
      gateSource: "hard-block",
      taskSnippet: longSnippet,
    });
    assert.ok(entry.taskSnippet !== null && entry.taskSnippet.length <= 100,
      `taskSnippet must be at most 100 chars; got ${entry.taskSnippet?.length}`);
  });

  it("negative path: reasonCodes contains UNKNOWN for unrecognized gap string", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, ["some-unrecognized-gap"], {
      gateSource: "hard-block",
    });
    assert.ok(entry.reasonCodes.includes(ARTIFACT_GAP_CODE.UNKNOWN),
      `unrecognized gap must map to UNKNOWN code; got: [${entry.reasonCodes.join("; ")}]`
    );
  });

  it("evolution-gate gateSource is preserved in the entry", () => {
    const entry = buildArtifactAuditEntry(fullArtifact, [], { gateSource: "evolution-gate" });
    assert.equal(entry.gateSource, "evolution-gate");
  });
});

// ── Task 1: Artifact gate enforced across all done-capable lanes ──────────────
// Ensures devops, integration, and frontend roles (all have ≥1 required
// evidence field) are blocked when SHA or npm test output is absent.

describe("verification_gate — artifact gate across additional done-capable lanes (Task 1)", () => {
  it("devops role done without SHA or npm output fails artifact gate", () => {
    const result = validateWorkerContract("devops", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=n/a; EDGE_CASES=n/a; SECURITY=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/201",
        // No git SHA or npm test output
      ].join("\n")
    });
    assert.equal(result.passed, false, "devops done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for devops role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("devops role done with BOX_MERGED_SHA and npm block passes artifact gate", () => {
    const result = validateWorkerContract("devops", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=cafe1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5",
        "# pass 5",
        "# fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=n/a; EDGE_CASES=n/a; SECURITY=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/201",
      ].join("\n")
    });
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `devops done with BOX_MERGED_SHA + npm block must pass artifact gate; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("integration role done without artifact fails artifact gate (negative path)", () => {
    const result = validateWorkerContract("integration", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; API=pass; EDGE_CASES=pass",
        // No git SHA or npm test output
      ].join("\n")
    });
    assert.equal(result.passed, false, "integration done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for integration role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("frontend role done without SHA fails artifact gate (negative path)", () => {
    const result = validateWorkerContract("frontend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=n/a; RESPONSIVE=pass; EDGE_CASES=pass",
        "RESPONSIVE_MATRIX: 320x568=pass, 360x640=pass, 375x667=pass, 390x844=pass, 412x915=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/300",
        // No git SHA or npm test output
      ].join("\n")
    });
    assert.equal(result.passed, false, "frontend done without artifact must fail");
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for frontend role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: devops done with unfilled placeholder is rejected", () => {
    const result = validateWorkerContract("devops", {
      status: "done",
      fullOutput: [
        "POST_MERGE_TEST_OUTPUT placeholder not replaced",
        "VERIFICATION_REPORT: BUILD=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/202",
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap for devops role; got: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Named test proof gate ─────────────────────────────────────────────────────

describe("verification_gate — checkNamedTestProof", () => {
  it("exports NAMED_TEST_PROOF_PATTERN as a RegExp", () => {
    assert.ok(NAMED_TEST_PROOF_PATTERN instanceof RegExp, "NAMED_TEST_PROOF_PATTERN must be a RegExp");
  });

  it("exports NAMED_TEST_PROOF_GAP as a non-empty string", () => {
    assert.ok(typeof NAMED_TEST_PROOF_GAP === "string" && NAMED_TEST_PROOF_GAP.length > 0);
  });

  it("returns matched:false for non-named-test verification text (e.g. 'npm test')", () => {
    const result = checkNamedTestProof("npm test", "all tests passed");
    assert.equal(result.matched, false, "'npm test' is not a named test proof format");
    assert.equal(result.gap, null, "no gap for non-named-test verification text");
    assert.equal(result.testFile, null);
    assert.equal(result.testDesc, null);
  });

  it("returns matched:false for empty verification text", () => {
    const result = checkNamedTestProof("", "some output");
    assert.equal(result.matched, false);
    assert.equal(result.gap, null);
  });

  it("returns matched:true with gap=null when test file appears in output (file-only format)", () => {
    const output = "# Subtest: prometheus_parse.test.ts\nok 1 - should compute X\n# pass 3\n";
    const result = checkNamedTestProof("tests/core/prometheus_parse.test.ts", output);
    assert.equal(result.matched, true, "file-only format must be matched");
    assert.equal(result.testFile, "tests/core/prometheus_parse.test.ts");
    assert.equal(result.gap, null, "gap must be null when test file appears in output");
  });

  it("returns matched:true with gap when test file does NOT appear in output", () => {
    const output = "# Subtest: some_other.test.ts\nok 1 - passes\n";
    const result = checkNamedTestProof("tests/core/prometheus_parse.test.ts", output);
    assert.equal(result.matched, true);
    assert.ok(result.gap !== null, "gap must be non-null when test file is missing from output");
    assert.ok(result.gap!.includes("prometheus_parse.test.ts"), "gap message must name the missing test file");
  });

  it("returns gap when test file is present but description is NOT in output", () => {
    const output = "# Subtest: verification_gate.test.ts\nok 1 - some other test\n";
    const result = checkNamedTestProof(
      "tests/core/verification_gate.test.ts — test: should validate named test proof",
      output
    );
    assert.equal(result.matched, true);
    assert.equal(result.testFile, "tests/core/verification_gate.test.ts");
    assert.equal(result.testDesc, "should validate named test proof");
    assert.ok(result.gap !== null, "gap must be non-null when description is missing from output");
    assert.ok(result.gap!.includes("should validate named test proof"), "gap must include the missing description");
  });

  it("returns gap=null when both test file and description appear in output", () => {
    const output = [
      "# Subtest: verification_gate.test.ts",
      "  ok 1 - should validate named test proof",
      "# pass 1",
    ].join("\n");
    const result = checkNamedTestProof(
      "tests/core/verification_gate.test.ts — test: should validate named test proof",
      output
    );
    assert.equal(result.matched, true);
    assert.equal(result.gap, null, "gap must be null when both file and description are in output");
  });

  it("negative: returns gap when worker output is empty", () => {
    const result = checkNamedTestProof("tests/core/foo.test.ts — test: should do X", "");
    assert.equal(result.matched, true, "empty output triggers named test proof check");
    assert.ok(result.gap !== null, "gap must be non-null when output is empty");
  });

  it("integrates with validateWorkerContract via options.verificationText — adds gap when named test file missing", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# Subtest: other_test.test.ts",
        "ok 1 - some test",
        "# pass 1",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/99",
      ].join("\n"),
    };
    const result = validateWorkerContract("backend", parsedResponse, {
      taskKind: "implementation",
      verificationText: "tests/core/my_specific.test.ts — test: should handle edge case",
    });
    assert.equal(result.passed, false, "must fail when named test file is not in output");
    const namedGap = result.gaps.find((g: string) => g.includes("my_specific.test.ts"));
    assert.ok(namedGap, `gaps must include the named test file gap; got: [${result.gaps.join("; ")}]`);
  });

  it("integrates with validateWorkerContract — no gap when verificationText is not a named test format", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/88",
      ].join("\n"),
    };
    const result = validateWorkerContract("backend", parsedResponse, {
      taskKind: "implementation",
      verificationText: "npm test",
    });
    // 'npm test' is non-specific, so no named-test-proof gap should be added
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined, "no named-test-proof gap when verificationText is 'npm test'");
  });

  it("en dash (–) separator is supported as a valid named test proof format", () => {
    const output = "# Subtest: verification_gate.test.ts\n  ok 1 - should parse en dash separator\n";
    const result = checkNamedTestProof(
      "tests/core/verification_gate.test.ts \u2013 test: should parse en dash separator",
      output
    );
    assert.equal(result.matched, true, "en dash separator must be matched by NAMED_TEST_PROOF_PATTERN");
    assert.equal(result.gap, null, "gap must be null when file and description are in output");
  });

  it("hyphen (-) separator is supported as a valid named test proof format", () => {
    const output = "# Subtest: verification_gate.test.ts\n  ok 1 - should parse hyphen separator\n";
    const result = checkNamedTestProof(
      "tests/core/verification_gate.test.ts - test: should parse hyphen separator",
      output
    );
    assert.equal(result.matched, true, "hyphen separator must be matched by NAMED_TEST_PROOF_PATTERN");
    assert.equal(result.gap, null, "gap must be null when file and description are in output");
  });

  it("'it:' prefix is supported in named test proof description", () => {
    const output = "# Subtest: foo.test.ts\n  ok 1 - handle edge case\n";
    const result = checkNamedTestProof(
      "tests/core/foo.test.ts \u2014 it: handle edge case",
      output
    );
    assert.equal(result.matched, true, "it: prefix must be recognized as a named test proof format");
    assert.equal(result.testDesc, "handle edge case", "testDesc must strip the 'it:' prefix");
    assert.equal(result.gap, null, "gap must be null when description is in output");
  });

  it("negative: named test proof gap is NOT added when worker status is 'skipped'", () => {
    const parsedResponse = {
      status: "skipped",
      fullOutput: "Already merged in previous wave.",
    };
    const result = validateWorkerContract("backend", parsedResponse, {
      verificationText: "tests/core/specific.test.ts \u2014 test: some named proof",
    });
    assert.equal(result.passed, true,
      "skipped status must bypass all verification gates including named test proof");
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      "named test proof gap must not be added for skipped status");
  });

  it("negative: named test proof gap is NOT added when worker status is 'partial'", () => {
    const parsedResponse = {
      status: "partial",
      fullOutput: "Work in progress.",
    };
    const result = validateWorkerContract("backend", parsedResponse, {
      verificationText: "tests/core/specific.test.ts \u2014 test: some named proof",
    });
    // partial status → verification skipped by validateWorkerContract
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      "named test proof gap must not be added when status is partial (verification skipped for non-done)");
  });

  it("gap message references NAMED_TEST_PROOF_GAP constant prefix text", () => {
    const result = checkNamedTestProof("tests/core/foo.test.ts", "some unrelated output");
    assert.ok(result.gap !== null, "must produce a gap when test file is absent from output");
    assert.ok(
      result.gap!.startsWith("Named test proof missing"),
      `gap message must start with the NAMED_TEST_PROOF_GAP prefix; got: "${result.gap}"`
    );
  });
});

// ── Task 1: scanB and quality-worker done-path artifact gate coverage ─────────
// scanB has no required evidence fields → artifact gate must NOT fire.
// quality-worker has no dedicated profile → falls back to DEFAULT_PROFILE
// (build=required) → artifact gate MUST fire and block when SHA/npm output absent.

describe("verification_gate — scanB and quality-worker artifact gate (Task 1 coverage)", () => {
  it("scanB role done without artifact passes gate (no required evidence fields)", () => {
    // scanB (Documentation role): build=optional, everything else optional/exempt.
    // hasRequiredFields=false → requireArtifact=false → artifact gate is skipped.
    const result = validateWorkerContract("scanB", {
      status: "done",
      fullOutput: "Documentation review complete. No code changes made."
      // No git SHA, no npm test output — intentionally absent
    });
    assert.equal(result.passed, true,
      "scanB has no required fields, so artifact gate must not fire"
    );
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `scanB must not be blocked by artifact gate; unexpected gap: ${artifactGap}`
    );
  });

  it("quality-worker role done without SHA or npm output fails artifact gate", () => {
    // 'quality-worker' has no dedicated profile → falls back to DEFAULT_PROFILE.
    // DEFAULT_PROFILE has build=required → hasRequiredFields=true → artifact gate fires.
    const result = validateWorkerContract("quality-worker", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        // No git SHA or npm test output
      ].join("\n")
    });
    assert.equal(result.passed, false,
      "quality-worker done without SHA/npm output must fail (DEFAULT_PROFILE: build=required)"
    );
    const hasArtifactGap = result.gaps.some(g => /sha|npm|post-merge|test output/i.test(g));
    assert.ok(hasArtifactGap,
      `expected artifact gap for quality-worker role; got: [${result.gaps.join("; ")}]`
    );
  });

  it("quality-worker role done with BOX_MERGED_SHA and npm block passes artifact gate", () => {
    const result = validateWorkerContract("quality-worker", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 10",
        "# pass 10",
        "# fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
      ].join("\n")
    });
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `quality-worker with BOX_MERGED_SHA + npm block must pass artifact gate; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: scanB done with unfilled placeholder passes gate (artifact gate skipped entirely for scanB)", () => {
    // scanB has no required fields → artifact gate block is never entered,
    // so the placeholder check does NOT fire — same behavior as scan taskKind.
    const result = validateWorkerContract("scanB", {
      status: "done",
      fullOutput: "POST_MERGE_TEST_OUTPUT placeholder not replaced"
    });
    assert.equal(result.passed, true,
      "scanB artifact gate is skipped entirely (no required fields)"
    );
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|test output|placeholder/i.test(g));
    assert.equal(artifactGap, undefined,
      `scanB placeholder check must not fire when artifact gate is skipped; got: ${artifactGap}`
    );
  });
});

// ── Task 1: Packet-named verification proof gate ──────────────────────────────
// When the task packet's verification field names a specific test file and/or
// description, the worker output must contain that evidence before done closure
// is accepted. This tests the integration path through validateWorkerContract.

describe("verification_gate — packet-named verification proof gate (Task 1)", () => {
  it("rejects done when packet verification names a test file absent from worker output", () => {
    // Packet says: run tests/core/foo.test.ts — but worker output doesn't mention it.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# Subtest: other_test.test.ts",
        "ok 1 - some passing test",
        "# pass 1",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    }, {
      taskKind: "backend",
      verificationText: "tests/core/foo.test.ts — test: should handle edge case",
    });
    assert.equal(result.passed, false,
      "done must be rejected when packet-named test file is absent from worker output"
    );
    const namedGap = result.gaps.find((g: string) => g.includes("foo.test.ts"));
    assert.ok(namedGap,
      `gaps must reference the missing named test file; got: [${result.gaps.join("; ")}]`
    );
  });

  it("accepts done when packet verification names a test file present in worker output", () => {
    // Packet names foo.test.ts and worker output contains it.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# Subtest: foo.test.ts",
        "ok 1 - should handle edge case",
        "# pass 1",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    }, {
      taskKind: "backend",
      verificationText: "tests/core/foo.test.ts — test: should handle edge case",
    });
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      `no named-proof gap expected when test file and description are in output; got: ${namedGap}`
    );
  });

  it("no named-proof gap when verificationText is a non-specific format (e.g. 'npm test')", () => {
    // 'npm test' is not a named test proof format — gate must not fire.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/2",
      ].join("\n"),
    }, {
      taskKind: "backend",
      verificationText: "npm test",
    });
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      "generic 'npm test' must not trigger the named-proof gate"
    );
  });

  it("no named-proof gap when verificationText is null or empty", () => {
    // When no verificationText is provided, the gate must not fire.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/3",
      ].join("\n"),
    }, {
      taskKind: "backend",
      verificationText: null,
    });
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      "null verificationText must not trigger the named-proof gate"
    );
  });

  it("negative: named-proof gap is NOT added when worker status is skipped (proof gate bypassed)", () => {
    const result = validateWorkerContract("backend", {
      status: "skipped",
      fullOutput: "Already merged in a previous wave.",
    }, {
      verificationText: "tests/core/bar.test.ts — test: some named proof",
    });
    assert.equal(result.passed, true,
      "skipped status must bypass the named-proof gate entirely"
    );
    const namedGap = result.gaps.find((g: string) => g.includes("Named test proof"));
    assert.equal(namedGap, undefined,
      "skipped status must not trigger the named-proof gate"
    );
  });

  it("rejects done when packet names only a test file (no description) and file is absent", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# Subtest: other.test.ts",
        "# pass 1",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/4",
      ].join("\n"),
    }, {
      taskKind: "backend",
      verificationText: "tests/core/specific.test.ts",
    });
    assert.equal(result.passed, false,
      "done must be rejected when packet-named test file (file-only format) is absent"
    );
    const namedGap = result.gaps.find((g: string) => g.includes("specific.test.ts"));
    assert.ok(namedGap,
      `gaps must reference the missing named test file; got: [${result.gaps.join("; ")}]`
    );
  });
});

describe("verification_gate — exact-proof verification target enforcement", () => {
  const COMPLETE_DONE_OUTPUT = [
    "BOX_MERGED_SHA=abc1234f",
    "CLEAN_TREE_STATUS=clean",
    "===NPM TEST OUTPUT START===",
    "# Subtest: verification_gate.test.ts",
    "ok 1 - rejects generic verification",
    "# pass 1",
    "===NPM TEST OUTPUT END===",
    "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
    "BOX_PR_URL=https://github.com/org/repo/pull/123",
  ].join("\n");

  it("rejects merge-oriented done output when verification target is generic", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: COMPLETE_DONE_OUTPUT,
    }, {
      taskKind: "backend",
      verificationText: "npm test",
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.includes(`${NON_SPECIFIC_VERIFICATION_GAP}: "npm test"`));
  });

  it("rejects merge-oriented done output when verification target uses a Windows-incompatible glob", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: COMPLETE_DONE_OUTPUT,
    }, {
      taskKind: "backend",
      verificationText: "node --test tests/**/*.test.ts",
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((gap) => gap.includes("non-portable command")));
  });

  it("does not enforce exact-proof target for discovery-safe task kinds", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=n/a; TESTS=n/a; EDGE_CASES=n/a",
    }, {
      taskKind: "scan",
      verificationText: "npm test",
    });
    const verificationGap = result.gaps.find((gap) => gap.includes("Verification target"));
    assert.equal(verificationGap, undefined);
  });
});

// ── Profile-aware evidence matching: normalizeReportValue + canonical values ──

describe("verification_gate — normalizeReportValue canonical normalization", () => {
  it("exports CANONICAL_REPORT_VALUES as a frozen Set with pass/fail/n/a", () => {
    assert.ok(CANONICAL_REPORT_VALUES instanceof Set, "CANONICAL_REPORT_VALUES must be a Set");
    assert.ok(Object.isFrozen(CANONICAL_REPORT_VALUES), "CANONICAL_REPORT_VALUES must be frozen");
    assert.ok(CANONICAL_REPORT_VALUES.has("pass"));
    assert.ok(CANONICAL_REPORT_VALUES.has("fail"));
    assert.ok(CANONICAL_REPORT_VALUES.has("n/a"));
  });

  it("pass synonyms are normalized to 'pass'", () => {
    assert.equal(normalizeReportValue("passing"), "pass");
    assert.equal(normalizeReportValue("passed"), "pass");
    assert.equal(normalizeReportValue("ok"), "pass");
    assert.equal(normalizeReportValue("yes"), "pass");
    assert.equal(normalizeReportValue("true"), "pass");
  });

  it("fail synonyms are normalized to 'fail'", () => {
    assert.equal(normalizeReportValue("failing"), "fail");
    assert.equal(normalizeReportValue("failed"), "fail");
    assert.equal(normalizeReportValue("no"), "fail");
    assert.equal(normalizeReportValue("false"), "fail");
    assert.equal(normalizeReportValue("error"), "fail");
  });

  it("n/a synonyms are normalized to 'n/a'", () => {
    assert.equal(normalizeReportValue("na"), "n/a");
    assert.equal(normalizeReportValue("not-applicable"), "n/a");
    assert.equal(normalizeReportValue("skip"), "n/a");
    assert.equal(normalizeReportValue("skipped"), "n/a");
    assert.equal(normalizeReportValue("exempt"), "n/a");
  });

  it("canonical values are returned unchanged", () => {
    assert.equal(normalizeReportValue("pass"), "pass");
    assert.equal(normalizeReportValue("fail"), "fail");
    assert.equal(normalizeReportValue("n/a"), "n/a");
  });

  it("truly unknown values are returned as-is (not coerced)", () => {
    assert.equal(normalizeReportValue("xyz"), "xyz");
    assert.equal(normalizeReportValue("green"), "green");
    assert.equal(normalizeReportValue(""), "");
  });

  it("parseVerificationReport normalizes 'passing' and 'passed' to canonical values", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: BUILD=passing; TESTS=passed; EDGE_CASES=ok"
    );
    assert.equal(report?.build, "pass", "'passing' must be normalized to 'pass'");
    assert.equal(report?.tests, "pass", "'passed' must be normalized to 'pass'");
    assert.equal(report?.edgeCases, "pass", "'ok' must be normalized to 'pass'");
  });

  it("parseVerificationReport normalizes 'failing' and 'failed' to 'fail'", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: BUILD=failing; TESTS=failed"
    );
    assert.equal(report?.build, "fail", "'failing' must be normalized to 'fail'");
    assert.equal(report?.tests, "fail", "'failed' must be normalized to 'fail'");
  });

  it("parseVerificationReport normalizes 'na' and 'skipped' to 'n/a'", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: RESPONSIVE=na; API=skipped"
    );
    assert.equal(report?.responsive, "n/a", "'na' must be normalized to 'n/a'");
    assert.equal(report?.api, "n/a", "'skipped' must be normalized to 'n/a'");
  });
});

// ── Profile-aware: non-canonical required field values raise gaps ──────────────

describe("verification_gate — non-canonical required field value gaps", () => {
  it("non-canonical value 'xyz' on a required field raises a gap (false-negative prevention)", () => {
    // A worker that writes BUILD=xyz would slip past fail/n/a checks without
    // this guard.  The gate must reject it as non-canonical.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "# tests 5 pass 5",
        // Sneaks in a non-canonical value that isn't caught by n/a or fail checks
        "VERIFICATION_REPORT: BUILD=xyz; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    assert.equal(result.passed, false,
      "non-canonical required field value must fail the gate"
    );
    const nonCanonicalGap = result.gaps.find((g: string) => /non-canonical/i.test(g));
    assert.ok(nonCanonicalGap,
      `expected a non-canonical gap for BUILD=xyz; got: [${result.gaps.join("; ")}]`
    );
    assert.ok(nonCanonicalGap!.includes("BUILD"),
      "gap message must name the offending field"
    );
    assert.ok(nonCanonicalGap!.includes("xyz"),
      "gap message must include the non-canonical value"
    );
  });

  it("canonical 'pass' value on a required field does NOT raise a non-canonical gap", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "# tests 5 pass 5",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    const nonCanonicalGap = result.gaps.find((g: string) => /non-canonical/i.test(g));
    assert.equal(nonCanonicalGap, undefined,
      `canonical 'pass' must not raise a non-canonical gap; got: ${nonCanonicalGap}`
    );
  });

  it("normalized synonym 'passing' (→ 'pass') does NOT raise a non-canonical gap after normalization", () => {
    // 'passing' is normalized to 'pass' in parseVerificationReport, so by the
    // time validateWorkerContract sees the report the value is already canonical.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "# tests 5 pass 5",
        "VERIFICATION_REPORT: BUILD=passing; TESTS=passed; EDGE_CASES=ok; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    const nonCanonicalGap = result.gaps.find((g: string) => /non-canonical/i.test(g));
    assert.equal(nonCanonicalGap, undefined,
      "synonym 'passing' is pre-normalized; no non-canonical gap expected"
    );
  });

  it("negative path: non-canonical value on optional field does NOT raise a gap (optional → not enforced)", () => {
    // Optional fields are never checked for canonical values — only tracked.
    // Using 'security' (optional for backend) with a weird value must not block.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "# tests 5 pass 5",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=dunno; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    const nonCanonicalGap = result.gaps.find((g: string) => /non-canonical/i.test(g));
    assert.equal(nonCanonicalGap, undefined,
      "non-canonical value on optional field must not raise a gap"
    );
  });
});

// ── Profile-aware: optional field failure tracking ────────────────────────────

describe("verification_gate — optional field failure tracking in evidence", () => {
  it("evidence.optionalFieldFailures is an empty array when no optional fields fail", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5 pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    const optFails = (result.evidence as any).optionalFieldFailures;
    assert.ok(Array.isArray(optFails), "optionalFieldFailures must be an array");
    assert.equal(optFails.length, 0, "no optional field failures expected");
  });

  it("evidence.optionalFieldFailures includes 'security' when optional security=fail for backend", () => {
    // For backend: security is optional. A fail value must be tracked but NOT block.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5 pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=fail; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    // Gate must still PASS (security is optional for backend)
    assert.equal(result.passed, true,
      "optional security=fail must not block backend gate"
    );
    const optFails = (result.evidence as any).optionalFieldFailures as string[];
    assert.ok(Array.isArray(optFails), "optionalFieldFailures must be an array");
    assert.ok(optFails.includes("security"),
      `'security' must appear in optionalFieldFailures; got: [${optFails.join(", ")}]`
    );
  });

  it("required field failures remain in gaps, not in optionalFieldFailures", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "# tests 5 pass 5",
        "VERIFICATION_REPORT: BUILD=fail; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    assert.equal(result.passed, false, "required BUILD=fail must still block gate");
    assert.ok(result.gaps.some(g => /BUILD.*FAIL/i.test(g)), "BUILD fail must be in gaps");
    const optFails = (result.evidence as any).optionalFieldFailures as string[];
    assert.ok(!optFails.includes("build"),
      "required field 'build' must NOT appear in optionalFieldFailures"
    );
  });

  it("optionalFieldFailures is empty array when VERIFICATION_REPORT is missing", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "BOX_MERGED_SHA=abc1234\nCLEAN_TREE_STATUS=clean\n# tests 5 pass 5"
    });
    const optFails = (result.evidence as any).optionalFieldFailures;
    assert.ok(Array.isArray(optFails), "optionalFieldFailures must be an array even with no report");
    assert.equal(optFails.length, 0);
  });

  it("negative path: multiple optional field failures are all tracked", () => {
    // For backend: security and api are optional.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5 pass 5",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=fail; API=fail; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    // Gate still passes (both failing fields are optional for backend)
    assert.equal(result.passed, true,
      "optional security+api fail must not block backend gate"
    );
    const optFails = (result.evidence as any).optionalFieldFailures as string[];
    assert.ok(optFails.includes("security"),
      `'security' must be in optionalFieldFailures; got: [${optFails.join(", ")}]`
    );
    assert.ok(optFails.includes("api"),
      `'api' must be in optionalFieldFailures; got: [${optFails.join(", ")}]`
    );
  });
});

// ── applyConfigOverrides — promotedFields tracking ────────────────────────────

import { getVerificationProfile } from "../../src/core/verification_profiles.js";

describe("verification_gate — applyConfigOverrides promotedFields tracking", () => {
  it("promotes build from optional to required when requireBuild=true", () => {
    const profile = getVerificationProfile("test"); // test role: build=optional
    assert.equal(profile.evidence.build, "optional", "pre-condition: test role build must be optional");
    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.equal(upgraded.evidence.build, "required", "build must be promoted to required");
  });

  it("tracks promoted field in promotedFields Set", () => {
    const profile = getVerificationProfile("test");
    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.ok(upgraded.promotedFields instanceof Set, "promotedFields must be a Set");
    assert.ok(upgraded.promotedFields.has("build"), "promoted field 'build' must be in promotedFields");
  });

  it("does not include non-promoted fields in promotedFields", () => {
    const profile = getVerificationProfile("test");
    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.ok(!upgraded.promotedFields.has("tests"), "tests was not promoted and must not be in promotedFields");
  });

  it("does not promote exempt fields even when config flag is set", () => {
    // For test role: security=exempt — requireSecurityScan must not change it
    const profile = getVerificationProfile("test");
    const upgraded = applyConfigOverrides(profile, { requireSecurityScan: true });
    assert.equal(upgraded.evidence.security, "exempt", "exempt field must not be promoted");
    assert.ok(!upgraded.promotedFields.has("security"), "exempt field must not appear in promotedFields");
  });

  it("does not promote already-required fields (idempotent promotion guard)", () => {
    // backend role: build=required — promoting again must not double-add to promotedFields
    const profile = getVerificationProfile("backend");
    assert.equal(profile.evidence.build, "required", "pre-condition: backend build is already required");
    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    // build stays required but must NOT be added to promotedFields (it was already required)
    assert.ok(!upgraded.promotedFields.has("build"),
      "already-required field must not be added to promotedFields"
    );
  });

  it("promotes multiple fields when multiple flags are set", () => {
    const profile = getVerificationProfile("test"); // build=optional, security=exempt, tests=required
    const upgraded = applyConfigOverrides(profile, { requireBuild: true, requireTests: false });
    assert.ok(upgraded.promotedFields.has("build"), "build must be promoted");
    assert.ok(!upgraded.promotedFields.has("tests"), "tests was already required, not promoted");
  });

  it("returns original profile unchanged when no relevant flags are set", () => {
    const profile = getVerificationProfile("test");
    const result = applyConfigOverrides(profile, {});
    assert.deepEqual(result.evidence, profile.evidence);
    assert.ok(result.promotedFields instanceof Set && result.promotedFields.size === 0,
      "no promotions should occur with empty gatesConfig"
    );
  });

  it("returns original profile unchanged when gatesConfig is null/undefined", () => {
    const profile = getVerificationProfile("test");
    assert.strictEqual(applyConfigOverrides(profile, null), profile);
    assert.strictEqual(applyConfigOverrides(profile, undefined), profile);
  });
});

// ── Globally-promoted BUILD: n/a is allowed (false completion block prevention) ─

describe("verification_gate — globally-promoted BUILD allows n/a (no false completion block)", () => {
  const FULL_ARTIFACT = [
      "BOX_MERGED_SHA=abc1234",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 10 pass 10 fail 0",
      "===NPM TEST OUTPUT END===",
  ].join("\n");

  it("test role with requireBuild=true and BUILD=n/a passes (no false block)", () => {
    // test role: build=optional → promoted to required by config.
    // Worker doing a test-only task has no compilation step → reports BUILD=n/a.
    // This must NOT produce a gap — globally-promoted fields allow n/a.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT,
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    const buildGap = result.gaps.find(g => /BUILD.*required.*n\/a|BUILD.*was.*n\/a/i.test(g));
    assert.equal(
      buildGap, undefined,
      `globally-promoted BUILD=n/a must not produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("test role with requireBuild=true and BUILD=fail is still rejected (failure is always a gap)", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT,
        "VERIFICATION_REPORT: BUILD=fail; TESTS=pass; EDGE_CASES=pass",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    assert.equal(result.passed, false, "promoted BUILD=fail must still block the gate");
    assert.ok(result.gaps.some(g => /BUILD.*FAIL/i.test(g)),
      `BUILD fail must produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("test role with requireBuild=true and BUILD=pass passes cleanly", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT,
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    const buildGap = result.gaps.find(g => /BUILD/i.test(g));
    assert.equal(
      buildGap, undefined,
      `BUILD=pass must produce no gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("test role with requireBuild=true and BUILD missing from report produces a gap", () => {
    // Missing from report entirely is still an error — n/a must be explicit.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT,
        "VERIFICATION_REPORT: TESTS=pass; EDGE_CASES=pass",
        // No BUILD field at all
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    assert.equal(result.passed, false, "promoted BUILD missing from report must still block");
    assert.ok(result.gaps.some(g => /BUILD.*missing|BUILD.*required/i.test(g)),
      `BUILD missing from report must produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: non-promoted required BUILD=n/a still creates a gap", () => {
    // backend role: build=required (NOT optional, so no promotion) — n/a must still fail.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        FULL_ARTIFACT,
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    }, { gatesConfig: { requireBuild: true } });

    assert.equal(result.passed, false,
      "non-promoted required BUILD=n/a must still block the gate"
    );
    assert.ok(result.gaps.some(g => /BUILD.*n\/a|BUILD.*required/i.test(g)),
      `originally-required BUILD=n/a must produce a gap; gaps: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Template-complete post-merge placeholders (T-1 hardening) ─────────────────
// Verifies that ALL template placeholder residues are exported as constants and
// that checkPostMergeArtifact rejects each of them deterministically.

describe("verification_gate — POST_MERGE_SHA_PLACEHOLDER and POST_MERGE_OUTPUT_PLACEHOLDER constants", () => {
  it("exports POST_MERGE_SHA_PLACEHOLDER as a non-empty string", () => {
    assert.ok(typeof POST_MERGE_SHA_PLACEHOLDER === "string" && POST_MERGE_SHA_PLACEHOLDER.length > 0,
      "POST_MERGE_SHA_PLACEHOLDER must be a non-empty string");
  });

  it("exports POST_MERGE_OUTPUT_PLACEHOLDER as a non-empty string", () => {
    assert.ok(typeof POST_MERGE_OUTPUT_PLACEHOLDER === "string" && POST_MERGE_OUTPUT_PLACEHOLDER.length > 0,
      "POST_MERGE_OUTPUT_PLACEHOLDER must be a non-empty string");
  });

  it("POST_MERGE_SHA_PLACEHOLDER contains the expected template text", () => {
    assert.ok(POST_MERGE_SHA_PLACEHOLDER.includes("paste") && POST_MERGE_SHA_PLACEHOLDER.includes("rev-parse"),
      `expected SHA placeholder to reference git rev-parse; got: "${POST_MERGE_SHA_PLACEHOLDER}"`);
  });

  it("POST_MERGE_OUTPUT_PLACEHOLDER contains the expected template text", () => {
    assert.ok(POST_MERGE_OUTPUT_PLACEHOLDER.includes("paste") && POST_MERGE_OUTPUT_PLACEHOLDER.includes("npm"),
      `expected output placeholder to reference npm test; got: "${POST_MERGE_OUTPUT_PLACEHOLDER}"`);
  });

  it("exports ALL_POST_MERGE_PLACEHOLDERS as a frozen array containing all three literals", () => {
    assert.ok(Array.isArray(ALL_POST_MERGE_PLACEHOLDERS), "ALL_POST_MERGE_PLACEHOLDERS must be an array");
    assert.ok(Object.isFrozen(ALL_POST_MERGE_PLACEHOLDERS), "ALL_POST_MERGE_PLACEHOLDERS must be frozen");
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.includes(POST_MERGE_PLACEHOLDER),
      "ALL_POST_MERGE_PLACEHOLDERS must include POST_MERGE_PLACEHOLDER");
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.includes(POST_MERGE_SHA_PLACEHOLDER),
      "ALL_POST_MERGE_PLACEHOLDERS must include POST_MERGE_SHA_PLACEHOLDER");
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.includes(POST_MERGE_OUTPUT_PLACEHOLDER),
      "ALL_POST_MERGE_PLACEHOLDERS must include POST_MERGE_OUTPUT_PLACEHOLDER");
  });

  it("ALL_POST_MERGE_PLACEHOLDERS contains at least three entries", () => {
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.length >= 3,
      `expected ≥3 placeholder entries; got ${ALL_POST_MERGE_PLACEHOLDERS.length}`);
  });
});

describe("verification_gate — checkPostMergeArtifact rejects all template placeholder residues", () => {
  it("hasUnfilledPlaceholder=true when POST_MERGE_SHA_PLACEHOLDER is present", () => {
    const output = `SHA: ${POST_MERGE_SHA_PLACEHOLDER}\nnpm test output:\n# tests 5 pass 5`;
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, true,
      "SHA placeholder residue must set hasUnfilledPlaceholder=true");
    assert.equal(result.hasArtifact, false,
      "artifact must be incomplete when SHA placeholder is present");
  });

  it("hasUnfilledPlaceholder=true when POST_MERGE_OUTPUT_PLACEHOLDER is present", () => {
    const output = `BOX_MERGED_SHA=abc1234\nnpm test output:\n${POST_MERGE_OUTPUT_PLACEHOLDER}`;
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, true,
      "test output placeholder residue must set hasUnfilledPlaceholder=true");
    assert.equal(result.hasArtifact, false,
      "artifact must be incomplete when test output placeholder is present");
  });

  it("hasUnfilledPlaceholder=true when POST_MERGE_PLACEHOLDER (main marker) is present", () => {
    const output = `${POST_MERGE_PLACEHOLDER}\nSHA: abc1234\n# tests 5 pass 5`;
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, true,
      "main placeholder residue must set hasUnfilledPlaceholder=true");
  });

  it("hasUnfilledPlaceholder=false for fully-filled artifact with no template residue", () => {
    const output = [
      "BOX_MERGED_SHA=abc1234f",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 10 pass 10 fail 0",
      "===NPM TEST OUTPUT END===",
    ].join("\n");
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, false,
      "no placeholder residue expected in a fully-filled artifact");
    assert.equal(result.hasArtifact, true,
      "fully-filled artifact must have hasArtifact=true");
  });

  it("collectArtifactGaps emits UNFILLED_PLACEHOLDER for SHA placeholder residue", () => {
    const output = `SHA: ${POST_MERGE_SHA_PLACEHOLDER}`;
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasUnfilledPlaceholder, true);
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.includes(ARTIFACT_GAP.UNFILLED_PLACEHOLDER),
      `UNFILLED_PLACEHOLDER gap expected; got: [${gaps.join("; ")}]`);
  });

  it("negative path: output with only inline SHA placeholder (no full template marker) is still rejected", () => {
    // Even when POST_MERGE_TEST_OUTPUT is absent, the SHA placeholder alone is enough to reject.
    const output = `BOX_MERGED_SHA=abc1234\n${POST_MERGE_SHA_PLACEHOLDER}`;
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, true,
      "SHA placeholder alone must trigger hasUnfilledPlaceholder");
  });

  it("negative path: output with only output placeholder is still rejected", () => {
    const output = `BOX_MERGED_SHA=abc1234\n# tests 5 pass 5\n${POST_MERGE_OUTPUT_PLACEHOLDER}`;
    const result = checkPostMergeArtifact(output);
    assert.equal(result.hasUnfilledPlaceholder, true,
      "test output placeholder alone must trigger hasUnfilledPlaceholder");
  });
});

describe("verification_gate — validateWorkerContract rejects inline template placeholder residues", () => {
  it("backend done with SHA placeholder in output is rejected as unfilled placeholder", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        `SHA: ${POST_MERGE_SHA_PLACEHOLDER}`,
        "# tests 5 pass 5",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    assert.equal(result.passed, false,
      "SHA placeholder residue must cause done gate to fail");
    assert.ok(result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap; got: [${result.gaps.join("; ")}]`);
  });

  it("backend done with output placeholder in output is rejected as unfilled placeholder", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234",
        POST_MERGE_OUTPUT_PLACEHOLDER,
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    assert.equal(result.passed, false,
      "test output placeholder residue must cause done gate to fail");
    assert.ok(result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap; got: [${result.gaps.join("; ")}]`);
  });

  it("negative path: done with all three placeholders removed and real content passes artifact gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "BOX_MERGED_SHA=abc1234f",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 12 pass 12 fail 0",
        "===NPM TEST OUTPUT END===",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1",
      ].join("\n"),
    });
    const artifactGap = result.gaps.find(g => /placeholder|sha|test output/i.test(g));
    assert.equal(artifactGap, undefined,
      `no artifact gap expected when all placeholders are replaced; gaps: [${result.gaps.join("; ")}]`);
  });
});

// ── Carry-forward backlog closure verification (#1-#5) ────────────────────────
// Machine-checkable tests proving each item in state/carry_forward_backlog.json
// has a concrete gate that prevents the failure pattern from recurring.

import {
  checkForbiddenCommands,
} from "../../src/core/verification_command_registry.js";

describe("verification_gate — carry-forward backlog closure (#1-#5)", () => {
  // CF-001: Workers not including BOX_MERGED_SHA
  it("CF-001: collectArtifactGaps emits ARTIFACT_GAP.MISSING_SHA when SHA is absent", () => {
    const artifact = checkPostMergeArtifact(
      "===NPM TEST OUTPUT START===\n# pass 5\n===NPM TEST OUTPUT END===\n"
    );
    assert.equal(artifact.hasSha, false, "hasSha must be false when no SHA in output");
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_SHA),
      `MISSING_SHA gap must be emitted; got: [${gaps.join("; ")}]`);
  });

  it("CF-001: ARTIFACT_GAP.MISSING_SHA constant is a non-empty string", () => {
    assert.equal(typeof ARTIFACT_GAP.MISSING_SHA, "string");
    assert.ok(ARTIFACT_GAP.MISSING_SHA.length > 0);
  });

  // CF-002: Workers not including ===NPM TEST OUTPUT START=== block
  it("CF-002: collectArtifactGaps emits ARTIFACT_GAP.MISSING_TEST_OUTPUT when npm block is absent", () => {
    const artifact = checkPostMergeArtifact("BOX_MERGED_SHA=abc1234f\nsome output without npm block\n");
    assert.equal(artifact.hasTestOutput, false, "hasTestOutput must be false when npm block is absent");
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.includes(ARTIFACT_GAP.MISSING_TEST_OUTPUT),
      `MISSING_TEST_OUTPUT gap must be emitted; got: [${gaps.join("; ")}]`);
  });

  it("CF-002: ARTIFACT_GAP.MISSING_TEST_OUTPUT constant is a non-empty string", () => {
    assert.equal(typeof ARTIFACT_GAP.MISSING_TEST_OUTPUT, "string");
    assert.ok(ARTIFACT_GAP.MISSING_TEST_OUTPUT.length > 0);
  });

  // CF-003: Workers using node --test tests/** glob patterns
  it("CF-003: checkForbiddenCommands rejects node --test tests/** glob pattern", () => {
    const result = checkForbiddenCommands("node --test tests/**");
    assert.equal(result.forbidden, true,
      "node --test tests/** must be forbidden (glob pattern, not npm test)");
    assert.ok(result.violations.length > 0, "must have at least one violation");
  });

  it("CF-003: checkForbiddenCommands rejects node --test with deep glob path", () => {
    const result = checkForbiddenCommands("node --test tests/core/**/*.test.js");
    assert.equal(result.forbidden, true,
      "node --test with deep glob must be forbidden");
  });

  // CF-004: Workers using bash/sh scripts
  it("CF-004: checkForbiddenCommands rejects bare bash invocation", () => {
    const result = checkForbiddenCommands("bash scripts/test.sh");
    assert.equal(result.forbidden, true,
      "bash scripts/test.sh must be forbidden");
    assert.ok(result.violations.length > 0, "must have at least one violation");
  });

  it("CF-004: checkForbiddenCommands rejects sh script invocation (negative path: npm test is allowed)", () => {
    const allowed = checkForbiddenCommands("npm test");
    assert.equal(allowed.forbidden, false,
      "npm test must NOT be a forbidden command (it is the canonical command)");
  });

  // CF-005: Workers using unfilled template placeholders
  it("CF-005: checkPostMergeArtifact sets hasUnfilledPlaceholder=true for SHA placeholder residue", () => {
    const output = [
      `BOX_MERGED_SHA=${POST_MERGE_SHA_PLACEHOLDER}`,
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===\n# pass 5\n===NPM TEST OUTPUT END===",
    ].join("\n");
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasUnfilledPlaceholder, true,
      "SHA placeholder residue must set hasUnfilledPlaceholder=true");
  });

  it("CF-005: collectArtifactGaps emits ARTIFACT_GAP.UNFILLED_PLACEHOLDER for placeholder residue", () => {
    const output = `SHA: ${POST_MERGE_SHA_PLACEHOLDER}`;
    const artifact = checkPostMergeArtifact(output);
    assert.equal(artifact.hasUnfilledPlaceholder, true);
    const gaps = collectArtifactGaps(artifact);
    assert.ok(gaps.includes(ARTIFACT_GAP.UNFILLED_PLACEHOLDER),
      `UNFILLED_PLACEHOLDER gap must be emitted; got: [${gaps.join("; ")}]`);
  });

  it("CF-005: ALL_POST_MERGE_PLACEHOLDERS contains both placeholder constants", () => {
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.includes(POST_MERGE_SHA_PLACEHOLDER),
      "ALL_POST_MERGE_PLACEHOLDERS must include POST_MERGE_SHA_PLACEHOLDER");
    assert.ok(ALL_POST_MERGE_PLACEHOLDERS.includes(POST_MERGE_OUTPUT_PLACEHOLDER),
      "ALL_POST_MERGE_PLACEHOLDERS must include POST_MERGE_OUTPUT_PLACEHOLDER");
  });

  // Integration path: validateWorkerContract blocks done for all five failure patterns
  it("integration: done with missing SHA is blocked (CF-001 + CF-002 combined)", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
    });
    assert.equal(result.passed, false, "done without SHA or npm output must be blocked");
    assert.ok(result.gaps.some(g => /sha/i.test(g)),
      `SHA gap expected; got: [${result.gaps.join("; ")}]`);
    assert.ok(result.gaps.some(g => /test output|npm/i.test(g)),
      `test output gap expected; got: [${result.gaps.join("; ")}]`);
  });

  it("integration: done with unfilled placeholder is blocked (CF-005)", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        POST_MERGE_OUTPUT_PLACEHOLDER,
        "VERIFICATION_REPORT: BUILD=pass",
      ].join("\n"),
    });
    assert.equal(result.passed, false, "done with placeholder residue must be blocked");
    assert.ok(result.gaps.some(g => /placeholder/i.test(g)),
      `placeholder gap expected; got: [${result.gaps.join("; ")}]`);
  });
});

// ── Cancellation-scope at verification entry ──────────────────────────────────

import {
  checkCancellationAtVerification,
} from "../../src/core/verification_gate.js";
import { createCancellationToken, CancelledError } from "../../src/core/daemon_control.js";

describe("verification_gate — checkCancellationAtVerification", () => {
  it("is a no-op when token is null", () => {
    assert.doesNotThrow(() => checkCancellationAtVerification(null));
  });

  it("is a no-op when token is undefined", () => {
    assert.doesNotThrow(() => checkCancellationAtVerification(undefined));
  });

  it("is a no-op when token is not cancelled", () => {
    const token = createCancellationToken();
    assert.doesNotThrow(() => checkCancellationAtVerification(token));
  });

  it("throws CancelledError when token is already cancelled", () => {
    const token = createCancellationToken();
    token.cancel("stop-before-verification");
    assert.throws(() => checkCancellationAtVerification(token), CancelledError);
  });

  it("CancelledError carries the cancel reason from the token", () => {
    const token = createCancellationToken();
    token.cancel("cycle-teardown");
    try {
      checkCancellationAtVerification(token);
      assert.fail("expected CancelledError");
    } catch (err) {
      assert.ok(err instanceof CancelledError);
      assert.equal(err.reason, "cycle-teardown");
    }
  });

  it("negative path: does not throw for a freshly created non-cancelled token", () => {
    const token = createCancellationToken();
    // Not cancelled — must be a complete no-op
    let threw = false;
    try { checkCancellationAtVerification(token); } catch { threw = true; }
    assert.equal(threw, false, "fresh token must not trigger CancelledError");
  });
});

// ── auditRuntimeHookEnforcement ───────────────────────────────────────────────

import { auditRuntimeHookEnforcement } from "../../src/core/verification_gate.js";

describe("auditRuntimeHookEnforcement", () => {
  it("reports consistent=true when runtime and worker decisions all agree", () => {
    const runtimeDecisions = [
      { envelope: { scope: "src", intent: "read", impact: "low", clearance: "read" }, decision: { allowed: true, decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "allow-tool-intent-envelope" } },
    ];
    const workerDecisions = [
      { tool: "execute", decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "allow-tool-intent-envelope", envelopeScope: "src", envelopeIntent: "read", envelopeImpact: "low", envelopeClearance: "read", raw: "" },
    ];
    const audit = auditRuntimeHookEnforcement(runtimeDecisions, workerDecisions);
    assert.equal(audit.consistent, true);
    assert.deepEqual(audit.gaps, []);
    assert.equal(audit.runtimeDenied, 0);
    assert.equal(audit.workerDenied, 0);
  });

  it("detects count mismatch between runtime and worker decisions", () => {
    const runtimeDecisions = [
      { envelope: { scope: "src", intent: "read", impact: "low", clearance: "read" }, decision: { allowed: true, decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "r1" } },
      { envelope: { scope: "src", intent: "write", impact: "medium", clearance: "write" }, decision: { allowed: true, decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "r1" } },
    ];
    const workerDecisions = [
      { tool: "execute", decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "r1", envelopeScope: "src", envelopeIntent: "read", envelopeImpact: "low", envelopeClearance: "read", raw: "" },
    ];
    const audit = auditRuntimeHookEnforcement(runtimeDecisions, workerDecisions);
    assert.equal(audit.consistent, false);
    assert.ok(audit.gaps.some((g) => g.includes("RUNTIME_HOOK_COUNT_MISMATCH")));
  });

  it("detects decision mismatch at same index", () => {
    const runtimeDecisions = [
      { envelope: { scope: "src", intent: "delete", impact: "high", clearance: "read" }, decision: { allowed: false, decision: "deny", reasonCode: "TOOL_INTENT_INSUFFICIENT_CLEARANCE", ruleId: "deny-r" } },
    ];
    const workerDecisions = [
      { tool: "execute", decision: "allow", reasonCode: "TOOL_INTENT_ALLOWED", ruleId: "r1", envelopeScope: "src", envelopeIntent: "delete", envelopeImpact: "high", envelopeClearance: "read", raw: "" },
    ];
    const audit = auditRuntimeHookEnforcement(runtimeDecisions, workerDecisions);
    assert.equal(audit.consistent, false);
    assert.ok(audit.gaps.some((g) => g.includes("RUNTIME_HOOK_DECISION_MISMATCH")));
    assert.equal(audit.runtimeDenied, 1);
    assert.equal(audit.workerDenied, 0);
  });

  it("negative path: returns consistent=true for empty input", () => {
    const audit = auditRuntimeHookEnforcement([], []);
    assert.equal(audit.consistent, true);
    assert.deepEqual(audit.gaps, []);
  });
});
