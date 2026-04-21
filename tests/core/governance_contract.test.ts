/**
 * governance_contract.test.ts
 *
 * Tests for src/core/governance_contract.js
 *
 * Coverage mapping (Athena AC5/AC14 resolved — all exported functions covered):
 *   validateGovernanceContract   → AC1 startup validation (positive + negative paths)
 *   classifyRiskLevel            → AC2 risk classification (all 4 levels, quantitative evidence)
 *   validateDualApproval         → AC2 dual-approval conditions (positive + all failure modes)
 *   validateApprovalEvidenceSchema → AC4 schema validation (missing fields, invalid enum)
 *   recordApprovalEvidence       → AC4 evidence persistence (schema failure + happy path)
 *   enforceGovernance            → AC3 hard-block on violation (negative path included)
 *   GOVERNANCE_CONTRACT_VERSION  → AC1 versioned contract (exported constant)
 *   GOVERNANCE_STARTUP_EXIT_CODE → AC1 deterministic exit code
 *   GovernanceContractError      → AC1 error class with exitCode
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import {
  GOVERNANCE_CONTRACT_VERSION,
  GOVERNANCE_STARTUP_EXIT_CODE,
  GOVERNANCE_DISPATCH_BLOCK_REASON,
  GOVERNANCE_SIGNAL_REGISTRY,
  RISK_LEVEL,
  HIGH_RISK_CHANGE_TYPE,
  HIGH_RISK_SCORE_THRESHOLD,
  CRITICAL_RISK_SCORE_THRESHOLD,
  DUAL_APPROVAL_MIN_APPROVERS,
  GOVERNANCE_ERROR_CODE,
  APPROVAL_EVIDENCE_REQUIRED_FIELDS,
  APPROVAL_EVIDENCE_APPROVAL_REQUIRED_FIELDS,
  RISK_LEVEL_ENUM,
  HIGH_RISK_CHANGE_TYPE_ENUM,
  DEFAULT_APPROVAL_EVIDENCE_PATH,
  GovernanceContractError,
  validateGovernanceContract,
  classifyRiskLevel,
  validateDualApproval,
  validateApprovalEvidenceSchema,
  recordApprovalEvidence,
  enforceGovernance
} from "../../src/core/governance_contract.js";

// ── AC5 coverage assertion (Athena AC14 resolved) ─────────────────────────────
// Verifies all required exports are present at import time.
// If any export is removed or renamed, this test fails deterministically.
describe("governance_contract — module exports", () => {
  it("exports all required constants and functions", () => {
    assert.equal(typeof GOVERNANCE_CONTRACT_VERSION, "string");
    assert.ok(GOVERNANCE_CONTRACT_VERSION.length > 0, "version must be non-empty");

    assert.equal(typeof GOVERNANCE_STARTUP_EXIT_CODE, "number");
    assert.equal(GOVERNANCE_STARTUP_EXIT_CODE, 1, "exit code must be 1");

    assert.equal(typeof RISK_LEVEL, "object");
    assert.equal(typeof HIGH_RISK_CHANGE_TYPE, "object");
    assert.equal(typeof GOVERNANCE_ERROR_CODE, "object");
    assert.equal(typeof GOVERNANCE_DISPATCH_BLOCK_REASON, "object");
    assert.equal(typeof GOVERNANCE_SIGNAL_REGISTRY, "object");
    assert.equal(typeof APPROVAL_EVIDENCE_REQUIRED_FIELDS, "object");
    assert.equal(typeof APPROVAL_EVIDENCE_APPROVAL_REQUIRED_FIELDS, "object");

    assert.equal(typeof validateGovernanceContract, "function");
    assert.equal(typeof classifyRiskLevel, "function");
    assert.equal(typeof validateDualApproval, "function");
    assert.equal(typeof validateApprovalEvidenceSchema, "function");
    assert.equal(typeof recordApprovalEvidence, "function");
    assert.equal(typeof enforceGovernance, "function");
    assert.equal(typeof GovernanceContractError, "function");
  });

  it("GOVERNANCE_CONTRACT_VERSION matches policy.json governanceContract.version", async () => {
    const policyPath = new URL("../../policy.json", import.meta.url);
    const policy = JSON.parse(await fs.readFile(policyPath, "utf8"));
    assert.equal(
      policy.governanceContract?.version,
      GOVERNANCE_CONTRACT_VERSION,
      "policy.json governanceContract.version must match GOVERNANCE_CONTRACT_VERSION"
    );
  });
});

describe("GOVERNANCE_SIGNAL_REGISTRY dispatchBlockReason contract", () => {
  it("uses canonical outward block reasons for lane diversity while preserving rolling yield and autonomy", () => {
    assert.equal(
      GOVERNANCE_SIGNAL_REGISTRY.lane_diversity_gate_blocked.dispatchBlockReason,
      GOVERNANCE_DISPATCH_BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT,
    );
    assert.equal(
      GOVERNANCE_SIGNAL_REGISTRY.lane_diversity_insufficient.dispatchBlockReason,
      GOVERNANCE_DISPATCH_BLOCK_REASON.LANE_DIVERSITY_INSUFFICIENT,
    );
    assert.equal(
      GOVERNANCE_SIGNAL_REGISTRY.rolling_yield_throttle.dispatchBlockReason,
      GOVERNANCE_DISPATCH_BLOCK_REASON.ROLLING_YIELD_THROTTLE,
    );
    assert.equal(
      GOVERNANCE_SIGNAL_REGISTRY.autonomy_execution_gate_not_ready.dispatchBlockReason,
      GOVERNANCE_DISPATCH_BLOCK_REASON.AUTONOMY_EXECUTION_GATE_NOT_READY,
    );
  });
});

// ── validateGovernanceContract ────────────────────────────────────────────────
describe("validateGovernanceContract", () => {
  const validPolicy = {
    protectedPaths: ["src/core/**"],
    governanceContract: {
      version: GOVERNANCE_CONTRACT_VERSION,
      highRiskScoreThreshold: 0.7,
      approvedApproverRoles: ["athena", "human"]
    }
  };

  // AC1: positive path
  it("returns ok=true for a valid governance contract", () => {
    const result = validateGovernanceContract(validPolicy);
    assert.equal(result.ok, true);
    assert.equal(result.errorCode, null);
    assert.equal(result.message, null);
  });

  // AC1/AC11: negative path — POLICY_MISSING (missing input)
  it("returns POLICY_MISSING when policy is null", () => {
    const result = validateGovernanceContract(null);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_MISSING);
    assert.ok(result.message.includes("[governance]"), "message must include [governance] prefix");
    assert.ok(result.message.includes("POLICY_MISSING"), "message must include error code");
  });

  it("returns POLICY_MISSING when policy is undefined", () => {
    const result = validateGovernanceContract(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_MISSING);
  });

  // AC1/AC9: negative path — POLICY_INVALID (invalid input — missing section)
  it("returns POLICY_INVALID when governanceContract section is missing", () => {
    const result = validateGovernanceContract({ protectedPaths: [] });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
    assert.ok(result.message.includes("[governance]"));
    assert.ok(result.message.includes("POLICY_INVALID"));
  });

  it("returns POLICY_INVALID when governanceContract is not an object", () => {
    const result = validateGovernanceContract({ governanceContract: "string-value" });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("returns POLICY_INVALID when version is missing", () => {
    const result = validateGovernanceContract({
      governanceContract: { highRiskScoreThreshold: 0.7, approvedApproverRoles: ["athena"] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("returns POLICY_INVALID when version is empty string", () => {
    const result = validateGovernanceContract({
      governanceContract: { version: "   ", highRiskScoreThreshold: 0.7, approvedApproverRoles: ["athena"] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("returns POLICY_INVALID when highRiskScoreThreshold is missing", () => {
    const result = validateGovernanceContract({
      governanceContract: { version: GOVERNANCE_CONTRACT_VERSION, approvedApproverRoles: ["athena"] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("returns POLICY_INVALID when highRiskScoreThreshold is out of range", () => {
    const result = validateGovernanceContract({
      governanceContract: { version: GOVERNANCE_CONTRACT_VERSION, highRiskScoreThreshold: 1.5, approvedApproverRoles: ["athena"] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("returns POLICY_INVALID when approvedApproverRoles is empty array", () => {
    const result = validateGovernanceContract({
      governanceContract: { version: GOVERNANCE_CONTRACT_VERSION, highRiskScoreThreshold: 0.7, approvedApproverRoles: [] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  // AC1/AC9: negative path — CONTRACT_VERSION_MISMATCH (invalid — version present but wrong)
  it("returns CONTRACT_VERSION_MISMATCH when version does not match", () => {
    const result = validateGovernanceContract({
      governanceContract: { version: "0.9.0", highRiskScoreThreshold: 0.7, approvedApproverRoles: ["athena"] }
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, GOVERNANCE_ERROR_CODE.CONTRACT_VERSION_MISMATCH);
    assert.ok(result.message.includes(GOVERNANCE_CONTRACT_VERSION), "message must include expected version");
    assert.ok(result.message.includes("0.9.0"), "message must include actual version");
  });

  // AC1: exit code constant is deterministic and machine-checkable
  it("GOVERNANCE_STARTUP_EXIT_CODE is 1", () => {
    assert.equal(GOVERNANCE_STARTUP_EXIT_CODE, 1);
  });
});

// ── GovernanceContractError ───────────────────────────────────────────────────
describe("GovernanceContractError", () => {
  it("sets exitCode to GOVERNANCE_STARTUP_EXIT_CODE", () => {
    const err = new GovernanceContractError(GOVERNANCE_ERROR_CODE.POLICY_MISSING, "test detail");
    assert.equal(err.exitCode, GOVERNANCE_STARTUP_EXIT_CODE);
    assert.equal(err.exitCode, 1);
  });

  it("sets errorCode to the provided code", () => {
    const err = new GovernanceContractError(GOVERNANCE_ERROR_CODE.POLICY_INVALID, "bad contract");
    assert.equal(err.errorCode, GOVERNANCE_ERROR_CODE.POLICY_INVALID);
  });

  it("formats message as [governance] <errorCode>: <detail>", () => {
    const err = new GovernanceContractError(GOVERNANCE_ERROR_CODE.CONTRACT_VERSION_MISMATCH, "expected 1.0.0, got 0.9.0");
    assert.ok(err.message.startsWith("[governance]"));
    assert.ok(err.message.includes("CONTRACT_VERSION_MISMATCH"));
    assert.ok(err.message.includes("expected 1.0.0"));
  });

  it("is an instance of Error", () => {
    const err = new GovernanceContractError(GOVERNANCE_ERROR_CODE.POLICY_MISSING, "missing");
    assert.ok(err instanceof Error);
  });
});

// ── classifyRiskLevel ─────────────────────────────────────────────────────────
describe("classifyRiskLevel", () => {
  const basePolicy = {
    protectedPaths: ["src/core/**", "infra/**"],
    governanceContract: {
      highRiskScoreThreshold: 0.7,
      criticalRiskScoreThreshold: 0.9,
      highRiskChangeTypes: HIGH_RISK_CHANGE_TYPE_ENUM
    }
  };

  // LOW
  it("classifies LOW when riskScore is 0 and no high-risk indicators", () => {
    const result = classifyRiskLevel({ riskScore: 0, changeType: "config", filesChanged: ["README.md"] }, basePolicy);
    assert.equal(result, RISK_LEVEL.LOW);
  });

  it("classifies LOW when riskScore is below 0.4", () => {
    const result = classifyRiskLevel({ riskScore: 0.3, changeType: "config", filesChanged: ["README.md"] }, basePolicy);
    assert.equal(result, RISK_LEVEL.LOW);
  });

  // MEDIUM
  it("classifies MEDIUM when riskScore is >= 0.4 but < 0.7", () => {
    const result = classifyRiskLevel({ riskScore: 0.5, changeType: "config", filesChanged: ["README.md"] }, basePolicy);
    assert.equal(result, RISK_LEVEL.MEDIUM);
  });

  it("classifies MEDIUM at exactly 0.4", () => {
    const result = classifyRiskLevel({ riskScore: 0.4, changeType: "config", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.MEDIUM);
  });

  // HIGH — by riskScore
  it("classifies HIGH when riskScore is >= HIGH_RISK_SCORE_THRESHOLD (0.7)", () => {
    const result = classifyRiskLevel({ riskScore: 0.7, changeType: "config", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  it("classifies HIGH when riskScore is 0.8", () => {
    const result = classifyRiskLevel({ riskScore: 0.8, changeType: "config", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  // HIGH — by changeType
  it("classifies HIGH when changeType is core_module regardless of score", () => {
    const result = classifyRiskLevel({ riskScore: 0.1, changeType: "core_module", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  it("classifies HIGH when changeType is policy", () => {
    const result = classifyRiskLevel({ riskScore: 0, changeType: "policy", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  it("classifies HIGH when changeType is schema", () => {
    const result = classifyRiskLevel({ riskScore: 0, changeType: "schema", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  // HIGH — by touching protected path
  it("classifies HIGH when a changed file matches policy.protectedPaths", () => {
    const result = classifyRiskLevel(
      { riskScore: 0.1, changeType: "config", filesChanged: ["src/core/orchestrator.js"] },
      basePolicy
    );
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  it("classifies HIGH for infra/** protected path", () => {
    const result = classifyRiskLevel(
      { riskScore: 0, changeType: "config", filesChanged: ["infra/deploy.sh"] },
      basePolicy
    );
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  // CRITICAL — by riskScore
  it("classifies CRITICAL when riskScore is >= CRITICAL_RISK_SCORE_THRESHOLD (0.9)", () => {
    const result = classifyRiskLevel({ riskScore: 0.9, changeType: "config", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.CRITICAL);
  });

  it("classifies CRITICAL at riskScore 1.0", () => {
    const result = classifyRiskLevel({ riskScore: 1.0, changeType: "config", filesChanged: [] }, basePolicy);
    assert.equal(result, RISK_LEVEL.CRITICAL);
  });

  // CRITICAL — security + protected path
  it("classifies CRITICAL when changeType is security AND file touches protectedPaths", () => {
    const result = classifyRiskLevel(
      { riskScore: 0.1, changeType: "security", filesChanged: ["src/core/policy_engine.js"] },
      basePolicy
    );
    assert.equal(result, RISK_LEVEL.CRITICAL);
  });

  // security without protected path → HIGH (not CRITICAL)
  it("classifies HIGH (not CRITICAL) when changeType is security but no protected path touched", () => {
    const result = classifyRiskLevel(
      { riskScore: 0.1, changeType: "security", filesChanged: ["src/providers/openai.js"] },
      basePolicy
    );
    assert.equal(result, RISK_LEVEL.HIGH);
  });

  // Threshold override from policy
  it("uses policy.governanceContract.highRiskScoreThreshold as override", () => {
    const policy = {
      protectedPaths: [],
      governanceContract: { highRiskScoreThreshold: 0.5, criticalRiskScoreThreshold: 0.9, highRiskChangeTypes: [] }
    };
    const result = classifyRiskLevel({ riskScore: 0.6, changeType: "config", filesChanged: [] }, policy);
    assert.equal(result, RISK_LEVEL.HIGH, "should use 0.5 threshold from policy");
  });

  // Missing change fields use safe defaults
  it("classifies LOW safely when change is empty object", () => {
    const result = classifyRiskLevel({}, basePolicy);
    assert.equal(result, RISK_LEVEL.LOW);
  });

  it("classifies LOW safely when change is null", () => {
    const result = classifyRiskLevel(null, basePolicy);
    assert.equal(result, RISK_LEVEL.LOW);
  });
});

// ── validateDualApproval ──────────────────────────────────────────────────────
describe("validateDualApproval", () => {
  const validApprovalEvidence = {
    approvals: [
      { approverRole: "athena",  approvedAt: "2026-01-01T00:00:00Z", rationale: "plan reviewed" },
      { approverRole: "human",   approvedAt: "2026-01-01T00:01:00Z", rationale: "human confirmed" }
    ]
  };

  // Positive path
  it("returns ok=true for valid dual approval with 2 distinct roles", () => {
    const result = validateDualApproval(validApprovalEvidence);
    assert.equal(result.ok, true);
    assert.equal(result.reason, null);
  });

  it("returns ok=true with 3 approvals from 3 distinct roles", () => {
    const evidence = {
      approvals: [
        { approverRole: "athena",  approvedAt: "2026-01-01T00:00:00Z", rationale: "a" },
        { approverRole: "human",   approvedAt: "2026-01-01T00:01:00Z", rationale: "b" },
        { approverRole: "operator",approvedAt: "2026-01-01T00:02:00Z", rationale: "c" }
      ]
    };
    const result = validateDualApproval(evidence);
    assert.equal(result.ok, true);
  });

  // Negative path — APPROVALS_MISSING
  it("returns APPROVALS_MISSING when approvals field is absent", () => {
    const result = validateDualApproval({});
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("APPROVALS_MISSING"), `got: ${result.reason}`);
  });

  it("returns APPROVALS_MISSING when approvals is not an array", () => {
    const result = validateDualApproval({ approvals: "not-array" });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("APPROVALS_MISSING"));
  });

  it("returns APPROVALS_MISSING when approvalEvidence is null", () => {
    const result = validateDualApproval(null);
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("APPROVALS_MISSING"));
  });

  // Negative path — INSUFFICIENT_APPROVERS
  it("returns INSUFFICIENT_APPROVERS when only 1 approval provided", () => {
    const result = validateDualApproval({
      approvals: [{ approverRole: "athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "ok" }]
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("INSUFFICIENT_APPROVERS"), `got: ${result.reason}`);
    assert.ok(result.reason.includes("1"), "should mention count");
  });

  it("returns INSUFFICIENT_APPROVERS when empty approvals array", () => {
    const result = validateDualApproval({ approvals: [] });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("INSUFFICIENT_APPROVERS"));
  });

  // Negative path — APPROVAL_SCHEMA_INVALID
  it("returns APPROVAL_SCHEMA_INVALID when approverRole is missing", () => {
    const result = validateDualApproval({
      approvals: [
        { approverRole: "", approvedAt: "2026-01-01T00:00:00Z", rationale: "ok" },
        { approverRole: "human", approvedAt: "2026-01-01T00:01:00Z", rationale: "ok" }
      ]
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("APPROVAL_SCHEMA_INVALID"), `got: ${result.reason}`);
    assert.ok(result.reason.includes("approverRole"));
  });

  it("returns APPROVAL_SCHEMA_INVALID when rationale is missing", () => {
    const result = validateDualApproval({
      approvals: [
        { approverRole: "athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "" },
        { approverRole: "human",  approvedAt: "2026-01-01T00:01:00Z", rationale: "ok" }
      ]
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("APPROVAL_SCHEMA_INVALID"));
    assert.ok(result.reason.includes("rationale"));
  });

  // Negative path — INSUFFICIENT_DISTINCT_ROLES (AC2/AC12 resolved)
  it("returns INSUFFICIENT_DISTINCT_ROLES when both approvals have same role", () => {
    const result = validateDualApproval({
      approvals: [
        { approverRole: "athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "first" },
        { approverRole: "athena", approvedAt: "2026-01-01T00:01:00Z", rationale: "second" }
      ]
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("INSUFFICIENT_DISTINCT_ROLES"), `got: ${result.reason}`);
  });

  it("treats approverRole comparison as case-insensitive", () => {
    const result = validateDualApproval({
      approvals: [
        { approverRole: "Athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "ok" },
        { approverRole: "ATHENA", approvedAt: "2026-01-01T00:01:00Z", rationale: "ok" }
      ]
    });
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("INSUFFICIENT_DISTINCT_ROLES"));
  });
});

// ── validateApprovalEvidenceSchema ────────────────────────────────────────────
describe("validateApprovalEvidenceSchema", () => {
  const validEvidence = {
    changeId:        "abc-123",
    changedBy:       "self-improvement",
    changedAt:       "2026-01-01T00:00:00Z",
    riskLevel:       RISK_LEVEL.LOW,
    filesChanged:    ["box.config.json"],
    approvals:       [],
    contractVersion: GOVERNANCE_CONTRACT_VERSION
  };

  it("returns ok=true for a valid evidence record", () => {
    const result = validateApprovalEvidenceSchema(validEvidence);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingFields, []);
    assert.deepEqual(result.invalidFields, []);
  });

  it("returns ok=false with all required fields listed when evidence is null", () => {
    const result = validateApprovalEvidenceSchema(null);
    assert.equal(result.ok, false);
    for (const field of APPROVAL_EVIDENCE_REQUIRED_FIELDS) {
      assert.ok(result.missingFields.includes(field), `expected ${field} in missingFields`);
    }
  });

  it("returns ok=false listing missing fields (not all fields)", () => {
    const incomplete = { changeId: "x", changedBy: "bot", changedAt: "2026-01-01T00:00:00Z" };
    const result = validateApprovalEvidenceSchema(incomplete);
    assert.equal(result.ok, false);
    assert.ok(result.missingFields.includes("riskLevel"), "riskLevel should be missing");
    assert.ok(result.missingFields.includes("filesChanged"), "filesChanged should be missing");
    assert.ok(!result.missingFields.includes("changeId"), "changeId should NOT be missing");
  });

  // AC8: invalid enum value detected
  it("returns ok=false with invalidFields when riskLevel is not a valid enum value", () => {
    const evidence = { ...validEvidence, riskLevel: "extreme" };
    const result = validateApprovalEvidenceSchema(evidence);
    assert.equal(result.ok, false);
    assert.ok(result.invalidFields.some(f => f.includes("riskLevel")), `got: ${JSON.stringify(result.invalidFields)}`);
  });

  it("returns ok=false when filesChanged is not an array", () => {
    const evidence = { ...validEvidence, filesChanged: "not-array" };
    const result = validateApprovalEvidenceSchema(evidence);
    assert.equal(result.ok, false);
    assert.ok(result.invalidFields.some(f => f.includes("filesChanged")));
  });

  it("accepts all valid RISK_LEVEL enum values", () => {
    for (const level of RISK_LEVEL_ENUM) {
      const evidence = { ...validEvidence, riskLevel: level };
      const result = validateApprovalEvidenceSchema(evidence);
      assert.equal(result.ok, true, `expected ok=true for riskLevel=${level}`);
    }
  });
});

// ── recordApprovalEvidence ────────────────────────────────────────────────────
describe("recordApprovalEvidence", () => {
  const validEvidence = {
    changeId:        "test-record-001",
    changedBy:       "test-agent",
    changedAt:       "2026-01-01T00:00:00Z",
    riskLevel:       RISK_LEVEL.LOW,
    filesChanged:    ["box.config.json"],
    approvals:       [],
    contractVersion: GOVERNANCE_CONTRACT_VERSION
  };

  it("returns SCHEMA_INVALID reason when evidence is missing required fields", async () => {
    const result = await recordApprovalEvidence({ changeId: "x" }, {});
    assert.equal(result.ok, false);
    assert.ok(result.reason.includes("SCHEMA_INVALID"), `got: ${result.reason}`);
  });

  it("returns ok=true and appends a valid JSON line to the evidence file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gov-test-"));
    const evidencePath = path.join(tmpDir, "approval_evidence.jsonl");
    const config = { governanceContract: { approvalEvidencePath: evidencePath } };

    const result = await recordApprovalEvidence(validEvidence, config);
    assert.equal(result.ok, true, `expected ok=true, got reason: ${result.reason}`);

    const content = await fs.readFile(evidencePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 1, "should have written exactly 1 line");

    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.changeId, validEvidence.changeId);
    assert.equal(parsed.riskLevel, validEvidence.riskLevel);
    assert.equal(parsed.contractVersion, GOVERNANCE_CONTRACT_VERSION);

    // Cleanup
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends multiple records as separate JSONL lines", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gov-test-"));
    const evidencePath = path.join(tmpDir, "approval_evidence.jsonl");
    const config = { governanceContract: { approvalEvidencePath: evidencePath } };

    await recordApprovalEvidence({ ...validEvidence, changeId: "ev-001" }, config);
    await recordApprovalEvidence({ ...validEvidence, changeId: "ev-002" }, config);

    const content = await fs.readFile(evidencePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2, "should have 2 lines");
    assert.equal(JSON.parse(lines[0]).changeId, "ev-001");
    assert.equal(JSON.parse(lines[1]).changeId, "ev-002");

    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

// ── enforceGovernance ─────────────────────────────────────────────────────────
describe("enforceGovernance", () => {
  const basePolicy = {
    protectedPaths: ["src/core/**"],
    governanceContract: {
      version: GOVERNANCE_CONTRACT_VERSION,
      highRiskScoreThreshold: 0.7,
      criticalRiskScoreThreshold: 0.9,
      highRiskChangeTypes: HIGH_RISK_CHANGE_TYPE_ENUM,
      approvedApproverRoles: ["athena", "human"]
    }
  };

  const validDualApproval = {
    approvals: [
      { approverRole: "athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "reviewed" },
      { approverRole: "human",  approvedAt: "2026-01-01T00:01:00Z", rationale: "confirmed" }
    ]
  };

  // Positive path — LOW risk, no approval needed
  it("allows LOW risk change without approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.2, changeType: "config", filesChanged: ["README.md"] },
      {},
      basePolicy
    );
    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(result.blockReason, null);
    assert.equal(result.riskLevel, RISK_LEVEL.LOW);
  });

  // Positive path — MEDIUM risk, no approval needed
  it("allows MEDIUM risk change without approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.5, changeType: "config", filesChanged: ["docs/readme.md"] },
      {},
      basePolicy
    );
    assert.equal(result.ok, true);
    assert.equal(result.riskLevel, RISK_LEVEL.MEDIUM);
  });

  // Positive path — HIGH risk WITH valid dual approval
  it("allows HIGH risk change with valid dual approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.8, changeType: "config", filesChanged: [] },
      validDualApproval,
      basePolicy
    );
    assert.equal(result.ok, true);
    assert.equal(result.blocked, false);
    assert.equal(result.riskLevel, RISK_LEVEL.HIGH);
  });

  // Positive path — CRITICAL risk WITH valid dual approval
  it("allows CRITICAL risk change with valid dual approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.95, changeType: "security", filesChanged: ["src/core/auth.js"] },
      validDualApproval,
      basePolicy
    );
    assert.equal(result.ok, true);
    assert.equal(result.riskLevel, RISK_LEVEL.CRITICAL);
  });

  // Negative path (AC3) — HIGH risk WITHOUT dual approval (hard-block)
  it("hard-blocks HIGH risk change without dual approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.8, changeType: "config", filesChanged: [] },
      {},  // no approvals
      basePolicy
    );
    assert.equal(result.ok, false, "high-risk change without approval must be blocked");
    assert.equal(result.blocked, true);
    assert.ok(result.blockReason.includes("DUAL_APPROVAL_REQUIRED"), `got: ${result.blockReason}`);
    assert.equal(result.riskLevel, RISK_LEVEL.HIGH);
  });

  // Negative path — CRITICAL risk WITHOUT dual approval (hard-block)
  it("hard-blocks CRITICAL risk change without dual approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.95, changeType: "core_module", filesChanged: ["src/core/orchestrator.js"] },
      { approvals: [] },
      basePolicy
    );
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
    assert.ok(result.blockReason.includes("DUAL_APPROVAL_REQUIRED"));
    assert.equal(result.riskLevel, RISK_LEVEL.CRITICAL);
  });

  // Negative path — high-risk change type triggers high-risk even with zero score
  it("hard-blocks core_module changeType change without approval even at riskScore 0", () => {
    const result = enforceGovernance(
      { riskScore: 0, changeType: "core_module", filesChanged: [] },
      {},
      basePolicy
    );
    assert.equal(result.ok, false);
    assert.equal(result.riskLevel, RISK_LEVEL.HIGH);
  });

  // Negative path — touching protected path triggers high-risk
  it("hard-blocks change touching protected path without approval", () => {
    const result = enforceGovernance(
      { riskScore: 0.1, changeType: "config", filesChanged: ["src/core/orchestrator.js"] },
      {},
      basePolicy
    );
    assert.equal(result.ok, false);
    assert.equal(result.blocked, true);
  });

  // Negative path — single approver (same role twice) is blocked
  it("hard-blocks when dual approval has only 1 distinct role", () => {
    const result = enforceGovernance(
      { riskScore: 0.8, changeType: "config", filesChanged: [] },
      {
        approvals: [
          { approverRole: "athena", approvedAt: "2026-01-01T00:00:00Z", rationale: "first" },
          { approverRole: "athena", approvedAt: "2026-01-01T00:01:00Z", rationale: "second" }
        ]
      },
      basePolicy
    );
    assert.equal(result.ok, false);
    assert.ok(result.blockReason.includes("DUAL_APPROVAL_REQUIRED"));
    assert.ok(result.blockReason.includes("INSUFFICIENT_DISTINCT_ROLES"));
  });
});

// ── AGENT_CONTRACT_GOVERNANCE_REASON_CODE ────────────────────────────────────
import { AGENT_CONTRACT_GOVERNANCE_REASON_CODE } from "../../src/core/governance_contract.js";

describe("AGENT_CONTRACT_GOVERNANCE_REASON_CODE", () => {
  it("exports all 6 expected reason codes as frozen string constants", () => {
    assert.equal(typeof AGENT_CONTRACT_GOVERNANCE_REASON_CODE, "object");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FILE_MISSING,        "AGENT_FILE_MISSING");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FRONTMATTER_MISSING, "AGENT_FRONTMATTER_MISSING");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_MODEL_MISSING,       "AGENT_MODEL_MISSING");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_TOOLS_MISSING,       "AGENT_TOOLS_MISSING");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_DESCRIPTION_MISSING, "AGENT_DESCRIPTION_MISSING");
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_SCHEMA_VIOLATION,    "AGENT_SCHEMA_VIOLATION");
  });

  it("negative path: object is frozen — mutation attempts are silently ignored", () => {
    // Frozen objects do not throw in non-strict mode but also do not mutate.
    const original = AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FILE_MISSING;
    try {
      (AGENT_CONTRACT_GOVERNANCE_REASON_CODE as any).AGENT_FILE_MISSING = "mutated";
    } catch { /* strict mode may throw — that is also acceptable */ }
    assert.equal(AGENT_CONTRACT_GOVERNANCE_REASON_CODE.AGENT_FILE_MISSING, original);
  });
});
