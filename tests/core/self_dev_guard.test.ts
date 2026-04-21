import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateSelfDevProtectionBoundary,
  getSelfDevProtectionContract,
  isSelfDevMode,
  validateFileChanges,
  validatePrSize,
  validateBranch,
  getSelfDevGateOverrides,
  getRecoveryInstructions,
  summarizeSelfDevProtectionContract,
} from "../../src/core/self_dev_guard.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";

describe("self_dev_guard", () => {
  it("detects self-dev mode via explicit flag", () => {
    assert.equal(isSelfDevMode({ selfDev: { enabled: true }, env: { targetRepo: "" } }), true);
  });

  it("disables self-dev mode when single_target_delivery is the active runtime mode", () => {
    assert.equal(isSelfDevMode({
      selfDev: { enabled: true },
      env: { targetRepo: "Ancora-Labs/Box" },
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
      activeTargetSession: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
    }), false);
  });

  it("validates blocked and caution file changes", () => {
    const result = validateFileChanges([
      "src/core/orchestrator.ts",
      "box.config.json"
    ]);
    assert.equal(result.allowed, false);
    assert.ok(result.blocked.some((b) => b.includes("critical system file")));
    assert.ok(result.warnings.some((w) => w.includes("sensitive system file")));
  });

  it("negative path: rejects main branch and oversized PR", () => {
    const branch = validateBranch("main");
    const size = validatePrSize(99, { selfDev: { maxFilesPerPr: 8 } });
    assert.equal(branch.allowed, false);
    assert.equal(size.allowed, false);
  });

  it("returns deterministic gate overrides and recovery metadata", () => {
    const gates = getSelfDevGateOverrides();
    const recovery = getRecoveryInstructions();
    assert.equal(gates.requireLint, true);
    assert.equal(gates.requireTests, true);
    assert.ok(recovery.tag.includes("box/recovery"));
  });

  it("builds a config-backed protection contract with future delivery flags off by default", () => {
    const contract = getSelfDevProtectionContract({
      selfDev: {
        enabled: true,
        criticalFiles: ["src/core/orchestrator.ts"],
        cautionFiles: ["box.config.json"],
        protectedPrefixes: ["state/"],
        forbiddenBranchTargets: ["main", "release"],
      },
      env: { targetRepo: "Ancora-Labs/Box" },
    });

    assert.equal(contract.enabled, true);
    assert.deepEqual(contract.criticalFiles, ["src/core/orchestrator.ts"]);
    assert.deepEqual(contract.forbiddenBranchTargets, ["main", "release"]);
    assert.equal(contract.futureModeFlags.singleTargetDelivery, false);
    assert.equal(contract.futureModeFlags.targetSessionState, false);
  });

  it("blocks combined self_dev boundary breaches and summarizes active protection", () => {
    const config = {
      selfDev: {
        enabled: true,
        maxFilesPerPr: 2,
        criticalFiles: ["src/core/orchestrator.ts"],
        forbiddenBranchTargets: ["main"],
      },
      env: { targetRepo: "Ancora-Labs/Box" },
    };

    const result = evaluateSelfDevProtectionBoundary({
      changedFiles: ["src/core/orchestrator.ts", "src/core/prometheus.ts", "src/core/athena_reviewer.ts"],
      changedFilesCount: 3,
      branchName: "main",
    }, config);

    const summary = summarizeSelfDevProtectionContract(config);
    assert.equal(result.active, true);
    assert.equal(result.allowed, false);
    assert.ok(result.blocked.some((entry) => entry.includes("critical system file")));
    assert.ok(result.blocked.some((entry) => entry.includes("too large")));
    assert.ok(result.blocked.some((entry) => entry.includes("feature branch")));
    assert.ok(summary.includes("futureFlagsOff="));
    assert.ok(summary.includes("singleTargetDelivery"));
    assert.ok(summary.includes("targetSessionState"));
    assert.ok(summary.includes("targetPromptOverlay"));
    assert.ok(summary.includes("targetWorkspaceLifecycle"));
  });

  it("ignores relative target-repo files during single_target_delivery runtime", () => {
    const result = evaluateSelfDevProtectionBoundary({
      changedFiles: ["package.json", "tests/app.test.ts"],
      changedFilesCount: 2,
      branchName: "main",
    }, {
      rootDir: "C:/Users/caner/Desktop/Box",
      selfDev: {
        enabled: true,
      },
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
      activeTargetSession: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        workspace: {
          path: "C:/Users/caner/Desktop/.box-target-workspaces/box/targets/target_portal/sess_123",
        },
      },
    });

    assert.equal(result.active, false);
    assert.equal(result.allowed, true);
    assert.deepEqual(result.blocked, []);
  });

  it("still blocks BOX-root file touches during single_target_delivery runtime", () => {
    const result = evaluateSelfDevProtectionBoundary({
      changedFiles: ["C:/Users/caner/Desktop/Box/src/core/orchestrator.ts"],
      changedFilesCount: 1,
      branchName: "main",
    }, {
      rootDir: "C:/Users/caner/Desktop/Box",
      selfDev: {
        enabled: true,
      },
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
      activeTargetSession: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        workspace: {
          path: "C:/Users/caner/Desktop/.box-target-workspaces/box/targets/target_portal/sess_123",
        },
      },
    });

    assert.equal(result.active, true);
    assert.equal(result.allowed, false);
    assert.ok(result.blocked.some((entry) => entry.includes("critical system file")));
  });
});

