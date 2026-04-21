/**
 * orchestrator_worker_cycle_artifacts.test.ts
 *
 * Verifies deterministic task identity generation and correct persistence of
 * task/taskIds across worker dispatch start/complete events, including
 * completedTaskIds accounting.
 *
 * Tested behaviours:
 *   1. generateDeterministicTaskId  — stable, non-empty, hash-based output
 *   2. stampBatchPlanTaskIds        — stamps missing task_ids; preserves existing ones
 *   3. extractBatchTaskSummary      — derives non-empty task summary from batch.plans
 *   4. migrateWorkerCycleArtifacts  — canonical migration path still works after changes
 *   5. completedTaskIds accounting  — selectWorkerCycleRecord returns correct shape
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  generateDeterministicTaskId,
  migrateWorkerCycleArtifacts,
  isWorkerCycleArtifactsSnapshotContractValid,
  selectWorkerCycleRecord,
  WORKER_CYCLE_ARTIFACTS_FILE,
  WORKER_CYCLE_ARTIFACTS_SCHEMA,
} from "../../src/core/cycle_analytics.js";
import { buildWorkerTopologyContract } from "../../src/core/role_registry.js";
import {
  stampBatchPlanTaskIds,
  extractBatchTaskSummary,
  persistSkippedDispatchCheckpoint,
} from "../../src/core/orchestrator.js";

// ── 1. generateDeterministicTaskId ────────────────────────────────────────────

describe("generateDeterministicTaskId", () => {
  it("returns a non-empty string", () => {
    const id = generateDeterministicTaskId("evolution-worker", 0, "Fix the pipeline");
    assert.ok(typeof id === "string" && id.length > 0, "must return a non-empty string");
  });

  it("returns exactly 12 hex characters", () => {
    const id = generateDeterministicTaskId("evolution-worker", 0, "Fix the pipeline");
    assert.match(id, /^[0-9a-f]{12}$/, "must be 12 lowercase hex chars");
  });

  it("is deterministic — same inputs produce identical output", () => {
    const a = generateDeterministicTaskId("evolution-worker", 3, "Add telemetry spans");
    const b = generateDeterministicTaskId("evolution-worker", 3, "Add telemetry spans");
    assert.equal(a, b, "same inputs must yield the same id");
  });

  it("differs when role changes", () => {
    const a = generateDeterministicTaskId("evolution-worker", 0, "task");
    const b = generateDeterministicTaskId("quality-worker", 0, "task");
    assert.notEqual(a, b, "different roles must yield different ids");
  });

  it("differs when plan index changes", () => {
    const a = generateDeterministicTaskId("evolution-worker", 0, "task");
    const b = generateDeterministicTaskId("evolution-worker", 1, "task");
    assert.notEqual(a, b, "different indexes must yield different ids");
  });

  it("differs when task text changes", () => {
    const a = generateDeterministicTaskId("evolution-worker", 0, "task A");
    const b = generateDeterministicTaskId("evolution-worker", 0, "task B");
    assert.notEqual(a, b, "different task text must yield different ids");
  });

  it("handles empty task text without throwing", () => {
    const id = generateDeterministicTaskId("evolution-worker", 0, "");
    assert.match(id, /^[0-9a-f]{12}$/, "empty task text must still return 12 hex chars");
  });

  it("handles empty role without throwing", () => {
    const id = generateDeterministicTaskId("", 0, "some task");
    assert.match(id, /^[0-9a-f]{12}$/, "empty role must still return 12 hex chars");
  });
});

// ── 2. stampBatchPlanTaskIds ──────────────────────────────────────────────────

describe("stampBatchPlanTaskIds", () => {
  it("stamps missing task_id on plans that have none", () => {
    const batches = [
      {
        role: "evolution-worker",
        wave: 1,
        plans: [
          { task: "Implement feature A" },
          { task: "Write tests for A" },
        ],
      },
    ];
    stampBatchPlanTaskIds(batches);
    for (const plan of batches[0].plans) {
      assert.ok(
        typeof (plan as any).task_id === "string" && (plan as any).task_id.length > 0,
        `plan "${plan.task}" must have a non-empty task_id after stamping`,
      );
    }
  });

  it("preserves an existing task_id and does not overwrite it", () => {
    const existing = "existing-id-001";
    const batches = [
      {
        role: "evolution-worker",
        wave: 1,
        plans: [
          { task: "Refactor module", task_id: existing },
        ],
      },
    ];
    stampBatchPlanTaskIds(batches);
    assert.equal(
      (batches[0].plans[0] as any).task_id,
      existing,
      "existing task_id must not be overwritten",
    );
  });

  it("preserves an existing id field (fallback) and does not overwrite it", () => {
    const existing = "id-fallback-007";
    const batches = [
      {
        role: "evolution-worker",
        wave: 1,
        plans: [
          { task: "Deploy infra", id: existing },
        ],
      },
    ];
    stampBatchPlanTaskIds(batches);
    // task_id should NOT be stamped because id is already present
    assert.equal(
      (batches[0].plans[0] as any).id,
      existing,
      "existing id must not be overwritten",
    );
    // The function stamps task_id only when BOTH task_id and id are absent
    assert.ok(
      !(batches[0].plans[0] as any).task_id,
      "task_id must not be written when id already present",
    );
  });

  it("uses global offset so same-task plans in different batches get distinct ids", () => {
    const sharedTask = "Shared task text";
    const batches = [
      {
        role: "evolution-worker",
        wave: 1,
        plans: [{ task: sharedTask }],
      },
      {
        role: "evolution-worker",
        wave: 2,
        plans: [{ task: sharedTask }],
      },
    ];
    stampBatchPlanTaskIds(batches);
    const id0 = (batches[0].plans[0] as any).task_id;
    const id1 = (batches[1].plans[0] as any).task_id;
    assert.ok(id0 && id1, "both plans must have task_ids");
    assert.notEqual(
      id0,
      id1,
      "plans with same text but different global positions must have distinct ids",
    );
  });

  it("produces stable ids — calling stamp twice does not change already-stamped ids", () => {
    const batches = [
      {
        role: "evolution-worker",
        wave: 1,
        plans: [{ task: "Stable task" }],
      },
    ];
    stampBatchPlanTaskIds(batches);
    const firstId = (batches[0].plans[0] as any).task_id;
    // Simulate a second stamp call (e.g., resume path) — should be a no-op
    stampBatchPlanTaskIds(batches);
    assert.equal(
      (batches[0].plans[0] as any).task_id,
      firstId,
      "second stamp call must not alter already-stamped ids",
    );
  });

  it("handles empty batches array without throwing", () => {
    assert.doesNotThrow(() => stampBatchPlanTaskIds([]));
  });

  it("handles batches with no plans without throwing", () => {
    const batches = [{ role: "evolution-worker", wave: 1 }];
    assert.doesNotThrow(() => stampBatchPlanTaskIds(batches));
  });
});

// ── 3. extractBatchTaskSummary ────────────────────────────────────────────────

describe("extractBatchTaskSummary", () => {
  it("returns the single plan task when batch has one plan", () => {
    const batch = {
      role: "evolution-worker",
      plans: [{ task: "Implement feature X" }],
    };
    const summary = extractBatchTaskSummary(batch);
    assert.equal(summary, "Implement feature X");
  });

  it("appends count suffix when multiple plans are present", () => {
    const batch = {
      role: "evolution-worker",
      plans: [
        { task: "Task one" },
        { task: "Task two" },
        { task: "Task three" },
      ],
    };
    const summary = extractBatchTaskSummary(batch);
    assert.ok(
      summary.startsWith("Task one") && summary.includes("+2 more"),
      `summary "${summary}" must show first task and count`,
    );
  });

  it("falls back to batch.task when plans array is absent", () => {
    const batch = { role: "evolution-worker", task: "Fallback task" };
    assert.equal(extractBatchTaskSummary(batch), "Fallback task");
  });

  it("falls back to batch.title when task is absent and plans array is absent", () => {
    const batch = { role: "evolution-worker", title: "Title fallback" };
    assert.equal(extractBatchTaskSummary(batch), "Title fallback");
  });

  it("returns empty string for a batch with no plans and no task/title fields", () => {
    const batch = { role: "evolution-worker" };
    assert.equal(extractBatchTaskSummary(batch), "");
  });

  it("truncates very long first-plan task to 120 chars", () => {
    const longTask = "x".repeat(200);
    const batch = { role: "evolution-worker", plans: [{ task: longTask }] };
    const summary = extractBatchTaskSummary(batch);
    assert.ok(summary.length <= 120, `summary length ${summary.length} must be ≤ 120`);
  });
});

describe("persistSkippedDispatchCheckpoint", () => {
  it("preserves planner and reviewer prompt lineage in the dispatch snapshot", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dispatch-lineage-"));
    try {
      const config = { paths: { stateDir }, runtime: {} };
      await persistSkippedDispatchCheckpoint(config, [
        { role: "evolution-worker", wave: 1, task: "Persist lineage-aware dispatch state" },
      ], {
        planAnalyzedAt: "2026-04-04T00:00:00.000Z",
        plannerPromptLineage: {
          lineageId: "planner:abc",
          promptFamilyKey: "family-123",
          totalSegments: 5,
          cacheableSegments: 3,
          estimatedSavedTokens: 120,
        },
        reviewerPromptLineage: {
          lineageId: "reviewer:def",
          promptFamilyKey: "family-123",
          totalSegments: 4,
          cacheableSegments: 2,
          estimatedSavedTokens: 80,
        },
      });
      const raw = await fs.readFile(path.join(stateDir, "dispatch_checkpoint.json"), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.plannerPromptLineage.lineageId, "planner:abc");
      assert.equal(parsed.reviewerPromptLineage.lineageId, "reviewer:def");
      assert.equal(parsed.reviewerPromptLineage.cacheableSegments, 2);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists the admitted worker topology for later-wave continuation resumes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dispatch-topology-"));
    try {
      const config = { paths: { stateDir }, runtime: {} };
      const workerBatches = [
        {
          role: "quality-worker",
          wave: 1,
          task: "Quality wave",
          plans: [{ role: "quality-worker", task: "Quality wave", wave: 1 }],
        },
        {
          role: "evolution-worker",
          wave: 2,
          task: "Continuation wave",
          plans: [{ role: "evolution-worker", task: "Continuation wave", wave: 2 }],
        },
      ];
      const admittedWorkerTopology = buildWorkerTopologyContract(
        workerBatches.flatMap((batch) => batch.plans),
      );
      for (const batch of workerBatches) {
        (batch as any).workerTopology = admittedWorkerTopology;
      }

      await persistSkippedDispatchCheckpoint(config, workerBatches, {
        planAnalyzedAt: "2026-04-04T00:00:00.000Z",
      });
      const raw = await fs.readFile(path.join(stateDir, "dispatch_checkpoint.json"), "utf8");
      const parsed = JSON.parse(raw);
      assert.equal(parsed.admittedWorkerTopology.laneCount, admittedWorkerTopology.laneCount);
      assert.equal(parsed.admittedWorkerTopology.workerCount, admittedWorkerTopology.workerCount);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ── 4. migrateWorkerCycleArtifacts ────────────────────────────────────────────

describe("migrateWorkerCycleArtifacts — canonical path with stamped task ids", () => {
  it("accepts a v1 envelope with non-empty completedTaskIds", () => {
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "cycle-abc",
      cycles: {
        "cycle-abc": {
          cycleId: "cycle-abc",
          status: "dispatching",
          updatedAt: new Date().toISOString(),
          workerSessions: {},
          workerActivity: {
            "evolution-worker": [
              {
                at: new Date().toISOString(),
                status: "done",
                task: "Implement feature X",
                taskIds: ["abc000000001", "abc000000002"],
                wave: 1,
              },
            ],
          },
          completedTaskIds: ["abc000000001", "abc000000002"],
        },
      },
    };
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.equal(result.ok, true, "migration must succeed");
    const record = (result.data as any).cycles["cycle-abc"];
    assert.deepEqual(
      record.completedTaskIds,
      ["abc000000001", "abc000000002"],
      "completedTaskIds must be preserved through migration",
    );
  });

  it("normalizes duplicate task ids in completedTaskIds", () => {
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "cycle-dup",
      cycles: {
        "cycle-dup": {
          cycleId: "cycle-dup",
          status: "dispatching",
          updatedAt: new Date().toISOString(),
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: ["id-001", "id-001", "id-002"],
        },
      },
    };
    const result = migrateWorkerCycleArtifacts(artifact);
    assert.equal(result.ok, true);
    const record = (result.data as any).cycles["cycle-dup"];
    assert.deepEqual(
      record.completedTaskIds,
      ["id-001", "id-002"],
      "duplicates must be removed by migration",
    );
  });
});

// ── 5. completedTaskIds accounting ───────────────────────────────────────────

describe("selectWorkerCycleRecord — completedTaskIds accounting", () => {
  it("returns empty completedTaskIds for a cycle with no completed workers", () => {
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "cycle-new",
      cycles: {
        "cycle-new": {
          cycleId: "cycle-new",
          status: "dispatching",
          updatedAt: new Date().toISOString(),
          workerSessions: { "evolution-worker": { status: "working" } },
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    const result = selectWorkerCycleRecord(artifact, "cycle-new");
    assert.ok(result.record, "record must be found");
    assert.deepEqual(result.record!.completedTaskIds, [], "no completed task ids yet");
  });

  it("returns completedTaskIds populated after a done event", () => {
    const taskIds = ["deadbeef0001", "deadbeef0002"];
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "cycle-done",
      cycles: {
        "cycle-done": {
          cycleId: "cycle-done",
          status: "dispatching",
          updatedAt: new Date().toISOString(),
          workerSessions: { "evolution-worker": { status: "idle", lastStatus: "done" } },
          workerActivity: {
            "evolution-worker": [
              {
                at: new Date().toISOString(),
                status: "done",
                task: "Implement feature Y",
                taskIds,
                wave: 1,
              },
            ],
          },
          completedTaskIds: taskIds,
        },
      },
    };
    const result = selectWorkerCycleRecord(artifact, "cycle-done");
    assert.ok(result.record, "record must be found");
    assert.deepEqual(
      result.record!.completedTaskIds,
      taskIds,
      "completedTaskIds must match persisted task ids",
    );
  });

  it("preserves resolvedRole on workerSessions so analytics can attribute execution to the effective lane", () => {
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "cycle-resolved-role",
      cycles: {
        "cycle-resolved-role": {
          cycleId: "cycle-resolved-role",
          status: "dispatching",
          updatedAt: new Date().toISOString(),
          workerSessions: {
            "quality-worker": {
              status: "idle",
              lastStatus: "done",
              resolvedRole: "observation-worker",
            },
          },
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    const result = selectWorkerCycleRecord(artifact, "cycle-resolved-role");
    assert.ok(result.record, "record must be found");
    assert.equal(
      (result.record!.workerSessions["quality-worker"] as any).resolvedRole,
      "observation-worker",
      "resolvedRole must survive normalization for downstream analytics consumers",
    );
  });

  it("negative path — returns source=none when artifact is empty", () => {
    // selectWorkerCycleRecord falls back through preferred → latestCycleId → mostRecent.
    // An empty cycles map with no latestCycleId yields source="none".
    const artifact = {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      latestCycleId: "",
      cycles: {},
    };
    const result = selectWorkerCycleRecord(artifact, "cycle-does-not-exist");
    assert.equal(result.source, "none", "must return source=none for empty artifact");
    assert.equal(result.record, null, "record must be null for empty artifact");
  });
});

// ── 6. WORKER_CYCLE_ARTIFACTS_FILE / WORKER_CYCLE_ARTIFACTS_SCHEMA ────────────

describe("WORKER_CYCLE_ARTIFACTS constants", () => {
  it("WORKER_CYCLE_ARTIFACTS_FILE is the expected filename", () => {
    assert.equal(WORKER_CYCLE_ARTIFACTS_FILE, "worker_cycle_artifacts.json");
  });

  it("WORKER_CYCLE_ARTIFACTS_SCHEMA has required cycleRecord fields including completedTaskIds", () => {
    assert.ok(
      Array.isArray(WORKER_CYCLE_ARTIFACTS_SCHEMA.cycleRecordRequired),
      "cycleRecordRequired must be an array",
    );
    assert.ok(
      WORKER_CYCLE_ARTIFACTS_SCHEMA.cycleRecordRequired.includes("completedTaskIds"),
      "cycleRecordRequired must include completedTaskIds",
    );
  });
});

describe("isWorkerCycleArtifactsSnapshotContractValid", () => {
  it("returns true for canonical schema-valid snapshot", () => {
    const updatedAt = new Date().toISOString();
    const snapshot = {
      schemaVersion: 1,
      updatedAt,
      latestCycleId: "cycle-valid",
      cycles: {
        "cycle-valid": {
          cycleId: "cycle-valid",
          updatedAt,
          status: "running",
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    assert.equal(isWorkerCycleArtifactsSnapshotContractValid(snapshot), true);
  });

  it("negative path — returns false when updatedAt is missing", () => {
    const snapshot = {
      schemaVersion: 1,
      latestCycleId: "cycle-missing-updated-at",
      cycles: {
        "cycle-missing-updated-at": {
          cycleId: "cycle-missing-updated-at",
          updatedAt: new Date().toISOString(),
          status: "running",
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    assert.equal(isWorkerCycleArtifactsSnapshotContractValid(snapshot), false);
  });

  it("negative path — returns false when latest cycleId and record cycleId diverge", () => {
    const updatedAt = new Date().toISOString();
    const snapshot = {
      schemaVersion: 1,
      updatedAt,
      latestCycleId: "cycle-a",
      cycles: {
        "cycle-a": {
          cycleId: "cycle-b",
          updatedAt,
          status: "running",
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    assert.equal(isWorkerCycleArtifactsSnapshotContractValid(snapshot), false);
  });

  it("negative path — returns false when latest cycle status is empty", () => {
    const updatedAt = new Date().toISOString();
    const snapshot = {
      schemaVersion: 1,
      updatedAt,
      latestCycleId: "cycle-a",
      cycles: {
        "cycle-a": {
          cycleId: "cycle-a",
          updatedAt,
          status: "",
          workerSessions: {},
          workerActivity: {},
          completedTaskIds: [],
        },
      },
    };
    assert.equal(isWorkerCycleArtifactsSnapshotContractValid(snapshot), false);
  });
});
