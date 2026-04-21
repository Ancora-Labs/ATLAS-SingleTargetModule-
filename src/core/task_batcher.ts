/**
 * Task Batcher — Token-Budget-Based Task Packing
 *
 * Instead of dispatching one worker per task (N workers = N premium requests),
 * this module estimates token usage per plan and packs multiple plans into
 * minimal batches that fit within the worker's context window.
 *
 * Goal: minimize premium request count by sending as many tasks as possible
 * to a single worker call. Within one Copilot CLI session, all tool calls
 * (file edits, terminal commands, etc.) are FREE — only the session itself
 * costs 1 premium request.
 */

// Rough approximation: 1 token ≈ 4 characters for mixed English/code text.
const CHARS_PER_TOKEN = 4;

// Fixed overhead tokens for conversation context, persona, instructions, history, etc.
const OVERHEAD_TOKENS = 4000;

/**
 * Estimate token count for a single plan based on its text fields.
 * @param {{ task?: string, context?: string, verification?: string }} plan
 * @returns {number} estimated tokens
 */
export function estimateTokens(plan) {
  const text = [
    String(plan.task || ""),
    String(plan.context || ""),
    String(plan.verification || "")
  ].join("\n");
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate total token count for an array of plans.
 * Re-exported from worker_batch_planner — that module is the canonical batching
 * implementation and uses the richer per-plan estimator (includes overhead,
 * file-read cost, risk multiplier, and reasoning overhead).
 */
export { estimateBatchTokens } from "./worker_batch_planner.js";

/**
 * Pack plans into the fewest possible batches that each fit within the token limit.
 *
 * Plans are packed in order (preserving dependency ordering from Prometheus).
 * A new batch is started only when the next plan would exceed the remaining budget.
 *
 * @param {Array} plans - Prometheus plan objects
 * @param {number} maxTokensPerBatch - total context window budget per worker call
 * @returns {Array<Array>} array of batches, each batch is an array of plans
 */
export function packPlansIntoBatches(plans, maxTokensPerBatch) {
  if (!plans || plans.length === 0) return [];

  const available = maxTokensPerBatch - OVERHEAD_TOKENS;
  if (available <= 0) {
    // Budget too small for even overhead — each plan gets its own batch
    return plans.map(p => [p]);
  }

  const batches = [];
  let currentBatch = [];
  let currentTokens = 0;

  for (const plan of plans) {
    const tokens = estimateTokens(plan);

    if (currentBatch.length > 0 && currentTokens + tokens > available) {
      batches.push(currentBatch);
      currentBatch = [plan];
      currentTokens = tokens;
    } else {
      currentBatch.push(plan);
      currentTokens += tokens;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

/**
 * Build a single combined instruction object from a batch of plans.
 *
 * The worker receives one numbered task list and must complete ALL tasks
 * sequentially within a single session (1 premium request).
 *
 * @param {Array} plans - plans in this batch
 * @returns {{ task: string, context: string, verification: string, taskKind: string }}
 */
export function buildBatchInstruction(plans) {
  if (plans.length === 1) {
    // Single plan — no batch wrapping needed, pass through directly
    const plan = plans[0];
    return {
      task: String(plan.task || ""),
      context: String(plan.context || ""),
      verification: String(plan.verification || ""),
      taskKind: plan.taskKind || plan.kind || "implementation"
    };
  }

  const parts = [];
  parts.push(`You have ${plans.length} tasks to complete in this single session.`);
  parts.push("Complete ALL tasks sequentially. Each task must be fully implemented before moving to the next.");
  parts.push("For each task, follow the verification criteria specified.\n");

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    parts.push(`━━━ TASK ${i + 1} of ${plans.length} ━━━`);
    parts.push(String(plan.task || ""));
    if (plan.context) parts.push(`Context: ${String(plan.context)}`);
    if (plan.verification) parts.push(`Verification: ${String(plan.verification)}`);
    parts.push("");
  }

  parts.push("━━━ BATCH COMPLETION RULES ━━━");
  parts.push("1. Implement ALL tasks above — do not skip any.");
  parts.push("2. If a task is blocked, implement the rest and report which task(s) were blocked.");
  parts.push("3. Create a single PR covering all changes, or update your existing PR.");
  parts.push("4. Run build + tests ONCE after all tasks are implemented.");
  parts.push("5. Report BOX_STATUS=done only if ALL tasks succeeded.");
  parts.push("6. If some tasks succeeded and some failed, report BOX_STATUS=partial.");

  return {
    task: parts.join("\n"),
    context: `Batch of ${plans.length} tasks packed into a single worker session`,
    verification: plans.map(p => String(p.verification || "")).filter(Boolean).join("; "),
    taskKind: "implementation"
  };
}

/**
 * Build a combined plan object for Athena postmortem from a batch of plans.
 * @param {Array} plans
 * @returns {object} combined plan
 */
export function buildCombinedPlan(plans) {
  if (plans.length === 1) return plans[0];

  return {
    task: plans.map((p, i) => `[Task ${i + 1}] ${String(p.task || "")}`).join("\n"),
    context: plans.map(p => String(p.context || "")).filter(Boolean).join("\n"),
    verification: plans.map(p => String(p.verification || "")).filter(Boolean).join("; "),
    role: plans[0]?.role || "evolution-worker",
    taskKind: "implementation",
    _batchSize: plans.length
  };
}
