/**
 * pr_triage_automation.mjs — Reusable stale automated-PR guard.
 *
 * Scans open PRs on the target repo, identifies automated/recovery PRs by branch
 * prefix, audits CI status and diff substance, then records a deterministic
 * MERGE or CLOSE decision with evidence to state/pr_triage_<number>.json.
 *
 * Usage (standalone):
 *   node scripts/pr_triage_automation.mjs
 *
 * Exports:
 *   triageStalePrs(options) — programmatic entry point used by the orchestrator.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Branch prefixes that identify BOX-owned automated PRs. */
const AUTOMATED_BRANCH_PREFIXES = [
  "recovery/",
  "evolution/",
  "box/",
  "wave",
  "pr-",
  "qa/",
  "scan/",
];

/** Title patterns that indicate an automated/recovery PR. */
const AUTOMATED_TITLE_PATTERNS = [
  /api[:\s-]*blocked/i,
  /automated\s+commit/i,
  /auto[-\s]?recovery/i,
  /\[auto\]/i,
];

/** Minimum age in milliseconds before a PR is considered stale (3 days). */
const STALE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

/** Branch drift threshold: PRs more than this many commits behind base are closed. */
const BRANCH_DRIFT_CLOSE_THRESHOLD = 10;

/**
 * Determine whether a PR is BOX-owned and automated.
 *
 * @param {object} pr — GitHub PR object
 * @returns {boolean}
 */
function isAutomatedPr(pr) {
  if (!pr || typeof pr !== "object") return false;
  const branch = String(pr.headRefName || pr.head?.ref || "");
  const title = String(pr.title || "");
  const isBotBranch = AUTOMATED_BRANCH_PREFIXES.some((p) => branch.startsWith(p));
  const isBotTitle = AUTOMATED_TITLE_PATTERNS.some((re) => re.test(title));
  return isBotBranch || isBotTitle;
}

/**
 * Classify the automation class of a PR for the triage record.
 *
 * @param {object} pr — GitHub PR object
 * @returns {string}
 */
function classifyAutomationClass(pr) {
  const branch = String(pr?.headRefName || pr?.head?.ref || "");
  const title = String(pr?.title || "").toLowerCase();
  if (branch.startsWith("recovery/")) return "api-blocked-recovery";
  if (branch.startsWith("evolution/")) return "evolution-worker";
  if (/api[:\s-]*blocked/.test(title)) return "api-blocked-recovery";
  if (branch.startsWith("box/")) return "box-automation";
  if (branch.startsWith("qa/")) return "qa-automation";
  return "unknown-automation";
}

/**
 * Run the GitHub CLI to retrieve PR CI check status.
 *
 * @param {number} prNumber
 * @param {string} repo — "owner/name"
 * @returns {Promise<{ allChecksPassed: boolean, totalChecks: number, failingChecks: number, passingChecks: number, pendingChecks: number, checkNames: string[] }>}
 */
async function fetchPrCiStatus(prNumber, repo) {
  const fallback = {
    allChecksPassed: false,
    totalChecks: 0,
    failingChecks: 0,
    passingChecks: 0,
    pendingChecks: 0,
    checkNames: [],
  };

  try {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "checks",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "name,state,conclusion",
    ]);

    const checks = JSON.parse(String(stdout || "[]"));
    if (!Array.isArray(checks)) return fallback;

    const total = checks.length;
    const failing = checks.filter(
      (c) => String(c?.conclusion || c?.state || "").toLowerCase() === "failure",
    ).length;
    const passing = checks.filter((c) => {
      const s = String(c?.conclusion || c?.state || "").toLowerCase();
      return s === "success" || s === "passed";
    }).length;
    const pending = checks.filter((c) => {
      const s = String(c?.conclusion || c?.state || "").toLowerCase();
      return s === "pending" || s === "in_progress" || s === "queued";
    }).length;
    const names = checks.map((c) => String(c?.name || "")).filter(Boolean);

    return {
      allChecksPassed: total > 0 && failing === 0 && pending === 0,
      totalChecks: total,
      failingChecks: failing,
      passingChecks: passing,
      pendingChecks: pending,
      checkNames: names,
    };
  } catch (err) {
    // gh CLI unavailable or PR not found — return conservative fallback
    console.error(`[pr_triage] CI check fetch failed for PR #${prNumber}: ${String(err?.message || err)}`);
    return fallback;
  }
}

/**
 * Retrieve the diff metadata for a PR (files changed + lines).
 *
 * @param {number} prNumber
 * @param {string} repo
 * @returns {Promise<{ filesChanged: string[], hasSubstantiveChanges: boolean, summary: string }>}
 */
async function fetchPrDiffMeta(prNumber, repo) {
  const fallback = { filesChanged: [], hasSubstantiveChanges: false, summary: "diff unavailable" };

  try {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "diff",
      String(prNumber),
      "--repo",
      repo,
      "--name-only",
    ]);

    const files = String(stdout || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    const hasSubstantiveChanges = files.length > 0 && files.some((f) =>
      /\.(ts|js|mjs|cjs|json|yml|yaml|sh|md)$/.test(f),
    );

    const summary =
      files.length > 0
        ? `${files.length} file(s) changed: ${files.slice(0, 5).join(", ")}${files.length > 5 ? " …" : ""}`
        : "no files changed";

    return { filesChanged: files, hasSubstantiveChanges, summary };
  } catch (err) {
    console.error(`[pr_triage] diff fetch failed for PR #${prNumber}: ${String(err?.message || err)}`);
    return fallback;
  }
}

/**
 * Decide whether to merge or close a PR based on CI + diff + merge-state evidence.
 *
 * Rules (in priority order):
 *  1. Merge conflicts (mergeable=false) → hard CLOSE (branch triage signal)
 *  2. Excessive branch drift (behindBy > threshold) → hard CLOSE (stale branch signal)
 *  3. CI has failing checks → CLOSE (do not promote broken code)
 *  4. CI is fully pending and PR is stale → CLOSE
 *  5. CI passes and diff has substantive changes → MERGE
 *  6. CI passes but diff is empty/trivial → CLOSE (no-op automated PR)
 *
 * @param {{ allChecksPassed: boolean, failingChecks: number, pendingChecks: number }} ci
 * @param {{ hasSubstantiveChanges: boolean }} diff
 * @param {number} ageMs
 * @param {{ mergeable?: boolean|null, behindBy?: number }} [mergeState]
 * @returns {{ decision: "MERGE" | "CLOSE", rationale: string }}
 */
function makeTriageDecision(ci, diff, ageMs, mergeState) {
  // Hard CLOSE: merge conflicts detected — content requires manual conflict resolution.
  if (mergeState?.mergeable === false) {
    return {
      decision: "CLOSE",
      rationale: "PR has merge conflicts. Branch must be rebased or conflicts resolved before merging. Salvage: identify relevant commits and open a fresh branch from main.",
    };
  }
  // Hard CLOSE: excessive branch drift — branch too far behind base to be reliable.
  const behindBy = Number(mergeState?.behindBy ?? 0);
  if (behindBy > BRANCH_DRIFT_CLOSE_THRESHOLD) {
    return {
      decision: "CLOSE",
      rationale: `Branch is ${behindBy} commits behind base (threshold: ${BRANCH_DRIFT_CLOSE_THRESHOLD}). Salvage: cherry-pick relevant commits onto a fresh branch from main.`,
    };
  }
  if (ci.failingChecks > 0) {
    return {
      decision: "CLOSE",
      rationale: `CI has ${ci.failingChecks} failing check(s). Cannot merge failing code.`,
    };
  }

  if (ci.totalChecks === 0 || (ci.pendingChecks > 0 && ageMs > STALE_AGE_MS)) {
    return {
      decision: "CLOSE",
      rationale: `No CI checks found (or all pending) and PR is ${Math.round(ageMs / (24 * 60 * 60 * 1000))} day(s) old. Stale with no evidence of correctness.`,
    };
  }

  if (ci.allChecksPassed && diff.hasSubstantiveChanges) {
    return {
      decision: "MERGE",
      rationale: `CI checks all pass (${ci.passingChecks}/${ci.totalChecks}). Diff contains substantive production changes. Safe to merge automatically.`,
    };
  }

  return {
    decision: "CLOSE",
    rationale: `CI passes but diff has no substantive changes (no-op or trivial automated commit). Closing to keep PR list clean.`,
  };
}

/**
 * Write a triage record to state/pr_triage_<number>.json.
 *
 * @param {string} stateDir
 * @param {object} record
 */
async function writeTriageRecord(stateDir, record) {
  const filePath = path.join(stateDir, `pr_triage_${record.pr.number}.json`);
  await fs.writeFile(filePath, JSON.stringify(record, null, 2) + "\n", "utf8");
  return filePath;
}

/**
 * Triage stale automated PRs in the target repository.
 *
 * State machine per PR:
 *   pending → applied  (decision executed successfully)
 *   pending → failed   (execution error — retryable on next run)
 *   applied             (terminal — idempotency gate skips re-processing)
 *
 * For each open automated PR, this function:
 *  1. Checks existing triage record for applyState=applied (idempotency gate)
 *  2. Fetches CI check status via `gh pr checks`
 *  3. Fetches diff file list via `gh pr diff --name-only`
 *  4. Applies deterministic MERGE/CLOSE decision rules
 *  5. Writes a triage record to state/pr_triage_<number>.json with applyState=pending
 *  6. Executes the decision (merge/close) when `dryRun=false`
 *  7. Updates the record with applyState=applied|failed and appliedAt|applyError
 *
 * @param {{ repo: string, stateDir?: string, dryRun?: boolean }} options
 * @returns {Promise<Array<{ prNumber: number, decision: string, written: string, applyState: string }>>}
 */
export async function triageStalePrs(options = {}) {
  const repo = String(options.repo || process.env.BOX_TARGET_REPO || "");
  const stateDir = String(options.stateDir || "state");
  const dryRun = options.dryRun !== false; // default: dry run (no API mutations)
  const results = [];

  if (!repo) {
    console.error("[pr_triage] No repo specified. Set options.repo or BOX_TARGET_REPO.");
    return results;
  }

  // Fetch all open PRs
  let openPrs = [];
  try {
    const { stdout } = await execFileAsync("gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,title,state,headRefName,createdAt,mergedAt",
    ]);
    const parsed = JSON.parse(String(stdout || "[]"));
    openPrs = Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`[pr_triage] Failed to list open PRs: ${String(err?.message || err)}`);
    return results;
  }

  const automatedPrs = openPrs.filter(isAutomatedPr);
  if (automatedPrs.length === 0) {
    console.log("[pr_triage] No automated PRs found.");
    return results;
  }

  for (const pr of automatedPrs) {
    const prNumber = Number(pr.number);
    const createdAt = String(pr.createdAt || "");
    const ageMs = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;

    // Idempotency gate: skip PRs already in terminal applied state.
    const recordFilePath = path.join(stateDir, `pr_triage_${prNumber}.json`);
    let existingRecord = null;
    try {
      const raw = await fs.readFile(recordFilePath, "utf8");
      existingRecord = JSON.parse(raw);
    } catch { /* no existing record — first run */ }

    if (existingRecord?.applyState === "applied") {
      console.log(`[pr_triage] PR #${prNumber} already applied — skipping`);
      results.push({ prNumber, decision: existingRecord.decision, written: recordFilePath, applyState: "applied" });
      continue;
    }

    const [ci, diff] = await Promise.all([
      fetchPrCiStatus(prNumber, repo),
      fetchPrDiffMeta(prNumber, repo),
    ]);

    const { decision, rationale } = makeTriageDecision(ci, diff, ageMs);
    const now = new Date().toISOString();

    // Determine initial applyState: skipped in dry-run, pending in execute mode.
    const initialApplyState = dryRun ? "skipped" : "pending";

    const record = {
      schemaVersion: 1,
      triageTimestamp: now,
      pr: {
        number: prNumber,
        title: String(pr.title || ""),
        state: "OPEN",
        branch: String(pr.headRefName || ""),
        createdAt,
        mergedAt: pr.mergedAt || null,
        isAutomatedPr: true,
        automationClass: classifyAutomationClass(pr),
      },
      ci,
      diff,
      decision,
      rationale,
      decidedBy: "pr_triage_automation",
      decidedAt: now,
      applyState: initialApplyState,
    };

    let written = "";
    try {
      written = await writeTriageRecord(stateDir, record);
      console.log(`[pr_triage] PR #${prNumber} → ${decision} (written: ${written})`);
    } catch (err) {
      console.error(`[pr_triage] Failed to write triage record for PR #${prNumber}: ${String(err?.message || err)}`);
    }

    // Execute decision only in non-dry-run mode, then persist the apply result.
    let applyState = initialApplyState;
    if (!dryRun) {
      let appliedAt = null;
      let applyError = null;
      try {
        if (decision === "MERGE") {
          await execFileAsync("gh", [
            "pr",
            "merge",
            String(prNumber),
            "--repo",
            repo,
            "--squash",
            "--auto",
          ]);
          applyState = "applied";
          appliedAt = new Date().toISOString();
          console.log(`[pr_triage] Merged PR #${prNumber}`);
        } else if (decision === "CLOSE") {
          await execFileAsync("gh", [
            "pr",
            "close",
            String(prNumber),
            "--repo",
            repo,
            "--comment",
            `[pr_triage_automation] Closing stale automated PR: ${rationale}`,
          ]);
          applyState = "applied";
          appliedAt = new Date().toISOString();
          console.log(`[pr_triage] Closed PR #${prNumber}`);
        }
      } catch (err) {
        applyState = "failed";
        applyError = String(err?.message || err);
        console.error(`[pr_triage] Failed to execute ${decision} for PR #${prNumber}: ${applyError}`);
      }

      // Persist apply result back to record.
      try {
        const updatedRecord = { ...record, applyState };
        if (appliedAt) updatedRecord.appliedAt = appliedAt;
        if (applyError) updatedRecord.applyError = applyError;
        written = await writeTriageRecord(stateDir, updatedRecord);
      } catch (err) {
        console.error(`[pr_triage] Failed to update apply state for PR #${prNumber}: ${String(err?.message || err)}`);
      }
    }

    results.push({ prNumber, decision, written, applyState });
  }

  return results;
}

// ── Standalone execution ─────────────────────────────────────────────────────
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("pr_triage_automation.mjs") ||
    process.argv[1].endsWith("pr_triage_automation"));

if (isMain) {
  const repo = process.argv[2] || process.env.BOX_TARGET_REPO || "";
  const dryRun = !process.argv.includes("--execute");
  const stateDir = "state";

  if (!repo) {
    console.error("Usage: node scripts/pr_triage_automation.mjs <owner/repo> [--execute]");
    process.exit(1);
  }

  try {
    const results = await triageStalePrs({ repo, stateDir, dryRun });
    console.log(`[pr_triage] Done. Triaged ${results.length} automated PR(s).`);
    if (dryRun && results.length > 0) {
      console.log("[pr_triage] Dry-run mode — no PRs were merged or closed. Pass --execute to apply decisions.");
    }
  } catch (err) {
    console.error(`[pr_triage] Fatal error: ${String(err?.message || err)}`);
    process.exit(1);
  }
}
