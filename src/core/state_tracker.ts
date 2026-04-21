import fs from "node:fs/promises";
import path from "node:path";
import { ensureParent, readJson, writeJson } from "./fs_utils.js";
import { resolvePromptFamilyLineageJoinKey } from "./prompt_compiler.js";
import { emitEvent } from "./logger.js";
import { PLATFORM_MODE } from "./mode_state.js";
import { getTargetSessionProgressLogPath } from "./target_session_state.js";
import { EVENTS, EVENT_DOMAIN } from "./event_schema.js";
import { validateLineageEntry, buildFailureClusters, detectLoop, LINEAGE_ERROR_CODE, LINEAGE_THRESHOLDS } from "./lineage_graph.js";
import {
  OPTIMIZER_LOG_SCHEMA_VERSION,
  OPTIMIZER_LOG_JSONL_SCHEMA,
  OPTIMIZER_LOG_FRESHNESS_MS,
  OPTIMIZER_LOG_RECORD_TYPE,
} from "./intervention_optimizer.js";

// ── Alert severity enum — deterministic constants for all alert records ───────
export const ALERT_SEVERITY = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
};

export const STATE_RETENTION_CLASS = Object.freeze({
  PLANNING_TRUTH: "planning_truth",
  WARM_TELEMETRY: "warm_telemetry",
  AUDIT_LINEAGE: "audit_lineage",
});

export const STATE_RETENTION_RULES = Object.freeze({
  alerts: {
    key: "alerts",
    fileName: "alerts.json",
    retentionClass: STATE_RETENTION_CLASS.WARM_TELEMETRY,
    format: "json-history",
    historyKey: "entries",
    maxEntries: 120,
    newestFirst: false,
  },
  parserBaselineMetrics: {
    key: "parserBaselineMetrics",
    fileName: "parser_baseline_metrics.json",
    retentionClass: STATE_RETENTION_CLASS.PLANNING_TRUTH,
    format: "json-history",
    historyKey: "history",
    maxEntries: 100,
    newestFirst: true,
  },
  promptCacheTelemetry: {
    key: "promptCacheTelemetry",
    fileName: "prompt_cache_usage.jsonl",
    retentionClass: STATE_RETENTION_CLASS.WARM_TELEMETRY,
    format: "jsonl",
    maxEntries: 240,
  },
  interventionApplicationLedger: {
    key: "interventionApplicationLedger",
    fileName: "intervention_application_ledger.jsonl",
    retentionClass: STATE_RETENTION_CLASS.AUDIT_LINEAGE,
    format: "jsonl",
    maxEntries: 800,
  },
  interventionRetirementEvidence: {
    key: "interventionRetirementEvidence",
    fileName: "intervention_retirement_evidence.jsonl",
    retentionClass: STATE_RETENTION_CLASS.AUDIT_LINEAGE,
    format: "jsonl",
    maxEntries: 800,
  },
  policyClosureEvidence: {
    key: "policyClosureEvidence",
    fileName: "policy_closure_evidence.jsonl",
    retentionClass: STATE_RETENTION_CLASS.AUDIT_LINEAGE,
    format: "jsonl",
    maxEntries: 800,
  },
  interventionOptimizerLog: {
    key: "interventionOptimizerLog",
    fileName: "intervention_optimizer_log.jsonl",
    retentionClass: STATE_RETENTION_CLASS.WARM_TELEMETRY,
    format: "jsonl",
    maxEntries: 240,
  },
});

const RETENTION_CLASS_PRIORITY = Object.freeze({
  [STATE_RETENTION_CLASS.WARM_TELEMETRY]: 1,
  [STATE_RETENTION_CLASS.PLANNING_TRUTH]: 2,
  [STATE_RETENTION_CLASS.AUDIT_LINEAGE]: 3,
});

export function getStateRetentionRule(keyOrFileName: string | null | undefined): any {
  const needle = String(keyOrFileName || "").trim();
  if (!needle) return null;
  for (const rule of Object.values(STATE_RETENTION_RULES)) {
    if (rule.key === needle || rule.fileName === needle) {
      return rule;
    }
  }
  return null;
}

export function applyRetentionCap<T>(
  records: T[],
  maxEntries: number,
  opts: { newestFirst?: boolean } = {},
): T[] {
  const list = Array.isArray(records) ? [...records] : [];
  const safeMax = Number.isFinite(Number(maxEntries))
    ? Math.max(0, Math.floor(Number(maxEntries)))
    : list.length;
  if (safeMax <= 0) return [];
  if (list.length <= safeMax) return list;
  return opts.newestFirst === true
    ? list.slice(0, safeMax)
    : list.slice(list.length - safeMax);
}

export async function enforceStateRetention(
  config,
  opts: { rules?: string[] } = {},
): Promise<{ ok: boolean; totalTrimmed: number; touchedFiles: string[]; details: any[] }> {
  const stateDir = config?.paths?.stateDir || "state";
  const requested = Array.isArray(opts?.rules) && opts.rules.length > 0
    ? new Set(opts.rules.map((entry) => String(entry || "").trim()).filter(Boolean))
    : null;
  const rules = Object.values(STATE_RETENTION_RULES)
    .filter((rule) => !requested || requested.has(rule.key) || requested.has(rule.fileName))
    .sort((left, right) => {
      const priorityDelta = (RETENTION_CLASS_PRIORITY[left.retentionClass] || 99) - (RETENTION_CLASS_PRIORITY[right.retentionClass] || 99);
      return priorityDelta || String(left.fileName).localeCompare(String(right.fileName));
    });

  const details: any[] = [];
  const touchedFiles = new Set<string>();
  let totalTrimmed = 0;

  for (const rule of rules) {
    const filePath = path.join(stateDir, rule.fileName);
    try {
      if (rule.format === "jsonl") {
        const raw = await fs.readFile(filePath, "utf8").catch(() => "");
        const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
        const retained = applyRetentionCap(lines, rule.maxEntries, { newestFirst: false });
        const trimmed = Math.max(0, lines.length - retained.length);
        if (trimmed > 0) {
          await ensureParent(filePath);
          const nextRaw = retained.length > 0 ? `${retained.join("\n")}\n` : "";
          await fs.writeFile(filePath, nextRaw, "utf8");
          touchedFiles.add(rule.fileName);
          totalTrimmed += trimmed;
        }
        details.push({
          key: rule.key,
          fileName: rule.fileName,
          retentionClass: rule.retentionClass,
          trimmed,
          retained: retained.length,
        });
        continue;
      }

      if (rule.format === "json-history") {
        const historyRule = rule as any;
        const snapshot = await readJson(filePath, null);
        if (!snapshot || typeof snapshot !== "object") {
          details.push({
            key: rule.key,
            fileName: rule.fileName,
            retentionClass: rule.retentionClass,
            trimmed: 0,
            retained: 0,
          });
          continue;
        }
        const historyKey = String(historyRule.historyKey || "history");
        const history = Array.isArray((snapshot as any)[historyKey]) ? (snapshot as any)[historyKey] : [];
        const retained = applyRetentionCap(history, rule.maxEntries, { newestFirst: Boolean(historyRule.newestFirst) });
        const trimmed = Math.max(0, history.length - retained.length);
        if (trimmed > 0) {
          (snapshot as any)[historyKey] = retained;
          if (Object.prototype.hasOwnProperty.call(snapshot, "lastRecord")) {
            (snapshot as any).lastRecord = retained.length === 0
              ? null
              : (historyRule.newestFirst ? retained[0] : retained[retained.length - 1]);
          }
          (snapshot as any).updatedAt = new Date().toISOString();
          await writeJson(filePath, snapshot);
          touchedFiles.add(rule.fileName);
          totalTrimmed += trimmed;
        }
        details.push({
          key: rule.key,
          fileName: rule.fileName,
          retentionClass: rule.retentionClass,
          trimmed,
          retained: retained.length,
        });
      }
    } catch (err) {
      details.push({
        key: rule.key,
        fileName: rule.fileName,
        retentionClass: rule.retentionClass,
        trimmed: 0,
        retained: 0,
        error: String((err as any)?.message || err),
      });
    }
  }

  return { ok: true, totalTrimmed, touchedFiles: [...touchedFiles], details };
}

function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function aggregateByMonth(entries) {
  const result: Record<string, any> = {};
  for (const entry of entries) {
    const key = getMonthKey(new Date(entry.timestamp));
    if (!result[key]) {
      result[key] = {
        totalCalls: 0,
        opusCalls: 0,
        autoFallbacks: 0,
        byModel: {}
      };
    }

    const model = String(entry?.copilot?.model || "unknown");
    const invocation = String(entry?.copilot?.invocation || "unknown");
    const usedOpus = Boolean(entry?.copilot?.usedOpus);

    result[key].totalCalls += 1;
    result[key].byModel[model] = (result[key].byModel[model] || 0) + 1;
    if (usedOpus) {
      result[key].opusCalls += 1;
    }
    if (invocation.includes("fallback")) {
      result[key].autoFallbacks += 1;
    }
  }
  return result;
}

function aggregateClaudeByMonth(entries) {
  const result: Record<string, any> = {};
  for (const entry of entries) {
    const key = getMonthKey(new Date(entry.timestamp));
    if (!result[key]) {
      result[key] = {
        totalCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        byStage: {}
      };
    }

    const stage = String(entry.stage || "unknown");
    result[key].totalCalls += 1;
    result[key].inputTokens += Number(entry.inputTokens || 0);
    result[key].outputTokens += Number(entry.outputTokens || 0);
    result[key].cacheReadTokens += Number(entry.cacheReadTokens || 0);
    result[key].cacheCreationTokens += Number(entry.cacheCreationTokens || 0);
    result[key].byStage[stage] = (result[key].byStage[stage] || 0) + 1;
  }
  return result;
}

const PROGRESS_MAX_LINES = 200;
let _progressLineCount = -1; // lazy init

function resolveProgressFilePath(config) {
  return String(config?.paths?.progressFile || path.join(config?.paths?.stateDir || "state", "progress.txt"));
}

export function resolveRuntimeLoggingContext(config) {
  const requestedMode = String(config?.platformModeState?.currentMode || PLATFORM_MODE.SELF_DEV).trim() || PLATFORM_MODE.SELF_DEV;
  const activeTargetSession = config?.activeTargetSession && typeof config.activeTargetSession === "object"
    ? config.activeTargetSession
    : null;
  const projectId = String(activeTargetSession?.projectId || "").trim() || null;
  const sessionId = String(activeTargetSession?.sessionId || "").trim() || null;
  return {
    mode: requestedMode,
    activeTargetSession,
    projectId,
    sessionId,
  };
}

function resolveRuntimeLoggingContextWithOverrides(config, overrides = null) {
  const base = resolveRuntimeLoggingContext(config);
  const overrideProjectId = String(overrides?.projectId || "").trim() || null;
  const overrideSessionId = String(overrides?.sessionId || "").trim() || null;
  const overrideMode = String(overrides?.mode || "").trim() || null;
  const inferredMode = (!overrideMode && overrideProjectId && overrideSessionId)
    ? PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    : null;

  return {
    ...base,
    mode: overrideMode || inferredMode || base.mode,
    projectId: overrideProjectId || base.projectId,
    sessionId: overrideSessionId || base.sessionId,
  };
}

export function buildProgressLogPrefix(config, overrides = null) {
  const context = resolveRuntimeLoggingContextWithOverrides(config, overrides);
  const parts = [`mode=${context.mode}`];
  if (context.mode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY && context.projectId && context.sessionId) {
    parts.push(`projectId=${context.projectId}`);
    parts.push(`sessionId=${context.sessionId}`);
  }
  return `[${parts.join(" ")}]`;
}

export async function appendProgress(config, message, overrides = null) {
  const progressFilePath = resolveProgressFilePath(config);
  const loggingContext = resolveRuntimeLoggingContextWithOverrides(config, overrides);
  const prefix = buildProgressLogPrefix(config, overrides);
  await ensureParent(progressFilePath);
  const safeMessage = String(message || "").trim();
  const line = `[${new Date().toISOString()}] ${safeMessage}${safeMessage ? " " : ""}${prefix}\n`;
  await fs.appendFile(progressFilePath, line, "utf8");

  if (
    loggingContext.mode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    && loggingContext.projectId
    && loggingContext.sessionId
  ) {
    const sessionLogPath = getTargetSessionProgressLogPath(
      config?.paths?.stateDir || "state",
      loggingContext.projectId,
      loggingContext.sessionId,
    );
    await ensureParent(sessionLogPath);
    await fs.appendFile(sessionLogPath, line, "utf8").catch(() => {});
  }

  // Auto-trim: keep only the last PROGRESS_MAX_LINES lines
  _progressLineCount += 1;
  if (_progressLineCount >= 0 && _progressLineCount % 50 === 0) {
    try {
      const content = await fs.readFile(progressFilePath, "utf8");
      const lines = content.split("\n");
      if (lines.length > PROGRESS_MAX_LINES) {
        const trimmed = lines.slice(-PROGRESS_MAX_LINES).join("\n");
        await fs.writeFile(progressFilePath, trimmed, "utf8");
      }
    } catch { /* ignore trim errors */ }
  }
}

export async function loadTestsState(config) {
  const raw = await readJson(config.paths.testsStateFile, {
    tests: [],
    totals: {
      passed: 0,
      failed: 0,
      running: 0,
      queued: 0
    },
    updatedAt: new Date().toISOString()
  });

  return {
    tests: Array.isArray(raw?.tests) ? raw.tests : [],
    totals: raw?.totals && typeof raw.totals === "object"
      ? raw.totals
      : {
        passed: 0,
        failed: 0,
        running: 0,
        queued: 0
      },
    updatedAt: raw?.updatedAt || new Date().toISOString()
  };
}

export async function updateTaskInTestsState(config, task, status, notes = "") {
  const state = await loadTestsState(config);
  const existing = state.tests.find((t) =>
    Number(t.id) === Number(task.id) && String(t.title || t.name || "") === String(task.title || "")
  );

  if (existing) {
    existing.status = status;
    existing.title = task.title;
    existing.notes = notes;
    existing.updatedAt = new Date().toISOString();
  } else {
    state.tests.push({
      id: task.id,
      kind: task.kind || "general",
      name: task.title,
      title: task.title,
      status,
      notes,
      updatedAt: new Date().toISOString()
    });
  }

  state.totals = {
    passed: state.tests.filter((t) => t.status === "passed").length,
    failed: state.tests.filter((t) => t.status === "failed").length,
    running: state.tests.filter((t) => t.status === "running").length,
    queued: state.tests.filter((t) => t.status === "queued").length
  };
  state.updatedAt = new Date().toISOString();

  await writeJson(config.paths.testsStateFile, state);
}

export async function appendCopilotUsage(config, usage) {
  const state = await readJson(config.paths.copilotUsageFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(usage?.correlationId || `copilot-${Date.now()}`);
  state.entries.push({
    ...usage,
    timestamp: new Date().toISOString()
  });

  if (state.entries.length > 500) {
    state.entries = state.entries.slice(-500);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(config.paths.copilotUsageFile, state);

  const byMonth = aggregateByMonth(state.entries);
  await writeJson(config.paths.copilotUsageMonthlyFile, {
    generatedAt: new Date().toISOString(),
    byMonth
  });

  // Emit typed billing event (non-blocking; never throws)
  emitEvent(EVENTS.BILLING_USAGE_RECORDED, EVENT_DOMAIN.BILLING, correlationId, {
    source: "copilot",
    model: String(usage?.copilot?.model || "unknown"),
  });
}

export async function appendClaudeUsage(config, usage) {
  const claudeUsageFile = path.join(config.paths.stateDir, "claude_usage.json");
  const claudeUsageMonthlyFile = path.join(config.paths.stateDir, "claude_usage_monthly.json");

  const state = await readJson(claudeUsageFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(usage?.correlationId || `claude-${Date.now()}`);
  state.entries.push({
    ...usage,
    timestamp: new Date().toISOString()
  });

  if (state.entries.length > 1000) {
    state.entries = state.entries.slice(-1000);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(claudeUsageFile, state);

  const byMonth = aggregateClaudeByMonth(state.entries);
  await writeJson(claudeUsageMonthlyFile, {
    generatedAt: new Date().toISOString(),
    byMonth
  });

  // Emit typed billing event (non-blocking; never throws)
  emitEvent(EVENTS.BILLING_USAGE_RECORDED, EVENT_DOMAIN.BILLING, correlationId, {
    source: "claude",
    stage: String(usage?.stage || "unknown"),
    inputTokens: Number(usage?.inputTokens || 0),
    outputTokens: Number(usage?.outputTokens || 0),
  });
}

export async function getCurrentMonthCopilotStats(config) {
  const monthly = await readJson(config.paths.copilotUsageMonthlyFile, {
    byMonth: {}
  });
  const key = getMonthKey(new Date());
  return monthly.byMonth?.[key] || {
    totalCalls: 0,
    opusCalls: 0,
    autoFallbacks: 0,
    byModel: {}
  };
}

export async function loadAlerts(config) {
  const alertsFile = path.join(config.paths.stateDir, "alerts.json");
  return readJson(alertsFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });
}

/**
 * Persist a failure classification result to state/failure_classifications.json.
 *
 * AC #2: evidence and confidence are persisted alongside every classification.
 * AC #10: write errors set ok=false with an explicit reason; never silently dropped.
 *
 * Storage key: state/failure_classifications.json
 * Schema: { schemaVersion: 1, updatedAt: ISO, entries: ClassificationResult[] }
 * Entries are trimmed to the last 500 to prevent unbounded growth.
 *
 * @param {object} config
 * @param {object} classification — ClassificationResult from classifyFailure
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function appendFailureClassification(config, classification) {
  const classFile = path.join(config.paths?.stateDir || "state", "failure_classifications.json");
  try {
    const state = await readJson(classFile, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries: []
    });

    const entries = Array.isArray(state.entries) ? state.entries : [];
    entries.push({ ...classification, savedAt: new Date().toISOString() });

    if (entries.length > 500) {
      state.entries = entries.slice(-500);
    } else {
      state.entries = entries;
    }

    state.updatedAt = new Date().toISOString();
    await writeJson(classFile, state);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export interface RoutingTelemetryScope {
  lineageJoinKey?: string | null;
  lineageId?: string | null;
  taskKind?: string | null;
  role?: string | null;
  limit?: number;
}

export interface PromptCacheRoutingSignal {
  sampleCount: number;
  hitRate: number;
  avgSavedTokens: number;
  matchMode: string;
}

export interface FailureFinishEvidenceSignal {
  sampleCount: number;
  matchMode: string;
  lowRoiSignalCount: number;
  latestFailureClass: string | null;
  latestFinishCode: string | null;
  latestFinishStatus: string | null;
  verificationFailureCount: number;
  policyBlockCount: number;
  modelFailureCount: number;
  logicDefectCount: number;
}

function selectScopedTelemetryRecords<T>(
  records: T[],
  scope: RoutingTelemetryScope,
  projector: (record: T) => {
    lineageJoinKey: string | null;
    lineageId: string | null;
    taskKind: string | null;
    role: string | null;
  },
): { records: T[]; matchMode: string } {
  const allRecords = Array.isArray(records) ? records : [];
  const limit = Number.isFinite(Number(scope?.limit))
    ? Math.max(1, Math.floor(Number(scope?.limit)))
    : 20;
  const lineageJoinKey = normalizeLineageScalar(scope?.lineageJoinKey);
  const lineageId = normalizeLineageScalar(scope?.lineageId);
  const taskKind = normalizeLineageScalar(scope?.taskKind);
  const role = normalizeLineageScalar(scope?.role);
  const modes = [
    {
      mode: "lineageJoinKey",
      enabled: Boolean(lineageJoinKey),
      match: (record: T) => projector(record).lineageJoinKey === lineageJoinKey,
    },
    {
      mode: "lineageId",
      enabled: Boolean(lineageId),
      match: (record: T) => projector(record).lineageId === lineageId,
    },
    {
      mode: "taskKind+role",
      enabled: Boolean(taskKind && role),
      match: (record: T) => projector(record).taskKind === taskKind && projector(record).role === role,
    },
    {
      mode: "taskKind",
      enabled: Boolean(taskKind),
      match: (record: T) => projector(record).taskKind === taskKind,
    },
    {
      mode: "role",
      enabled: Boolean(role),
      match: (record: T) => projector(record).role === role,
    },
  ];
  for (const candidate of modes) {
    if (!candidate.enabled) continue;
    const matched = allRecords.filter(candidate.match);
    if (matched.length > 0) {
      return {
        records: matched.slice(-limit),
        matchMode: candidate.mode,
      };
    }
  }
  return { records: [], matchMode: "none" };
}

export async function appendAlert(config, alert) {
  const alertsFile = path.join(config.paths.stateDir, "alerts.json");
  const alertsRule = STATE_RETENTION_RULES.alerts;
  const state = await readJson(alertsFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(alert?.correlationId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const entry = {
    id: correlationId,
    timestamp: new Date().toISOString(),
    severity: String(alert?.severity || "warning"),
    source: String(alert?.source || "system"),
    title: String(alert?.title || "System alert"),
    message: String(alert?.message || "")
  };

  state.entries.push(entry);
  state.entries = applyRetentionCap(state.entries, alertsRule.maxEntries, {
    newestFirst: alertsRule.newestFirst,
  });

  state.updatedAt = new Date().toISOString();
  await writeJson(alertsFile, state);

  // Emit typed observability event (non-blocking; never throws)
  emitEvent(EVENTS.ORCHESTRATION_ALERT_EMITTED, EVENT_DOMAIN.ORCHESTRATION, correlationId, {
    severity: entry.severity,
    source: entry.source,
    title: entry.title,
  });
}

// ── Cache outcome tracking ─────────────────────────────────────────────────────

/**
 * Valid completion outcomes for cache outcome records.
 * Maps directly to LABEL_OUTCOME_MAP keys used by Athena.
 */
export const CACHE_COMPLETION_OUTCOME = Object.freeze({
  MERGED:   "merged",
  REOPEN:   "reopen",
  ROLLBACK: "rollback",
  TIMEOUT:  "timeout",
  UNKNOWN:  "unknown",
} as const);

export const INTERVENTION_LINEAGE_CONTRACT_SCHEMA_VERSION = 1 as const;

export interface InterventionLineageContract {
  schemaVersion: typeof INTERVENTION_LINEAGE_CONTRACT_SCHEMA_VERSION;
  lineageId: string | null;
  taskId: string | null;
  taskIdentity: string | null;
  cycleId: string | null;
  taskKind: string | null;
  interventionId: string | null;
  promptFamilyKey: string | null;
  continuationFamilyKey: string | null;
  model: string | null;
  role: string | null;
  lane: string | null;
  capability: string | null;
  specialized: boolean | null;
  rerouteReasonCode: string | null;
}

function normalizeLineageScalar(value: unknown, maxLength = 160): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeLineageBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  return null;
}

function normalizeLineageJoinTaskKind(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function normalizeInterventionLineageContract(
  input: unknown,
  defaults: Partial<InterventionLineageContract> = {},
): InterventionLineageContract {
  const src = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    schemaVersion: INTERVENTION_LINEAGE_CONTRACT_SCHEMA_VERSION,
    lineageId: normalizeLineageScalar(src.lineageId ?? src.id ?? defaults.lineageId),
    taskId: normalizeLineageScalar(src.taskId ?? src.task_id ?? defaults.taskId),
    taskIdentity: normalizeLineageScalar(
      src.taskIdentity
      ?? src.semanticKey
      ?? defaults.taskIdentity,
      240,
    ),
    cycleId: normalizeLineageScalar(src.cycleId ?? defaults.cycleId),
    taskKind: normalizeLineageScalar(src.taskKind ?? src.kind ?? defaults.taskKind),
    interventionId: normalizeLineageScalar(src.interventionId ?? src.id ?? defaults.interventionId),
    promptFamilyKey: normalizeLineageScalar(src.promptFamilyKey ?? defaults.promptFamilyKey),
    continuationFamilyKey: normalizeLineageScalar(
      src.continuationFamilyKey
      ?? src.familyKey
      ?? defaults.continuationFamilyKey,
    ),
    model: normalizeLineageScalar(src.model ?? src.resolvedModel ?? defaults.model),
    role: normalizeLineageScalar(
      src.role
      ?? src.roleName
      ?? src.worker
      ?? src.agent
      ?? defaults.role,
    ),
    lane: normalizeLineageScalar(src.lane ?? src.capabilityLane ?? defaults.lane),
    capability: normalizeLineageScalar(
      src.capability
      ?? src.capabilityId
      ?? src.capabilityTag
      ?? defaults.capability,
    ),
    specialized: normalizeLineageBoolean(src.specialized ?? defaults.specialized),
    rerouteReasonCode: normalizeLineageScalar(
      src.rerouteReasonCode
      ?? defaults.rerouteReasonCode,
    ),
  };
}

export function resolveInterventionLineageJoinKey(input: unknown): string | null {
  const contract = normalizeInterventionLineageContract(input);
  if (contract.lineageId) return `lineage:${contract.lineageId}`;
  if (contract.taskId && contract.cycleId) return `cycle-task:${contract.cycleId}:${contract.taskId}`;
  if (contract.taskId) return `task:${contract.taskId}`;
  if (contract.taskIdentity) return `identity:${contract.taskIdentity}`;
  if (contract.continuationFamilyKey) return `family:${contract.continuationFamilyKey}`;
  if (contract.interventionId && contract.cycleId) {
    return `cycle-intervention:${contract.cycleId}:${contract.interventionId}`;
  }
  if (contract.interventionId) return `intervention:${contract.interventionId}`;
  return null;
}

export function resolveStableInterventionLineage(
  input: unknown,
  defaults: Partial<InterventionLineageContract> = {},
  hints: {
    taskKind?: unknown;
    role?: unknown;
    explicitJoinKey?: unknown;
  } = {},
): {
  lineage: InterventionLineageContract;
  lineageJoinKey: string | null;
} {
  const lineage = normalizeInterventionLineageContract(input, defaults);
  return {
    lineage,
    lineageJoinKey: resolvePromptFamilyLineageJoinKey({
      promptFamilyKey: lineage.promptFamilyKey,
      taskKind: normalizeLineageJoinTaskKind(hints.taskKind ?? lineage.taskKind),
      role: hints.role ?? lineage.role,
      explicitJoinKey: hints.explicitJoinKey,
      fallbackJoinKey: resolveInterventionLineageJoinKey(lineage),
    }),
  };
}

export function mergeInterventionLineageContracts(
  ...values: unknown[]
): InterventionLineageContract {
  const fields: Array<keyof InterventionLineageContract> = [
    "lineageId",
    "taskId",
    "taskIdentity",
    "cycleId",
    "taskKind",
    "interventionId",
    "promptFamilyKey",
    "continuationFamilyKey",
    "model",
    "role",
    "lane",
    "capability",
    "specialized",
    "rerouteReasonCode",
  ];
  const merged = normalizeInterventionLineageContract(null);
  for (const value of values) {
    const contract = normalizeInterventionLineageContract(value);
    for (const field of fields) {
      if (merged[field] == null && contract[field] != null) {
        (merged as unknown as Record<string, unknown>)[field] = contract[field];
      }
    }
  }
  return merged;
}

/**
 * Persist a cache hit/miss record alongside its completion outcome.
 *
 * Persists to: state/cache_outcomes.jsonl  (NDJSON append log)
 * Entries are trimmed to the last 500 to prevent unbounded growth.
 *
 * Fail-open: write errors return { ok: false, reason } and are never thrown.
 *
 * @param {object} config
 * @param {{ correlationId?: string, cacheHit: boolean, completionOutcome: string, stage?: string }} record
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function appendCacheOutcome(
  config,
  record: {
    correlationId?: string;
    cacheHit: boolean;
    completionOutcome: string;
    stage?: string;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const cacheFile = path.join(
    config?.paths?.stateDir || "state",
    "cache_outcomes.jsonl",
  );

  try {
    if (record === null || record === undefined) {
      return { ok: false, reason: "record is required (got null/undefined)" };
    }
    if (typeof record.cacheHit !== "boolean") {
      return { ok: false, reason: "record.cacheHit must be a boolean" };
    }
    const validOutcomes = new Set<string>(Object.values(CACHE_COMPLETION_OUTCOME));
    const outcome = String(record.completionOutcome || CACHE_COMPLETION_OUTCOME.UNKNOWN);
    if (!validOutcomes.has(outcome)) {
      return { ok: false, reason: `unknown completionOutcome: '${outcome}'` };
    }

    const entry = JSON.stringify({
      correlationId: String(record.correlationId || `cache-${Date.now()}`),
      cacheHit: record.cacheHit,
      completionOutcome: outcome,
      stage: String(record.stage || "unknown"),
      recordedAt: new Date().toISOString(),
    });
    await fs.appendFile(cacheFile, entry + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

export async function appendPromptCacheTelemetry(
  config,
  record: {
    promptFamilyKey: string;
    agent?: string;
    model?: string;
    taskKind?: string;
    totalSegments: number;
    cachedSegments?: number;
    cacheableSegments?: number;
    estimatedSavedTokens?: number;
    stablePrefixHash?: string;
    lineage?: unknown;
    lineageId?: string;
    lineageJoinKey?: string;
    taskId?: string;
    cycleId?: string;
    interventionId?: string;
    lane?: string;
    capability?: string;
    specialized?: boolean;
    rerouteReasonCode?: string;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const filePath = path.join(config?.paths?.stateDir || "state", "prompt_cache_usage.jsonl");
  try {
    const normalized = normalizePromptCacheTelemetryEntry(record, {
      recordedAt: new Date().toISOString(),
    });
    if (normalized.ok === false) {
      return { ok: false, reason: normalized.reason };
    }
    await ensureParent(filePath);
    await fs.appendFile(filePath, JSON.stringify(normalized.entry) + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

function normalizePromptCacheTelemetryEntry(
  record: unknown,
  defaults: { recordedAt?: string } = {},
): { ok: true; entry: Record<string, unknown> } | { ok: false; reason: string } {
  const source = record && typeof record === "object" && !Array.isArray(record)
    ? record as Record<string, unknown>
    : {};
  const promptFamilyKey = normalizeLineageScalar(source.promptFamilyKey);
  if (!promptFamilyKey) {
    return { ok: false, reason: "promptFamilyKey is required" };
  }
  const totalSegments = Math.max(0, Math.floor(Number(source.totalSegments || 0)));
  if (totalSegments <= 0) {
    return { ok: false, reason: "totalSegments must be > 0" };
  }
  const cacheableSegments = Math.max(
    0,
    Math.floor(Number(source.cacheableSegments ?? source.cachedSegments ?? 0)),
  );
  const boundedCachedSegments = Math.min(totalSegments, cacheableSegments);
  const estimatedSavedTokens = Math.max(0, Math.round(Number(source.estimatedSavedTokens || 0)));
  const lineage = normalizeInterventionLineageContract(source.lineage, {
    lineageId: normalizeLineageScalar(source.lineageId),
    taskId: normalizeLineageScalar(source.taskId),
    cycleId: normalizeLineageScalar(source.cycleId),
    taskKind: normalizeLineageScalar(source.taskKind),
    interventionId: normalizeLineageScalar(source.interventionId),
    promptFamilyKey,
    model: normalizeLineageScalar(source.model),
    role: normalizeLineageScalar(source.agent ?? source.role),
    lane: normalizeLineageScalar(source.lane),
    capability: normalizeLineageScalar(source.capability),
    specialized: normalizeLineageBoolean(source.specialized),
    rerouteReasonCode: normalizeLineageScalar(source.rerouteReasonCode),
  });
  const lineageJoinKey = resolvePromptFamilyLineageJoinKey({
    promptFamilyKey,
    taskKind: source.taskKind ?? lineage.taskKind,
    role: source.agent ?? source.role ?? lineage.role,
    explicitJoinKey: source.lineageJoinKey,
    fallbackJoinKey: resolveInterventionLineageJoinKey(lineage),
  });
  const hitRate = Math.round((boundedCachedSegments / totalSegments) * 1000) / 1000;
  return {
    ok: true,
    entry: {
      ...source,
      promptFamilyKey,
      stablePrefixHash: normalizeLineageScalar(source.stablePrefixHash ?? promptFamilyKey),
      agent: String(source.agent || source.role || "unknown"),
      model: String(source.model || "unknown"),
      taskKind: String(source.taskKind || "general"),
      totalSegments,
      cachedSegments: boundedCachedSegments,
      cacheableSegments: boundedCachedSegments,
      hitRate,
      prefixReuseRate: hitRate,
      estimatedSavedTokens,
      lineageId: lineage.lineageId,
      lineageJoinKey,
      lineage,
      recordedAt: String(source.recordedAt || defaults.recordedAt || new Date().toISOString()),
    },
  };
}

export async function readPromptCacheTelemetry(config): Promise<any[]> {
  const filePath = path.join(config?.paths?.stateDir || "state", "prompt_cache_usage.jsonl");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const normalized = normalizePromptCacheTelemetryEntry(JSON.parse(line));
          return normalized.ok ? normalized.entry : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export async function summarizePromptCacheTelemetryForScope(
  config,
  scope: RoutingTelemetryScope = {},
): Promise<PromptCacheRoutingSignal> {
  const entries = await readPromptCacheTelemetry(config);
  const selected = selectScopedTelemetryRecords(entries, scope, (entry) => ({
    lineageJoinKey: normalizeLineageScalar((entry as any)?.lineageJoinKey),
    lineageId: normalizeLineageScalar((entry as any)?.lineageId ?? (entry as any)?.lineage?.lineageId),
    taskKind: normalizeLineageScalar((entry as any)?.taskKind),
    role: normalizeLineageScalar((entry as any)?.agent ?? (entry as any)?.role),
  }));
  if (selected.records.length === 0) {
    return { sampleCount: 0, hitRate: 0, avgSavedTokens: 0, matchMode: selected.matchMode };
  }
  let hitRateSum = 0;
  let savedTokensSum = 0;
  for (const entry of selected.records) {
    const totalSegments = Number((entry as any)?.totalSegments || 0);
    const cachedSegments = Number((entry as any)?.cachedSegments || 0);
    const hitRate = totalSegments > 0
      ? Math.max(0, Math.min(1, cachedSegments / totalSegments))
      : Math.max(0, Math.min(1, Number((entry as any)?.hitRate || 0)));
    hitRateSum += hitRate;
    savedTokensSum += Math.max(0, Number((entry as any)?.estimatedSavedTokens || 0));
  }
  const sampleCount = selected.records.length;
  return {
    sampleCount,
    hitRate: Math.round((hitRateSum / sampleCount) * 1000) / 1000,
    avgSavedTokens: Math.round(savedTokensSum / sampleCount),
    matchMode: selected.matchMode,
  };
}

export async function readFailureClassificationHistory(config): Promise<any[]> {
  const filePath = path.join(config?.paths?.stateDir || "state", "failure_classifications.json");
  try {
    const snapshot = await readJson(filePath, { entries: [] });
    return Array.isArray((snapshot as any)?.entries)
      ? (snapshot as any).entries.filter((entry) => entry && typeof entry === "object")
      : [];
  } catch {
    return [];
  }
}

export async function summarizeFailureFinishEvidenceForScope(
  config,
  scope: RoutingTelemetryScope = {},
): Promise<FailureFinishEvidenceSignal> {
  const history = await readFailureClassificationHistory(config);
  const selected = selectScopedTelemetryRecords(history, scope, (entry) => ({
    lineageJoinKey: normalizeLineageScalar((entry as any)?.lineageJoinKey ?? (entry as any)?.lineage?.lineageJoinKey),
    lineageId: normalizeLineageScalar((entry as any)?.lineageId ?? (entry as any)?.lineage?.lineageId),
    taskKind: normalizeLineageScalar((entry as any)?.taskKind ?? (entry as any)?.lineage?.taskKind),
    role: normalizeLineageScalar((entry as any)?.roleName ?? (entry as any)?.role ?? (entry as any)?.lineage?.role),
  }));
  if (selected.records.length === 0) {
    return {
      sampleCount: 0,
      matchMode: selected.matchMode,
      lowRoiSignalCount: 0,
      latestFailureClass: null,
      latestFinishCode: null,
      latestFinishStatus: null,
      verificationFailureCount: 0,
      policyBlockCount: 0,
      modelFailureCount: 0,
      logicDefectCount: 0,
    };
  }
  let lowRoiSignalCount = 0;
  let verificationFailureCount = 0;
  let policyBlockCount = 0;
  let modelFailureCount = 0;
  let logicDefectCount = 0;
  let latestFailureClass: string | null = null;
  let latestFinishCode: string | null = null;
  let latestFinishStatus: string | null = null;
  for (const entry of selected.records) {
    const primaryClass = normalizeLineageScalar((entry as any)?.primaryClass ?? (entry as any)?.classification?.primaryClass);
    const finishCode = normalizeLineageScalar((entry as any)?.finishCode ?? (entry as any)?.dispatchBlockReason, 200);
    const finishStatus = normalizeLineageScalar((entry as any)?.finishStatus ?? (entry as any)?.workerStatus, 80);
    const retryRoiAllowed = (entry as any)?.retryRoiAllowed === true
      ? true
      : (entry as any)?.retryRoiAllowed === false
        ? false
        : null;
    const retryRoiExpectedGain = Number((entry as any)?.retryRoiExpectedGain);
    const retryRoiThreshold = Number((entry as any)?.retryRoiThreshold);
    if (
      retryRoiAllowed === false
      || (
        Number.isFinite(retryRoiExpectedGain)
        && Number.isFinite(retryRoiThreshold)
        && retryRoiExpectedGain < retryRoiThreshold
      )
    ) {
      lowRoiSignalCount += 1;
    }
    if (primaryClass === "verification" || /^verification_report_fail:/i.test(String(finishCode || ""))) {
      verificationFailureCount += 1;
    }
    if (primaryClass === "policy" || /policy|guard|capability_check/i.test(String(finishCode || ""))) {
      policyBlockCount += 1;
    }
    if (primaryClass === "model" || /rate|quota|429|503|timeout|provider/i.test(String(finishCode || ""))) {
      modelFailureCount += 1;
    }
    if (primaryClass === "logic_defect") {
      logicDefectCount += 1;
    }
    latestFailureClass = primaryClass ?? latestFailureClass;
    latestFinishCode = finishCode ?? latestFinishCode;
    latestFinishStatus = finishStatus ?? latestFinishStatus;
  }
  return {
    sampleCount: selected.records.length,
    matchMode: selected.matchMode,
    lowRoiSignalCount,
    latestFailureClass,
    latestFinishCode,
    latestFinishStatus,
    verificationFailureCount,
    policyBlockCount,
    modelFailureCount,
    logicDefectCount,
  };
}

export async function appendInterventionApplicationEntries(config, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: "entries must be a non-empty array" };
  }

  const stateDir = config?.paths?.stateDir || "state";
  const logFile = path.join(stateDir, "intervention_application_ledger.jsonl");

  try {
    await ensureParent(logFile);
    const now = new Date().toISOString();
    const lines = entries.map((entry) => JSON.stringify({
      schemaVersion: 1,
      recordedAt: String(entry?.recordedAt || now),
      interventionId: String(entry?.interventionId || "").trim(),
      lineageId: entry?.lineageId ? String(entry.lineageId).trim() : null,
      lineageJoinKey: entry?.lineageJoinKey ? String(entry.lineageJoinKey).trim() : null,
      policyId: entry?.policyId ? String(entry.policyId).trim() : null,
      cycleId: entry?.cycleId ? String(entry.cycleId).trim() : null,
      role: String(entry?.role || "evolution-worker").trim() || "evolution-worker",
      interventionCategory: entry?.interventionCategory ? String(entry.interventionCategory).trim() : null,
      interventionType: entry?.interventionType ? String(entry.interventionType).trim() : null,
      selectedAt: String(entry?.selectedAt || now),
      status: String(entry?.status || "selected").trim() || "selected",
      outcomeStatus: entry?.outcomeStatus ? String(entry.outcomeStatus).trim().toLowerCase() : null,
      noSignalOutcome: Boolean(entry?.noSignalOutcome),
      decisionReason: entry?.decisionReason ? String(entry.decisionReason).trim() : null,
    }));
    await fs.appendFile(logFile, lines.join("\n") + "\n", "utf8");
    return { ok: true, count: lines.length };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

export async function appendInterventionRetirementEvidence(config, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, reason: "entries must be a non-empty array" };
  }

  const stateDir = config?.paths?.stateDir || "state";
  const logFile = path.join(stateDir, "intervention_retirement_evidence.jsonl");

  try {
    const normalizedEntries = entries.map((entry, index) => {
      const interventionId = String(entry?.interventionId || "").trim();
      if (!interventionId) {
        return {
          ok: false as const,
          reason: `entries[${index}].interventionId is required`,
        };
      }
      const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
        entry?.lineage,
        {
          lineageId: entry?.lineageId ?? null,
          taskId: entry?.taskId ?? null,
          taskIdentity: entry?.taskIdentity ?? null,
          cycleId: entry?.cycleId ?? null,
          taskKind: entry?.taskKind ?? null,
          interventionId,
          promptFamilyKey: entry?.promptFamilyKey ?? null,
          role: entry?.role ?? null,
        },
        {
          explicitJoinKey: entry?.lineageJoinKey,
          taskKind: entry?.taskKind ?? null,
          role: entry?.role ?? null,
        },
      );
      if (!lineageJoinKey) {
        return {
          ok: false as const,
          reason: `entries[${index}] requires a stable lineage join key`,
        };
      }
      return {
        ok: true as const,
        entry,
        interventionId,
        lineage,
        lineageJoinKey,
      };
    });
    const failedEntry = normalizedEntries.find((entry) => entry.ok === false);
    if (failedEntry?.ok === false) {
      return { ok: false, reason: failedEntry.reason };
    }
    await ensureParent(logFile);
    const now = new Date().toISOString();
    const lines = normalizedEntries.map((normalized) => JSON.stringify({
      schemaVersion: 1,
      recordedAt: String(normalized.entry?.recordedAt || now),
      cycleId: normalized.entry?.cycleId ? String(normalized.entry.cycleId).trim() : normalized.lineage.cycleId,
      interventionId: normalized.interventionId,
      lineageId: normalized.lineage.lineageId,
      lineageJoinKey: normalized.lineageJoinKey,
      lineage: normalized.lineage,
      policyId: normalized.entry?.policyId ? String(normalized.entry.policyId).trim() : null,
      role: normalized.entry?.role ? String(normalized.entry.role).trim() : normalized.lineage.role,
      interventionCategory: normalized.entry?.interventionCategory ? String(normalized.entry.interventionCategory).trim() : null,
      interventionType: normalized.entry?.interventionType ? String(normalized.entry.interventionType).trim() : null,
      decision: String(normalized.entry?.decision || "hold").trim().toLowerCase() || "hold",
      decisionMode: normalized.entry?.decisionMode ? String(normalized.entry.decisionMode).trim() : null,
      closureMode: String(normalized.entry?.closureMode || "observed").trim().toLowerCase() || "observed",
      outcomeStatus: normalized.entry?.outcomeStatus ? String(normalized.entry.outcomeStatus).trim().toLowerCase() : null,
      noSignalOutcome: Boolean(normalized.entry?.noSignalOutcome),
      reason: normalized.entry?.reason ? String(normalized.entry.reason).trim() : null,
      outcomeScore: Number.isFinite(Number(normalized.entry?.outcomeScore))
        ? Math.max(0, Math.min(1, Number(normalized.entry.outcomeScore)))
        : null,
      evidenceCount: Number.isFinite(Number(normalized.entry?.evidenceCount))
        ? Math.max(0, Math.floor(Number(normalized.entry.evidenceCount)))
        : null,
      improvedCount: Number.isFinite(Number(normalized.entry?.improvedCount))
        ? Math.max(0, Math.floor(Number(normalized.entry.improvedCount)))
        : null,
      noSignalCount: Number.isFinite(Number(normalized.entry?.noSignalCount))
        ? Math.max(0, Math.floor(Number(normalized.entry.noSignalCount)))
        : null,
      ineffectiveCount: Number.isFinite(Number(normalized.entry?.ineffectiveCount))
        ? Math.max(0, Math.floor(Number(normalized.entry.ineffectiveCount)))
        : null,
      averageOutcomeScore: Number.isFinite(Number(normalized.entry?.averageOutcomeScore))
        ? Math.max(0, Math.min(1, Number(normalized.entry.averageOutcomeScore)))
        : null,
      shouldRetire: Boolean(normalized.entry?.shouldRetire),
      reversible: normalized.entry?.reversible === false ? false : true,
      reactivateWhen: normalized.entry?.reactivateWhen ? String(normalized.entry.reactivateWhen).trim() : null,
      aiConfidence: Number.isFinite(Number(normalized.entry?.aiConfidence))
        ? Math.max(0, Math.min(1, Number(normalized.entry.aiConfidence)))
        : null,
      resolvedPolicy: Boolean(normalized.entry?.resolvedPolicy),
    }));
    await fs.appendFile(logFile, lines.join("\n") + "\n", "utf8");
    return { ok: true, count: lines.length };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

export async function loadInterventionRetirementEvidence(config): Promise<any[]> {
  try {
    const filePath = path.join(config?.paths?.stateDir || "state", "intervention_retirement_evidence.jsonl");
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) return [];
    return raw.trim().split("\n").map((line) => {
      try {
        const parsed = JSON.parse(line);
        const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
          parsed?.lineage,
          {
            lineageId: parsed?.lineageId ?? null,
            taskId: parsed?.taskId ?? null,
            taskIdentity: parsed?.taskIdentity ?? null,
            cycleId: parsed?.cycleId ?? null,
            taskKind: parsed?.taskKind ?? null,
            interventionId: parsed?.interventionId ?? null,
            promptFamilyKey: parsed?.promptFamilyKey ?? null,
            role: parsed?.role ?? null,
          },
          {
            explicitJoinKey: parsed?.lineageJoinKey,
            taskKind: parsed?.taskKind ?? null,
            role: parsed?.role ?? null,
          },
        );
        if (!lineageJoinKey) return null;
        return {
          ...parsed,
          lineageId: lineage.lineageId,
          lineage,
          lineageJoinKey,
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Lineage graph — append-only task fingerprint graph ────────────────────────

/**
 * Append a single LineageEntry to the lineage graph file (append-only, immutable).
 *
 * Validation:
 *   - Missing input (null/undefined entry) → returns { ok: false, code: MISSING_INPUT, ... }
 *   - Schema-invalid entry               → returns { ok: false, code: <field error>, ... }
 *   - Valid entry that creates a loop     → returns { ok: false, code: LOOP_*, isLoop: true, ... }
 *   - Valid, no loop                      → appends and returns { ok: true, loopCheck, entry }
 *
 * The graph is stored at state/lineage_graph.json as { entries: [...], updatedAt, schemaVersion }.
 * Entries are never deleted or modified — this is an append-only log.
 *
 * @param {object} config
 * @param {object} entry — must pass validateLineageEntry
 * @returns {Promise<{ ok: boolean, code: string, message: string, entry?: object, loopCheck?: object, isLoop?: boolean }>}
 */
export async function appendLineageEntry(config, entry) {
  // Distinguish missing from invalid input
  if (entry === null || entry === undefined) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_INPUT, message: "entry is required (got null/undefined)" };
  }

  const validation = validateLineageEntry(entry);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message };
  }

  const graphFile = path.join(config.paths.stateDir, "lineage_graph.json");
  const state = await readJson(graphFile, {
    schemaVersion: "1.0",
    entries: [],
    updatedAt: new Date().toISOString()
  });

  if (!Array.isArray(state.entries)) {
    // Degraded state: entries field is corrupt; reset to empty array with explicit status
    state.entries = [];
    state.degraded = true;
    state.degradedReason = "entries_corrupt_reset";
  }

  // Run loop detection before appending
  const loopCheck = detectLoop(state.entries, entry);
  if (loopCheck.isLoop) {
    return {
      ok: false,
      code: loopCheck.code,
      message: loopCheck.message,
      isLoop: true,
      loopCheck
    };
  }

  // Append immutably — the entry itself is never mutated after this point
  state.entries.push(Object.freeze ? Object.assign({}, entry) : entry);

  // Trim to last 5000 entries to prevent unbounded file growth
  if (state.entries.length > 5000) {
    state.entries = state.entries.slice(-5000);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(graphFile, state);

  return { ok: true, code: LINEAGE_ERROR_CODE.NO_LOOP, message: "entry appended", entry, loopCheck };
}

/**
 * Compute failure clusters from the lineage graph and persist the top clusters
 * to state/lineage_clusters.json (the "dashboard" surface for AC5).
 *
 * Output file schema:
 *   {
 *     schemaVersion: "1.0",
 *     generatedAt:   <ISO string>,
 *     thresholds:    { CLUSTER_MIN_SIZE, TOP_CLUSTERS_COUNT },
 *     totalEntries:  <number>,
 *     clusters:      <FailureCluster[]>   — at most TOP_CLUSTERS_COUNT items
 *   }
 *
 * Returns the clusters array. If the graph file does not exist, returns [].
 * Never throws — on read/write failure, sets status=degraded in return value.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, clusters: object[], code?: string, message?: string }>}
 */
export async function getFailureClusterReport(config) {
  const graphFile = path.join(config.paths.stateDir, "lineage_graph.json");
  const clustersFile = path.join(config.paths.stateDir, "lineage_clusters.json");

  let state;
  try {
    state = await readJson(graphFile, { entries: [] });
  } catch (err) {
    return {
      ok: false,
      code: "READ_ERROR",
      message: `lineage_graph.json unreadable: ${String(err?.message || err)}`,
      clusters: []
    };
  }

  const entries = Array.isArray(state?.entries) ? state.entries : [];
  const clusters = buildFailureClusters(entries);

  const report = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    thresholds: {
      CLUSTER_MIN_SIZE: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE,
      TOP_CLUSTERS_COUNT: LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT,
    },
    totalEntries: entries.length,
    clusters
  };

  try {
    await writeJson(clustersFile, report);
  } catch (err) {
    // Write failure is non-fatal — return clusters even if persistence failed
    return {
      ok: false,
      code: "WRITE_ERROR",
      message: `lineage_clusters.json write failed: ${String(err?.message || err)}`,
      clusters
    };
  }

  return { ok: true, clusters, code: null, message: `${clusters.length} clusters written` };
}

// ── Intervention optimizer log ────────────────────────────────────────────────

/**
 * Load the intervention optimizer log from state/intervention_optimizer_log.jsonl.
 *
 * @param {object} config — box config object with paths.stateDir
 * @returns {Promise<object>} — { schemaVersion, updatedAt, entries: [] } (fresh entries only)
 */
export async function loadInterventionOptimizerLog(config) {
  const stateDir = config?.paths?.stateDir || "state";
  const jsonlFile = path.join(stateDir, "intervention_optimizer_log.jsonl");
  const fallbackJsonFile = path.join(stateDir, "intervention_optimizer_log.json");
  const nowMs = Date.now();
  const defaultFreshnessMs = OPTIMIZER_LOG_FRESHNESS_MS;

  try {
    const raw = await fs.readFile(jsonlFile, "utf8");
    const lines = raw.split("\n").map(line => line.trim()).filter(Boolean);
    const records = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    const entries = [];
    for (const record of records as any[]) {
      if (
        record?.jsonlSchema !== OPTIMIZER_LOG_JSONL_SCHEMA
        || record?.recordType !== OPTIMIZER_LOG_RECORD_TYPE
      ) {
        continue;
      }
      const freshness = record?.freshness && typeof record.freshness === "object"
        ? record.freshness
        : {};
      const staleAfterMsRaw = Number(freshness?.staleAfterMs);
      const staleAfterMs = Number.isFinite(staleAfterMsRaw) && staleAfterMsRaw > 0
        ? staleAfterMsRaw
        : defaultFreshnessMs;
      const savedAt = String(record?.savedAt || record?.persistedAt || "").trim();
      const savedAtMs = savedAt ? new Date(savedAt).getTime() : NaN;
      if (!Number.isFinite(savedAtMs)) continue;
      if (nowMs - savedAtMs > staleAfterMs) continue;
      const payload = record?.payload && typeof record.payload === "object" ? record.payload : null;
      if (payload) entries.push(payload);
    }

    return {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: entries.slice(-100),
    };
  } catch {
    // Backward compatibility: accept the legacy JSON object file when JSONL does not exist.
    const fallback = await readJson(fallbackJsonFile, {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt:     new Date().toISOString(),
      entries:       [],
    });
    const updatedAtRaw = String(fallback?.updatedAt || "").trim();
    const updatedAtMs = updatedAtRaw ? new Date(updatedAtRaw).getTime() : NaN;
    const isFresh = Number.isFinite(updatedAtMs) && (nowMs - updatedAtMs) <= defaultFreshnessMs;
    return {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      entries: isFresh && Array.isArray(fallback?.entries) ? fallback.entries : [],
    };
  }
}

/**
 * Append one optimizer result entry to state/intervention_optimizer_log.jsonl.
 *
 * Emits PLANNING_INTERVENTION_OPTIMIZED event (non-blocking; never throws).
 * Trims to the last 100 entries to cap file growth.
 *
 * @param {object} config — box config object with paths.stateDir
 * @param {object} entry  — optimizer result from runInterventionOptimizer
 * @returns {Promise<void>}
 */
// ── Monthly Postmortem Persistence ────────────────────────────────────────────

/**
 * Persist a monthly postmortem to state/monthly_postmortem_{monthKey}.json.
 *
 * Validates all required schema fields before writing.
 * Distinguishes missing input (postmortem is null) from invalid input
 * (postmortem present but fails schema validation) with explicit reason codes.
 *
 * Never silently drops data — write errors return ok=false with an explicit reason.
 *
 * @param {object} config
 * @param {object} postmortem — output of generateMonthlyPostmortem().postmortem
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistMonthlyPostmortem(config, postmortem) {
  if (postmortem === null || postmortem === undefined) {
    return { ok: false, reason: "MISSING_INPUT: postmortem is null or undefined" };
  }
  if (typeof postmortem !== "object" || Array.isArray(postmortem)) {
    return { ok: false, reason: "INVALID_INPUT: postmortem must be a non-array object" };
  }

  const REQUIRED = [
    "schemaVersion", "monthKey", "generatedAt", "status",
    "cycleCount", "experimentOutcomes", "compoundingEffects",
    "decisionQualityTrend", "seedQuestion"
  ];

  for (const field of REQUIRED) {
    if (!(field in postmortem)) {
      return { ok: false, reason: `INVALID_INPUT: missing required field "${field}"` };
    }
  }

  const monthKey = String(postmortem.monthKey || "");
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { ok: false, reason: `INVALID_INPUT: monthKey must be "YYYY-MM", got "${monthKey}"` };
  }

  const stateDir  = config?.paths?.stateDir || "state";
  const filePath  = path.join(stateDir, `monthly_postmortem_${monthKey}.json`);

  try {
    await ensureParent(filePath);
    await writeJson(filePath, postmortem);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

export async function appendInterventionOptimizerEntry(config, entry) {
  const stateDir = config?.paths?.stateDir || "state";
  const logFile = path.join(stateDir, "intervention_optimizer_log.jsonl");
  const savedAt = new Date().toISOString();
  const staleAfterMs = OPTIMIZER_LOG_FRESHNESS_MS;
  const expiresAt = new Date(Date.now() + staleAfterMs).toISOString();
  const correlationId = String(entry?.correlationId || `optimizer-${Date.now()}`);
  const record = {
    jsonlSchema: OPTIMIZER_LOG_JSONL_SCHEMA,
    recordType: OPTIMIZER_LOG_RECORD_TYPE,
    schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
    savedAt,
    freshness: {
      status: "fresh",
      staleAfterMs,
      expiresAt,
    },
    payload: { ...entry, savedAt },
  };
  await fs.appendFile(logFile, JSON.stringify(record) + "\n", "utf8");

  // Emit typed planning event (non-blocking; never throws)
  emitEvent(EVENTS.PLANNING_INTERVENTION_OPTIMIZED, EVENT_DOMAIN.PLANNING, correlationId, {
    status:           String(entry?.status ?? "unknown"),
    reasonCode:       String(entry?.reasonCode ?? "unknown"),
    selectedCount:    Number(Array.isArray(entry?.selected) ? entry.selected.length : 0),
    rejectedCount:    Number(Array.isArray(entry?.rejected) ? entry.rejected.length : 0),
    totalBudgetUsed:  Number(entry?.totalBudgetUsed ?? 0),
    totalBudgetLimit: Number(entry?.totalBudgetLimit ?? 0),
    budgetUnit:       String(entry?.budgetUnit ?? "workerSpawns"),
  });
}

// ── Compounding effects persistence (re-exports from compounding_effects_analyzer) ──

/**
 * Persist a compounding-effects AnalyzerResult to state/.
 * Delegates to compounding_effects_analyzer.persistCompoundingEffectsResult.
 *
 * @param {object} config — box config with config.paths.stateDir
 * @param {object} result — AnalyzerResult from analyzeCompoundingEffects()
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export { persistCompoundingEffectsResult } from "./compounding_effects_analyzer.js";

/**
 * Persist a monthly compounding-effects report to state/.
 * Delegates to compounding_effects_analyzer.persistMonthlyCompoundingReport.
 *
 * @param {object} config  — box config with config.paths.stateDir
 * @param {object} report  — MonthlyCompoundingReport
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export { persistMonthlyCompoundingReport } from "./compounding_effects_analyzer.js";

/**
 * Generate and persist a monthly compounding-effects report from the rolling log.
 * Delegates to compounding_effects_analyzer.generateAndPersistMonthlyReport.
 *
 * @param {object} config   — box config with config.paths.stateDir
 * @param {string} monthKey — "YYYY-MM"
 * @returns {Promise<{ ok: boolean, filePath?: string, report?: object, reason?: string }>}
 */
export { generateAndPersistMonthlyReport } from "./compounding_effects_analyzer.js";

// ── Dispatch tier telemetry ───────────────────────────────────────────────────

/** Valid complexity tier values for dispatch tier telemetry records. */
export const DISPATCH_TIER = Object.freeze({
  T1: "T1",
  T2: "T2",
  T3: "T3",
} as const);

/**
 * Append a single dispatch tier event to state/dispatch_tier_log.jsonl.
 *
 * Records the complexity tier assigned to each worker dispatch so that
 * cycle_analytics.js can aggregate tierCounts per cycle. The log is a
 * rolling JSONL buffer (max 2000 entries) that the orchestrator reads at
 * cycle close time.
 *
 * Fail-open: write errors return { ok: false, reason } and are never thrown.
 *
 * @param {object} config
 * @param {{ taskId?: string|null, roleName: string, tier: string, taskKind?: string|null, cycleId?: string|null, recordedAt?: string }} entry
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function appendDispatchTierEvent(
  config,
  entry: {
    taskId?: string | null;
    roleName: string;
    tier: string;
    taskKind?: string | null;
    cycleId?: string | null;
    recordedAt?: string;
  },
): Promise<{ ok: boolean; reason?: string }> {
  const logFile = path.join(config?.paths?.stateDir || "state", "dispatch_tier_log.jsonl");

  try {
    if (!entry || typeof entry !== "object") {
      return { ok: false, reason: "entry is required (got null/undefined/non-object)" };
    }
    if (!entry.roleName || typeof entry.roleName !== "string" || entry.roleName.trim() === "") {
      return { ok: false, reason: "entry.roleName must be a non-empty string" };
    }
    const validTiers = new Set<string>(Object.values(DISPATCH_TIER));
    const tier = String(entry.tier || "");
    if (!validTiers.has(tier)) {
      return { ok: false, reason: `entry.tier must be one of ${[...validTiers].join(", ")}, got "${tier}"` };
    }

    const record = JSON.stringify({
      taskId:    entry.taskId    ?? null,
      roleName:  String(entry.roleName).trim(),
      tier,
      taskKind:  entry.taskKind  ?? null,
      cycleId:   entry.cycleId   ?? null,
      recordedAt: entry.recordedAt ?? new Date().toISOString(),
    });

    await fs.appendFile(logFile, record + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

/**
 * Read and parse all dispatch tier events from the rolling JSONL log.
 * Returns parsed entries; silently skips malformed lines.
 * Returns [] if the file does not exist.
 *
 * @param {object} config
 * @returns {Promise<object[]>}
 */
export async function readDispatchTierEvents(config): Promise<object[]> {
  const logFile = path.join(config?.paths?.stateDir || "state", "dispatch_tier_log.jsonl");
  try {
    const raw = await fs.readFile(logFile, "utf8");
    return raw.split("\n")
      .filter(line => line.trim().length > 0)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Aggregate dispatch tier events from the JSONL log into tierCounts for a given cycleId.
 * When cycleId is null, aggregates all events in the log.
 *
 * Returns { T1: number, T2: number, T3: number } where each value is the count of
 * dispatches at that tier. Missing tiers default to 0.
 *
 * @param {object} config
 * @param {string|null} cycleId — filter events by cycleId; null aggregates all
 * @returns {Promise<{ T1: number, T2: number, T3: number }>}
 */
export async function aggregateTierCounts(config, cycleId: string | null = null): Promise<{ T1: number; T2: number; T3: number }> {
  const events = await readDispatchTierEvents(config);
  const relevant = cycleId
    ? events.filter((e: any) => e.cycleId === cycleId)
    : events;
  const counts = { T1: 0, T2: 0, T3: 0 };
  for (const ev of relevant) {
    const tier = (ev as any).tier;
    if (tier === "T1") counts.T1++;
    else if (tier === "T2") counts.T2++;
    else if (tier === "T3") counts.T3++;
  }
  return counts;
}

// ── Policy closure evidence persistence ──────────────────────────────────────

/**
 * Append a PolicyClosureEvidence record to state/policy_closure_evidence.jsonl.
 *
 * Used by the learning-policy lifecycle to track when recurring lessons are
 * verifiably resolved so compiled policies can later be evaluated for retirement.
 *
 * Storage: append-only JSONL (one JSON object per line).
 * Fail-open: write errors return { ok: false, reason } and are never thrown.
 *
 * @param config  — BOX config object (config.paths.stateDir)
 * @param record  — PolicyClosureEvidence from learning_policy_compiler.buildPolicyClosureEvidence
 * @returns {{ ok: boolean, reason?: string }}
 */
export async function appendPolicyClosureEvidence(
  config,
  record: {
    policyId: string;
    resolvedAt: string;
    resolvedBy: string;
    evidence: string;
    cycleId?: string;
    outcomeStatus?: string;
    evidenceCount?: number;
    reversible?: boolean;
    reactivateWhen?: string;
  },
): Promise<{ ok: boolean; reason?: string }> {
  try {
    if (!record || !record.policyId) {
      return { ok: false, reason: "record.policyId is required" };
    }
    const filePath = path.join(config?.paths?.stateDir || "state", "policy_closure_evidence.jsonl");
    const entry = JSON.stringify({
      ...record,
      outcomeStatus: record?.outcomeStatus ? String(record.outcomeStatus).trim().toLowerCase() : null,
      evidenceCount: Number.isFinite(Number(record?.evidenceCount)) ? Math.max(0, Math.floor(Number(record.evidenceCount))) : null,
      reversible: record?.reversible === false ? false : true,
      reactivateWhen: record?.reactivateWhen ? String(record.reactivateWhen).trim() : null,
      appendedAt: new Date().toISOString(),
    });
    await ensureParent(filePath);
    await fs.appendFile(filePath, entry + "\n", "utf8");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String((err as any)?.message || err) };
  }
}

/**
 * Load the full policy closure evidence history from state/policy_closure_evidence.jsonl.
 *
 * Returns an empty array when the file does not exist or is empty.
 * Malformed lines are silently skipped (fail-open).
 *
 * @param config — BOX config object
 * @returns PolicyClosureEvidence[]
 */
export async function loadPolicyClosureHistory(config): Promise<any[]> {
  try {
    const filePath = path.join(config?.paths?.stateDir || "state", "policy_closure_evidence.jsonl");
    const raw = await fs.readFile(filePath, "utf8").catch(() => "");
    if (!raw.trim()) return [];
    return raw.trim().split("\n").map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// ── Capability execution trace ────────────────────────────────────────────────

/**
 * How long a capability execution trace remains "recent" for downgrade purposes.
 * Traces older than this window are treated as stale and do not satisfy the
 * execution-path gate in Janus capability-gap downgrade logic.
 */
export const CAPABILITY_TRACE_FRESHNESS_MS = 86_400_000; // 24 hours

/**
 * A single capability execution trace record.
 * Written by any module that actually invokes a capability at runtime.
 */
export interface CapabilityExecutionTrace {
  /** Canonical capability identifier (lowercase, trimmed). */
  capability: string;
  /** ISO 8601 timestamp when the capability was observed executing. */
  observedAt: string;
  /** Free-form context string (truncated to 500 chars on write). */
  context: string;
  /** Role that triggered this capability execution (e.g. 'evolution-worker'). */
  role?: string;
  /** Wave number within the plan this capability was executed for. */
  wave?: number | null;
  /** Governance gate identifier that was active when this capability ran. */
  gateId?: string | null;
  /** Outcome of the governance gate or capability execution step. */
  outcome?: string | null;
  /** Shared lineage contract tying capability execution to routing and outcomes. */
  lineage?: InterventionLineageContract | null;
  /** Deterministic join key derived from lineage. */
  lineageJoinKey?: string | null;
}

export interface CapabilityExecutionSummary {
  freshnessWindowMs: number;
  traceCount: number;
  recentTraceCount: number;
  staleTraceCount: number;
  observedCapabilityCount: number;
  observedCapabilities: string[];
  lastObservedAt: string | null;
  lastInvokedAtByCapability: Record<string, string>;
  recentTraces: CapabilityExecutionTrace[];
}

/**
 * Record that a capability was observed executing in the active runtime path.
 *
 * Persists to: state/capability_execution_traces.json
 * Capped at 200 entries (oldest trimmed). Fail-open: write errors are logged
 * but never thrown.
 *
 * @param config     — BOX config object with paths.stateDir
 * @param capability — canonical capability identifier (e.g. "ci-failure-log-injection")
 * @param context    — human-readable context for observability
 */
export interface CapabilityTraceMetadata {
  /** Role that triggered this capability execution (e.g. 'evolution-worker'). */
  role?: string;
  /** Wave number within the plan this capability was executed for. */
  wave?: number | null;
  /** Governance gate identifier that was active when this capability ran. */
  gateId?: string | null;
  /** Outcome of the governance gate or capability execution step. */
  outcome?: string | null;
  /** Shared lineage contract tying this trace to routing, usage, and outcomes. */
  lineage?: unknown;
  lineageJoinKey?: string | null;
  taskId?: string | null;
  cycleId?: string | null;
  taskKind?: string | null;
  interventionId?: string | null;
  lane?: string | null;
  specialized?: boolean | null;
  rerouteReasonCode?: string | null;
}

export async function recordCapabilityExecution(
  config: { paths: { stateDir: string } },
  capability: string,
  context: string,
  meta?: CapabilityTraceMetadata,
): Promise<void> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capability_execution_traces.json");
  try {
    let existing: CapabilityExecutionTrace[] = [];
    try {
      const raw = await readJson(filePath, { traces: [] });
      existing = Array.isArray(raw?.traces) ? raw.traces : [];
    } catch { /* first write */ }
    const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
      meta?.lineage,
      {
        taskId: meta?.taskId ?? null,
        cycleId: meta?.cycleId ?? null,
        taskKind: meta?.taskKind ?? null,
        interventionId: meta?.interventionId ?? null,
        role: meta?.role ?? null,
        lane: meta?.lane ?? null,
        capability,
        specialized: meta?.specialized ?? null,
        rerouteReasonCode: meta?.rerouteReasonCode ?? null,
      },
      {
        explicitJoinKey: meta?.lineageJoinKey ?? null,
        taskKind: meta?.taskKind ?? null,
        role: meta?.role ?? null,
      },
    );
    const record: CapabilityExecutionTrace = {
      capability: String(capability || "").trim().toLowerCase(),
      observedAt: new Date().toISOString(),
      context: String(context || "").slice(0, 500),
      ...(meta?.role != null && { role: String(meta.role).slice(0, 80) }),
      ...(meta?.wave != null && { wave: Number.isFinite(Number(meta.wave)) ? Number(meta.wave) : null }),
      ...(meta?.gateId != null && { gateId: String(meta.gateId).slice(0, 80) }),
      ...(meta?.outcome != null && { outcome: String(meta.outcome).slice(0, 80) }),
      lineage,
      lineageJoinKey,
    };
    const updated = [...existing, record].slice(-200);
    await writeJson(filePath, { traces: updated });
  } catch (err) {
    console.error(`[state_tracker] recordCapabilityExecution failed: ${String((err as any)?.message || err)}`);
  }
}

/**
 * Load the set of capability IDs that have recent execution traces.
 *
 * Reads state/capability_execution_traces.json and returns a Set of capability
 * IDs that were observed executing within `freshnessMs` milliseconds.
 * Returns an empty Set when the file does not exist or is malformed.
 *
 * @param config      — BOX config object with paths.stateDir
 * @param freshnessMs — max trace age in milliseconds (default: CAPABILITY_TRACE_FRESHNESS_MS)
 */
export async function loadCapabilityExecutionTraces(
  config: { paths?: { stateDir?: string } },
  freshnessMs: number = CAPABILITY_TRACE_FRESHNESS_MS,
): Promise<Set<string>> {
  const summary = await loadCapabilityExecutionSummary(config, freshnessMs);
  return new Set(summary.observedCapabilities);
}

export async function loadCapabilityExecutionSummary(
  config: { paths?: { stateDir?: string } },
  freshnessMs: number = CAPABILITY_TRACE_FRESHNESS_MS,
): Promise<CapabilityExecutionSummary> {
  const fallback: CapabilityExecutionSummary = {
    freshnessWindowMs: freshnessMs,
    traceCount: 0,
    recentTraceCount: 0,
    staleTraceCount: 0,
    observedCapabilityCount: 0,
    observedCapabilities: [],
    lastObservedAt: null,
    lastInvokedAtByCapability: {},
    recentTraces: [],
  };
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capability_execution_traces.json");
  try {
    const raw = await readJson(filePath, { traces: [] });
    const traces: CapabilityExecutionTrace[] = Array.isArray(raw?.traces) ? raw.traces : [];
    const cutoff = Date.now() - freshnessMs;
    const recent = traces.filter((t) => {
      const ts = Date.parse(String(t?.observedAt || ""));
      return Number.isFinite(ts) && ts > cutoff;
    });

    if (recent.length === 0) {
      return {
        ...fallback,
        freshnessWindowMs: freshnessMs,
        traceCount: traces.length,
        staleTraceCount: traces.length,
      };
    }

    const normalizedRecent = recent.map((t) => {
      const rawTrace = t as unknown as Record<string, unknown>;
      const { lineage, lineageJoinKey } = resolveStableInterventionLineage(
        rawTrace.lineage,
        {
          lineageId: normalizeLineageScalar(rawTrace.lineageId),
          taskId: normalizeLineageScalar(rawTrace.taskId),
          cycleId: normalizeLineageScalar(rawTrace.cycleId),
          taskKind: normalizeLineageScalar(rawTrace.taskKind),
          interventionId: normalizeLineageScalar(rawTrace.interventionId),
          role: normalizeLineageScalar(rawTrace.role),
          lane: normalizeLineageScalar(rawTrace.lane),
          capability: normalizeLineageScalar(rawTrace.capability),
          specialized: normalizeLineageBoolean(rawTrace.specialized),
          rerouteReasonCode: normalizeLineageScalar(rawTrace.rerouteReasonCode),
        },
        {
          explicitJoinKey: rawTrace.lineageJoinKey,
          taskKind: rawTrace.taskKind,
          role: rawTrace.role,
        },
      );
      const base: CapabilityExecutionTrace = {
        capability: String(t?.capability || "").trim().toLowerCase(),
        observedAt: String(t?.observedAt || ""),
        context: String(t?.context || ""),
        lineage,
        lineageJoinKey,
      };
      if (t?.role != null) base.role = String(t.role).slice(0, 80);
      if (t?.wave != null) base.wave = Number.isFinite(Number(t.wave)) ? Number(t.wave) : null;
      if (t?.gateId != null) base.gateId = String(t.gateId).slice(0, 80);
      if (t?.outcome != null) base.outcome = String(t.outcome).slice(0, 80);
      return base;
    });
    const observedCapabilities = [...new Set(
      normalizedRecent
        .map((t) => t.capability)
        .filter(Boolean),
    )];
    const lastObservedAt = normalizedRecent
      .map((t) => Date.parse(t.observedAt))
      .filter((ts) => Number.isFinite(ts))
      .sort((a, b) => b - a)
      .map((ts) => new Date(ts).toISOString())[0] ?? null;
    const lastInvokedAtByCapability = normalizedRecent.reduce<Record<string, string>>((acc, trace) => {
      if (!trace.capability) return acc;
      const previous = acc[trace.capability];
      if (!previous || Date.parse(trace.observedAt) > Date.parse(previous)) {
        acc[trace.capability] = trace.observedAt;
      }
      return acc;
    }, {});

    return {
      freshnessWindowMs: freshnessMs,
      traceCount: traces.length,
      recentTraceCount: normalizedRecent.length,
      staleTraceCount: Math.max(0, traces.length - normalizedRecent.length),
      observedCapabilityCount: observedCapabilities.length,
      observedCapabilities,
      lastObservedAt,
      lastInvokedAtByCapability,
      recentTraces: normalizedRecent,
    };
  } catch {
    return fallback;
  }
}

/**
 * Append a structured governance block event to governance_blocks.jsonl.
 *
 * Records every cycle that was blocked before dispatch so that downstream
 * consumers (Athena, metrics) can correlate block frequency and reasons
 * without parsing free-text progress logs or alert messages.
 *
 * File: state/governance_blocks.jsonl (NDJSON append log)
 *
 * @param config
 * @param record.cycleId     — ISO timestamp or opaque cycle identifier
 * @param record.blockReason — canonical block reason from evaluatePreDispatchGovernanceGate
 * @param record.blockedAt   — ISO 8601 timestamp when block fired
 * @param record.gateSource  — which gate fired: "pre_dispatch_gate" | "lane_diversity_gate" | ...
 */
export async function appendGovernanceBlockEvent(
  config,
  record: {
    cycleId: string;
    blockReason: string;
    blockedAt: string;
    gateSource: string;
  }
): Promise<void> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "governance_blocks.jsonl");
  const blockReason = String(record.blockReason || "");
  const blockReasonCode = blockReason.split(":")[0]?.trim().toLowerCase() || "unknown";
  const entry = {
    cycleId:     String(record.cycleId || ""),
    blockReason,
    blockReasonCode,
    blockedAt:   String(record.blockedAt || new Date().toISOString()),
    gateSource:  String(record.gateSource || "unknown"),
    schemaVersion: 1,
  };
  try {
    await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Non-fatal: telemetry append failure must never block orchestration
    console.error(`[state_tracker] appendGovernanceBlockEvent failed: ${String((err as any)?.message || err)}`);
  }
}

export async function loadGovernanceBlockSummary(
  config,
  limit = 25,
): Promise<{
  recentBlockCount: number;
  byReasonCode: Record<string, number>;
  byGateSource: Record<string, number>;
  latestBlockReason: string | null;
  latestBlockedAt: string | null;
}> {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "governance_blocks.jsonl");
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const recent = lines.slice(-Math.max(1, Math.floor(Number(limit) || 25))).flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
    const byReasonCode: Record<string, number> = {};
    const byGateSource: Record<string, number> = {};
    for (const entry of recent) {
      const reasonCode = String(entry.blockReasonCode || String(entry.blockReason || "").split(":")[0] || "unknown").trim().toLowerCase();
      const gateSource = String(entry.gateSource || "unknown").trim().toLowerCase();
      byReasonCode[reasonCode] = (byReasonCode[reasonCode] || 0) + 1;
      byGateSource[gateSource] = (byGateSource[gateSource] || 0) + 1;
    }
    const latest = recent.length > 0 ? recent[recent.length - 1] : null;
    return {
      recentBlockCount: recent.length,
      byReasonCode,
      byGateSource,
      latestBlockReason: latest ? String(latest.blockReason || "") || null : null,
      latestBlockedAt: latest ? String(latest.blockedAt || "") || null : null,
    };
  } catch {
    return {
      recentBlockCount: 0,
      byReasonCode: {},
      byGateSource: {},
      latestBlockReason: null,
      latestBlockedAt: null,
    };
  }
}


