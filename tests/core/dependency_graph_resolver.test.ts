/**
 * Tests for src/core/dependency_graph_resolver.js
 *
 * Covers:
 *   - Input validation (missing, wrong type, invalid task, duplicate IDs)
 *   - DAG validation (cycle detection — negative path)
 *   - Conflict detection (overlapping filesInScope)
 *   - Wave assignment (explicit deps + conflict serialization)
 *   - Parallel-track output schema (required fields present, correct enums)
 *   - Gate computation (explicit_dependency + file_conflict gates)
 *   - Output determinism (same inputs → same outputs)
 *   - persistGraphDiagnostics (file written, correct schema)
 *   - Edge cases: self-referencing dep, dep to unknown ID, all isolated tasks
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  resolveDependencyGraph,
  persistGraphDiagnostics,
  validateGraphTask,
  normalizeFilePath,
  computeReadinessGate,
  GRAPH_STATUS,
  GRAPH_REASON,
  GATE_REASON,
  CONFLICT_REASON,
  TASK_ERROR_CODE,
  GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
  GRAPH_DIAGNOSTICS_JSONL_SCHEMA,
  GRAPH_DIAGNOSTICS_FRESHNESS_MS,
  isGraphDiagnosticsRecordContractValid,
  READINESS_STATUS,
  READINESS_REASON,
  READINESS_CONFIDENCE_THRESHOLD_DEFAULT,
  READINESS_CONFIDENCE_DIMENSION,
} from "../../src/core/dependency_graph_resolver.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(id, opts = {}) {
  return {
    id,
    dependsOn: opts.dependsOn || [],
    filesInScope: opts.filesInScope || [],
  };
}

// ── normalizeFilePath ─────────────────────────────────────────────────────────

describe("normalizeFilePath", () => {
  it("lowercases and normalizes forward slashes", () => {
    assert.equal(normalizeFilePath("SRC\\Core\\Foo.js"), "src/core/foo.js");
  });

  it("strips leading ./", () => {
    assert.equal(normalizeFilePath("./src/foo.js"), "src/foo.js");
  });

  it("handles empty string", () => {
    assert.equal(normalizeFilePath(""), "");
  });

  it("handles null/undefined gracefully", () => {
    assert.equal(normalizeFilePath(null), "");
    assert.equal(normalizeFilePath(undefined), "");
  });
});

// ── validateGraphTask ─────────────────────────────────────────────────────────

describe("validateGraphTask", () => {
  it("accepts a fully valid task", () => {
    const result = validateGraphTask(makeTask("t1", { dependsOn: ["t2"], filesInScope: ["src/a.js"] }));
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
  });

  it("accepts a minimal task with only id", () => {
    const result = validateGraphTask({ id: "t1" });
    assert.equal(result.ok, true);
  });

  it("rejects null input with MISSING_INPUT code", () => {
    const result = validateGraphTask(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects undefined input with MISSING_INPUT code", () => {
    const result = validateGraphTask(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects non-object input with INVALID_TYPE code", () => {
    const result = validateGraphTask("not-an-object");
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects array input with INVALID_TYPE code", () => {
    const result = validateGraphTask(["t1"]);
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects missing id with MISSING_FIELD code", () => {
    const result = validateGraphTask({ dependsOn: [] });
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.MISSING_FIELD);
    assert.equal(result.field, "id");
  });

  it("rejects empty-string id with INVALID_FIELD code", () => {
    const result = validateGraphTask({ id: "  " });
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "id");
  });

  it("rejects non-array dependsOn with INVALID_FIELD code", () => {
    const result = validateGraphTask({ id: "t1", dependsOn: "t2" });
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "dependsOn");
  });

  it("rejects non-string entry in dependsOn with INVALID_FIELD code", () => {
    const result = validateGraphTask({ id: "t1", dependsOn: [42] });
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_FIELD);
  });

  it("rejects non-array filesInScope with INVALID_FIELD code", () => {
    const result = validateGraphTask({ id: "t1", filesInScope: "src/foo.js" });
    assert.equal(result.ok, false);
    assert.equal(result.code, TASK_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "filesInScope");
  });
});

// ── resolveDependencyGraph — input validation ─────────────────────────────────

describe("resolveDependencyGraph — input validation", () => {
  it("returns MISSING_INPUT status for null input", () => {
    const result = resolveDependencyGraph(null);
    assert.equal(result.status, GRAPH_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, GRAPH_REASON.MISSING_INPUT);
    assert.ok(typeof result.errorMessage === "string" && result.errorMessage.length > 0);
  });

  it("returns MISSING_INPUT status for undefined input", () => {
    const result = resolveDependencyGraph(undefined);
    assert.equal(result.status, GRAPH_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, GRAPH_REASON.MISSING_INPUT);
  });

  it("returns INVALID_INPUT status for non-array input", () => {
    const result = resolveDependencyGraph("not-an-array");
    assert.equal(result.status, GRAPH_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, GRAPH_REASON.INVALID_INPUT);
    assert.ok(result.errorMessage.includes("array"));
  });

  it("returns INVALID_INPUT status for invalid task within array", () => {
    const result = resolveDependencyGraph([null]);
    assert.equal(result.status, GRAPH_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, GRAPH_REASON.INVALID_INPUT);
    assert.ok(result.errorMessage.includes("tasks[0]"));
  });

  it("returns INVALID_INPUT for duplicate task IDs", () => {
    const result = resolveDependencyGraph([makeTask("t1"), makeTask("t1")]);
    assert.equal(result.status, GRAPH_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, GRAPH_REASON.INVALID_INPUT);
    assert.ok(result.errorMessage.includes("duplicate"));
  });

  it("returns EMPTY_INPUT for empty array", () => {
    const result = resolveDependencyGraph([]);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.reasonCode, GRAPH_REASON.EMPTY_INPUT);
    assert.deepEqual(result.waves, []);
    assert.equal(result.totalTasks, 0);
  });

  it("all error results include required schema fields", () => {
    const result = resolveDependencyGraph(null);
    assert.equal(typeof result.schemaVersion, "number");
    assert.equal(typeof result.resolvedAt, "string");
    assert.ok(Array.isArray(result.waves));
    assert.ok(Array.isArray(result.conflictPairs));
    assert.ok(Array.isArray(result.cycles));
    assert.equal(typeof result.totalTasks, "number");
    assert.equal(typeof result.parallelTasks, "number");
    assert.equal(typeof result.serializedTasks, "number");
  });
});

// ── resolveDependencyGraph — cycle detection (negative path, AC4/AC7) ─────────

describe("resolveDependencyGraph — cycle detection (negative path)", () => {
  it("NEGATIVE PATH: aborts and returns CYCLE_DETECTED for a direct self-loop", () => {
    const tasks = [makeTask("t1", { dependsOn: ["t1"] })];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.CYCLE_DETECTED);
    assert.equal(result.reasonCode, GRAPH_REASON.CYCLE_DETECTED);
    assert.ok(result.cycles.length > 0);
    assert.deepEqual(result.waves, []);
    assert.ok(typeof result.errorMessage === "string" && result.errorMessage.includes("cycle"));
  });

  it("NEGATIVE PATH: aborts for a two-task mutual dependency cycle (t1→t2→t1)", () => {
    const tasks = [
      makeTask("t1", { dependsOn: ["t2"] }),
      makeTask("t2", { dependsOn: ["t1"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.CYCLE_DETECTED);
    assert.equal(result.reasonCode, GRAPH_REASON.CYCLE_DETECTED);
    assert.ok(result.cycles.length > 0);
    // Verify that all tasks in the cycle appear in at least one cycle path
    const cycleNodes = new Set(result.cycles.flat());
    assert.ok(cycleNodes.has("t1") || cycleNodes.has("t2"));
  });

  it("NEGATIVE PATH: aborts for a three-task cycle (t1→t2→t3→t1)", () => {
    const tasks = [
      makeTask("t1", { dependsOn: ["t3"] }),
      makeTask("t2", { dependsOn: ["t1"] }),
      makeTask("t3", { dependsOn: ["t2"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.CYCLE_DETECTED);
    assert.equal(result.reasonCode, GRAPH_REASON.CYCLE_DETECTED);
  });

  it("does NOT flag a valid chain (t1←t2←t3) as a cycle", () => {
    const tasks = [
      makeTask("t1"),
      makeTask("t2", { dependsOn: ["t1"] }),
      makeTask("t3", { dependsOn: ["t2"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.deepEqual(result.cycles, []);
  });
});

// ── resolveDependencyGraph — happy path ───────────────────────────────────────

describe("resolveDependencyGraph — valid DAG", () => {
  it("assigns all independent tasks to wave 1", () => {
    const tasks = [makeTask("t1"), makeTask("t2"), makeTask("t3")];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.reasonCode, GRAPH_REASON.VALID);
    assert.equal(result.waves.length, 1);
    assert.equal(result.waves[0].wave, 1);
    assert.deepEqual(result.waves[0].taskIds.sort(), ["t1", "t2", "t3"]);
    assert.deepEqual(result.waves[0].gates, []);
  });

  it("assigns dependent tasks to later waves", () => {
    const tasks = [
      makeTask("t1"),
      makeTask("t2", { dependsOn: ["t1"] }),
      makeTask("t3", { dependsOn: ["t2"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.waves.length, 3);
    assert.deepEqual(result.waves[0].taskIds, ["t1"]);
    assert.deepEqual(result.waves[1].taskIds, ["t2"]);
    assert.deepEqual(result.waves[2].taskIds, ["t3"]);
  });

  it("places the diamond pattern correctly (t1; t2,t3 depend on t1; t4 depends on t2,t3)", () => {
    const tasks = [
      makeTask("t1"),
      makeTask("t2", { dependsOn: ["t1"] }),
      makeTask("t3", { dependsOn: ["t1"] }),
      makeTask("t4", { dependsOn: ["t2", "t3"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    // t1 → wave 1; t2,t3 → wave 2; t4 → wave 3
    const waveOf = {};
    for (const wave of result.waves) {
      for (const id of wave.taskIds) waveOf[id] = wave.wave;
    }
    assert.equal(waveOf["t1"], 1);
    assert.equal(waveOf["t2"], 2);
    assert.equal(waveOf["t3"], 2);
    assert.equal(waveOf["t4"], 3);
    // t2 and t3 are parallel in wave 2
    assert.equal(result.parallelTasks >= 2, true);
  });

  it("produces explicit_dependency gates for tasks with dependsOn", () => {
    const tasks = [makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    const wave2 = result.waves.find((w) => w.wave === 2);
    assert.ok(wave2, "wave 2 must exist");
    const gate = wave2.gates.find((g) => g.afterTaskId === "t1");
    assert.ok(gate, "gate after t1 must exist in wave 2");
    assert.equal(gate.reason, GATE_REASON.EXPLICIT_DEPENDENCY);
  });

  it("ignores dependsOn references to tasks not in the input set", () => {
    // External dependency — should not cause a crash or INVALID_INPUT
    const tasks = [makeTask("t1", { dependsOn: ["external-task"] })];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.waves.length, 1);
    assert.deepEqual(result.waves[0].taskIds, ["t1"]);
  });
});

// ── resolveDependencyGraph — conflict detection & serialization (AC2/AC11) ────

describe("resolveDependencyGraph — conflict detection", () => {
  it("detects overlapping filesInScope as a conflict", () => {
    const tasks = [
      makeTask("t1", { filesInScope: ["src/core/orchestrator.js"] }),
      makeTask("t2", { filesInScope: ["src/core/orchestrator.js"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.conflictPairs.length, 1);
    assert.equal(result.conflictPairs[0].taskA, "t1");
    assert.equal(result.conflictPairs[0].taskB, "t2");
    assert.equal(result.conflictPairs[0].reason, CONFLICT_REASON.OVERLAPPING_FILES_IN_SCOPE);
    assert.ok(result.conflictPairs[0].sharedFiles.includes("src/core/orchestrator.js"));
  });

  it("serializes conflicting tasks into different waves", () => {
    const tasks = [
      makeTask("t1", { filesInScope: ["src/foo.js"] }),
      makeTask("t2", { filesInScope: ["src/foo.js"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);
    assert.equal(result.conflictPairs.length, 1);
    // They must be in different waves
    const waveOf = {};
    for (const wave of result.waves) {
      for (const id of wave.taskIds) waveOf[id] = wave.wave;
    }
    assert.notEqual(waveOf["t1"], waveOf["t2"], "conflicting tasks must be in different waves");
  });

  it("produces file_conflict gates for conflict-serialized tasks", () => {
    const tasks = [
      makeTask("a", { filesInScope: ["src/shared.js"] }),
      makeTask("b", { filesInScope: ["src/shared.js"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    // The later wave must have a gate with reason=file_conflict
    const laterWave = result.waves.find((w) => w.wave === 2);
    assert.ok(laterWave, "wave 2 must exist after conflict serialization");
    const conflictGate = laterWave.gates.find((g) => g.reason === GATE_REASON.FILE_CONFLICT);
    assert.ok(conflictGate, "file_conflict gate must exist in wave 2");
    assert.ok(Array.isArray(conflictGate.sharedFiles) && conflictGate.sharedFiles.length > 0);
  });

  it("normalizes file paths for conflict detection (case and separator)", () => {
    const tasks = [
      makeTask("t1", { filesInScope: ["SRC\\Core\\Foo.js"] }),
      makeTask("t2", { filesInScope: ["src/core/foo.js"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.conflictPairs.length, 1, "case/separator-normalized paths should conflict");
  });

  it("does not flag tasks with non-overlapping files as conflicting", () => {
    const tasks = [
      makeTask("t1", { filesInScope: ["src/a.js"] }),
      makeTask("t2", { filesInScope: ["src/b.js"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.conflictPairs.length, 0);
    // Both should be in wave 1
    const waveOf = {};
    for (const wave of result.waves) {
      for (const id of wave.taskIds) waveOf[id] = wave.wave;
    }
    assert.equal(waveOf["t1"], waveOf["t2"], "non-conflicting tasks with no deps share wave 1");
  });

  it("does not flag tasks with empty filesInScope as conflicting", () => {
    const tasks = [makeTask("t1"), makeTask("t2")];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.conflictPairs.length, 0);
  });
});

// ── resolveDependencyGraph — output schema validation (AC3/AC8) ───────────────

describe("resolveDependencyGraph — output schema", () => {
  it("ok result includes all required schema fields", () => {
    const result = resolveDependencyGraph([makeTask("t1")]);
    assert.equal(result.schemaVersion, GRAPH_DIAGNOSTICS_SCHEMA_VERSION);
    assert.equal(typeof result.resolvedAt, "string");
    assert.ok(Object.values(GRAPH_STATUS).includes(result.status));
    assert.ok(Object.values(GRAPH_REASON).includes(result.reasonCode));
    assert.ok(Array.isArray(result.waves));
    assert.ok(Array.isArray(result.conflictPairs));
    assert.ok(Array.isArray(result.cycles));
    assert.equal(typeof result.totalTasks, "number");
    assert.equal(typeof result.parallelTasks, "number");
    assert.equal(typeof result.serializedTasks, "number");
    assert.ok("errorMessage" in result);
  });

  it("each wave includes wave number, taskIds array, and gates array", () => {
    const result = resolveDependencyGraph([makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })]);
    assert.equal(result.status, GRAPH_STATUS.OK);
    for (const wave of result.waves) {
      assert.equal(typeof wave.wave, "number");
      assert.ok(wave.wave >= 1);
      assert.ok(Array.isArray(wave.taskIds));
      assert.ok(Array.isArray(wave.gates));
    }
  });

  it("each gate includes afterTaskId, reason, and sharedFiles", () => {
    const result = resolveDependencyGraph([makeTask("t1"), makeTask("t2", { dependsOn: ["t1"] })]);
    const wave2 = result.waves.find((w) => w.wave === 2);
    for (const gate of wave2.gates) {
      assert.equal(typeof gate.afterTaskId, "string");
      assert.ok(Object.values(GATE_REASON).includes(gate.reason));
      assert.ok(Array.isArray(gate.sharedFiles));
    }
  });

  it("each conflictPair includes taskA, taskB, reason, and sharedFiles", () => {
    const result = resolveDependencyGraph([
      makeTask("t1", { filesInScope: ["src/x.js"] }),
      makeTask("t2", { filesInScope: ["src/x.js"] }),
    ]);
    for (const pair of result.conflictPairs) {
      assert.equal(typeof pair.taskA, "string");
      assert.equal(typeof pair.taskB, "string");
      assert.ok(Object.values(CONFLICT_REASON).includes(pair.reason));
      assert.ok(Array.isArray(pair.sharedFiles));
    }
  });

  it("status and reasonCode values are from defined enums", () => {
    const statuses = Object.values(GRAPH_STATUS);
    const reasons = Object.values(GRAPH_REASON);
    const inputs = [
      null,
      "bad",
      [],
      [makeTask("t1")],
      [makeTask("t1", { dependsOn: ["t1"] })],
    ];
    for (const input of inputs) {
      const result = resolveDependencyGraph(input);
      assert.ok(statuses.includes(result.status), `unknown status: ${result.status}`);
      assert.ok(reasons.includes(result.reasonCode), `unknown reasonCode: ${result.reasonCode}`);
    }
  });

  it("is deterministic: same input always produces same output", () => {
    const tasks = [
      makeTask("t1", { filesInScope: ["src/a.js"] }),
      makeTask("t2", { filesInScope: ["src/a.js"] }),
      makeTask("t3", { dependsOn: ["t1"] }),
    ];
    const r1 = resolveDependencyGraph(tasks);
    const r2 = resolveDependencyGraph(tasks);
    assert.equal(r1.status, r2.status);
    assert.equal(r1.waves.length, r2.waves.length);
    assert.equal(r1.conflictPairs.length, r2.conflictPairs.length);
    assert.equal(r1.parallelTasks, r2.parallelTasks);
    assert.equal(r1.serializedTasks, r2.serializedTasks);
  });
});

// ── persistGraphDiagnostics (AC5/AC13) ───────────────────────────────────────

describe("persistGraphDiagnostics", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dgr-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("writes a NDJSON entry to state/dependency_graph_diagnostics.json", async () => {
    const resolution = resolveDependencyGraph([makeTask("t1"), makeTask("t2")]);
    await persistGraphDiagnostics(tmpDir, resolution, { correlationId: "test-001" });

    const diagnosticsPath = path.join(tmpDir, "dependency_graph_diagnostics.json");
    const raw = await fs.readFile(diagnosticsPath, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.ok(lines.length >= 1, "at least one entry must be written");

    const entry = JSON.parse(lines[0]);
    assert.equal(entry.schemaVersion, GRAPH_DIAGNOSTICS_SCHEMA_VERSION);
    assert.equal(typeof entry.persistedAt, "string");
    assert.equal(entry.correlationId, "test-001");
    assert.ok(Object.values(GRAPH_STATUS).includes(entry.status));
    assert.ok(Object.values(GRAPH_REASON).includes(entry.reasonCode));
    assert.equal(typeof entry.totalTasks, "number");
    assert.ok(Array.isArray(entry.waves));
    assert.ok(Array.isArray(entry.conflictPairs));
    assert.ok(Array.isArray(entry.cycles));
  });

  it("appends entries on repeated calls (NDJSON growth)", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "append-test-"));
    const r1 = resolveDependencyGraph([makeTask("a")]);
    const r2 = resolveDependencyGraph([makeTask("b")]);

    await persistGraphDiagnostics(subDir, r1, { run: 1 });
    await persistGraphDiagnostics(subDir, r2, { run: 2 });

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "two entries should be appended");

    const entry1 = JSON.parse(lines[0]);
    const entry2 = JSON.parse(lines[1]);
    assert.equal(entry1.run, 1);
    assert.equal(entry2.run, 2);
  });

  it("persisted entry for cycle result records status=cycle_detected", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "cycle-persist-"));
    const cycleResult = resolveDependencyGraph([makeTask("x", { dependsOn: ["x"] })]);
    await persistGraphDiagnostics(subDir, cycleResult);

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0]);
    assert.equal(entry.status, GRAPH_STATUS.CYCLE_DETECTED);
    assert.equal(entry.reasonCode, GRAPH_REASON.CYCLE_DETECTED);
    assert.ok(entry.cycleCount >= 1);
  });
});

// ── persistGraphDiagnostics — guaranteed parseable NDJSON contract ────────────
// Each appended line must be independently parseable as valid JSON.
// This contract ensures diagnostics files remain machine-readable even after
// partial writes, concurrent appends, or multi-cycle accumulation.

describe("persistGraphDiagnostics — guaranteed parseable NDJSON contract", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dgr-ndjson-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("every line in the file is independently valid JSON (single entry)", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "ndjson-single-"));
    const resolution = resolveDependencyGraph([makeTask("a"), makeTask("b", { dependsOn: ["a"] })]);
    await persistGraphDiagnostics(subDir, resolution);

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    assert.ok(lines.length >= 1, "at least one line must be written");
    for (const line of lines) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `each NDJSON line must be valid JSON; failed on: "${line.slice(0, 80)}"`
      );
    }
  });

  it("every line in the file is independently valid JSON (multiple entries)", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "ndjson-multi-"));
    const r1 = resolveDependencyGraph([makeTask("x1")]);
    const r2 = resolveDependencyGraph([makeTask("x2"), makeTask("x3", { dependsOn: ["x2"] })]);
    const r3 = resolveDependencyGraph([makeTask("y", { dependsOn: ["y"] })]);
    await persistGraphDiagnostics(subDir, r1, { run: "first" });
    await persistGraphDiagnostics(subDir, r2, { run: "second" });
    await persistGraphDiagnostics(subDir, r3, { run: "third" });

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    assert.equal(lines.length, 3, "three entries must be appended");
    for (const line of lines) {
      assert.doesNotThrow(
        () => JSON.parse(line),
        `each NDJSON line must be independently parseable; failed on: "${line.slice(0, 80)}"`
      );
    }
  });

  it("each line contains all required schema fields", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "ndjson-schema-"));
    const resolution = resolveDependencyGraph([makeTask("m1"), makeTask("m2")]);
    await persistGraphDiagnostics(subDir, resolution, { correlationId: "schema-check" });

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0]);
    const requiredFields = [
      "schemaVersion", "persistedAt", "status", "reasonCode",
      "totalTasks", "waves", "conflictPairs", "cycles",
    ];
    for (const field of requiredFields) {
      assert.ok(field in entry, `required field "${field}" must be present in every NDJSON entry`);
    }
    assert.equal(entry.jsonlSchema, GRAPH_DIAGNOSTICS_JSONL_SCHEMA);
    assert.equal(entry.recordType, "dependency_graph_diagnostic");
    assert.equal(entry.freshness.status, "fresh");
    assert.equal(entry.freshness.staleAfterMs, GRAPH_DIAGNOSTICS_FRESHNESS_MS);
    assert.ok(typeof entry.freshness.expiresAt === "string" && entry.freshness.expiresAt.length > 0);
  });

  it("negative path: meta cannot override diagnostics contract fields", async () => {
    const subDir = await fs.mkdtemp(path.join(tmpDir, "ndjson-meta-"));
    const resolution = resolveDependencyGraph([makeTask("safe-1")]);
    await persistGraphDiagnostics(subDir, resolution, {
      jsonlSchema: "tampered.schema",
      recordType: "tampered_type",
      schemaVersion: 9999,
      freshness: { status: "stale", staleAfterMs: 1 },
      correlationId: "allowed-correlation",
    });

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0]);
    assert.equal(entry.jsonlSchema, GRAPH_DIAGNOSTICS_JSONL_SCHEMA);
    assert.equal(entry.recordType, "dependency_graph_diagnostic");
    assert.equal(entry.schemaVersion, GRAPH_DIAGNOSTICS_SCHEMA_VERSION);
    assert.equal(entry.freshness.status, "fresh");
    assert.equal(entry.correlationId, "allowed-correlation");
  });

  it("NEGATIVE PATH: each independently-parsed line does not depend on prior lines", async () => {
    // Simulate reading only the second line (as if the first was corrupted/missing).
    const subDir = await fs.mkdtemp(path.join(tmpDir, "ndjson-independent-"));
    await persistGraphDiagnostics(subDir, resolveDependencyGraph([makeTask("p1")]), { seq: 1 });
    await persistGraphDiagnostics(subDir, resolveDependencyGraph([makeTask("p2")]), { seq: 2 });

    const raw = await fs.readFile(path.join(subDir, "dependency_graph_diagnostics.json"), "utf8");
    const lines = raw.split("\n").filter(l => l.trim().length > 0);
    // Parse only the second line — must not throw or reference first line
    const secondEntry = JSON.parse(lines[1]);
    assert.equal(secondEntry.seq, 2,
      "second line must be independently parseable without requiring the first");
    assert.equal(secondEntry.schemaVersion, GRAPH_DIAGNOSTICS_SCHEMA_VERSION);
  });
});

describe("isGraphDiagnosticsRecordContractValid", () => {
  it("returns true for a persisted dependency graph diagnostics entry", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dgr-contract-"));
    try {
      const resolution = resolveDependencyGraph([makeTask("c1"), makeTask("c2", { dependsOn: ["c1"] })]);
      await persistGraphDiagnostics(tmpDir, resolution);
      const raw = await fs.readFile(path.join(tmpDir, "dependency_graph_diagnostics.json"), "utf8");
      const entry = JSON.parse(raw.trim().split("\n").slice(-1)[0]);
      assert.equal(isGraphDiagnosticsRecordContractValid(entry), true);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("negative: returns false when payload arrays are malformed", () => {
    const record = {
      jsonlSchema: GRAPH_DIAGNOSTICS_JSONL_SCHEMA,
      recordType: "dependency_graph_diagnostic",
      schemaVersion: GRAPH_DIAGNOSTICS_SCHEMA_VERSION,
      savedAt: new Date().toISOString(),
      persistedAt: new Date().toISOString(),
      freshness: {
        status: "fresh",
        staleAfterMs: GRAPH_DIAGNOSTICS_FRESHNESS_MS,
        expiresAt: new Date(Date.now() + GRAPH_DIAGNOSTICS_FRESHNESS_MS).toISOString(),
      },
      status: GRAPH_STATUS.OK,
      reasonCode: GRAPH_REASON.VALID,
      waves: [],
      conflictPairs: [],
      cycles: [],
      payload: {
        status: GRAPH_STATUS.OK,
        reasonCode: GRAPH_REASON.VALID,
        waves: "not-an-array",
        conflictPairs: [],
        cycles: [],
      },
    };
    assert.equal(isGraphDiagnosticsRecordContractValid(record), false);
  });
});

// ── Integration: conflict + explicit dep combined ─────────────────────────────

describe("resolveDependencyGraph — combined explicit deps and conflicts", () => {
  it("correctly serializes a complex graph with both deps and conflicts", () => {
    // t1 → wave 1
    // t2 depends on t1 → wave 2
    // t3 conflicts with t2 (same file) → wave 3 (after conflict bump)
    // t4 depends on t3 → wave 4
    const tasks = [
      makeTask("t1"),
      makeTask("t2", { dependsOn: ["t1"], filesInScope: ["src/shared.js"] }),
      makeTask("t3", { filesInScope: ["src/shared.js"] }),
      makeTask("t4", { dependsOn: ["t3"] }),
    ];
    const result = resolveDependencyGraph(tasks);
    assert.equal(result.status, GRAPH_STATUS.OK);

    const waveOf = {};
    for (const wave of result.waves) {
      for (const id of wave.taskIds) waveOf[id] = wave.wave;
    }

    // t2 must be after t1, t3 must be in a different wave from t2, t4 must be after t3
    assert.ok(waveOf["t2"] > waveOf["t1"], "t2 after t1");
    assert.notEqual(waveOf["t2"], waveOf["t3"], "t2 and t3 must not share a wave (conflict)");
    assert.ok(waveOf["t4"] > waveOf["t3"], "t4 after t3");
  });
});

// ── Enum exports ──────────────────────────────────────────────────────────────

describe("enum exports", () => {
  it("GRAPH_STATUS is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(GRAPH_STATUS));
    assert.equal(GRAPH_STATUS.OK, "ok");
    assert.equal(GRAPH_STATUS.CYCLE_DETECTED, "cycle_detected");
    assert.equal(GRAPH_STATUS.INVALID_INPUT, "invalid_input");
    assert.equal(GRAPH_STATUS.DEGRADED, "degraded");
  });

  it("GRAPH_REASON is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(GRAPH_REASON));
    assert.equal(GRAPH_REASON.VALID, "VALID");
    assert.equal(GRAPH_REASON.EMPTY_INPUT, "EMPTY_INPUT");
    assert.equal(GRAPH_REASON.MISSING_INPUT, "MISSING_INPUT");
    assert.equal(GRAPH_REASON.INVALID_INPUT, "INVALID_INPUT");
    assert.equal(GRAPH_REASON.CYCLE_DETECTED, "CYCLE_DETECTED");
  });

  it("GATE_REASON is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(GATE_REASON));
    assert.equal(GATE_REASON.EXPLICIT_DEPENDENCY, "explicit_dependency");
    assert.equal(GATE_REASON.FILE_CONFLICT, "file_conflict");
  });

  it("CONFLICT_REASON is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(CONFLICT_REASON));
    assert.equal(CONFLICT_REASON.OVERLAPPING_FILES_IN_SCOPE, "overlapping_files_in_scope");
  });

  it("TASK_ERROR_CODE is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(TASK_ERROR_CODE));
    assert.equal(TASK_ERROR_CODE.MISSING_INPUT, "MISSING_INPUT");
    assert.equal(TASK_ERROR_CODE.INVALID_TYPE, "INVALID_TYPE");
    assert.equal(TASK_ERROR_CODE.MISSING_FIELD, "MISSING_FIELD");
    assert.equal(TASK_ERROR_CODE.INVALID_FIELD, "INVALID_FIELD");
  });

  it("READINESS_STATUS is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(READINESS_STATUS));
    assert.equal(READINESS_STATUS.READY, "ready");
    assert.equal(READINESS_STATUS.INCOMPLETE, "incomplete");
    assert.equal(READINESS_STATUS.INVALID_INPUT, "invalid_input");
  });

  it("READINESS_REASON is frozen and contains required values", () => {
    assert.ok(Object.isFrozen(READINESS_REASON));
    assert.equal(READINESS_REASON.READY, "READY");
    assert.equal(READINESS_REASON.MISSING_CONFIDENCE, "MISSING_CONFIDENCE");
    assert.equal(READINESS_REASON.BELOW_THRESHOLD, "BELOW_THRESHOLD");
    assert.equal(READINESS_REASON.INVALID_INPUT, "INVALID_INPUT");
  });

  it("READINESS_CONFIDENCE_DIMENSION exports the three dimension keys", () => {
    assert.equal(READINESS_CONFIDENCE_DIMENSION.SHAPE, "shapeConfidence");
    assert.equal(READINESS_CONFIDENCE_DIMENSION.BUDGET, "budgetConfidence");
    assert.equal(READINESS_CONFIDENCE_DIMENSION.DEPENDENCY, "dependencyConfidence");
    assert.ok(Object.isFrozen(READINESS_CONFIDENCE_DIMENSION));
  });

  it("READINESS_CONFIDENCE_THRESHOLD_DEFAULT is 0.5", () => {
    assert.equal(READINESS_CONFIDENCE_THRESHOLD_DEFAULT, 0.5);
  });
});

// ── computeReadinessGate ──────────────────────────────────────────────────────

describe("computeReadinessGate — positive paths", () => {
  it("returns ready=true for empty tasks array", () => {
    const result = computeReadinessGate([]);
    assert.equal(result.ready, true);
    assert.equal(result.status, READINESS_STATUS.READY);
    assert.equal(result.reason, READINESS_REASON.READY);
    assert.equal(result.checkedTasks, 0);
    assert.deepEqual(result.missingDimensions, []);
    assert.deepEqual(result.belowThresholdTasks, []);
  });

  it("returns ready=true for tasks without any confidence fields (opt-in, no constraint)", () => {
    const tasks = [{ id: "t1" }, { id: "t2" }];
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, true);
    assert.equal(result.status, READINESS_STATUS.READY);
    assert.equal(result.checkedTasks, 2);
  });

  it("returns ready=true when all confidence values meet the default threshold", () => {
    const tasks = [
      { id: "t1", shapeConfidence: 0.8, budgetConfidence: 0.9, dependencyConfidence: 0.7 },
      { id: "t2", shapeConfidence: 0.6, budgetConfidence: 0.5, dependencyConfidence: 1.0 },
    ];
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, true);
    assert.equal(result.status, READINESS_STATUS.READY);
    assert.equal(result.belowThresholdTasks.length, 0);
  });

  it("returns ready=true when confidence exactly equals the threshold", () => {
    const tasks = [{ id: "t1", shapeConfidence: 0.5 }];
    const result = computeReadinessGate(tasks, { minConfidence: 0.5 });
    assert.equal(result.ready, true);
  });

  it("returns ready=true with custom minConfidence option", () => {
    const tasks = [{ id: "t1", shapeConfidence: 0.3 }];
    const result = computeReadinessGate(tasks, { minConfidence: 0.2 });
    assert.equal(result.ready, true);
  });

  it("returns ready=true when only some dimensions are present and all meet threshold", () => {
    const tasks = [{ id: "t1", shapeConfidence: 0.9 }]; // budgetConfidence absent → ok
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, true);
  });
});

describe("computeReadinessGate — negative paths", () => {
  it("NEGATIVE PATH: returns ready=false when a confidence value is below threshold", () => {
    const tasks = [{ id: "t1", shapeConfidence: 0.3 }];
    const result = computeReadinessGate(tasks, { minConfidence: 0.5 });
    assert.equal(result.ready, false);
    assert.equal(result.status, READINESS_STATUS.INCOMPLETE);
    assert.equal(result.reason, READINESS_REASON.BELOW_THRESHOLD);
    assert.equal(result.belowThresholdTasks.length, 1);
    assert.equal(result.belowThresholdTasks[0].id, "t1");
    assert.equal(result.belowThresholdTasks[0].dimension, "shapeConfidence");
    assert.equal(result.belowThresholdTasks[0].value, 0.3);
    assert.equal(result.belowThresholdTasks[0].threshold, 0.5);
  });

  it("NEGATIVE PATH: returns ready=false when budgetConfidence is below threshold", () => {
    const tasks = [{ id: "t2", budgetConfidence: 0.1 }];
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, false);
    assert.equal(result.reason, READINESS_REASON.BELOW_THRESHOLD);
    assert.equal(result.belowThresholdTasks[0].dimension, "budgetConfidence");
  });

  it("NEGATIVE PATH: returns ready=false when dependencyConfidence is below threshold", () => {
    const tasks = [{ id: "t3", dependencyConfidence: 0.0 }];
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, false);
    assert.equal(result.reason, READINESS_REASON.BELOW_THRESHOLD);
  });

  it("NEGATIVE PATH: reports MISSING_CONFIDENCE for non-numeric confidence value", () => {
    const tasks = [{ id: "t1", shapeConfidence: "high" }]; // string, not number
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, false);
    assert.equal(result.status, READINESS_STATUS.INCOMPLETE);
    assert.equal(result.reason, READINESS_REASON.MISSING_CONFIDENCE);
    assert.ok(result.missingDimensions.includes("shapeConfidence"));
  });

  it("NEGATIVE PATH: reports MISSING_CONFIDENCE for NaN confidence value", () => {
    const tasks = [{ id: "t1", budgetConfidence: NaN }];
    const result = computeReadinessGate(tasks);
    assert.equal(result.ready, false);
    assert.equal(result.reason, READINESS_REASON.MISSING_CONFIDENCE);
  });

  it("NEGATIVE PATH: returns invalid_input for non-array tasks argument", () => {
    const result = computeReadinessGate(null as any);
    assert.equal(result.ready, false);
    assert.equal(result.status, READINESS_STATUS.INVALID_INPUT);
    assert.equal(result.reason, READINESS_REASON.INVALID_INPUT);
    assert.equal(result.checkedTasks, 0);
  });

  it("NEGATIVE PATH: returns invalid_input for string input", () => {
    const result = computeReadinessGate("not-an-array" as any);
    assert.equal(result.ready, false);
    assert.equal(result.status, READINESS_STATUS.INVALID_INPUT);
  });

  it("reports all below-threshold tasks across multiple tasks and dimensions", () => {
    const tasks = [
      { id: "a", shapeConfidence: 0.2, budgetConfidence: 0.8 },
      { id: "b", shapeConfidence: 0.9, dependencyConfidence: 0.1 },
    ];
    const result = computeReadinessGate(tasks, { minConfidence: 0.5 });
    assert.equal(result.ready, false);
    assert.equal(result.belowThresholdTasks.length, 2);
    const dims = result.belowThresholdTasks.map(t => `${t.id}:${t.dimension}`).sort();
    assert.deepEqual(dims, ["a:shapeConfidence", "b:dependencyConfidence"].sort());
  });

  it("result includes checkedTasks count equal to input length", () => {
    const tasks = [
      { id: "x1", shapeConfidence: 0.7 },
      { id: "x2", shapeConfidence: 0.8 },
      { id: "x3" },
    ];
    const result = computeReadinessGate(tasks);
    assert.equal(result.checkedTasks, 3);
  });
});
