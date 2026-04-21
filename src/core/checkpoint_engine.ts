import path from "node:path";
import crypto from "node:crypto";
import { readJsonSafe, READ_JSON_REASON, writeJsonAtomic } from "./fs_utils.js";
import { unlink } from "node:fs/promises";
import type { CancellationToken } from "./daemon_control.js";
import { normalizePromptLineageContract } from "./prompt_compiler.js";
import {
  normalizeInterventionLineageContract,
  resolveInterventionLineageJoinKey,
  type InterventionLineageContract,
} from "./state_tracker.js";

export const CHECKPOINT_SCHEMA_VERSION = 2;
export const CHECKPOINT_FORMAT = "resumable_v2";
export const CHECKPOINT_INTEGRITY_ALGORITHM = "sha256";
export const RUN_SEGMENT_BATCH_SPAN_DEFAULT = 5;
export const RUN_SEGMENT_HISTORY_MAX_DEFAULT = 20;
export const PHASE_AWARE_RETRY_STATE_SCHEMA_VERSION = 1;

/** Stable namespace identifiers for pipeline boundary checkpoints. */
export const CHECKPOINT_NS = {
  PLANNER: "planner",
  REVIEWER: "reviewer",
  DISPATCH: "dispatch",
  VERIFICATION: "verification",
  ATTEMPT: "attempt",
} as const;

export type CheckpointNs = typeof CHECKPOINT_NS[keyof typeof CHECKPOINT_NS];

export const WORKER_EXECUTION_PHASE = Object.freeze({
  PLAN: "plan",
  EDIT: "edit",
  TEST: "test",
  PUSH: "push",
} as const);

export type WorkerExecutionPhase = typeof WORKER_EXECUTION_PHASE[keyof typeof WORKER_EXECUTION_PHASE];

export const WORKER_EXECUTION_PHASE_ORDER = Object.freeze([
  WORKER_EXECUTION_PHASE.PLAN,
  WORKER_EXECUTION_PHASE.EDIT,
  WORKER_EXECUTION_PHASE.TEST,
  WORKER_EXECUTION_PHASE.PUSH,
] as const);

export function normalizeWorkerExecutionPhase(
  value: unknown,
  fallback: WorkerExecutionPhase | null = WORKER_EXECUTION_PHASE.PLAN,
): WorkerExecutionPhase | null {
  const normalized = String(value || "").toLowerCase().trim();
  return (WORKER_EXECUTION_PHASE_ORDER as readonly string[]).includes(normalized)
    ? normalized as WorkerExecutionPhase
    : fallback;
}

function normalizePhaseCheckpointEvidence(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 12)
    .map((entry) => ({
      code: String((entry as any).code || "unspecified"),
      detail: String((entry as any).detail || "").slice(0, 240),
      source: String((entry as any).source || "worker_output"),
    }));
}

function normalizePhaseCheckpointStates(value: unknown) {
  const output: Record<string, { status: string; evidence: Array<{ code: string; detail: string; source: string }> }> = {};
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  for (const phase of WORKER_EXECUTION_PHASE_ORDER) {
    const raw = input[phase];
    const state = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    output[phase] = {
      status: String(state.status || "pending"),
      evidence: normalizePhaseCheckpointEvidence(state.evidence),
    };
  }
  return output;
}

function hasMeaningfulLineageContract(lineage: InterventionLineageContract): boolean {
  return Object.entries(lineage).some(([key, value]) => key !== "schemaVersion" && value !== null);
}

function normalizeLineageJoinTaskKind(value: unknown): string {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function resolveCheckpointLineageJoinKey(
  lineage: InterventionLineageContract,
  payload: Record<string, unknown>,
): string | null {
  const explicitJoinKey = String(payload.lineageJoinKey || "").trim();
  const taskKind = normalizeLineageJoinTaskKind(payload.taskKind ?? lineage.taskKind);
  const role = String(payload.roleName ?? payload.role ?? lineage.role ?? "").trim().toLowerCase();
  const prefersPromptFamily = Boolean(
    lineage.promptFamilyKey
    && (
      taskKind === "planning"
      || taskKind === "plan-review"
      || taskKind === "review"
      || taskKind === "analysis"
      || role === "prometheus"
      || role === "athena"
      || role === "janus"
    ),
  );
  const derivedJoinKey = prefersPromptFamily
    ? `prompt-family:${lineage.promptFamilyKey}`
    : resolveInterventionLineageJoinKey(lineage)
      || (lineage.promptFamilyKey ? `prompt-family:${lineage.promptFamilyKey}` : null);
  if (explicitJoinKey && (!derivedJoinKey || explicitJoinKey === derivedJoinKey)) {
    return explicitJoinKey;
  }
  return derivedJoinKey ?? (explicitJoinKey || null);
}

function normalizeCheckpointLineageFields(payload: Record<string, unknown>) {
  const output = { ...payload };
  const lineage = normalizeInterventionLineageContract(
    output.lineage && typeof output.lineage === "object"
      ? output.lineage
      : output.lineageContract && typeof output.lineageContract === "object"
        ? output.lineageContract
        : output,
    {
      lineageId: output.lineageId as string | null,
      taskId: output.taskId as string | null,
      taskIdentity: output.taskIdentity as string | null,
      cycleId: output.cycleId as string | null,
      taskKind: output.taskKind as string | null,
      interventionId: output.interventionId as string | null,
      promptFamilyKey: output.promptFamilyKey as string | null,
      model: output.model as string | null,
      role: (output.roleName ?? output.role) as string | null,
      lane: output.lane as string | null,
      capability: output.capability as string | null,
      specialized: typeof output.specialized === "boolean" ? output.specialized : null,
      rerouteReasonCode: output.rerouteReasonCode as string | null,
    },
  );
  if (!hasMeaningfulLineageContract(lineage)) {
    return output;
  }
  const lineageJoinKey = resolveCheckpointLineageJoinKey(lineage, output);
  output.lineage = lineage;
  output.lineageContract = lineage;
  output.lineageId = lineage.lineageId;
  output.lineageJoinKey = lineageJoinKey;
  return output;
}

export function buildPhaseAwareAttemptCheckpoint(
  retryState: unknown,
  meta: {
    taskId?: string | null;
    roleName?: string | null;
    status?: string | null;
    retryAction?: string | null;
    failureClass?: string | null;
    lineage?: InterventionLineageContract | null;
    lineageJoinKey?: string | null;
  } = {},
) {
  const input = retryState && typeof retryState === "object" ? retryState as Record<string, unknown> : {};
  const phaseOrder = Array.isArray(input.phaseOrder)
    ? input.phaseOrder
      .map((phase) => normalizeWorkerExecutionPhase(phase, null))
      .filter(Boolean)
    : [...WORKER_EXECUTION_PHASE_ORDER];
  const effectivePhaseOrder = phaseOrder.length > 0 ? phaseOrder : [...WORKER_EXECUTION_PHASE_ORDER];
  return normalizeCheckpointLineageFields({
    schemaVersion: PHASE_AWARE_RETRY_STATE_SCHEMA_VERSION,
    retryStateKind: "phase_aware_retry_v1",
    phaseOrder: effectivePhaseOrder,
    currentPhase: normalizeWorkerExecutionPhase(input.currentPhase, WORKER_EXECUTION_PHASE.PLAN),
    failedPhase: normalizeWorkerExecutionPhase(input.failedPhase, null),
    resumeFromPhase: normalizeWorkerExecutionPhase(
      input.resumeFromPhase,
      normalizeWorkerExecutionPhase(input.currentPhase, WORKER_EXECUTION_PHASE.PLAN),
    ),
    lastCompletedPhase: normalizeWorkerExecutionPhase(input.lastCompletedPhase, null),
    phaseStates: normalizePhaseCheckpointStates(input.phaseStates),
    evidence: normalizePhaseCheckpointEvidence(input.evidence),
    mutation: input.mutation && typeof input.mutation === "object"
      ? {
          strategy: String((input.mutation as any).strategy || "resume_from_failed_phase"),
          instructions: Array.isArray((input.mutation as any).instructions)
            ? (input.mutation as any).instructions.slice(0, 8).map((item) => String(item || "").slice(0, 240))
            : [],
        }
      : {
          strategy: "resume_from_failed_phase",
          instructions: [],
        },
    taskId: meta.taskId != null ? String(meta.taskId) : null,
    roleName: meta.roleName != null ? String(meta.roleName) : null,
    status: meta.status != null ? String(meta.status) : null,
    retryAction: meta.retryAction != null ? String(meta.retryAction) : null,
    failureClass: meta.failureClass != null ? String(meta.failureClass) : null,
    lineage: meta.lineage ?? null,
    lineageJoinKey: meta.lineageJoinKey ?? null,
    recordedAt: new Date().toISOString(),
  });
}

const CHECKPOINT_META_KEYS = new Set([
  "schemaVersion",
  "checkpointFormat",
  "checkpointKind",
  "checkpointVersion",
  "replayCompatibility",
  "integrity",
]);

function extractPayloadFields(checkpoint) {
  const input = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (CHECKPOINT_META_KEYS.has(key)) continue;
    payload[key] = value;
  }
  return payload;
}

function normalizeCheckpointPromptLineageFields(payload: Record<string, unknown>) {
  const output = { ...payload };
  for (const fieldName of ["promptLineage", "plannerPromptLineage", "reviewerPromptLineage"] as const) {
    const raw = output[fieldName];
    if (raw && typeof raw === "object") {
      output[fieldName] = normalizePromptLineageContract(raw);
    }
  }
  return output;
}

function computeCheckpointIntegrity(payload) {
  return crypto.createHash(CHECKPOINT_INTEGRITY_ALGORITHM).update(JSON.stringify(payload)).digest("hex");
}

function resolveSegmentBounds(segmentIndex: number, spanBatches: number, totalBatches: number) {
  const safeSpan = Math.max(1, Math.floor(Number(spanBatches) || RUN_SEGMENT_BATCH_SPAN_DEFAULT));
  const safeTotal = Math.max(0, Math.floor(Number(totalBatches) || 0));
  const idx = Math.max(1, Math.floor(Number(segmentIndex) || 1));
  const startBatch = ((idx - 1) * safeSpan) + 1;
  const endBatch = Math.min(safeTotal > 0 ? safeTotal : startBatch + safeSpan - 1, idx * safeSpan);
  return { segmentIndex: idx, spanBatches: safeSpan, startBatch, endBatch };
}

export function initializeRunSegmentState(checkpoint, opts: { spanBatches?: number; historyMax?: number } = {}) {
  const target = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  const totalBatches = Math.max(0, Math.floor(Number((target as any).totalPlans || 0)));
  const spanBatches = Math.max(1, Math.floor(Number(opts.spanBatches) || RUN_SEGMENT_BATCH_SPAN_DEFAULT));
  const historyMax = Math.max(1, Math.floor(Number(opts.historyMax) || RUN_SEGMENT_HISTORY_MAX_DEFAULT));
  const initialized = {
    ...target,
    runSegment: {
      ...resolveSegmentBounds(1, spanBatches, totalBatches),
      startedAt: String((target as any)?.createdAt || new Date().toISOString()),
      rolloverAt: null,
    },
    runSegmentHistory: [],
    runSegmentHistoryMax: historyMax,
  };
  return initialized;
}

export function applyRunSegmentRollover(
  checkpoint,
  opts: { completedBatches: number; spanBatches?: number; historyMax?: number } = { completedBatches: 0 },
): {
  checkpoint: any;
  rolledOver: boolean;
  previousSegment?: Record<string, unknown> | null;
  activeSegment?: Record<string, unknown> | null;
} {
  const target = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  const totalBatches = Math.max(0, Math.floor(Number((target as any).totalPlans || 0)));
  const spanBatches = Math.max(
    1,
    Math.floor(
      Number(opts.spanBatches || (target as any)?.runSegment?.spanBatches || RUN_SEGMENT_BATCH_SPAN_DEFAULT),
    ),
  );
  const historyMax = Math.max(
    1,
    Math.floor(
      Number(opts.historyMax || (target as any)?.runSegmentHistoryMax || RUN_SEGMENT_HISTORY_MAX_DEFAULT),
    ),
  );
  const completedBatches = Math.max(0, Math.floor(Number(opts.completedBatches || 0)));
  const currentIndex = Math.max(1, Math.floor(Number((target as any)?.runSegment?.segmentIndex || 1)));
  const nextIndex = Math.max(1, Math.floor(completedBatches / spanBatches) + 1);
  const effectiveNextIndex = totalBatches > 0 ? Math.min(nextIndex, Math.ceil(totalBatches / spanBatches)) : nextIndex;
  const previousHistory = Array.isArray((target as any).runSegmentHistory) ? (target as any).runSegmentHistory : [];

  const base = {
    ...target,
    runSegmentHistoryMax: historyMax,
  };
  if (effectiveNextIndex <= currentIndex) {
    if (!(base as any).runSegment) {
      (base as any).runSegment = {
        ...resolveSegmentBounds(currentIndex, spanBatches, totalBatches),
        startedAt: new Date().toISOString(),
        rolloverAt: null,
      };
    }
    return { checkpoint: base, rolledOver: false, previousSegment: null, activeSegment: (base as any).runSegment || null };
  }

  const nowIso = new Date().toISOString();
  const previousSegment = {
    ...resolveSegmentBounds(currentIndex, spanBatches, totalBatches),
    completedBatches: Math.min(completedBatches, totalBatches || completedBatches),
    rolloverAt: nowIso,
  };
  const runSegmentHistory = [...previousHistory, previousSegment].slice(-historyMax);
  const activeSegment = {
    ...resolveSegmentBounds(effectiveNextIndex, spanBatches, totalBatches),
    startedAt: nowIso,
    rolloverAt: null,
  };
  const next = {
    ...base,
    runSegmentHistory,
    runSegment: activeSegment,
  };
  return { checkpoint: next, rolledOver: true, previousSegment, activeSegment };
}

export function createVersionedCheckpointEnvelope(checkpoint, previousCheckpoint = null, checkpointKind = "dispatch", logicalIds: { thread_id?: string; checkpoint_ns?: string; checkpoint_id?: string } = {}) {
  const payload = extractPayloadFields(checkpoint);
  const previous = previousCheckpoint && typeof previousCheckpoint === "object" ? previousCheckpoint : null;
  const nowIso = new Date().toISOString();
  const createdAt = String(payload.createdAt || (previous as any)?.createdAt || nowIso);
  const nextVersion = Math.max(
    1,
    Number((previous as any)?.checkpointVersion || checkpoint?.checkpointVersion || 0) + 1
  );
  const normalizedPayload = {
    ...normalizeCheckpointLineageFields(normalizeCheckpointPromptLineageFields(payload)),
    createdAt,
    updatedAt: nowIso,
  };
  // Include stable logical identifiers when provided; they participate in the integrity hash.
  if (logicalIds.thread_id) (normalizedPayload as any).thread_id = String(logicalIds.thread_id);
  if (logicalIds.checkpoint_ns) (normalizedPayload as any).checkpoint_ns = String(logicalIds.checkpoint_ns);
  if (logicalIds.checkpoint_id) (normalizedPayload as any).checkpoint_id = String(logicalIds.checkpoint_id);
  const integrityHash = computeCheckpointIntegrity(normalizedPayload);
  return {
    ...normalizedPayload,
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointFormat: CHECKPOINT_FORMAT,
    checkpointKind: String(checkpointKind || "dispatch"),
    checkpointVersion: nextVersion,
    replayCompatibility: {
      replayContractVersion: 1,
      legacySchemaVersion: 1,
      resumable: true,
    },
    integrity: {
      algorithm: CHECKPOINT_INTEGRITY_ALGORITHM,
      hash: integrityHash,
    },
  };
}

export function validateCheckpointEnvelope(checkpoint) {
  if (!checkpoint || typeof checkpoint !== "object") {
    return { ok: false, reason: "checkpoint_not_object" };
  }
  const schemaVersion = Number(checkpoint.schemaVersion || 0);
  if (schemaVersion < CHECKPOINT_SCHEMA_VERSION) {
    return { ok: true, reason: "legacy_schema" };
  }
  const payload = extractPayloadFields(checkpoint);
  const expectedHash = computeCheckpointIntegrity(payload);
  const actualHash = String(checkpoint?.integrity?.hash || "");
  if (!actualHash || actualHash !== expectedHash) {
    return { ok: false, reason: "checkpoint_integrity_mismatch" };
  }
  return { ok: true, reason: "ok" };
}

export async function readCheckpoint(config, opts = {}) {
  const stateDir = config?.paths?.stateDir || "state";
  const options = opts as { fileName?: string };
  const fileName = String(options.fileName || "dispatch_checkpoint.json");
  const filePath = path.join(stateDir, fileName);
  const raw = await readJsonSafe(filePath);
  if (!raw.ok) {
    if (raw.reason === READ_JSON_REASON.MISSING) return null;
    throw raw.error || new Error(`checkpoint_read_failed:${raw.reason}`);
  }
  const validation = validateCheckpointEnvelope(raw.data);
  if (!validation.ok) {
    throw new Error(validation.reason);
  }
  return raw.data;
}

export async function writeCheckpoint(config, checkpoint, opts = {}) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw new Error("checkpoint must be a non-null object");
  }
  const stateDir = config?.paths?.stateDir || "state";
  const options = opts as {
    fileName?: string;
    checkpointKind?: string;
    returnEnvelope?: boolean;
    token?: CancellationToken | null;
  };
  // Honour cooperative cancellation before performing the (potentially slow) write.
  checkCancellationAtCheckpoint(options.token);
  const fileName = options.fileName
    ? String(options.fileName)
    : `checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const checkpointKind = String(options.checkpointKind || "dispatch");
  const filePath = path.join(stateDir, fileName);
  const previousCheckpoint = options.fileName
    ? await readCheckpoint(config, { fileName }).catch(() => null)
    : null;
  const envelope = createVersionedCheckpointEnvelope(checkpoint, previousCheckpoint, checkpointKind);
  await writeJsonAtomic(filePath, envelope);
  return options.returnEnvelope ? envelope : filePath;
}

/**
 * Cooperative cancellation checkpoint for use inside checkpoint-writing flows.
 *
 * Throws CancelledError if the provided token is already cancelled; otherwise
 * returns immediately.  Safe to call with null/undefined — treated as no-op so
 * callers that have not opted into cancellation are unaffected.
 *
 * @param token — CancellationToken from createCancellationToken(), or null/undefined
 */
export function checkCancellationAtCheckpoint(token?: CancellationToken | null): void {
  token?.throwIfCancelled();
}

/**
 * Write a boundary checkpoint for a specific pipeline transition.
 *
 * Boundary checkpoints use stable logical identifiers (thread_id, checkpoint_ns,
 * checkpoint_id) so that each transition in the planner→reviewer→dispatch→verification
 * pipeline produces a uniquely addressable, replayable snapshot.
 *
 * @param config           - runtime config with paths.stateDir
 * @param payload          - the checkpoint data to persist
 * @param opts.thread_id   - stable cycle identifier (e.g. plan cycleId or timestamp)
 * @param opts.checkpoint_ns - pipeline namespace (use CHECKPOINT_NS constants)
 * @param opts.sequence    - monotonic sequence within the namespace (default: 1)
 * @param opts.token       - optional cancellation token
 * @returns file path where the checkpoint was written
 */
export async function writeBoundaryCheckpoint(
  config: unknown,
  payload: Record<string, unknown>,
  opts: {
    thread_id: string;
    checkpoint_ns: CheckpointNs | string;
    sequence?: number;
    token?: CancellationToken | null;
  },
): Promise<string> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const ns = String(opts.checkpoint_ns || CHECKPOINT_NS.DISPATCH);
  const seq = Math.max(1, Math.floor(Number(opts.sequence || 1)));
  const thread_id = String(opts.thread_id || "");
  const checkpoint_id = thread_id ? `${thread_id}/${ns}/${seq}` : `${ns}/${seq}`;
  const safeNs = ns.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeThread = thread_id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  const fileName = safeThread
    ? `boundary_checkpoint_${safeNs}_${safeThread}.json`
    : `boundary_checkpoint_${safeNs}.json`;
  const filePath = path.join(stateDir, fileName);

  checkCancellationAtCheckpoint(opts.token);

  const previousCheckpoint = await readCheckpoint(config, { fileName }).catch(() => null);
  const envelope = createVersionedCheckpointEnvelope(
    payload,
    previousCheckpoint,
    `boundary:${ns}`,
    { thread_id, checkpoint_ns: ns, checkpoint_id },
  );
  await writeJsonAtomic(filePath, envelope);
  return filePath;
}

/**
 * Reset the boundary checkpoint file for a given thread/namespace so stale
 * attempt state cannot bleed into the next retry. Safe to call even if no
 * checkpoint file exists (missing file is treated as a no-op).
 *
 * @param config            - runtime config with paths.stateDir
 * @param opts.thread_id    - stable cycle/worker identifier
 * @param opts.checkpoint_ns - namespace to clear (default: CHECKPOINT_NS.ATTEMPT)
 */
export async function resetAttemptBoundary(
  config: unknown,
  opts: {
    thread_id: string;
    checkpoint_ns?: typeof CHECKPOINT_NS[keyof typeof CHECKPOINT_NS] | string;
  },
): Promise<void> {
  const stateDir = (config as any)?.paths?.stateDir || "state";
  const ns = String(opts.checkpoint_ns || CHECKPOINT_NS.ATTEMPT);
  const thread_id = String(opts.thread_id || "");
  const safeNs = ns.replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeThread = thread_id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  const fileName = safeThread
    ? `boundary_checkpoint_${safeNs}_${safeThread}.json`
    : `boundary_checkpoint_${safeNs}.json`;
  const filePath = path.join(stateDir, fileName);
  try {
    await unlink(filePath);
  } catch (err: any) {
    // ENOENT means no checkpoint to clear — that is fine.
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

