import fs from "node:fs/promises";
import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

export const PLATFORM_MODE = Object.freeze({
  SELF_DEV: "self_dev",
  SINGLE_TARGET_DELIVERY: "single_target_delivery",
  IDLE: "idle",
});

const VALID_PLATFORM_MODES = new Set(Object.values(PLATFORM_MODE));

type PlatformMode = typeof PLATFORM_MODE[keyof typeof PLATFORM_MODE];

export const PLATFORM_MODE_STATE_SCHEMA_VERSION = 1;

export const DEFAULT_PLATFORM_MODE_STATE = Object.freeze({
  schemaVersion: PLATFORM_MODE_STATE_SCHEMA_VERSION,
  currentMode: PLATFORM_MODE.IDLE,
  activeTargetSessionId: null,
  activeTargetProjectId: null,
  fallbackModeAfterCompletion: PLATFORM_MODE.IDLE,
  updatedAt: null,
  lastModeChangeAt: null,
  reason: "idle_default",
  singleTargetDeliveryEnabled: true,
  targetSessionStateEnabled: true,
  warnings: [],
});

function isValidMode(value: unknown): value is PlatformMode {
  const normalized = String(value || "").trim() as PlatformMode;
  return VALID_PLATFORM_MODES.has(normalized);
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

export function getPlatformModeStatePath(stateDir: string): string {
  return path.join(stateDir, "platform", "mode_state.json");
}

export function getActiveTargetSessionPath(stateDir: string): string {
  return path.join(stateDir, "active_target_session.json");
}

export function normalizePlatformModeState(rawState: any, activeTargetSession: any, config: any) {
  const singleTargetDeliveryEnabled = true;
  const targetSessionStateEnabled = true;
  const warnings: string[] = [];

  let currentMode = isValidMode(rawState?.currentMode)
    ? rawState.currentMode
    : DEFAULT_PLATFORM_MODE_STATE.currentMode;
  let fallbackModeAfterCompletion = isValidMode(rawState?.fallbackModeAfterCompletion)
    ? rawState.fallbackModeAfterCompletion
    : DEFAULT_PLATFORM_MODE_STATE.fallbackModeAfterCompletion;
  let activeTargetSessionId = normalizeNullableString(rawState?.activeTargetSessionId);
  let activeTargetProjectId = normalizeNullableString(rawState?.activeTargetProjectId);

  const activeSessionIdFromFile = normalizeNullableString(activeTargetSession?.sessionId);
  const activeProjectIdFromFile = normalizeNullableString(activeTargetSession?.projectId);

  if (currentMode === PLATFORM_MODE.SELF_DEV) {
    warnings.push("self_dev is not exposed in Atlas; falling back to idle");
    currentMode = PLATFORM_MODE.IDLE;
  }

  if (fallbackModeAfterCompletion === PLATFORM_MODE.SELF_DEV) {
    warnings.push("fallbackModeAfterCompletion cannot remain self_dev in Atlas; falling back to idle");
    fallbackModeAfterCompletion = PLATFORM_MODE.IDLE;
  }

  if (currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    if (!activeTargetSessionId && activeSessionIdFromFile) {
      activeTargetSessionId = activeSessionIdFromFile;
      activeTargetProjectId = activeProjectIdFromFile;
    } else if (activeTargetSessionId && activeSessionIdFromFile && activeTargetSessionId !== activeSessionIdFromFile) {
      warnings.push("active target session pointer disagreed with active_target_session.json; trusting active_target_session.json");
      activeTargetSessionId = activeSessionIdFromFile;
      activeTargetProjectId = activeProjectIdFromFile;
    }

    if (!activeTargetSessionId) {
      warnings.push("single_target_delivery mode requires an active target session pointer; falling back to idle");
      currentMode = PLATFORM_MODE.IDLE;
      activeTargetProjectId = null;
    }
  }

  if (currentMode !== PLATFORM_MODE.SINGLE_TARGET_DELIVERY && activeTargetSessionId) {
    warnings.push("non-target mode cannot keep an active target session pointer; clearing pointer");
    activeTargetSessionId = null;
    activeTargetProjectId = null;
  }

  return {
    schemaVersion: PLATFORM_MODE_STATE_SCHEMA_VERSION,
    currentMode,
    activeTargetSessionId,
    activeTargetProjectId,
    fallbackModeAfterCompletion,
    updatedAt: new Date().toISOString(),
    lastModeChangeAt: normalizeNullableString(rawState?.lastModeChangeAt),
    reason: normalizeNullableString(rawState?.reason) || DEFAULT_PLATFORM_MODE_STATE.reason,
    singleTargetDeliveryEnabled,
    targetSessionStateEnabled,
    warnings,
  };
}

export async function loadPlatformModeState(config: any) {
  const stateDir = config?.paths?.stateDir || "state";
  const modeStatePath = getPlatformModeStatePath(stateDir);
  const activeTargetSessionPath = getActiveTargetSessionPath(stateDir);
  await fs.mkdir(path.dirname(modeStatePath), { recursive: true });

  const [rawState, activeTargetSession] = await Promise.all([
    readJson(modeStatePath, null),
    readJson(activeTargetSessionPath, null),
  ]);

  const normalized = normalizePlatformModeState(rawState, activeTargetSession, config);
  await writeJson(modeStatePath, normalized);
  return normalized;
}

export async function persistPlatformModeState(config: any, rawState: any, activeTargetSession?: any) {
  const stateDir = config?.paths?.stateDir || "state";
  const modeStatePath = getPlatformModeStatePath(stateDir);
  const resolvedActiveTargetSession = activeTargetSession === undefined
    ? await readJson(getActiveTargetSessionPath(stateDir), null)
    : activeTargetSession;
  await fs.mkdir(path.dirname(modeStatePath), { recursive: true });
  const normalized = normalizePlatformModeState(rawState, resolvedActiveTargetSession, config);
  await writeJson(modeStatePath, normalized);
  return normalized;
}

export async function updatePlatformModeState(config: any, updates: any, activeTargetSession?: any) {
  const stateDir = config?.paths?.stateDir || "state";
  const modeStatePath = getPlatformModeStatePath(stateDir);
  const existingState = await readJson(modeStatePath, null);
  const requestedMode = updates && Object.prototype.hasOwnProperty.call(updates, "currentMode")
    ? updates.currentMode
    : undefined;
  const resolvedCurrentMode = requestedMode === null
    ? normalizeNullableString(existingState?.fallbackModeAfterCompletion) || DEFAULT_PLATFORM_MODE_STATE.fallbackModeAfterCompletion
    : requestedMode;
  const previousMode = normalizeNullableString(existingState?.currentMode);
  const nextMode = normalizeNullableString(resolvedCurrentMode);
  const now = new Date().toISOString();
  const rawState = {
    ...(existingState && typeof existingState === "object" ? existingState : {}),
    ...(updates && typeof updates === "object" ? updates : {}),
    ...(requestedMode === undefined ? {} : { currentMode: resolvedCurrentMode }),
    updatedAt: now,
    lastModeChangeAt: nextMode && nextMode !== previousMode
      ? now
      : normalizeNullableString(updates?.lastModeChangeAt)
        || normalizeNullableString(existingState?.lastModeChangeAt)
        || now,
  };
  return persistPlatformModeState(config, rawState, activeTargetSession);
}

export function summarizePlatformModeState(state: any): string {
  const warnings = Array.isArray(state?.warnings) ? state.warnings.length : 0;
  return [
    `currentMode=${String(state?.currentMode || DEFAULT_PLATFORM_MODE_STATE.currentMode)}`,
    `activeTargetSessionId=${String(state?.activeTargetSessionId || "none")}`,
    `fallbackModeAfterCompletion=${String(state?.fallbackModeAfterCompletion || DEFAULT_PLATFORM_MODE_STATE.fallbackModeAfterCompletion)}`,
    `singleTargetDeliveryEnabled=${state?.singleTargetDeliveryEnabled === true}`,
    `targetSessionStateEnabled=${state?.targetSessionStateEnabled === true}`,
    `warnings=${warnings}`,
  ].join(" | ");
}