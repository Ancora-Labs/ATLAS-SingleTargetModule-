import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  readCalibrationState,
  recordCalibrationSample,
  getCalibrationCoefficient,
} from "../../src/core/token_calibration.js";

let testStateDir = "";

function testConfig() {
  return { paths: { stateDir: testStateDir } };
}

describe("token_calibration", () => {
  beforeEach(async () => {
    testStateDir = await mkdtemp(path.join(os.tmpdir(), "box-token-calibration-"));
  });

  afterEach(async () => {
    if (!testStateDir) return;
    await rm(testStateDir, { recursive: true, force: true });
    testStateDir = "";
  });

  it("returns default state when no file exists", async () => {
    const state = await readCalibrationState(testConfig());
    assert.equal(state.schemaVersion, 1);
    assert.equal(state.globalCoefficient, 1.0);
    assert.deepEqual(state.roleCoefficients, {});
    assert.deepEqual(state.samples, []);
  });

  it("records a sample and updates EWMA coefficients", async () => {
    const config = testConfig();
    await recordCalibrationSample(config, "evolution-worker", 1000, 1200);
    const state = await readCalibrationState(config);

    assert.equal(state.samples.length, 1);
    assert.equal(state.samples[0].batchRole, "evolution-worker");
    assert.equal(state.samples[0].estimatedTokens, 1000);
    assert.equal(state.samples[0].actualTokens, 1200);
    // ratio = 1.2, EWMA with alpha=0.15: 0.15*1.2 + 0.85*1.0 = 1.03
    assert.ok(state.globalCoefficient > 1.0, "coefficient should increase when actual > estimated");
    assert.ok(state.globalCoefficient < 1.2, "coefficient should be dampened by EWMA");
    assert.ok(state.roleCoefficients["evolution-worker"] > 1.0);
  });

  it("converges coefficient over multiple samples", async () => {
    const config = testConfig();
    // Simulate consistently underestimating by 50%
    for (let i = 0; i < 20; i++) {
      await recordCalibrationSample(config, "evolution-worker", 1000, 1500);
    }
    const state = await readCalibrationState(config);
    // After 20 consistent samples with ratio=1.5, coefficient should approach 1.5
    assert.ok(state.globalCoefficient > 1.3, `expected > 1.3, got ${state.globalCoefficient}`);
    assert.ok(state.globalCoefficient <= 1.5, `expected <= 1.5, got ${state.globalCoefficient}`);
  });

  it("clamps coefficient within bounds", async () => {
    const config = testConfig();
    // Extreme overestimation
    for (let i = 0; i < 50; i++) {
      await recordCalibrationSample(config, "evolution-worker", 1000, 100);
    }
    const state = await readCalibrationState(config);
    assert.ok(state.globalCoefficient >= 0.5, "coefficient should not go below 0.5");
  });

  it("tracks per-role coefficients independently", async () => {
    const config = testConfig();
    await recordCalibrationSample(config, "governance-worker", 1000, 2000);
    await recordCalibrationSample(config, "evolution-worker", 1000, 800);
    const state = await readCalibrationState(config);

    assert.ok(state.roleCoefficients["governance-worker"] > 1.0);
    assert.ok(state.roleCoefficients["evolution-worker"] < 1.0);
  });

  it("getCalibrationCoefficient falls back correctly", () => {
    const state = {
      schemaVersion: 1,
      globalCoefficient: 1.2,
      roleCoefficients: { "governance-worker": 1.4 },
      samples: [],
      updatedAt: "",
    };

    assert.equal(getCalibrationCoefficient(state, "governance-worker"), 1.4);
    assert.equal(getCalibrationCoefficient(state, "evolution-worker"), 1.2); // falls back to global
    assert.equal(getCalibrationCoefficient({ ...state, globalCoefficient: 0 }, "unknown"), 1.0); // falls back to 1.0
  });

  it("ignores invalid inputs without throwing", async () => {
    const config = testConfig();
    // Zero estimated = skip
    await recordCalibrationSample(config, "evo", 0, 100);
    // Negative actual = skip
    await recordCalibrationSample(config, "evo", 100, -1);
    // NaN = skip
    await recordCalibrationSample(config, "evo", NaN, 100);

    const state = await readCalibrationState(config);
    assert.equal(state.samples.length, 0, "invalid samples should be silently ignored");
  });

  it("caps samples at MAX_SAMPLES", async () => {
    const config = testConfig();
    // Record 210 samples (cap is 200)
    for (let i = 0; i < 210; i++) {
      await recordCalibrationSample(config, "evo", 1000, 1100);
    }
    const state = await readCalibrationState(config);
    assert.ok(state.samples.length <= 200, `samples should be capped, got ${state.samples.length}`);
  });
});
