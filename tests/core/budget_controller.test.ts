import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  canUseClaude, chargeBudget, loadBudget, reconcileBudgetEligibility, BUDGET_THRESHOLD_USD,
  computeRollingCompletionYield, ROLLING_YIELD_WINDOW_SIZE, ROLLING_YIELD_MIN_DISPATCHES, ROLLING_YIELD_THROTTLE_THRESHOLD,
} from "../../src/core/budget_controller.js";

describe("budget_controller", () => {
  let tmpDir: string;
  let budgetFile: string;
  let config: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-budget-"));
    budgetFile = path.join(tmpDir, "budget.json");
    config = { paths: { budgetFile }, env: { budgetUsd: 5 } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads default budget when file does not exist", async () => {
    const budget = await loadBudget(config);
    assert.equal(budget.initialUsd, 5);
    assert.equal(budget.remainingUsd, 5);
    assert.equal(budget.claudeCalls, 0);
    assert.equal(budget.workerRuns, 0);
  });

  it("charges budget and clamps remainingUsd at zero", async () => {
    const budget = await chargeBudget(config, { usd: 9.99, claudeCalls: 2, workerRuns: 1 });
    assert.equal(budget.remainingUsd, 0);
    assert.equal(budget.claudeCalls, 2);
    assert.equal(budget.workerRuns, 1);
  });

  it("negative path: blocks claude usage when remaining budget is too low", () => {
    assert.equal(canUseClaude({ remainingUsd: 0.2 }), false);
    assert.equal(canUseClaude({ remainingUsd: 0.1 }), false);
  });
});

describe("reconcileBudgetEligibility", () => {
  let tmpDir: string;
  let budgetFile: string;
  let config: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-budget-elig-"));
    budgetFile = path.join(tmpDir, "budget.json");
    config = { paths: { budgetFile }, env: { budgetUsd: 5 } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns eligible contract when remaining budget exceeds threshold", async () => {
    await fs.writeFile(budgetFile, JSON.stringify({ initialUsd: 5, remainingUsd: 3.0, claudeCalls: 0, workerRuns: 0, updatedAt: new Date().toISOString() }), "utf8");
    const contract = await reconcileBudgetEligibility(config);
    assert.equal(contract.eligible, true);
    assert.equal(contract.remainingUsd, 3.0);
    assert.equal(contract.thresholdUsd, BUDGET_THRESHOLD_USD);
    assert.equal(contract.reason, null);
    assert.equal(contract.configured, true);
    assert.ok(contract.checkedAt, "checkedAt must be populated");
  });

  it("returns ineligible contract when remaining budget is at threshold boundary", async () => {
    await fs.writeFile(budgetFile, JSON.stringify({ initialUsd: 5, remainingUsd: 0.2, claudeCalls: 0, workerRuns: 0, updatedAt: new Date().toISOString() }), "utf8");
    const contract = await reconcileBudgetEligibility(config);
    assert.equal(contract.eligible, false);
    assert.equal(contract.remainingUsd, 0.2);
    assert.ok(contract.reason?.startsWith("budget_exhausted:"), `reason must reflect exhaustion; got: ${contract.reason}`);
    assert.ok(contract.reason?.includes("remainingUsd=0.2"), `reason must include amount; got: ${contract.reason}`);
    assert.equal(contract.configured, true);
  });

  it("returns ineligible contract when remaining budget is below threshold", async () => {
    await fs.writeFile(budgetFile, JSON.stringify({ initialUsd: 5, remainingUsd: 0.05, claudeCalls: 10, workerRuns: 5, updatedAt: new Date().toISOString() }), "utf8");
    const contract = await reconcileBudgetEligibility(config);
    assert.equal(contract.eligible, false);
    assert.ok(contract.reason?.includes("remainingUsd=0.05"));
  });

  it("returns eligible unconfigured contract when no budgetFile path is set", async () => {
    const cfgNoPath = { paths: { stateDir: tmpDir }, env: { budgetUsd: 5 } };
    const contract = await reconcileBudgetEligibility(cfgNoPath);
    assert.equal(contract.eligible, true);
    assert.equal(contract.configured, false);
    assert.equal(contract.remainingUsd, null);
    assert.equal(contract.reason, null);
    assert.equal(contract.thresholdUsd, BUDGET_THRESHOLD_USD);
  });

  it("negative path: fails open with eligible=true when budget file does not exist", async () => {
    // readJson returns the default budget (env.budgetUsd) on ENOENT, so the gate
    // stays open — there is no "read error" from the contract's perspective.
    const missingConfig = { paths: { budgetFile: path.join(tmpDir, "nonexistent.json") }, env: { budgetUsd: 5 } };
    const contract = await reconcileBudgetEligibility(missingConfig);
    assert.equal(contract.eligible, true, "must fail open when budget file does not exist");
    assert.equal(contract.configured, true);
    // readJson fell back to default (budgetUsd=5), so reason is null (budget is fine)
    assert.equal(contract.reason, null, "a missing file is not an error — readJson provides the default budget");
  });
});

describe("computeRollingCompletionYield — rolling dispatch throttle", () => {
  let tmpDir: string;
  let config: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-yield-"));
    config = { paths: { stateDir: tmpDir } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports expected constants", () => {
    assert.ok(Number.isInteger(ROLLING_YIELD_WINDOW_SIZE) && ROLLING_YIELD_WINDOW_SIZE > 0);
    assert.ok(Number.isInteger(ROLLING_YIELD_MIN_DISPATCHES) && ROLLING_YIELD_MIN_DISPATCHES > 0);
    assert.ok(typeof ROLLING_YIELD_THROTTLE_THRESHOLD === "number" && ROLLING_YIELD_THROTTLE_THRESHOLD > 0);
  });

  it("fails open (not throttled) when no usage log exists", async () => {
    const contract = await computeRollingCompletionYield(config);
    assert.equal(contract.throttled, false, "must not throttle when no log exists");
    assert.equal(contract.configured, false, "configured must be false with no log file");
    assert.equal(contract.reason, null);
  });

  it("fails open when window has fewer than ROLLING_YIELD_MIN_DISPATCHES entries", async () => {
    const entries = [
      { role: "worker", outcome: "failed", timestamp: new Date().toISOString() },
    ];
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config, { minDispatches: 3 });
    assert.equal(contract.throttled, false, "must not throttle below min-dispatches threshold");
    assert.equal(contract.dispatches, 1);
    assert.equal(contract.configured, true);
  });

  it("throttles when yield is at or below the threshold", async () => {
    // 3 dispatches, 0 done → yield = 0 ≤ 0.2 → throttled
    const entries = Array.from({ length: 3 }, (_, i) => ({
      role: "worker", outcome: "failed", timestamp: new Date().toISOString(),
    }));
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config, { minDispatches: 3 });
    assert.equal(contract.throttled, true, "yield=0 must trigger throttle");
    assert.equal(contract.completions, 0);
    assert.equal(contract.dispatches, 3);
    assert.ok(contract.reason?.startsWith("rolling_yield_throttle:"), `reason must start with rolling_yield_throttle; got: ${contract.reason}`);
    assert.ok(contract.reason?.includes("completions=0/3"));
  });

  it("does not throttle when yield is above the threshold", async () => {
    // 5 dispatches, 4 done → yield = 0.8 > 0.2
    const entries = [
      { role: "worker", outcome: "done", timestamp: new Date().toISOString() },
      { role: "worker", outcome: "done", timestamp: new Date().toISOString() },
      { role: "worker", outcome: "done", timestamp: new Date().toISOString() },
      { role: "worker", outcome: "done", timestamp: new Date().toISOString() },
      { role: "worker", outcome: "failed", timestamp: new Date().toISOString() },
    ];
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config);
    assert.equal(contract.throttled, false);
    assert.equal(contract.completions, 4);
    assert.equal(contract.dispatches, 5);
    assert.ok(contract.yield > 0.2);
    assert.equal(contract.reason, null);
  });

  it("treats partial outcomes as productive completions for rolling yield", async () => {
    // 5 dispatches, 2 partial + 1 done = 3 productive completions => yield = 0.6
    const entries = [
      { role: "w", outcome: "partial", timestamp: new Date().toISOString() },
      { role: "w", outcome: "partial", timestamp: new Date().toISOString() },
      { role: "w", outcome: "done", timestamp: new Date().toISOString() },
      { role: "w", outcome: "failed", timestamp: new Date().toISOString() },
      { role: "w", outcome: "blocked", timestamp: new Date().toISOString() },
    ];
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config, { minDispatches: 3 });
    assert.equal(contract.dispatches, 5);
    assert.equal(contract.completions, 3, "partial outcomes must contribute to productive completion yield");
    assert.equal(contract.throttled, false, "yield=0.6 must not trigger throttle");
  });

  it("uses only the last ROLLING_YIELD_WINDOW_SIZE entries from the log", async () => {
    // 15 entries: first 5 all "done", last 10 all "failed" → window (last 10) has yield=0
    const entries = [
      ...Array.from({ length: 5 }, () => ({ role: "w", outcome: "done", timestamp: new Date().toISOString() })),
      ...Array.from({ length: 10 }, () => ({ role: "w", outcome: "failed", timestamp: new Date().toISOString() })),
    ];
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config, { windowSize: 10 });
    assert.equal(contract.dispatches, 10, "window must be exactly 10");
    assert.equal(contract.completions, 0, "last 10 entries are all failed");
    assert.equal(contract.throttled, true);
  });

  it("negative path: does not throttle when custom threshold is very low", async () => {
    // 3 dispatches, 1 done → yield = 0.33, above threshold=0.10
    const entries = [
      { role: "w", outcome: "done", timestamp: new Date().toISOString() },
      { role: "w", outcome: "failed", timestamp: new Date().toISOString() },
      { role: "w", outcome: "failed", timestamp: new Date().toISOString() },
    ];
    await fs.writeFile(path.join(tmpDir, "premium_usage_log.json"), JSON.stringify(entries), "utf8");
    const contract = await computeRollingCompletionYield(config, { threshold: 0.10, minDispatches: 3 });
    assert.equal(contract.throttled, false, "yield=0.33 must not throttle at threshold=0.10");
  });

  it("result always includes checkedAt ISO timestamp", async () => {
    const contract = await computeRollingCompletionYield(config);
    assert.ok(contract.checkedAt, "checkedAt must be present");
    assert.doesNotThrow(() => new Date(contract.checkedAt), "checkedAt must be a valid ISO date");
  });
});

