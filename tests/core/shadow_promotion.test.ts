import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  promoteShadowSessionToActiveAfterCleanWave,
  shouldPromoteShadowSessionAfterCleanWave,
} from "../../src/core/orchestrator.js";
import {
  createTargetSession,
  loadActiveTargetSession,
  TARGET_SESSION_STAGE,
} from "../../src/core/target_session_state.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";

function buildConfig(stateDir: string) {
  return {
    rootDir: path.join(stateDir, "box-root"),
    paths: { stateDir },
    env: {},
    selfDev: {
      futureModeFlags: {
        singleTargetDelivery: true,
        targetSessionState: true,
        targetWorkspaceLifecycle: true,
      },
    },
    platformModeState: {
      currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      activeTargetSessionId: null,
      activeTargetProjectId: null,
    },
  };
}

function buildManifest() {
  return {
    schemaVersion: 1,
    requestId: "req_shadow_promote_001",
    target: {
      repoUrl: "https://github.com/acme/shadow-promo-target.git",
      provider: "github",
      defaultBranch: "main",
    },
    objective: {
      summary: "Deliver a small todo app incrementally",
      desiredOutcome: "Shadow success promotes to active",
      acceptanceCriteria: ["wave one clean", "session promotes"],
    },
  };
}

describe("shadow promotion", () => {
  it("promotes a single-target shadow session to active after the last clean batch of the shadow cycle", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-shadow-promotion-"));
    const config = buildConfig(tempRoot);
    const created = await createTargetSession(buildManifest(), config);
    const shadowSession = {
      ...created,
      currentStage: TARGET_SESSION_STAGE.SHADOW,
      onboarding: {
        ...created.onboarding,
        recommendedNextStage: TARGET_SESSION_STAGE.SHADOW,
      },
      gates: {
        ...created.gates,
        allowPlanning: true,
        allowShadowExecution: true,
        allowActiveExecution: false,
      },
      workspace: {
        ...created.workspace,
        path: path.join(tempRoot, "target-workspaces", "shadow-promo"),
      },
    };
    config.activeTargetSession = shadowSession;
    await fs.mkdir(shadowSession.workspace.path, { recursive: true });
    await fs.writeFile(path.join(tempRoot, "active_target_session.json"), JSON.stringify(shadowSession, null, 2), "utf8");

    const promoted = await promoteShadowSessionToActiveAfterCleanWave(config, {
      batch: { wave: 2, role: "quality-worker" },
      workerResult: { status: "done" },
      workerBatches: [
        { wave: 1, role: "evolution-worker" },
        { wave: 2, role: "quality-worker" },
      ],
      completedBatchIndex: 1,
    });

    assert.equal(promoted?.currentStage, TARGET_SESSION_STAGE.ACTIVE);
    assert.equal(promoted?.gates?.allowShadowExecution, false);
    assert.equal(promoted?.gates?.allowActiveExecution, true);
    assert.equal(promoted?.onboarding?.recommendedNextStage, TARGET_SESSION_STAGE.ACTIVE);
    assert.equal(config.activeTargetSession?.currentStage, TARGET_SESSION_STAGE.ACTIVE);

    const reloaded = await loadActiveTargetSession(config);
    assert.equal(reloaded?.currentStage, TARGET_SESSION_STAGE.ACTIVE);
    assert.equal(reloaded?.gates?.allowShadowExecution, false);
    assert.equal(reloaded?.gates?.allowActiveExecution, true);
    assert.equal(reloaded?.handoff?.nextAction, "run_active_planning");
  });

  it("promotes immediately when a shadow cycle contains a single clean batch", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-shadow-promotion-single-"));
    const config = buildConfig(tempRoot);
    const created = await createTargetSession(buildManifest(), config);
    const shadowSession = {
      ...created,
      currentStage: TARGET_SESSION_STAGE.SHADOW,
      gates: {
        ...created.gates,
        allowPlanning: true,
        allowShadowExecution: true,
        allowActiveExecution: false,
      },
      workspace: {
        ...created.workspace,
        path: path.join(tempRoot, "target-workspaces", "shadow-promo-single"),
      },
    };
    config.activeTargetSession = shadowSession;
    await fs.mkdir(shadowSession.workspace.path, { recursive: true });
    await fs.writeFile(path.join(tempRoot, "active_target_session.json"), JSON.stringify(shadowSession, null, 2), "utf8");

    const promoted = await promoteShadowSessionToActiveAfterCleanWave(config, {
      batch: { wave: 1, role: "evolution-worker" },
      workerResult: { status: "done" },
      workerBatches: [{ wave: 1, role: "evolution-worker" }],
      completedBatchIndex: 0,
    });

    assert.equal(promoted?.currentStage, TARGET_SESSION_STAGE.ACTIVE);
    assert.equal(promoted?.gates?.allowShadowExecution, false);
    assert.equal(promoted?.gates?.allowActiveExecution, true);
    assert.equal(config.activeTargetSession?.currentStage, TARGET_SESSION_STAGE.ACTIVE);
  });

  it("does not promote before the final batch of the cycle or on non-done outcomes", () => {
    const config = {
      platformModeState: { currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY },
      activeTargetSession: {
        currentStage: TARGET_SESSION_STAGE.SHADOW,
        gates: {
          allowShadowExecution: true,
          allowActiveExecution: false,
        },
      },
    };

    assert.equal(shouldPromoteShadowSessionAfterCleanWave({
      config,
      batch: { wave: 1 },
      workerResult: { status: "done" },
      workerBatches: [{ wave: 1 }, { wave: 2 }],
      completedBatchIndex: 0,
    }), false);

    assert.equal(shouldPromoteShadowSessionAfterCleanWave({
      config,
      batch: { wave: 1 },
      workerResult: { status: "blocked" },
      workerBatches: [{ wave: 1 }, { wave: 2 }],
      completedBatchIndex: 0,
    }), false);
  });
});