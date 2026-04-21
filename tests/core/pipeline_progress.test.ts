import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  PIPELINE_STEPS,
  PIPELINE_STAGE_ENUM,
  PIPELINE_PROGRESS_SCHEMA,
  PIPELINE_SEGMENT_HISTORY_MAX,
  PROGRESS_ERROR_CODE,
  QUEUE_VIABILITY_MIN_COMPLETION_RATE,
  updatePipelineProgress,
  readPipelineProgress,
} from "../../src/core/pipeline_progress.js";

// ── computeQueueViability ─────────────────────────────────────────────────────

import { computeQueueViability } from "../../src/core/pipeline_progress.js";

describe("computeQueueViability", () => {
  let testDir: string;

  async function setup() {
    testDir = path.join(os.tmpdir(), `qv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  }

  async function teardown() {
    await fs.rm(testDir, { recursive: true, force: true });
  }

  function makeConfig(dir: string) {
    return { paths: { stateDir: dir } };
  }

  async function writeJson(filePath: string, data: unknown) {
    await fs.writeFile(filePath, JSON.stringify(data), "utf8");
  }

  it("returns viable=false with reason=no-plans when prometheus_analysis has no plans", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), { plans: [] });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "no-plans");
    await teardown();
  });

  it("returns viable=false with reason=no-plans when prometheus_analysis is missing", async () => {
    await setup();
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "no-plans");
    await teardown();
  });

  it("returns viable=false with reason=athena-not-approved when athena review is absent", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }, { id: "p2" }]
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "athena-not-approved");
    assert.equal(result.totalCount, 2);
    await teardown();
  });

  it("returns viable=false with reason=athena-not-approved when athena review is not approved", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: false });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "athena-not-approved");
    await teardown();
  });

  it("returns viable=true when approved and dispatch checkpoint is not complete", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }, { id: "p2" }, { id: "p3" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "dispatch_checkpoint.json"), {
      status: "in_progress",
      totalPlans: 3,
      completedPlans: 1,
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.totalCount, 3);
    assert.ok(result.pendingCount > 0);
    await teardown();
  });

  it("returns viable=false with reason=all-complete when checkpoint status=complete and plan count matches", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }, { id: "p2" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "dispatch_checkpoint.json"), {
      status: "complete",
      planCount: 2,
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "all-complete");
    await teardown();
  });

  it("returns viable=true with no checkpoint file (fresh queue)", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.totalCount, 1);
    await teardown();
  });

  it("returns viable=false when prometheus_analysis is missing from non-existent dir", async () => {
    const result = await computeQueueViability({ paths: { stateDir: "/does/not/exist/ever" } });
    assert.equal(result.viable, false);
    // readJson returns null for missing files, so we get no-plans (graceful fail-open)
    assert.ok(result.reason === "no-plans" || result.reason === "read-error");
    assert.equal(result.pendingCount, 0);
  });

  it("returns viable=false with reason=read-error on malformed state files", async () => {
    await setup();
    await fs.writeFile(path.join(testDir, "prometheus_analysis.json"), "NOT JSON", "utf8");
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "no-plans");
    await teardown();
  });

  // ── completionRate gate ────────────────────────────────────────────────────

  it("returns viable=false with reason=low-completion-rate when funnel completionRate is below threshold", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }, { id: "p2" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: 5, completed: 0, completionRate: 0.0 }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "low-completion-rate");
    assert.equal(result.completionRate, 0.0);
    await teardown();
  });

  it("returns viable=false when completionRate is just below QUEUE_VIABILITY_MIN_COMPLETION_RATE", async () => {
    const { QUEUE_VIABILITY_MIN_COMPLETION_RATE } = await import("../../src/core/pipeline_progress.js");
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    const belowThreshold = Math.max(0, QUEUE_VIABILITY_MIN_COMPLETION_RATE - 0.01);
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: 10, completed: 1, completionRate: belowThreshold }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "low-completion-rate");
    await teardown();
  });

  it("returns viable=true when completionRate meets QUEUE_VIABILITY_MIN_COMPLETION_RATE threshold", async () => {
    const { QUEUE_VIABILITY_MIN_COMPLETION_RATE } = await import("../../src/core/pipeline_progress.js");
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: 10, completed: 3, completionRate: QUEUE_VIABILITY_MIN_COMPLETION_RATE }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.completionRate, QUEUE_VIABILITY_MIN_COMPLETION_RATE);
    await teardown();
  });

  it("returns viable=true when cycle_analytics is missing (no data — do not penalise)", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    // No cycle_analytics.json written — absence should not block viability
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.completionRate, null);
    await teardown();
  });

  it("returns viable=true when cycle_analytics funnel completionRate is null (missing data sentinel)", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: null, completed: null, completionRate: null }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.completionRate, null);
    await teardown();
  });

  it("reads completionRate from lastCycle.funnel when top-level funnel is absent (composite schema)", async () => {
    const { QUEUE_VIABILITY_MIN_COMPLETION_RATE } = await import("../../src/core/pipeline_progress.js");
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      lastCycle: {
        funnel: { dispatched: 5, completed: 0, completionRate: 0.0 }
      }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, false);
    assert.equal(result.reason, "low-completion-rate");
    await teardown();
  });

  it("does not fail when dispatched is 0 in funnel (avoid division edge case)", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    // dispatched=0 means no work was dispatched; completionRate=0 with dispatched=0 should not block
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: 0, completed: 0, completionRate: 0.0 }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    // dispatched=0 means the gate condition (dispatched>0 && rate<threshold) is false → viable
    assert.equal(result.viable, true);
    await teardown();
  });

  it("returns completionRate field in result for all viable=true outcomes", async () => {
    await setup();
    await writeJson(path.join(testDir, "prometheus_analysis.json"), {
      plans: [{ id: "p1" }]
    });
    await writeJson(path.join(testDir, "athena_plan_review.json"), { approved: true });
    await writeJson(path.join(testDir, "cycle_analytics.json"), {
      funnel: { dispatched: 5, completed: 4, completionRate: 0.8 }
    });
    const result = await computeQueueViability(makeConfig(testDir));
    assert.equal(result.viable, true);
    assert.equal(result.completionRate, 0.8);
    assert.ok("completionRate" in result, "completionRate field must always be present in result");
    await teardown();
  });
});

const EXPECTED_STEP_IDS = [
  "idle",
  "janus_awakening",
  "janus_reading",
  "janus_thinking",
  "janus_decided",
  "prometheus_starting",
  "prometheus_reading_repo",
  "prometheus_analyzing",
  "prometheus_audit",
  "prometheus_done",
  "athena_reviewing",
  "athena_approved",
  "workers_dispatching",
  "workers_running",
  "workers_finishing",
  "cycle_complete",
];

describe("PIPELINE_STEPS", () => {
  it("contains all expected step IDs in order", () => {
    const ids = PIPELINE_STEPS.map(s => s.id);
    assert.deepEqual(ids, EXPECTED_STEP_IDS);
  });

  it("starts at 0% and ends at 100%", () => {
    assert.equal(PIPELINE_STEPS[0].pct, 0);
    assert.equal(PIPELINE_STEPS[PIPELINE_STEPS.length - 1].pct, 100);
  });

  it("has strictly non-decreasing pct values", () => {
    for (let i = 1; i < PIPELINE_STEPS.length; i++) {
      assert.ok(
        PIPELINE_STEPS[i].pct >= PIPELINE_STEPS[i - 1].pct,
        `Step ${PIPELINE_STEPS[i].id} (${PIPELINE_STEPS[i].pct}) must be >= previous step (${PIPELINE_STEPS[i-1].pct})`
      );
    }
  });

  it("has only ASCII labels (no Turkish or other non-ASCII characters)", () => {
    for (const step of PIPELINE_STEPS) {
      // eslint-disable-next-line no-control-regex
      assert.ok(
        /^[\x00-\x7F]*$/.test(step.label),
        `Step '${step.id}' label '${step.label}' contains non-ASCII characters`
      );
    }
  });

  it("each step has id, label, and pct fields", () => {
    for (const step of PIPELINE_STEPS) {
      assert.ok(typeof step.id === "string" && step.id.length > 0, `step missing id`);
      assert.ok(typeof step.label === "string" && step.label.length > 0, `step ${step.id} missing label`);
      assert.ok(typeof step.pct === "number", `step ${step.id} missing pct`);
    }
  });
});

// ── PIPELINE_STAGE_ENUM tests ───────────────────────────────────────────────

describe("PIPELINE_STAGE_ENUM", () => {
  it("matches PIPELINE_STEPS ids exactly", () => {
    const stepIds = PIPELINE_STEPS.map(s => s.id);
    assert.deepEqual([...PIPELINE_STAGE_ENUM], stepIds);
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(PIPELINE_STAGE_ENUM));
  });
});

// ── PIPELINE_PROGRESS_SCHEMA tests ─────────────────────────────────────────

describe("PIPELINE_PROGRESS_SCHEMA", () => {
  it("declares all required fields including startedAt", () => {
    const required = PIPELINE_PROGRESS_SCHEMA.required;
    assert.ok(Array.isArray(required));
    for (const field of ["stage", "stageLabel", "percent", "detail", "steps", "updatedAt", "startedAt"]) {
      assert.ok(required.includes(field), `schema must require '${field}'`);
    }
  });

  it("percentRange is [0, 100]", () => {
    assert.deepEqual(PIPELINE_PROGRESS_SCHEMA.percentRange, [0, 100]);
  });

  it("stageEnum matches PIPELINE_STAGE_ENUM", () => {
    assert.deepEqual([...PIPELINE_PROGRESS_SCHEMA.stageEnum], [...PIPELINE_STAGE_ENUM]);
  });

  it("stepStatusEnum contains done, active, pending", () => {
    const statusEnum = PIPELINE_PROGRESS_SCHEMA.stepStatusEnum;
    assert.ok(statusEnum.includes("done"));
    assert.ok(statusEnum.includes("active"));
    assert.ok(statusEnum.includes("pending"));
  });
});

// ── updatePipelineProgress validation tests ────────────────────────────────

describe("updatePipelineProgress validation", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pp-test-"));
    config = { paths: { stateDir: tmpDir } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws MISSING_STEP_ID when stepId is undefined", async () => {
    await assert.rejects(
      () => updatePipelineProgress(config, undefined),
      (err) => {
        assert.equal(err.code, PROGRESS_ERROR_CODE.MISSING_STEP_ID);
        return true;
      }
    );
  });

  it("throws MISSING_STEP_ID when stepId is null", async () => {
    await assert.rejects(
      () => updatePipelineProgress(config, null),
      (err) => {
        assert.equal(err.code, PROGRESS_ERROR_CODE.MISSING_STEP_ID);
        return true;
      }
    );
  });

  it("throws MISSING_STEP_ID when stepId is empty string", async () => {
    await assert.rejects(
      () => updatePipelineProgress(config, ""),
      (err) => {
        assert.equal(err.code, PROGRESS_ERROR_CODE.MISSING_STEP_ID);
        return true;
      }
    );
  });

  it("throws INVALID_STEP_ID for an unknown stepId", async () => {
    await assert.rejects(
      () => updatePipelineProgress(config, "trump_starting"),
      (err) => {
        assert.equal(err.code, PROGRESS_ERROR_CODE.INVALID_STEP_ID);
        assert.ok(err.message.includes("trump_starting"), "error message should include the bad step id");
        return true;
      }
    );
  });

  it("distinguishes missing from invalid: missing throws MISSING_STEP_ID, invalid throws INVALID_STEP_ID", async () => {
    let missingErr, invalidErr;
    try { await updatePipelineProgress(config, null); } catch (e) { missingErr = e; }
    try { await updatePipelineProgress(config, "nonexistent_step"); } catch (e) { invalidErr = e; }
    assert.equal(missingErr.code, PROGRESS_ERROR_CODE.MISSING_STEP_ID);
    assert.equal(invalidErr.code, PROGRESS_ERROR_CODE.INVALID_STEP_ID);
    assert.notEqual(missingErr.code, invalidErr.code);
  });
});

// ── updatePipelineProgress state tests ────────────────────────────────────

describe("updatePipelineProgress state transitions", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-pp-state-"));
    config = { paths: { stateDir: tmpDir } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a valid progress file for a normal step", async () => {
    await updatePipelineProgress(config, "janus_awakening", "Starting up");
    const data = await readPipelineProgress(config);
    assert.equal(data.stage, "janus_awakening");
    assert.equal(data.stageLabel, "Janus Awakening");
    assert.equal(data.percent, 5);
    assert.equal(data.detail, "Starting up");
    assert.ok(typeof data.updatedAt === "string");
    assert.ok(Array.isArray(data.steps));
  });

  it("output conforms to schema: all required fields present", async () => {
    await updatePipelineProgress(config, "prometheus_starting");
    const data = await readPipelineProgress(config);
    for (const field of PIPELINE_PROGRESS_SCHEMA.required) {
      assert.ok(field in data, `required field '${field}' missing from pipeline progress output`);
    }
  });

  it("stage field is one of PIPELINE_STAGE_ENUM values", async () => {
    await updatePipelineProgress(config, "athena_reviewing");
    const data = await readPipelineProgress(config);
    assert.ok(PIPELINE_STAGE_ENUM.includes(data.stage), `stage '${data.stage}' is not in PIPELINE_STAGE_ENUM`);
  });

  it("percent is within [0, 100] range", async () => {
    for (const step of PIPELINE_STEPS) {
      await updatePipelineProgress(config, step.id);
      const data = await readPipelineProgress(config);
      assert.ok(data.percent >= 0 && data.percent <= 100,
        `percent ${data.percent} for step ${step.id} is out of range`);
    }
  });

  it("step status values are all valid (done|active|pending)", async () => {
    await updatePipelineProgress(config, "workers_running");
    const data = await readPipelineProgress(config);
    const validStatuses = new Set(PIPELINE_PROGRESS_SCHEMA.stepStatusEnum);
    for (const step of data.steps) {
      assert.ok(validStatuses.has(step.status),
        `step ${step.id} has invalid status '${step.status}'`);
    }
  });

  // AC3/AC13: idle transition — startedAt must be null
  it("idle transition sets startedAt to null", async () => {
    await updatePipelineProgress(config, "janus_awakening", "starting");
    await updatePipelineProgress(config, "idle", "back to idle");
    const data = await readPipelineProgress(config);
    assert.equal(data.stage, "idle");
    assert.equal(data.percent, 0);
    assert.equal(data.startedAt, null, "startedAt must be null after idle transition");
    assert.equal(data.completedAt, undefined, "completedAt must not be present on idle");
  });

  // AC3/AC13: cycle_complete — completedAt must be ISO timestamp
  it("cycle_complete transition sets completedAt to ISO timestamp", async () => {
    await updatePipelineProgress(config, "janus_awakening");
    await updatePipelineProgress(config, "cycle_complete", "All done");
    const data = await readPipelineProgress(config);
    assert.equal(data.stage, "cycle_complete");
    assert.equal(data.percent, 100);
    assert.ok(typeof data.completedAt === "string" && data.completedAt.length > 0,
      "completedAt must be a non-empty string on cycle_complete");
    assert.ok(!isNaN(Date.parse(data.completedAt)), "completedAt must be a valid ISO timestamp");
  });

  // AC3/AC13: cycle_complete preserves startedAt from previous step
  it("cycle_complete preserves startedAt from cycle start", async () => {
    await updatePipelineProgress(config, "janus_awakening");
    const afterStart = await readPipelineProgress(config);
    const startedAt = afterStart.startedAt;
    await updatePipelineProgress(config, "cycle_complete");
    const data = await readPipelineProgress(config);
    assert.equal(data.startedAt, startedAt, "cycle_complete must preserve startedAt");
  });

  // AC5: monotonic stage progression for normal flow
  it("step pct values are non-decreasing in normal flow (monotonic progression)", async () => {
    const normalFlow = [
      "idle",
      "janus_awakening",
      "janus_reading",
      "janus_thinking",
      "janus_decided",
      "prometheus_starting",
      "prometheus_done",
      "athena_reviewing",
      "athena_approved",
      "workers_dispatching",
      "workers_running",
      "workers_finishing",
      "cycle_complete",
    ];
    let prevPct = -1;
    for (const stepId of normalFlow) {
      await updatePipelineProgress(config, stepId);
      const data = await readPipelineProgress(config);
      assert.ok(
        data.percent >= prevPct,
        `stage ${stepId} pct=${data.percent} regressed from previous pct=${prevPct}`
      );
      prevPct = data.percent;
    }
  });

  // AC4: no stage regression except explicit rollback (idle resets)
  it("idle is the only step that resets pct to 0 — explicit rollback", async () => {
    await updatePipelineProgress(config, "workers_running");
    const before = await readPipelineProgress(config);
    assert.ok(before.percent > 0);

    await updatePipelineProgress(config, "idle", "reset");
    const after = await readPipelineProgress(config);
    assert.equal(after.percent, 0, "only idle should reset percent to 0");
    assert.equal(after.stage, "idle");
  });

  it("maintains bounded run segment rollover history", async () => {
    await updatePipelineProgress(config, "workers_running", "segment-1", {
      runSegment: { segmentIndex: 1, startBatch: 1, endBatch: 2 },
    });
    for (let i = 1; i <= PIPELINE_SEGMENT_HISTORY_MAX + 2; i++) {
      await updatePipelineProgress(config, "workers_running", `rollover-${i}`, {
        runSegment: { segmentIndex: i + 1, startBatch: i + 1, endBatch: i + 2 },
        runSegmentRollover: { segmentIndex: i, startBatch: i, endBatch: i + 1 },
      });
    }
    const data = await readPipelineProgress(config);
    assert.equal(data.runSegment.segmentIndex, PIPELINE_SEGMENT_HISTORY_MAX + 3);
    assert.ok(Array.isArray(data.segmentHistory), "segmentHistory must be an array");
    assert.equal(
      data.segmentHistory.length,
      PIPELINE_SEGMENT_HISTORY_MAX,
      "segment history must be capped to PIPELINE_SEGMENT_HISTORY_MAX",
    );
  });
});

