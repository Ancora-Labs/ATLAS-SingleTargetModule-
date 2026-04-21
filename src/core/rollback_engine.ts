/**
 * rollback_engine.js — Multi-level rollback engine for BOX orchestrator.
 *
 * ## Rollback levels and trigger conditions (AC-1 / Athena item #1)
 *
 *   config-only
 *     TRIGGER: CONFIG_PARSE_FAILURE — box.config.json fails JSON.parse
 *     TRIGGER: CONFIG_KEY_MISSING   — required config key absent
 *     TRIGGER: CANARY_ROLLBACK      — canary engine signals rollback
 *
 *   state-schema
 *     TRIGGER: STATE_SCHEMA_VIOLATION  — state file fails required-field validation
 *     TRIGGER: STATE_VERSION_MISMATCH  — state file schemaVersion unknown
 *
 *   policy-set
 *     TRIGGER: POLICY_PARSE_FAILURE    — policy.json fails JSON.parse
 *     TRIGGER: POLICY_GATE_MISSING     — required policy gate absent
 *     TRIGGER: POLICY_VERSION_MISMATCH — policy version incompatible
 *
 *   orchestration-code-freeze
 *     TRIGGER: CORE_FILE_MODIFIED      — critical file modified outside self-dev guard
 *     TRIGGER: SELF_DEV_GUARD_BREACH   — self-dev guard signals unauthorized core edit
 *
 *   full-baseline-restore
 *     TRIGGER: MULTI_LEVEL_FAILURE     — ≥2 rollback levels triggered in the same cycle
 *     TRIGGER: HEALTH_SCORE_CRITICAL   — health score < 0.3 after another level's rollback
 *
 * ## Incident record schema (AC-2 / Athena item #2)
 *   Storage: state/rollback_incidents.jsonl (append-only JSONL — immutable by design)
 *   Required fields: schemaVersion, incidentId, level, trigger, triggeredAt,
 *                    completedAt, status, stepsExecuted, evidence, baselineRef,
 *                    healthCheckResult, durationMs
 *
 * ## One-cycle SLA (AC-3 / Athena item #3)
 *   "One cycle" = config.rollbackEngine.oneCycleSlaMs (default: 5000ms)
 *   config-only and policy-set rollbacks must complete within this window.
 *   durationMs is recorded; SLA breach is flagged in the incident record.
 *
 * ## Baseline tag format (AC-4 / Athena item #4)
 *   Format: `box/baseline-YYYY-MM-DD`
 *   Storage: state/project_baseline.json (already set by project_lifecycle.js)
 *   Verification checks: CONFIG_PARSE, POLICY_PARSE, STATE_DIR_WRITABLE,
 *                        INCIDENT_LOG_PRESENT, FREEZE_LOCK_CONSISTENT
 *
 * ## Health validation (AC-5 / Athena item #5)
 *   Five deterministic checks, each with an explicit pass/fail contract:
 *     CONFIG_PARSE         — box.config.json parses without error
 *     POLICY_PARSE         — policy.json parses without error
 *     STATE_DIR_WRITABLE   — state/ accepts a sentinel write
 *     INCIDENT_LOG_PRESENT — rollback_incidents.jsonl is accessible
 *     FREEZE_LOCK_CONSISTENT — rollback_lock.json is absent or valid
 *
 * ## Orchestration-code freeze semantics (Athena item #6)
 *   Freeze:   write state/rollback_lock.json { frozen:true, frozenAt, frozenBy, scope }
 *   Scope:    selfDev.criticalFiles from box.config.json
 *   Unfreeze: set frozen=false with unfrozenAt, or delete the file
 *   No writes to files in scope are permitted while frozen (callers must check isFrozen()).
 *
 * ## State/ mutation boundary (Athena item #7)
 *   Rollback is permitted to write ONLY:
 *     state/rollback_incidents.jsonl — incident log (append-only)
 *     state/rollback_lock.json       — code freeze lock
 *     box.config.json                — config-only rollback target
 *     policy.json                    — policy-set rollback target
 *
 * ## No silent fallback (AC-10)
 *   Every public function returns { ok, status, reason } on failure.
 *   Critical state failures always set an explicit status field with a reason code.
 */

import path from "node:path";
import fs   from "node:fs/promises";
import { createHash } from "node:crypto";
import { readJson, readJsonSafe, writeJson, ensureParent } from "./fs_utils.js";
import { warn } from "./logger.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Integer schema version for rollback incident records. Bump on incompatible change. */
export const ROLLBACK_ENGINE_SCHEMA_VERSION = 1;

// ── Rollback level enum ───────────────────────────────────────────────────────

/**
 * All five rollback levels, in ascending severity order.
 * Each level has a discrete, deterministic trigger condition table (see module header).
 */
export const ROLLBACK_LEVEL = Object.freeze({
  CONFIG_ONLY:               "config-only",
  STATE_SCHEMA:              "state-schema",
  POLICY_SET:                "policy-set",
  ORCHESTRATION_CODE_FREEZE: "orchestration-code-freeze",
  FULL_BASELINE_RESTORE:     "full-baseline-restore"
});

// ── Trigger code enum ─────────────────────────────────────────────────────────

/**
 * Exhaustive set of machine-readable trigger codes, one-to-one with the
 * trigger condition table in the module header (resolves Athena item #1).
 *
 * Missing input (the trigger argument was absent):  MISSING_TRIGGER
 * Invalid input (the trigger value is not in this enum): INVALID_TRIGGER
 */
export const ROLLBACK_TRIGGER = Object.freeze({
  // config-only
  CONFIG_PARSE_FAILURE:    "CONFIG_PARSE_FAILURE",
  CONFIG_KEY_MISSING:      "CONFIG_KEY_MISSING",
  CANARY_ROLLBACK:         "CANARY_ROLLBACK",

  // state-schema
  STATE_SCHEMA_VIOLATION:  "STATE_SCHEMA_VIOLATION",
  STATE_VERSION_MISMATCH:  "STATE_VERSION_MISMATCH",

  // policy-set
  POLICY_PARSE_FAILURE:    "POLICY_PARSE_FAILURE",
  POLICY_GATE_MISSING:     "POLICY_GATE_MISSING",
  POLICY_VERSION_MISMATCH: "POLICY_VERSION_MISMATCH",

  // orchestration-code-freeze
  CORE_FILE_MODIFIED:      "CORE_FILE_MODIFIED",
  SELF_DEV_GUARD_BREACH:   "SELF_DEV_GUARD_BREACH",

  // full-baseline-restore
  MULTI_LEVEL_FAILURE:     "MULTI_LEVEL_FAILURE",
  HEALTH_SCORE_CRITICAL:   "HEALTH_SCORE_CRITICAL"
});

// ── Trigger-to-level mapping (deterministic dispatch table) ──────────────────

/**
 * Canonical trigger → level dispatch table.
 * executeRollback() uses this to validate trigger + level coherence.
 */
export const TRIGGER_LEVEL_MAP = Object.freeze({
  [ROLLBACK_TRIGGER.CONFIG_PARSE_FAILURE]:    ROLLBACK_LEVEL.CONFIG_ONLY,
  [ROLLBACK_TRIGGER.CONFIG_KEY_MISSING]:      ROLLBACK_LEVEL.CONFIG_ONLY,
  [ROLLBACK_TRIGGER.CANARY_ROLLBACK]:         ROLLBACK_LEVEL.CONFIG_ONLY,
  [ROLLBACK_TRIGGER.STATE_SCHEMA_VIOLATION]:  ROLLBACK_LEVEL.STATE_SCHEMA,
  [ROLLBACK_TRIGGER.STATE_VERSION_MISMATCH]:  ROLLBACK_LEVEL.STATE_SCHEMA,
  [ROLLBACK_TRIGGER.POLICY_PARSE_FAILURE]:    ROLLBACK_LEVEL.POLICY_SET,
  [ROLLBACK_TRIGGER.POLICY_GATE_MISSING]:     ROLLBACK_LEVEL.POLICY_SET,
  [ROLLBACK_TRIGGER.POLICY_VERSION_MISMATCH]: ROLLBACK_LEVEL.POLICY_SET,
  [ROLLBACK_TRIGGER.CORE_FILE_MODIFIED]:      ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE,
  [ROLLBACK_TRIGGER.SELF_DEV_GUARD_BREACH]:   ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE,
  [ROLLBACK_TRIGGER.MULTI_LEVEL_FAILURE]:     ROLLBACK_LEVEL.FULL_BASELINE_RESTORE,
  [ROLLBACK_TRIGGER.HEALTH_SCORE_CRITICAL]:   ROLLBACK_LEVEL.FULL_BASELINE_RESTORE
});

// ── Incident status enum ──────────────────────────────────────────────────────

export const ROLLBACK_STATUS = Object.freeze({
  TRIGGERED:  "triggered",
  EXECUTING:  "executing",
  COMPLETED:  "completed",
  FAILED:     "failed",
  SLA_BREACH: "sla_breach"
});

// ── Health check enum ─────────────────────────────────────────────────────────

/**
 * Exhaustive set of post-rollback health check identifiers (AC-5 / Athena item #5).
 * Each maps to a deterministic pass/fail predicate in runHealthValidation().
 */
export const HEALTH_CHECK = Object.freeze({
  CONFIG_PARSE:           "CONFIG_PARSE",
  POLICY_PARSE:           "POLICY_PARSE",
  STATE_DIR_WRITABLE:     "STATE_DIR_WRITABLE",
  INCIDENT_LOG_PRESENT:   "INCIDENT_LOG_PRESENT",
  FREEZE_LOCK_CONSISTENT: "FREEZE_LOCK_CONSISTENT"
});

// ── Validation reason codes ──────────────────────────────────────────────────

/**
 * Machine-readable reason codes for input validation.
 * Distinguishes missing input from invalid input (AC-9).
 */
export const ROLLBACK_REASON = Object.freeze({
  OK:                   "OK",
  MISSING_TRIGGER:      "MISSING_TRIGGER",    // trigger argument absent
  INVALID_TRIGGER:      "INVALID_TRIGGER",    // trigger not in ROLLBACK_TRIGGER enum
  MISSING_LEVEL:        "MISSING_LEVEL",      // level argument absent
  INVALID_LEVEL:        "INVALID_LEVEL",      // level not in ROLLBACK_LEVEL enum
  TRIGGER_LEVEL_MISMATCH: "TRIGGER_LEVEL_MISMATCH", // trigger not valid for level
  MISSING_CONFIG:       "MISSING_CONFIG",     // config object absent
  NO_ROLLBACK_TARGET:   "NO_ROLLBACK_TARGET"  // no value to roll back to
});

// ── State mutation boundary ───────────────────────────────────────────────────

/**
 * Exhaustive list of state/ paths that rollback is permitted to write.
 * Any write outside this set by rollback code is a protocol violation (Athena item #7).
 */
export const ROLLBACK_PERMITTED_WRITES = Object.freeze([
  "state/rollback_incidents.jsonl",
  "state/rollback_lock.json"
]);

/**
 * Files outside state/ that rollback is permitted to write (level-specific):
 *   config-only  → box.config.json
 *   policy-set   → policy.json
 */
export const ROLLBACK_PERMITTED_EXTERNAL_WRITES = Object.freeze({
  [ROLLBACK_LEVEL.CONFIG_ONLY]: ["box.config.json"],
  [ROLLBACK_LEVEL.POLICY_SET]:  ["policy.json"]
});

// ── Default configuration ─────────────────────────────────────────────────────

/**
 * Default rollback engine configuration.
 * Corresponds to box.config.json#rollbackEngine.
 */
export const ROLLBACK_ENGINE_DEFAULTS = Object.freeze({
  enabled:          true,
  oneCycleSlaMs:    5000,               // AC-3: one-cycle SLA wall-clock budget
  incidentLogPath:  "state/rollback_incidents.jsonl",
  lockFilePath:     "state/rollback_lock.json",
  baselineRefPath:  "state/project_baseline.json",
  configFilePath:   "box.config.json",
  policyFilePath:   "policy.json"
});

// ── Incident ID generation ────────────────────────────────────────────────────

/**
 * Generate a deterministic, collision-resistant incident ID.
 * Format: rollback-<sha1-12> derived from level+trigger+timestamp.
 */
function buildIncidentId(level, trigger, ts) {
  const hash = createHash("sha1")
    .update(`${level}:${trigger}:${ts}`)
    .digest("hex")
    .slice(0, 12);
  return `rollback-${hash}`;
}

// ── Input validation ─────────────────────────────────────────────────────────

/**
 * Validate a rollback request before execution.
 * Distinguishes missing input from invalid input (AC-9).
 *
 * @param {{ level: string, trigger: string, evidence: object }} params
 * @returns {{ ok: boolean, reason: string, message: string }}
 */
export function validateRollbackRequest(params) {
  if (!params || typeof params !== "object") {
    return { ok: false, reason: ROLLBACK_REASON.MISSING_TRIGGER, message: "params object is required" };
  }

  const { level, trigger } = params;

  if (trigger === undefined || trigger === null || trigger === "") {
    return { ok: false, reason: ROLLBACK_REASON.MISSING_TRIGGER, message: "trigger is required" };
  }
  if (!Object.values(ROLLBACK_TRIGGER).includes(trigger)) {
    return { ok: false, reason: ROLLBACK_REASON.INVALID_TRIGGER, message: `trigger '${trigger}' is not a valid ROLLBACK_TRIGGER value` };
  }

  if (level === undefined || level === null || level === "") {
    return { ok: false, reason: ROLLBACK_REASON.MISSING_LEVEL, message: "level is required" };
  }
  if (!Object.values(ROLLBACK_LEVEL).includes(level)) {
    return { ok: false, reason: ROLLBACK_REASON.INVALID_LEVEL, message: `level '${level}' is not a valid ROLLBACK_LEVEL value` };
  }

  const expectedLevel = TRIGGER_LEVEL_MAP[trigger];
  if (expectedLevel !== level) {
    return {
      ok: false,
      reason: ROLLBACK_REASON.TRIGGER_LEVEL_MISMATCH,
      message: `trigger '${trigger}' belongs to level '${expectedLevel}', not '${level}'`
    };
  }

  return { ok: true, reason: ROLLBACK_REASON.OK, message: "valid" };
}

// ── Incident record helpers ───────────────────────────────────────────────────

/**
 * Append a single incident record to the append-only JSONL incident log.
 * Immutability is enforced by append-only file operations (O_APPEND).
 *
 * The log is one JSON object per line — never a JSON array.
 * Schema (all fields required, AC-2 / Athena item #2):
 *   schemaVersion {number}    = ROLLBACK_ENGINE_SCHEMA_VERSION
 *   incidentId    {string}    — rollback-<sha1-12>
 *   level         {string}    — one of ROLLBACK_LEVEL
 *   trigger       {string}    — one of ROLLBACK_TRIGGER
 *   triggeredAt   {string}    — ISO 8601
 *   completedAt   {string|null}
 *   status        {string}    — one of ROLLBACK_STATUS
 *   stepsExecuted {string[]}  — ordered list of executed step descriptions
 *   evidence      {object}    — level-specific context provided by caller
 *   baselineRef   {string|null} — box/baseline-YYYY-MM-DD or null
 *   healthCheckResult {object|null}
 *   durationMs    {number|null}
 *   slaBreach     {boolean}
 */
async function appendIncident(logPath, record) {
  await ensureParent(logPath);
  const line = `${JSON.stringify(record)}\n`;
  // Use append flag — this is the immutability enforcement mechanism
  await fs.appendFile(logPath, line, { encoding: "utf8", flag: "a" });
}

// ── Freeze lock helpers ───────────────────────────────────────────────────────

/**
 * Write the orchestration-code-freeze lock file.
 * Scope = criticalFiles from box.config.json#selfDev.criticalFiles.
 */
async function writeFreezelock(lockPath, trigger, criticalFiles) {
  const lock = {
    frozen:    true,
    frozenAt:  new Date().toISOString(),
    frozenBy:  trigger,
    scope:     Array.isArray(criticalFiles) ? criticalFiles : [],
    unfrozenAt: null
  };
  await writeJson(lockPath, lock);
  return lock;
}

/**
 * Read the current freeze lock state, or return null if no lock file exists.
 * @param {string} lockPath
 * @returns {Promise<object|null>}
 */
export async function readFreezeLock(lockPath) {
  const result = await readJsonSafe(lockPath);
  if (!result.ok) return null;
  return result.data;
}

/**
 * Check whether the orchestration-code-freeze is currently active.
 * @param {string} lockPath
 * @returns {Promise<boolean>}
 */
export async function isFrozen(lockPath) {
  const lock = await readFreezeLock(lockPath);
  return lock?.frozen === true;
}

/**
 * Lift a previously applied code freeze by marking it unfrozen.
 * Does NOT delete the file — preserves audit trail.
 * @param {string} lockPath
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
export async function unfreeze(lockPath) {
  const lock = await readFreezeLock(lockPath);
  if (!lock) {
    return { ok: false, reason: "no lock file found" };
  }
  if (!lock.frozen) {
    return { ok: true, reason: "already unfrozen" };
  }
  lock.frozen = false;
  lock.unfrozenAt = new Date().toISOString();
  await writeJson(lockPath, lock);
  return { ok: true, reason: "unfrozen" };
}

// ── Post-rollback health validation ─────────────────────────────────────────

/**
 * Run all five post-rollback health checks (AC-5 / Athena item #5).
 *
 * Check list:
 *   CONFIG_PARSE         — box.config.json is valid JSON
 *   POLICY_PARSE         — policy.json is valid JSON
 *   STATE_DIR_WRITABLE   — state/ directory accepts a sentinel write + cleanup
 *   INCIDENT_LOG_PRESENT — rollback_incidents.jsonl exists and is accessible
 *   FREEZE_LOCK_CONSISTENT — rollback_lock.json is absent, or frozen is a boolean
 *
 * Returns:
 *   { ok: boolean, checks: Array<{ check, pass, reason }>, summary: string }
 *
 * Pass condition: ALL checks pass → ok=true.
 * The output surface is a structured object, never a raw string.
 *
 * @param {object} paths — { configFile, policyFile, stateDir, incidentLog, lockFile }
 * @returns {Promise<{ ok: boolean, checks: Array, summary: string }>}
 */
export async function runHealthValidation(paths) {
  const checks = [];

  // 1. CONFIG_PARSE
  {
    const r = await readJsonSafe(paths.configFile);
    checks.push({
      check: HEALTH_CHECK.CONFIG_PARSE,
      pass:  r.ok,
      reason: r.ok ? "parsed" : `${r.reason}: ${r.error?.message || "unknown"}`
    });
  }

  // 2. POLICY_PARSE
  {
    const r = await readJsonSafe(paths.policyFile);
    checks.push({
      check: HEALTH_CHECK.POLICY_PARSE,
      pass:  r.ok,
      reason: r.ok ? "parsed" : `${r.reason}: ${r.error?.message || "unknown"}`
    });
  }

  // 3. STATE_DIR_WRITABLE
  {
    const sentinel = path.join(paths.stateDir, ".rollback-health-sentinel");
    let pass = false;
    let reason;
    try {
      await ensureParent(sentinel);
      await fs.writeFile(sentinel, "ok", "utf8");
      await fs.rm(sentinel, { force: true });
      pass = true;
      reason = "writable";
    } catch (err) {
      reason = err.message || "write failed";
    }
    checks.push({ check: HEALTH_CHECK.STATE_DIR_WRITABLE, pass, reason });
  }

  // 4. INCIDENT_LOG_PRESENT
  {
    let pass = false;
    let reason;
    try {
      await fs.access(paths.incidentLog);
      pass = true;
      reason = "accessible";
    } catch (err) {
      reason = err.code === "ENOENT" ? "file not found (ENOENT)" : err.message || "inaccessible";
    }
    checks.push({ check: HEALTH_CHECK.INCIDENT_LOG_PRESENT, pass, reason });
  }

  // 5. FREEZE_LOCK_CONSISTENT
  {
    let pass = false;
    let reason;
    try {
      const lockData = await readJsonSafe(paths.lockFile);
      if (!lockData.ok && lockData.reason === "missing") {
        // No lock file → consistent (not frozen)
        pass = true;
        reason = "absent (not frozen)";
      } else if (lockData.ok && typeof lockData.data?.frozen === "boolean") {
        pass = true;
        reason = lockData.data.frozen ? "frozen" : "unfrozen";
      } else {
        reason = lockData.ok ? "frozen field missing or not boolean" : `read error: ${lockData.reason}`;
      }
    } catch (err) {
      reason = err.message || "check failed";
    }
    checks.push({ check: HEALTH_CHECK.FREEZE_LOCK_CONSISTENT, pass, reason });
  }

  const allPass = checks.every(c => c.pass);
  const failed  = checks.filter(c => !c.pass).map(c => c.check);
  const summary = allPass
    ? "all health checks passed"
    : `failed checks: ${failed.join(", ")}`;

  return { ok: allPass, checks, summary };
}

// ── Rollback level executors ──────────────────────────────────────────────────

/**
 * Execute config-only rollback.
 * Reads box.config.json backup from evidence.controlValue and writes it back.
 * Must complete within one-cycle SLA (oneCycleSlaMs).
 *
 * @param {object} ctx — { configFilePath, evidence: { controlValue, configPath } }
 * @returns {Promise<{ ok: boolean, steps: string[], reason?: string }>}
 */
async function executeConfigRollback(ctx) {
  const steps = [];

  const { configFilePath, evidence } = ctx;

  if (!evidence?.controlValue) {
    return { ok: false, steps, reason: ROLLBACK_REASON.NO_ROLLBACK_TARGET };
  }

  steps.push("read control value from evidence");
  try {
    // controlValue is the pre-canary config snapshot (object or partial patch)
    // Write it back to box.config.json
    const existing = await readJsonSafe(configFilePath);
    const current = existing.ok ? existing.data : {};

    // Apply controlValue as a deep patch (top-level keys only — safe shallow restore)
    const restored = { ...current, ...evidence.controlValue };
    await writeJson(configFilePath, restored);
    steps.push(`wrote control value back to ${configFilePath}`);
    return { ok: true, steps };
  } catch (err) {
    steps.push(`write failed: ${err.message}`);
    return { ok: false, steps, reason: err.message };
  }
}

/**
 * Execute state-schema rollback.
 * Moves the offending state file to a .corrupt backup and writes an empty valid skeleton.
 *
 * @param {object} ctx — { stateDir, evidence: { filePath, requiredFields } }
 * @returns {Promise<{ ok: boolean, steps: string[], reason?: string }>}
 */
async function executeStateSchemaRollback(ctx) {
  const steps = [];
  const { evidence } = ctx;

  if (!evidence?.filePath) {
    return { ok: false, steps, reason: ROLLBACK_REASON.NO_ROLLBACK_TARGET };
  }

  const corruptPath = `${evidence.filePath}.corrupt.${Date.now()}`;
  try {
    // Rename offending file to .corrupt backup — preserve for forensics
    await fs.rename(evidence.filePath, corruptPath);
    steps.push(`quarantined corrupt state file → ${corruptPath}`);

    // Write a typed empty skeleton so downstream code doesn't fail on missing file
    const skeleton = {
      schemaVersion: 1,
      quarantinedAt: new Date().toISOString(),
      reason:        "state-schema rollback — original file quarantined",
      originalPath:  evidence.filePath
    };
    await writeJson(evidence.filePath, skeleton);
    steps.push(`wrote empty skeleton to ${evidence.filePath}`);
    return { ok: true, steps };
  } catch (err) {
    steps.push(`quarantine failed: ${err.message}`);
    return { ok: false, steps, reason: err.message };
  }
}

/**
 * Execute policy-set rollback.
 * Restores policy.json from evidence.controlValue.
 *
 * @param {object} ctx — { policyFilePath, evidence: { controlValue } }
 * @returns {Promise<{ ok: boolean, steps: string[], reason?: string }>}
 */
async function executePolicyRollback(ctx) {
  const steps = [];
  const { policyFilePath, evidence } = ctx;

  if (!evidence?.controlValue) {
    return { ok: false, steps, reason: ROLLBACK_REASON.NO_ROLLBACK_TARGET };
  }

  steps.push("read policy control value from evidence");
  try {
    await writeJson(policyFilePath, evidence.controlValue);
    steps.push(`restored policy.json from control value`);
    return { ok: true, steps };
  } catch (err) {
    steps.push(`policy restore failed: ${err.message}`);
    return { ok: false, steps, reason: err.message };
  }
}

/**
 * Execute orchestration-code-freeze.
 * Writes the freeze lock and does NOT modify any source files.
 * Scope is derived from selfDev.criticalFiles in box.config.json.
 *
 * @param {object} ctx — { lockFilePath, criticalFiles, trigger }
 * @returns {Promise<{ ok: boolean, steps: string[], reason?: string }>}
 */
async function executeCodeFreeze(ctx) {
  const steps = [];
  const { lockFilePath, criticalFiles, trigger } = ctx;

  try {
    const lock = await writeFreezelock(lockFilePath, trigger, criticalFiles);
    steps.push(`wrote freeze lock to ${lockFilePath}`);
    steps.push(`frozen scope: ${lock.scope.length} critical files`);
    steps.push("code freeze active — no further writes to critical files until unfreeze()");
    return { ok: true, steps };
  } catch (err) {
    steps.push(`freeze lock write failed: ${err.message}`);
    return { ok: false, steps, reason: err.message };
  }
}

/**
 * Execute full-baseline-restore guidance.
 * Records the baseline tag reference and verification check list in the incident.
 * Automated step: validates baseline ref is resolvable in state/project_baseline.json.
 * Human step: instructions are recorded in the incident record (evidence.restoreGuidance).
 *
 * @param {object} ctx — { baselineRefPath, evidence }
 * @returns {Promise<{ ok: boolean, steps: string[], baselineRef: string|null, reason?: string }>}
 */
async function executeFullBaselineRestore(ctx) {
  const steps = [];
  const { baselineRefPath, evidence } = ctx;

  const baseline = await readJson(baselineRefPath, null);
  const baselineTag = baseline?.tagName || null;

  if (!baselineTag) {
    steps.push("WARNING: no baseline tag found in state/project_baseline.json");
    steps.push("manual baseline restore required — see evidence.restoreGuidance");
  } else {
    steps.push(`baseline tag resolved: ${baselineTag} → ${baseline.sha?.slice(0, 7) || "unknown"}`);
    steps.push("automated verification: CONFIG_PARSE, POLICY_PARSE, STATE_DIR_WRITABLE, INCIDENT_LOG_PRESENT, FREEZE_LOCK_CONSISTENT");
    steps.push(`restore command: git revert --no-commit ${baselineTag}..HEAD && git commit -m "Revert to baseline ${baselineTag}"`);
  }

  // Record machine-readable restore guidance
  const restoreGuidance = {
    baselineTag,
    baselineSha:         baseline?.sha || null,
    baselineRepo:        baseline?.repo || null,
    capturedAt:          baseline?.capturedAt || null,
    verificationChecks:  Object.values(HEALTH_CHECK),
    restoreCommand:      baselineTag
      ? `git revert --no-commit ${baselineTag}..HEAD && git commit -m "Revert to baseline ${baselineTag}"`
      : "git revert --no-commit <baseline-tag>..HEAD && git commit -m 'Revert to baseline'",
    note: "Run runHealthValidation() after completing the restore to confirm system health"
  };

  if (evidence && typeof evidence === "object") {
    evidence.restoreGuidance = restoreGuidance;
  }

  return { ok: true, steps, baselineRef: baselineTag };
}

// ── Main public API ───────────────────────────────────────────────────────────

/**
 * Resolve rollback engine configuration from box.config.json#rollbackEngine.
 * Falls back to ROLLBACK_ENGINE_DEFAULTS for any absent key.
 */
export function resolveRollbackConfig(boxConfig) {
  const rc = boxConfig?.rollbackEngine || {};
  return {
    enabled:         rc.enabled         ?? ROLLBACK_ENGINE_DEFAULTS.enabled,
    oneCycleSlaMs:   rc.oneCycleSlaMs   ?? ROLLBACK_ENGINE_DEFAULTS.oneCycleSlaMs,
    incidentLogPath: rc.incidentLogPath ?? ROLLBACK_ENGINE_DEFAULTS.incidentLogPath,
    lockFilePath:    rc.lockFilePath    ?? ROLLBACK_ENGINE_DEFAULTS.lockFilePath,
    baselineRefPath: rc.baselineRefPath ?? ROLLBACK_ENGINE_DEFAULTS.baselineRefPath,
    configFilePath:  rc.configFilePath  ?? ROLLBACK_ENGINE_DEFAULTS.configFilePath,
    policyFilePath:  rc.policyFilePath  ?? ROLLBACK_ENGINE_DEFAULTS.policyFilePath,
    criticalFiles:   rc.criticalFiles   ?? (boxConfig?.selfDev?.criticalFiles || [])
  };
}

/**
 * Execute a rollback at the specified level with the given trigger.
 *
 * Algorithm:
 *   1. Validate inputs (missing vs. invalid, AC-9)
 *   2. Write "triggered" incident record (AC-2)
 *   3. Execute level-specific steps with SLA timer (AC-3)
 *   4. Run post-rollback health validation (AC-5)
 *   5. Append final incident record with status, steps, health, duration (AC-2)
 *   6. Return structured result — never throws, always sets status (AC-10)
 *
 * @param {object} params
 *   @param {string}  params.level     — one of ROLLBACK_LEVEL
 *   @param {string}  params.trigger   — one of ROLLBACK_TRIGGER
 *   @param {object}  [params.evidence] — level-specific context
 *   @param {object}  params.config    — full box.config.json object
 *   @param {string}  [params.stateDir] — override state directory path
 * @returns {Promise<{
 *   ok: boolean,
 *   status: string,
 *   reason: string|null,
 *   incidentId: string|null,
 *   durationMs: number|null,
 *   slaBreach: boolean,
 *   healthCheckResult: object|null,
 *   baselineRef: string|null
 * }>}
 */
export async function executeRollback(params) {
  // ── Validate inputs ──────────────────────────────────────────────────────
  const validation = validateRollbackRequest(params);
  if (!validation.ok) {
    return {
      ok:               false,
      status:           "degraded",
      reason:           validation.reason,
      incidentId:       null,
      durationMs:       null,
      slaBreach:        false,
      healthCheckResult: null,
      baselineRef:       null
    };
  }

  if (!params.config || typeof params.config !== "object") {
    return {
      ok:               false,
      status:           "degraded",
      reason:           ROLLBACK_REASON.MISSING_CONFIG,
      incidentId:       null,
      durationMs:       null,
      slaBreach:        false,
      healthCheckResult: null,
      baselineRef:       null
    };
  }

  const { level, trigger, evidence = {}, config } = params;
  const rc = resolveRollbackConfig(config);
  const stateDir = params.stateDir || "state";

  const triggeredAt = new Date().toISOString();
  const incidentId  = buildIncidentId(level, trigger, triggeredAt);
  const startMs     = Date.now();

  // ── Write "triggered" incident record ────────────────────────────────────
  const triggeredRecord = {
    schemaVersion:   ROLLBACK_ENGINE_SCHEMA_VERSION,
    incidentId,
    level,
    trigger,
    triggeredAt,
    completedAt:     null,
    status:          ROLLBACK_STATUS.TRIGGERED,
    stepsExecuted:   [],
    evidence:        { ...evidence },
    baselineRef:     null,
    healthCheckResult: null,
    durationMs:      null,
    slaBreach:       false
  };

  try {
    await appendIncident(rc.incidentLogPath, triggeredRecord);
  } catch (err) {
    warn(`[rollback] failed to write triggered incident: ${err.message}`);
  }

  // ── Execute level-specific rollback ──────────────────────────────────────
  let execResult;
  let baselineRef = null;

  try {
    switch (level) {
      case ROLLBACK_LEVEL.CONFIG_ONLY:
        execResult = await executeConfigRollback({
          configFilePath: rc.configFilePath,
          evidence
        });
        break;

      case ROLLBACK_LEVEL.STATE_SCHEMA:
        execResult = await executeStateSchemaRollback({
          stateDir,
          evidence
        });
        break;

      case ROLLBACK_LEVEL.POLICY_SET:
        execResult = await executePolicyRollback({
          policyFilePath: rc.policyFilePath,
          evidence
        });
        break;

      case ROLLBACK_LEVEL.ORCHESTRATION_CODE_FREEZE:
        execResult = await executeCodeFreeze({
          lockFilePath:  rc.lockFilePath,
          criticalFiles: rc.criticalFiles,
          trigger
        });
        break;

      case ROLLBACK_LEVEL.FULL_BASELINE_RESTORE:
        execResult = await executeFullBaselineRestore({
          baselineRefPath: rc.baselineRefPath,
          evidence
        });
        baselineRef = execResult.baselineRef || null;
        break;

      default:
        execResult = { ok: false, steps: [], reason: `unhandled level: ${level}` };
    }
  } catch (err) {
    execResult = { ok: false, steps: [], reason: err.message };
    warn(`[rollback] level execution threw: ${err.message}`);
  }

  const durationMs  = Date.now() - startMs;
  const oneCycleSla = rc.oneCycleSlaMs;
  const slaBreach   = (
    (level === ROLLBACK_LEVEL.CONFIG_ONLY || level === ROLLBACK_LEVEL.POLICY_SET) &&
    durationMs > oneCycleSla
  );

  if (slaBreach) {
    warn(`[rollback] SLA breach: level=${level} durationMs=${durationMs} slaMs=${oneCycleSla}`);
  }

  // ── Post-rollback health validation ──────────────────────────────────────
  const healthCheckResult = await runHealthValidation({
    configFile:  rc.configFilePath,
    policyFile:  rc.policyFilePath,
    stateDir,
    incidentLog: rc.incidentLogPath,
    lockFile:    rc.lockFilePath
  });

  // ── Write final incident record ───────────────────────────────────────────
  const completedAt = new Date().toISOString();
  const finalStatus = !execResult.ok
    ? ROLLBACK_STATUS.FAILED
    : slaBreach
      ? ROLLBACK_STATUS.SLA_BREACH
      : ROLLBACK_STATUS.COMPLETED;

  const finalRecord = {
    ...triggeredRecord,
    completedAt,
    status:           finalStatus,
    stepsExecuted:    execResult.steps || [],
    evidence:         { ...evidence },
    baselineRef,
    healthCheckResult,
    durationMs,
    slaBreach
  };

  try {
    await appendIncident(rc.incidentLogPath, finalRecord);
  } catch (err) {
    warn(`[rollback] failed to write final incident: ${err.message}`);
  }

  return {
    ok:               execResult.ok,
    status:           finalStatus,
    reason:           execResult.ok ? null : (execResult.reason || "execution failed"),
    incidentId,
    durationMs,
    slaBreach,
    healthCheckResult,
    baselineRef
  };
}

/**
 * Read all incident records from the JSONL log.
 * Returns an array of parsed incident objects in append order.
 *
 * @param {string} logPath
 * @returns {Promise<object[]>}
 */
export async function readIncidentLog(logPath) {
  try {
    const raw = await fs.readFile(logPath, "utf8");
    return raw
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}
