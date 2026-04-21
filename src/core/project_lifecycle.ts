/**
 * Project Lifecycle Manager
 *
 * Handles the full lifecycle of BOX working on a target repository:
 *
 * 1. PRE-WORK BASELINE — Before any changes, tag the target repo's current HEAD
 *    so the owner can always roll back to the exact state before BOX touched it.
 *    Tag: `box/baseline-{date}`
 *
 * 2. PROJECT COMPLETION — After all waves are done and verified:
 *    - Create a completion tag: `box/completed-{date}`
 *    - Create a GitHub release summarizing all work done
 *    - Record the project in completed_projects.json
 *    - Close any remaining stale BOX branches/PRs
 *
 * Design principles:
 *   - Tags are lightweight — zero overhead during normal work
 *   - Rollback is trivial: `git revert box/baseline-{date}..main` or `git reset`
 *   - No impact on worker workflows — lifecycle runs at orchestrator level only
 *   - All GitHub API calls are non-fatal — lifecycle failures never block work
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { warn } from "./logger.js";
import {
  normalizePostmortemVerdict,
  POSTMORTEM_PARSE_REASON
} from "./athena_reviewer.js";

// ── GitHub API helpers ───────────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0",
    "Content-Type": "application/json"
  };
}

async function ghGet(url, token) {
  try {
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function ghPost(url, token, body) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: ghHeaders(token),
      body: JSON.stringify(body)
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

// ── Date helpers ─────────────────────────────────────────────────────────────

function dateTag() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── PRE-WORK BASELINE ────────────────────────────────────────────────────────

/**
 * Tag the target repo's current default-branch HEAD before BOX makes any changes.
 * Creates a lightweight tag: `box/baseline-YYYY-MM-DD`
 * If a baseline already exists for today, skip (idempotent).
 *
 * This tag is the "undo point" — the repo owner can always:
 *   git diff box/baseline-2026-03-18..main     # see everything BOX did
 *   git revert --no-commit box/baseline-2026-03-18..HEAD  # undo all BOX changes
 */
export async function capturePreWorkBaseline(config) {
  const token = config.env?.githubToken;
  const repo = config.env?.targetRepo;
  if (!token || !repo) return null;

  const base = `https://api.github.com/repos/${repo}`;
  const tagName = `box/baseline-${dateTag()}`;

  try {
    // Check if this baseline tag already exists (idempotent)
    const existing: any = await ghGet(`${base}/git/refs/tags/${encodeURIComponent(tagName)}`, token);
    if (existing?.ref) {
      await appendProgress(config, `[LIFECYCLE] Baseline tag already exists: ${tagName}`);
      return tagName;
    }

    // Get default branch HEAD SHA
    const repoInfo: any = await ghGet(base, token);
    const defaultBranch = repoInfo?.default_branch || "main";
    const branchInfo: any = await ghGet(`${base}/branches/${encodeURIComponent(defaultBranch)}`, token);
    const sha = branchInfo?.commit?.sha;
    if (!sha) {
      warn("[lifecycle] Could not resolve default branch HEAD — skipping baseline");
      return null;
    }

    // Create the tag ref
    const created: any = await ghPost(`${base}/git/refs`, token, {
      ref: `refs/tags/${tagName}`,
      sha
    });

    if (created?.ref) {
      await appendProgress(config, `[LIFECYCLE] Pre-work baseline captured: ${tagName} → ${sha.slice(0, 7)}`);
      // Record in state for later reference
      const stateDir = config.paths?.stateDir || "state";
      const record = await readJson(path.join(stateDir, "project_baseline.json"), {});
      record.tagName = tagName;
      record.sha = sha;
      record.repo = repo;
      record.capturedAt = new Date().toISOString();
      await writeJson(path.join(stateDir, "project_baseline.json"), record);
      return tagName;
    }

    warn(`[lifecycle] Failed to create baseline tag ${tagName}`);
    return null;
  } catch (err) {
    warn(`[lifecycle] capturePreWorkBaseline error: ${String(err?.message || err)}`);
    return null;
  }
}

// ── PROJECT COMPLETION ───────────────────────────────────────────────────────

/**
 * Collect a summary of all work BOX did on the project.
 * Used for the GitHub release body and the completion record.
 *
 * Return schema (all fields required):
 *   projectType        {string}   - from Prometheus analysis
 *   projectHealth      {string}   - from Prometheus analysis
 *   baselineTag        {string|null}
 *   baselineSha        {string|null}
 *   totalMergedPrs     {number}
 *   mergedPrs          {Array}    - [{ number, title, mergedAt, branch }]
 *   completedTasks     {string[]} - workerNames with recommendation==="proceed" postmortems
 *   workerOutcomes     {Array}    - [{ worker, prsDelivered, filesChanged, errors, successes }]
 *   completedAt        {string}   - ISO timestamp
 */
export async function collectWorkSummary(config) {
  const stateDir = config.paths?.stateDir || "state";
  const token = config.env?.githubToken;
  const repo = config.env?.targetRepo;

  const prometheusAnalysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
  const athenaPostmortems = await readJson(path.join(stateDir, "athena_postmortems.json"), []);
  const baseline = await readJson(path.join(stateDir, "project_baseline.json"), {});

  const projectType = prometheusAnalysis?.projectType || "unknown";
  const projectHealth = prometheusAnalysis?.projectHealth || "unknown";

  // Normalize postmortem records on read — supports both new schema
  // (recommendation field) and legacy schema (verdict field).
  // Records with neither field degrade explicitly; no silent pass-through.
  const completedTasks = Array.isArray(athenaPostmortems)
    ? athenaPostmortems
        .map(pm => {
          const normalized = normalizePostmortemVerdict(pm);
          if (normalized.reason !== POSTMORTEM_PARSE_REASON.OK) {
            warn(`[lifecycle] Postmortem for "${pm?.workerName || "unknown"}" skipped — ${normalized.reason}`);
          }
          return { pm, ...normalized };
        })
        .filter(({ pass }) => pass)
        .map(({ pm }) => pm.workerName)
    : [];

  // Collect merged PRs from GitHub
  const mergedPrs = [];
  if (token && repo) {
    const base = `https://api.github.com/repos/${repo}`;
    const baselineDate = baseline.capturedAt || null;

    // Fetch recently closed PRs that were merged
    const prsData = await ghGet(
      `${base}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      token
    );
    if (Array.isArray(prsData)) {
      for (const pr of prsData) {
        if (!pr.merged_at) continue;
        // Only include PRs merged after the baseline (if we have one)
        if (baselineDate && new Date(pr.merged_at) < new Date(baselineDate)) continue;
        // Only include BOX-created PRs (check for known branch prefixes)
        const head = pr.head?.ref || "";
        if (head.startsWith("box/") || head.startsWith("wave") || head.includes("regression") || head.includes("security") || head.includes("devops") || head.includes("qa")) {
          mergedPrs.push({
            number: pr.number,
            title: pr.title,
            mergedAt: pr.merged_at,
            branch: head
          });
        }
      }
    }
  }

  // Collect per-worker outcomes
  const workerOutcomes = [];
  const knownRoles = ["evolution-worker"];
  for (const role of knownRoles) {
    const slug = role.replace(/\s+/g, "-");
    const workerState = await readJson(path.join(stateDir, `worker_${slug}.json`), null);
    if (!workerState) continue;

    const logs = Array.isArray(workerState.activityLog) ? workerState.activityLog : [];
    const doneLogs = logs.filter(l => l.status === "done" && l.pr);
    const errorLogs = logs.filter(l => l.status === "error");

    if (doneLogs.length > 0 || errorLogs.length > 0) {
      workerOutcomes.push({
        worker: role,
        prsDelivered: doneLogs.map(l => l.pr).filter(Boolean),
        filesChanged: [...new Set(doneLogs.flatMap(l => l.files || []))],
        errors: errorLogs.length,
        successes: doneLogs.length
      });
    }
  }

  return {
    projectType,
    projectHealth,
    baselineTag: baseline.tagName || null,
    baselineSha: baseline.sha || null,
    totalMergedPrs: mergedPrs.length,
    mergedPrs,
    completedTasks,
    workerOutcomes,
    completedAt: new Date().toISOString()
  };
}

/**
 * Create a completion tag and GitHub release for the finished project.
 * Tag: `box/completed-YYYY-MM-DD`
 * Release: includes full summary of what BOX did.
 */
async function createCompletionRelease(config, summary) {
  const token = config.env?.githubToken;
  const repo = config.env?.targetRepo;
  if (!token || !repo) return null;

  const base = `https://api.github.com/repos/${repo}`;
  const tagName = `box/completed-${dateTag()}`;

  try {
    // Get current default branch HEAD
    const repoInfo: any = await ghGet(base, token);
    const defaultBranch = repoInfo?.default_branch || "main";
    const branchInfo: any = await ghGet(`${base}/branches/${encodeURIComponent(defaultBranch)}`, token);
    const sha = branchInfo?.commit?.sha;
    if (!sha) return null;

    // Create tag (idempotent check)
    const existing: any = await ghGet(`${base}/git/refs/tags/${encodeURIComponent(tagName)}`, token);
    if (!existing?.ref) {
      await ghPost(`${base}/git/refs`, token, {
        ref: `refs/tags/${tagName}`,
        sha
      });
    }

    // Build release body
    const prList = summary.mergedPrs
      .sort((a, b) => a.number - b.number)
      .map(pr => `- #${pr.number} — ${pr.title}`)
      .join("\n");

    const workerTable = summary.workerOutcomes
      .map(w => `| ${w.worker} | ${w.successes} | ${w.errors} | ${w.prsDelivered.length} |`)
      .join("\n");

    // Completed tasks are derived from Athena postmortems with recommendation==="proceed".
    // This is the canonical field (new schema) with legacy fallback (verdict==="pass").
    const completedTasksList = Array.isArray(summary.completedTasks) && summary.completedTasks.length > 0
      ? summary.completedTasks.map(name => `- ${name}`).join("\n")
      : "_No tasks recorded as completed by Athena_";

    const body = [
      `## BOX Automated Delivery — Project Complete`,
      ``,
      `**Project type:** ${summary.projectType}`,
      `**Baseline (before BOX):** \`${summary.baselineTag || "not captured"}\` → \`${summary.baselineSha?.slice(0, 7) || "n/a"}\``,
      `**Completion:** \`${tagName}\` → \`${sha.slice(0, 7)}\``,
      `**Total PRs merged:** ${summary.totalMergedPrs}`,
      `**Athena-verified completed tasks:** ${(summary.completedTasks || []).length}`,
      ``,
      `### Completed Tasks (Athena postmortem: recommendation=proceed)`,
      completedTasksList,
      ``,
      `### Merged Pull Requests`,
      prList || "_No BOX PRs detected_",
      ``,
      `### Worker Performance`,
      `| Worker | Successes | Errors | PRs |`,
      `|--------|-----------|--------|-----|`,
      workerTable || "| — | — | — | — |",
      ``,
      `### Rollback`,
      `To undo all BOX changes (safe, non-destructive):`,
      `\`\`\`bash`,
      `git revert --no-commit ${summary.baselineTag || "box/baseline-YYYY-MM-DD"}..HEAD`,
      `git commit -m "Revert all BOX changes"`,
      `\`\`\``,
    ].join("\n");

    // Create the GitHub release
    const release: any = await ghPost(`${base}/releases`, token, {
      tag_name: tagName,
      name: `BOX Delivery Complete — ${dateTag()}`,
      body,
      draft: false,
      prerelease: false
    });

    if (release?.html_url) {
      await appendProgress(config, `[LIFECYCLE] Release created: ${release.html_url}`);
      return { tagName, releaseUrl: release.html_url, sha };
    }

    return { tagName, sha };
  } catch (err) {
    warn(`[lifecycle] createCompletionRelease error: ${String(err?.message || err)}`);
    return null;
  }
}

/**
 * Record this project in the persistent completed_projects.json ledger.
 * This survives across daemon restarts and serves as BOX's delivery history.
 */
async function recordCompletedProject(config, summary, releaseInfo) {
  const stateDir = config.paths?.stateDir || "state";
  const repo = config.env?.targetRepo || "unknown";

  const ledger = await readJson(path.join(stateDir, "completed_projects.json"), []);

  ledger.push({
    repo,
    projectType: summary.projectType,
    baselineTag: summary.baselineTag,
    completionTag: releaseInfo?.tagName || `box/completed-${dateTag()}`,
    releaseUrl: releaseInfo?.releaseUrl || null,
    totalMergedPrs: summary.totalMergedPrs,
    mergedPrNumbers: summary.mergedPrs.map(p => p.number),
    workerSummary: summary.workerOutcomes.map(w => ({
      worker: w.worker,
      successes: w.successes,
      errors: w.errors
    })),
    completedAt: summary.completedAt
  });

  await writeJson(path.join(stateDir, "completed_projects.json"), ledger);
  await appendProgress(config, `[LIFECYCLE] Project recorded in completion ledger: ${repo} (${summary.totalMergedPrs} PRs)`);
}

/**
 * Delete all BOX-created branches that no longer have an open PR.
 * Handles squash merges correctly — doesn't rely on commit comparison.
 */
async function cleanupStaleBranches(config) {
  const token = config.env?.githubToken;
  const repo = config.env?.targetRepo;
  if (!token || !repo) return;

  const base = `https://api.github.com/repos/${repo}`;
  const branches: any = await ghGet(`${base}/branches?per_page=100`, token);
  if (!Array.isArray(branches)) return;

  // Collect branches still used by an open PR
  const openPrs: any = await ghGet(`${base}/pulls?state=open&per_page=100`, token) || [];
  const openPrBranches = new Set(openPrs.map(pr => pr.head?.ref).filter(Boolean));

  const boxPrefixes = ["box/", "wave", "pr-", "qa/", "scan/"];
  let deleted = 0;

  for (const branch of branches) {
    const name = branch.name;
    if (name === "main" || name === "master" || name === "develop") continue;
    if (!boxPrefixes.some(p => name.startsWith(p))) continue;
    if (openPrBranches.has(name)) continue;

    try {
      const res = await fetch(`${base}/git/refs/heads/${encodeURIComponent(name)}`, {
        method: "DELETE",
        headers: ghHeaders(token)
      });
      if (res.ok) {
        deleted++;
        await appendProgress(config, `[LIFECYCLE] Deleted stale branch: ${name}`);
      }
    } catch { /* non-fatal */ }
  }

  if (deleted > 0) {
    await appendProgress(config, `[LIFECYCLE] Cleaned up ${deleted} stale branches`);
  }
}

// ── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Full project completion sequence. Called by the orchestrator when all work is done.
 *
 * 1. Collect work summary (PRs, workers, outcomes)
 * 2. Clean up stale BOX branches
 * 3. Create completion tag + GitHub release
 * 4. Record in completed_projects.json
 */
export async function runProjectCompletion(config) {
  const repo = config.env?.targetRepo;
  if (!repo) {
    warn("[lifecycle] No target repo configured — skipping project completion");
    return undefined;
  }

  try {
    await appendProgress(config, "[LIFECYCLE] ── Project completion sequence starting ──");

    const summary = await collectWorkSummary(config);
    await cleanupStaleBranches(config);
    const releaseInfo = await createCompletionRelease(config, summary);
    await recordCompletedProject(config, summary, releaseInfo);

    await appendProgress(config, "[LIFECYCLE] ── Project completion sequence done ──");
    return summary;
  } catch (err) {
    warn(`[lifecycle] runProjectCompletion error: ${String(err?.message || err)}`);
    await appendProgress(config, `[LIFECYCLE] Completion sequence error (non-fatal): ${String(err?.message || err)}`);
    return null;
  }
}

/**
 * Check if the current target repo has already been completed.
 * Prevents double-completion on daemon restarts.
 */
export async function isProjectAlreadyCompleted(config) {
  const stateDir = config.paths?.stateDir || "state";
  const repo = config.env?.targetRepo;
  if (!repo) return false;

  const ledger = await readJson(path.join(stateDir, "completed_projects.json"), []);
  return ledger.some(entry => entry.repo === repo);
}
