/**
 * governance_review_packet.test.ts
 *
 * Tests for T-039: Governance Review Board Artifact Generator.
 *
 * Acceptance criteria coverage mapping:
 *   AC1  — Packet includes decision logs, metrics, unresolved risks.
 *   AC2  — All high-risk changes have explicit owner and rollback status.
 *   AC3  — Packet generation is reproducible from state artifacts (deterministic).
 *   AC4  — No secrets or tokens appear in packet output.
 *   AC5  — Packet references cycle IDs and intervention IDs.
 *   AC6  — Each AC maps to at least one explicit test with deterministic pass/fail.
 *   AC7  — Includes negative path asserting failure handling.
 *   AC8  — JSON output has defined schema with required fields and explicit enums.
 *   AC9  — Validation distinguishes missing input from invalid input with reason codes.
 *   AC10 — No silent fallback; degraded behavior sets explicit status + degradedSources.
 *
 * Athena missing items resolved:
 *   AM1  — GOVERNANCE_PACKET_REQUIRED_FIELDS + GOVERNANCE_PACKET_SCHEMA_VERSION defined.
 *   AM2  — HIGH_RISK_THRESHOLD = 0.7; isHighRisk() deterministic.
 *   AM3  — GOVERNANCE_PACKET_METRICS_FIELDS enumerates all 8 metrics.
 *   AM4  — Trigger is scripts/generate-governance-packet.ts (CLI).
 *   AM5  — Each test verifies a specific deterministic condition.
 *   AM6  — Output path is state/governance_packets/ (sub-directory, not state/ root).
 *
 * Scenarios:
 *   1.  Constants and exports present (module contract)
 *   2.  isHighRisk() — positive paths (high, critical, score-based)
 *   3.  isHighRisk() — negative paths (low, medium, null input)
 *   4.  stripSecrets() — strips secret-key fields, preserves safe fields
 *   5.  stripSecrets() — recursive stripping on nested objects and arrays
 *   6.  readApprovalEvidence() — missing file → APPROVAL_EVIDENCE_ABSENT
 *   7.  readApprovalEvidence() — valid JSONL file → ok=true, entries parsed
 *   8.  readApprovalEvidence() — corrupt line skipped, rest parsed (partial OK)
 *   9.  readApprovalEvidence() — empty file → ok=true, entries=[]
 *   10. generateGovernancePacket() — happy path with all state files present
 *   11. generateGovernancePacket() — all required fields present in output
 *   12. generateGovernancePacket() — AC1: decisionLogs, metrics, unresolvedRisks populated
 *   13. generateGovernancePacket() — AC2: highRiskChanges have owner + rollbackStatus
 *   14. generateGovernancePacket() — AC4: secret fields stripped from packet
 *   15. generateGovernancePacket() — AC5: cycleId from evolution_progress; interventionIds populated
 *   16. generateGovernancePacket() — AC9/AC10: degraded when evolution_progress missing (ABSENT)
 *   17. generateGovernancePacket() — AC9: degraded with EVOLUTION_INVALID when corrupt
 *   18. generateGovernancePacket() — AC10: degraded when all sources missing, no throw
 *   19. generateGovernancePacket() — APPROVAL_EVIDENCE_ABSENT in degradedSources when missing
 *   20. generateGovernancePacket() — highRiskThreshold=0.7 in output (schema field)
 *   21. generateGovernancePacket() — AC3: reproducible — same state → same packet shape
 *   22. persistGovernancePacket()  — AC9: null packet → MISSING_INPUT reason code
 *   23. persistGovernancePacket()  — AC9: array packet → INVALID_INPUT reason code
 *   24. persistGovernancePacket()  — AC9: missing required field → INVALID_INPUT
 *   25. persistGovernancePacket()  — AC9: invalid monthKey format → INVALID_INPUT
 *   26. persistGovernancePacket()  — happy path: writes correct file to governance_packets/
 *   27. persistGovernancePacket()  — AC6: output path uses sub-directory, not state/ root
 *   28. generateGovernancePacket() — AC7 negative path: experiment with secret field stripped
 *   29. GOVERNANCE_PACKET_METRICS_FIELDS — enumerates all 8 defined metrics
 *   30. ROLLBACK_STATUS enum — all values present and frozen
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  GOVERNANCE_PACKET_SCHEMA_VERSION,
  GOVERNANCE_PACKET_STATUS,
  PACKET_REASON_CODE,
  GOVERNANCE_PACKET_REQUIRED_FIELDS,
  DECISION_LOG_REQUIRED_FIELDS,
  HIGH_RISK_CHANGE_REQUIRED_FIELDS,
  HIGH_RISK_THRESHOLD,
  GOVERNANCE_PACKET_METRICS_FIELDS,
  SECRET_KEY_PATTERNS,
  ROLLBACK_STATUS,
  isHighRisk,
  stripSecrets,
  readApprovalEvidence,
  generateGovernancePacket,
  persistGovernancePacket
} from "../../src/core/governance_review_packet.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

async function writeRaw(dir, filename, text) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), text, "utf8");
}

async function writeJsonl(dir, filename, records) {
  await fs.mkdir(dir, { recursive: true });
  const lines = records.map(r => JSON.stringify(r)).join("\n");
  await fs.writeFile(path.join(dir, filename), lines + "\n", "utf8");
}

function makeConfig(stateDir) {
  return { paths: { stateDir } };
}

const MONTH_KEY = "2025-06";

const PERIOD_TIMESTAMP  = "2025-06-15T10:00:00.000Z";
const OUTSIDE_TIMESTAMP = "2025-07-01T00:00:00.000Z";

function makeEvolutionProgress(overrides = {}) {
  return {
    cycle_id: "SE-test-cycle-001",
    started_at: PERIOD_TIMESTAMP,
    current_task_index: 2,
    tasks: {
      "T-001": { status: "completed", attempts: 1 },
      "T-002": { status: "completed", attempts: 2 },
      "T-003": { status: "pending",   attempts: 0 }
    },
    ...overrides
  };
}

function makeEvidenceRecord(overrides = {}) {
  return {
    changeId:        "change-001",
    changedBy:       "self-improvement",
    changedAt:       PERIOD_TIMESTAMP,
    riskLevel:       "low",
    filesChanged:    ["src/config.js"],
    approvals:       [],
    contractVersion: "1.0.0",
    ...overrides
  };
}

function makeHighRiskEvidenceRecord(overrides = {}) {
  return makeEvidenceRecord({
    changeId:  "change-high-001",
    riskLevel: "high",
    approvals: [
      { approverRole: "senior-engineer", approvedAt: PERIOD_TIMESTAMP, rationale: "LGTM" },
      { approverRole: "security-lead",   approvedAt: PERIOD_TIMESTAMP, rationale: "Reviewed" }
    ],
    ...overrides
  });
}

function makeImprovementReports(cycleAt = PERIOD_TIMESTAMP) {
  return {
    reports: [
      {
        cycleAt,
        analysis: {
          systemHealthScore: 75,
          lessons: [{ lesson: "Workers need longer timeout", category: "timeout", severity: "warning" }],
          capabilityGaps: [],
          nextCyclePriorities: ["Improve test coverage"],
          workerFeedback: []
        }
      },
      {
        cycleAt,
        analysis: {
          systemHealthScore: 85,
          lessons: [],
          capabilityGaps: [],
          nextCyclePriorities: [],
          workerFeedback: []
        }
      },
      {
        cycleAt,
        analysis: {
          systemHealthScore: 90,
          lessons: [],
          capabilityGaps: [],
          nextCyclePriorities: [],
          workerFeedback: []
        }
      }
    ]
  };
}

function makeExperiment(overrides = {}) {
  return {
    experimentId:      "exp-001",
    hypothesisId:      "increase-timeout-reduces-errors",
    interventionId:    "intervention-timeout-001",
    treatmentGroup:    "A",
    status:            "running",
    interventionScope: ["workerTimeoutMinutes"],
    createdAt:         PERIOD_TIMESTAMP,
    ...overrides
  };
}

function makeExperimentRegistry(experiments = []) {
  return {
    schemaVersion: 1,
    updatedAt:     PERIOD_TIMESTAMP,
    experiments
  };
}

// Minimal valid packet for persistence tests
function makeMinimalPacket(monthKey = MONTH_KEY) {
  return {
    schemaVersion:    GOVERNANCE_PACKET_SCHEMA_VERSION,
    packetId:         `gov-packet-${monthKey}`,
    cycleId:          "SE-test-cycle-001",
    monthKey,
    generatedAt:      PERIOD_TIMESTAMP,
    status:           GOVERNANCE_PACKET_STATUS.OK,
    reviewPeriodStart: "2025-06-01T00:00:00.000Z",
    reviewPeriodEnd:   "2025-06-30T23:59:59.999Z",
    highRiskThreshold: HIGH_RISK_THRESHOLD,
    metrics: {
      totalCycles:                3,
      completedTasks:             2,
      rollbackCount:              0,
      experimentCount:            1,
      decisionQualityScore:       null,
      decisionQualityLabelCounts: {},
      systemHealthScore:          80,
      highRiskChangeCount:        0
    },
    decisionLogs:    [],
    highRiskChanges: [],
    unresolvedRisks: [],
    interventionIds: []
  };
}

// ── 1. Module contract — constants and exports ─────────────────────────────────

describe("governance_review_packet — module exports (AC8, AM1)", () => {
  it("exports GOVERNANCE_PACKET_SCHEMA_VERSION as integer 1", () => {
    assert.equal(GOVERNANCE_PACKET_SCHEMA_VERSION, 1);
  });

  it("exports GOVERNANCE_PACKET_STATUS with ok/degraded/insufficient_data", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_PACKET_STATUS));
    assert.equal(GOVERNANCE_PACKET_STATUS.OK,                "ok");
    assert.equal(GOVERNANCE_PACKET_STATUS.DEGRADED,          "degraded");
    assert.equal(GOVERNANCE_PACKET_STATUS.INSUFFICIENT_DATA, "insufficient_data");
  });

  it("exports PACKET_REASON_CODE with all required codes", () => {
    assert.ok(Object.isFrozen(PACKET_REASON_CODE));
    const expected = [
      "APPROVAL_EVIDENCE_ABSENT", "APPROVAL_EVIDENCE_INVALID",
      "EVOLUTION_ABSENT",         "EVOLUTION_INVALID",
      "REPORTS_ABSENT",           "REPORTS_INVALID",
      "REGISTRY_ABSENT",          "REGISTRY_INVALID",
      "POSTMORTEMS_ABSENT",       "POSTMORTEMS_INVALID",
      "MISSING_INPUT",            "INVALID_INPUT",
      "WRITE_FAILED"
    ];
    for (const code of expected) {
      assert.equal(PACKET_REASON_CODE[code], code, `PACKET_REASON_CODE.${code} must equal "${code}"`);
    }
  });

  it("exports GOVERNANCE_PACKET_REQUIRED_FIELDS with all 14 required fields", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_PACKET_REQUIRED_FIELDS));
    assert.equal(GOVERNANCE_PACKET_REQUIRED_FIELDS.length, 14);
    for (const field of [
      "schemaVersion", "packetId", "cycleId", "monthKey", "generatedAt", "status",
      "reviewPeriodStart", "reviewPeriodEnd", "highRiskThreshold",
      "metrics", "decisionLogs", "highRiskChanges", "unresolvedRisks", "interventionIds"
    ]) {
      assert.ok(GOVERNANCE_PACKET_REQUIRED_FIELDS.includes(field), `must include "${field}"`);
    }
  });

  it("exports DECISION_LOG_REQUIRED_FIELDS with all required fields", () => {
    assert.ok(Object.isFrozen(DECISION_LOG_REQUIRED_FIELDS));
    for (const f of ["changeId", "changedBy", "changedAt", "riskLevel", "filesChanged", "approvals", "contractVersion"]) {
      assert.ok(DECISION_LOG_REQUIRED_FIELDS.includes(f), `must include "${f}"`);
    }
  });

  it("exports HIGH_RISK_CHANGE_REQUIRED_FIELDS with all required fields (AC2)", () => {
    assert.ok(Object.isFrozen(HIGH_RISK_CHANGE_REQUIRED_FIELDS));
    for (const f of ["changeId", "owner", "changedAt", "riskLevel", "filesChanged", "rollbackStatus"]) {
      assert.ok(HIGH_RISK_CHANGE_REQUIRED_FIELDS.includes(f), `must include "${f}"`);
    }
  });

  it("exports HIGH_RISK_THRESHOLD = 0.7 (AM2)", () => {
    assert.equal(HIGH_RISK_THRESHOLD, 0.7);
  });

  it("exports GOVERNANCE_PACKET_METRICS_FIELDS with all 8 metrics (AM3)", () => {
    assert.ok(Object.isFrozen(GOVERNANCE_PACKET_METRICS_FIELDS));
    assert.equal(GOVERNANCE_PACKET_METRICS_FIELDS.length, 8);
    for (const f of [
      "totalCycles", "completedTasks", "rollbackCount", "experimentCount",
      "decisionQualityScore", "decisionQualityLabelCounts", "systemHealthScore", "highRiskChangeCount"
    ]) {
      assert.ok(GOVERNANCE_PACKET_METRICS_FIELDS.includes(f), `must include "${f}"`);
    }
  });

  it("exports ROLLBACK_STATUS with all values frozen (AM8)", () => {
    assert.ok(Object.isFrozen(ROLLBACK_STATUS));
    assert.equal(ROLLBACK_STATUS.ROLLED_BACK,     "rolled_back");
    assert.equal(ROLLBACK_STATUS.NOT_ROLLED_BACK, "not_rolled_back");
    assert.equal(ROLLBACK_STATUS.UNKNOWN,         "unknown");
  });

  it("exports required functions", () => {
    assert.equal(typeof isHighRisk,               "function");
    assert.equal(typeof stripSecrets,             "function");
    assert.equal(typeof readApprovalEvidence,     "function");
    assert.equal(typeof generateGovernancePacket, "function");
    assert.equal(typeof persistGovernancePacket,  "function");
  });
});

// ── 2–3. isHighRisk() — AC2, AM2 ─────────────────────────────────────────────

describe("isHighRisk() — positive paths (AC2, AM2)", () => {
  it("returns true for riskLevel=high", () => {
    assert.equal(isHighRisk({ riskLevel: "high" }), true);
  });

  it("returns true for riskLevel=critical", () => {
    assert.equal(isHighRisk({ riskLevel: "critical" }), true);
  });

  it("returns true for riskLevel=HIGH (case-insensitive)", () => {
    assert.equal(isHighRisk({ riskLevel: "HIGH" }), true);
  });

  it("returns true for riskScore >= 0.7 regardless of riskLevel", () => {
    assert.equal(isHighRisk({ riskLevel: "medium", riskScore: 0.7 }), true);
    assert.equal(isHighRisk({ riskLevel: "low",    riskScore: 0.9 }), true);
  });
});

describe("isHighRisk() — negative paths (AC7)", () => {
  it("returns false for riskLevel=low", () => {
    assert.equal(isHighRisk({ riskLevel: "low" }), false);
  });

  it("returns false for riskLevel=medium", () => {
    assert.equal(isHighRisk({ riskLevel: "medium" }), false);
  });

  it("returns false for riskScore < 0.7", () => {
    assert.equal(isHighRisk({ riskLevel: "low", riskScore: 0.69 }), false);
  });

  it("returns false for null input", () => {
    assert.equal(isHighRisk(null), false);
  });

  it("returns false for undefined input", () => {
    assert.equal(isHighRisk(undefined), false);
  });

  it("returns false for non-object input", () => {
    assert.equal(isHighRisk("high"), false);
    assert.equal(isHighRisk(42),     false);
  });
});

// ── 4–5. stripSecrets() — AC4 ─────────────────────────────────────────────────

describe("stripSecrets() — AC4", () => {
  it("strips keys containing 'token'", () => {
    const input  = { name: "worker", authToken: "secret-value" };
    const result = stripSecrets(input);
    assert.ok(!("authToken" in result), "authToken must be stripped");
    assert.equal(result.name, "worker");
  });

  it("strips keys containing 'secret'", () => {
    const result = stripSecrets({ data: "safe", mySecret: "s3cret" });
    assert.ok(!("mySecret" in result));
    assert.equal(result.data, "safe");
  });

  it("strips keys containing 'password'", () => {
    const result = stripSecrets({ user: "alice", password: "hunter2" });
    assert.ok(!("password" in result));
    assert.equal(result.user, "alice");
  });

  it("strips keys containing 'apikey' (case-insensitive)", () => {
    const result = stripSecrets({ ApiKey: "abc123", endpoint: "https://example.com" });
    assert.ok(!("ApiKey" in result));
    assert.equal(result.endpoint, "https://example.com");
  });

  it("preserves safe fields untouched", () => {
    const input  = { changeId: "c-001", riskLevel: "high", filesChanged: ["src/a.js"] };
    const result = stripSecrets(input);
    assert.deepEqual(result, input);
  });

  it("strips recursively in nested objects", () => {
    const input  = { approvals: [{ approverRole: "admin", apiKey: "key123", rationale: "LGTM" }] };
    const result = stripSecrets(input);
    assert.ok(!("apiKey" in result.approvals[0]), "nested apiKey must be stripped");
    assert.equal(result.approvals[0].approverRole, "admin");
    assert.equal(result.approvals[0].rationale,    "LGTM");
  });

  it("strips recursively in arrays", () => {
    const input  = [{ token: "abc" }, { name: "safe" }];
    const result = stripSecrets(input);
    assert.ok(!("token" in result[0]));
    assert.equal(result[1].name, "safe");
  });

  it("passes through primitives unchanged", () => {
    assert.equal(stripSecrets("hello"), "hello");
    assert.equal(stripSecrets(42),      42);
    assert.equal(stripSecrets(null),    null);
    assert.equal(stripSecrets(true),    true);
  });
});

// ── 6–9. readApprovalEvidence() — AC9 ────────────────────────────────────────

describe("readApprovalEvidence() — missing file", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-ev1-")); });
  after(async  () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=false and APPROVAL_EVIDENCE_ABSENT reason (AC9)", async () => {
    const result = await readApprovalEvidence(path.join(tmpDir, "approval_evidence.jsonl"));
    assert.equal(result.ok, false);
    assert.equal(result.reason, PACKET_REASON_CODE.APPROVAL_EVIDENCE_ABSENT);
    assert.deepEqual(result.entries, []);
  });
});

describe("readApprovalEvidence() — valid JSONL", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-ev2-"));
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [
      makeEvidenceRecord(),
      makeHighRiskEvidenceRecord()
    ]);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true with parsed entries", async () => {
    const result = await readApprovalEvidence(path.join(tmpDir, "approval_evidence.jsonl"));
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].changeId, "change-001");
  });
});

describe("readApprovalEvidence() — corrupt line skipped", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-ev3-"));
    const jsonl = `${JSON.stringify(makeEvidenceRecord())}\nNOT VALID JSON{{{\n${JSON.stringify(makeHighRiskEvidenceRecord())}\n`;
    await writeRaw(tmpDir, "approval_evidence.jsonl", jsonl);
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("ok=true, skips corrupt line, returns 2 valid records", async () => {
    const result = await readApprovalEvidence(path.join(tmpDir, "approval_evidence.jsonl"));
    assert.equal(result.ok, true);
    assert.equal(result.entries.length, 2, "corrupt line must be skipped, valid lines parsed");
  });
});

describe("readApprovalEvidence() — empty file", () => {
  let tmpDir;
  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-ev4-"));
    await writeRaw(tmpDir, "approval_evidence.jsonl", "");
  });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true, entries=[]", async () => {
    const result = await readApprovalEvidence(path.join(tmpDir, "approval_evidence.jsonl"));
    assert.equal(result.ok, true);
    assert.deepEqual(result.entries, []);
  });
});

// ── 10–21. generateGovernancePacket() — AC1, AC2, AC3, AC4, AC5, AC10 ─────────

describe("generateGovernancePacket() — happy path with all sources", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-gen1-"));
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [
      makeEvidenceRecord(),
      makeHighRiskEvidenceRecord()
    ]);
    await writeJson(tmpDir, "evolution_progress.json", makeEvolutionProgress());
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry([
      makeExperiment({ interventionId: "intervention-timeout-001" }),
      makeExperiment({ experimentId: "exp-002", interventionId: "intervention-timeout-002", status: "running" })
    ]));
    // Provide minimal athena_postmortems.json so the happy-path packet is status=ok
    await writeJson(tmpDir, "athena_postmortems.json", {
      schemaVersion: 1,
      entries: []
    });
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true", () => {
    assert.equal(result.ok, true);
  });

  it("status=ok when all sources are present", () => {
    assert.equal(result.status, GOVERNANCE_PACKET_STATUS.OK);
    assert.equal(result.packet.status, GOVERNANCE_PACKET_STATUS.OK);
  });

  it("packet has all required fields (AC8, AM1)", () => {
    for (const field of GOVERNANCE_PACKET_REQUIRED_FIELDS) {
      assert.ok(field in result.packet, `packet must include required field "${field}"`);
    }
  });

  it("schemaVersion=1 (AC8)", () => {
    assert.equal(result.packet.schemaVersion, GOVERNANCE_PACKET_SCHEMA_VERSION);
  });

  it("monthKey matches the provided month", () => {
    assert.equal(result.packet.monthKey, MONTH_KEY);
  });

  it("packetId = gov-packet-{monthKey}", () => {
    assert.equal(result.packet.packetId, `gov-packet-${MONTH_KEY}`);
  });

  it("highRiskThreshold = 0.7 (AM2)", () => {
    assert.equal(result.packet.highRiskThreshold, 0.7);
  });

  it("reviewPeriodStart and reviewPeriodEnd are ISO timestamps for the month", () => {
    assert.ok(result.packet.reviewPeriodStart.startsWith("2025-06-01"), "must start at June 1");
    assert.ok(result.packet.reviewPeriodEnd.startsWith("2025-06-30"),   "must end at June 30");
  });

  it("AC1: decisionLogs array present with entries for the period", () => {
    assert.ok(Array.isArray(result.packet.decisionLogs), "decisionLogs must be an array");
    assert.ok(result.packet.decisionLogs.length >= 1, "must include evidence entries for the period");
  });

  it("AC1: each decisionLog entry has all required fields", () => {
    for (const log of result.packet.decisionLogs) {
      for (const field of DECISION_LOG_REQUIRED_FIELDS) {
        assert.ok(field in log, `decisionLog entry must have field "${field}"`);
      }
    }
  });

  it("AC1: metrics object has all 8 required metrics fields (AM3)", () => {
    for (const field of GOVERNANCE_PACKET_METRICS_FIELDS) {
      assert.ok(field in result.packet.metrics, `metrics must include field "${field}"`);
    }
  });

  it("AC1: metrics.totalCycles reflects improvement_reports in the period", () => {
    assert.equal(result.packet.metrics.totalCycles, 3);
  });

  it("AC1: metrics.completedTasks reflects evolution_progress completed count", () => {
    assert.equal(result.packet.metrics.completedTasks, 2);
  });

  it("AC1: metrics.highRiskChangeCount = 1 (one high-risk evidence record)", () => {
    assert.equal(result.packet.metrics.highRiskChangeCount, 1);
  });

  it("AC1: unresolvedRisks array present", () => {
    assert.ok(Array.isArray(result.packet.unresolvedRisks), "unresolvedRisks must be an array");
  });

  it("AC2: highRiskChanges array present", () => {
    assert.ok(Array.isArray(result.packet.highRiskChanges), "highRiskChanges must be an array");
  });

  it("AC2: highRiskChanges entries include owner and rollbackStatus", () => {
    assert.equal(result.packet.highRiskChanges.length, 1, "must have 1 high-risk change");
    const hrc = result.packet.highRiskChanges[0];
    for (const field of HIGH_RISK_CHANGE_REQUIRED_FIELDS) {
      assert.ok(field in hrc, `highRiskChange entry must have field "${field}"`);
    }
    assert.ok(typeof hrc.owner === "string" && hrc.owner.length > 0, "owner must be non-empty string");
    assert.ok(Object.values(ROLLBACK_STATUS).includes(hrc.rollbackStatus),
      `rollbackStatus must be a ROLLBACK_STATUS value, got "${hrc.rollbackStatus}"`);
  });

  it("AC5: cycleId from evolution_progress.cycle_id", () => {
    assert.equal(result.packet.cycleId, "SE-test-cycle-001");
  });

  it("AC5: interventionIds array contains intervention IDs from experiments", () => {
    assert.ok(Array.isArray(result.packet.interventionIds), "interventionIds must be an array");
    assert.ok(result.packet.interventionIds.includes("intervention-timeout-001"),
      "must include intervention-timeout-001");
    assert.ok(result.packet.interventionIds.includes("intervention-timeout-002"),
      "must include intervention-timeout-002");
  });
});

// ── AC4: no secrets in packet ─────────────────────────────────────────────────

describe("generateGovernancePacket() — AC4: no secrets in output", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-sec-"));
    // Evidence record with a secret field (should be stripped)
    const evidenceWithSecret = makeHighRiskEvidenceRecord({
      authToken:   "Bearer secret-token-abc123",
      apiKey:      "sk-should-be-stripped",
      approvals: [
        { approverRole: "admin", approvedAt: PERIOD_TIMESTAMP, rationale: "ok", apikey: "nested-secret" }
      ]
    });
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [evidenceWithSecret]);
    await writeJson(tmpDir, "evolution_progress.json", makeEvolutionProgress());
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry());
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("no top-level field in packet contains 'token' or 'secret' or 'apikey' key", () => {
    const packetStr = JSON.stringify(result.packet);
    // Check that known secret field names are not present as JSON keys
    assert.ok(!/"authToken"\s*:/.test(packetStr), "authToken must not appear in packet JSON");
    assert.ok(!/"apiKey"\s*:/.test(packetStr),    "apiKey must not appear in packet JSON");
    assert.ok(!/"apikey"\s*:/.test(packetStr),    "apikey must not appear in packet JSON");
  });

  it("decisionLog entry does not contain secret fields", () => {
    for (const log of result.packet.decisionLogs) {
      assert.ok(!("authToken" in log), "authToken must be stripped from decisionLog");
      assert.ok(!("apiKey"    in log), "apiKey must be stripped from decisionLog");
    }
  });

  it("highRiskChanges approval entries do not contain nested secret fields", () => {
    for (const hrc of result.packet.highRiskChanges) {
      for (const approval of (hrc.approvals || [])) {
        assert.ok(!("apikey" in approval), "nested apikey must be stripped from approval");
      }
    }
  });
});

// ── AC9/AC10: degraded when evolution_progress missing ────────────────────────

describe("generateGovernancePacket() — AC9/AC10: degraded when evolution_progress missing", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-evo-"));
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [makeEvidenceRecord()]);
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry());
    // Intentionally NO evolution_progress.json
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("ok=true (generator never throws on missing files)", () => {
    assert.equal(result.ok, true);
  });

  it("status=degraded when evolution_progress is missing (AC10)", () => {
    assert.equal(result.status, GOVERNANCE_PACKET_STATUS.DEGRADED);
  });

  it("degradedSources contains EVOLUTION_ABSENT (AC9 — ABSENT for missing file)", () => {
    assert.ok(Array.isArray(result.packet.degradedSources), "degradedSources must be an array");
    assert.ok(result.packet.degradedSources.includes(PACKET_REASON_CODE.EVOLUTION_ABSENT),
      `degradedSources must include EVOLUTION_ABSENT, got: ${JSON.stringify(result.packet.degradedSources)}`);
  });

  it("cycleId falls back to cycle-{monthKey} (no silent null)", () => {
    // Must not be null — uses "cycle-{monthKey}" fallback
    assert.ok(typeof result.packet.cycleId === "string" && result.packet.cycleId.length > 0,
      "cycleId must be a non-empty string even when evolution_progress is missing");
  });
});

// ── AC9: distinct reason code for invalid JSON (EVOLUTION_INVALID vs EVOLUTION_ABSENT) ─

describe("generateGovernancePacket() — AC9: EVOLUTION_INVALID for corrupt file", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-evoinv-"));
    await writeJsonl(tmpDir, "approval_evidence.jsonl", []);
    await writeRaw(tmpDir, "evolution_progress.json", "CORRUPT{{{{");
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry());
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("degradedSources contains EVOLUTION_INVALID (not EVOLUTION_ABSENT) for corrupt file", () => {
    assert.ok(result.packet.degradedSources.includes(PACKET_REASON_CODE.EVOLUTION_INVALID),
      "must use EVOLUTION_INVALID for a present but corrupt file");
    assert.ok(!result.packet.degradedSources.includes(PACKET_REASON_CODE.EVOLUTION_ABSENT),
      "must not use EVOLUTION_ABSENT for a present file");
  });
});

// ── AC10: all sources missing — degraded, no throw ────────────────────────────

describe("generateGovernancePacket() — AC10: all sources missing", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-empty-"));
    // Create empty directory with no state files
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("ok=true — generator never throws even with empty stateDir (AC10)", () => {
    assert.equal(result.ok, true);
  });

  it("status=degraded (AC10 — explicit status field)", () => {
    assert.equal(result.status, GOVERNANCE_PACKET_STATUS.DEGRADED);
    assert.equal(result.packet.status, GOVERNANCE_PACKET_STATUS.DEGRADED);
  });

  it("degradedSources is non-empty (AC10 — machine-readable reason codes)", () => {
    assert.ok(Array.isArray(result.packet.degradedSources));
    assert.ok(result.packet.degradedSources.length > 0, "must list at least one degraded source");
  });

  it("packet is a non-null object — no silent failure (AC10)", () => {
    assert.ok(result.packet !== null && typeof result.packet === "object");
  });

  it("packet still has all required fields even when degraded (AC8)", () => {
    for (const field of GOVERNANCE_PACKET_REQUIRED_FIELDS) {
      assert.ok(field in result.packet, `packet must include "${field}" even when degraded`);
    }
  });

  it("metrics fields all present even when degraded (AM3)", () => {
    for (const field of GOVERNANCE_PACKET_METRICS_FIELDS) {
      assert.ok(field in result.packet.metrics, `metrics.${field} must be present even when degraded`);
    }
  });
});

// ── AC3: reproducibility ──────────────────────────────────────────────────────

describe("generateGovernancePacket() — AC3: deterministic output from same state", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-repro-"));
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [makeEvidenceRecord()]);
    await writeJson(tmpDir, "evolution_progress.json", makeEvolutionProgress());
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry([makeExperiment()]));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("two successive calls produce packets with identical structure (AC3)", async () => {
    const cfg = makeConfig(tmpDir);
    const r1 = await generateGovernancePacket(cfg, MONTH_KEY);
    const r2 = await generateGovernancePacket(cfg, MONTH_KEY);

    // Structural fields must be identical
    assert.equal(r1.packet.monthKey,             r2.packet.monthKey);
    assert.equal(r1.packet.cycleId,              r2.packet.cycleId);
    assert.equal(r1.packet.status,               r2.packet.status);
    assert.equal(r1.packet.highRiskThreshold,    r2.packet.highRiskThreshold);
    assert.deepEqual(r1.packet.metrics,          r2.packet.metrics);
    assert.deepEqual(r1.packet.interventionIds,  r2.packet.interventionIds);
    assert.deepEqual(r1.packet.decisionLogs,     r2.packet.decisionLogs);
    assert.deepEqual(r1.packet.highRiskChanges,  r2.packet.highRiskChanges);
    assert.deepEqual(r1.packet.unresolvedRisks,  r2.packet.unresolvedRisks);
  });
});

// ── 22–27. persistGovernancePacket() — AC9, AC6 ───────────────────────────────

describe("persistGovernancePacket() — AC9: null input → MISSING_INPUT", () => {
  it("returns ok=false with MISSING_INPUT reason for null", async () => {
    const r = await persistGovernancePacket({}, null);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(PACKET_REASON_CODE.MISSING_INPUT),
      `reason must start with MISSING_INPUT, got "${r.reason}"`);
  });

  it("returns ok=false with MISSING_INPUT reason for undefined", async () => {
    const r = await persistGovernancePacket({}, undefined);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(PACKET_REASON_CODE.MISSING_INPUT));
  });
});

describe("persistGovernancePacket() — AC9: array input → INVALID_INPUT", () => {
  it("returns ok=false with INVALID_INPUT reason for array", async () => {
    const r = await persistGovernancePacket({}, []);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(PACKET_REASON_CODE.INVALID_INPUT));
  });
});

describe("persistGovernancePacket() — AC9: missing required field → INVALID_INPUT", () => {
  it("returns ok=false with INVALID_INPUT when packet misses required field", async () => {
    const incomplete = { ...makeMinimalPacket() };
    delete incomplete.cycleId;
    const r = await persistGovernancePacket({}, incomplete);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(PACKET_REASON_CODE.INVALID_INPUT),
      `reason must start with INVALID_INPUT, got "${r.reason}"`);
    assert.ok(r.reason.includes("cycleId"), "reason must name the missing field");
  });
});

describe("persistGovernancePacket() — AC9: invalid monthKey format → INVALID_INPUT", () => {
  it("returns ok=false with INVALID_INPUT for bad monthKey", async () => {
    const bad = { ...makeMinimalPacket(), monthKey: "2025/06" };
    const r = await persistGovernancePacket({}, bad);
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith(PACKET_REASON_CODE.INVALID_INPUT));
    assert.ok(r.reason.includes("monthKey"), "reason must mention monthKey");
  });
});

describe("persistGovernancePacket() — happy path: writes correct file", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-persist-"));
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("writes packet to governance_packets/ sub-directory (AC6, AM6)", async () => {
    const cfg    = makeConfig(tmpDir);
    const packet = makeMinimalPacket(MONTH_KEY);
    const r      = await persistGovernancePacket(cfg, packet);

    assert.equal(r.ok, true, `persist failed: ${r.reason}`);
    assert.ok(r.filePath.includes("governance_packets"), "filePath must be in governance_packets/ sub-directory");
    assert.ok(r.filePath.endsWith(`governance_packet_${MONTH_KEY}.json`),
      `filePath must end with governance_packet_${MONTH_KEY}.json`);
  });

  it("written file contains valid JSON matching the packet", async () => {
    const cfg    = makeConfig(tmpDir);
    const packet = makeMinimalPacket(MONTH_KEY);
    const r      = await persistGovernancePacket(cfg, packet);

    const written = JSON.parse(await fs.readFile(r.filePath, "utf8"));
    assert.equal(written.schemaVersion, GOVERNANCE_PACKET_SCHEMA_VERSION);
    assert.equal(written.monthKey,      MONTH_KEY);
    assert.equal(written.cycleId,       packet.cycleId);
  });

  it("output is NOT in state/ root — uses governance_packets/ sub-directory (AM6)", async () => {
    const cfg    = makeConfig(tmpDir);
    const packet = makeMinimalPacket(MONTH_KEY);
    const r      = await persistGovernancePacket(cfg, packet);

    const relPath = path.relative(tmpDir, r.filePath);
    assert.ok(relPath.startsWith("governance_packets"),
      `output path must be inside governance_packets/, got relative path: ${relPath}`);
  });
});

// ── 28. AC7 negative path: rollback status when experiment is rolled back ──────

describe("generateGovernancePacket() — AC2/AC7: rollback status derivation", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t039-rb-"));
    // A rolled_back experiment that covers the same scope as a high-risk change
    const rolledBackExp = makeExperiment({
      experimentId:   "exp-rollback-001",
      interventionId: "intervention-001",
      status:         "rolled_back",
      interventionScope: ["src/core/policy_engine.js"]
    });
    // High-risk change to the same file
    const highRiskChange = makeHighRiskEvidenceRecord({
      changeId:     "change-core-001",
      filesChanged: ["src/core/policy_engine.js"]
    });
    await writeJsonl(tmpDir, "approval_evidence.jsonl", [highRiskChange]);
    await writeJson(tmpDir, "evolution_progress.json", makeEvolutionProgress());
    await writeJson(tmpDir, "improvement_reports.json", makeImprovementReports());
    await writeJson(tmpDir, "experiment_registry.json", makeExperimentRegistry([rolledBackExp]));
    result = await generateGovernancePacket(makeConfig(tmpDir), MONTH_KEY);
  });

  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("highRiskChange with matching rolled_back experiment gets rollbackStatus=rolled_back", () => {
    assert.equal(result.packet.highRiskChanges.length, 1);
    assert.equal(result.packet.highRiskChanges[0].rollbackStatus, ROLLBACK_STATUS.ROLLED_BACK,
      "rollbackStatus must be rolled_back when a rolled_back experiment covers the changed files");
  });
});

// ── 29. GOVERNANCE_PACKET_METRICS_FIELDS completeness ─────────────────────────

describe("GOVERNANCE_PACKET_METRICS_FIELDS — AM3", () => {
  it("contains exactly 8 fields", () => {
    assert.equal(GOVERNANCE_PACKET_METRICS_FIELDS.length, 8);
  });
});

// ── 30. SECRET_KEY_PATTERNS exported and frozen ────────────────────────────────

describe("SECRET_KEY_PATTERNS", () => {
  it("is a frozen array", () => {
    assert.ok(Object.isFrozen(SECRET_KEY_PATTERNS));
  });

  it("contains 'token', 'secret', 'password', 'apikey'", () => {
    assert.ok(SECRET_KEY_PATTERNS.includes("token"));
    assert.ok(SECRET_KEY_PATTERNS.includes("secret"));
    assert.ok(SECRET_KEY_PATTERNS.includes("password"));
    assert.ok(SECRET_KEY_PATTERNS.includes("apikey"));
  });
});
