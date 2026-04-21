/**
 * medic_agent.ts — BOX Medic: self-healing runtime repair agent.
 *
 * Activates ONLY on critical error signals (plans=0, agent crash, parser failure).
 * NO timeout triggers. NO speculative intervention.
 *
 * Flow:
 *   1. Receive error signal from orchestrator
 *   2. Diagnose root cause via logs + source
 *   3. Pause the broken lane (other lanes untouched)
 *   4. Invoke Copilot CLI medic agent to produce a patch
 *   5. Run npm test to verify
 *   6. If pass → resume checkpoint; if fail → halt system + log
 *   7. Audit every action to state/medic_audit_log.json
 *
 * Live log: state/live_worker_medic.log (streamed in real-time)
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readJson, writeJson } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs, nameToSlug } from "./agent_loader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export const MEDIC_TRIGGER = Object.freeze({
  PLANS_ZERO:      "plans_zero",
  AGENT_CRASH:     "agent_crash",
  PARSER_FAILURE:  "parser_failure",
  SYSTEM_ERROR:    "system_error",
});

export interface MedicSignal {
  trigger: string;
  source: string;
  message: string;
  context?: Record<string, unknown>;
  timestamp?: string;
}

export interface MedicResult {
  status: "fixed" | "failed" | "skipped";
  diagnosis: string;
  patchedFiles: string[];
  verifyPassed: boolean;
  durationMs: number;
  auditEntry: MedicAuditEntry;
}

export interface MedicAuditEntry {
  timestamp: string;
  trigger: string;
  source: string;
  diagnosis: string;
  patchedFiles: string[];
  verifyPassed: boolean;
  outcome: "fixed" | "failed" | "skipped";
  durationMs: number;
  systemHalted: boolean;
}

// ── Live log helpers ─────────────────────────────────────────────────────────

function liveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_worker_medic.log");
}

function appendLiveLogSync(stateDir: string, text: string): void {
  try {
    appendFileSync(liveLogPath(stateDir), String(text || ""), "utf8");
  } catch { /* best-effort */ }
}

function ts(): string {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

// ── Audit log ────────────────────────────────────────────────────────────────

const AUDIT_LOG_FILE = "medic_audit_log.json";
const MAX_AUDIT_ENTRIES = 200;

async function appendAuditEntry(stateDir: string, entry: MedicAuditEntry): Promise<void> {
  const filePath = path.join(stateDir, AUDIT_LOG_FILE);
  const existing: MedicAuditEntry[] = await readJson(filePath, []);
  existing.push(entry);
  // Keep bounded
  const trimmed = existing.length > MAX_AUDIT_ENTRIES
    ? existing.slice(existing.length - MAX_AUDIT_ENTRIES)
    : existing;
  await writeJson(filePath, trimmed);
}

// ── Lane pause/resume ────────────────────────────────────────────────────────

const PAUSED_LANES_FILE = "medic_paused_lanes.json";

export async function pauseLane(stateDir: string, lane: string, reason: string): Promise<void> {
  const filePath = path.join(stateDir, PAUSED_LANES_FILE);
  const paused: Record<string, { pausedAt: string; reason: string }> = await readJson(filePath, {});
  paused[lane] = { pausedAt: new Date().toISOString(), reason };
  await writeJson(filePath, paused);
}

export async function resumeLane(stateDir: string, lane: string): Promise<void> {
  const filePath = path.join(stateDir, PAUSED_LANES_FILE);
  const paused: Record<string, unknown> = await readJson(filePath, {});
  delete paused[lane];
  await writeJson(filePath, paused);
}

export async function isLanePaused(stateDir: string, lane: string): Promise<boolean> {
  const filePath = path.join(stateDir, PAUSED_LANES_FILE);
  const paused: Record<string, unknown> = await readJson(filePath, {});
  return lane in paused;
}

export async function getPausedLanes(stateDir: string): Promise<Record<string, { pausedAt: string; reason: string }>> {
  const filePath = path.join(stateDir, PAUSED_LANES_FILE);
  return readJson(filePath, {});
}

// ── Diagnosis: gather context for the medic prompt ───────────────────────────

async function gatherDiagnosticContext(config: any, signal: MedicSignal): Promise<string> {
  const stateDir = config.paths?.stateDir || "state";
  const parts: string[] = [];

  parts.push(`## Error Signal`);
  parts.push(`trigger: ${signal.trigger}`);
  parts.push(`source: ${signal.source}`);
  parts.push(`message: ${signal.message}`);
  parts.push(`timestamp: ${signal.timestamp || new Date().toISOString()}`);
  if (signal.context) {
    parts.push(`context: ${JSON.stringify(signal.context, null, 2)}`);
  }
  parts.push("");

  // Recent progress log (last 50 lines)
  try {
    const progressPath = path.join(stateDir, "progress.txt");
    const content = await fs.readFile(progressPath, "utf8");
    const lines = content.split("\n");
    const tail = lines.slice(Math.max(0, lines.length - 50)).join("\n");
    parts.push(`## Recent Progress (last 50 lines)\n${tail}\n`);
  } catch { /* file may not exist */ }

  // Relevant live log based on source
  const slug = nameToSlug(signal.source);
  if (slug) {
    try {
      const logPath = path.join(stateDir, `live_worker_${slug}.log`);
      const content = await fs.readFile(logPath, "utf8");
      const lines = content.split("\n");
      const tail = lines.slice(Math.max(0, lines.length - 80)).join("\n");
      parts.push(`## Live Log (${slug}, last 80 lines)\n${tail}\n`);
    } catch { /* file may not exist */ }
  }

  // Prometheus analysis state
  try {
    const analysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
    if (analysis) {
      parts.push(`## Prometheus Analysis State`);
      parts.push(`plans: ${Array.isArray(analysis.plans) ? analysis.plans.length : "N/A"}`);
      parts.push(`health: ${analysis.health || "unknown"}`);
      parts.push(`parserConfidence: ${analysis.parserConfidence ?? "N/A"}`);
      parts.push("");
    }
  } catch { /* non-critical */ }

  // Orchestrator health
  try {
    const health = await readJson(path.join(stateDir, "orchestrator_health.json"), null);
    if (health) {
      parts.push(`## Orchestrator Health\n${JSON.stringify(health, null, 2)}\n`);
    }
  } catch { /* non-critical */ }

  return parts.join("\n");
}

// ── Verification: run npm test ───────────────────────────────────────────────

function runVerification(repoRoot: string, timeoutMs = 60 * 60 * 1000): { passed: boolean; output: string } {
  try {
    const result = spawnSync("npm", ["test"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      timeout: timeoutMs,
      windowsHide: true,
    });
    const stdout = String(result.stdout || "");
    const stderr = String(result.stderr || "");
    const combined = `${stdout}\n${stderr}`;
    // npm test exit code 0 = pass
    const passed = result.status === 0;
    return { passed, output: combined.slice(-3000) }; // keep last 3KB
  } catch (err) {
    return { passed: false, output: String(err?.message || err).slice(0, 1000) };
  }
}

// ── Halt system ──────────────────────────────────────────────────────────────

async function haltSystem(config: any, reason: string): Promise<void> {
  const stateDir = config.paths?.stateDir || "state";
  await writeJson(path.join(stateDir, "daemon.stop.json"), {
    requestedAt: new Date().toISOString(),
    reason: `medic-halt: ${reason}`
  });
  await appendProgress(config, `[MEDIC] HALT — system stopped: ${reason}`);
}

// ── Parse medic agent output ─────────────────────────────────────────────────

interface MedicParsedOutput {
  status: "fixed" | "failed";
  diagnosis: string;
  patches: string[];
  verifyHint: string;
}

function parseMedicOutput(output: string): MedicParsedOutput {
  const statusMatch = output.match(/MEDIC_STATUS=(\w+)/);
  const diagnosisMatch = output.match(/MEDIC_DIAGNOSIS=(.+)/);
  const patchesMatch = output.match(/MEDIC_PATCHES=(.+)/);
  const verifyMatch = output.match(/MEDIC_VERIFY=(\w+)/);

  return {
    status: (statusMatch?.[1] === "fixed" ? "fixed" : "failed") as "fixed" | "failed",
    diagnosis: diagnosisMatch?.[1]?.trim() || "unknown",
    patches: patchesMatch?.[1]?.split(",").map(s => s.trim()).filter(Boolean) || [],
    verifyHint: verifyMatch?.[1]?.trim() || "unknown",
  };
}

// ── Main medic entry point ───────────────────────────────────────────────────

export async function runMedic(config: any, signal: MedicSignal): Promise<MedicResult> {
  const start = Date.now();
  const stateDir = config.paths?.stateDir || "state";
  const repoRoot = config.paths?.repoRoot || process.cwd();

  // Initialize live log
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(liveLogPath(stateDir),
    `[medic_live]\n[${ts()}] Medic activated — trigger=${signal.trigger} source=${signal.source}\n`,
    "utf8"
  );

  appendLiveLogSync(stateDir, `[${ts()}] Signal: ${signal.message}\n`);
  await appendProgress(config, `[MEDIC] Activated — trigger=${signal.trigger} source=${signal.source} message=${signal.message}`);

  // Determine affected lane from source
  const affectedLane = detectAffectedLane(signal);
  if (affectedLane) {
    await pauseLane(stateDir, affectedLane, `medic: ${signal.trigger}`);
    appendLiveLogSync(stateDir, `[${ts()}] Lane paused: ${affectedLane}\n`);
    await appendProgress(config, `[MEDIC] Lane paused: ${affectedLane}`);
  }

  // Gather diagnostic context
  appendLiveLogSync(stateDir, `[${ts()}] Gathering diagnostic context...\n`);
  const diagnosticContext = await gatherDiagnosticContext(config, signal);

  // Build medic prompt
  const medicPrompt = buildMedicPrompt(diagnosticContext, signal);

  // Invoke medic agent via Copilot CLI
  appendLiveLogSync(stateDir, `[${ts()}] Invoking Medic agent via Copilot CLI...\n`);
  let agentOutput: string;
  try {
    agentOutput = await invokeMedicAgent(config, medicPrompt, stateDir);
  } catch (err) {
    const errMsg = String(err?.message || err);
    appendLiveLogSync(stateDir, `[${ts()}] Medic agent invocation failed: ${errMsg}\n`);
    const failResult = buildFailResult(signal, `Agent invocation failed: ${errMsg}`, start, stateDir);
    await haltSystem(config, failResult.diagnosis);
    return failResult;
  }

  appendLiveLogSync(stateDir, `[${ts()}] Medic agent response received (${agentOutput.length} chars)\n`);

  // Parse output
  const parsed = parseMedicOutput(agentOutput);
  appendLiveLogSync(stateDir, `[${ts()}] Diagnosis: ${parsed.diagnosis}\n`);
  appendLiveLogSync(stateDir, `[${ts()}] Patches: ${parsed.patches.join(", ") || "none"}\n`);

  if (parsed.status === "failed" || parsed.patches.length === 0) {
    appendLiveLogSync(stateDir, `[${ts()}] Medic could not produce a fix — halting system\n`);
    const failResult = buildFailResult(signal, parsed.diagnosis || "No fix produced", start, stateDir);
    await recordAndHalt(config, stateDir, failResult);
    return failResult;
  }

  // Enforce max 2 patches
  if (parsed.patches.length > 2) {
    appendLiveLogSync(stateDir, `[${ts()}] Too many patches (${parsed.patches.length} > 2) — halting\n`);
    const failResult = buildFailResult(signal, `Patch count exceeded limit: ${parsed.patches.length}`, start, stateDir);
    await recordAndHalt(config, stateDir, failResult);
    return failResult;
  }

  // Run verification
  appendLiveLogSync(stateDir, `[${ts()}] Running verification (npm test)...\n`);
  await appendProgress(config, `[MEDIC] Running verification — patches: ${parsed.patches.join(", ")}`);
  const verify = runVerification(repoRoot, Number(config?.runtime?.verificationCommandTimeoutMs || 60 * 60 * 1000));
  appendLiveLogSync(stateDir, `[${ts()}] Verification result: ${verify.passed ? "PASS" : "FAIL"}\n`);

  if (!verify.passed) {
    appendLiveLogSync(stateDir, `[${ts()}] Verification FAILED — halting system\n`);
    appendLiveLogSync(stateDir, `[${ts()}] Test output (tail):\n${verify.output.slice(-500)}\n`);
    const failResult = buildFailResult(signal, `Fix verification failed: ${parsed.diagnosis}`, start, stateDir, parsed.patches);
    await recordAndHalt(config, stateDir, failResult);
    return failResult;
  }

  // Success: resume lane
  appendLiveLogSync(stateDir, `[${ts()}] Verification PASSED — resuming lane\n`);
  if (affectedLane) {
    await resumeLane(stateDir, affectedLane);
    appendLiveLogSync(stateDir, `[${ts()}] Lane resumed: ${affectedLane}\n`);
    await appendProgress(config, `[MEDIC] Lane resumed: ${affectedLane}`);
  }

  const durationMs = Date.now() - start;
  const auditEntry: MedicAuditEntry = {
    timestamp: new Date().toISOString(),
    trigger: signal.trigger,
    source: signal.source,
    diagnosis: parsed.diagnosis,
    patchedFiles: parsed.patches,
    verifyPassed: true,
    outcome: "fixed",
    durationMs,
    systemHalted: false,
  };

  await appendAuditEntry(stateDir, auditEntry);
  await appendProgress(config, `[MEDIC] Fix verified — diagnosis="${parsed.diagnosis}" patches=${parsed.patches.join(",")}`);
  appendLiveLogSync(stateDir, `[${ts()}] Medic intervention complete — FIXED (${durationMs}ms)\n`);

  return {
    status: "fixed",
    diagnosis: parsed.diagnosis,
    patchedFiles: parsed.patches,
    verifyPassed: true,
    durationMs,
    auditEntry,
  };
}

// ── Detect affected lane from signal ─────────────────────────────────────────

function detectAffectedLane(signal: MedicSignal): string | null {
  const source = String(signal.source || "").toLowerCase();
  if (source.includes("prometheus")) return "planning";
  if (source.includes("athena")) return "review";
  if (source.includes("janus")) return "supervision";
  if (source.includes("evolution")) return "implementation";
  if (source.includes("quality")) return "quality";
  if (source.includes("governance")) return "governance";
  if (source.includes("infrastructure")) return "infrastructure";
  if (source.includes("integration")) return "integration";
  if (source.includes("observation")) return "observation";
  return null;
}

// ── Build medic prompt ───────────────────────────────────────────────────────

function buildMedicPrompt(diagnosticContext: string, signal: MedicSignal): string {
  return `You are the MEDIC agent for BOX — an autonomous self-healing repair agent.

A critical error has occurred and you must diagnose and fix it.

## Error Signal
- Trigger: ${signal.trigger}
- Source: ${signal.source}
- Message: ${signal.message}

## Rules
- Produce at most 1-2 file patches
- Each patch must be the minimal fix for the root cause
- After fixing, the system must pass npm test
- Do NOT refactor, add features, or change unrelated code
- Do NOT add timeout handling — this is explicitly forbidden

## Diagnostic Context
${diagnosticContext}

## Your Task
1. Read the relevant source files to understand the failure
2. Identify the exact root cause
3. Make the minimal fix (edit 1-2 files maximum)
4. Report your findings in this exact format at the end:

MEDIC_STATUS=fixed (or MEDIC_STATUS=failed if you cannot fix it)
MEDIC_DIAGNOSIS=<one sentence describing root cause>
MEDIC_PATCHES=<comma-separated list of files you edited>
MEDIC_VERIFY=pass`;
}

// ── Invoke medic via Copilot CLI ─────────────────────────────────────────────

async function invokeMedicAgent(config: any, prompt: string, stateDir: string): Promise<string> {
  const registry = config.roleRegistry || {};
  const medicConfig = registry.medic || {};
  const model = medicConfig.model || "Claude Sonnet 4.6";

  const args = buildAgentArgs({
    agentSlug: "medic",
    prompt,
    model,
    allowAll: true,
    noAskUser: true,
    silent: true,
  });

  const copilotCmd = process.platform === "win32" ? "copilot" : "copilot";
  appendLiveLogSync(stateDir, `[${ts()}] CLI: ${copilotCmd} ${args.slice(0, 3).join(" ")} ... (prompt ${prompt.length} chars)\n`);

  const result = spawnSync(copilotCmd, args, {
    cwd: config.paths?.repoRoot || process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
    windowsHide: true,
    env: {
      ...process.env,
      GH_TOKEN: process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "",
      GITHUB_TOKEN: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
      TARGET_REPO: config.github?.repo || "Ancora-Labs/Box",
    },
  });

  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");

  // Stream to live log
  if (stdout) appendLiveLogSync(stateDir, stdout);
  if (stderr) appendLiveLogSync(stateDir, `[stderr] ${stderr}\n`);
  appendLiveLogSync(stateDir, `[${ts()}] CLI exit=${result.status}\n`);

  if (result.status !== 0 && !stdout.includes("MEDIC_STATUS")) {
    throw new Error(`Copilot CLI failed (exit=${result.status}): ${stderr.slice(0, 500)}`);
  }

  return stdout;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildFailResult(
  signal: MedicSignal,
  diagnosis: string,
  startTime: number,
  stateDir: string,
  patches: string[] = []
): MedicResult {
  const durationMs = Date.now() - startTime;
  const auditEntry: MedicAuditEntry = {
    timestamp: new Date().toISOString(),
    trigger: signal.trigger,
    source: signal.source,
    diagnosis,
    patchedFiles: patches,
    verifyPassed: false,
    outcome: "failed",
    durationMs,
    systemHalted: true,
  };
  return {
    status: "failed",
    diagnosis,
    patchedFiles: patches,
    verifyPassed: false,
    durationMs,
    auditEntry,
  };
}

async function recordAndHalt(config: any, stateDir: string, result: MedicResult): Promise<void> {
  await appendAuditEntry(stateDir, result.auditEntry);
  await appendProgress(config, `[MEDIC] FAILED — diagnosis="${result.diagnosis}" — halting system`);
  await haltSystem(config, result.diagnosis);
}

// ── Quick check: should medic intervene? ─────────────────────────────────────
// Called by orchestrator to decide whether to invoke medic before returning.

export function shouldTriggerMedic(signal: {
  plansCount?: number;
  error?: Error | string | null;
  parserFailed?: boolean;
}): MedicSignal | null {
  // plans=0 is a critical signal
  if (signal.plansCount === 0) {
    return {
      trigger: MEDIC_TRIGGER.PLANS_ZERO,
      source: "Prometheus",
      message: "Prometheus produced 0 plans — parser or model output failure",
      timestamp: new Date().toISOString(),
    };
  }

  // System error / agent crash
  if (signal.error) {
    const msg = typeof signal.error === "string" ? signal.error : signal.error.message;
    return {
      trigger: MEDIC_TRIGGER.SYSTEM_ERROR,
      source: "orchestrator",
      message: `System error: ${msg}`,
      timestamp: new Date().toISOString(),
    };
  }

  // Parser failure
  if (signal.parserFailed) {
    return {
      trigger: MEDIC_TRIGGER.PARSER_FAILURE,
      source: "Prometheus",
      message: "Parser returned empty/invalid output",
      timestamp: new Date().toISOString(),
    };
  }

  return null;
}

