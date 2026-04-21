import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import {
  buildLiveWorkerLogStamp,
  buildConversationContext,
  buildWorkerRuntimeLineage,
  formatLiveWorkerLogChunk,
  formatLiveWorkerLogStatefulChunk,
  parseWorkerResponse,
  extractStreamingWorkerResultMarker,
  shouldTreatAbortedWorkerRunAsTerminalResult,
  deriveDeterministicCleanTreeEvidence,
  ensureWorkerOutputClosureFields,
  resolveCleanTreeEvidenceTargets,
  inferWorkerReportedTaskScopedCleanTreeEvidence,
  detectRepoContamination,
  attemptBranchCleanlinessRecovery,
  shouldEnableFullToolAccess,
  evaluateWorkerRoleCapability,
  injectCiFailureContextIfMissing,
  applyMemoryTrustFilter,
  computeMemoryHitRatio,
  computePromptCacheRoutingSignal,
  computeFailureFinishRoutingSignal,
  deriveWorkerFinishCode,
  isTerminalWorkerStatus,
  resolveWorkerExecutionLineageId,
  shouldResolveRecoveredWorkerEscalations,
  extractWorkerViolationSummary,
} from "../../src/core/worker_runner.js";
import { isProcessAlive } from "../../src/core/daemon_control.js";
import { createVersionedCheckpointEnvelope } from "../../src/core/checkpoint_engine.js";
import { buildWorkerExecutionReportArtifact } from "../../src/core/evidence_envelope.js";
import { buildInterventionLineageTelemetry, buildRoutingROISummary } from "../../src/core/cycle_analytics.js";
import { appendPromptCacheTelemetry, appendFailureClassification } from "../../src/core/state_tracker.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";
import { TARGET_SESSION_STAGE } from "../../src/core/target_session_state.js";

const execFileAsync = promisify(execFile);

// ── parseWorkerResponse ──────────────────────────────────────────────────────

describe("parseWorkerResponse", () => {
  it("parses done status when BOX_STATUS=done", () => {
    const result = parseWorkerResponse("BOX_STATUS=done\nSome output", "");
    assert.equal(result.status, "done");
  });

  it("defaults to done when no BOX_STATUS marker is present", () => {
    const result = parseWorkerResponse("Worker completed the task successfully.", "");
    assert.equal(result.status, "done");
  });

  it("parses blocked status", () => {
    const result = parseWorkerResponse("BOX_STATUS=blocked\nCannot access repo", "");
    assert.equal(result.status, "blocked");
  });

  it("parses partial status", () => {
    const result = parseWorkerResponse("BOX_STATUS=partial", "");
    assert.equal(result.status, "partial");
  });

  it("promotes inspection-only partial output to done when all checks passed", () => {
    const stdout = [
      "The existing shadow artifact passes inspection as a simple static todo-list MVP.",
      "index.html — PASS",
      "style.css — PASS",
      "app.js — PASS",
      "README.md — PASS",
      "Because the only ordered work item was an inspection pass, I did not create a no-op PR.",
      "BOX_STATUS=partial",
      "BOX_ACCESS=repo:ok;files:ok;tools:ok;api:ok",
      "BOX_EXPECTED_OUTCOME=Inspect the artifact and emit PASS/FAIL checks.",
      "BOX_ACTUAL_OUTCOME=Completed an evidence-backed inspection with all checks passing.",
      "BOX_DEVIATION=minor",
      "===VERIFICATION_REPORT===",
      "BUILD=pass",
      "TESTS=pass",
      "EDGE_CASES=pass",
      "===END_VERIFICATION===",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "done");
  });

  it("keeps partial when inspection output contains an actual fail", () => {
    const stdout = [
      "The artifact failed inspection.",
      "index.html — PASS",
      "app.js — FAIL",
      "Because the only ordered work item was an inspection pass, I did not create a no-op PR.",
      "BOX_STATUS=partial",
      "BOX_EXPECTED_OUTCOME=Inspect the artifact and emit PASS/FAIL checks.",
      "BOX_ACTUAL_OUTCOME=Inspection found a failing app.js check.",
      "BOX_DEVIATION=major",
      "===VERIFICATION_REPORT===",
      "BUILD=pass",
      "TESTS=pass",
      "EDGE_CASES=pass",
      "===END_VERIFICATION===",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "partial");
  });

  it("normalizes already-completed partial output to skipped", () => {
    const stdout = [
      "BOX_STATUS=partial",
      "BOX_SKIP_REASON=already-merged",
      "BOX_BLOCKER=Task was already completed in a prior wave via merged PR #2",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "skipped");
    assert.equal(result.skipReason, "already-merged");
  });

  it("parses error status", () => {
    const result = parseWorkerResponse("", "fatal: not a git repository\nBOX_STATUS=error");
    assert.equal(result.status, "error");
  });

  it("normalizes unknown status values to done", () => {
    const result = parseWorkerResponse("BOX_STATUS=complete", "");
    assert.equal(result.status, "done");
  });

  it("extracts BOX_PR_URL", () => {
    const result = parseWorkerResponse("BOX_PR_URL=https://github.com/org/repo/pull/42", "");
    assert.equal(result.prUrl, "https://github.com/org/repo/pull/42");
  });

  it("returns null prUrl when marker is absent", () => {
    const result = parseWorkerResponse("No PR in this output", "");
    assert.equal(result.prUrl, null);
  });

  it("extracts BOX_BRANCH", () => {
    const result = parseWorkerResponse("BOX_BRANCH=box/feature-auth", "");
    assert.equal(result.currentBranch, "box/feature-auth");
  });

  it("extracts BOX_FILES_TOUCHED as array", () => {
    const result = parseWorkerResponse("BOX_FILES_TOUCHED=src/a.js,src/b.js, src/c.js", "");
    assert.deepEqual(result.filesTouched, ["src/a.js", "src/b.js", "src/c.js"]);
  });

  it("returns empty filesTouched when marker is absent", () => {
    const result = parseWorkerResponse("No files mentioned", "");
    assert.deepEqual(result.filesTouched, []);
  });

  // BOX_ACCESS blocked guardrail — access-blocked output must force status=blocked
  // even if the worker self-reports BOX_STATUS=done. This prevents silent swallowing
  // of blocked access states.
  it("forces status=blocked when BOX_ACCESS reports blocked fields", () => {
    const stdout = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok",
      "I completed the task"
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "blocked",
      "Worker self-reporting done must be overridden when access is blocked");
  });

  it("does not override status when BOX_ACCESS reports all ok", () => {
    const stdout = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:ok;api:ok"
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "done");
  });

  it("does not override status=blocked when BOX_ACCESS also blocked", () => {
    const stdout = "BOX_STATUS=blocked\nBOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok";
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "blocked");
  });

  it("extracts explicit dispatch block reason from BOX_BLOCKER", () => {
    const stdout = "BOX_STATUS=blocked\nBOX_BLOCKER=governance_freeze_active:manual_freeze";
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.dispatchBlockReason, "governance_freeze_active:manual_freeze");
  });

  it("flags unsupported upstream-only CI deferrals for red PRs", () => {
    const stdout = [
      "BOX_STATUS=partial",
      "BOX_PR_URL=https://github.com/org/repo/pull/42",
      "CI failed on the PR, so I'm pulling the workflow logs.",
      "Merge is blocked upstream, not by this change.",
      "The latest main CI run fails with the same assertions.",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "partial");
    assert.equal(result.dispatchBlockReason, "unsupported_upstream_ci_deferral");
    assert.equal(result.unsupportedUpstreamCiDeferral, true);
  });

  it("derives dispatch block reason from BOX_ACCESS blocked scopes when BOX_BLOCKER is absent", () => {
    const stdout = "BOX_STATUS=done\nBOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok";
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "blocked");
    assert.equal(result.dispatchBlockReason, "access_blocked:repo");
  });

  it("includes VERIFICATION_REPORT in verificationReport field", () => {
    const stdout = "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=n/a; API=n/a; EDGE_CASES=pass; SECURITY=pass";
    const result = parseWorkerResponse(stdout, "");
    assert.ok(result.verificationReport, "verificationReport should be populated");
    assert.equal(result.verificationReport.build, "pass");
    assert.equal(result.verificationReport.tests, "pass");
  });

  it("sets verificationReport to null when no VERIFICATION_REPORT marker is present", () => {
    const result = parseWorkerResponse("Task complete. No report.", "");
    assert.equal(result.verificationReport, null);
  });

  it("parses canonical block-style VERIFICATION_REPORT", () => {
    const stdout = [
      "===VERIFICATION_REPORT===",
      "BUILD=pass",
      "TESTS=pass",
      "EDGE_CASES=pass",
      "===END_VERIFICATION===",
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.ok(result.verificationReport);
    assert.equal(result.verificationReport.build, "pass");
    assert.equal(result.verificationReport.tests, "pass");
  });

  it("extracts CLEAN_TREE_STATUS evidence marker", () => {
    const result = parseWorkerResponse("CLEAN_TREE_STATUS=clean", "");
    assert.equal(result.cleanTreeStatus, true);
  });

  it("negative: cleanTreeStatus=false when marker is absent", () => {
    const result = parseWorkerResponse("No clean tree marker here", "");
    assert.equal(result.cleanTreeStatus, false);
  });

  it("keeps verificationReport null when VERIFICATION_REPORT block is malformed", () => {
    const stdout = "===VERIFICATION_REPORT===\nnot-a-report\n===END_VERIFICATION===";
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.verificationReport, null);
  });

  it("returns non-empty summary from stdout", () => {
    const result = parseWorkerResponse("I fixed the bug in src/auth.js", "");
    assert.ok(result.summary.length > 0);
  });

  it("returns fullOutput equal to raw stdout", () => {
    const raw = "BOX_STATUS=done\nSome text";
    const result = parseWorkerResponse(raw, "");
    assert.equal(result.fullOutput, raw);
  });
});

describe("target-aware worker live log formatting", () => {
  it("moves worker metadata to a compact suffix while preserving target context", () => {
    const config = {
      platformModeState: {
        currentMode: "single_target_delivery",
      },
      activeTargetSession: {
        projectId: "target_portal",
        sessionId: "sess_123",
      },
    };

    const stamp = buildLiveWorkerLogStamp(config, "integration-worker");
    const formatted = formatLiveWorkerLogChunk(config, "integration-worker", "line one\nline two\n");
    const lines = formatted.trim().split("\n");

    assert.equal(stamp, "[mode=target]");
    assert.ok(lines[0].startsWith("line one"));
    assert.ok(lines[1].startsWith("line two"));
    assert.ok(lines[0].endsWith("[mode=target]"));
    assert.ok(lines[1].endsWith("[mode=target]"));
  });

  it("buffers tokenized stream chunks until a readable sentence is available", () => {
    const config = {
      platformModeState: {
        currentMode: "single_target_delivery",
      },
      activeTargetSession: {
        projectId: "target_portal",
        sessionId: "sess_123",
      },
    };

    const first = formatLiveWorkerLogStatefulChunk(config, "quality-worker", "The command appears", "");
    const second = formatLiveWorkerLogStatefulChunk(config, "quality-worker", " to be hanging", first.remainder);
    const third = formatLiveWorkerLogStatefulChunk(config, "quality-worker", " after 300 seconds.", second.remainder);

    assert.equal(first.formatted, "");
    assert.equal(second.formatted, "");
    assert.equal(third.remainder, "");
    assert.ok(third.formatted.includes("The command appears to be hanging after 300 seconds."));
    assert.ok(third.formatted.includes("[mode=target]"));
    assert.ok(!third.formatted.includes("quality-worker"));
  });

  it("does not emit metadata-only lines for blank log chunks", () => {
    const config = {
      platformModeState: {
        currentMode: "single_target_delivery",
      },
      activeTargetSession: {
        projectId: "target_portal",
        sessionId: "sess_123",
      },
    };

    const formatted = formatLiveWorkerLogChunk(config, "quality-worker", "\n");
    assert.equal(formatted, "");
  });

  it("keeps tool command detail lines plain while showing mode on action headers", () => {
    const config = {
      platformModeState: {
        currentMode: "single_target_delivery",
      },
      activeTargetSession: {
        projectId: "target_portal",
        sessionId: "sess_123",
      },
    };

    const formatted = formatLiveWorkerLogChunk(config, "quality-worker", "● Run test (shell)\n  │ npm test\n  └ 4 lines...\n");
    const lines = formatted.trim().split("\n");

    assert.ok(lines[0].endsWith("[mode=target]"));
    assert.equal(lines[1], "  │ npm test");
    assert.equal(lines[2], "  └ 4 lines...");
  });
});

describe("extractStreamingWorkerResultMarker", () => {
  it("returns null before terminal verification evidence appears", () => {
    const marker = extractStreamingWorkerResultMarker("BOX_STATUS=partial\nStill writing...", "");
    assert.equal(marker, null);
  });

  it("does not emit a marker from BOX_PR_URL alone before verification output completes", () => {
    const stdout = [
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/org/repo/pull/42",
      "BOX_EXPECTED_OUTCOME=join keys propagated",
      "BOX_ACTUAL_OUTCOME=runner and analytics updated",
    ].join("\n");
    const marker = extractStreamingWorkerResultMarker(stdout, "");
    assert.equal(marker, null);
  });

  it("does not emit a marker from a verification template without parsed evidence", () => {
    const stdout = [
      "BOX_STATUS=done",
      "3. Include a complete VERIFICATION_REPORT in your response using this exact block template:",
      "===VERIFICATION_REPORT===",
      "BUILD=<pass|fail|n/a>",
      "TESTS=<pass|fail|n/a>",
      "===END_VERIFICATION===",
    ].join("\n");
    const marker = extractStreamingWorkerResultMarker(stdout, "");
    assert.equal(marker, null);
  });

  it("emits a marker once BOX_STATUS and verification boundary are present", () => {
    const stdout = [
      "BOX_MERGED_SHA=abc123d",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 5",
      "# pass 5",
      "# fail 0",
      "===NPM TEST OUTPUT END===",
      "===VERIFICATION_REPORT===",
      "BUILD=pass",
      "TESTS=pass",
      "===END_VERIFICATION===",
      "BOX_STATUS=partial",
    ].join("\n");
    const marker = extractStreamingWorkerResultMarker(stdout, "");
    assert.deepEqual(marker, { status: "partial", prUrl: null });
  });

  it("uses normalized parsed status when access evidence forces a block", () => {
    const stdout = [
      "BOX_ACCESS=repo:ok;files:ok;tools:blocked;api:ok",
      "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=n/a; API=pass; EDGE_CASES=pass; SECURITY=n/a",
      "BOX_STATUS=done",
    ].join("\n");
    const marker = extractStreamingWorkerResultMarker(stdout, "");
    assert.deepEqual(marker, { status: "blocked", prUrl: null });
  });
});

describe("shouldTreatAbortedWorkerRunAsTerminalResult", () => {
  it("accepts an aborted process when final worker markers were already emitted", () => {
    const stdout = [
      "BOX_MERGED_SHA=abc123d",
      "CLEAN_TREE_STATUS=clean",
      "===NPM TEST OUTPUT START===",
      "# tests 5",
      "# pass 5",
      "# fail 0",
      "===NPM TEST OUTPUT END===",
      "===VERIFICATION_REPORT===",
      "BUILD=pass",
      "TESTS=pass",
      "===END_VERIFICATION===",
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/org/repo/pull/42",
    ].join("\n");

    const marker = shouldTreatAbortedWorkerRunAsTerminalResult(
      {
        aborted: true,
        stderr: "[BOX] Post-final-output grace expired after 30000ms",
      },
      stdout,
      "[BOX] Post-final-output grace expired after 30000ms",
    );

    assert.deepEqual(marker, {
      status: "done",
      prUrl: "https://github.com/org/repo/pull/42",
    });
  });

  it("rejects aborted processes that never emitted a terminal worker result", () => {
    const marker = shouldTreatAbortedWorkerRunAsTerminalResult(
      {
        aborted: true,
        stderr: "[BOX] Post-final-output grace expired after 30000ms",
      },
      "BOX_STATUS=done\nStill streaming",
      "[BOX] Post-final-output grace expired after 30000ms",
    );

    assert.equal(marker, null);
  });
});

describe("deriveDeterministicCleanTreeEvidence", () => {
  it("returns global clean evidence when repo status is empty", () => {
    const result = deriveDeterministicCleanTreeEvidence("", "", ["src/core/orchestrator.ts"]);
    assert.equal(result.mode, "global");
    assert.deepEqual(result.lines, ["CLEAN_TREE_STATUS=clean"]);
  });

  it("returns task-scoped clean evidence when repo is dirty but task targets are clean", () => {
    const result = deriveDeterministicCleanTreeEvidence(
      " M state/progress.txt\n",
      "",
      ["src/core/orchestrator.ts", "tests/core/orchestrator_runtime_contracts.test.ts"],
    );
    assert.equal(result.mode, "task-scoped");
    assert.deepEqual(result.lines, [
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/orchestrator.ts, tests/core/orchestrator_runtime_contracts.test.ts",
    ]);
  });

  it("returns none when repo and task targets are both dirty", () => {
    const result = deriveDeterministicCleanTreeEvidence(
      " M state/progress.txt\n M src/core/orchestrator.ts\n",
      " M src/core/orchestrator.ts\n",
      ["src/core/orchestrator.ts"],
    );
    assert.equal(result.mode, "none");
    assert.deepEqual(result.lines, []);
  });
});

describe("resolveCleanTreeEvidenceTargets", () => {
  it("intersects BOX_FILES_TOUCHED with instruction targetFiles when worker output includes incidental files", () => {
    const result = resolveCleanTreeEvidenceTargets(
      {
        filesTouched: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
          "state/benchmark_ground_truth.json",
        ],
      },
      {
        targetFiles: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
          "tests/core/orchestrator_pipeline_progress.test.ts",
        ],
      },
    );

    assert.deepEqual(result, [
      "src/core/doctor.ts",
      "src/core/orchestrator.ts",
    ]);
  });

  it("prefers BOX_FILES_TOUCHED over broad instruction targetFiles", () => {
    const result = resolveCleanTreeEvidenceTargets(
      {
        filesTouched: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
        ],
      },
      {
        targetFiles: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
          "tests/core/orchestrator_pipeline_progress.test.ts",
        ],
      },
    );

    assert.deepEqual(result, [
      "src/core/doctor.ts",
      "src/core/orchestrator.ts",
    ]);
  });

  it("falls back to instruction targetFiles when filesTouched is empty", () => {
    const result = resolveCleanTreeEvidenceTargets(
      { filesTouched: [] },
      {
        targetFiles: [
          "src/core/orchestrator.ts",
          "tests/core/orchestrator_runtime_contracts.test.ts",
        ],
      },
    );

    assert.deepEqual(result, [
      "src/core/orchestrator.ts",
      "tests/core/orchestrator_runtime_contracts.test.ts",
    ]);
  });
});

describe("inferWorkerReportedTaskScopedCleanTreeEvidence", () => {
  it("synthesizes task-scoped clean-tree evidence from worker-reported merged output", () => {
    const result = inferWorkerReportedTaskScopedCleanTreeEvidence(
      {
        status: "done",
        mergedSha: "abc1234",
        filesTouched: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
          "state/benchmark_ground_truth.json",
        ],
      },
      {
        targetFiles: [
          "src/core/doctor.ts",
          "src/core/orchestrator.ts",
        ],
      },
    );

    assert.equal(result.mode, "task-scoped");
    assert.deepEqual(result.lines, [
      "CLEAN_TREE_STATUS=dirty-other-tasks-only",
      "TASK_SCOPED_CLEAN_STATUS=clean",
      "TASK_SCOPED_CLEAN_TARGETS=src/core/doctor.ts, src/core/orchestrator.ts",
    ]);
  });

  it("returns none when worker completion is not merged", () => {
    const result = inferWorkerReportedTaskScopedCleanTreeEvidence(
      {
        status: "done",
        mergedSha: "",
        filesTouched: ["src/core/doctor.ts"],
      },
      {
        targetFiles: ["src/core/doctor.ts"],
      },
    );

    assert.equal(result.mode, "none");
    assert.deepEqual(result.lines, []);
  });

  it("returns none for non-terminal worker outcomes even when merged metadata exists", () => {
    const result = inferWorkerReportedTaskScopedCleanTreeEvidence(
      {
        status: "partial",
        mergedSha: "abc1234",
        filesTouched: ["src/core/doctor.ts"],
      },
      {
        targetFiles: ["src/core/doctor.ts"],
      },
    );

    assert.equal(result.mode, "none");
    assert.deepEqual(result.lines, []);
  });
});

describe("isTerminalWorkerStatus", () => {
  it("treats recovery artifact status as terminal", () => {
    assert.equal(isTerminalWorkerStatus("recovered"), true);
  });

  it("negative path: leaves active statuses non-terminal", () => {
    assert.equal(isTerminalWorkerStatus("working"), false);
  });
});

describe("shouldResolveRecoveredWorkerEscalations", () => {
  it("returns true for recovered terminal outcomes", () => {
    assert.equal(shouldResolveRecoveredWorkerEscalations("done"), true);
    assert.equal(shouldResolveRecoveredWorkerEscalations("partial"), true);
    assert.equal(shouldResolveRecoveredWorkerEscalations("skipped"), true);
  });

  it("negative path: does not resolve on active failure outcomes", () => {
    assert.equal(shouldResolveRecoveredWorkerEscalations("blocked"), false);
    assert.equal(shouldResolveRecoveredWorkerEscalations("error"), false);
    assert.equal(shouldResolveRecoveredWorkerEscalations("transient_error"), false);
  });
});

describe("tool access + capability guards", () => {
  it("grants full tools for Athena postmortem/review work even with drifted taskKind label", () => {
    const allowAll = shouldEnableFullToolAccess("quality-worker", "audit-followup", "Run Athena postmortem review on latest cycle");
    assert.equal(allowAll, true);
  });

  it("grants full tools to registered specialist workers even when taskKind is not implementation", () => {
    const allowAll = shouldEnableFullToolAccess("infrastructure-worker", "observation", "Collect dashboard screenshots");
    assert.equal(allowAll, true);
  });

  it("keeps least-privilege defaults for non-worker non-review roles", () => {
    const allowAll = shouldEnableFullToolAccess("prometheus", "observation", "Collect dashboard screenshots");
    assert.equal(allowAll, false);
  });

  it("blocks unknown roles before worker invocation", () => {
    const check = evaluateWorkerRoleCapability({}, "unknown-worker", "athena-review", "Review dispatch failures");
    assert.equal(check.allowed, false);
    assert.equal(check.code, "ROLE_NOT_REGISTERED");
  });

  it("worker prompt no longer asks for TOOL_INTENT or HOOK_DECISION pseudo-telemetry", () => {
    const prompt = buildConversationContext(
      [],
      {
        task: "Collect dashboard screenshots",
        taskKind: "observation",
        context: "Use the dashboard and save evidence.",
      },
      {},
      {
        env: { targetRepo: "test/repo" },
        paths: { stateDir: path.join(os.tmpdir(), "box-worker-runner-prompt-test") },
      },
      "infrastructure",
      {},
    );

    assert.ok(prompt.includes("Do not print TOOL_INTENT or HOOK_DECISION pseudo-telemetry lines in your response."));
    assert.ok(!prompt.includes("Before every execute tool call, emit one explicit tool-intent envelope:"));
    assert.ok(!prompt.includes("[TOOL_INTENT] scope=<repo-path-or-subsystem> intent=<goal> impact=<low|medium|high|critical> clearance=<read|write|admin>"));
  });

  it("worker prompt still requires closure evidence for observation tasks", () => {
    const prompt = buildConversationContext(
      [],
      {
        task: "Run install and verify the CLI help output.",
        taskKind: "observation",
        verification: "1. npm install\n2. npm run build\n3. node dist/index.js --help",
      },
      {},
      {
        env: { targetRepo: "test/repo" },
        paths: { stateDir: path.join(os.tmpdir(), "box-worker-runner-prompt-test") },
      },
      "quality",
      {},
    );

    assert.ok(prompt.includes("BOX_EXPECTED_OUTCOME=<one-line: what this task was supposed to achieve>"));
    assert.ok(prompt.includes("BOX_ACTUAL_OUTCOME=<one-line: what was actually done/delivered>"));
    assert.ok(prompt.includes("BOX_DEVIATION=none|minor|major"));
    assert.ok(!prompt.includes("BOX_MERGED_SHA=<actual sha>"));
  });

  it("synthesizes missing closure evidence for successful observation runs", () => {
    const result = ensureWorkerOutputClosureFields(
      [
        "BOX_STATUS=done",
        "===VERIFICATION_REPORT===",
        "BUILD=pass",
        "TESTS=pass",
        "===END_VERIFICATION===",
      ].join("\n"),
      {
        task: "Verify install, typecheck, build, and CLI help output.",
        taskKind: "observation",
      },
      {
        status: "done",
        summary: "Completed install, typecheck, build, and CLI help verification.",
        verificationReport: { build: "pass", tests: "pass" },
      },
    );

    assert.equal(result.valid, true);
    assert.equal(result.synthesized, true);
    assert.ok(result.output.includes("BOX_EXPECTED_OUTCOME=Verify install, typecheck, build, and CLI help output."));
    assert.ok(result.output.includes("BOX_ACTUAL_OUTCOME=Completed install, typecheck, build, and CLI help verification."));
    assert.ok(result.output.includes("BOX_DEVIATION=none"));
  });

  it("worker prompt forbids upstream-only deferrals for red PRs", () => {
    const prompt = buildConversationContext(
      [],
      {
        task: "Repair a red PR by investigating its failing checks and shipping the fix.",
        taskKind: "implementation",
        verification: "1. npm test -- tests/core/worker_runner.test.ts",
        targetFiles: ["src/core/worker_runner.ts", "tests/core/worker_runner.test.ts"],
      },
      {},
      {
        env: { targetRepo: "test/repo" },
        paths: { stateDir: path.join(os.tmpdir(), "box-worker-runner-prompt-test") },
      },
      "quality",
      {},
    );

    assert.ok(prompt.includes("A red PR is NOT resolved by saying main is red too."));
    assert.ok(prompt.includes("reproduce the failing branch check"));
  });

  it("worker prompt adds a final placeholder self-check before done responses", () => {
    const prompt = buildConversationContext(
      [],
      {
        task: "Patch verification handling in src/core/worker_runner.ts and update tests.",
        taskKind: "implementation",
        verification: "1. npm test -- tests/core/worker_runner.test.ts",
        targetFiles: ["src/core/worker_runner.ts", "tests/core/worker_runner.test.ts"],
      },
      {},
      {
        env: { targetRepo: "test/repo" },
        paths: { stateDir: path.join(os.tmpdir(), "box-worker-runner-prompt-test") },
      },
      "quality",
      {},
    );

    assert.ok(prompt.includes("Before you send your final answer, do one last literal self-check on your draft."));
    assert.ok(prompt.includes("BOX_MERGED_SHA=<sha>"));
    assert.ok(prompt.includes("<pass|fail|n/a>"));
    assert.ok(prompt.includes("<paste full raw npm test stdout here>"));
    assert.ok(prompt.includes("POST_MERGE_TEST_OUTPUT"));
    assert.ok(prompt.includes("Do NOT copy instructional examples verbatim into your final evidence block."));
  });

  it("worker prompt includes scored candidate first moves for bounded deliberation", () => {
    const prompt = buildConversationContext(
      [],
      {
        task: "Replace linear retry behavior in worker_runner and keep tests deterministic.",
        taskKind: "implementation",
        targetFiles: ["src/core/worker_runner.ts", "tests/core/worker_runner.test.ts"],
      },
      {},
      {
        env: { targetRepo: "test/repo" },
        paths: { stateDir: path.join(os.tmpdir(), "box-worker-runner-prompt-test") },
      },
      "quality",
      {
        deliberationMode: "multi-attempt",
        searchBudget: 3,
        uncertaintyLevel: "high",
        recommendedFirstMove: {
          key: "smallest_verification",
          summary: "Run the smallest relevant verification slice to confirm the first failing surface.",
          rationale: "Cheap verification evidence should anchor the first move before deeper implementation work.",
          cheapSignals: ["sampleCount=1 below threshold 6", "attemptRate=0.00 below 0.7"],
          signalScores: {
            uncertaintyReduction: 0.95,
            cheapVerification: 0.95,
            executionLeverage: 0.85,
          },
          score: 0.925,
        },
        candidateFirstMoves: [
          {
            key: "smallest_verification",
            summary: "Run the smallest relevant verification slice to confirm the first failing surface.",
            rationale: "Cheap verification evidence should anchor the first move before deeper implementation work.",
            cheapSignals: ["sampleCount=1 below threshold 6", "attemptRate=0.00 below 0.7"],
            signalScores: {
              uncertaintyReduction: 0.95,
              cheapVerification: 0.95,
              executionLeverage: 0.85,
            },
            score: 0.925,
          },
          {
            key: "contract_scan",
            summary: "Inspect the task contract, target files, and nearest tests before deeper execution.",
            rationale: "Thin evidence or weak precision favors a cheap contract pass before choosing an edit path.",
            cheapSignals: ["precisionOnAttempted=0.10 below 0.65"],
            signalScores: {
              uncertaintyReduction: 0.75,
              cheapVerification: 0.95,
              executionLeverage: 0.75,
            },
            score: 0.82,
          },
        ],
      },
    );

    assert.ok(prompt.includes("Uncertainty classification: high."));
    assert.ok(prompt.includes("Recommended first move: Run the smallest relevant verification slice to confirm the first failing surface."));
    assert.ok(prompt.includes("Candidate first moves scored with cheap verification signals:"));
    assert.ok(prompt.includes("[score=0.925]"));
    assert.ok(prompt.includes("cheap signals: sampleCount=1 below threshold 6; attemptRate=0.00 below 0.7"));
  });
});

// ── detectRepoContamination ──────────────────────────────────────────────────

describe("detectRepoContamination", () => {
  it("returns isContamination=false when summary is clean and no scope declared", () => {
    const result = detectRepoContamination("All good, task complete.", [], []);
    assert.equal(result.isContamination, false);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("returns isContamination=true when summary contains SCOPE VIOLATION marker", () => {
    const result = detectRepoContamination("SCOPE VIOLATION: 1 file modified outside scope.", [], []);
    assert.equal(result.isContamination, true);
  });

  it("returns isContamination=true when summary contains 'unrelated file'", () => {
    const result = detectRepoContamination("Worker touched unrelated file src/foo.ts", [], []);
    assert.equal(result.isContamination, true);
  });

  it("returns isContamination=true when summary contains 'git checkout --'", () => {
    const result = detectRepoContamination("Recovery: revert with git checkout -- src/bar.ts", [], []);
    assert.equal(result.isContamination, true);
  });

  it("returns unrelatedFiles when touched files fall outside declared scope", () => {
    const result = detectRepoContamination(
      "Task done.",
      ["src/core/foo.ts", "src/dashboard/live.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.isContamination, true);
    assert.ok(result.unrelatedFiles.includes("src/dashboard/live.ts"));
    assert.ok(!result.unrelatedFiles.includes("src/core/foo.ts"));
  });

  it("returns isContamination=false when all touched files are within scope", () => {
    const result = detectRepoContamination(
      "Task done.",
      ["src/core/foo.ts", "tests/core/foo.test.ts"],
      ["src/core/foo.ts", "tests/core/foo.test.ts"]
    );
    assert.equal(result.isContamination, false);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("returns isContamination=false when no files_hint declared (cannot enforce)", () => {
    const result = detectRepoContamination(
      "Task done.",
      ["src/core/foo.ts", "src/dashboard/live.ts"],
      []
    );
    assert.equal(result.isContamination, false);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("normalizes Windows backslash paths when checking scope", () => {
    const result = detectRepoContamination(
      "Task done.",
      ["src\\core\\foo.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.isContamination, false, "backslash paths must be normalized for scope check");
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("negative: clean summary with no unrelated files returns false", () => {
    const result = detectRepoContamination(
      "Build passed, PR created.",
      ["src/core/orchestrator.ts", "tests/core/orchestrator.test.ts"],
      ["src/core/orchestrator.ts", "tests/core/orchestrator.test.ts"]
    );
    assert.equal(result.isContamination, false);
  });
});

// ── attemptBranchCleanlinessRecovery ────────────────────────────────────────

describe("attemptBranchCleanlinessRecovery", () => {
  it("returns recovered=true immediately when no files are specified", async () => {
    const result = await attemptBranchCleanlinessRecovery({}, [], 2);
    assert.equal(result.recovered, true);
    assert.equal(result.attemptsMade, 0);
    assert.deepEqual(result.errors, []);
  });

  it("returns recovered=true when filesToRecover is null-like (empty array)", async () => {
    const result = await attemptBranchCleanlinessRecovery({}, null as unknown as string[], 2);
    assert.equal(result.recovered, true);
    assert.equal(result.attemptsMade, 0);
  });

  it("returns a result object with the expected shape", async () => {
    // Non-empty file list will fail (git not in a repo here), but shape must be correct
    const result = await attemptBranchCleanlinessRecovery({}, ["non_existent_file.ts"], 1);
    assert.ok("recovered" in result, "result must have recovered field");
    assert.ok("attemptsMade" in result, "result must have attemptsMade field");
    assert.ok("errors" in result, "result must have errors field");
    assert.ok(Array.isArray(result.errors), "errors must be an array");
    // With a non-existent file, git will fail — recovered should be false
    assert.equal(result.recovered, false);
    assert.equal(result.attemptsMade, 1);
  });

  it("negative: exhausts maxAttempts without giving up early", async () => {
    const result = await attemptBranchCleanlinessRecovery({}, ["missing_file_1.ts", "missing_file_2.ts"], 2);
    // Both attempts should be made since files cannot be recovered
    assert.equal(result.attemptsMade, 2);
    assert.equal(result.recovered, false);
  });

  it("uses the isolated target workspace cwd in single-target mode", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-worker-recovery-"));
    const boxRoot = path.join(tempRoot, "box-root");
    const targetWorkspace = path.join(tempRoot, "target-workspace");
    const previousCwd = process.cwd();

    try {
      await fs.mkdir(boxRoot, { recursive: true });
      await fs.mkdir(targetWorkspace, { recursive: true });
      process.chdir(boxRoot);

      await execFileAsync("git", ["init"], { cwd: targetWorkspace });
      await execFileAsync("git", ["config", "user.email", "box@example.com"], { cwd: targetWorkspace });
      await execFileAsync("git", ["config", "user.name", "BOX Test"], { cwd: targetWorkspace });

      const trackedFile = path.join(targetWorkspace, "tracked.txt");
      await fs.writeFile(trackedFile, "original\n", "utf8");
      await execFileAsync("git", ["add", "tracked.txt"], { cwd: targetWorkspace });
      await execFileAsync("git", ["commit", "-m", "init"], { cwd: targetWorkspace });

      await fs.writeFile(trackedFile, "modified\n", "utf8");

      const config = {
        rootDir: boxRoot,
        selfDev: {
          futureModeFlags: {
            singleTargetDelivery: true,
            targetSessionState: true,
            targetWorkspaceLifecycle: true,
          },
        },
        platformModeState: {
          currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        },
        activeTargetSession: {
          currentStage: TARGET_SESSION_STAGE.SHADOW,
          workspace: {
            path: targetWorkspace,
          },
          gates: {
            allowShadowExecution: true,
            allowActiveExecution: false,
          },
        },
      };

      const result = await attemptBranchCleanlinessRecovery(config, ["tracked.txt"], 1);
      const recoveredContent = await fs.readFile(trackedFile, "utf8");

      assert.equal(result.recovered, true);
      assert.equal(recoveredContent.replace(/\r\n/g, "\n"), "original\n");
    } finally {
      process.chdir(previousCwd);
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

// ── daemon-control: isProcessAlive ──────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true for the current process pid", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for pid 0", () => {
    assert.equal(isProcessAlive(0), false);
  });

  it("returns false for a negative pid", () => {
    assert.equal(isProcessAlive(-1), false);
  });

  it("returns false for a non-numeric value", () => {
    assert.equal(isProcessAlive("not-a-pid"), false);
  });

  it("returns false for a pid that does not exist (very high number)", () => {
    // PID 9999999 is astronomically unlikely to be a real process
    assert.equal(isProcessAlive(9999999), false);
  });
});

// ── injectCiFailureContextIfMissing ──────────────────────────────────────────

describe("injectCiFailureContextIfMissing", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-worker-ci-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("skips injection when CI_FAILURE_CONTEXT already present", async () => {
    const instruction = { task: "fix ci", context: "## CI_FAILURE_CONTEXT\nalready present" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir } });
    assert.equal(result.context, instruction.context, "must not double-inject");
  });

  it("injects from npm_test_full.log when available", async () => {
    await fs.writeFile(path.join(stateDir, "npm_test_full.log"), "FAIL tests/core/auth.test.ts\nError: bad", "utf8");
    const instruction = { task: "fix ci", context: "" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir } });
    assert.ok(String(result.context).includes("## CI_FAILURE_CONTEXT"));
    assert.ok(String(result.context).includes("worker_runner_fallback:npm_test_full.log"));
  });

  it("falls back through artifact priority order", async () => {
    // Only test_run.log available
    await fs.writeFile(path.join(stateDir, "test_run.log"), "FAIL tests/core/runner.test.ts\nTypeError: x", "utf8");
    const instruction = { task: "fix ci", context: "" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir } });
    assert.ok(String(result.context).includes("worker_runner_fallback:test_run.log"));
  });

  it("injects no-data marker when no artifacts exist", async () => {
    const instruction = { task: "fix ci", context: "" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir } });
    assert.ok(String(result.context).includes("## CI_FAILURE_CONTEXT"));
    assert.ok(String(result.context).includes("no_evidence_available"));
  });

  it("preserves existing context and appends CI block", async () => {
    await fs.writeFile(path.join(stateDir, "npm_test_full.log"), "FAIL tests/core/x.test.ts\nError: fail", "utf8");
    const instruction = { task: "fix ci", context: "existing context" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir } });
    assert.ok(String(result.context).startsWith("existing context"));
    assert.ok(String(result.context).includes("## CI_FAILURE_CONTEXT"));
  });

  it("negative: does not inject when stateDir is empty string", async () => {
    const instruction = { task: "fix ci", context: "" };
    const result = await injectCiFailureContextIfMissing(instruction, { paths: { stateDir: "" } });
    assert.ok(String(result.context).includes("no_evidence_available"), "must still inject no-data marker");
  });
});

// ── applyMemoryTrustFilter ────────────────────────────────────────────────────

describe("applyMemoryTrustFilter", () => {
  const highHint = {
    hint: "use path.join for all file paths",
    reason: "prevents separator issues",
    trust: { level: "high", source: "system", reason: "deterministic", taggedAt: "2024-01-01T00:00:00Z" },
  };
  const mediumHint = {
    hint: "prefer small functions",
    reason: "model-derived best practice",
    trust: { level: "medium", source: "model", reason: "model-produced", taggedAt: "2024-01-01T00:00:00Z" },
  };
  const lowHint = {
    hint: "try manual review first",
    reason: "user feedback",
    trust: { level: "low", source: "user-mediated", reason: "free text", taggedAt: "2024-01-01T00:00:00Z" },
  };

  it("returns only HIGH and MEDIUM hints for non-privileged worker kind", () => {
    const { selected, droppedLowTrustCount, isPrivileged } = applyMemoryTrustFilter(
      [highHint, mediumHint, lowHint],
      "evolution",
    );
    assert.equal(selected.length, 2);
    assert.equal(droppedLowTrustCount, 1);
    assert.equal(isPrivileged, false);
    assert.ok(!selected.some(h => h.trust.level === "low"));
  });

  it("returns HIGH hints first (ranked by trust level descending)", () => {
    const { selected } = applyMemoryTrustFilter([mediumHint, highHint], "quality");
    assert.equal(selected[0].trust.level, "high");
    assert.equal(selected[1].trust.level, "medium");
  });

  it("includes LOW trust hints for privileged caller (governance)", () => {
    const { selected, droppedLowTrustCount, isPrivileged } = applyMemoryTrustFilter(
      [highHint, mediumHint, lowHint],
      "governance",
    );
    assert.equal(selected.length, 3);
    assert.equal(droppedLowTrustCount, 0);
    assert.equal(isPrivileged, true);
  });

  it("includes LOW trust hints for 'system' worker kind", () => {
    const { isPrivileged } = applyMemoryTrustFilter([lowHint], "system");
    assert.equal(isPrivileged, true);
  });

  it("handles empty hints array without throwing", () => {
    const { selected, droppedLowTrustCount } = applyMemoryTrustFilter([], "evolution");
    assert.equal(selected.length, 0);
    assert.equal(droppedLowTrustCount, 0);
  });

  it("annotates raw hints without trust field via classification", () => {
    const rawHint = { hint: "use npm test", reason: "standard", source: "system" };
    const { selected } = applyMemoryTrustFilter([rawHint], "evolution");
    assert.ok(selected.length > 0, "system-sourced hint must pass trust filter");
    assert.ok(selected[0].trust, "trust metadata must be attached");
  });

  it("negative: non-privileged caller cannot force LOW trust inclusion", () => {
    const { selected } = applyMemoryTrustFilter([lowHint], "infrastructure");
    assert.equal(selected.length, 0, "non-privileged caller must not receive LOW trust hints");
  });
});

// ── computeMemoryHitRatio ─────────────────────────────────────────────────────

describe("computeMemoryHitRatio", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-memory-hit-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 when no log file exists", async () => {
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config);
    assert.equal(ratio, 0, "missing log must yield ratio=0");
  });

  it("returns 0 for empty log array", async () => {
    await fs.writeFile(path.join(tmpDir, "memory_hit_log.json"), "[]");
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config);
    assert.equal(ratio, 0, "empty log must yield ratio=0");
  });

  it("returns 1.0 when all entries have hints injected", async () => {
    const log = [
      { taskId: "t1", hintsInjected: 2, lessonsInjected: 1, outcome: "done", isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t2", hintsInjected: 1, lessonsInjected: 0, outcome: null, isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
    ];
    await fs.writeFile(path.join(tmpDir, "memory_hit_log.json"), JSON.stringify(log));
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config);
    assert.equal(ratio, 1.0, "all entries with hints must yield ratio=1.0");
  });

  it("returns correct ratio for mixed hit/miss entries", async () => {
    const log = [
      { taskId: "t1", hintsInjected: 2, lessonsInjected: 0, outcome: "done", isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t2", hintsInjected: 0, lessonsInjected: 0, outcome: null, isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t3", hintsInjected: 0, lessonsInjected: 1, outcome: "done", isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t4", hintsInjected: 0, lessonsInjected: 0, outcome: null, isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
    ];
    await fs.writeFile(path.join(tmpDir, "memory_hit_log.json"), JSON.stringify(log));
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config);
    assert.equal(ratio, 0.5, "2 hits out of 4 entries must yield ratio=0.5");
  });

  it("respects limit parameter (only checks most recent N entries)", async () => {
    // 4 entries: first 2 are misses, last 2 are hits — with limit=2, only hits counted → ratio=1.0
    const log = [
      { taskId: "t1", hintsInjected: 0, lessonsInjected: 0, outcome: null, isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t2", hintsInjected: 0, lessonsInjected: 0, outcome: null, isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t3", hintsInjected: 1, lessonsInjected: 0, outcome: "done", isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
      { taskId: "t4", hintsInjected: 2, lessonsInjected: 1, outcome: "done", isPrivileged: false, timestamp: "2024-01-01T00:00:00Z" },
    ];
    await fs.writeFile(path.join(tmpDir, "memory_hit_log.json"), JSON.stringify(log));
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config, 2);
    assert.equal(ratio, 1.0, "limit=2 must only look at the 2 most-recent entries");
  });

  it("negative: returns 0 for corrupt/invalid JSON log file", async () => {
    await fs.writeFile(path.join(tmpDir, "memory_hit_log.json"), "NOT_JSON{{{");
    const config = { paths: { stateDir: tmpDir } };
    const ratio = await computeMemoryHitRatio(config);
    assert.equal(ratio, 0, "corrupt log must yield ratio=0 without throwing");
  });
});

describe("lineage-scoped routing signals", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-worker-routing-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("prefers lineage-joined prompt cache telemetry over broader task-kind history", async () => {
    const config = { paths: { stateDir } };
    await appendPromptCacheTelemetry(config, {
      promptFamilyKey: "family-a",
      agent: "integration-worker",
      taskKind: "implementation",
      totalSegments: 10,
      cacheableSegments: 2,
      estimatedSavedTokens: 40,
      lineageJoinKey: "lineage:other",
      lineageId: "other",
    });
    await appendPromptCacheTelemetry(config, {
      promptFamilyKey: "family-b",
      agent: "integration-worker",
      taskKind: "implementation",
      totalSegments: 10,
      cacheableSegments: 8,
      estimatedSavedTokens: 220,
      lineageJoinKey: "lineage:match",
      lineageId: "match",
    });

    const signal = await computePromptCacheRoutingSignal(
      config,
      "implementation",
      "integration-worker",
      { lineageJoinKey: "lineage:match", lineageId: "match" },
    );
    assert.equal(signal.matchMode, "lineageJoinKey");
    assert.equal(signal.sampleCount, 1);
    assert.equal(signal.hitRate, 0.8);
    assert.equal(signal.avgSavedTokens, 220);
  });

  it("summarizes low-roi failure evidence for the active lineage", async () => {
    const config = { paths: { stateDir } };
    await appendFailureClassification(config, {
      primaryClass: "verification",
      taskKind: "implementation",
      roleName: "integration-worker",
      lineageJoinKey: "lineage:match",
      lineageId: "match",
      finishStatus: "partial",
      finishCode: "verification_report_fail:tests",
      retryRoiExpectedGain: 0.05,
      retryRoiThreshold: 0.18,
      retryRoiAllowed: false,
    });
    await appendFailureClassification(config, {
      primaryClass: "policy",
      taskKind: "implementation",
      roleName: "integration-worker",
      lineageJoinKey: "lineage:other",
      lineageId: "other",
      finishStatus: "blocked",
      finishCode: "self_dev_guard_breach:planned_scope",
      retryRoiExpectedGain: 0.25,
      retryRoiThreshold: 0.18,
      retryRoiAllowed: true,
    });

    const signal = await computeFailureFinishRoutingSignal(
      config,
      "implementation",
      "integration-worker",
      { lineageJoinKey: "lineage:match", lineageId: "match" },
    );
    assert.equal(signal.matchMode, "lineageJoinKey");
    assert.equal(signal.lowRoiSignalCount, 1);
    assert.equal(signal.latestFailureClass, "verification");
    assert.equal(signal.latestFinishCode, "verification_report_fail:tests");
    assert.equal(signal.verificationFailureCount, 1);
  });

  it("derives finish codes from verification evidence when no dispatch block exists", () => {
    const finishCode = deriveWorkerFinishCode({
      status: "partial",
      verificationReport: {
        build: "pass",
        tests: "fail",
      },
    });
    assert.equal(finishCode, "verification_report_fail:tests");
  });
});

describe("runtime lineage contract", () => {
  it("derives a stable join key from an embedded lineage contract", () => {
    const lineage = buildWorkerRuntimeLineage(
      {
        task: "Extend runtime lineage joins across checkpoints and analytics",
        taskKind: "implementation",
        lineageContract: {
          lineageId: "lineage-42",
          taskId: "task-42",
          taskKind: "implementation",
        },
      },
      { roleName: "integration-worker", model: "GPT-5.4" },
    );

    assert.equal(resolveWorkerExecutionLineageId({ lineageContract: { lineageId: "lineage-42" } }), "lineage-42");
    assert.equal(lineage.lineageJoinKey, "lineage:lineage-42");
    assert.equal(lineage.checkpointThreadId, "lineage:lineage-42");
    assert.equal(lineage.lineage?.role, "integration-worker");
    assert.equal(lineage.lineage?.model, "GPT-5.4");
  });

  it("keeps checkpoint, evidence, and analytics lineage joins aligned", () => {
    const runtimeLineage = buildWorkerRuntimeLineage(
      {
        task: "Persist worker lineage through runtime boundaries",
        taskKind: "implementation",
        lineageContract: {
          lineageId: "lineage-99",
          taskId: "task-99",
          taskKind: "implementation",
        },
      },
      { roleName: "integration-worker", model: "GPT-5.4" },
    );

    const checkpoint = createVersionedCheckpointEnvelope(
      {
        status: "partial",
        taskId: "task-99",
        lineage: runtimeLineage.lineage,
      },
      null,
      "boundary:attempt",
      {
        thread_id: runtimeLineage.checkpointThreadId || "lineage:lineage-99",
        checkpoint_ns: "attempt",
        checkpoint_id: "lineage-99/attempt/1",
      },
    );
    const executionReport = buildWorkerExecutionReportArtifact({
      roleName: "integration-worker",
      status: "partial",
      summary: "Runtime lineage captured.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
      lineage: runtimeLineage.lineage,
      lineageJoinKey: runtimeLineage.lineageJoinKey,
    });
    const telemetry = buildInterventionLineageTelemetry({
      premiumUsageLog: [{
        worker: "integration-worker",
        model: "GPT-5.4",
        taskKind: "implementation",
        outcome: "done",
        lineage: runtimeLineage.lineage,
        lineageJoinKey: runtimeLineage.lineageJoinKey,
        lineageId: runtimeLineage.lineage?.lineageId,
      }],
      routeRoiLedger: [{
        taskId: "task-99",
        model: "GPT-5.4",
        tier: "T2",
        estimatedTokens: 900,
        expectedQuality: 0.8,
        realizedQuality: 0.92,
        outcome: "done",
        roi: 0.92,
        roiDelta: 0.12,
        routedAt: "2026-04-15T08:33:53.721Z",
        realizedAt: "2026-04-15T08:34:53.721Z",
        lineage: runtimeLineage.lineage,
        lineageJoinKey: runtimeLineage.lineageJoinKey,
        lineageId: runtimeLineage.lineage?.lineageId,
      }],
      workerResults: [{
        roleName: "integration-worker",
        status: "done",
        lineage: runtimeLineage.lineage,
        lineageJoinKey: runtimeLineage.lineageJoinKey,
      }],
    });

    assert.equal(checkpoint.lineageJoinKey, runtimeLineage.lineageJoinKey);
    assert.equal(executionReport.lineageJoinKey, runtimeLineage.lineageJoinKey);
    assert.equal(telemetry.joinedLineages[0]?.joinKey, runtimeLineage.lineageJoinKey);
    assert.ok(telemetry.joinedLineages[0]?.surfaces.includes("modelRouting"));
    assert.ok(telemetry.joinedLineages[0]?.surfaces.includes("workerOutcome"));
  });

  it("prefers prompt-family join keys for planning lineage contracts", () => {
    const runtimeLineage = buildWorkerRuntimeLineage(
      {
        task: "Assemble planning brief",
        taskKind: "planning",
        promptFamilyKey: "planner-cycle-7",
        lineageContract: {
          lineageId: "lineage-77",
          taskKind: "planning",
          promptFamilyKey: "planner-cycle-7",
        },
      },
      { roleName: "prometheus", model: "GPT-5.4" },
    );

    assert.equal(runtimeLineage.lineageJoinKey, "prompt-family:planner-cycle-7");
    assert.equal(runtimeLineage.checkpointThreadId, "prompt-family:planner-cycle-7");
  });
});

// ── buildRoutingROISummary — lineage-key join for premium usage + routing ROI ──
// These tests verify that premium usage log entries are correctly joined via
// the shared lineageId key and that ROI is computed per-lineage group.

describe("buildRoutingROISummary — lineage-keyed routing ROI", () => {
  it("returns zero-state for empty log", () => {
    const result = buildRoutingROISummary([]);
    assert.equal(result.totalRequests, 0);
    assert.equal(result.linkedRequests, 0);
    assert.equal(result.linkedRatio, null);
    assert.deepEqual(result.roiByLineageId, {});
    assert.equal(result.overallLinkedROI, null);
  });

  it("counts entries without any lineage contract signals as unlinked", () => {
    const log = [
      { worker: "king-david", model: "Claude Sonnet 4.6", taskKind: "backend", outcome: "done", lineageId: null },
      { worker: "esther",     model: "Claude Sonnet 4.6", taskKind: "backend", outcome: "done", lineageId: null },
    ];
    const result = buildRoutingROISummary(log);
    assert.equal(result.totalRequests, 2);
    assert.equal(result.linkedRequests, 0);
    assert.equal(result.linkedRatio, 0);
    assert.deepEqual(result.roiByLineageId, {});
  });

  it("groups done outcomes by lineageId and computes ROI", () => {
    const log = [
      { worker: "king-david", model: "Claude Sonnet 4.6", taskKind: "backend", outcome: "done",    lineageId: "lid-abc" },
      { worker: "king-david", model: "Claude Sonnet 4.6", taskKind: "backend", outcome: "blocked", lineageId: "lid-abc" },
      { worker: "esther",     model: "Claude Sonnet 4.6", taskKind: "scan",    outcome: "done",    lineageId: "lid-xyz" },
    ];
    const result = buildRoutingROISummary(log);
    assert.equal(result.totalRequests, 3);
    assert.equal(result.linkedRequests, 3);
    assert.equal(result.linkedRatio, 1);
    // lineage:lid-abc: 1 done / 2 total = 0.5
    assert.equal(result.roiByLineageId["lineage:lid-abc"]?.roi, 0.5);
    assert.equal(result.roiByLineageId["lineage:lid-abc"]?.success, 1);
    assert.equal(result.roiByLineageId["lineage:lid-abc"]?.total, 2);
    // lineage:lid-xyz: 1 done / 1 total = 1.0
    assert.equal(result.roiByLineageId["lineage:lid-xyz"]?.roi, 1);
    // overallLinkedROI: 2 done / 3 total = 0.667
    assert.ok(typeof result.overallLinkedROI === "number");
    assert.ok(result.overallLinkedROI > 0.6 && result.overallLinkedROI < 0.7);
  });

  it("computes linkedRatio correctly with mixed linked/unlinked entries", () => {
    const log = [
      { outcome: "done",    lineageId: "lid-1" },
      { outcome: "done",    lineageId: "lid-1" },
      { outcome: "blocked", lineageId: null     },
      { outcome: "done",    lineageId: null     },
    ];
    const result = buildRoutingROISummary(log);
    assert.equal(result.totalRequests, 4);
    assert.equal(result.linkedRequests, 2);
    assert.equal(result.linkedRatio, 0.5, "half of entries carry a lineageId");
    assert.equal(result.overallLinkedROI, 1, "both linked entries are done");
  });

  it("negative: ignores non-object entries in the log", () => {
    const log = [null, undefined, "not-an-object", 42,
      { outcome: "done", lineageId: "lid-1" }];
    const result = buildRoutingROISummary(log as unknown[]);
    assert.equal(result.linkedRequests, 1);
    assert.ok(result.totalRequests >= 1);
  });

  it("links join-key-only routing records when lineageId is absent", () => {
    const result = buildRoutingROISummary(
      [
        {
          worker: "integration-worker",
          model: "GPT-5.4",
          taskKind: "implementation",
          outcome: "done",
          taskId: "task-join-only",
          lineage: { taskId: "task-join-only", taskKind: "implementation" },
          lineageJoinKey: "task:task-join-only",
        },
      ],
      [],
      [
        {
          taskId: "task-join-only",
          model: "GPT-5.4",
          tier: "T2",
          estimatedTokens: 500,
          expectedQuality: 0.8,
          realizedQuality: 0.9,
          outcome: "done",
          roi: 0.9,
          roiDelta: 0.1,
          routedAt: "2026-04-15T08:33:53.721Z",
          realizedAt: "2026-04-15T08:34:53.721Z",
          lineage: { taskId: "task-join-only", taskKind: "implementation" },
          lineageJoinKey: "task:task-join-only",
        },
      ],
    );

    assert.equal(result.linkedRequests, 1);
    assert.equal(result.roiByLineageId["task:task-join-only"]?.roi, 1);
  });
});

// ── WorkerActivityEntry wave field — structural contract ──────────────────────
// WorkerActivityEntry is a local type; we verify its structural contract here
// by confirming worker session state JSON with a wave field is accepted by the
// worker session parsing path without error. The wave field must be optional
// (number | null | undefined).
describe("WorkerActivityEntry wave field — structural contract", () => {
  it("worker session JSON with wave field in activityLog is read without error", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-wave-field-"));
    try {
      const sessionFile = path.join(tmpDir, "worker_evolution-worker.json");
      const sessionData = {
        currentBranch: "feat/test",
        activityLog: [
          { at: new Date().toISOString(), status: "done", task: "Fix auth", wave: 1 },
          { at: new Date().toISOString(), status: "done", task: "Add test", wave: null },
          { at: new Date().toISOString(), status: "in_progress", task: "Deploy" },
        ]
      };
      await fs.writeFile(sessionFile, JSON.stringify(sessionData), "utf8");
      const raw = await fs.readFile(sessionFile, "utf8");
      const parsed = JSON.parse(raw);
      assert.ok(Array.isArray(parsed.activityLog), "activityLog must be an array");
      assert.equal(parsed.activityLog[0].wave, 1, "wave=1 must be preserved");
      assert.equal(parsed.activityLog[1].wave, null, "wave=null must be preserved");
      assert.equal(parsed.activityLog[2].wave, undefined, "wave absent is ok");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── buildWorkerRunContract ────────────────────────────────────────────────────

import { buildWorkerRunContract } from "../../src/core/worker_runner.js";

describe("buildWorkerRunContract", () => {
  it("returns defaults when config and instruction are empty", () => {
    const contract = buildWorkerRunContract({}, {});
    assert.equal(contract.maxTurns, 50);
    assert.equal(contract.workflowName, "box-evolution");
    assert.equal(contract.groupId, "box-workers");
    assert.equal(contract.traceIncludeSensitiveData, false);
    assert.equal(contract.sessionInputPolicy, "auto");
    assert.deepEqual(contract.traceMetadata, {});
  });

  it("instruction overrides config-level maxTurns", () => {
    const config = { workerRunContract: { maxTurns: 25 } };
    const instruction = { maxTurns: 10 };
    const contract = buildWorkerRunContract(config, instruction);
    assert.equal(contract.maxTurns, 10);
  });

  it("config-level maxTurns used when instruction omits it", () => {
    const config = { workerRunContract: { maxTurns: 30 } };
    const contract = buildWorkerRunContract(config, {});
    assert.equal(contract.maxTurns, 30);
  });

  it("traceIncludeSensitiveData defaults to false and never exceeds explicit false", () => {
    const contract = buildWorkerRunContract({ workerRunContract: { traceIncludeSensitiveData: false } }, {});
    assert.equal(contract.traceIncludeSensitiveData, false);
  });

  it("traceIncludeSensitiveData explicit true is respected", () => {
    const contract = buildWorkerRunContract({ workerRunContract: { traceIncludeSensitiveData: true } }, {});
    assert.equal(contract.traceIncludeSensitiveData, true);
  });

  it("negative: null config and null instruction yield safe defaults", () => {
    const contract = buildWorkerRunContract(null, null);
    assert.equal(contract.maxTurns, 50);
    assert.equal(contract.traceIncludeSensitiveData, false);
  });

  it("sessionInputPolicy propagates valid string values", () => {
    const contract = buildWorkerRunContract({ workerRunContract: { sessionInputPolicy: "no_tools" } }, {});
    assert.equal(contract.sessionInputPolicy, "no_tools");
  });
});

// ── extractWorkerViolationSummary ────────────────────────────────────────────

describe("extractWorkerViolationSummary", () => {
  it("returns all-false for null input", () => {
    const result = extractWorkerViolationSummary(null);
    assert.equal(result.closureBoundaryViolation, false);
    assert.equal(result.hookTelemetryViolation, false);
    assert.equal(result.isDispatchBlocked, false);
  });

  it("returns all-false for non-object input", () => {
    const result = extractWorkerViolationSummary("bad-string");
    assert.equal(result.closureBoundaryViolation, false);
    assert.equal(result.hookTelemetryViolation, false);
    assert.equal(result.isDispatchBlocked, false);
  });

  it("returns all-false for empty object", () => {
    const result = extractWorkerViolationSummary({});
    assert.equal(result.closureBoundaryViolation, false);
    assert.equal(result.hookTelemetryViolation, false);
    assert.equal(result.isDispatchBlocked, false);
  });

  it("detects closureBoundaryViolation from dispatchContract", () => {
    const result = extractWorkerViolationSummary({
      dispatchContract: { closureBoundaryViolation: true },
    });
    assert.equal(result.closureBoundaryViolation, true);
    assert.equal(result.hookTelemetryViolation, false);
    assert.equal(result.isDispatchBlocked, false);
  });

  it("does not set closureBoundaryViolation when false in dispatchContract", () => {
    const result = extractWorkerViolationSummary({
      dispatchContract: { closureBoundaryViolation: false },
    });
    assert.equal(result.closureBoundaryViolation, false);
  });

  it("detects hookTelemetryViolation from dispatchBlockReason prefix", () => {
    const result = extractWorkerViolationSummary({
      dispatchBlockReason: "hook_telemetry_inconsistent:hash_mismatch",
    });
    assert.equal(result.hookTelemetryViolation, true);
    assert.equal(result.isDispatchBlocked, true);
  });

  it("sets isDispatchBlocked for any non-empty dispatchBlockReason", () => {
    const result = extractWorkerViolationSummary({
      dispatchBlockReason: "some_other_block_reason",
    });
    assert.equal(result.hookTelemetryViolation, false);
    assert.equal(result.isDispatchBlocked, true);
  });

  it("negative path: ignores non-object dispatchContract", () => {
    const result = extractWorkerViolationSummary({
      dispatchContract: "not-an-object",
    });
    assert.equal(result.closureBoundaryViolation, false);
  });
});

// ── loadReflectionMemoryContext — failure-class keyed retrieval ──────────────

import { loadReflectionMemoryContext } from "../../src/core/worker_runner.js";

describe("loadReflectionMemoryContext — failure-class keyed retrieval", () => {
  let tmpDir: string;
  const structuredRetryState = {
    schemaVersion: 1,
    phaseOrder: ["plan", "edit", "test", "push"],
    currentPhase: "test",
    failedPhase: "test",
    resumeFromPhase: "test",
    lastCompletedPhase: "edit",
    phaseStates: {
      plan: { status: "completed", evidence: [{ code: "target_files", detail: "src/core/worker_runner.ts", source: "instruction" }] },
      edit: { status: "completed", evidence: [{ code: "files_touched", detail: "src/core/worker_runner.ts", source: "worker_output" }] },
      test: { status: "failed", evidence: [{ code: "tests_status", detail: "TESTS=fail", source: "verification_report" }] },
      push: { status: "pending", evidence: [] },
    },
    evidence: [
      { code: "files_touched", detail: "src/core/worker_runner.ts", source: "worker_output" },
      { code: "tests_status", detail: "TESTS=fail", source: "verification_report" },
    ],
    mutation: {
      strategy: "resume_from_failed_phase",
      instructions: [
        "Start by reproducing the recorded verification/build/test evidence before wider edits.",
        "Repair TESTS=fail before entering push.",
      ],
    },
  };

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-reflection-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty string when no reflection memory file exists", () => {
    const result = loadReflectionMemoryContext(
      { paths: { stateDir: tmpDir } },
      "king-david",
      "implementation",
      "fix the auth bug",
    );
    assert.equal(result, "");
  });

  it("returns matching entries without failureClass filter", async () => {
    const entries = [
      {
        roleName: "king-david",
        taskKind: "implementation",
        taskFingerprint: "fp-1",
        taskSnippet: "fix the auth bug",
        outcome: {
          status: "blocked",
          failureClass: "logic_defect",
          retryAction: "rework",
          recordedAt: "2024-01-01T00:00:00Z",
        },
        retryState: structuredRetryState,
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "reflection_memory.json"),
      JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), entries }),
    );
    const result = loadReflectionMemoryContext(
      { paths: { stateDir: tmpDir } },
      "king-david",
      "implementation",
      "fix the auth bug",
    );
    assert.ok(result.includes("RETRY STATE"), "must include structured retry-state header");
    assert.ok(result.includes("rework"), "must include retryAction from entry");
    assert.ok(result.includes("failedPhase=test"), "must surface the failed phase");
    assert.ok(result.includes("mutate next attempt"), "must include mutation guidance");
  });

  it("filters entries by failureClass when provided — keeps matching class", async () => {
    const entries = [
      {
        roleName: "king-david",
        taskKind: "implementation",
        taskFingerprint: "fp-2",
        taskSnippet: "fix tests",
        outcome: {
          status: "blocked",
          failureClass: "logic_defect",
          retryAction: "rework",
          recordedAt: "2024-01-01T00:00:00Z",
        },
        retryState: {
          ...structuredRetryState,
          evidence: [{ code: "failure_class", detail: "logic_defect", source: "failure_classifier" }],
        },
      },
      {
        roleName: "king-david",
        taskKind: "implementation",
        taskFingerprint: "fp-3",
        taskSnippet: "fix tests",
        outcome: {
          status: "blocked",
          failureClass: "environment",
          retryAction: "cooldown_retry",
          recordedAt: "2024-01-01T00:01:00Z",
        },
        retryState: {
          ...structuredRetryState,
          currentPhase: "plan",
          failedPhase: "plan",
          resumeFromPhase: "plan",
          lastCompletedPhase: null,
          mutation: {
            strategy: "resume_from_failed_phase",
            instructions: ["Re-validate repo, tools, and scoped files before editing."],
          },
          evidence: [{ code: "dispatch_block_reason", detail: "disk full", source: "worker_output" }],
        },
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "reflection_memory.json"),
      JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), entries }),
    );
    const result = loadReflectionMemoryContext(
      { paths: { stateDir: tmpDir } },
      "king-david",
      "implementation",
      "fix tests",
      "environment",
    );
    assert.ok(result.includes("cooldown_retry"), "must include the environment-class entry");
    assert.ok(!result.includes("logic_defect"), "must NOT include the logic_defect entry");
    assert.ok(result.includes("resumeFrom=plan"), "must surface the matching retry start phase");
  });

  it("negative: returns empty string when failureClass matches no entries", async () => {
    const entries = [
      {
        roleName: "king-david",
        taskKind: "implementation",
        taskFingerprint: "fp-4",
        taskSnippet: "fix tests",
        outcome: {
          status: "blocked",
          failureClass: "logic_defect",
          retryAction: "rework",
          recordedAt: "2024-01-01T00:00:00Z",
        },
        retryState: structuredRetryState,
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "reflection_memory.json"),
      JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), entries }),
    );
    const result = loadReflectionMemoryContext(
      { paths: { stateDir: tmpDir } },
      "king-david",
      "implementation",
      "fix tests",
      "model",
    );
    assert.equal(result, "", "no entries matching failureClass=model must yield empty string");
  });

  it("uses phase-aware mutation guidance instead of replaying raw reason transcripts", async () => {
    const entries = [
      {
        roleName: "king-david",
        taskKind: "implementation",
        taskFingerprint: "fp-5",
        taskSnippet: "fix the auth bug",
        outcome: {
          status: "partial",
          failureClass: "verification",
          retryAction: "rework",
          recordedAt: "2024-01-01T00:02:00Z",
        },
        retryState: structuredRetryState,
      },
    ];
    await fs.writeFile(
      path.join(tmpDir, "reflection_memory.json"),
      JSON.stringify({ schemaVersion: 2, updatedAt: new Date().toISOString(), entries }),
    );
    const result = loadReflectionMemoryContext(
      { paths: { stateDir: tmpDir } },
      "king-david",
      "implementation",
      "fix the auth bug",
    );
    assert.ok(!result.includes("reason="), "must not fall back to transcript-style reason replay");
    assert.ok(result.includes("TESTS=fail"), "must expose deterministic evidence instead");
  });
});

// ── enforcePreExecuteHookDecisions — authoritative hook enforcement ──────────

import { enforcePreExecuteHookDecisions } from "../../src/core/policy_engine.js";

describe("enforcePreExecuteHookDecisions", () => {
  it("returns allowed=true when no envelopes are provided", () => {
    const result = enforcePreExecuteHookDecisions({}, "king-david", []);
    assert.equal(result.allowed, true);
    assert.equal(result.deniedCount, 0);
    assert.equal(result.blockReason, null);
    assert.deepEqual(result.decisions, []);
  });

  it("returns allowed=true when policy is null and envelopes are well-formed", () => {
    const envelopes = [
      { scope: "src/core/**", intent: "edit file", impact: "medium", clearance: "write" },
    ];
    const result = enforcePreExecuteHookDecisions(null, "king-david", envelopes);
    assert.equal(result.allowed, true);
    assert.equal(result.deniedCount, 0);
    assert.equal(result.blockReason, null);
  });

  it("returns allowed=false when policy blocks a high-impact envelope requiring admin clearance", () => {
    const policy = {
      rolePolicies: {},
      preToolUse: {
        required: true,
        mandatoryFields: ["scope", "intent", "impact", "clearance"],
        validImpactValues: ["low", "medium", "high", "critical"],
        validClearanceValues: ["read", "write", "admin"],
        impactMinClearance: { critical: "admin" },
      },
    };
    const envelopes = [
      { scope: "infra/**", intent: "deploy to production", impact: "critical", clearance: "write" },
    ];
    const result = enforcePreExecuteHookDecisions(policy, "king-david", envelopes);
    assert.equal(result.allowed, false);
    assert.ok(result.deniedCount >= 1);
    assert.ok(typeof result.blockReason === "string" && result.blockReason.startsWith("runtime_hook_denied:"));
    assert.ok(result.firstDeniedScope !== null || result.firstDeniedReasonCode !== null);
  });

  it("negative: returns allowed=false when a non-array is passed as envelopes", () => {
    // Non-array envelopes must produce an empty decisions set and be treated as allowed
    const result = enforcePreExecuteHookDecisions({}, "king-david", null as unknown as unknown[]);
    assert.equal(result.allowed, true);
    assert.equal(result.deniedCount, 0);
    assert.deepEqual(result.decisions, []);
  });

  it("exposes structured decisions array for audit telemetry", () => {
    const envelopes = [
      { scope: "src/**", intent: "read file", impact: "low", clearance: "read" },
    ];
    const result = enforcePreExecuteHookDecisions({}, "king-david", envelopes);
    assert.ok(Array.isArray(result.decisions));
    assert.equal(result.decisions.length, 1);
    assert.ok("envelope" in result.decisions[0]);
    assert.ok("decision" in result.decisions[0]);
  });
});

// ── buildAttemptArtifact — deterministic per-attempt artifact ────────────────

import { buildAttemptArtifact, ATTEMPT_ARTIFACT_SCHEMA_VERSION } from "../../src/core/retry_strategy.js";

describe("buildAttemptArtifact", () => {
  it("produces a phase-aware artifact with correct structure", () => {
    const artifact = buildAttemptArtifact(
      "abc123",
      0,
      "task-42",
      "blocked",
      "logic_defect",
      { retryAction: "rework" },
      "2024-01-01T00:00:00Z",
      {
        failedPhase: "edit",
        resumeFromPhase: "edit",
      },
    );
    assert.equal(artifact.schemaVersion, ATTEMPT_ARTIFACT_SCHEMA_VERSION);
    assert.equal(artifact.runId, "abc123");
    assert.equal(artifact.attempt, 0);
    assert.equal(artifact.taskId, "task-42");
    assert.equal(artifact.outcome, "blocked");
    assert.equal(artifact.failureClass, "logic_defect");
    assert.equal(artifact.retryAction, "rework");
    assert.equal(artifact.firstAttemptAt, "2024-01-01T00:00:00Z");
    assert.equal((artifact.phaseRetryState as any)?.failedPhase, "edit");
    assert.ok(typeof artifact.decidedAt === "string" && artifact.decidedAt.length > 0);
  });

  it("populates policyApplied for a known failure class", () => {
    const artifact = buildAttemptArtifact(
      "run-1",
      1,
      null,
      "error",
      "environment",
      { retryAction: "cooldown_retry" },
      "2024-01-01T00:00:00Z",
    );
    assert.ok(artifact.policyApplied !== null, "policyApplied must be set for a known class");
    assert.equal(artifact.policyApplied!.failureClass, "environment");
    assert.equal(artifact.policyApplied!.action, "cooldown_retry");
    assert.ok(typeof artifact.policyApplied!.escalateAfter === "number");
  });

  it("sets policyApplied to null for an unknown failure class", () => {
    const artifact = buildAttemptArtifact(
      "run-2",
      0,
      null,
      "blocked",
      "unknown_class",
      null,
      "2024-01-01T00:00:00Z",
    );
    assert.equal(artifact.policyApplied, null);
  });

  it("negative: handles null retryDecision and null failureClass gracefully", () => {
    const artifact = buildAttemptArtifact(
      "",
      0,
      null,
      "done",
      null,
      null,
      "",
    );
    assert.equal(artifact.schemaVersion, ATTEMPT_ARTIFACT_SCHEMA_VERSION);
    assert.equal(artifact.retryAction, null);
    assert.equal(artifact.failureClass, null);
    assert.equal(artifact.policyApplied, null);
    assert.equal(artifact.outcome, "done");
    assert.equal(artifact.phaseRetryState, null);
  });
});

// ── isNonRetryablePolicyBlockReason ─────────────────────────────────────────────

import { isNonRetryablePolicyBlockReason } from "../../src/core/worker_runner.js";

describe("isNonRetryablePolicyBlockReason", () => {
  it("returns true for runtime_hook_denied: prefix", () => {
    assert.equal(isNonRetryablePolicyBlockReason("runtime_hook_denied:SOME_CODE"), true);
  });

  it("returns true for runtime_hook_denied: with any suffix", () => {
    assert.equal(isNonRetryablePolicyBlockReason("runtime_hook_denied:write_critical_system_file"), true);
  });

  it("returns true for cloud_agent_governance_policy_violation: prefix", () => {
    assert.equal(isNonRetryablePolicyBlockReason("cloud_agent_governance_policy_violation:sec123"), true);
  });

  it("returns true for tool_policy_denied:hook_deny_ prefix", () => {
    assert.equal(isNonRetryablePolicyBlockReason("tool_policy_denied:hook_deny_write"), true);
  });

  it("returns false for plain policy reasons that are retryable", () => {
    assert.equal(isNonRetryablePolicyBlockReason("rate_limited"), false);
    assert.equal(isNonRetryablePolicyBlockReason("temporary_outage"), false);
    assert.equal(isNonRetryablePolicyBlockReason(""), false);
  });

  it("negative path: partial prefix match does not trigger non-retryable", () => {
    assert.equal(isNonRetryablePolicyBlockReason("runtime_hook"), false);
    assert.equal(isNonRetryablePolicyBlockReason("runtime_hook_allowed:X"), false);
  });
});
