import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig } from "../src/config.js";
import { buildAgentArgs, parseAgentOutput } from "../src/core/agent_loader.js";
import { spawnAsync, readJson } from "../src/core/fs_utils.js";

type GuardOptions = {
  hours: number;
  intervalMinutes: number;
  maxPremiumRequests: number;
  maxCycles: number;
  autoFix: boolean;
  stopWhenDone: boolean;
  aiModel: string;
};

type GuardState = {
  baselineLineCount: number;
  processedLineCount: number;
  baselinePremiumCount: number;
  premiumSpent: number;
  cyclesSeen: number;
  checksRun: number;
};

const DEFAULTS: GuardOptions = {
  hours: 6,
  intervalMinutes: 30,
  maxPremiumRequests: 45,
  maxCycles: 5,
  autoFix: true,
  stopWhenDone: true,
  aiModel: "gpt-5.3-codex",
};

const PROGRESS_FILE = path.join("state", "progress.txt");
const STOP_FILE = path.join("state", "daemon.stop.json");
const LOG_FILE = path.join("state", "overnight_guard.log");
const PREMIUM_LOG_FILE = path.join("state", "premium_usage_log.json");

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): GuardOptions {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--hours" && next) {
      options.hours = Math.max(1, Number(next) || DEFAULTS.hours);
      i++;
      continue;
    }
    if ((arg === "--interval" || arg === "--interval-minutes") && next) {
      options.intervalMinutes = Math.max(1, Number(next) || DEFAULTS.intervalMinutes);
      i++;
      continue;
    }
    if ((arg === "--max-premium" || arg === "--max-premium-requests") && next) {
      options.maxPremiumRequests = Math.max(1, Number(next) || DEFAULTS.maxPremiumRequests);
      i++;
      continue;
    }
    if (arg === "--max-cycles" && next) {
      options.maxCycles = Math.max(1, Number(next) || DEFAULTS.maxCycles);
      i++;
      continue;
    }
    if (arg === "--no-auto-fix") {
      options.autoFix = false;
      continue;
    }
    if (arg === "--no-stop") {
      options.stopWhenDone = false;
      continue;
    }
    if (arg === "--ai-model" && next) {
      options.aiModel = String(next).trim() || DEFAULTS.aiModel;
      i++;
      continue;
    }
  }
  return options;
}

async function appendGuardLog(message: string): Promise<void> {
  const line = `[${nowIso()}] ${message}\n`;
  process.stdout.write(line);
  await fs.appendFile(LOG_FILE, line, "utf8");
}

async function runBoxCli(command: "on" | "off" | "stop" | "resume", timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", ["--import", "tsx", "src/cli.ts", command], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let out = "";
    child.stdout.on("data", (d) => {
      out += String(d || "");
    });
    child.stderr.on("data", (d) => {
      out += String(d || "");
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Best effort.
      }
      resolve({ ok: false, output: `${out}\n[guard] timed out running box ${command}`.trim() });
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, output: out.trim() });
    });
  });
}

async function readProgressLines(): Promise<string[]> {
  const raw = await fs.readFile(PROGRESS_FILE, "utf8");
  return raw.split(/\r?\n/).filter(Boolean);
}

async function readPremiumUsageCount(): Promise<number> {
  const list = await readJson(PREMIUM_LOG_FILE, []);
  return Array.isArray(list) ? list.length : 0;
}

function countMatches(lines: string[], pattern: RegExp): number {
  return lines.reduce((acc, line) => acc + (pattern.test(line) ? 1 : 0), 0);
}

function detectIssues(lines: string[], staleMinutes: number, lastWriteMs: number): string[] {
  const issues: string[] = [];
  const staleMs = staleMinutes * 60_000;
  if (Date.now() - lastWriteMs > staleMs) {
    issues.push(`progress_stale>${staleMinutes}m`);
  }

  const criticalPatterns: Array<{ name: string; re: RegExp }> = [
    { name: "trust_boundary_block", re: /\[PROMETHEUS\]\[TRUST_BOUNDARY\].*Blocking analysis/i },
    { name: "no_plans", re: /Prometheus produced no plans/i },
    { name: "worker_blocked", re: /Worker batch .* status=blocked/i },
  ];

  for (const p of criticalPatterns) {
    if (lines.some((line) => p.re.test(line))) {
      issues.push(p.name);
    }
  }

  return issues;
}

async function ensureNoStopFile(): Promise<void> {
  try {
    await fs.rm(STOP_FILE, { force: true });
  } catch {
    // Best effort.
  }
}

async function autoRemediate(issues: string[]): Promise<void> {
  await appendGuardLog(`[AUTOFIX] issues=${issues.join(",")}`);
  await ensureNoStopFile();

  const resume = await runBoxCli("resume", 180_000);
  await appendGuardLog(`[AUTOFIX] resume ok=${resume.ok} output=${JSON.stringify(resume.output.slice(0, 240))}`);
  if (resume.ok) return;

  const on = await runBoxCli("on", 180_000);
  await appendGuardLog(`[AUTOFIX] on ok=${on.ok} output=${JSON.stringify(on.output.slice(0, 240))}`);
}

async function getProgressMtimeMs(): Promise<number> {
  const stat = await fs.stat(PROGRESS_FILE);
  return stat.mtimeMs;
}

async function invokeAiSupervisor(
  command: string,
  options: GuardOptions,
  state: GuardState,
  deltaLines: string[],
  deterministicIssues: string[]
): Promise<{ healthy: boolean; issues: string[]; actions: Array<"resume" | "on" | "stop" | "none">; summary: string }> {
  const contextTail = deltaLines.slice(-180).join("\n");
  const prompt = `You are overnight runtime guard for BOX.
Analyze current runtime health from progress tail and counters.
Respond with JSON ONLY wrapped in ===DECISION=== and ===END===.

Current counters:
- premiumSpent=${state.premiumSpent}
- premiumLimit=${options.maxPremiumRequests}
- cyclesSeen=${state.cyclesSeen}
- cycleLimit=${options.maxCycles}
- deterministicIssues=${deterministicIssues.join(",") || "none"}

Progress tail:
${contextTail || "(empty)"}

Return JSON schema:
{
  "healthy": true|false,
  "issues": ["..."],
  "actions": ["resume"|"on"|"stop"|"none"],
  "summary": "short"
}

Rules:
- If blocked/stalled/no-plans/trust-boundary-block seen: healthy=false.
- Prefer action "resume" first, then "on" if needed.
- Use "stop" only if limits exceeded or unrecoverable.
- Keep actions minimal and deterministic.
`;

  try {
    const args = buildAgentArgs({
      prompt,
      model: options.aiModel,
      allowAll: true,
      noAskUser: true,
    });
    const result = await spawnAsync(command, args, { env: process.env, timeoutMs: 8 * 60_000 });
    const raw = String((result as any)?.stdout || (result as any)?.stderr || "");
    const parsed = parseAgentOutput(raw);
    const data: any = parsed?.parsed || {};

    const healthy = Boolean(data.healthy);
    const issues = Array.isArray(data.issues) ? data.issues.map((x: unknown) => String(x)) : [];
    const summary = String(data.summary || "no summary");
    const allowed = new Set(["resume", "on", "stop", "none"]);
    const actions = Array.isArray(data.actions)
      ? data.actions.map((x: unknown) => String(x)).filter((x: string) => allowed.has(x)) as Array<"resume" | "on" | "stop" | "none">
      : [];

    if (!healthy && actions.length === 0) {
      return { healthy, issues: issues.length > 0 ? issues : ["ai_unhealthy_without_actions"], actions: ["resume"], summary };
    }
    return { healthy, issues, actions: actions.length > 0 ? actions : ["none"], summary };
  } catch (error) {
    await appendGuardLog(`[AI] supervisor_call_failed=${String((error as Error)?.message || error)}`);
    return {
      healthy: deterministicIssues.length === 0,
      issues: deterministicIssues,
      actions: deterministicIssues.length > 0 ? ["resume"] : ["none"],
      summary: "ai_failed_fallback_to_deterministic",
    };
  }
}

async function refreshAndDetect(state: GuardState, options: GuardOptions): Promise<{
  allLines: string[];
  deltaLines: string[];
  newLines: string[];
  issues: string[];
  mtimeMs: number;
}> {
  const allLines = await readProgressLines();
  const deltaLines = allLines.slice(state.baselineLineCount);
  const newLines = allLines.slice(state.processedLineCount);
  const mtimeMs = await getProgressMtimeMs();
  const issues = detectIssues(newLines, Math.max(options.intervalMinutes + 10, 25), mtimeMs);

  const premiumCount = await readPremiumUsageCount();
  state.premiumSpent = Math.max(0, premiumCount - state.baselinePremiumCount);
  state.cyclesSeen = countMatches(deltaLines, /\[CYCLE START\]/i);
  state.processedLineCount = allLines.length;

  return { allLines, deltaLines, newLines, issues, mtimeMs };
}

async function remediateUntilStable(
  command: string,
  state: GuardState,
  options: GuardOptions,
  endMs: number,
  initialIssues: string[]
): Promise<void> {
  let safety = 0;
  let pendingIssues = [...initialIssues];
  for (;;) {
    safety += 1;
    const snapshot = await refreshAndDetect(state, options);
    const ai = await invokeAiSupervisor(command, options, state, snapshot.deltaLines, snapshot.issues);
    const unresolved = Array.from(new Set([...pendingIssues, ...snapshot.issues, ...(ai.healthy ? [] : ai.issues)]));
    if (unresolved.length === 0 && ai.healthy) {
      await appendGuardLog(`[AUTOFIX] stable after ${safety - 1} remediation attempt(s)`);
      return;
    }

    await appendGuardLog(`[AI] healthy=${ai.healthy} summary=${ai.summary} actions=${ai.actions.join(",")}`);
    await appendGuardLog(`[AUTOFIX] unresolved issues=${unresolved.join(",")} attempt=${safety}`);

    const actions = ai.actions.filter((a) => a !== "none");
    if (actions.length === 0) {
      await autoRemediate(unresolved);
    } else {
      for (const action of actions) {
        if (action === "resume") {
          const resume = await runBoxCli("resume", 180_000);
          await appendGuardLog(`[AUTOFIX] resume ok=${resume.ok} output=${JSON.stringify(resume.output.slice(0, 240))}`);
        } else if (action === "on") {
          const on = await runBoxCli("on", 180_000);
          await appendGuardLog(`[AUTOFIX] on ok=${on.ok} output=${JSON.stringify(on.output.slice(0, 240))}`);
        } else if (action === "stop") {
          const stop = await runBoxCli("stop", 120_000);
          await appendGuardLog(`[AUTOFIX] stop ok=${stop.ok} output=${JSON.stringify(stop.output.slice(0, 240))}`);
        }
      }
    }
    pendingIssues = unresolved;

    if (Date.now() >= endMs) {
      await appendGuardLog("[AUTOFIX] time window ended before full recovery");
      return;
    }

    // Do not return to long sleep while unhealthy; re-check quickly.
    await sleep(45_000);
  }
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const command = config.env?.copilotCliCommand || "copilot";
  const options = parseArgs(process.argv.slice(2));
  await fs.mkdir("state", { recursive: true });

  await appendGuardLog(
    `[START] hours=${options.hours} intervalMinutes=${options.intervalMinutes} maxPremium=${options.maxPremiumRequests} maxCycles=${options.maxCycles} autoFix=${options.autoFix} stopWhenDone=${options.stopWhenDone}`
  );

  let baselineLines = await readProgressLines();
  const baselinePremiumCount = await readPremiumUsageCount();
  const state: GuardState = {
    baselineLineCount: baselineLines.length,
    processedLineCount: baselineLines.length,
    baselinePremiumCount,
    premiumSpent: 0,
    cyclesSeen: 0,
    checksRun: 0,
  };

  const startMs = Date.now();
  const endMs = startMs + options.hours * 60 * 60 * 1000;
  const intervalMs = options.intervalMinutes * 60_000;

  while (Date.now() < endMs) {
    state.checksRun += 1;

    const { deltaLines, issues } = await refreshAndDetect(state, options);

    await appendGuardLog(
      `[CHECK ${state.checksRun}] premium=${state.premiumSpent}/${options.maxPremiumRequests} cycles=${state.cyclesSeen}/${options.maxCycles} deltaLines=${deltaLines.length}`
    );

    const ai = await invokeAiSupervisor(command, options, state, deltaLines, issues);
    await appendGuardLog(`[AI] healthy=${ai.healthy} summary=${ai.summary} actions=${ai.actions.join(",")}`);

    const combinedIssues = Array.from(new Set([...issues, ...(ai.healthy ? [] : ai.issues)]));

    if (combinedIssues.length > 0) {
      await appendGuardLog(`[CHECK ${state.checksRun}] issues=${combinedIssues.join(",")}`);
      if (options.autoFix) {
        await remediateUntilStable(command, state, options, endMs, combinedIssues);
      }
    }

    if (state.premiumSpent >= options.maxPremiumRequests) {
      await appendGuardLog(`[STOP] premium limit reached (${state.premiumSpent})`);
      break;
    }

    if (state.cyclesSeen >= options.maxCycles) {
      await appendGuardLog(`[STOP] cycle limit reached (${state.cyclesSeen})`);
      break;
    }

    const msLeft = endMs - Date.now();
    if (msLeft <= 0) break;
    await sleep(Math.min(intervalMs, msLeft));
  }

  if (options.stopWhenDone) {
    const stop = await runBoxCli("stop", 120_000);
    await appendGuardLog(`[DONE] issued box stop ok=${stop.ok}`);
  } else {
    await appendGuardLog("[DONE] monitoring finished without stop (per --no-stop)");
  }
}

main().catch(async (error) => {
  await appendGuardLog(`[FATAL] ${String((error as Error)?.message || error)}`);
  process.exitCode = 1;
});
