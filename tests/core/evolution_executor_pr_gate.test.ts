import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessStatusCheckRollup,
  injectAthenaMissingItems,
  hardenTaskForAthena,
  repairPrometheusTask,
  shouldHaltOnPreReviewReject,
  shouldRetryAthenaPreReview,
  checkScopeConformance,
  buildVerificationTargets,
  inferVerificationFromFilesHint,
  validateVerificationPortability,
  BLOCKED_VERIFICATION_CMDS,
} from "../../src/core/evolution_executor.js";

describe("assessStatusCheckRollup", () => {
  it("passes when all checks are successful", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Security", status: "COMPLETED", conclusion: "NEUTRAL" }
    ]);

    assert.equal(result.passed, true);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pending, []);
  });

  it("fails when at least one check fails", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "Security", status: "COMPLETED", conclusion: "SUCCESS" }
    ]);

    assert.equal(result.passed, false);
    assert.deepEqual(result.failed, ["CI"]);
    assert.deepEqual(result.pending, []);
  });

  it("treats non-completed checks as pending", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "IN_PROGRESS", conclusion: null },
      { name: "Security", status: "COMPLETED", conclusion: "SUCCESS" }
    ]);

    assert.equal(result.passed, false);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pending, ["CI"]);
  });
});

describe("Athena pre-review hardening", () => {
  it("retries when Athena rejection indicates measurability/schema ambiguity", () => {
    const retry = shouldRetryAthenaPreReview({
      reason: "Acceptance criteria are not measurable and schema is undefined",
      issues: ["Missing deterministic enum for output status"]
    });

    assert.equal(retry, true);
  });

  it("does not retry for non-quality operational rejections", () => {
    const retry = shouldRetryAthenaPreReview({
      reason: "Repository write permissions are missing for protected path",
      issues: ["External approval required"]
    });

    assert.equal(retry, false);
  });

  it("appends deterministic hardening criteria and safe verification commands", () => {
    const task = {
      task_id: "T-099",
      title: "Test task",
      scope: "Update state serialization",
      acceptance_criteria: ["Existing criterion"],
      verification_commands: ["node --import tsx src/cli.ts once"]
    };

    const hardened = hardenTaskForAthena(task, {
      reason: "Criteria are untestable",
      issues: ["Missing schema"]
    });

    assert.ok(hardened.acceptance_criteria.length > task.acceptance_criteria.length);
    assert.ok(hardened.acceptance_criteria.some(c => c.includes("deterministic pass/fail evidence")));
    assert.ok(hardened.scope.includes("Athena hardening notes"));
    assert.deepEqual(hardened.verification_commands, ["node --import tsx src/cli.ts once", "npm test", "npm run lint"]);
  });
});

describe("Athena pre-review halt policy", () => {
  it("continues by default when pre-review is rejected", () => {
    assert.equal(shouldHaltOnPreReviewReject({ runtime: {} }), false);
    assert.equal(shouldHaltOnPreReviewReject({}), false);
  });

  it("halts only when explicitly enabled", () => {
    assert.equal(
      shouldHaltOnPreReviewReject({ runtime: { evolutionStopOnPreReviewReject: true } }),
      true
    );
  });
});

describe("Prometheus task repair", () => {
  it("repairs missing critical fields with deterministic defaults", () => {
    const repaired = repairPrometheusTask({
      task_id: "T-777",
      title: "",
      scope: "",
      acceptance_criteria: [],
      verification_commands: []
    });

    assert.equal(repaired.title, "T-777");
    assert.ok(repaired.scope.length > 0);
    assert.ok(repaired.acceptance_criteria.length >= 3);
    assert.ok(repaired.verification_commands.length > 0);
  });

  it("normalizes non-string entries and keeps commands runnable", () => {
    const repaired = repairPrometheusTask({
      task_id: "T-778",
      title: "task",
      scope: "scope",
      acceptance_criteria: ["criterion", null, 42],
      verification_commands: ["npm test", "", null]
    });

    assert.ok(repaired.acceptance_criteria.includes("criterion"));
    assert.ok(repaired.acceptance_criteria.includes("42"));
    assert.deepEqual(repaired.verification_commands, ["npm test"]);
  });
});

describe("Athena missing-item injection", () => {
  it("adds Athena issues into task scope and acceptance criteria", () => {
    const task = {
      task_id: "T-900",
      title: "Example",
      scope: "Base scope",
      acceptance_criteria: ["Existing criterion"],
      verification_commands: ["npm test"]
    };

    const updated = injectAthenaMissingItems(task, {
      reason: "reject",
      issues: ["Define outcome object schema", "Define reason code enum"]
    });

    assert.ok(updated.scope.includes("Athena missing items"));
    assert.ok(updated.scope.includes("Define outcome object schema"));
    assert.ok(updated.acceptance_criteria.some(c => c.includes("Athena missing item resolved")));
    assert.ok(updated.verification_commands.includes("npm run lint"));
  });

  it("falls back to reason text when issue list is missing", () => {
    const task = {
      task_id: "T-901",
      title: "Example",
      scope: "Base",
      acceptance_criteria: ["A"],
      verification_commands: ["npm test"]
    };

    const updated = injectAthenaMissingItems(task, {
      reason: "Need deterministic degraded state definition",
      issues: []
    });

    assert.ok(updated.scope.includes("Need deterministic degraded state definition"));
    assert.ok(updated.acceptance_criteria.some(c => c.includes("Need deterministic degraded state definition")));
  });
});

// ── Scope Conformance Gate (Task 7) ───────────────────────────────────────────

describe("checkScopeConformance", () => {
  it("passes when all touched files are within declared scope", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "tests/core/foo.test.ts"],
      ["src/core/foo.ts", "tests/core/foo.test.ts"]
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
    assert.equal(result.recoveryInstruction, "");
  });

  it("passes when touched file is under a declared directory prefix", () => {
    const result = checkScopeConformance(
      ["src/core/orchestrator.ts", "src/core/policy_engine.ts"],
      ["src/core/"]
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("blocks when an unrelated file is touched", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "src/dashboard/live_dashboard.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.ok(result.unrelatedFiles.includes("src/dashboard/live_dashboard.ts"));
    assert.ok(result.recoveryInstruction.includes("SCOPE VIOLATION"));
    assert.ok(result.recoveryInstruction.includes("git checkout"));
  });

  it("passes when no files_hint declared (cannot enforce without scope)", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "src/core/bar.ts"],
      []
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("passes when no files are touched", () => {
    const result = checkScopeConformance([], ["src/core/foo.ts"]);
    assert.equal(result.ok, true);
  });

  it("recovery instruction names all unrelated files", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "scripts/deploy.sh", "docker/Dockerfile"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.equal(result.unrelatedFiles.length, 2);
    assert.ok(result.recoveryInstruction.includes("scripts/deploy.sh"));
    assert.ok(result.recoveryInstruction.includes("docker/Dockerfile"));
  });

  it("handles Windows-style backslash paths in filesTouched", () => {
    const result = checkScopeConformance(
      ["src\\core\\foo.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, true, "backslash paths must be normalized for comparison");
  });

  it("negative: multiple unrelated files all appear in recoveryInstruction", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "README.md", "package.json", ".env"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.equal(result.unrelatedFiles.length, 3);
    for (const f of result.unrelatedFiles) {
      assert.ok(result.recoveryInstruction.includes(f), `recoveryInstruction must mention ${f}`);
    }
  });
});

// ── buildVerificationTargets — explicit verification evidence ─────────────────

describe("buildVerificationTargets", () => {
  it("maps each requested command to a target with cmd, passed, blocked fields", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm run lint"],
      [{ cmd: "npm test", passed: true }, { cmd: "npm run lint", passed: true }],
      []
    );
    assert.equal(targets.length, 2);
    for (const t of targets) {
      assert.ok("cmd" in t);
      assert.ok("passed" in t);
      assert.ok("blocked" in t);
    }
  });

  it("marks non-blocked commands as executed with their actual pass/fail result", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm run lint"],
      [{ cmd: "npm test", passed: true }, { cmd: "npm run lint", passed: false }],
      []
    );
    const testTarget = targets.find(t => t.cmd === "npm test")!;
    const lintTarget = targets.find(t => t.cmd === "npm run lint")!;
    assert.equal(testTarget.blocked, false);
    assert.equal(testTarget.passed, true);
    assert.equal(lintTarget.blocked, false);
    assert.equal(lintTarget.passed, false);
  });

  it("marks blocked commands with blocked=true and passed=false", () => {
    const targets = buildVerificationTargets(
      ["npm start", "npm test"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"]
    );
    const startTarget = targets.find(t => t.cmd === "npm start")!;
    const testTarget  = targets.find(t => t.cmd === "npm test")!;
    assert.equal(startTarget.blocked, true);
    assert.equal(startTarget.passed, false);
    assert.equal(testTarget.blocked, false);
    assert.equal(testTarget.passed, true);
  });

  it("appends fallback command when all task-named commands were blocked (negative path)", () => {
    const targets = buildVerificationTargets(
      ["npm start"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"],
      "npm test"
    );
    // Original blocked command
    const startTarget = targets.find(t => t.cmd === "npm start")!;
    assert.equal(startTarget.blocked, true);
    // Fallback command appended
    const fallbackTarget = targets.find(t => t.cmd === "npm test")!;
    assert.ok(fallbackTarget, "fallback command must appear in targets when all task commands blocked");
    assert.equal(fallbackTarget.blocked, false);
    assert.equal(fallbackTarget.passed, true);
  });

  it("does not append fallback when not all commands were blocked", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm start"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"],
      "npm test"
    );
    // npm test appears only once (as a requested command, not as a duplicate fallback)
    const testOccurrences = targets.filter(t => t.cmd === "npm test");
    assert.equal(testOccurrences.length, 1, "fallback must not duplicate an already-present target");
  });

  it("returns empty array for empty requested commands list", () => {
    const targets = buildVerificationTargets([], [], []);
    assert.deepEqual(targets, []);
  });
});

// ── inferVerificationFromFilesHint — specific verification inference ──────────

describe("inferVerificationFromFilesHint", () => {
  it("returns empty array for empty files_hint", () => {
    assert.deepEqual(inferVerificationFromFilesHint([]), []);
  });

  it("returns empty array when files_hint has no test files", () => {
    const result = inferVerificationFromFilesHint(["src/core/foo.ts", "src/core/bar.ts"]);
    assert.deepEqual(result, []);
  });

  it("returns node --test commands for test files in files_hint", () => {
    const result = inferVerificationFromFilesHint([
      "src/core/foo.ts",
      "tests/core/foo.test.ts",
      "tests/core/bar.test.ts",
    ]);
    assert.equal(result.length, 2);
    assert.ok(result[0].startsWith("node --test"));
    assert.ok(result[0].includes("foo.test.ts"));
    assert.ok(result[1].includes("bar.test.ts"));
  });

  it("caps results at 3 commands even with many test files", () => {
    const files = Array.from({ length: 5 }, (_, i) => `tests/core/file${i}.test.ts`);
    const result = inferVerificationFromFilesHint(files);
    assert.equal(result.length, 3);
  });

  it("only includes files matching .test. or .spec. pattern", () => {
    const result = inferVerificationFromFilesHint([
      "tests/core/foo.spec.ts",
      "src/core/bar.ts",
    ]);
    assert.equal(result.length, 1);
    assert.ok(result[0].includes("foo.spec.ts"));
  });
});

describe("repairPrometheusTask — specific verification inference", () => {
  it("injects specific verification commands when files_hint has test files and all commands are generic", () => {
    const task = {
      task_id: "T-001",
      title: "Add validation",
      files_hint: ["src/core/validator.ts", "tests/core/validator.test.ts"],
      verification_commands: [],
    };
    const repaired = repairPrometheusTask(task);
    const hasSpecific = repaired.verification_commands.some(cmd =>
      /validator\.test\.ts/.test(cmd)
    );
    assert.ok(hasSpecific, "repaired task should have a specific test command for validator.test.ts");
  });

  it("does not change verification_commands when they already contain specific targets", () => {
    const task = {
      task_id: "T-002",
      title: "Add validation",
      files_hint: ["src/core/validator.ts", "tests/core/validator.test.ts"],
      verification_commands: ["node --test tests/core/validator.test.ts"],
    };
    const repaired = repairPrometheusTask(task);
    // Should contain the specific command (not duplicated)
    const specificCount = repaired.verification_commands.filter(cmd =>
      /validator\.test\.ts/.test(cmd)
    ).length;
    assert.ok(specificCount >= 1, "specific command should be preserved");
  });
});

// ── buildVerificationEvidence — canonical slot mapping ────────────────────────

import { buildVerificationEvidence } from "../../src/core/evolution_executor.js";

describe("buildVerificationEvidence", () => {
  it("maps npm test to tests slot", () => {
    const ev = buildVerificationEvidence([{ cmd: "npm test", passed: true }]);
    assert.equal(ev.tests, "pass");
    assert.equal(ev.build, "n/a");
    assert.equal(ev.lint, "n/a");
  });

  it("maps node --test to tests slot", () => {
    const ev = buildVerificationEvidence([{ cmd: "node --test foo.test.ts", passed: false }]);
    assert.equal(ev.tests, "fail");
    assert.equal(ev.build, "n/a");
  });

  it("maps npm run build to build slot", () => {
    const ev = buildVerificationEvidence([{ cmd: "npm run build", passed: true }]);
    assert.equal(ev.build, "pass");
    assert.equal(ev.tests, "n/a");
    assert.equal(ev.lint, "n/a");
  });

  it("maps tsc to build slot", () => {
    const ev = buildVerificationEvidence([{ cmd: "tsc --noEmit", passed: false }]);
    assert.equal(ev.build, "fail");
  });

  it("maps npm run lint to lint slot", () => {
    const ev = buildVerificationEvidence([{ cmd: "npm run lint", passed: true }]);
    assert.equal(ev.lint, "pass");
    assert.equal(ev.build, "n/a");
    assert.equal(ev.tests, "n/a");
  });

  it("fail is sticky — one failure overrides a passing command in same slot", () => {
    const ev = buildVerificationEvidence([
      { cmd: "npm test", passed: true },
      { cmd: "node --test foo.test.ts", passed: false },
    ]);
    assert.equal(ev.tests, "fail");
  });

  it("all slots from mixed commands", () => {
    const ev = buildVerificationEvidence([
      { cmd: "npm run build", passed: true },
      { cmd: "npm test", passed: true },
      { cmd: "npm run lint", passed: false },
    ]);
    assert.equal(ev.build, "pass");
    assert.equal(ev.tests, "pass");
    assert.equal(ev.lint, "fail");
  });

  it("returns all n/a for empty input", () => {
    const ev = buildVerificationEvidence([]);
    assert.equal(ev.build, "n/a");
    assert.equal(ev.tests, "n/a");
    assert.equal(ev.lint, "n/a");
  });

  it("negative: partial failure — clean pass requires all slots green", () => {
    // Verify that a build-only run cannot satisfy the full green requirement
    const ev = buildVerificationEvidence([{ cmd: "npm run build", passed: true }]);
    const fullGreen = ev.build === "pass" && ev.tests === "pass";
    assert.equal(fullGreen, false, "tests slot is n/a, so full green must be false");
  });
});

// ── validateVerificationPortability — Task 2 ─────────────────────────────────

describe("validateVerificationPortability", () => {
  it("returns portable=true for canonical commands", () => {
    const result = validateVerificationPortability(["npm test", "npm run lint", "npm run build"]);
    assert.equal(result.portable, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.rewrites, []);
  });

  it("detects shell-glob node --test as non-portable", () => {
    const result = validateVerificationPortability(["node --test tests/**/*.test.ts"]);
    assert.equal(result.portable, false);
    assert.ok(result.violations.length > 0, "violation must be reported");
    assert.ok(result.violations[0].includes("Glob patterns"), "violation must mention glob");
  });

  it("detects bash script invocation as non-portable", () => {
    const result = validateVerificationPortability(["bash scripts/run_tests.sh"]);
    assert.equal(result.portable, false);
    assert.ok(result.violations.length > 0);
  });

  it("detects sh script invocation as non-portable", () => {
    const result = validateVerificationPortability(["sh run.sh"]);
    assert.equal(result.portable, false);
    assert.ok(result.violations.length > 0);
  });

  it("includes rewrite entry when command would be rewritten", () => {
    const result = validateVerificationPortability(["node --test tests/**/*.test.ts"]);
    assert.ok(result.rewrites.length > 0, "rewrite entry must be present for non-portable command");
    const rw = result.rewrites[0];
    assert.ok(typeof rw.original === "string");
    assert.ok(typeof rw.rewritten === "string");
    assert.ok(typeof rw.reason === "string");
    assert.ok(rw.rewritten !== rw.original, "rewritten must differ from original");
  });

  it("identifies specific commands (with test file reference) as hasSpecificTarget=true", () => {
    const result = validateVerificationPortability(["node --test tests/core/foo.test.ts"]);
    assert.equal(result.hasSpecificTarget, true);
    assert.ok(result.specificCommands.includes("node --test tests/core/foo.test.ts"));
  });

  it("marks generic-only commands as hasSpecificTarget=false", () => {
    const result = validateVerificationPortability(["npm test", "npm run lint"]);
    assert.equal(result.hasSpecificTarget, false);
    assert.deepEqual(result.specificCommands, []);
  });

  it("handles mixed portable and non-portable commands — reports all violations", () => {
    const result = validateVerificationPortability(["npm test", "bash scripts/test.sh"]);
    assert.equal(result.portable, false);
    assert.equal(result.violations.length, 1);
    assert.ok(result.violations[0].includes("bash"));
  });

  it("returns portable=true and empty arrays for empty input", () => {
    const result = validateVerificationPortability([]);
    assert.equal(result.portable, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.rewrites, []);
    assert.equal(result.hasSpecificTarget, false);
  });

  it("negative path: all forbidden commands produce portable=false with at least one violation each", () => {
    const cmds = [
      "node --test tests/**/*.test.ts",
      "bash scripts/deploy.sh",
      "sh run.sh",
    ];
    const result = validateVerificationPortability(cmds);
    assert.equal(result.portable, false);
    // Each command must produce at least one violation (node --test glob may produce 2)
    assert.ok(result.violations.length >= cmds.length,
      `Expected at least ${cmds.length} violations, got ${result.violations.length}`);
    assert.equal(result.rewrites.length, 3);
  });
});

// ── BLOCKED_VERIFICATION_CMDS — execution-time glob blocking (Task 1) ──────────

describe("BLOCKED_VERIFICATION_CMDS — execution-time glob blocking", () => {
  it("is a non-empty array of RegExp entries", () => {
    assert.ok(Array.isArray(BLOCKED_VERIFICATION_CMDS), "must be an array");
    assert.ok(BLOCKED_VERIFICATION_CMDS.length > 0, "must be non-empty");
    for (const entry of BLOCKED_VERIFICATION_CMDS) {
      assert.ok(entry instanceof RegExp, `every entry must be a RegExp, got: ${typeof entry}`);
    }
  });

  it("includes a pattern that blocks node --test with glob wildcards", () => {
    const globCmds = [
      "node --test tests/**/*.test.ts",
      "node --test tests/**/*.spec.ts",
      "node --test tests/**",
      "node --test src/**/*.test.ts",
    ];
    for (const cmd of globCmds) {
      assert.ok(
        BLOCKED_VERIFICATION_CMDS.some(re => re.test(cmd)),
        `BLOCKED_VERIFICATION_CMDS must block glob-based command: "${cmd}"`
      );
    }
  });

  it("does not block specific file-path node --test commands (no false positives)", () => {
    const specificCmds = [
      "node --test tests/core/foo.test.ts",
      "node --test tests/core/verification_gate.test.ts",
    ];
    for (const cmd of specificCmds) {
      assert.ok(
        !BLOCKED_VERIFICATION_CMDS.some(re => re.test(cmd)),
        `BLOCKED_VERIFICATION_CMDS must not block specific-file command: "${cmd}"`
      );
    }
  });

  it("negative path: canonical npm commands are not blocked", () => {
    const canonical = ["npm test", "npm run lint", "npm run build"];
    for (const cmd of canonical) {
      assert.ok(
        !BLOCKED_VERIFICATION_CMDS.some(re => re.test(cmd)),
        `canonical command must not be blocked: "${cmd}"`
      );
    }
  });
});

// ── buildScopeViolationRecoveryPlan — branch cleanliness recovery ─────────────

import { buildScopeViolationRecoveryPlan } from "../../src/core/evolution_executor.js";

describe("buildScopeViolationRecoveryPlan", () => {
  it("returns the unrelated files as filesToRecover", () => {
    const scopeCheck = {
      ok: false,
      unrelatedFiles: ["src/dashboard/live.ts", "scripts/deploy.sh"],
      recoveryInstruction: "SCOPE VIOLATION: ...",
    };
    const plan = buildScopeViolationRecoveryPlan(scopeCheck, "T-001");
    assert.deepEqual(plan.filesToRecover, ["src/dashboard/live.ts", "scripts/deploy.sh"]);
  });

  it("includes the task id in the recovery description", () => {
    const scopeCheck = {
      ok: false,
      unrelatedFiles: ["src/foo.ts"],
      recoveryInstruction: "SCOPE VIOLATION: ...",
    };
    const plan = buildScopeViolationRecoveryPlan(scopeCheck, "T-042");
    assert.ok(plan.recoveryDescription.includes("T-042"), "description must reference the task id");
  });

  it("returns empty filesToRecover and empty description when scopeCheck is clean (no unrelated files)", () => {
    const scopeCheck = {
      ok: true,
      unrelatedFiles: [],
      recoveryInstruction: "",
    };
    const plan = buildScopeViolationRecoveryPlan(scopeCheck, "T-999");
    assert.deepEqual(plan.filesToRecover, []);
    assert.equal(plan.recoveryDescription, "");
  });

  it("handles undefined taskId gracefully", () => {
    const scopeCheck = {
      ok: false,
      unrelatedFiles: ["src/extra.ts"],
      recoveryInstruction: "SCOPE VIOLATION: ...",
    };
    const plan = buildScopeViolationRecoveryPlan(scopeCheck, undefined);
    assert.ok(plan.recoveryDescription.includes("unknown"), "undefined taskId must produce 'unknown' in description");
  });

  it("negative: multiple unrelated files all appear in filesToRecover", () => {
    const unrelated = ["README.md", "package.json", ".env"];
    const scopeCheck = {
      ok: false,
      unrelatedFiles: unrelated,
      recoveryInstruction: "SCOPE VIOLATION: ...",
    };
    const plan = buildScopeViolationRecoveryPlan(scopeCheck, "T-007");
    assert.equal(plan.filesToRecover.length, 3);
    for (const f of unrelated) {
      assert.ok(plan.filesToRecover.includes(f), `filesToRecover must include ${f}`);
    }
  });
});
