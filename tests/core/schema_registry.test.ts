/**
 * Tests for T-009: Contract-versioned state schema registry.
 *
 * Covers:
 *   AC1: schemaVersion is stamped on write via addSchemaVersion.
 *   AC2: migrateData correctly upgrades v0 (LEGACY) → v1 for all three file types.
 *   AC3: Unknown future versions (> CURRENT) fail closed with UNKNOWN_FUTURE_VERSION.
 *   AC4: recordMigrationTelemetry writes deterministic telemetry records.
 *   AC5: Legacy fixture files (v0) migrate correctly and preserve loop-relevant data.
 *   AC6: detectVersion correctly identifies LEGACY and V1.
 *   AC7: Negative paths — invalid data, unsupported type, corrupt schemaVersion.
 *   AC8: extractPostmortemEntries handles both v0 (array) and v1 (object) shapes.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  SCHEMA_VERSION,
  CURRENT_SCHEMA_VERSION,
  STATE_FILE_TYPE,
  MIGRATION_REASON,
  MIGRATION_LOG_FILE,
  detectVersion,
  migrateData,
  addSchemaVersion,
  extractPostmortemEntries,
  recordMigrationTelemetry,
  backfillDecisionQualityLabel,
  VALID_DECISION_QUALITY_LABELS,
} from "../../src/core/schema_registry.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// ── SCHEMA_VERSION enum ───────────────────────────────────────────────────────

describe("SCHEMA_VERSION", () => {
  it("exposes LEGACY=0 and V1=1 as frozen integer constants", () => {
    assert.equal(SCHEMA_VERSION.LEGACY, 0);
    assert.equal(SCHEMA_VERSION.V1, 1);
    assert.ok(Object.isFrozen(SCHEMA_VERSION), "enum must be frozen");
  });

  it("CURRENT_SCHEMA_VERSION equals V1", () => {
    assert.equal(CURRENT_SCHEMA_VERSION, SCHEMA_VERSION.V1);
  });
});

// ── STATE_FILE_TYPE enum ──────────────────────────────────────────────────────

describe("STATE_FILE_TYPE", () => {
  it("exposes the three critical file type identifiers as frozen constants", () => {
    assert.equal(STATE_FILE_TYPE.WORKER_SESSIONS, "worker_sessions");
    assert.equal(STATE_FILE_TYPE.PROMETHEUS_ANALYSIS, "prometheus_analysis");
    assert.equal(STATE_FILE_TYPE.ATHENA_POSTMORTEMS, "athena_postmortems");
    assert.ok(Object.isFrozen(STATE_FILE_TYPE));
  });
});

// ── MIGRATION_REASON enum ─────────────────────────────────────────────────────

describe("MIGRATION_REASON", () => {
  it("exposes all five reason codes as frozen string constants", () => {
    assert.equal(MIGRATION_REASON.OK, "OK");
    assert.equal(MIGRATION_REASON.ALREADY_CURRENT, "ALREADY_CURRENT");
    assert.equal(MIGRATION_REASON.UNKNOWN_FUTURE_VERSION, "UNKNOWN_FUTURE_VERSION");
    assert.equal(MIGRATION_REASON.UNSUPPORTED_TYPE, "UNSUPPORTED_TYPE");
    assert.equal(MIGRATION_REASON.INVALID_DATA, "INVALID_DATA");
    assert.ok(Object.isFrozen(MIGRATION_REASON));
  });
});

// ── detectVersion ─────────────────────────────────────────────────────────────

describe("detectVersion", () => {
  it("returns LEGACY for an object without schemaVersion", () => {
    assert.equal(detectVersion({ plans: [], analyzedAt: "now" }), SCHEMA_VERSION.LEGACY);
  });

  it("returns LEGACY for an array (athena_postmortems v0)", () => {
    assert.equal(detectVersion([{ recommendation: "proceed" }]), SCHEMA_VERSION.LEGACY);
  });

  it("returns V1 for an object with schemaVersion: 1", () => {
    assert.equal(detectVersion({ schemaVersion: 1, entries: [] }), SCHEMA_VERSION.V1);
  });

  it("returns the exact integer for any other valid schemaVersion", () => {
    assert.equal(detectVersion({ schemaVersion: 5 }), 5);
  });

  it("returns null for null input", () => {
    assert.equal(detectVersion(null), null);
  });

  it("returns null for a non-integer schemaVersion (corrupt)", () => {
    assert.equal(detectVersion({ schemaVersion: "one" }), null);
    assert.equal(detectVersion({ schemaVersion: 1.5 }), null);
    assert.equal(detectVersion({ schemaVersion: null }), null);
  });
});

// ── migrateData — worker_sessions ─────────────────────────────────────────────

describe("migrateData — worker_sessions", () => {
  const FT = STATE_FILE_TYPE.WORKER_SESSIONS;

  it("migrates v0 object to v1: adds schemaVersion, preserves all role keys", () => {
    const v0 = { "King David": { status: "idle" }, "Esther": { status: "working" } };
    const result = migrateData(v0, FT);
    assert.equal(result.ok, true);
    assert.equal(result.fromVersion, SCHEMA_VERSION.LEGACY);
    assert.equal(result.toVersion, SCHEMA_VERSION.V1);
    assert.equal(result.reason, MIGRATION_REASON.OK);
    assert.equal(result.data.schemaVersion, 1);
    assert.deepEqual(result.data["King David"], { status: "idle" });
    assert.deepEqual(result.data["Esther"], { status: "working" });
  });

  it("returns ALREADY_CURRENT when schemaVersion is already V1", () => {
    const v1 = { schemaVersion: 1, "King David": { status: "idle" } };
    const result = migrateData(v1, FT);
    assert.equal(result.ok, true);
    assert.equal(result.reason, MIGRATION_REASON.ALREADY_CURRENT);
    assert.equal(result.data, v1); // same reference — no copy needed
  });

  it("negative path: fails closed for unknown future version (schemaVersion > CURRENT)", () => {
    const future = { schemaVersion: 99, "King David": { status: "idle" } };
    const result = migrateData(future, FT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.UNKNOWN_FUTURE_VERSION);
    assert.equal(result.data, null);
    assert.equal(result.fromVersion, 99);
  });

  it("negative path: fails with INVALID_DATA when input is an array", () => {
    const result = migrateData([{ status: "idle" }], FT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.INVALID_DATA);
  });

  it("negative path: fails with INVALID_DATA when input is null", () => {
    const result = migrateData(null, FT);
    assert.equal(result.ok, false);
    // null → detectVersion returns null → INVALID_DATA
    assert.equal(result.reason, MIGRATION_REASON.INVALID_DATA);
  });
});

// ── migrateData — prometheus_analysis ────────────────────────────────────────

describe("migrateData — prometheus_analysis", () => {
  const FT = STATE_FILE_TYPE.PROMETHEUS_ANALYSIS;

  it("migrates v0 object to v1: adds schemaVersion, preserves all analysis fields", () => {
    const v0 = { plans: [{ role: "King David", task: "t" }], projectHealth: "good", analyzedAt: "now" };
    const result = migrateData(v0, FT);
    assert.equal(result.ok, true);
    assert.equal(result.fromVersion, SCHEMA_VERSION.LEGACY);
    assert.equal(result.toVersion, SCHEMA_VERSION.V1);
    assert.equal(result.reason, MIGRATION_REASON.OK);
    assert.equal(result.data.schemaVersion, 1);
    assert.equal(result.data.projectHealth, "good");
    assert.ok(Array.isArray(result.data.plans));
  });

  it("returns ALREADY_CURRENT when schemaVersion is already V1", () => {
    const v1 = { schemaVersion: 1, plans: [], projectHealth: "good", analyzedAt: "now" };
    const result = migrateData(v1, FT);
    assert.equal(result.ok, true);
    assert.equal(result.reason, MIGRATION_REASON.ALREADY_CURRENT);
  });

  it("negative path: future schemaVersion fails closed", () => {
    const future = { schemaVersion: 42, plans: [] };
    const result = migrateData(future, FT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.UNKNOWN_FUTURE_VERSION);
  });

  it("negative path: array input fails with INVALID_DATA", () => {
    const result = migrateData([{ plans: [] }], FT);
    assert.equal(result.ok, false);
    // Arrays → detectVersion → LEGACY → migrateV0ToV1 → INVALID_DATA (expects object)
    assert.equal(result.reason, MIGRATION_REASON.INVALID_DATA);
  });
});

// ── migrateData — athena_postmortems ──────────────────────────────────────────

describe("migrateData — athena_postmortems", () => {
  const FT = STATE_FILE_TYPE.ATHENA_POSTMORTEMS;

  it("migrates v0 array to v1 object: wraps entries with schemaVersion", () => {
    const v0 = [{ workerName: "evolution-worker", recommendation: "proceed" }];
    const result = migrateData(v0, FT);
    assert.equal(result.ok, true);
    assert.equal(result.fromVersion, SCHEMA_VERSION.LEGACY);
    assert.equal(result.toVersion, SCHEMA_VERSION.V1);
    assert.equal(result.reason, MIGRATION_REASON.OK);
    assert.equal(result.data.schemaVersion, 1);
    assert.ok(Array.isArray(result.data.entries));
    assert.equal(result.data.entries.length, 1);
    assert.equal(result.data.entries[0].workerName, "evolution-worker");
  });

  it("returns ALREADY_CURRENT for v1 object", () => {
    const v1 = { schemaVersion: 1, entries: [{ recommendation: "proceed" }] };
    const result = migrateData(v1, FT);
    assert.equal(result.ok, true);
    assert.equal(result.reason, MIGRATION_REASON.ALREADY_CURRENT);
  });

  it("negative path: future version fails closed", () => {
    const future = { schemaVersion: 99, entries: [] };
    const result = migrateData(future, FT);
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.UNKNOWN_FUTURE_VERSION);
  });

  it("negative path: non-array v0 fails with INVALID_DATA", () => {
    const result = migrateData({ notAnArray: true }, FT);
    // Object without schemaVersion → LEGACY → migrateV0ToV1 expects array → INVALID_DATA
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.INVALID_DATA);
  });
});

// ── migrateData — unsupported file type ───────────────────────────────────────

describe("migrateData — unsupported file type (negative path)", () => {
  it("returns UNSUPPORTED_TYPE for an unknown fileType string", () => {
    const v0 = { someField: true };
    const result = migrateData(v0, "unknown_file_type");
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.UNSUPPORTED_TYPE);
  });
});

// ── addSchemaVersion ──────────────────────────────────────────────────────────

describe("addSchemaVersion", () => {
  it("adds schemaVersion: 1 to a worker_sessions object", () => {
    const sessions = { "King David": { status: "idle" } };
    const stamped = addSchemaVersion(sessions, STATE_FILE_TYPE.WORKER_SESSIONS);
    assert.equal(stamped.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.deepEqual(stamped["King David"], { status: "idle" });
  });

  it("adds schemaVersion: 1 to a prometheus_analysis object", () => {
    const analysis = { plans: [], projectHealth: "good", analyzedAt: "now" };
    const stamped = addSchemaVersion(analysis, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS);
    assert.equal(stamped.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(stamped.projectHealth, "good");
  });

  it("wraps athena_postmortems array in envelope object with schemaVersion and entries", () => {
    const entries = [{ recommendation: "proceed" }];
    const stamped = addSchemaVersion(entries, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
    assert.equal(stamped.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.ok(Array.isArray(stamped.entries));
    assert.deepEqual(stamped.entries, entries);
  });

  it("idempotent: stamping already-v1 data preserves schemaVersion", () => {
    const v1 = { schemaVersion: 1, plans: [], projectHealth: "good" };
    const stamped = addSchemaVersion(v1, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS);
    assert.equal(stamped.schemaVersion, 1);
    assert.equal(stamped.projectHealth, "good");
  });
});

// ── extractPostmortemEntries ──────────────────────────────────────────────────

describe("extractPostmortemEntries", () => {
  it("returns the array directly for v0 (raw array input)", () => {
    const v0 = [{ workerName: "evo", recommendation: "proceed" }];
    assert.deepEqual(extractPostmortemEntries(v0), v0);
  });

  it("returns entries from v1 object envelope", () => {
    const v1 = { schemaVersion: 1, entries: [{ recommendation: "rework" }] };
    const result = extractPostmortemEntries(v1);
    assert.ok(Array.isArray(result));
    assert.equal(result[0].recommendation, "rework");
  });

  it("returns empty array for null input", () => {
    assert.deepEqual(extractPostmortemEntries(null), []);
  });

  it("returns empty array for non-array, non-entries object", () => {
    assert.deepEqual(extractPostmortemEntries({ foo: "bar" }), []);
  });
});

// ── recordMigrationTelemetry ──────────────────────────────────────────────────

describe("recordMigrationTelemetry", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-migtel-")); });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("creates the migration log file with a single deterministic telemetry record", async () => {
    await recordMigrationTelemetry(tmpDir, {
      fileType: STATE_FILE_TYPE.WORKER_SESSIONS,
      filePath: "state/worker_sessions.json",
      fromVersion: SCHEMA_VERSION.LEGACY,
      toVersion: SCHEMA_VERSION.V1,
      success: true,
      reason: MIGRATION_REASON.OK
    });

    const logPath = path.join(tmpDir, MIGRATION_LOG_FILE);
    const raw = await fs.readFile(logPath, "utf8");
    const entries = JSON.parse(raw);

    assert.ok(Array.isArray(entries), "log must be an array");
    assert.equal(entries.length, 1);
    const rec = entries[0];
    assert.equal(rec.fileType, "worker_sessions");
    assert.equal(rec.filePath, "state/worker_sessions.json");
    assert.equal(rec.fromVersion, 0);
    assert.equal(rec.toVersion, 1);
    assert.equal(rec.success, true);
    assert.equal(rec.reason, "OK");
    assert.ok(typeof rec.timestamp === "string" && rec.timestamp.length > 0,
      "timestamp must be a non-empty ISO string");
  });

  it("appends subsequent events rather than overwriting", async () => {
    await recordMigrationTelemetry(tmpDir, {
      fileType: STATE_FILE_TYPE.PROMETHEUS_ANALYSIS,
      filePath: "state/prometheus_analysis.json",
      fromVersion: null,
      toVersion: SCHEMA_VERSION.V1,
      success: false,
      reason: MIGRATION_REASON.INVALID_DATA
    });

    const logPath = path.join(tmpDir, MIGRATION_LOG_FILE);
    const entries = JSON.parse(await fs.readFile(logPath, "utf8"));
    assert.ok(entries.length >= 2, "second event must be appended");
    const last = entries[entries.length - 1];
    assert.equal(last.fileType, "prometheus_analysis");
    assert.equal(last.success, false);
    assert.equal(last.reason, "INVALID_DATA");
    assert.equal(last.fromVersion, null);
  });

  it("telemetry record for UNKNOWN_FUTURE_VERSION includes the future version number", async () => {
    await recordMigrationTelemetry(tmpDir, {
      fileType: STATE_FILE_TYPE.ATHENA_POSTMORTEMS,
      filePath: "state/athena_postmortems.json",
      fromVersion: 99,
      toVersion: SCHEMA_VERSION.V1,
      success: false,
      reason: MIGRATION_REASON.UNKNOWN_FUTURE_VERSION
    });

    const entries = JSON.parse(await fs.readFile(path.join(tmpDir, MIGRATION_LOG_FILE), "utf8"));
    const last = entries[entries.length - 1];
    assert.equal(last.fromVersion, 99);
    assert.equal(last.reason, "UNKNOWN_FUTURE_VERSION");
    assert.equal(last.success, false);
  });
});

// ── AC5: Legacy fixture replay ────────────────────────────────────────────────
// Named legacy fixtures from tests/fixtures/. Verifies that v0 files produced
// by the pre-registry pipeline migrate correctly and preserve loop-relevant data.

describe("AC5 — legacy fixture migration", () => {
  it("worker_sessions_v0.json migrates to v1 and preserves all role entries", async () => {
    const raw = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, "worker_sessions_v0.json"), "utf8"));
    // Confirm it is a valid v0 fixture (no schemaVersion)
    assert.ok(!("schemaVersion" in raw), "fixture must be v0 — no schemaVersion");

    const result = migrateData(raw, STATE_FILE_TYPE.WORKER_SESSIONS);
    assert.equal(result.ok, true, `migration must succeed: ${result.reason}`);
    assert.equal(result.fromVersion, SCHEMA_VERSION.LEGACY);
    assert.equal(result.toVersion, SCHEMA_VERSION.V1);
    assert.equal(result.data.schemaVersion, 1);

    // Loop-relevant data preserved: role statuses are intact
    assert.equal(result.data["King David"].status, "idle");
    assert.equal(result.data["Esther"].status, "working");

    // Orchestrator's active-worker filter still works post-migration:
    // schemaVersion: 1 (a number) must NOT appear as an active worker
    const activeWorkers = Object.entries(result.data)
      .filter(([, s]) => s?.status === "working")
      .map(([name]) => name);
    assert.ok(!activeWorkers.includes("schemaVersion"),
      "schemaVersion key must not be treated as a worker role");
    assert.ok(activeWorkers.includes("Esther"),
      "Esther (status=working) must appear in active workers");
  });

  it("prometheus_analysis_v0.json migrates to v1 and preserves plans/projectHealth", async () => {
    const raw = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, "prometheus_analysis_v0.json"), "utf8"));
    assert.ok(!("schemaVersion" in raw), "fixture must be v0");

    const result = migrateData(raw, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS);
    assert.equal(result.ok, true);
    assert.equal(result.data.schemaVersion, 1);
    assert.equal(result.data.projectHealth, "needs-work");
    assert.ok(Array.isArray(result.data.plans) && result.data.plans.length > 0,
      "plans array must be preserved after migration");
  });

  it("athena_postmortems_v0.json migrates to v1 and entries remain accessible", async () => {
    const raw = JSON.parse(await fs.readFile(path.join(FIXTURES_DIR, "athena_postmortems_v0.json"), "utf8"));
    assert.ok(Array.isArray(raw), "fixture must be v0 (root array)");

    const result = migrateData(raw, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
    assert.equal(result.ok, true);
    assert.equal(result.data.schemaVersion, 1);
    assert.ok(Array.isArray(result.data.entries));
    assert.equal(result.data.entries.length, raw.length);

    // extractPostmortemEntries works transparently for both shapes
    const fromV0 = extractPostmortemEntries(raw);
    const fromV1 = extractPostmortemEntries(result.data);
    assert.deepEqual(fromV0, fromV1, "entries must be identical regardless of shape");

    // Athena reviewer loop-relevant: recommendation field preserved
    assert.equal(result.data.entries[0].recommendation, "proceed");
  });
});

// ── Negative path: schema validation edge cases ───────────────────────────────

describe("migrateData — negative paths", () => {
  it("unknown future version emits no data and correct reason for all three file types", () => {
    const futureVersion = CURRENT_SCHEMA_VERSION + 1;
    for (const ft of Object.values(STATE_FILE_TYPE)) {
      const data = ft === STATE_FILE_TYPE.ATHENA_POSTMORTEMS
        ? { schemaVersion: futureVersion, entries: [] }
        : { schemaVersion: futureVersion };
      const result = migrateData(data, ft);
      assert.equal(result.ok, false, `${ft}: must fail closed on future version`);
      assert.equal(result.reason, MIGRATION_REASON.UNKNOWN_FUTURE_VERSION, `${ft}: reason must be UNKNOWN_FUTURE_VERSION`);
      assert.equal(result.data, null, `${ft}: data must be null on failure`);
    }
  });

  it("INVALID_DATA is returned for non-integer schemaVersion value", () => {
    const corrupt = { schemaVersion: "v1" };
    const result = migrateData(corrupt, STATE_FILE_TYPE.WORKER_SESSIONS);
    assert.equal(result.ok, false);
    assert.equal(result.reason, MIGRATION_REASON.INVALID_DATA);
  });
});

// ── backfillDecisionQualityLabel ─────────────────────────────────────────────

describe("backfillDecisionQualityLabel", () => {
  it("backfills entries missing decisionQualityLabel with 'inconclusive'", () => {
    const entries = [
      { workerName: "evo", taskCompleted: true },
      { workerName: "gov", decisionQualityLabel: "correct" },
      { workerName: "arc", decisionQualityLabel: "" },
    ];
    const { entries: out, backfilledCount } = backfillDecisionQualityLabel(entries as any);
    assert.equal(backfilledCount, 2, "two entries should be backfilled");
    assert.equal(out[0].decisionQualityLabel, "inconclusive");
    assert.equal(out[0].decisionQualityLabelReason, "BACKFILLED_MISSING");
    assert.equal(out[1].decisionQualityLabel, "correct", "already-correct entry must be unchanged");
    assert.equal(out[2].decisionQualityLabel, "inconclusive");
  });

  it("does not touch entries that already have valid labels", () => {
    for (const label of VALID_DECISION_QUALITY_LABELS) {
      const entries = [{ decisionQualityLabel: label }];
      const { backfilledCount } = backfillDecisionQualityLabel(entries as any);
      assert.equal(backfilledCount, 0, `label '${label}' should not be backfilled`);
    }
  });

  it("returns empty result and zero count for non-array input", () => {
    const { entries, backfilledCount } = backfillDecisionQualityLabel(null as any);
    assert.deepEqual(entries, []);
    assert.equal(backfilledCount, 0);
  });

  it("returns zero count for empty array input", () => {
    const { entries, backfilledCount } = backfillDecisionQualityLabel([]);
    assert.deepEqual(entries, []);
    assert.equal(backfilledCount, 0);
  });

  it("negative path: invalid label value is treated as missing and backfilled", () => {
    const entries = [{ decisionQualityLabel: "UNKNOWN_VALUE" }];
    const { backfilledCount } = backfillDecisionQualityLabel(entries as any);
    assert.equal(backfilledCount, 1, "invalid label must be backfilled");
    assert.equal(entries[0].decisionQualityLabel, "inconclusive");
  });
});
