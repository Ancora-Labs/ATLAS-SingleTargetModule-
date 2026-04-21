import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSingleTargetStartupGuardMessage, evaluateSingleTargetStartupRequirements } from "../../src/core/single_target_startup_guard.ts";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";

describe("single target startup guard", () => {
  it("does not block self_dev startup when no active target exists", async () => {
    const result = await evaluateSingleTargetStartupRequirements({
      env: {
        githubToken: null,
        copilotGithubToken: null,
      },
      paths: {
        stateDir: "C:/box/state",
      },
    });

    assert.equal(result.singleTargetRequired, false);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.equal(result.currentMode, PLATFORM_MODE.SELF_DEV);
  });

  it("blocks forced single-target startup when either token is missing", async () => {
    const result = await evaluateSingleTargetStartupRequirements({
      env: {
        githubToken: "classic-token",
        copilotGithubToken: null,
      },
      paths: {
        stateDir: "C:/box/state",
      },
    }, {
      forceSingleTarget: true,
    });

    assert.equal(result.singleTargetRequired, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["COPILOT_GITHUB_TOKEN"]);
    assert.match(buildSingleTargetStartupGuardMessage(result), /Missing: COPILOT_GITHUB_TOKEN/);
  });

  it("blocks active single-target runtime when both tokens are missing", async () => {
    const result = await evaluateSingleTargetStartupRequirements({
      env: {
        githubToken: null,
        copilotGithubToken: null,
      },
      paths: {
        stateDir: "C:/box/state",
      },
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
    }, {
      forceSingleTarget: true,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]);
    assert.match(buildSingleTargetStartupGuardMessage(result), /BOX will not auto-create or auto-fetch GitHub tokens/);
  });
});