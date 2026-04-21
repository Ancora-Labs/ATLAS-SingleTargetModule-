import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  buildTargetExecutionWorkerContext,
  evaluateTargetExecutionBoundary,
  resolveWorkerExecutionCwd,
} from "../../src/core/target_execution_guard.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";
import { TARGET_SESSION_STAGE } from "../../src/core/target_session_state.js";
import { buildConversationContext } from "../../src/core/worker_runner.js";

function buildSession(workspacePath: string) {
  return {
    currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    currentStage: TARGET_SESSION_STAGE.SHADOW,
    projectId: "target_portal",
    sessionId: "sess_123",
    repo: {
      repoUrl: "https://github.com/acme/portal.git",
      defaultBranch: "main",
    },
    objective: {
      summary: "Ship the target fix without touching BOX",
    },
    workspace: {
      path: workspacePath,
    },
    gates: {
      allowShadowExecution: true,
      allowActiveExecution: false,
    },
    constraints: {
      protectedPaths: ["infra/prod", "secrets"],
      forbiddenActions: ["force push", "rotate production secret", "bypass review gate"],
    },
  };
}

function buildConfig(overrides: Record<string, unknown> = {}) {
  const rootDir = path.join("C:/tmp", "box-root");
  const workspacePath = path.join("C:/tmp", "target-workspaces", "portal", "sess_123");
  return {
    rootDir,
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
    activeTargetSession: buildSession(workspacePath),
    ...overrides,
  };
}

describe("target_execution_guard", () => {
  it("allows isolated target execution and switches worker cwd to the target workspace", () => {
    const config = buildConfig();
    const boundary = evaluateTargetExecutionBoundary({
      changedFiles: ["src/app.ts"],
      taskKind: "test",
      task: "Implement the scoped target fix",
    }, config);

    assert.equal(boundary.active, true);
    assert.equal(boundary.allowed, true);
    assert.equal(resolveWorkerExecutionCwd(config), config.activeTargetSession.workspace.path);
  });

  it("blocks target execution when the target workspace overlaps BOX", () => {
    const rootDir = path.join("C:/tmp", "box-root");
    const config = buildConfig({
      rootDir,
      activeTargetSession: buildSession(rootDir),
    });

    const boundary = evaluateTargetExecutionBoundary({ task: "Patch the target repo" }, config);
    assert.equal(boundary.allowed, false);
    assert.equal(boundary.dispatchBlockReason, "target_execution_guard:workspace_not_isolated");
  });

  it("blocks protected target path edits and forbidden actions", () => {
    const config = buildConfig();
    const protectedPathBoundary = evaluateTargetExecutionBoundary({
      changedFiles: ["infra/prod/deploy.yml"],
      taskKind: "docs",
      task: "Adjust guarded infra configuration",
    }, config);
    assert.equal(protectedPathBoundary.allowed, false);
    assert.equal(protectedPathBoundary.dispatchBlockReason, "target_execution_guard:protected_path_scope");

    const forbiddenActionBoundary = evaluateTargetExecutionBoundary({
      taskKind: "docs",
      task: "Apply the fix and bypass review gate after merge",
    }, config);
    assert.equal(forbiddenActionBoundary.allowed, false);
    assert.equal(forbiddenActionBoundary.dispatchBlockReason, "target_execution_guard:forbidden_action_requested");
  });

  it("blocks shadow implementation packets that do not carry concrete verification", () => {
    const config = buildConfig();
    const boundary = evaluateTargetExecutionBoundary({
      changedFiles: ["src/app.ts"],
      taskKind: "implementation",
      task: "Implement the target feature in a bounded way",
      verification: "npm test",
    }, config);

    assert.equal(boundary.allowed, false);
    assert.equal(boundary.dispatchBlockReason, "target_execution_guard:shadow_implementation_requires_verification");
  });

  it("allows a bounded shadow implementation packet when it carries concrete verification", () => {
    const config = buildConfig();
    const boundary = evaluateTargetExecutionBoundary({
      changedFiles: ["src/app.ts", "src/ui.ts"],
      taskKind: "implementation",
      task: "Implement a tiny proving-step refinement only",
      verification: "npm test -- tests/core/target_execution_guard.test.ts",
    }, config);

    assert.equal(boundary.allowed, true);
    assert.equal(boundary.dispatchBlockReason, null);
  });

  it("blocks deploy intent while shadow mode is active", () => {
    const config = buildConfig();
    const boundary = evaluateTargetExecutionBoundary({
      changedFiles: ["docs/runbook.md"],
      taskKind: "docs",
      task: "Prepare production deploy checklist",
    }, config);

    assert.equal(boundary.allowed, false);
    assert.equal(boundary.dispatchBlockReason, "target_execution_guard:shadow_high_risk_action");
  });

  it("injects explicit target execution instructions into the worker conversation", () => {
    const config = buildConfig();
    const prompt = buildConversationContext([], {
      task: "Patch the target service",
      taskKind: "backend",
      verification: "1. tests/core/target_execution_guard.test.ts",
      targetFiles: ["src/app.ts"],
    }, {}, config, null, {});

    const contextBlock = buildTargetExecutionWorkerContext(config);
    assert.match(contextBlock, /TARGET EXECUTION CONTEXT/);
    assert.match(contextBlock, /Run repo commands, tests, and git operations inside the target workspace only/);
    assert.match(contextBlock, /Shadow mode is verification-first/);
    assert.match(contextBlock, /Allowed task kinds only: planning, test, ci-fix, observation, analysis, docs, documentation, verification, implementation/);
    assert.match(contextBlock, /must stay within 4 target file\(s\), avoid broad delivery or release intent, and carry concrete verification/i);
    assert.match(contextBlock, /must produce evidence: keep at least one verification, test, observation, analysis, or concretely verified implementation packet/i);
    assert.match(contextBlock, /do not create extra files outside the planner-declared target file set/i);
    assert.match(prompt, /TARGET EXECUTION CONTEXT/);
    assert.match(prompt, /SHADOW MODE DELIVERY DISCIPLINE/);
    assert.match(prompt, /Allowed target files only: src\/app.ts/);
    assert.match(prompt, /Do not add helpful extras, scaffolding, dependency manifests, lockfiles, tests, configs, folders, assets, or docs unless they are explicitly listed in targetFiles/);
    assert.ok(prompt.includes(config.activeTargetSession.workspace.path));
  });
});