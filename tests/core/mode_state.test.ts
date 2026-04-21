import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_PLATFORM_MODE_STATE,
  PLATFORM_MODE,
  getPlatformModeStatePath,
  loadPlatformModeState,
  normalizePlatformModeState,
} from "../../src/core/mode_state.js";

describe("mode_state", () => {
  it("defaults to self_dev when no mode state exists", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-mode-state-"));
    const stateDir = path.join(tempRoot, "state");
    await fs.mkdir(stateDir, { recursive: true });

    const state = await loadPlatformModeState({
      paths: { stateDir },
      selfDev: {
        futureModeFlags: {
          singleTargetDelivery: false,
          targetSessionState: false,
        },
      },
    });

    assert.equal(state.currentMode, PLATFORM_MODE.SELF_DEV);
    assert.equal(state.activeTargetSessionId, null);
    assert.equal(state.fallbackModeAfterCompletion, PLATFORM_MODE.SELF_DEV);

    const persisted = JSON.parse(await fs.readFile(getPlatformModeStatePath(stateDir), "utf8"));
    assert.equal(persisted.currentMode, PLATFORM_MODE.SELF_DEV);
  });

  it("negative path: blocks single_target_delivery while feature flags stay off", () => {
    const normalized = normalizePlatformModeState({
      currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      activeTargetSessionId: "sess_123",
      activeTargetProjectId: "proj_123",
      fallbackModeAfterCompletion: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    }, {
      sessionId: "sess_123",
      projectId: "proj_123",
    }, {
      selfDev: {
        futureModeFlags: {
          singleTargetDelivery: false,
          targetSessionState: false,
        },
      },
    });

    assert.equal(normalized.currentMode, PLATFORM_MODE.SELF_DEV);
    assert.equal(normalized.activeTargetSessionId, null);
    assert.equal(normalized.fallbackModeAfterCompletion, PLATFORM_MODE.SELF_DEV);
    assert.ok(normalized.warnings.some((entry: string) => entry.includes("feature flag is disabled")));
  });

  it("clears stale target pointers when current mode is not single_target_delivery", () => {
    const normalized = normalizePlatformModeState({
      ...DEFAULT_PLATFORM_MODE_STATE,
      currentMode: PLATFORM_MODE.SELF_DEV,
      activeTargetSessionId: "sess_stale",
      activeTargetProjectId: "proj_stale",
    }, null, {
      selfDev: {
        futureModeFlags: {
          singleTargetDelivery: true,
          targetSessionState: true,
        },
      },
    });

    assert.equal(normalized.currentMode, PLATFORM_MODE.SELF_DEV);
    assert.equal(normalized.activeTargetSessionId, null);
    assert.equal(normalized.activeTargetProjectId, null);
    assert.ok(normalized.warnings.some((entry: string) => entry.includes("cannot keep an active target session pointer")));
  });
});