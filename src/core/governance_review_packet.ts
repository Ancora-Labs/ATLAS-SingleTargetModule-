/**
 * governance_review_packet.js — Monthly governance review board artifact generator.
 *
 * Generates a deterministic governance packet from state artifacts for human review.
 * Output: state/governance_packets/governance_packet_{YYYY-MM}.json
 *
 * Reads (read-only — never modifies live state/ files):
 *   state/approval_evidence.jsonl   — decision logs with high-risk changes and approvals
 *   state/evolution_progress.json   — active cycle ID
 *   state/improvement_reports.json  — cycle metrics (health scores, lesson counts)
 *   state/athena_postmortems.json   — decision quality scores
 *   state/experiment_registry.json  — intervention IDs and unresolved experiment risks
 *
 * High-risk threshold (AC2, Athena missing item #2 resolved):
 *   A change is classified high-risk if riskLevel ∈ {"high","critical"} OR
 *   riskScore >= HIGH_RISK_THRESHOLD (0.7 — reuses governance_contract.HIGH_RISK_SCORE_THRESHOLD).
 *
 * Metrics included (AC1, Athena missing item #3 resolved):
 *   totalCycles             — count of improvement_reports entries in the review period
 *   completedTasks          — count of tasks with status "completed" in evolution_progress
 *   rollbackCount           — count of experiments with status "rolled_back" in registry
 *   experimentCount         — count of experiments in registry for the period
 *   decisionQualityScore    — weighted score in [0,1] from athena_postmortems (or null)
 *   decisionQualityLabelCounts — per-label count from athena_postmortems
 *   systemHealthScore       — average systemHealthScore across improvement_reports for period
 *   highRiskChangeCount     — count of high/critical changes from approval_evidence.jsonl
 *
 * Secret scanning (AC4): before writing, all fields whose key name matches a known
 * secret-key pattern (token, secret, password, etc.) are stripped recursively.
 *
 * Trigger (Athena missing item #4 resolved):
 *   CLI via scripts/generate-governance-packet.ts
 *   node scripts/generate-governance-packet.ts [--month YYYY-MM] [--state-dir <path>] [--dry-run]
 *
 * Output path (Athena missing item #6 resolved):
 *   state/governance_packets/governance_packet_{YYYY-MM}.json
 *   Sub-directory prevents accidental writes to live state/ root files.
 *
 * Risk level: MEDIUM — a faulty packet that omits critical interventions could
 * delay human escalation. All required fields are validated before write.
 * No side effects on live state/ directory (read-only operation).
 */

import path from "node:path";
import fs from "node:fs/promises";
import { readJsonSafe, READ_JSON_REASON, writeJson } from "./fs_utils.js";
import { extractPostmortemEntries, migrateData, STATE_FILE_TYPE } from "./schema_registry.js";
import { normalizeDecisionQualityLabel, DECISION_QUALITY_LABEL } from "./athena_reviewer.js";
import { HIGH_RISK_SCORE_THRESHOLD, RISK_LEVEL } from "./governance_contract.js";

const DECISION_QUALITY_WEIGHTS = Object.freeze({
  [DECISION_QUALITY_LABEL.CORRECT]: 1.0,
  [DECISION_QUALITY_LABEL.DELAYED_CORRECT]: 0.6,
  [DECISION_QUALITY_LABEL.INCORRECT]: 0.0,
  [DECISION_QUALITY_LABEL.INCONCLUSIVE]: 0.3,
});

function computeWeightedDecisionScore(postmortems) {
  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return { score: null, labelCounts: {}, total: 0 };
  }
  const labelCounts = {};
  for (const label of Object.values(DECISION_QUALITY_LABEL)) {
    labelCounts[label] = 0;
  }
  let weightedSum = 0;
  let count = 0;
  for (const postmortem of postmortems) {
    const label = normalizeDecisionQualityLabel(postmortem);
    labelCounts[label] = (labelCounts[label] || 0) + 1;
    weightedSum += DECISION_QUALITY_WEIGHTS[label] ?? DECISION_QUALITY_WEIGHTS[DECISION_QUALITY_LABEL.INCONCLUSIVE];
    count++;
  }
  return {
    score: count > 0 ? weightedSum / count : null,
    labelCounts,
    total: count,
  };
}

// ── Schema version ────────────────────────────────────────────────────────────

/** Current schema version for governance_packet_{YYYY-MM}.json. */
export const GOVERNANCE_PACKET_SCHEMA_VERSION = 1;

// ── Status enum ───────────────────────────────────────────────────────────────

/**
 * Status values for a generated governance review packet.
 *
 *   ok               — all data sources available; full packet generated
 *   degraded         — generated with partial data; degradedSources lists affected fields
 *   insufficient_data — not enough state data to generate a meaningful packet
 *
 * @enum {string}
 */
export const GOVERNANCE_PACKET_STATUS = Object.freeze({
  OK:                "ok",
  DEGRADED:          "degraded",
  INSUFFICIENT_DATA: "insufficient_data"
});

// ── Reason codes ──────────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for packet generation failures and degraded states.
 *
 * Distinguishes missing input (ABSENT) from invalid input (INVALID) for each source
 * (Athena AC9 / AC10 resolved).
 *
 *   APPROVAL_EVIDENCE_ABSENT    — state/approval_evidence.jsonl not found (ENOENT)
 *   APPROVAL_EVIDENCE_INVALID   — approval_evidence.jsonl present but failed to parse
 *   EVOLUTION_ABSENT            — evolution_progress.json not found (ENOENT)
 *   EVOLUTION_INVALID           — evolution_progress.json present but failed to parse
 *   REPORTS_ABSENT              — improvement_reports.json not found (ENOENT)
 *   REPORTS_INVALID             — improvement_reports.json present but failed to parse
 *   REGISTRY_ABSENT             — experiment_registry.json not found (ENOENT)
 *   REGISTRY_INVALID            — experiment_registry.json present but failed to parse
 *   POSTMORTEMS_ABSENT          — athena_postmortems.json not found (ENOENT)
 *   POSTMORTEMS_INVALID         — athena_postmortems.json present but failed to parse
 *   MISSING_INPUT               — persist called with null/undefined packet
 *   INVALID_INPUT               — persist called with present packet that fails schema validation
 *   WRITE_FAILED                — packet file could not be written to disk
 *
 * @enum {string}
 */
export const PACKET_REASON_CODE = Object.freeze({
  APPROVAL_EVIDENCE_ABSENT:  "APPROVAL_EVIDENCE_ABSENT",
  APPROVAL_EVIDENCE_INVALID: "APPROVAL_EVIDENCE_INVALID",
  EVOLUTION_ABSENT:          "EVOLUTION_ABSENT",
  EVOLUTION_INVALID:         "EVOLUTION_INVALID",
  REPORTS_ABSENT:            "REPORTS_ABSENT",
  REPORTS_INVALID:           "REPORTS_INVALID",
  REGISTRY_ABSENT:           "REGISTRY_ABSENT",
  REGISTRY_INVALID:          "REGISTRY_INVALID",
  POSTMORTEMS_ABSENT:        "POSTMORTEMS_ABSENT",
  POSTMORTEMS_INVALID:       "POSTMORTEMS_INVALID",
  MISSING_INPUT:             "MISSING_INPUT",
  INVALID_INPUT:             "INVALID_INPUT",
  WRITE_FAILED:              "WRITE_FAILED"
});

// ── Required packet fields (schema, AC8 / Athena missing item #1 resolved) ─────

/**
 * Required top-level fields for a governance review packet.
 * All must be present before the packet can be persisted.
 *
 * Fields:
 *   schemaVersion     — integer — GOVERNANCE_PACKET_SCHEMA_VERSION
 *   packetId          — string  — "gov-packet-{YYYY-MM}"
 *   cycleId           — string  — from evolution_progress.cycle_id
 *   monthKey          — string  — "YYYY-MM"
 *   generatedAt       — string  — ISO 8601 timestamp
 *   status            — string  — GOVERNANCE_PACKET_STATUS enum
 *   reviewPeriodStart — string  — ISO 8601 timestamp (start of month)
 *   reviewPeriodEnd   — string  — ISO 8601 timestamp (end of month)
 *   highRiskThreshold — number  — threshold used to classify high-risk changes
 *   metrics           — object  — see GOVERNANCE_PACKET_METRICS_FIELDS
 *   decisionLogs      — array   — approval_evidence entries for the period
 *   highRiskChanges   — array   — high-risk entries with owner + rollbackStatus
 *   unresolvedRisks   — array   — experiments still running/pending in the period
 *   interventionIds   — array   — distinct interventionId values from the period
 */
export const GOVERNANCE_PACKET_REQUIRED_FIELDS = Object.freeze([
  "schemaVersion",
  "packetId",
  "cycleId",
  "monthKey",
  "generatedAt",
  "status",
  "reviewPeriodStart",
  "reviewPeriodEnd",
  "highRiskThreshold",
  "metrics",
  "decisionLogs",
  "highRiskChanges",
  "unresolvedRisks",
  "interventionIds"
]);

/**
 * Required fields for each entry in decisionLogs (AC1 — decision logs must be present).
 *
 *   changeId        — string  — unique change identifier
 *   changedBy       — string  — identity of agent/user applying the change
 *   changedAt       — string  — ISO 8601 timestamp
 *   riskLevel       — string  — RISK_LEVEL enum value
 *   filesChanged    — array   — file paths modified
 *   approvals       — array   — approval chain records
 *   contractVersion — string  — governance contract version at time of change
 */
export const DECISION_LOG_REQUIRED_FIELDS = Object.freeze([
  "changeId",
  "changedBy",
  "changedAt",
  "riskLevel",
  "filesChanged",
  "approvals",
  "contractVersion"
]);

/**
 * Required fields for each entry in highRiskChanges (AC2 — high-risk changes must have
 * explicit owner and rollback status).
 *
 *   changeId       — string  — unique change identifier
 *   owner          — string  — first approverRole or changedBy identity
 *   changedAt      — string  — ISO 8601 timestamp
 *   riskLevel      — string  — "high" | "critical"
 *   filesChanged   — array   — file paths modified
 *   rollbackStatus — string  — ROLLBACK_STATUS enum value
 */
export const HIGH_RISK_CHANGE_REQUIRED_FIELDS = Object.freeze([
  "changeId",
  "owner",
  "changedAt",
  "riskLevel",
  "filesChanged",
  "rollbackStatus"
]);

// ── High-risk threshold (AC2, Athena missing item #2 resolved) ──────────────────

/**
 * Quantitative threshold for classifying a change as "high risk" in the governance packet.
 *
 * A change qualifies as high-risk if EITHER:
 *   (a) riskLevel ∈ {"high", "critical"} (explicit classification from RISK_LEVEL enum), OR
 *   (b) riskScore >= HIGH_RISK_THRESHOLD (numeric score-based classification)
 *
 * Value: 0.7 — reuses governance_contract.HIGH_RISK_SCORE_THRESHOLD for determinism.
 * Overriding this constant requires a matching change in governance_contract.js.
 */
export const HIGH_RISK_THRESHOLD = HIGH_RISK_SCORE_THRESHOLD; // 0.7

/**
 * Determine whether a change record from approval_evidence.jsonl qualifies as high-risk.
 *
 * @param {unknown} change
 * @returns {boolean}
 */
export function isHighRisk(change) {
  if (!change || typeof change !== "object") return false;
  const rl = String(change.riskLevel || "").toLowerCase();
  if (rl === RISK_LEVEL.HIGH || rl === RISK_LEVEL.CRITICAL) return true;
  const score = typeof change.riskScore === "number" ? change.riskScore : null;
  return score !== null && score >= HIGH_RISK_THRESHOLD;
}

// ── Rollback status enum ──────────────────────────────────────────────────────

/**
 * Rollback status values for high-risk change entries.
 *
 *   rolled_back     — a rolled_back experiment covers the changed files
 *   not_rolled_back — no rollback detected for this change
 *   unknown         — status cannot be determined from available state artifacts
 *
 * @enum {string}
 */
export const ROLLBACK_STATUS = Object.freeze({
  ROLLED_BACK:     "rolled_back",
  NOT_ROLLED_BACK: "not_rolled_back",
  UNKNOWN:         "unknown"
});

// ── Metrics field enumeration (AC1, Athena missing item #3 resolved) ───────────

/**
 * Exhaustive enumeration of metrics fields included in every governance packet.
 *
 * All fields are derived deterministically from state artifacts — no AI call.
 *
 *   totalCycles             — count of improvement_reports entries in the review period
 *   completedTasks          — tasks with status "completed"|"done" in evolution_progress
 *   rollbackCount           — experiments with status "rolled_back" in the period
 *   experimentCount         — total experiments in registry for the period
 *   decisionQualityScore    — weighted score [0,1] from athena_postmortems (null if none)
 *   decisionQualityLabelCounts — per-label tally from athena_postmortems
 *   systemHealthScore       — average systemHealthScore across improvement_reports (null if none)
 *   highRiskChangeCount     — count of high/critical changes from approval_evidence.jsonl
 */
export const GOVERNANCE_PACKET_METRICS_FIELDS = Object.freeze([
  "totalCycles",
  "completedTasks",
  "rollbackCount",
  "experimentCount",
  "decisionQualityScore",
  "decisionQualityLabelCounts",
  "systemHealthScore",
  "highRiskChangeCount"
]);

// ── Secret scanning (AC4) ─────────────────────────────────────────────────────

/**
 * Lowercase substring patterns that identify secret key names.
 * Any JSON key whose lowercased name contains one of these substrings is stripped
 * from the packet before output. Applied recursively.
 */
export const SECRET_KEY_PATTERNS = Object.freeze([
  "token",
  "secret",
  "password",
  "apikey",
  "api_key",
  "credential",
  "private_key",
  "privatekey",
  "auth_token",
  "authtoken",
  "access_key",
  "accesskey"
]);

/**
 * Deep-strip keys matching SECRET_KEY_PATTERNS from any value. Non-mutating.
 *
 * Arrays: each element is recursively stripped.
 * Objects: keys matching a secret pattern are omitted; values are recursively stripped.
 * Primitives: returned as-is.
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function stripSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      const kl = k.toLowerCase();
      if (SECRET_KEY_PATTERNS.some(p => kl.includes(p))) continue;
      out[k] = stripSecrets(v);
    }
    return out;
  }
  return value;
}

// ── Approval evidence reader ──────────────────────────────────────────────────

/**
 * Read state/approval_evidence.jsonl (one JSON object per line, append-only).
 *
 * Returns a structured outcome with reason codes.
 *
 * Handles:
 *   - Missing file (ENOENT)      → ok=false, reason=APPROVAL_EVIDENCE_ABSENT
 *   - Unreadable file             → ok=false, reason=APPROVAL_EVIDENCE_INVALID
 *   - Corrupt individual lines    → ok=true, line skipped (partial data > no data)
 *   - Empty file                  → ok=true, entries=[]
 *   - Valid file                  → ok=true, entries=[...parsed records]
 *
 * @param {string} filePath
 * @returns {Promise<{ ok: boolean, entries: object[], reason?: string }>}
 */
export async function readApprovalEvidence(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    const reason = err.code === "ENOENT"
      ? PACKET_REASON_CODE.APPROVAL_EVIDENCE_ABSENT
      : PACKET_REASON_CODE.APPROVAL_EVIDENCE_INVALID;
    return { ok: false, entries: [], reason };
  }

  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { ok: true, entries: [] };

  const entries = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip unparseable lines; partial data is better than no data for audit purposes.
    }
  }
  return { ok: true, entries };
}

// ── Governance packet generator ────────────────────────────────────────────────

/**
 * Generate a monthly governance review packet from state artifacts.
 *
 * This function is READ-ONLY with respect to state/ — it never modifies any live state
 * file. The caller must call persistGovernancePacket() to write the packet to disk.
 *
 * Returns { ok, status, packet, degradedSources? } — never throws.
 *
 * When all sources are available: status="ok", full packet.
 * When some sources missing/invalid: status="degraded", degradedSources lists reason codes.
 * No silent fallback: degraded state sets explicit status and degradedSources.
 *
 * @param {object} config
 * @param {string} [monthKey] — "YYYY-MM"; defaults to current UTC month
 * @returns {Promise<{ ok: boolean, status: string, packet: object|null, degradedSources?: string[] }>}
 */
export async function generateGovernancePacket(config, monthKey) {
  const stateDir = config?.paths?.stateDir || "state";
  const now = new Date();
  const defaultMonthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const resolvedMonthKey = typeof monthKey === "string" && /^\d{4}-\d{2}$/.test(monthKey)
    ? monthKey
    : defaultMonthKey;

  const [year, month] = resolvedMonthKey.split("-").map(Number);
  const reviewPeriodStart = new Date(Date.UTC(year, month - 1, 1)).toISOString();
  const reviewPeriodEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999)).toISOString();
  const periodStartMs = new Date(reviewPeriodStart).getTime();
  const periodEndMs   = new Date(reviewPeriodEnd).getTime();

  const degradedSources = [];

  // ── Read approval_evidence.jsonl (decision logs) ───────────────────────────
  const evidenceResult = await readApprovalEvidence(
    path.join(stateDir, "approval_evidence.jsonl")
  );
  let allEvidenceEntries = [];
  if (!evidenceResult.ok) {
    degradedSources.push(evidenceResult.reason);
  } else {
    allEvidenceEntries = evidenceResult.entries;
  }

  // Filter to the review period
  const periodEvidenceEntries = allEvidenceEntries.filter(e => {
    if (!e?.changedAt) return false;
    const ts = new Date(e.changedAt).getTime();
    return Number.isFinite(ts) && ts >= periodStartMs && ts <= periodEndMs;
  });

  // ── Read evolution_progress.json (cycle ID) ────────────────────────────────
  const evolutionResult = await readJsonSafe(path.join(stateDir, "evolution_progress.json"));
  let cycleId = null;
  if (!evolutionResult.ok) {
    degradedSources.push(
      evolutionResult.reason === READ_JSON_REASON.MISSING
        ? PACKET_REASON_CODE.EVOLUTION_ABSENT
        : PACKET_REASON_CODE.EVOLUTION_INVALID
    );
  } else {
    cycleId = evolutionResult.data?.cycle_id || null;
  }

  // ── Read improvement_reports.json (metrics) ────────────────────────────────
  const reportsResult = await readJsonSafe(path.join(stateDir, "improvement_reports.json"));
  let allReports = [];
  if (!reportsResult.ok) {
    degradedSources.push(
      reportsResult.reason === READ_JSON_REASON.MISSING
        ? PACKET_REASON_CODE.REPORTS_ABSENT
        : PACKET_REASON_CODE.REPORTS_INVALID
    );
  } else {
    allReports = Array.isArray(reportsResult.data?.reports) ? reportsResult.data.reports : [];
  }

  const periodReports = allReports.filter(r => {
    if (!r?.cycleAt) return false;
    const ts = new Date(r.cycleAt).getTime();
    return Number.isFinite(ts) && ts >= periodStartMs && ts <= periodEndMs;
  });

  // ── Read experiment_registry.json (intervention IDs, unresolved risks) ─────
  const registryResult = await readJsonSafe(path.join(stateDir, "experiment_registry.json"));
  let allExperiments = [];
  if (!registryResult.ok) {
    degradedSources.push(
      registryResult.reason === READ_JSON_REASON.MISSING
        ? PACKET_REASON_CODE.REGISTRY_ABSENT
        : PACKET_REASON_CODE.REGISTRY_INVALID
    );
  } else {
    allExperiments = Array.isArray(registryResult.data?.experiments)
      ? registryResult.data.experiments
      : [];
  }

  const periodExperiments = allExperiments.filter(e => {
    const ts = new Date(e?.createdAt || e?.startedAt || 0).getTime();
    return Number.isFinite(ts) && ts >= periodStartMs && ts <= periodEndMs;
  });

  // ── Read athena_postmortems.json (decision quality) ────────────────────────
  const postmortemsResult = await readJsonSafe(path.join(stateDir, "athena_postmortems.json"));
  let postmortems = [];
  if (!postmortemsResult.ok) {
    degradedSources.push(
      postmortemsResult.reason === READ_JSON_REASON.MISSING
        ? PACKET_REASON_CODE.POSTMORTEMS_ABSENT
        : PACKET_REASON_CODE.POSTMORTEMS_INVALID
    );
  } else {
    try {
      const migrated = migrateData(postmortemsResult.data, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
      if (migrated.ok) {
        postmortems = extractPostmortemEntries(migrated.data);
      } else {
        degradedSources.push("POSTMORTEMS_MIGRATION_FAILED");
      }
    } catch {
      degradedSources.push("POSTMORTEMS_MIGRATION_ERROR");
    }
  }

  // ── Compute metrics (AC1, Athena missing item #3 resolved) ────────────────
  const decisionQualityResult = computeWeightedDecisionScore(postmortems);

  // Average systemHealthScore across improvement reports for the period
  const healthScores = periodReports
    .map(r => typeof r.analysis?.systemHealthScore === "number" ? r.analysis.systemHealthScore : null)
    .filter(s => s !== null);
  const systemHealthScore = healthScores.length > 0
    ? Math.round(healthScores.reduce((a, b) => a + b, 0) / healthScores.length * 100) / 100
    : null;

  // Completed tasks from evolution_progress (all completed tasks in the cycle, not period-bound)
  let completedTasks = 0;
  if (evolutionResult.ok && evolutionResult.data?.tasks) {
    const taskMap = evolutionResult.data.tasks;
    completedTasks = Object.values(taskMap)
      .filter((t: any) => t?.status === "completed" || t?.status === "done")
      .length;
  }

  const highRiskEntries = periodEvidenceEntries.filter(isHighRisk);

  const metrics = {
    totalCycles:                periodReports.length,
    completedTasks,
    rollbackCount:              periodExperiments.filter(e => e.status === "rolled_back").length,
    experimentCount:            periodExperiments.length,
    decisionQualityScore:       decisionQualityResult.score,
    decisionQualityLabelCounts: decisionQualityResult.labelCounts,
    systemHealthScore,
    highRiskChangeCount:        highRiskEntries.length
  };

  // ── Build decision logs (AC1) ──────────────────────────────────────────────
  // Decision logs = all approval_evidence entries for the period.
  // Fields are mapped explicitly to avoid including unexpected fields.
  const decisionLogs = periodEvidenceEntries.map(e => ({
    changeId:        String(e.changeId        || ""),
    changedBy:       String(e.changedBy       || ""),
    changedAt:       String(e.changedAt       || ""),
    riskLevel:       String(e.riskLevel       || RISK_LEVEL.LOW),
    filesChanged:    Array.isArray(e.filesChanged) ? e.filesChanged : [],
    approvals:       Array.isArray(e.approvals)    ? e.approvals    : [],
    contractVersion: String(e.contractVersion || "")
  }));

  // ── Build high-risk change list (AC2) ──────────────────────────────────────
  // Determine rollback status by checking if any rolled_back experiment covers
  // any of the changed files via interventionScope overlap.
  const highRiskChanges = highRiskEntries.map(e => {
    const filesChanged = Array.isArray(e.filesChanged) ? e.filesChanged : [];

    const rolledBack = allExperiments.some(exp =>
      exp.status === "rolled_back" &&
      Array.isArray(exp.interventionScope) &&
      exp.interventionScope.some(s =>
        filesChanged.some(f => String(f).includes(String(s)))
      )
    );

    const rollbackStatus = rolledBack
      ? ROLLBACK_STATUS.ROLLED_BACK
      : (e.riskLevel === RISK_LEVEL.CRITICAL || e.riskLevel === RISK_LEVEL.HIGH)
        ? ROLLBACK_STATUS.NOT_ROLLED_BACK
        : ROLLBACK_STATUS.UNKNOWN;

    // Owner: first approverRole in approvals chain, or changedBy, or "unknown"
    const approvals = Array.isArray(e.approvals) ? e.approvals : [];
    const owner = approvals.length > 0
      ? String(approvals[0].approverRole || e.changedBy || "unknown")
      : String(e.changedBy || "unknown");

    return {
      changeId:        String(e.changeId  || ""),
      owner,
      changedAt:       String(e.changedAt || ""),
      riskLevel:       String(e.riskLevel || ""),
      filesChanged,
      rollbackStatus,
      approvals,
      contractVersion: String(e.contractVersion || "")
    };
  });

  // ── Build unresolved risks (AC1) ───────────────────────────────────────────
  // Unresolved risks = experiments that are still "running", "pending", or "active"
  // within the review period (no terminal status: completed/rolled_back).
  const unresolvedRisks = periodExperiments
    .filter(e => {
      const status = String(e.status || "").toLowerCase();
      return status === "running" || status === "pending" || status === "active";
    })
    .map(e => ({
      riskId:         String(e.experimentId  || ""),
      source:         "experiment_registry",
      description:    String(e.hypothesis || e.hypothesisId || "No description"),
      riskLevel:      isHighRisk(e) ? String(e.riskLevel || RISK_LEVEL.HIGH) : RISK_LEVEL.MEDIUM,
      detectedAt:     String(e.createdAt || e.startedAt || ""),
      interventionId: String(e.interventionId || e.experimentId || ""),
      status:         "unresolved"
    }));

  // ── Build intervention IDs (AC5) ───────────────────────────────────────────
  // Collect all distinct intervention IDs from experiments in the period (cycle-linkage).
  const interventionIds = [
    ...new Set(
      periodExperiments
        .map(e => String(e.interventionId || e.experimentId || ""))
        .filter(Boolean)
    )
  ];

  // ── Determine final status ─────────────────────────────────────────────────
  const status = degradedSources.length > 0
    ? GOVERNANCE_PACKET_STATUS.DEGRADED
    : GOVERNANCE_PACKET_STATUS.OK;

  // ── Assemble raw packet ────────────────────────────────────────────────────
  const packetId = `gov-packet-${resolvedMonthKey}`;
  const rawPacket = {
    schemaVersion:    GOVERNANCE_PACKET_SCHEMA_VERSION,
    packetId,
    cycleId:          cycleId || `cycle-${resolvedMonthKey}`,
    monthKey:         resolvedMonthKey,
    generatedAt:      now.toISOString(),
    status,
    reviewPeriodStart,
    reviewPeriodEnd,
    highRiskThreshold: HIGH_RISK_THRESHOLD,
    metrics,
    decisionLogs,
    highRiskChanges,
    unresolvedRisks,
    interventionIds,
    ...(degradedSources.length > 0 ? { degradedSources } : {})
  };

  // ── Secret scan (AC4) ──────────────────────────────────────────────────────
  const packet = stripSecrets(rawPacket);

  return { ok: true, status, packet };
}

// ── Packet persistence ─────────────────────────────────────────────────────────

/**
 * Validate and persist a governance packet to
 * state/governance_packets/governance_packet_{monthKey}.json.
 *
 * Using a sub-directory (governance_packets/) prevents accidental writes to the live
 * state/ root directory and isolates packet artifacts from operational state.
 * (Athena missing item #6 resolved — output path unspecified; potential side-effect on state/)
 *
 * Validates all required fields before writing.
 * Distinguishes missing input (MISSING_INPUT) from invalid input (INVALID_INPUT).
 * Never silently drops data — write errors return ok=false with WRITE_FAILED reason.
 *
 * @param {object} config
 * @param {object} packet — output of generateGovernancePacket().packet
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistGovernancePacket(config, packet) {
  if (packet === null || packet === undefined) {
    return {
      ok: false,
      reason: `${PACKET_REASON_CODE.MISSING_INPUT}: packet is null or undefined`
    };
  }
  if (typeof packet !== "object" || Array.isArray(packet)) {
    return {
      ok: false,
      reason: `${PACKET_REASON_CODE.INVALID_INPUT}: packet must be a non-array object`
    };
  }

  for (const field of GOVERNANCE_PACKET_REQUIRED_FIELDS) {
    if (!(field in packet)) {
      return {
        ok: false,
        reason: `${PACKET_REASON_CODE.INVALID_INPUT}: missing required field "${field}"`
      };
    }
  }

  const monthKey = String(packet.monthKey || "");
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return {
      ok: false,
      reason: `${PACKET_REASON_CODE.INVALID_INPUT}: monthKey must be "YYYY-MM", got "${monthKey}"`
    };
  }

  const stateDir  = config?.paths?.stateDir || "state";
  const packetDir = path.join(stateDir, "governance_packets");
  const filePath  = path.join(packetDir, `governance_packet_${monthKey}.json`);

  try {
    await fs.mkdir(packetDir, { recursive: true });
    await writeJson(filePath, packet);
    return { ok: true, filePath };
  } catch (err) {
    return {
      ok: false,
      reason: `${PACKET_REASON_CODE.WRITE_FAILED}: ${String(err?.message || err)}`
    };
  }
}
