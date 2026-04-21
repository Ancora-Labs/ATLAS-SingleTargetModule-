/**
 * tests/core/experiment_registry.test.ts
 *
 * Covers all acceptance criteria for T-016 with deterministic pass/fail evidence.
 * Every critical flow includes at least one negative path asserting failure handling.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  validateExperiment,
  buildExperimentId,
  loadRegistry,
  saveRegistry,
  detectConflicts,
  registerExperiment,
  transitionExperiment,
  getRunningExperimentsForPath,
  getExperimentsByStatus,
  VALID_STATUSES,
  VALID_STOP_CONDITION_TYPES,
} from "../../src/core/experiment_registry.js";

// ── Test fixtures ─────────────────────────────────────────────────────────────

function validExperiment(overrides = {}) {
  return {
    experimentId: "exp-test-001",
    hypothesisId: "hyp-timeout-reduction",
    interventionId: "int-timeout-30min",
    treatmentGroup: "A",
    baselineWindow: {
      startAt: "2026-01-01T00:00:00.000Z",
      endAt: "2026-01-07T00:00:00.000Z",
      durationHours: 168
    },
    stopConditions: [
      { type: "max_duration_hours", value: 72 },
      { type: "error_rate_threshold", value: 0.1 }
    ],
    disproveCriteria: "Worker timeout rate increases by >5% compared to baseline",
    rollbackPlan: "Revert workerTimeoutMinutes to prior value via box.config.json",
    interventionScope: ["workerTimeoutMinutes"],
    status: "planned",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

async function freshStateDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-exp-test-"));
  return dir;
}

// ── Schema constants ──────────────────────────────────────────────────────────

describe("VALID_STATUSES (AC4, AC8)", () => {
  it("contains the four required status values", () => {
    assert.ok(VALID_STATUSES.has("planned"));
    assert.ok(VALID_STATUSES.has("running"));
    assert.ok(VALID_STATUSES.has("completed"));
    assert.ok(VALID_STATUSES.has("rolled_back"));
    assert.equal(VALID_STATUSES.size, 4);
  });

  it("does not contain non-standard values", () => {
    assert.ok(!VALID_STATUSES.has("pending"));
    assert.ok(!VALID_STATUSES.has("failed"));
  });
});

describe("VALID_STOP_CONDITION_TYPES (AC8)", () => {
  it("contains all four required stop condition types", () => {
    assert.ok(VALID_STOP_CONDITION_TYPES.has("max_duration_hours"));
    assert.ok(VALID_STOP_CONDITION_TYPES.has("error_rate_threshold"));
    assert.ok(VALID_STOP_CONDITION_TYPES.has("min_health_score"));
    assert.ok(VALID_STOP_CONDITION_TYPES.has("manual"));
    assert.equal(VALID_STOP_CONDITION_TYPES.size, 4);
  });
});

// ── validateExperiment (AC5, AC8, AC9) ───────────────────────────────────────

describe("validateExperiment — happy path (AC5, AC8)", () => {
  it("accepts a fully valid experiment definition", () => {
    const result = validateExperiment(validExperiment());
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("accepts all valid status values", () => {
    for (const status of VALID_STATUSES) {
      const result = validateExperiment(validExperiment({ status }));
      assert.equal(result.ok, true, `status=${status} should be valid`);
    }
  });

  it("accepts all valid stop condition types", () => {
    for (const type of VALID_STOP_CONDITION_TYPES) {
      const exp = validExperiment({ stopConditions: [{ type, value: 1 }] });
      const result = validateExperiment(exp);
      assert.equal(result.ok, true, `stopCondition type=${type} should be valid`);
    }
  });
});

describe("validateExperiment — missing fields (AC5, AC9: MISSING_FIELD code)", () => {
  it("rejects null input", () => {
    const r = validateExperiment(null);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === "MISSING_FIELD"));
  });

  it("rejects missing experimentId", () => {
    const { experimentId: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    const err = r.errors.find(e => e.field === "experimentId");
    assert.ok(err, "should have error for experimentId");
    assert.equal(err.code, "MISSING_FIELD");
  });

  it("rejects missing hypothesisId", () => {
    const { hypothesisId: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "hypothesisId" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing interventionId", () => {
    const { interventionId: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "interventionId" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing disproveCriteria", () => {
    const { disproveCriteria: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "disproveCriteria" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing rollbackPlan", () => {
    const { rollbackPlan: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "rollbackPlan" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing baselineWindow", () => {
    const { baselineWindow: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing baselineWindow.startAt", () => {
    const exp = validExperiment({ baselineWindow: { endAt: null, durationHours: 24 } });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow.startAt" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing baselineWindow.durationHours", () => {
    const exp = validExperiment({ baselineWindow: { startAt: "2026-01-01T00:00:00.000Z", endAt: null } });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow.durationHours" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing stopConditions", () => {
    const { stopConditions: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "stopConditions" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing interventionScope", () => {
    const { interventionScope: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "interventionScope" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing status", () => {
    const { status: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "status" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing stopCondition type", () => {
    const exp = validExperiment({ stopConditions: [{ value: 72 }] });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "stopConditions[0].type" && e.code === "MISSING_FIELD"));
  });

  it("rejects missing stopCondition value", () => {
    const exp = validExperiment({ stopConditions: [{ type: "max_duration_hours" }] });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "stopConditions[0].value" && e.code === "MISSING_FIELD"));
  });
});

describe("validateExperiment — invalid values (AC5, AC9: INVALID_VALUE code)", () => {
  it("rejects empty string experimentId", () => {
    const r = validateExperiment(validExperiment({ experimentId: "  " }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "experimentId" && e.code === "INVALID_VALUE"));
  });

  it("rejects invalid status value", () => {
    const r = validateExperiment(validExperiment({ status: "paused" }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "status" && e.code === "INVALID_VALUE"));
  });

  it("rejects invalid baselineWindow.startAt (non-ISO)", () => {
    const exp = validExperiment({ baselineWindow: { startAt: "not-a-date", endAt: null, durationHours: 24 } });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow.startAt" && e.code === "INVALID_VALUE"));
  });

  it("rejects invalid baselineWindow.endAt (non-ISO, non-null)", () => {
    const exp = validExperiment({
      baselineWindow: { startAt: "2026-01-01T00:00:00.000Z", endAt: "bad-date", durationHours: 24 }
    });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow.endAt" && e.code === "INVALID_VALUE"));
  });

  it("rejects zero durationHours", () => {
    const exp = validExperiment({
      baselineWindow: { startAt: "2026-01-01T00:00:00.000Z", endAt: null, durationHours: 0 }
    });
    const r = validateExperiment(exp);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "baselineWindow.durationHours" && e.code === "INVALID_VALUE"));
  });

  it("rejects empty stopConditions array", () => {
    const r = validateExperiment(validExperiment({ stopConditions: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "stopConditions" && e.code === "INVALID_VALUE"));
  });

  it("rejects unknown stop condition type", () => {
    const r = validateExperiment(validExperiment({ stopConditions: [{ type: "magic_condition", value: 1 }] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "stopConditions[0].type" && e.code === "INVALID_VALUE"));
  });

  it("rejects empty interventionScope array", () => {
    const r = validateExperiment(validExperiment({ interventionScope: [] }));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "interventionScope" && e.code === "INVALID_VALUE"));
  });

  it("rejects array input as root", () => {
    const r = validateExperiment([]);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.code === "MISSING_FIELD"));
  });
});

// ── buildExperimentId ─────────────────────────────────────────────────────────

describe("buildExperimentId", () => {
  it("returns a string prefixed with 'exp-'", () => {
    const id = buildExperimentId("hyp-1", "int-1", "A");
    assert.match(id, /^exp-[a-f0-9]{12}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = buildExperimentId("hyp-1", "int-1", "A");
    const b = buildExperimentId("hyp-1", "int-1", "A");
    assert.equal(a, b);
  });

  it("produces different IDs for different treatment groups", () => {
    const a = buildExperimentId("hyp-1", "int-1", "A");
    const b = buildExperimentId("hyp-1", "int-1", "B");
    assert.notEqual(a, b);
  });

  it("produces different IDs for different interventions", () => {
    const a = buildExperimentId("hyp-1", "int-1", "A");
    const b = buildExperimentId("hyp-1", "int-2", "A");
    assert.notEqual(a, b);
  });
});

// ── detectConflicts (AC3) ─────────────────────────────────────────────────────

describe("detectConflicts — config-path overlap (AC3)", () => {
  it("reports no conflict when no experiments are running", () => {
    const registry = { experiments: [] };
    const candidate = { experimentId: "exp-new", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, false);
    assert.deepEqual(result.conflictsWith, []);
    assert.deepEqual(result.sharedPaths, []);
  });

  it("reports no conflict when running experiment has no overlapping paths", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-existing", status: "running", interventionScope: ["maxRetries"] }
      ]
    };
    const candidate = { experimentId: "exp-new", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, false);
  });

  it("detects conflict when running experiment shares a config path", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-existing", status: "running", interventionScope: ["workerTimeoutMinutes", "maxRetries"] }
      ]
    };
    const candidate = { experimentId: "exp-new", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, true);
    assert.ok(result.conflictsWith.includes("exp-existing"));
    assert.ok(result.sharedPaths.includes("workerTimeoutMinutes"));
  });

  it("does not conflict with itself (self-transition to running)", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-self", status: "running", interventionScope: ["workerTimeoutMinutes"] }
      ]
    };
    const candidate = { experimentId: "exp-self", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, false);
  });

  it("ignores completed and planned experiments (not running)", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-completed", status: "completed", interventionScope: ["workerTimeoutMinutes"] },
        { experimentId: "exp-planned",   status: "planned",   interventionScope: ["workerTimeoutMinutes"] }
      ]
    };
    const candidate = { experimentId: "exp-new", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, false);
  });

  it("reports all conflicting experiments and deduplicated shared paths", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-a", status: "running", interventionScope: ["workerTimeoutMinutes", "maxRetries"] },
        { experimentId: "exp-b", status: "running", interventionScope: ["workerTimeoutMinutes"] }
      ]
    };
    const candidate = { experimentId: "exp-new", interventionScope: ["workerTimeoutMinutes"] };
    const result = detectConflicts(registry, candidate);
    assert.equal(result.hasConflict, true);
    assert.equal(result.conflictsWith.length, 2);
    // sharedPaths should be deduplicated
    assert.equal(result.sharedPaths.filter(p => p === "workerTimeoutMinutes").length, 1);
  });
});

// ── registerExperiment (AC4, AC5) ─────────────────────────────────────────────

describe("registerExperiment (AC4, AC5)", () => {
  it("registers a valid planned experiment and persists it", async () => {
    const dir = await freshStateDir();
    const exp = validExperiment({ experimentId: "exp-reg-001" });
    const result = await registerExperiment(dir, exp);
    assert.equal(result.ok, true);
    assert.equal(result.experimentId, "exp-reg-001");

    // Verify persistence
    const registry = await loadRegistry(dir);
    assert.equal(registry.experiments.length, 1);
    assert.equal(registry.experiments[0].experimentId, "exp-reg-001");
    assert.equal(registry.experiments[0].status, "planned");

    await fs.rm(dir, { recursive: true });
  });

  it("rejects registration of duplicate experimentId", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-dup" }));
    const result = await registerExperiment(dir, validExperiment({ experimentId: "exp-dup" }));
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "experimentId" && e.code === "INVALID_VALUE"));
    await fs.rm(dir, { recursive: true });
  });

  it("rejects registration of invalid experiment (missing disproveCriteria)", async () => {
    const dir = await freshStateDir();
    const { disproveCriteria: _, ...bad } = validExperiment();
    const result = await registerExperiment(dir, bad);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.field === "disproveCriteria"));
    await fs.rm(dir, { recursive: true });
  });

  it("blocks registration in running state when config-path conflict exists (AC3)", async () => {
    const dir = await freshStateDir();
    // Register and start first experiment
    await registerExperiment(dir, validExperiment({ experimentId: "exp-first", status: "planned" }));
    await transitionExperiment(dir, "exp-first", "running");

    // Attempt to register second experiment in running state with overlapping path
    const second = validExperiment({
      experimentId: "exp-second",
      status: "running",
      interventionScope: ["workerTimeoutMinutes"]
    });
    const result = await registerExperiment(dir, second);
    assert.equal(result.ok, false);
    assert.ok(result.conflict);
    assert.ok(result.conflict.hasConflict);
    assert.ok(result.conflict.sharedPaths.includes("workerTimeoutMinutes"));
    await fs.rm(dir, { recursive: true });
  });
});

// ── transitionExperiment (AC4) ────────────────────────────────────────────────

describe("transitionExperiment — valid transitions (AC4)", () => {
  it("transitions planned → running", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-t1" }));
    const r = await transitionExperiment(dir, "exp-t1", "running", "starting-trial");
    assert.equal(r.ok, true);
    assert.equal(r.status, "running");

    const registry = await loadRegistry(dir);
    const exp = registry.experiments.find(e => e.experimentId === "exp-t1");
    assert.equal(exp.status, "running");
    assert.ok(exp.startedAt);
    assert.equal(exp.statusReason, "starting-trial");
    await fs.rm(dir, { recursive: true });
  });

  it("transitions running → completed", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-t2" }));
    await transitionExperiment(dir, "exp-t2", "running");
    const r = await transitionExperiment(dir, "exp-t2", "completed", "hypothesis-confirmed");
    assert.equal(r.ok, true);

    const registry = await loadRegistry(dir);
    const exp = registry.experiments.find(e => e.experimentId === "exp-t2");
    assert.equal(exp.status, "completed");
    assert.ok(exp.completedAt);
    await fs.rm(dir, { recursive: true });
  });

  it("transitions running → rolled_back", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-t3" }));
    await transitionExperiment(dir, "exp-t3", "running");
    const r = await transitionExperiment(dir, "exp-t3", "rolled_back", "error-rate-exceeded");
    assert.equal(r.ok, true);

    const registry = await loadRegistry(dir);
    const exp = registry.experiments.find(e => e.experimentId === "exp-t3");
    assert.equal(exp.status, "rolled_back");
    assert.ok(exp.rolledBackAt);
    await fs.rm(dir, { recursive: true });
  });

  it("transitions completed → rolled_back", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-t4" }));
    await transitionExperiment(dir, "exp-t4", "running");
    await transitionExperiment(dir, "exp-t4", "completed");
    const r = await transitionExperiment(dir, "exp-t4", "rolled_back", "post-completion-revert");
    assert.equal(r.ok, true);
    await fs.rm(dir, { recursive: true });
  });
});

describe("transitionExperiment — invalid transitions (AC4, negative paths)", () => {
  it("rejects planned → completed (invalid leap)", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-inv1" }));
    const r = await transitionExperiment(dir, "exp-inv1", "completed");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "status" && e.code === "INVALID_VALUE"));
    await fs.rm(dir, { recursive: true });
  });

  it("rejects rolled_back → running (terminal status)", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-inv2" }));
    await transitionExperiment(dir, "exp-inv2", "running");
    await transitionExperiment(dir, "exp-inv2", "rolled_back");
    const r = await transitionExperiment(dir, "exp-inv2", "running");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "status" && e.code === "INVALID_VALUE"));
    await fs.rm(dir, { recursive: true });
  });

  it("rejects transition for non-existent experimentId", async () => {
    const dir = await freshStateDir();
    const r = await transitionExperiment(dir, "exp-ghost", "running");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "experimentId" && e.code === "INVALID_VALUE"));
    await fs.rm(dir, { recursive: true });
  });

  it("rejects transition with missing experimentId", async () => {
    const dir = await freshStateDir();
    const r = await transitionExperiment(dir, "", "running");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "experimentId" && e.code === "MISSING_FIELD"));
    await fs.rm(dir, { recursive: true });
  });

  it("rejects transition with invalid newStatus", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-inv3" }));
    const r = await transitionExperiment(dir, "exp-inv3", "in_progress");
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "status" && e.code === "INVALID_VALUE"));
    await fs.rm(dir, { recursive: true });
  });

  it("blocks transition to running when config-path conflict exists (AC3)", async () => {
    const dir = await freshStateDir();
    // First experiment is already running
    await registerExperiment(dir, validExperiment({ experimentId: "exp-a" }));
    await transitionExperiment(dir, "exp-a", "running");

    // Second experiment with overlapping scope
    await registerExperiment(dir, validExperiment({
      experimentId: "exp-b",
      interventionScope: ["workerTimeoutMinutes"]
    }));
    const r = await transitionExperiment(dir, "exp-b", "running");
    assert.equal(r.ok, false);
    assert.ok(r.conflict);
    assert.ok(r.conflict.hasConflict);
    assert.ok(r.conflict.sharedPaths.includes("workerTimeoutMinutes"));
    await fs.rm(dir, { recursive: true });
  });
});

// ── getRunningExperimentsForPath (AC1) ────────────────────────────────────────

describe("getRunningExperimentsForPath (AC1)", () => {
  it("returns IDs of running experiments that cover the path", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-run", status: "running", interventionScope: ["workerTimeoutMinutes", "maxRetries"] },
        { experimentId: "exp-planned", status: "planned", interventionScope: ["workerTimeoutMinutes"] }
      ]
    };
    const ids = getRunningExperimentsForPath(registry, "workerTimeoutMinutes");
    assert.deepEqual(ids, ["exp-run"]);
  });

  it("returns empty array when no running experiment covers the path", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-run", status: "running", interventionScope: ["maxRetries"] }
      ]
    };
    const ids = getRunningExperimentsForPath(registry, "workerTimeoutMinutes");
    assert.deepEqual(ids, []);
  });

  it("returns empty array for an empty registry", () => {
    const registry = { experiments: [] };
    const ids = getRunningExperimentsForPath(registry, "workerTimeoutMinutes");
    assert.deepEqual(ids, []);
  });

  it("returns multiple IDs when multiple running experiments cover the path", () => {
    const registry = {
      experiments: [
        { experimentId: "exp-1", status: "running", interventionScope: ["workerTimeoutMinutes"] },
        { experimentId: "exp-2", status: "running", interventionScope: ["workerTimeoutMinutes"] }
      ]
    };
    const ids = getRunningExperimentsForPath(registry, "workerTimeoutMinutes");
    assert.equal(ids.length, 2);
    assert.ok(ids.includes("exp-1"));
    assert.ok(ids.includes("exp-2"));
  });
});

// ── getExperimentsByStatus (AC4) ──────────────────────────────────────────────

describe("getExperimentsByStatus (AC4)", () => {
  it("returns experiments with the requested status", () => {
    const registry = {
      experiments: [
        { experimentId: "a", status: "planned" },
        { experimentId: "b", status: "running" },
        { experimentId: "c", status: "completed" },
        { experimentId: "d", status: "rolled_back" }
      ]
    };
    assert.equal(getExperimentsByStatus(registry, "planned").length, 1);
    assert.equal(getExperimentsByStatus(registry, "running").length, 1);
    assert.equal(getExperimentsByStatus(registry, "completed").length, 1);
    assert.equal(getExperimentsByStatus(registry, "rolled_back").length, 1);
  });

  it("returns empty array when no experiments match the status", () => {
    const registry = { experiments: [{ experimentId: "a", status: "planned" }] };
    assert.deepEqual(getExperimentsByStatus(registry, "running"), []);
  });
});

// ── Persistence (AC4, AC8) ────────────────────────────────────────────────────

describe("loadRegistry / saveRegistry (AC8 schema)", () => {
  it("returns default structure when no file exists", async () => {
    const dir = await freshStateDir();
    const registry = await loadRegistry(dir);
    assert.equal(registry.schemaVersion, 1);
    assert.ok(Array.isArray(registry.experiments));
    assert.equal(registry.experiments.length, 0);
    await fs.rm(dir, { recursive: true });
  });

  it("persists and reloads registry correctly", async () => {
    const dir = await freshStateDir();
    const registry = { schemaVersion: 1, experiments: [{ experimentId: "exp-persist", status: "planned" }] };
    await saveRegistry(dir, registry);
    const reloaded = await loadRegistry(dir);
    assert.equal(reloaded.experiments.length, 1);
    assert.equal(reloaded.experiments[0].experimentId, "exp-persist");
    assert.ok(reloaded.updatedAt); // saveRegistry stamps updatedAt
    await fs.rm(dir, { recursive: true });
  });
});

// ── Disprove and rollback clauses (AC2) ───────────────────────────────────────

describe("disproveCriteria and rollbackPlan enforcement (AC2)", () => {
  it("rejects experiment without disproveCriteria", () => {
    const { disproveCriteria: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "disproveCriteria"));
  });

  it("rejects experiment without rollbackPlan", () => {
    const { rollbackPlan: _, ...rest } = validExperiment();
    const r = validateExperiment(rest);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some(e => e.field === "rollbackPlan"));
  });

  it("accepts experiment with both disproveCriteria and rollbackPlan present", () => {
    const r = validateExperiment(validExperiment({
      disproveCriteria: "Timeout rate increases > 5%",
      rollbackPlan: "Revert workerTimeoutMinutes to 45"
    }));
    assert.equal(r.ok, true);
  });
});

// ── Full lifecycle (AC4, AC2, AC3) ────────────────────────────────────────────

describe("full experiment lifecycle (AC4)", () => {
  it("runs a complete planned→running→completed lifecycle", async () => {
    const dir = await freshStateDir();
    const exp = validExperiment({ experimentId: "exp-lifecycle" });

    // Register as planned
    const reg = await registerExperiment(dir, exp);
    assert.equal(reg.ok, true);

    // Start
    const start = await transitionExperiment(dir, "exp-lifecycle", "running", "trial-started");
    assert.equal(start.ok, true);

    // Complete
    const done = await transitionExperiment(dir, "exp-lifecycle", "completed", "hypothesis-confirmed");
    assert.equal(done.ok, true);

    // Verify final state
    const registry = await loadRegistry(dir);
    const final = registry.experiments.find(e => e.experimentId === "exp-lifecycle");
    assert.equal(final.status, "completed");
    assert.ok(final.startedAt);
    assert.ok(final.completedAt);

    await fs.rm(dir, { recursive: true });
  });

  it("runs a planned→running→rolled_back lifecycle with reason", async () => {
    const dir = await freshStateDir();
    await registerExperiment(dir, validExperiment({ experimentId: "exp-rollback" }));
    await transitionExperiment(dir, "exp-rollback", "running");
    await transitionExperiment(dir, "exp-rollback", "rolled_back", "stop-condition-exceeded");

    const registry = await loadRegistry(dir);
    const exp = registry.experiments.find(e => e.experimentId === "exp-rollback");
    assert.equal(exp.status, "rolled_back");
    assert.equal(exp.statusReason, "stop-condition-exceeded");
    assert.ok(exp.rolledBackAt);

    await fs.rm(dir, { recursive: true });
  });
});
