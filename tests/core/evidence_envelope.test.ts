/**
 * evidence_envelope.test.ts
 *
 * Unit tests for validateEvidenceEnvelope — the hard admission control that
 * blocks malformed envelopes from reaching Athena's postmortem logic.
 *
 * Covers:
 *   - Valid envelope passes
 *   - Missing required fields fail
 *   - Invalid verificationEvidence slot values fail
 *   - Null / non-object input fails
 *   - Negative path: partial envelope (only some required fields)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildWorkerExecutionReportArtifact,
  validateEvidenceEnvelope,
  validatePlanEvidenceCoupling,
  envelopeFieldHasPlaceholderResidue,
} from "../../src/core/evidence_envelope.js";
import {
  buildAthenaReviewFindingArtifact,
  buildPrometheusPlanArtifact,
} from "../../src/core/plan_lifecycle_contract.js";

const VALID_EVIDENCE = { build: "pass", tests: "pass", lint: "n/a" };

function validEnvelope() {
  return {
    roleName: "evolution-worker",
    status: "done",
    summary: "Task completed successfully.",
    verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
  };
}

function validPlanArtifact() {
  return buildPrometheusPlanArtifact({
    task: "Introduce typed artifacts across the leadership chain",
    task_id: "T-typed-artifacts",
    role: "evolution-worker",
    wave: 1,
    scope: "Persist structured artifacts for Janus, Prometheus, Athena, and worker handoff",
    target_files: ["src/core/janus_supervisor.ts", "src/core/evidence_envelope.ts"],
    acceptance_criteria: ["Athena consumes typed plan and execution artifacts directly"],
    verification_commands: ["npm test -- tests/core/evidence_envelope.test.ts"],
    riskLevel: "medium",
    _provenance: {
      source: "prometheus-normalization",
      reason: "aggregate-parser-confidence",
      confidence: 0.91,
      tag: "direct",
      attachedAt: "2026-04-13T18:05:02.838Z",
    },
  }, {
    emittedAt: "2026-04-13T18:05:02.838Z",
  });
}

function validReviewArtifact() {
  return buildAthenaReviewFindingArtifact({
    approved: true,
    overallScore: 9,
    summary: "Plan is concrete and low risk.",
    planReviews: [{
      planIndex: 0,
      role: "evolution-worker",
      measurable: true,
      successCriteriaClear: true,
      verificationConcrete: true,
      scopeDefined: true,
      preMortemComplete: true,
      issues: [],
      suggestion: "No changes required.",
    }],
  }, [validPlanArtifact()], {
    emittedAt: "2026-04-13T18:05:02.838Z",
    gateRisk: {
      gateBlockRisk: "low",
      reason: "No active governance gate blockers",
      activeGateSignals: [],
      requiresCorrection: false,
    },
  });
}

describe("validateEvidenceEnvelope", () => {
  it("accepts a fully valid envelope", () => {
    const result = validateEvidenceEnvelope(validEnvelope());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts envelope with all optional fields present", () => {
    const envelope = {
      ...validEnvelope(),
      prUrl: "https://github.com/owner/repo/pull/1",
      filesTouched: ["src/core/foo.ts"],
      verificationOutput: "Tests passed",
      verificationPassed: true,
      prChecks: { ok: true, passed: true, failed: [], pending: [], total: 3 },
      preReviewAssessment: "Looks good",
      preReviewIssues: [],
      planArtifact: validPlanArtifact(),
      reviewArtifact: validReviewArtifact(),
      executionReport: buildWorkerExecutionReportArtifact(validEnvelope(), {
        emittedAt: "2026-04-13T18:05:02.838Z",
      }),
    };
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, true);
  });

  it("builds a typed worker execution report from the evidence envelope", () => {
    const executionReport = buildWorkerExecutionReportArtifact({
      ...validEnvelope(),
      filesTouched: ["src/core/evidence_envelope.ts"],
      verificationPassed: true,
      preReviewAssessment: "Looks good",
      preReviewIssues: ["None"],
      dispatchContract: { dispatchBlockReason: null },
    }, {
      emittedAt: "2026-04-13T18:05:02.838Z",
    });
    assert.equal(executionReport.source, "worker_execution_report");
    assert.equal(executionReport.roleName, "evolution-worker");
    assert.equal(executionReport.verificationEvidence.build, "pass");
    assert.deepEqual(executionReport.filesTouched, ["src/core/evidence_envelope.ts"]);
  });

  it("preserves stable prompt-family lineage joins in worker execution reports", () => {
    const executionReport = buildWorkerExecutionReportArtifact({
      ...validEnvelope(),
      roleName: "prometheus",
      taskKind: "planning",
      lineage: {
        lineageId: "lineage-314",
        taskKind: "planning",
        promptFamilyKey: "planner-wave-3",
      },
      lineageJoinKey: "prompt-family:planner-wave-3",
    }, {
      emittedAt: "2026-04-13T18:05:02.838Z",
    });
    assert.equal(executionReport.lineageJoinKey, "prompt-family:planner-wave-3");
  });

  it("rejects null", () => {
    const result = validateEvidenceEnvelope(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects non-object (string)", () => {
    const result = validateEvidenceEnvelope("bad");
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects missing roleName", () => {
    const { roleName: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("roleName")));
  });

  it("rejects empty roleName", () => {
    const result = validateEvidenceEnvelope({ ...validEnvelope(), roleName: "  " });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("roleName")));
  });

  it("rejects missing status", () => {
    const { status: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("status")));
  });

  it("rejects missing summary", () => {
    const { summary: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("summary")));
  });

  it("rejects missing verificationEvidence", () => {
    const { verificationEvidence: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence")));
  });

  it("rejects verificationEvidence with invalid build slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "unknown", tests: "pass", lint: "n/a" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.build")));
  });

  it("rejects verificationEvidence with invalid tests slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "pass", tests: null, lint: "n/a" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.tests")));
  });

  it("rejects verificationEvidence with invalid lint slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "pass", tests: "fail", lint: "bad" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.lint")));
  });

  it("collects all errors when multiple fields are invalid", () => {
    const result = validateEvidenceEnvelope({
      roleName: "",
      status: "",
      summary: "",
      verificationEvidence: { build: "bad", tests: "bad", lint: "bad" },
    });
    assert.equal(result.valid, false);
    // roleName, status, summary, + 3 evidence slot errors = at least 6
    assert.ok(result.errors.length >= 6, `expected ≥6 errors, got ${result.errors.length}`);
  });

  it("negative path: envelope with only roleName is invalid", () => {
    const result = validateEvidenceEnvelope({ roleName: "worker" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("status")));
    assert.ok(result.errors.some(e => e.includes("summary")));
  });

  it("accepts all valid slot combinations", () => {
    const slots = ["pass", "fail", "n/a"] as const;
    for (const b of slots) {
      for (const t of slots) {
        for (const l of slots) {
          const result = validateEvidenceEnvelope({
            ...validEnvelope(),
            verificationEvidence: { build: b, tests: t, lint: l },
          });
          assert.equal(result.valid, true, `expected valid for build=${b} tests=${t} lint=${l}`);
        }
      }
    }
  });

  it("rejects malformed executionReport artifacts", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      executionReport: {
        source: "wrong",
        roleName: "",
        status: "done",
        summary: "",
        filesTouched: "src/core/evidence_envelope.ts",
        verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
      },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("executionReport.source")));
    assert.ok(result.errors.some(e => e.includes("executionReport.roleName")));
    assert.ok(result.errors.some(e => e.includes("executionReport.filesTouched")));
  });
});

// ── Task 3 hardening: validatePlanEvidenceCoupling — pre-dispatch plan gate ───

describe("validatePlanEvidenceCoupling — plan evidence coupling validation", () => {
  function validPlan(overrides: Record<string, unknown> = {}) {
    return {
      task_id: "T-001",
      task: "Implement trust boundary check",
      verification_commands: ["npm test"],
      acceptance_criteria: ["All tests pass"],
      ...overrides,
    };
  }

  it("accepts a fully valid plan with commands and criteria", () => {
    const result = validatePlanEvidenceCoupling(validPlan());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts a plan with acceptance_criteria as a string", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: "All tests must pass" }));
    assert.equal(result.valid, true);
  });

  it("accepts a plan with acceptance_criteria as a multi-element array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({
      acceptance_criteria: ["No regressions", "Test coverage ≥ 80%"]
    }));
    assert.equal(result.valid, true);
  });

  it("rejects null input", () => {
    const result = validatePlanEvidenceCoupling(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects non-object input", () => {
    const result = validatePlanEvidenceCoupling("not a plan");
    assert.equal(result.valid, false);
  });

  it("rejects plan with missing verification_commands", () => {
    const { verification_commands: _, ...plan } = validPlan();
    const result = validatePlanEvidenceCoupling(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with empty verification_commands array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ verification_commands: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with only empty-string verification_commands", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ verification_commands: ["", "  "] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with missing acceptance_criteria", () => {
    const { acceptance_criteria: _, ...plan } = validPlan();
    const result = validatePlanEvidenceCoupling(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("rejects plan with empty acceptance_criteria string", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: "   " }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("rejects plan with empty acceptance_criteria array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("collects all errors when both required fields are missing", () => {
    const result = validatePlanEvidenceCoupling({ task: "do something" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
    assert.equal(result.errors.length, 2);
  });

  it("negative path: plan without any evidence fields is invalid", () => {
    const result = validatePlanEvidenceCoupling({ task: "do something", wave: 1 });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2, "both coupling fields must be reported missing");
  });
});

// ── Athena consumption boundary: runAthenaPostmortem rejects invalid envelopes ─

import { runAthenaPostmortem } from "../../src/core/athena_reviewer.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeConfig(tmpDir: string) {
  return {
    paths: { stateDir: tmpDir, progressFile: path.join(tmpDir, "progress.txt") },
    env: { copilotCliCommand: "__missing_copilot_binary__", targetRepo: "CanerDoqdu/Box" },
    roleRegistry: {
      qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
    },
    runtime: {},
  };
}

function validEnvelopeForAthena() {
  return {
    roleName: "evolution-worker",
    status: "done",
    summary: "All changes implemented and tests pass.",
    verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    verificationPassed: true,
  };
}

describe("runAthenaPostmortem — Athena consumption boundary validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-boundary-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when the envelope is missing required fields (no roleName)", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      status: "done",
      summary: "Task completed.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        assert.ok(err.message.includes("roleName"), `expected roleName error, got: ${err.message}`);
        return true;
      }
    );
  });

  it("throws when verificationEvidence has invalid slot values", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "Task completed.",
      verificationEvidence: { build: "yes", tests: "no", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        return true;
      }
    );
  });

  it("throws when summary is empty", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "   ",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        assert.ok(err.message.includes("summary"), `expected summary error, got: ${err.message}`);
        return true;
      }
    );
  });

  it("negative path: null envelope throws with evidence envelope error", async () => {
    const config = makeConfig(tmpDir);
    await assert.rejects(
      () => runAthenaPostmortem(config, null as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        return true;
      }
    );
  });

  it("does not throw envelope error for a structurally valid envelope (AI failure is expected)", async () => {
    const config = makeConfig(tmpDir);
    // The AI call will fail (missing binary), but the envelope is valid — so we should NOT get
    // an envelope validation error. Any other error (AI failure) is acceptable here.
    try {
      await runAthenaPostmortem(config, validEnvelopeForAthena() as any, {
        task: "T-001",
        verification: "npm test",
        context: "test"
      });
      // If it returns (e.g., deterministic fast-path), that's fine too.
    } catch (err: any) {
      // Must NOT be an envelope validation error
      assert.ok(
        !err.message.includes("[ATHENA] Evidence envelope invalid"),
        `valid envelope must not trigger validation error; got: ${err.message}`
      );
    }
  });

  it("consumes typed plan and execution artifacts on the deterministic fast-path", async () => {
    const config = makeConfig(tmpDir);
    const planArtifact = validPlanArtifact();
    const reviewArtifact = validReviewArtifact();
    const workerEnvelope = {
      ...validEnvelopeForAthena(),
      planArtifact,
      reviewArtifact,
      executionReport: buildWorkerExecutionReportArtifact({
        ...validEnvelopeForAthena(),
        filesTouched: ["src/core/evidence_envelope.ts"],
        verificationPassed: true,
      }, {
        emittedAt: "2026-04-13T18:05:02.838Z",
      }),
      dispatchContract: {
        doneWorkerWithVerificationReportEvidence: true,
        doneWorkerWithCleanTreeStatusEvidence: true,
        replayClosure: {
          contractSatisfied: true,
        },
      },
    };
    const postmortem = await runAthenaPostmortem(config, workerEnvelope as any, {
      planArtifact,
      task: "this should not be used when planArtifact is present",
      verification: "placeholder",
      context: "placeholder",
    });
    assert.equal(postmortem.expectedOutcome, planArtifact.task);
    assert.equal(postmortem.recommendation, "proceed");
    assert.equal(postmortem.closureEvidenceEnvelope?.task, planArtifact.task);
  });
});

// ── envelopeFieldHasPlaceholderResidue — deterministic template residue check ─

describe("envelopeFieldHasPlaceholderResidue", () => {
  it("returns false for a normal summary string without any placeholder", () => {
    assert.equal(envelopeFieldHasPlaceholderResidue("Task completed. All tests pass."), false);
  });

  it("returns true when POST_MERGE_TEST_OUTPUT literal is present", () => {
    assert.equal(envelopeFieldHasPlaceholderResidue("POST_MERGE_TEST_OUTPUT\nSHA: abc"), true);
  });

  it("returns true when SHA placeholder literal is present", () => {
    assert.equal(
      envelopeFieldHasPlaceholderResidue("SHA: <paste git rev-parse HEAD here>"),
      true,
      "SHA template placeholder must be detected"
    );
  });

  it("returns true when npm output placeholder literal is present", () => {
    assert.equal(
      envelopeFieldHasPlaceholderResidue("output:\n<paste full raw npm test stdout here>"),
      true,
      "npm output template placeholder must be detected"
    );
  });

  it("returns false for an empty string", () => {
    assert.equal(envelopeFieldHasPlaceholderResidue(""), false);
  });

  it("returns false for a long realistic summary without placeholders", () => {
    const summary = [
      "Implemented trust boundary check in src/core/trust_boundary.ts.",
      "BOX_MERGED_SHA=abc1234f",
      "All 42 tests pass.",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; LINT=pass",
    ].join("\n");
    assert.equal(envelopeFieldHasPlaceholderResidue(summary), false);
  });

  it("negative path: partial placeholder text that does not match any known literal returns false", () => {
    // A string that contains 'paste' but is not a known placeholder literal
    assert.equal(envelopeFieldHasPlaceholderResidue("please paste your output here in text"), false);
  });
});

// ── validateEvidenceEnvelope — placeholder residue in summary field ───────────

describe("validateEvidenceEnvelope — rejects summary with template placeholder residue", () => {
  it("rejects summary containing POST_MERGE_TEST_OUTPUT literal", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      summary: "POST_MERGE_TEST_OUTPUT\nSHA: abc\n# tests 5 pass",
    });
    assert.equal(result.valid, false,
      "summary with POST_MERGE_TEST_OUTPUT placeholder must be rejected");
    assert.ok(result.errors.some(e => /summary.*placeholder|placeholder.*summary/i.test(e)),
      `expected placeholder error in summary; got: [${result.errors.join("; ")}]`);
  });

  it("rejects summary containing SHA template placeholder", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      summary: "SHA: <paste git rev-parse HEAD here>",
    });
    assert.equal(result.valid, false,
      "summary with SHA placeholder must be rejected");
    assert.ok(result.errors.some(e => /placeholder/i.test(e)),
      `expected placeholder error; got: [${result.errors.join("; ")}]`);
  });

  it("rejects summary containing npm output template placeholder", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      summary: "npm test output:\n<paste full raw npm test stdout here>",
    });
    assert.equal(result.valid, false,
      "summary with npm output placeholder must be rejected");
    assert.ok(result.errors.some(e => /placeholder/i.test(e)),
      `expected placeholder error; got: [${result.errors.join("; ")}]`);
  });

  it("accepts summary that is fully filled with real content (no placeholder residue)", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      summary: "BOX_MERGED_SHA=abc1234f\n# tests 42 pass 42 fail 0\nAll done.",
    });
    assert.equal(result.valid, true,
      "summary with real content (no placeholders) must pass validation");
    assert.deepEqual(result.errors, []);
  });

  it("negative path: only summary placeholder rejected; other fields valid", () => {
    const result = validateEvidenceEnvelope({
      roleName: "evolution-worker",
      status: "done",
      summary: "<paste full raw npm test stdout here>",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 1,
      `expected exactly 1 error (summary placeholder); got ${result.errors.length}: [${result.errors.join("; ")}]`);
    assert.ok(result.errors[0].includes("placeholder"),
      `error must mention placeholder; got: "${result.errors[0]}"`);
  });
});


