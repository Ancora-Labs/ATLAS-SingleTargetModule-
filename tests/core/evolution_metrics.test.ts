import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectEvolutionMetrics } from "../../src/core/evolution_metrics.js";

describe("evolution_metrics", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-evolution-metrics-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("collects and persists metrics", async () => {
    const now = new Date().toISOString();
    await fs.writeFile(path.join(stateDir, "athena_postmortems.json"), JSON.stringify([{ model: "deterministic" }]), "utf8");
    await fs.writeFile(path.join(stateDir, "progress.txt"), `[${now}] [JANUS] awakening\n`, "utf8");
    await fs.writeFile(path.join(stateDir, "premium_usage_log.json"), JSON.stringify([{ timestamp: now }]), "utf8");
    await fs.writeFile(path.join(stateDir, "slo_metrics_history.json"), JSON.stringify([{ totalCycleDurationMs: 20 }, { totalCycleDurationMs: 10 }]), "utf8");
    await fs.writeFile(path.join(stateDir, "janus_directive.json"), JSON.stringify({ prometheusAnalysis: { projectHealth: "green" } }), "utf8");
    await fs.writeFile(
      path.join(stateDir, "benchmark_ground_truth.json"),
      JSON.stringify({
        schemaVersion: 1,
        updatedAt: now,
        entries: [],
        externalSamples: [
          { benchmark: "swebench", instance_id: "swe-1", repo: "org/repo", status: "resolved" },
          { benchmarkName: "osworld", task_id: "osw-1", environment_id: "env-1", status: "completed" },
        ],
      }),
      "utf8"
    );

    const metrics = await collectEvolutionMetrics({ paths: { stateDir } });
    assert.equal(metrics.deterministicPostmortem.totalCount, 1);
    assert.equal(metrics.janusAiCallsPerDay, 1);
    assert.equal(metrics.premiumRequestsPerDay, 1);
    assert.equal(metrics.cycleWallClockP50Ms, 15);
    const saved = JSON.parse(await fs.readFile(path.join(stateDir, "evolution_metrics.json"), "utf8"));
    assert.equal(saved.janusContextCorrect, true);
    // janusCalibration field must be present (null metrics when no history)
    assert.ok("janusCalibration" in saved, "janusCalibration must be present in saved metrics");
    assert.equal(saved.janusCalibration.totalRecords, 0);
    assert.equal(saved.janusCalibration.averageOverallScore, null);
    assert.equal(saved.externalBenchmarkCoverage.totalSamples, 2);
    assert.equal(saved.externalBenchmarkCoverage.validSamples, 2);
    assert.equal(saved.externalBenchmarkCoverage.invalidSamples, 0);
    assert.equal(saved.externalBenchmarkCoverage.normalizedSamples, 2);
  });

  it("negative path: handles missing input files deterministically", async () => {
    const metrics = await collectEvolutionMetrics({ paths: { stateDir } });
    assert.equal(metrics.deterministicPostmortem.totalCount, 0);
    assert.equal(metrics.premiumRequestsPerDay, 0);
    assert.equal(metrics.janusContextCorrect, false);
    // janusCalibration must always be present even with no history
    assert.ok("janusCalibration" in metrics, "janusCalibration must always be present");
    assert.equal(metrics.janusCalibration.totalRecords, 0);
    assert.equal(metrics.janusCalibration.averageOverallScore, null);
    assert.equal(metrics.externalBenchmarkCoverage.totalSamples, 0);
    assert.equal(metrics.externalBenchmarkCoverage.validSamples, 0);
    assert.equal(metrics.externalBenchmarkCoverage.invalidSamples, 0);
    assert.equal(metrics.externalBenchmarkCoverage.normalizedSamples, 0);
  });
});


