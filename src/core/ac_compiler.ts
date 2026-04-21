/**
 * ac_compiler.js — Acceptance Criteria Measurability Compiler.
 *
 * Converts vague task descriptions into measurable, verifiable acceptance criteria.
 * This is a deterministic heuristic (no AI call) that augments plans that lack
 * concrete verification steps.
 *
 * Integration: called by Prometheus normalizer to enrich plans before Athena review.
 */

/**
 * Known verification patterns by task kind.
 * These are used as templates when a plan lacks specific verification.
 */
const AC_TEMPLATES = Object.freeze({
  implementation: [
    "npm test passes with no new failures",
    "npm run lint passes with no new errors",
    "Changed files are covered by at least one test assertion",
  ],
  refactor: [
    "npm test produces identical pass count before and after",
    "npm run lint passes",
    "No new exports removed without migration",
  ],
  test: [
    "New test file exists under tests/",
    "npm test includes the new test suite in output",
    "At least one assertion per exported function",
  ],
  bugfix: [
    "Regression test added that reproduces the original bug",
    "npm test passes including the regression test",
    "npm run lint passes",
  ],
  documentation: [
    "Target .md file updated with new content",
    "No broken internal links",
  ],
  governance: [
    "Policy file updated with new rule",
    "Existing tests still pass (npm test)",
  ],
  infrastructure: [
    "Configuration change applied",
    "npm test and npm run lint pass",
    "No runtime errors on startup",
  ],
});

function inferTaskKind(plan) {
  const explicitKind = String(plan?.taskKind || plan?.kind || "").trim().toLowerCase();
  if (explicitKind) return explicitKind;

  const task = String(plan?.task || "").toLowerCase();
  if (/\b(test|tests|assertion|coverage|regression|replay corpus)\b/.test(task)) return "test";
  if (/\b(fix|bug|failure|error|reject)\b/.test(task)) return "bugfix";
  if (/\b(refactor|consolidat|cleanup|deduplicat)\b/.test(task)) return "refactor";
  if (/\b(readme|docs|documentation)\b/.test(task)) return "documentation";
  if (/\b(governance|policy|contract)\b/.test(task)) return "governance";
  if (/\b(docker|pipeline|scheduler|routing|infrastructure|worker lane)\b/.test(task)) return "infrastructure";
  return "implementation";
}

function getTargetFiles(plan) {
  const direct = Array.isArray(plan?.target_files)
    ? plan.target_files
    : Array.isArray(plan?.targetFiles)
      ? plan.targetFiles
      : [];
  return direct.map(value => String(value || "").trim()).filter(Boolean);
}

function buildNamedExpectation(task) {
  const cleaned = String(task || "")
    .replace(/^(add|introduce|enforce|convert|fix|create|implement)\s+/i, "")
    .replace(/\b(integration|end-to-end|deterministic|critical-path)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > 0 ? cleaned : String(task || "implementation behavior").trim();
}

function dedupeCriteria(criteria) {
  const seen = new Set();
  const result = [];
  for (const criterion of criteria) {
    const text = String(criterion || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

/**
 * @typedef {object} CompiledAC
 * @property {string[]} criteria — measurable acceptance criteria
 * @property {string} verification — combined verification command string
 * @property {boolean} wasEnriched — true if the compiler added criteria
 */

/**
 * Compile measurable acceptance criteria for a plan.
 *
 * If the plan already has strong criteria, returns them as-is.
 * Otherwise, infers criteria from the task kind and task text.
 *
 * @param {object} plan — plan object with task, taskKind, verification fields
 * @returns {CompiledAC}
 */
export function compileAcceptanceCriteria(plan) {
  if (!plan || typeof plan !== "object") {
    return { criteria: [], verification: "", wasEnriched: false };
  }

  const existing = String(plan.verification || "").trim();
  const existingCriteria = Array.isArray(plan.acceptance_criteria)
    ? plan.acceptance_criteria.map(value => String(value || "").trim()).filter(Boolean)
    : Array.isArray(plan.acceptanceCriteria)
      ? plan.acceptanceCriteria.map(value => String(value || "").trim()).filter(Boolean)
      : [];
  const taskKind = inferTaskKind(plan);
  const task = String(plan.task || "").trim();
  const targetFiles = getTargetFiles(plan);
  const primaryTarget = targetFiles[0] || "changed file";
  const namedExpectation = buildNamedExpectation(task);

  if (existingCriteria.length >= 2 && existing.length > 20) {
    return {
      criteria: existingCriteria,
      verification: existing,
      wasEnriched: false
    };
  }

  const template = AC_TEMPLATES[taskKind] || AC_TEMPLATES.implementation;
  const criteria = [...existingCriteria, ...template];

  if (taskKind === "test") {
    criteria.push(`Test file ${primaryTarget} exists and is executed by the test runner`);
    criteria.push(`Test output includes a named assertion for "${namedExpectation}"`);
  }

  if (/new\s+(file|module|function)/i.test(task)) {
    criteria.push("New file/module exists at expected path");
  }
  if (/fix|bug|error|fail/i.test(task)) {
    criteria.push("Root cause addressed; regression test confirms fix");
  }
  if (/import|export|api/i.test(task)) {
    criteria.push("Public API unchanged or backward-compatible");
  }
  if (/packet contract|contract completeness/i.test(task)) {
    criteria.push("Rejected planner payloads are blocked when task, role, wave, verification, or acceptance_criteria are missing");
    criteria.push("Contract validation reports the exact missing required field names");
  }
  if (/critical-path scheduling|dependency-aware waves/i.test(task)) {
    criteria.push("Scheduler computes dependency-aware wave ordering without violating existing wave constraints");
    criteria.push("Critical-path ordering reduces serialized waiting for dependent tasks in the targeted scheduler path");
  }
  if (/uncertainty-aware model routing|roi feedback loop|model routing/i.test(task)) {
    criteria.push("Routing contract defines an uncertainty signal schema before model selection runs");
    criteria.push("ROI formula is explicit and influences model routing decisions deterministically");
  }
  if (/postmortem deltas|actionable packets/i.test(task)) {
    criteria.push("Generated packets include task, scope, target_files, and acceptance_criteria fields");
    criteria.push("Packet generation is deterministic for the same postmortem delta input");
  }

  const finalCriteria = dedupeCriteria(criteria).slice(0, 6);

  let verification = existing;
  if (!verification) {
    if (taskKind === "test" && primaryTarget !== "changed file") {
      verification = `node --test ${primaryTarget}`;
    } else {
      verification = "npm test";
    }
  }
  if (!/npm|node|test|assert/i.test(verification)) {
    verification = `${verification}\nnpm test`;
  }

  const combined = verification;

  return {
    criteria: finalCriteria,
    verification: combined,
    wasEnriched: finalCriteria.length !== existingCriteria.length || combined !== existing
  };
}

/**
 * Enrich an array of plans with compiled acceptance criteria.
 * Plans that already have strong verification are left unchanged.
 *
 * @param {object[]} plans
 * @returns {{ plans: object[], enrichedCount: number }}
 */
export function enrichPlansWithAC(plans) {
  if (!Array.isArray(plans)) return { plans: [], enrichedCount: 0 };

  let enrichedCount = 0;
  const enriched = plans.map(plan => {
    const compiled = compileAcceptanceCriteria(plan);
    if (compiled.wasEnriched) {
      enrichedCount++;
      return {
        ...plan,
        acceptance_criteria: compiled.criteria,
        verification: compiled.verification,
        _acCompiled: true
      };
    }
    if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.length === 0) {
      return {
        ...plan,
        acceptance_criteria: compiled.criteria,
      };
    }
    return plan;
  });

  return { plans: enriched, enrichedCount };
}
