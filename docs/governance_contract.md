# Governance Policy Contract

**Contract version:** `1.0.0`  
**Risk level:** HIGH (hard-blocking safety control)  
**Task:** T-031

---

## Overview

The BOX governance policy contract defines machine-enforced rules for autonomous changes:
who can change what, under which evidence, and with which rollback SLA.

All enforcement is runtime-deterministic and machine-verifiable via `npm test`.

---

## Runtime Enforcement Mapping (AC5/T-031)

The table below maps each acceptance criterion to the exact runtime function that enforces it.
Every listed function is covered by a deterministic automated test in
`tests/core/governance_contract.test.ts`.

| Acceptance Criterion | Runtime Function | Test Coverage |
|---|---|---|
| AC1: Contract versioned and validated at startup | `validateGovernanceContract(policy)` | `describe("validateGovernanceContract")` |
| AC1: Startup failure exit code | `GOVERNANCE_STARTUP_EXIT_CODE = 1` | `it("GOVERNANCE_STARTUP_EXIT_CODE is 1")` |
| AC1: Error message format | `GovernanceContractError` | `describe("GovernanceContractError")` |
| AC2: High-risk classification (quantitative) | `classifyRiskLevel(change, policy)` | `describe("classifyRiskLevel")` |
| AC2: Dual-approval field schema | `validateDualApproval(approvalEvidence)` | `describe("validateDualApproval")` |
| AC3: Contract violations hard-block changes | `enforceGovernance(change, approval, policy)` | `describe("enforceGovernance")` |
| AC4: Approval evidence schema | `validateApprovalEvidenceSchema(evidence)` | `describe("validateApprovalEvidenceSchema")` |
| AC4: Evidence persistence | `recordApprovalEvidence(evidence, config)` | `describe("recordApprovalEvidence")` |
| AC7: Negative-path test | `it("hard-blocks HIGH risk change without dual approval")` | Explicit negative path |
| AC8: JSON schema with enums | `APPROVAL_EVIDENCE_REQUIRED_FIELDS`, `RISK_LEVEL_ENUM` | Schema constant tests |
| AC9: Missing vs invalid input | `GOVERNANCE_ERROR_CODE.POLICY_MISSING` vs `POLICY_INVALID` | Separate error code tests |
| AC10: No silent fallback | `status: "governance-blocked"` with `blockReason` field | Self-improvement integration |

---

## Contract Schema

### `policy.governanceContract` (required at startup)

```json
{
  "version":                    "1.0.0",
  "highRiskScoreThreshold":     0.7,
  "criticalRiskScoreThreshold": 0.9,
  "highRiskChangeTypes":        ["core_module", "policy", "security", "schema"],
  "approvedApproverRoles":      ["athena", "janus", "human", "operator"],
  "rollbackSlaMinutes":         30,
  "approvalEvidencePath":       "state/approval_evidence.jsonl"
}
```

### Approval Evidence Record (`state/approval_evidence.jsonl`)

Format: JSONL (one JSON object per line, append-only)

```json
{
  "changeId":        "string — unique change identifier",
  "changedBy":       "string — agent or user identity",
  "changedAt":       "string — ISO 8601 timestamp",
  "riskLevel":       "critical | high | medium | low",
  "filesChanged":    ["string[]"],
  "approvals": [
    {
      "approverRole": "string — distinct role identifier",
      "approvedAt":   "string — ISO 8601 timestamp",
      "rationale":    "string — approval reason"
    }
  ],
  "contractVersion": "string — GOVERNANCE_CONTRACT_VERSION at time of change"
}
```

---

## Risk Classification Rules

| Risk Level | Conditions |
|---|---|
| `critical` | `riskScore >= 0.9` OR (`changeType === "security"` AND touches `protectedPaths`) |
| `high`     | `riskScore >= 0.7` OR `changeType` in `["core_module","policy","security","schema"]` OR touches `protectedPaths` |
| `medium`   | `riskScore >= 0.4` |
| `low`      | everything else |

CRITICAL and HIGH require dual approval before change application.

---

## Dual-Approval Requirements

HIGH and CRITICAL changes require:
- `approvals.length >= 2`
- `>= 2 distinct approverRole values` (case-insensitive)
- Each approval: `{ approverRole, approvedAt, rationale }` — all non-empty strings

---

## Startup Validation

`validateGovernanceContract(policy)` is called at startup.  
On failure, it returns `{ ok: false, errorCode, message }`:

| Error Code | Cause | Recovery |
|---|---|---|
| `POLICY_MISSING` | `policy` is `null`/`undefined` | Ensure policy.json is readable |
| `POLICY_INVALID` | `governanceContract` section missing or structurally invalid | Fix policy.json and restart |
| `CONTRACT_VERSION_MISMATCH` | Version mismatch between policy and `GOVERNANCE_CONTRACT_VERSION` | Update policy.json version field |

Exit code on failure: **1** (`GOVERNANCE_STARTUP_EXIT_CODE`).

---

## Rollback SLA

`rollbackSlaMinutes: 30` — governed changes must be reversible within 30 minutes.  
Rollback path: revert to static policy file with governance validator disabled.

