#!/usr/bin/env node
/**
 * Athena Rubric Calibration Runner
 *
 * Runs the fixed calibration fixture set through the heuristic plan scorer
 * and computes a deviation score against expected verdicts.
 *
 * Integration point: Run this script as a release gate step.
 * Exit code: 0 = pass (deviation ≤ maxDeviationScore)
 *            1 = drift gate failed, input error, or fixture load failure
 *
 * Config location: box.config.json → athenaCalibration
 *   fixturesDir      : path to calibration fixture directory (relative to repo root)
 *   maxDeviationScore: float [0.0, 1.0] — maximum allowed deviation (default: 0.25)
 *   stateFile        : path to write the run result JSON (relative to repo root)
 *
 * Usage:
 *   node scripts/athena_calibration.ts [--dry-run]
 *
 * --dry-run: compute and report, but always exit 0 (warning mode).
 *
 * Deviation score formula:
 *   deviationScore = mismatches / total_fixtures
 *   Range: [0.0, 1.0], unit: fraction
 *   0.0 = perfect (all fixtures match expected verdicts)
 *   1.0 = complete drift (all fixtures produce wrong verdicts)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  scoreCalibrationPlan,
  computeCalibrationDeviation,
  runCalibration,
  RATIONALE_CLASS,
  VALID_RATIONALE_CLASSES
} from "../src/core/athena_reviewer.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const REASON = Object.freeze({
  PASS:             "PASS",
  DRIFT_EXCEEDED:   "DRIFT_EXCEEDED",
  NO_FIXTURES:      "NO_FIXTURES",
  LOAD_ERROR:       "LOAD_ERROR",
  INVALID_FIXTURE:  "INVALID_FIXTURE",
  CONFIG_ERROR:     "CONFIG_ERROR"
});

/** Required fields for a calibration fixture (schemaVersion 1). */
const REQUIRED_FIXTURE_FIELDS = ["schemaVersion", "fixtureId", "category", "expectedVerdict", "expectedRationaleClasses", "plan"];
/** Valid expectedVerdict values */
const VALID_VERDICTS = new Set(["approved", "ambiguous", "rejected"]);
/** Valid category values */
const VALID_CATEGORIES = new Set(["good", "ambiguous", "bad"]);

async function loadConfig() {
  const configPath = path.join(REPO_ROOT, "box.config.json");
  try {
    const raw = await fs.readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Validate a parsed fixture object.
 * Distinguishes missing input from invalid input.
 *
 * @returns {{ valid: boolean, reason: string, message: string }}
 */
function validateFixture(fixture, fixtureId) {
  if (!fixture || typeof fixture !== "object") {
    return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: fixture is not an object` };
  }
  for (const field of REQUIRED_FIXTURE_FIELDS) {
    if (!(field in fixture)) {
      return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: missing required field '${field}'` };
    }
  }
  if (!VALID_VERDICTS.has(fixture.expectedVerdict)) {
    return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: expectedVerdict '${fixture.expectedVerdict}' is not a valid CALIBRATION_VERDICT` };
  }
  if (!VALID_CATEGORIES.has(fixture.category)) {
    return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: category '${fixture.category}' must be one of: good, ambiguous, bad` };
  }
  if (!Array.isArray(fixture.expectedRationaleClasses)) {
    return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: expectedRationaleClasses must be an array` };
  }
  for (const cls of fixture.expectedRationaleClasses) {
    if (!VALID_RATIONALE_CLASSES.has(cls)) {
      return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: unknown rationale class '${cls}' — must be a value from RATIONALE_CLASS enum` };
    }
  }
  if (!fixture.plan || typeof fixture.plan !== "object") {
    return { valid: false, reason: REASON.INVALID_FIXTURE, message: `${fixtureId}: plan must be an object` };
  }
  return { valid: true, reason: REASON.PASS, message: "ok" };
}

async function loadFixtures(fixturesDir) {
  let entries;
  try {
    entries = await fs.readdir(fixturesDir);
  } catch (err) {
    return { ok: false, reason: REASON.LOAD_ERROR, message: `Cannot read fixtures dir '${fixturesDir}': ${err.message}`, fixtures: [] };
  }

  const jsonFiles = entries.filter(f => f.endsWith(".json")).sort();
  if (jsonFiles.length === 0) {
    return { ok: false, reason: REASON.NO_FIXTURES, message: `No .json fixtures found in '${fixturesDir}'`, fixtures: [] };
  }

  const fixtures = [];
  for (const file of jsonFiles) {
    const filePath = path.join(fixturesDir, file);
    let parsed;
    try {
      const raw = await fs.readFile(filePath, "utf8");
      parsed = JSON.parse(raw);
    } catch (err) {
      return { ok: false, reason: REASON.LOAD_ERROR, message: `Failed to parse '${file}': ${err.message}`, fixtures: [] };
    }

    const validation = validateFixture(parsed, file);
    if (!validation.valid) {
      return { ok: false, reason: validation.reason, message: validation.message, fixtures: [] };
    }
    fixtures.push(parsed);
  }
  return { ok: true, reason: REASON.PASS, message: "ok", fixtures };
}

async function writeResult(stateFile, result) {
  if (!stateFile) return;
  const absPath = path.isAbsolute(stateFile) ? stateFile : path.join(REPO_ROOT, stateFile);
  try {
    await fs.writeFile(absPath, JSON.stringify(result, null, 2), "utf8");
  } catch (err) {
    // Non-fatal — state write failure does not affect exit code
    console.warn(`[athena_calibration] WARNING: could not write state file '${absPath}': ${err.message}`);
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const config = await loadConfig();
  if (!config) {
    console.error("[athena_calibration] ERROR: could not load box.config.json");
    process.exit(1);
  }

  const calibConfig = config.athenaCalibration;
  if (!calibConfig || typeof calibConfig !== "object") {
    console.error("[athena_calibration] ERROR: box.config.json is missing 'athenaCalibration' section — reason_code=CONFIG_ERROR");
    process.exit(1);
  }

  const fixturesDir = calibConfig.fixturesDir
    ? path.resolve(REPO_ROOT, calibConfig.fixturesDir)
    : path.join(REPO_ROOT, "tests", "fixtures", "calibration");

  const maxDeviationScore = typeof calibConfig.maxDeviationScore === "number"
    ? calibConfig.maxDeviationScore
    : 0.25;

  const stateFile = calibConfig.stateFile || null;

  console.log(`[athena_calibration] fixturesDir=${fixturesDir}`);
  console.log(`[athena_calibration] maxDeviationScore=${maxDeviationScore}`);
  if (dryRun) console.log("[athena_calibration] --dry-run mode: gate failure will not set exit code 1");

  const loaded = await loadFixtures(fixturesDir);
  if (!loaded.ok) {
    const runResult = {
      status: "error",
      reason: loaded.reason,
      message: loaded.message,
      deviationScore: null,
      total: 0,
      mismatches: 0,
      runAt: new Date().toISOString()
    };
    await writeResult(stateFile, runResult);
    console.error(`[athena_calibration] ERROR: ${loaded.message} — reason_code=${loaded.reason}`);
    process.exit(1);
  }

  console.log(`[athena_calibration] Loaded ${loaded.fixtures.length} fixture(s)`);

  const calibResult = runCalibration(loaded.fixtures);

  const runResult = {
    status: calibResult.deviationScore <= maxDeviationScore ? "pass" : "fail",
    reason: calibResult.deviationScore <= maxDeviationScore ? REASON.PASS : REASON.DRIFT_EXCEEDED,
    deviationScore: calibResult.deviationScore,
    maxDeviationScore,
    total: calibResult.total,
    mismatches: calibResult.mismatches,
    details: calibResult.details,
    results: calibResult.results.map(r => ({
      fixtureId: r.fixture?.fixtureId,
      expectedVerdict: r.fixture?.expectedVerdict,
      actualCategory: r.scoreCategory,
      score: r.score,
      rationaleClasses: r.rationaleClasses,
      match: r.fixture?.expectedVerdict === r.scoreCategory
    })),
    runAt: new Date().toISOString()
  };

  await writeResult(stateFile, runResult);

  for (const r of runResult.results) {
    const icon = r.match ? "✓" : "✗";
    console.log(`  ${icon} [${r.fixtureId}] expected=${r.expectedVerdict} actual=${r.actualCategory} score=${r.score} classes=${r.rationaleClasses.join(",")}`);
  }

  console.log(`\n[athena_calibration] deviationScore=${calibResult.deviationScore} (${calibResult.mismatches}/${calibResult.total} mismatches)`);
  console.log(`[athena_calibration] maxDeviationScore=${maxDeviationScore}`);

  if (calibResult.deviationScore > maxDeviationScore) {
    console.error(`\n[athena_calibration] DRIFT GATE FAILED — deviationScore=${calibResult.deviationScore} exceeds maxDeviationScore=${maxDeviationScore} — reason_code=${REASON.DRIFT_EXCEEDED}`);
    if (dryRun) {
      console.warn("[athena_calibration] --dry-run: exiting 0 despite gate failure");
      process.exit(0);
    }
    process.exit(1);
  }

  console.log(`\n[athena_calibration] PASS — rubric drift within configured bound`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[athena_calibration] FATAL: ${err.message}`);
  process.exit(1);
});
