/**
 * Worker entry point — containerised task runner.
 *
 * This file is the CMD target for docker/worker/Dockerfile and the
 * target for the `worker:run` npm script.  It is intentionally thin:
 * real task execution happens inside the Copilot CLI agent process
 * that the orchestrator spawns via src/core/worker_runner.js.
 *
 * When BOX runs in container-worker mode the orchestrator launches a
 * worker container and passes the task payload via environment
 * variables.  This entry point validates those variables, prints
 * diagnostics, then delegates to the CLI (src/cli.ts once) so the
 * full orchestrator boot-path is exercised correctly.
 *
 * Required environment variables:
 *   WORKER_ROLE      — role slug the worker should act as (e.g. "noah")
 *   TASK_PAYLOAD     — JSON-stringified task object
 *   TARGET_REPO      — GitHub repo in owner/name format
 *   GITHUB_TOKEN     — PAT with repo + PR permissions
 *
 * Optional:
 *   BOX_LOG_LEVEL    — "debug" | "info" | "warn" | "error" (default: "info")
 *
 * Contract health gate:
 *   After validation this module emits a WORKER_CONTRACT_HEALTH= line to stdout
 *   (on success) or stderr (on failure). The line is machine-parseable and acts
 *   as a first-class runtime gate: downstream systems can inspect the line to
 *   verify all contract slots before allowing the worker to proceed.
 *
 *   Format:  WORKER_CONTRACT_HEALTH=env_vars:<pass|fail|n/a>;payload:<pass|fail|n/a>;role:<pass|fail|n/a>
 *   Success: WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass
 *   Failure: WORKER_CONTRACT_HEALTH=env_vars:fail;payload:n/a;role:n/a  (emitted to stderr)
 *
 * Exports: see src/workers/contract_health.ts for types and parsers.
 */

import process from "node:process";
import { formatContractHealth, formatStartupContractAnchor } from "./contract_health.js";

const REQUIRED_VARS = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];

function main(): void {
  // ── Step 1: environment-variable contract ────────────────────────────────
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    process.stderr.write(
      `[run_task] ERROR: Missing required environment variable(s): ${missing.join(", ")}\n` +
      `[run_task] Set these variables and re-run the container.\n`
    );
    // Emit contract health evidence to stderr so the runtime gate can observe it
    process.stderr.write(formatContractHealth({ env_vars: "fail", payload: "n/a", role: "n/a" }) + "\n");
    process.exit(1);
  }

  const role = process.env.WORKER_ROLE as string;
  const repo = process.env.TARGET_REPO as string;

  process.stdout.write(
    `[run_task] Worker container started — role=${role} repo=${repo}\n`
  );

  // ── Step 2: TASK_PAYLOAD JSON contract ───────────────────────────────────
  let task;
  try {
    task = JSON.parse(process.env.TASK_PAYLOAD as string);
  } catch {
    process.stderr.write(
      "[run_task] ERROR: TASK_PAYLOAD is not valid JSON.\n"
    );
    // Emit partial health: env_vars passed, payload failed
    process.stderr.write(formatContractHealth({ env_vars: "pass", payload: "fail", role: "n/a" }) + "\n");
    process.exit(1);
  }

  process.stdout.write(
    `[run_task] Task received — id=${task.id ?? "(none)"} kind=${task.kind ?? "(none)"}\n`
  );

  // ── Step 3: role presence contract ──────────────────────────────────────
  // WORKER_ROLE was already confirmed non-empty by REQUIRED_VARS check.
  // Emit the full-pass health line to stdout as a first-class runtime gate signal.
  process.stdout.write(formatContractHealth({ env_vars: "pass", payload: "pass", role: "pass" }) + "\n");
  // Emit the named startup-contract verification anchor immediately after the
  // health line.  This anchor unambiguously marks that all contract checks
  // completed in THIS startup cycle — downstream gates use it to distinguish
  // a fresh verification from a carry-forward health line in stale logs.
  process.stdout.write(formatStartupContractAnchor() + "\n");

  // Container workers are currently invoked by the orchestrator via
  // src/core/worker_runner.js which calls the Copilot CLI directly.
  // This entry point provides the coherent contract (env → validate →
  // log) required for a stable Docker CMD target.
  //
  // To extend with a full autonomous run cycle, import and call
  // runWorkerConversation() from src/core/worker_runner.js here.
  process.stdout.write("[run_task] Worker ready. Awaiting task dispatch.\n");
}

main();
