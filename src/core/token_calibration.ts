/**
 * Token Calibration Module
 *
 * Tracks estimated vs actual token usage per batch and maintains EWMA
 * calibration coefficients that improve estimatePlanTokens accuracy over time.
 *
 * No extra premium requests — calibration is purely based on post-dispatch
 * telemetry (worker-reported actual token usage).
 *
 * State file: state/token_calibration.json
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const CALIBRATION_FILE = "token_calibration.json";
const MAX_SAMPLES = 200;

/** EWMA smoothing factor — higher = more weight on recent samples. */
const DEFAULT_EWMA_ALPHA = 0.15;

/**
 * Hard bounds on the calibration coefficient to prevent runaway drift.
 * A coefficient of 1.0 means no adjustment. Range: [0.5, 2.5].
 */
const MIN_COEFFICIENT = 0.5;
const MAX_COEFFICIENT = 2.5;

export interface CalibrationSample {
  batchRole: string;
  estimatedTokens: number;
  actualTokens: number;
  ratio: number; // actual / estimated
  recordedAt: string;
}

export interface CalibrationState {
  schemaVersion: number;
  globalCoefficient: number;
  roleCoefficients: Record<string, number>;
  samples: CalibrationSample[];
  updatedAt: string;
}

function defaultState(): CalibrationState {
  return {
    schemaVersion: 1,
    globalCoefficient: 1.0,
    roleCoefficients: {},
    samples: [],
    updatedAt: new Date().toISOString(),
  };
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function calibrationFilePath(config: any): string {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, CALIBRATION_FILE);
}

/**
 * Read the current calibration state from disk.
 */
export async function readCalibrationState(config: object): Promise<CalibrationState> {
  const filePath = calibrationFilePath(config);
  const raw = await readJson<CalibrationState | null>(filePath, null);
  if (!raw || typeof raw !== "object" || !Number.isFinite(raw.globalCoefficient)) {
    return defaultState();
  }
  return {
    ...defaultState(),
    ...raw,
    samples: Array.isArray(raw.samples) ? raw.samples : [],
    roleCoefficients: raw.roleCoefficients && typeof raw.roleCoefficients === "object"
      ? raw.roleCoefficients
      : {},
  };
}

/**
 * Record actual token usage for a batch and update EWMA coefficients.
 *
 * @param config         — BOX config
 * @param batchRole      — worker role that executed the batch
 * @param estimatedTokens — sum of estimatePlanTokens() at dispatch time
 * @param actualTokens   — actual tokens reported by the worker/provider
 */
export async function recordCalibrationSample(
  config: object,
  batchRole: string,
  estimatedTokens: number,
  actualTokens: number
): Promise<void> {
  if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return;
  if (!Number.isFinite(actualTokens) || actualTokens <= 0) return;

  const state = await readCalibrationState(config);
  const alpha = Number((config as any)?.planner?.tokenCalibration?.ewmaAlpha) || DEFAULT_EWMA_ALPHA;
  const role = String(batchRole || "evolution-worker").trim() || "evolution-worker";
  const ratio = actualTokens / estimatedTokens;

  const sample: CalibrationSample = {
    batchRole: role,
    estimatedTokens,
    actualTokens,
    ratio,
    recordedAt: new Date().toISOString(),
  };

  state.samples.push(sample);
  if (state.samples.length > MAX_SAMPLES) {
    state.samples = state.samples.slice(-MAX_SAMPLES);
  }

  // Update global EWMA coefficient
  state.globalCoefficient = clampCoefficient(
    ewma(state.globalCoefficient, ratio, alpha)
  );

  // Update per-role EWMA coefficient
  const prevRole = state.roleCoefficients[role] ?? 1.0;
  state.roleCoefficients[role] = clampCoefficient(
    ewma(prevRole, ratio, alpha)
  );

  state.updatedAt = new Date().toISOString();
  await writeJson(calibrationFilePath(config), state);
}

/**
 * Get the calibration coefficient for a given role.
 * Falls back to global coefficient, then 1.0 (no adjustment).
 */
export function getCalibrationCoefficient(state: CalibrationState, role: string): number {
  const roleCoeff = state.roleCoefficients[role];
  if (Number.isFinite(roleCoeff) && roleCoeff > 0) return roleCoeff;
  if (Number.isFinite(state.globalCoefficient) && state.globalCoefficient > 0) {
    return state.globalCoefficient;
  }
  return 1.0;
}

function ewma(prev: number, current: number, alpha: number): number {
  return alpha * current + (1 - alpha) * prev;
}

function clampCoefficient(value: number): number {
  return Math.max(MIN_COEFFICIENT, Math.min(MAX_COEFFICIENT, value));
}
