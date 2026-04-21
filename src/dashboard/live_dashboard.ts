import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { readPipelineProgress, SYSTEM_STATUS_REASON_CODE } from "../core/pipeline_progress.js";
import { parseTypedEvent } from "../core/event_schema.js";
import { readCycleAnalytics } from "../core/cycle_analytics.js";
import { collectHypothesisScorecard } from "../core/hypothesis_scorecard.js";
import { normalizePlatformModeState, PLATFORM_MODE } from "../core/mode_state.js";
import { getTargetSessionProgressLogPath, normalizeActiveTargetSession } from "../core/target_session_state.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = (process.env.BOX_ROOT_DIR || "").trim() || path.resolve(__dirname, "..", "..");
const RUNTIME_CONFIG_FILE = existsSync(path.join(ROOT, "atlas.config.json")) ? "atlas.config.json" : "box.config.json";
const STATE_DIR = path.join(ROOT, "state");
const PORT = Number(process.env.BOX_DASHBOARD_PORT || "8787");
const TARGET_REPO = process.env.TARGET_REPO || "";
const CLAUDE_CREDIT_USD = Number(process.env.BOX_CLAUDE_CREDIT_USD || "5");
const COPILOT_TIER1_MONTHLY_REQUESTS = Number(process.env.BOX_COPILOT_TIER1_MONTHLY_REQUESTS || process.env.BOX_COPILOT_MONTHLY_QUOTA || "1500");
const CLAUDE_PLATFORM_TOTAL_COST_USD = process.env.BOX_CLAUDE_PLATFORM_TOTAL_COST_USD;
const COPILOT_SOURCE_ACCOUNT = process.env.BOX_COPILOT_SOURCE_ACCOUNT || "CanerDoqdu";
const CLAUDE_ADMIN_API_KEY = process.env.CLAUDE_ADMIN_API_KEY || process.env.ANTHROPIC_ADMIN_API_KEY || "";
const CLAUDE_COST_REFRESH_MS = Number(process.env.BOX_CLAUDE_COST_REFRESH_MS || "3600000");
const CLAUDE_RATE_LIMIT_BACKOFF_MS = Number(process.env.BOX_CLAUDE_RATE_LIMIT_BACKOFF_MS || "21600000");
const CLAUDE_COST_WINDOW_DAYS = Math.max(1, Number(process.env.BOX_CLAUDE_COST_WINDOW_DAYS || "30"));
const CLAUDE_COST_START_AT = String(process.env.BOX_CLAUDE_COST_START_AT || "").trim();
const CLAUDE_COST_END_AT = String(process.env.BOX_CLAUDE_COST_END_AT || "").trim();
const GITHUB_TOKEN = process.env.GITHUB_FINEGRADED || process.env.GITHUBFINEGRADEDPERSONALINTEL || process.env.GITHUB_TOKEN || process.env.GITHUB_TOKENPERSONAL || "";
const GITHUB_BILLING_TOKEN = process.env.GITHUBFINEGRADEDPERSONALINTEL || process.env.GITHUB_FINEGRADED || GITHUB_TOKEN;
const GITHUB_BILLING_SUMMARY_URL = process.env.BOX_GITHUB_BILLING_SUMMARY_URL
  || `https://api.github.com/users/${COPILOT_SOURCE_ACCOUNT}/settings/billing/premium_request/usage`;
const GITHUB_API_VERSION = process.env.BOX_GITHUB_API_VERSION || "2022-11-28";
const COPILOT_USAGE_REFRESH_MS = Number(process.env.BOX_COPILOT_USAGE_REFRESH_MS || "3600000");
const PR_DELTA_REFRESH_MS = Number(process.env.BOX_PR_DELTA_REFRESH_MS || "3600000");
const DASHBOARD_PROJECT_LABEL = String(process.env.BOX_DASHBOARD_PROJECT_LABEL || "").trim();
const DAEMON_STOP_GRACE_MS = Math.max(0, Number(process.env.BOX_DAEMON_STOP_GRACE_MS || "6000"));
const DAEMON_STOP_POLL_MS = 100;

// Bearer token required for all mutation (POST) endpoints.
// If not set, mutation endpoints are hard-blocked (fail-safe).
// Token is read lazily at request time (not cached) so tests can inject via process.env.
// Never log this value.

const COST_CACHE = {
  value: null,
  fetchedAtMs: 0,
  inFlight: null,
  nextAllowedFetchMs: 0
};

const COPILOT_CACHE = {
  value: null,
  fetchedAtMs: 0,
  inFlight: null
};

const PR_DELTA_CACHE = {
  value: null,
  fetchedAtMs: 0,
  inFlight: null
};

const REBASE_STATE = {
  running: false,
  lastStartedAt: null,
  lastCompletedAt: null,
  lastExitCode: null,
  lastOutput: ""
};

const PROMETHEUS_PLAN_HISTORY = [];
const PROMETHEUS_PLAN_HISTORY_LIMIT = 24;

/**
 * Consume a typed event for dashboard rendering.
 * Returns { ok, event } or { ok: false, code, message } — never throws.
 * Dashboard MUST use this instead of free-form string/regex parsing on event lines.
 * Exported for tests; not exposed via HTTP API.
 *
 * @param {any} raw — a typed event object, JSON string, or arbitrary input
 * @returns {{ ok: boolean, event?: object, code?: string, message: string }}
 */
export function consumeTypedEvent(raw: unknown): { ok: boolean; event?: Record<string, unknown>; code?: string; message: string } {
  return parseTypedEvent(raw);
}

/**
 * Determine if a raw value is a known typed event belonging to a specific domain.
 * Safe for use in dashboard rendering logic — avoids ad-hoc string parsing.
 *
 * @param {any} raw
 * @param {string} [domain] — optional filter: one of EVENT_DOMAIN values
 * @returns {boolean}
 */
export function isTypedEventForDomain(raw: unknown, domain?: string): boolean {
  const result = parseTypedEvent(raw);
  if (!result.ok) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (domain !== undefined && (result as any).event.domain !== domain) return false;
  return true;
}

// ── Dashboard payload size contract ──────────────────────────────────────────

/**
 * Maximum allowed byte size for a single dashboard poll payload.
 * Criterion 5: payload MUST be < 50 KB per poll cycle.
 * If the serialized payload exceeds this limit the response includes a
 * payloadTruncated=true flag and large leaf arrays are trimmed.
 */
export const DASHBOARD_PAYLOAD_MAX_BYTES = 51200; // 50 KB

// ── System status derivation ──────────────────────────────────────────────────

/**
 * Derive system status from authoritative event-driven state sources.
 *
 * Canonical event stream:
 *   Module:      src/core/event_schema.js
 *   Key events:  box.v1.orchestration.stageEntered  — written alongside updatePipelineProgress()
 *                box.v1.orchestration.healthDegraded — written by writeOrchestratorHealth()
 *                box.v1.orchestration.healthRecovered
 *   State files: state/pipeline_progress.json  (authoritative stage source)
 *                state/orchestrator_health.json (authoritative health source)
 *
 * Decision (Criterion 2 resolved): heuristic worker-session scanning is
 * LABELED FALLBACK-ONLY and only used when the event-driven pipeline state
 * is absent or stale (> 10 minutes old).
 *
 * Returns shape:
 *   {
 *     systemStatus:     one of SYSTEM_STATUS_ENUM
 *     systemStatusText: human-readable label
 *     statusSource:     "event-driven" | "fallback-heuristic"
 *     statusFreshnessAt: ISO timestamp from the authoritative source, or null
 *     degradedReason:   SYSTEM_STATUS_REASON_CODE value | null (only when degraded)
 *   }
 *
 * @param {object} pipelineProgress  — content of pipeline_progress.json (or default)
 * @param {object} orchestratorHealth — content of orchestrator_health.json (or default)
 * @param {{ running: boolean, pid: number }} daemonStatus
 * @param {object} workerSessions    — content of worker_sessions.json (or {})
 * @param {object|null} completedEntry — matching entry from completed_projects.json, or null
 * @returns {{ systemStatus: string, systemStatusText: string, statusSource: string, statusFreshnessAt: string|null, degradedReason: string|null }}
 */
interface SystemStatusResult {
  systemStatus: string;
  systemStatusText: string;
  statusSource: string;
  statusFreshnessAt: string | null;
  degradedReason: string | null;
}

export function deriveSystemStatus(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pipelineProgress: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  orchestratorHealth: Record<string, any>,
  daemonStatus: { running: boolean; pid: number },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  workerSessions: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completedEntry: Record<string, any> | null
): SystemStatusResult {
  const orchStatus = String(orchestratorHealth?.orchestratorStatus || "").toLowerCase();
  const orchReason = orchestratorHealth?.reason || null;
  const orchRecordedAt = orchestratorHealth?.recordedAt || null;
  const pipelineStage = String(pipelineProgress?.stage || "idle");
  const pipelineFreshnessAt = pipelineProgress?.updatedAt || null;

  // ── Event-driven path: orchestratorHealth is the highest-priority source ──
  if (orchStatus === "degraded") {
    return {
      systemStatus: "degraded",
      systemStatusText: `System Degraded — ${orchReason || "see health file"}`,
      statusSource: "event-driven",
      statusFreshnessAt: orchRecordedAt || pipelineFreshnessAt,
      degradedReason: orchReason || SYSTEM_STATUS_REASON_CODE.HEALTH_FILE_DEGRADED,
    };
  }

  // ── Event-driven path: completion record ──────────────────────────────────
  if (!daemonStatus?.running && completedEntry) {
    return {
      systemStatus: "completed",
      systemStatusText: "Project Completed",
      statusSource: "event-driven",
      statusFreshnessAt: completedEntry.completedAt || pipelineFreshnessAt,
      degradedReason: null,
    };
  }

  // ── Event-driven path: active pipeline stages ─────────────────────────────
  // pipeline_progress.stage is authoritative when it is fresh (< 10 min old).
  const PIPELINE_STALE_MS = 10 * 60 * 1000;
  const ACTIVE_STAGES = new Set([
    "janus_awakening", "janus_reading", "janus_thinking", "janus_decided",
    "prometheus_starting", "prometheus_reading_repo", "prometheus_analyzing",
    "prometheus_audit", "prometheus_done",
    "athena_reviewing", "athena_approved",
    "workers_dispatching", "workers_running", "workers_finishing",
  ]);

  if (ACTIVE_STAGES.has(pipelineStage) && pipelineFreshnessAt) {
    const staleness = Date.now() - new Date(pipelineFreshnessAt).getTime();
    if (staleness < PIPELINE_STALE_MS) {
      return {
        systemStatus: "working",
        systemStatusText: "Workers Active",
        statusSource: "event-driven",
        statusFreshnessAt: pipelineFreshnessAt,
        degradedReason: null,
      };
    }
    // Pipeline state is stale — fall through to heuristics
  }

  // ── Event-driven path: idle / cycle_complete + daemon online ─────────────
  if (pipelineStage === "idle" || pipelineStage === "cycle_complete") {
    if (!daemonStatus?.running) {
      return {
        systemStatus: "offline",
        systemStatusText: "System Offline",
        statusSource: "event-driven",
        statusFreshnessAt: pipelineFreshnessAt,
        degradedReason: SYSTEM_STATUS_REASON_CODE.DAEMON_OFFLINE,
      };
    }
    return {
      systemStatus: "idle",
      systemStatusText: completedEntry ? "System Idle (last project completed)" : "System Idle",
      statusSource: "event-driven",
      statusFreshnessAt: pipelineFreshnessAt,
      degradedReason: null,
    };
  }

  // ── [FALLBACK-ONLY] — pipeline state absent/stale; heuristic scan ─────────
  // Reason: pipeline_progress.json is either missing or was not updated in the
  // last 10 minutes.  This path MUST NOT be used for authoritative decisions.
  if (!daemonStatus?.running) {
    return {
      systemStatus: "offline",
      systemStatusText: "System Offline",
      statusSource: "fallback-heuristic",
      statusFreshnessAt: pipelineFreshnessAt,
      degradedReason: SYSTEM_STATUS_REASON_CODE.DAEMON_OFFLINE,
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasWorkingWorkers = Object.values(workerSessions || {}).some((s: any) => s?.status === "working");
  if (hasWorkingWorkers) {
    return {
      systemStatus: "working",
      systemStatusText: "Workers Active",
      statusSource: "fallback-heuristic",
      statusFreshnessAt: pipelineFreshnessAt,
      degradedReason: SYSTEM_STATUS_REASON_CODE.FALLBACK_HEURISTIC,
    };
  }

  return {
    systemStatus: "idle",
    systemStatusText: completedEntry ? "System Idle (last project completed)" : "System Idle",
    statusSource: "fallback-heuristic",
    statusFreshnessAt: pipelineFreshnessAt,
    degradedReason: SYSTEM_STATUS_REASON_CODE.FALLBACK_HEURISTIC,
  };
}

// ── Decision Quality Trend ───────────────────────────────────────────────────

/**
 * Compute the decision quality trend from persisted postmortem entries.
 *
 * Returns trendData — an array of objects with shape:
 *   { timestamp: string (ISO-8601), label: string, count: number }
 *
 * Each element represents one postmortem bucket grouped by (day, label).
 * Legacy entries without decisionQualityLabel are counted as "inconclusive".
 *
 * @param {string} [stateDir] — optional override for STATE_DIR
 * @returns {Promise<{ trendData: Array<{timestamp: string, label: string, count: number}>, total: number }>}
 */
export async function getDecisionQualityTrend(stateDir?: string): Promise<{ trendData: Array<{ timestamp: string; label: string; count: number }>; total: number }> {
  const dir = stateDir || STATE_DIR;
  let entries = [];
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, "athena_postmortems.json"), "utf8"));
    // Support both v0 (plain array) and v1 ({ schemaVersion, entries: [] })
    if (Array.isArray(raw)) {
      entries = raw;
    } else if (raw && Array.isArray(raw.entries)) {
      entries = raw.entries;
    }
  } catch { /* file absent or corrupt — return empty trend */ }

  // Bucket by (date, label)
  const VALID_LABELS = new Set(["correct", "delayed-correct", "incorrect", "inconclusive"]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const buckets: Record<string, any> = {};
  for (const pm of entries) {
    if (!pm || typeof pm !== "object") continue;
    const ts = pm.reviewedAt || pm.timestamp || null;
    const dateKey = ts ? String(ts).slice(0, 10) : "unknown";
    const rawLabel = pm.decisionQualityLabel;
    const label = (rawLabel && VALID_LABELS.has(rawLabel)) ? rawLabel : "inconclusive";
    const key = `${dateKey}::${label}`;
    if (!buckets[key]) {
      buckets[key] = { timestamp: dateKey, label, count: 0 };
    }
    buckets[key].count++;
  }

  const trendData = Object.values(buckets).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { trendData, total: entries.length };
}

function normalizeText(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function textLooksRelated(a: string, b: string): boolean {
  const aa = normalizeText(a);
  const bb = normalizeText(b);
  if (!aa || !bb) return false;
  if (aa.includes(bb) || bb.includes(aa)) return true;
  const aParts = aa.split(" ").filter((p) => p.length > 5);
  let matches = 0;
  for (const part of aParts) {
    if (bb.includes(part)) matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getLastWorkerMessage(session: Record<string, any>, roleName: string): any {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || String(entry.from || "").toLowerCase() === "athena") continue;
    if (roleName && entry.from && entry.from !== roleName) continue;
    return entry;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computePlanStatus(plan: Record<string, any>, workerSessions: Record<string, any>, athenaState: Record<string, any>): string {
  const role = String(plan?.role || "");
  const task = String(plan?.task || "");
  const session = workerSessions?.[role] || {};
  const sessionStatus = String(session?.status || "idle").toLowerCase();
  const completedTasks = Array.isArray(athenaState?.completedTasks) ? athenaState.completedTasks : [];
  const completedHit = completedTasks.some((item) => textLooksRelated(item, task));

  const history = Array.isArray(session?.history) ? session.history : [];
  let lastWorkerEntry = null;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.from === "orchestrator") continue;
    lastWorkerEntry = entry;
    break;
  }

  if (completedHit) return "done";
  if (sessionStatus === "working" && textLooksRelated(session?.lastTask || "", task)) return "running";

  const lastWorkerStatus = String(lastWorkerEntry?.status || "").toLowerCase();
  const lastWorkerSummary = String(lastWorkerEntry?.content || "");
  const benchHint = /benched|not re-dispatched|skipped this cycle/i.test(String(athenaState?.summary || ""));
  if (benchHint && role && String(athenaState?.summary || "").includes(role)) return "skipped";
  if (lastWorkerStatus === "done" && textLooksRelated(lastWorkerSummary, task)) return "done";
  if ((lastWorkerStatus === "blocked" || lastWorkerStatus === "error") && textLooksRelated(lastWorkerSummary, task)) return "skipped";
  if (sessionStatus === "error" && textLooksRelated(session?.lastTask || "", task)) return "skipped";
  return "queued";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildPrometheusPlanBoard(prometheusAnalysis: Record<string, any>, workerSessions: Record<string, any>, athenaState: Record<string, any>): Record<string, any> {
  const sessions = workerSessions || {};
  const coord = athenaState || {};

  const coordMs = coord?.coordinatedAt ? new Date(coord.coordinatedAt).getTime() : Date.now();
  const cycleItems = Object.entries(sessions)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map(([role, session]: any[], index) => {
      const lastTask = String(session?.lastTask || "").trim();
      if (!lastTask) return null;
      const lastActiveMs = session?.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
      // Keep only recent cycle activity on the front board to avoid showing old finished waves.
      if (!Number.isFinite(lastActiveMs) || lastActiveMs <= 0) return null;
      if (Math.abs(coordMs - lastActiveMs) > (180 * 60 * 1000)) return null;
      const status = String(session?.status || "idle").toLowerCase();
      let normalized = "queued";
      if (status === "working") normalized = "running";
      else if (status === "idle") {
        const last = getLastWorkerMessage(session, role);
        const lastStatus = String(last?.status || "").toLowerCase();
        normalized = lastStatus === "done" ? "done" : "queued";
      } else if (status === "error" || status === "blocked") normalized = "skipped";
      return {
        id: index + 1,
        role,
        priority: index + 1,
        kind: "cycle",
        task: lastTask,
        status: normalized
      };
    })
    .filter(Boolean);

  const cycleKey = `cycle:${coord?.coordinatedAt || "none"}:${normalizeText(coord?.summary || "").slice(0, 60)}`;
  const cycleSnapshot = {
    key: cycleKey,
    analyzedAt: coord?.coordinatedAt || null,
    projectHealth: String(coord?.janusDecision || "tactical"),
    summary: String(coord?.summary || "").slice(0, 260),
    items: cycleItems,
    source: "athena-cycle",
    updatedAt: new Date().toISOString()
  };

  if (cycleItems.length > 0) {
    const cycleIndex = PROMETHEUS_PLAN_HISTORY.findIndex((entry) => entry.key === cycleKey);
    if (cycleIndex >= 0) PROMETHEUS_PLAN_HISTORY[cycleIndex] = cycleSnapshot;
    else PROMETHEUS_PLAN_HISTORY.unshift(cycleSnapshot);
  }

  const plans = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [];
  const analyzedAt = prometheusAnalysis?.analyzedAt || null;
  const key = `${analyzedAt || "no-analysis"}|${plans.length}|${plans.map((p) => `${p?.role || "?"}:${normalizeText(p?.task || "")}`).join("||")}`;

  const items = plans.map((plan, index) => ({
    id: index + 1,
    role: String(plan?.role || "unknown"),
    priority: Number(plan?.priority || (index + 1)),
    kind: String(plan?.kind || "default"),
    task: String(plan?.task || ""),
    status: computePlanStatus(plan, workerSessions || {}, athenaState || {})
  }));

  const existingIndex = PROMETHEUS_PLAN_HISTORY.findIndex((entry) => entry.key === key);
  const snapshot = {
    key,
    analyzedAt,
    projectHealth: String(prometheusAnalysis?.projectHealth || "unknown"),
    summary: String(prometheusAnalysis?.analysis || "").slice(0, 260),
    items,
    source: "prometheus-analysis",
    updatedAt: new Date().toISOString()
  };

  if (existingIndex >= 0) {
    PROMETHEUS_PLAN_HISTORY[existingIndex] = snapshot;
  } else {
    PROMETHEUS_PLAN_HISTORY.unshift(snapshot);
  }

  if (PROMETHEUS_PLAN_HISTORY.length > PROMETHEUS_PLAN_HISTORY_LIMIT) {
    PROMETHEUS_PLAN_HISTORY.length = PROMETHEUS_PLAN_HISTORY_LIMIT;
  }

  const activeKey = coord?.hadPrometheusPlans === false && cycleItems.length > 0 ? cycleKey : key;
  const active = PROMETHEUS_PLAN_HISTORY.find((entry) => entry.key === activeKey) || snapshot;

  return {
    activeKey,
    active,
    history: PROMETHEUS_PLAN_HISTORY
  };
}

function runRebaseCommand() {
  return new Promise((resolve) => {
    const child = execFile("node", ["--import", "tsx", "src/cli.ts", "rebase"], { cwd: ROOT, windowsHide: true }, (error, stdout, stderr) => {
      const output = [String(stdout || "").trim(), String(stderr || "").trim()].filter(Boolean).join("\n");
      if (error) {
        resolve({ ok: false, exitCode: Number(error?.code || 1), output });
        return;
      }
      resolve({ ok: true, exitCode: 0, output });
    });

    child.on("error", (error) => {
      resolve({ ok: false, exitCode: 1, output: String(error?.message || error) });
    });
  });
}

// ── Daemon start/stop (dashboard stays alive) ────────────────────────────────

function startDaemonDetached() {
  return new Promise((resolve) => {
    try {
      const child = spawn("node", ["--import", "tsx", "src/cli.ts", "start"], {
        cwd: ROOT,
        detached: true,
        stdio: "ignore",
        windowsHide: true
      });
      child.unref();
      const pid = child.pid;
      resolve({ ok: true, pid, message: `Daemon started pid=${pid}` });
    } catch (err) {
      resolve({ ok: false, pid: 0, message: String(err?.message || err) });
    }
  });
}

async function stopDaemon() {
  const status = await getDaemonStatus();
  if (!status.running || !status.pid) {
    return { ok: true, message: "Daemon was not running" };
  }
  const pid = status.pid;
  // Write stop request so daemon exits gracefully via daemon_control.js contract (daemon.stop.json)
  try {
    const stopFile = path.join(STATE_DIR, "daemon.stop.json");
    await fs.writeFile(stopFile, JSON.stringify({ requestedAt: new Date().toISOString(), reason: "dashboard-stop" }), "utf8");
  } catch { /* best effort */ }
  // Wait for graceful exit; timeout is configurable for deterministic tests.
  for (let waited = 0; waited < DAEMON_STOP_GRACE_MS; waited += DAEMON_STOP_POLL_MS) {
    await new Promise(r => setTimeout(r, DAEMON_STOP_POLL_MS));
    if (!isProcessAlive(pid)) {
      return { ok: true, message: `Daemon pid=${pid} stopped gracefully` };
    }
  }
  // Force kill
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  return { ok: true, message: `Daemon pid=${pid} force-killed` };
}

async function readJsonSafe<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function readTailLines(filePath: string, maxLines: number): Promise<string[]> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}

function isProcessAlive(pid: number | string | null | undefined): boolean {
  const n = Number(pid || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function getDaemonStatus() {
  const daemonPidPath = path.join(STATE_DIR, "daemon.pid.json");
  const daemonState = await readJsonSafe(daemonPidPath, null);
  const pid = Number(daemonState?.pid || 0);
  const running = isProcessAlive(pid);
  return {
    running,
    pid: running ? pid : 0
  };
}

function getRollingWindowRangeUtc(days: number): { startingAt: string; endingAt: string } {
  const now = new Date();
  const endingAt = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds()
  ));
  const startingAt = new Date(endingAt.getTime() - (Math.max(1, Number(days || 30)) * 24 * 60 * 60 * 1000));
  return {
    startingAt: startingAt.toISOString(),
    endingAt: endingAt.toISOString()
  };
}

function getClaudeCostRange() {
  if (CLAUDE_COST_START_AT && CLAUDE_COST_END_AT) {
    return {
      startingAt: CLAUDE_COST_START_AT,
      endingAt: CLAUDE_COST_END_AT
    };
  }
  return getRollingWindowRangeUtc(CLAUDE_COST_WINDOW_DAYS);
}

function getCurrentUtcYearMonth() {
  const now = new Date();
  return {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && value.trim() === "") {
    return null;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseCopilotUsageFromSummary(payload: Record<string, any>): { quota: number | null; used: number | null; remaining: number | null; byModel?: unknown[] } | null {
  // Handle the /users/{username}/settings/billing/premium_request/usage response shape:
  // { timePeriod, user, usageItems: [{ product, sku, grossQuantity, netQuantity, ... }] }
  if (Array.isArray(payload?.usageItems)) {
    const copilotItems = payload.usageItems.filter((item) =>
      /copilot|premium[_-]?request/i.test(String(item?.product || item?.sku || ""))
    );
    const totalGross = copilotItems.reduce((sum, item) => sum + Number(item?.grossQuantity || 0), 0);
    return { quota: null, used: totalGross, remaining: null, byModel: copilotItems };
  }

  const arrays = [payload?.data, payload?.items, payload?.usage]
    .filter((item) => Array.isArray(item));
  const entries = arrays.flat();
  const pickName = (item) => String(item?.product || item?.sku || item?.name || item?.metric || item?.type || "").toLowerCase();
  const copilotItems = entries.filter((item) => /copilot|premium[_-]?request/.test(pickName(item)));
  const copilotItem = copilotItems[0];
  const source = copilotItem || payload;

  const quota = toFiniteNumber(
    source?.includedQuantity ?? source?.included_quantity ?? source?.includedUsage ?? source?.included_usage ?? source?.quota ?? source?.limit ?? source?.included
  );
  const used = toFiniteNumber(
    source?.usedQuantity ?? source?.used_quantity ?? source?.totalQuantity ?? source?.total_quantity ?? source?.consumed ?? source?.usage ?? source?.total_usage
  );
  const remainingDirect = toFiniteNumber(
    source?.remainingQuantity ?? source?.remaining_quantity ?? source?.remainingUsage ?? source?.remaining_usage ?? source?.remaining
  );

  // Billing usage/premium_request endpoints return usageItems with quantities (often netQuantity).
  const usageItemsUsed = copilotItems.reduce((sum, item) => {
    const qty = toFiniteNumber(item?.grossQuantity ?? item?.netQuantity ?? item?.quantity);
    return sum + (qty ?? 0);
  }, 0);
  const hasUsageItemsUsed = copilotItems.length > 0;
  const normalizedUsed = used !== null ? used : (hasUsageItemsUsed ? usageItemsUsed : null);

  if (quota === null && normalizedUsed === null && remainingDirect === null) {
    return null;
  }

  const remaining = remainingDirect !== null
    ? Math.max(0, remainingDirect)
    : (quota !== null && normalizedUsed !== null ? Math.max(0, quota - normalizedUsed) : null);

  return { quota, used: normalizedUsed, remaining };
}

/**
 * Fetch premium request quota snapshot from copilot_internal/user endpoint.
 * Returns { entitlement, used, remaining, percentRemaining } or null on failure.
 */
async function fetchCopilotInternalQuota() {
  if (!GITHUB_BILLING_TOKEN) return null;
  try {
    const r = await fetch("https://api.github.com/copilot_internal/user", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GITHUB_BILLING_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "user-agent": "BOX/1.0"
      }
    });
    if (!r.ok) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j: any = await r.json();
    const snap = j?.quota_snapshots?.premium_interactions;
    if (!snap || typeof snap.entitlement !== "number") return null;
    const entitlement = snap.entitlement;
    const remaining = Number(snap.quota_remaining ?? snap.remaining ?? 0);
    const used = entitlement - remaining;
    return { entitlement, used, remaining, percentRemaining: snap.percent_remaining ?? null };
  } catch {
    return null;
  }
}

async function fetchOneTimeCopilotUsage() {
  if (!GITHUB_BILLING_TOKEN || !GITHUB_BILLING_SUMMARY_URL) {
    return {
      quotaRequests: null,
      usedRequests: null,
      remainingRequests: null,
      source: "github-billing-unconfigured",
      fetchedAt: new Date().toISOString(),
      lastError: "github-billing-unconfigured"
    };
  }

  const { year, month } = getCurrentUtcYearMonth();
  let url;
  try {
    url = new URL(GITHUB_BILLING_SUMMARY_URL);
  } catch (error) {
    return {
      quotaRequests: null,
      usedRequests: null,
      remainingRequests: null,
      source: "github-billing-fetch-failed",
      fetchedAt: new Date().toISOString(),
      lastError: `github-billing-url-invalid:${String(error?.message || error)}`
    };
  }
  url.searchParams.set("year", String(year));
  url.searchParams.set("month", String(month));

  const fetchUsage = async (apiVersion) => {
    return fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${GITHUB_BILLING_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": apiVersion,
        "user-agent": "BOX/1.0"
      }
    });
  };

  try {
    let response = await fetchUsage(GITHUB_API_VERSION);
    // Some custom API versions can break this endpoint; retry with stable default.
    if (!response.ok && GITHUB_API_VERSION !== "2022-11-28") {
      response = await fetchUsage("2022-11-28");
    }

    if (!response.ok) {
      return {
        quotaRequests: null,
        usedRequests: null,
        remainingRequests: null,
        source: "github-billing-fetch-failed",
        fetchedAt: new Date().toISOString(),
        lastError: `github-billing-error-${response.status}`
      };
    }

    const payload = await response.json();
    const parsed = parseCopilotUsageFromSummary(payload);
    if (!parsed) {
      return {
        quotaRequests: null,
        usedRequests: null,
        remainingRequests: null,
        source: "github-billing-parse-failed",
        fetchedAt: new Date().toISOString(),
        lastError: "github-billing-parse-failed"
      };
    }

    // Prefer copilot_internal/user quota snapshot for accurate premium request tracking.
    // The billing API grossQuantity differs from actual premium interaction units.
    const internalQuota = await fetchCopilotInternalQuota();
    const usedRequests = internalQuota ? internalQuota.used : parsed.used;
    const quotaRequests = internalQuota ? internalQuota.entitlement : parsed.quota;
    const remainingRequests = internalQuota ? internalQuota.remaining : parsed.remaining;

    return {
      quotaRequests,
      usedRequests,
      remainingRequests,
      byModel: parsed.byModel || null,
      source: internalQuota ? "copilot-internal-quota" : "github-billing-usage-summary",
      fetchedAt: new Date().toISOString(),
      lastError: null
    };
  } catch (error) {
    return {
      quotaRequests: null,
      usedRequests: null,
      remainingRequests: null,
      source: "github-billing-fetch-failed",
      fetchedAt: new Date().toISOString(),
      lastError: String(error?.message || error)
    };
  }
}

async function getHourlyCopilotUsage() {
  const now = Date.now();
  const isFresh = COPILOT_CACHE.value && (now - COPILOT_CACHE.fetchedAtMs) < COPILOT_USAGE_REFRESH_MS;
  if (isFresh) {
    return {
      ...COPILOT_CACHE.value,
      refreshInSec: Math.max(0, Math.ceil((COPILOT_USAGE_REFRESH_MS - (now - COPILOT_CACHE.fetchedAtMs)) / 1000))
    };
  }

  if (COPILOT_CACHE.inFlight) {
    return COPILOT_CACHE.inFlight;
  }

  COPILOT_CACHE.inFlight = (async () => {
    const result = await fetchOneTimeCopilotUsage();
    COPILOT_CACHE.value = result;
    COPILOT_CACHE.fetchedAtMs = Date.now();
    COPILOT_CACHE.inFlight = null;
    return {
      ...result,
      refreshInSec: Math.ceil(COPILOT_USAGE_REFRESH_MS / 1000)
    };
  })();

  return COPILOT_CACHE.inFlight;
}

async function fetchGithubPrDelta() {
  const repo = (TARGET_REPO || "").trim();
  if (!repo || !GITHUB_TOKEN) {
    return null;
  }
  const slashIdx = repo.indexOf("/");
  if (slashIdx < 1 || slashIdx >= repo.length - 1) {
    return null;
  }
  const owner = repo.slice(0, slashIdx);
  const name = repo.slice(slashIdx + 1);
  const query = `
    query($owner: String!, $name: String!, $first: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: [MERGED], first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes { additions deletions mergedAt }
        }
      }
    }
  `;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "user-agent": "BOX/1.0"
      },
      body: JSON.stringify({ query, variables: { owner, name, first: 100 } })
    });
    if (!response.ok) {
      return null;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const payload: any = await response.json();
    const nodes = Array.isArray(payload?.data?.repository?.pullRequests?.nodes)
      ? payload.data.repository.pullRequests.nodes
      : [];
    const additions = nodes.reduce((sum, pr) => sum + Number(pr?.additions || 0), 0);
    const deletions = nodes.reduce((sum, pr) => sum + Number(pr?.deletions || 0), 0);
    return {
      additions,
      deletions,
      prCount: nodes.length,
      source: "github-merged-prs",
      fetchedAt: new Date().toISOString()
    };
  } catch {
    return null;
  }
}

async function getHourlyPrDeltaStats() {
  const now = Date.now();
  const isFresh = PR_DELTA_CACHE.value && (now - PR_DELTA_CACHE.fetchedAtMs) < PR_DELTA_REFRESH_MS;
  if (isFresh) {
    return PR_DELTA_CACHE.value;
  }
  if (PR_DELTA_CACHE.inFlight) {
    return PR_DELTA_CACHE.inFlight;
  }
  PR_DELTA_CACHE.inFlight = (async () => {
    const result = await fetchGithubPrDelta();
    PR_DELTA_CACHE.value = result;
    PR_DELTA_CACHE.fetchedAtMs = Date.now();
    PR_DELTA_CACHE.inFlight = null;
    return result;
  })();
  return PR_DELTA_CACHE.inFlight;
}

async function fetchOneTimeClaudeCostUsd() {
  if (!CLAUDE_ADMIN_API_KEY) {
    return {
      spentUsd: null,
      source: "admin-api-key-missing",
      fetchedAt: new Date().toISOString(),
      lastError: "admin-api-key-missing"
    };
  }

  const { startingAt, endingAt } = getClaudeCostRange();
  const baseUrl = new URL("https://api.anthropic.com/v1/organizations/cost_report");
  baseUrl.searchParams.set("starting_at", startingAt);
  baseUrl.searchParams.set("ending_at", endingAt);
  baseUrl.searchParams.append("group_by[]", "workspace_id");
  baseUrl.searchParams.append("group_by[]", "description");
  // Cost report supports daily buckets; keep a safe limit and follow next_page when needed.
  baseUrl.searchParams.set("limit", "31");

  try {
    let totalInCents = 0;
    let tokenTotalInCents = 0;
    let nextPage = null;
    let pagesFetched = 0;

    while (pagesFetched < 500) {
      const pageUrl = new URL(baseUrl.toString());
      if (nextPage) {
        pageUrl.searchParams.set("page", nextPage);
      }

      const response = await fetch(pageUrl.toString(), {
        method: "GET",
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": CLAUDE_ADMIN_API_KEY,
          "user-agent": "BOX/1.0"
        }
      });

      if (!response.ok) {
        const retryAfterRaw = response.headers.get("retry-after");
        const retryAfterSec = Number(retryAfterRaw);
        const retryAfterMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0
          ? retryAfterSec * 1000
          : null;
        return {
          spentUsd: null,
          source: "admin-api-fetch-failed",
          fetchedAt: new Date().toISOString(),
          lastError: `admin-api-error-${response.status}`,
          retryAfterMs
        };
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const payload: any = await response.json();
      pagesFetched += 1;

      for (const bucket of payload?.data || []) {
        for (const result of bucket?.results || []) {
          const amount = Number(result?.amount || 0);
          totalInCents += amount;
          if (String(result?.cost_type || "").toLowerCase() === "tokens") {
            tokenTotalInCents += amount;
          }
        }
      }

      if (!payload?.has_more) {
        break;
      }

      nextPage = String(payload?.next_page || "").trim();
      if (!nextPage) {
        break;
      }
    }

    return {
      spentUsd: Number((totalInCents / 100).toFixed(6)),
      tokenSpentUsd: Number((tokenTotalInCents / 100).toFixed(6)),
      source: "admin-api-cost-report",
      fetchedAt: new Date().toISOString(),
      lastError: null,
      retryAfterMs: null
    };
  } catch (error) {
    return {
      spentUsd: null,
      source: "admin-api-fetch-failed",
      fetchedAt: new Date().toISOString(),
      lastError: String(error?.message || error),
      retryAfterMs: null
    };
  }
}

async function getHourlyClaudeCost() {
  const now = Date.now();
  const cooldownRemainingMs = Math.max(0, COST_CACHE.nextAllowedFetchMs - now);
  const isFresh = COST_CACHE.value && (now - COST_CACHE.fetchedAtMs) < CLAUDE_COST_REFRESH_MS;
  if (isFresh || cooldownRemainingMs > 0) {
    const refreshRemainingMs = COST_CACHE.value
      ? Math.max(0, CLAUDE_COST_REFRESH_MS - (now - COST_CACHE.fetchedAtMs))
      : 0;
    return {
      ...COST_CACHE.value,
      refreshInSec: Math.max(0, Math.ceil(Math.max(refreshRemainingMs, cooldownRemainingMs) / 1000))
    };
  }

  if (COST_CACHE.inFlight) {
    return COST_CACHE.inFlight;
  }

  COST_CACHE.inFlight = (async () => {
    const result = await fetchOneTimeClaudeCostUsd();
    COST_CACHE.value = result;
    COST_CACHE.fetchedAtMs = Date.now();
    const isRateLimited = String(result?.lastError || "").includes("admin-api-error-429");
    const retryMs = Number.isFinite(Number(result?.retryAfterMs)) && Number(result.retryAfterMs) > 0
      ? Number(result.retryAfterMs)
      : CLAUDE_RATE_LIMIT_BACKOFF_MS;
    COST_CACHE.nextAllowedFetchMs = isRateLimited ? (Date.now() + retryMs) : 0;
    COST_CACHE.inFlight = null;
    const nextRefreshMs = isRateLimited ? retryMs : CLAUDE_COST_REFRESH_MS;
    return {
      ...result,
      refreshInSec: Math.ceil(nextRefreshMs / 1000)
    };
  })();

  return COST_CACHE.inFlight;
}

function getDockerSummary() {
  let composeServices = [];
  let composeRunning = 0;

  try {
    const raw = execSync("docker compose ps --format json", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true
    }).trim();

    if (raw) {
      const lines = raw.split(/\r?\n/).filter(Boolean);
      composeServices = lines
        .map((line) => {
          try {
            const item = JSON.parse(line);
            return {
              service: item.Service || "unknown",
              name: item.Name || "unknown",
              state: item.State || "unknown",
              status: item.Status || "unknown"
            };
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      composeRunning = composeServices.filter((s) => String(s.state).toLowerCase() === "running").length;
    }
  } catch {
    // docker compose may be unavailable or there may be no compose services.
  }

  let workerServices = [];
  let workerRunning = 0;
  try {
    const rawWorkers = execSync("docker ps --filter \"ancestor=box-worker:local\" --format \"{{.Names}}|{{.Status}}\"", {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true
    }).trim();

    if (rawWorkers) {
      const lines = rawWorkers.split(/\r?\n/).filter(Boolean);
      workerServices = lines.map((line) => {
        const [name, status] = String(line).split("|");
        return {
          service: "worker",
          name: String(name || "unknown").trim(),
          state: "running",
          status: String(status || "running").trim()
        };
      });
      workerRunning = workerServices.length;
    }
  } catch {
    // Ignore worker summary failures and return compose data only.
  }

  return {
    services: [...composeServices, ...workerServices],
    running: composeRunning + workerRunning
  };
}

function getGitActivity() {
  try {
    const todayStr = new Date().toISOString().slice(0, 10);
    // Commits today
    const todayLog = execSync(
      `git log --since="${todayStr}T00:00:00" --format="%H|%s|%ai" --no-merges`,
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", windowsHide: true, timeout: 5000 }
    ).trim();
    const todayCommits = todayLog ? todayLog.split(/\r?\n/).filter(Boolean) : [];

    // Lines changed today
    let linesAdded = 0;
    let linesDeleted = 0;
    let filesChanged = 0;
    try {
      const shortstat = execSync(
        `git diff --shortstat HEAD~${Math.max(1, todayCommits.length)} HEAD`,
        { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", windowsHide: true, timeout: 5000 }
      ).trim();
      const filesMatch = shortstat.match(/(\d+) file/);
      const addMatch = shortstat.match(/(\d+) insertion/);
      const delMatch = shortstat.match(/(\d+) deletion/);
      filesChanged = filesMatch ? Number(filesMatch[1]) : 0;
      linesAdded = addMatch ? Number(addMatch[1]) : 0;
      linesDeleted = delMatch ? Number(delMatch[1]) : 0;
    } catch { /* shallow clone or no commits */ }

    // Total commits on branch
    let totalCommits = 0;
    try {
      totalCommits = Number(execSync(
        "git rev-list --count HEAD",
        { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", windowsHide: true, timeout: 5000 }
      ).trim()) || 0;
    } catch { /* optional */ }

    // Recent commit messages (last 5)
    const recentMessages = todayCommits.slice(0, 5).map(line => {
      const [hash, ...rest] = line.split("|");
      const msg = rest.slice(0, -1).join("|") || "";
      const time = rest[rest.length - 1] || "";
      return { hash: (hash || "").slice(0, 7), message: msg.trim(), time: time.trim() };
    });

    return {
      commitsToday: todayCommits.length,
      totalCommits,
      linesAdded,
      linesDeleted,
      filesChanged,
      recentMessages
    };
  } catch {
    return { commitsToday: 0, totalCommits: 0, linesAdded: 0, linesDeleted: 0, filesChanged: 0, recentMessages: [] };
  }
}

function getMonthKey() {
  const d = new Date();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${m}`;
}

function deriveProjectLabel(targetRepo: string, packageName: string | null): string {
  if (DASHBOARD_PROJECT_LABEL) {
    return DASHBOARD_PROJECT_LABEL;
  }

  const fromRepo = String(targetRepo || "").split("/").pop() || "";
  const normalized = fromRepo.replace(/[^a-z]/gi, "").toLowerCase();
  if (normalized) {
    return normalized;
  }

  return String(packageName || "unknown");
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value || "").trim()).filter(Boolean);
}

export function deriveTargetRuntimeView(input: {
  platformModeState?: Record<string, any> | null;
  activeTargetSession?: Record<string, any> | null;
  targetRepo?: string | null;
  rootDir?: string | null;
}) {
  const platformModeState = input?.platformModeState && typeof input.platformModeState === "object"
    ? input.platformModeState
    : {};
  const activeTargetSession = input?.activeTargetSession && typeof input.activeTargetSession === "object"
    ? input.activeTargetSession
    : null;
  const currentMode = String(platformModeState.currentMode || PLATFORM_MODE.SELF_DEV);
  const targetRepo = String(activeTargetSession?.repo?.repoUrl || input?.targetRepo || "").trim();
  const projectLabel = deriveProjectLabel(targetRepo, String(activeTargetSession?.repo?.name || "").trim() || null);
  const stage = activeTargetSession ? String(activeTargetSession.currentStage || "unknown") : null;
  const objectiveSummary = String(activeTargetSession?.objective?.summary || "").trim() || null;
  const missing = normalizeStringList(activeTargetSession?.prerequisites?.missing);
  const requiredNow = normalizeStringList(activeTargetSession?.prerequisites?.requiredNow);
  const requiredHumanInputs = normalizeStringList(activeTargetSession?.handoff?.requiredHumanInputs);
  const warnings = normalizeStringList(activeTargetSession?.warnings);
  const repoState = String(activeTargetSession?.repoProfile?.repoState || "").trim() || null;
  const repoStateReason = String(activeTargetSession?.repoProfile?.repoStateReason || "").trim() || null;
  const selectedOnboardingAgent = String(activeTargetSession?.repoProfile?.selectedOnboardingAgent || "").trim() || null;
  const clarificationStatus = String(activeTargetSession?.clarification?.status || "").trim() || null;
  const clarificationMode = String(activeTargetSession?.clarification?.mode || "").trim() || null;
  const clarificationAgent = String(activeTargetSession?.clarification?.selectedAgentSlug || "").trim() || null;
  const clarificationPendingQuestions = normalizeStringList(activeTargetSession?.clarification?.pendingQuestions);
  const clarificationPacketPath = String(activeTargetSession?.clarification?.packetPath || "").trim() || null;
  const clarificationTranscriptPath = String(activeTargetSession?.clarification?.transcriptPath || "").trim() || null;
  const intentContractPath = String(activeTargetSession?.clarification?.intentContractPath || "").trim() || null;
  const blockers = [
    String(activeTargetSession?.prerequisites?.blockedReason || "").trim(),
    String(activeTargetSession?.gates?.quarantineReason || "").trim(),
    ...missing,
    ...requiredHumanInputs,
    ...warnings,
  ].filter(Boolean);

  let waitingReason = "none";
  if (currentMode === PLATFORM_MODE.SELF_DEV) {
    waitingReason = "BOX is operating in self_dev mode.";
  } else if (currentMode === PLATFORM_MODE.IDLE) {
    waitingReason = "BOX is idle and waiting for the next target intake.";
  } else if (!activeTargetSession) {
    waitingReason = "single_target_delivery is active but no active target session is loaded.";
  } else if (stage === "awaiting_credentials") {
    waitingReason = blockers[0] || requiredNow[0] || "Waiting for credentials before planning or execution can continue.";
  } else if (stage === "awaiting_manual_step") {
    waitingReason = requiredHumanInputs[0] || blockers[0] || "Waiting for a required manual step before resuming the target session.";
  } else if (stage === "awaiting_intent_clarification") {
    waitingReason = requiredHumanInputs[0]
      || String(activeTargetSession?.handoff?.nextAction || "").trim()
      || "Waiting for the target onboarding clarification session to finish before planning can begin.";
  } else if (stage === "quarantined") {
    waitingReason = blockers[0] || "Target session is quarantined pending human review.";
  } else if (stage === "onboarding") {
    waitingReason = "Onboarding is evaluating readiness, prerequisites, and risk.";
  } else if (stage === "shadow") {
    waitingReason = String(activeTargetSession?.handoff?.nextAction || "Running shadow validation before active delivery opens.").trim();
  } else if (stage === "active") {
    waitingReason = String(activeTargetSession?.handoff?.nextAction || "Target delivery is active.").trim();
  }

  const targetWorkspacePath = String(activeTargetSession?.workspace?.path || "").trim() || null;
  const boxWorkspacePath = String(input?.rootDir || ROOT).trim() || ROOT;
  const executionWorkspacePath = currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY && targetWorkspacePath
    ? targetWorkspacePath
    : boxWorkspacePath;
  const bootstrap = activeTargetSession?.workspace?.bootstrap && typeof activeTargetSession.workspace.bootstrap === "object"
    ? activeTargetSession.workspace.bootstrap
    : {};

  return {
    currentMode,
    fallbackModeAfterCompletion: String(platformModeState.fallbackModeAfterCompletion || PLATFORM_MODE.SELF_DEV),
    projectLabel,
    targetRepo,
    activeProjectId: String(activeTargetSession?.projectId || "").trim() || null,
    sessionId: String(activeTargetSession?.sessionId || "").trim() || null,
    stage,
    objectiveSummary,
    readiness: String(activeTargetSession?.onboarding?.readiness || "").trim() || null,
    readinessScore: Number(activeTargetSession?.onboarding?.readinessScore ?? 0),
    blockers,
    waitingReason,
    requiredHumanInputs,
    repoState,
    repoStateReason,
    selectedOnboardingAgent,
    clarificationStatus,
    clarificationMode,
    clarificationAgent,
    clarificationPendingQuestions,
    clarificationPacketPath,
    clarificationTranscriptPath,
    intentContractPath,
    boxWorkspacePath,
    targetWorkspacePath,
    executionWorkspacePath,
    bootstrapStatus: String(bootstrap.status || "pending").trim() || null,
    bootstrapStrategy: String(bootstrap.strategy || "pending").trim() || null,
    bootstrapLastError: String(bootstrap.lastError || "").trim() || null,
    hasActiveTargetSession: activeTargetSession != null,
    canOpenNewSession: activeTargetSession == null,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveTasks(prometheusAnalysis: Record<string, any>, workerSessions: Record<string, any>): Record<string, any> {
  const allPlans = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [];
  // Filter out Issachar/Ezra scan-only tasks (removed from active plan)
  const plans = allPlans.filter(p => !/^(Issachar|Ezra)/i.test(String(p.role || "")));
  const sessions = workerSessions || {};
  const list = plans.map((plan, idx) => {
    const role = String(plan.role || "unknown");
    const session = sessions[role] || {};
    const sessionStatus = String(session.status || "idle").toLowerCase();
    const lastHistory = Array.isArray(session.history) ? session.history[session.history.length - 1] : null;
    const lastStatus = String(lastHistory?.status || "").toLowerCase();
    let status;
    if (sessionStatus === "working") {
      // Cross-check: worker may be stuck at "working" if daemon died
      // If last history entry says "done", treat as passed
      if (lastStatus === "done") status = "passed";
      else status = "running";
    }
    else if (sessionStatus === "done") status = "passed";
    else if (sessionStatus === "blocked" || sessionStatus === "error") status = "failed";
    else {
      if (lastStatus === "done") status = "passed";
      else if (lastStatus === "blocked") status = "failed";
      else status = "queued";
    }
    return {
      id: idx + 1,
      title: String(plan.task || "").slice(0, 120),
      status,
      kind: String(plan.kind || "default"),
      assignedRole: role,
      priority: plan.priority || idx + 1,
      complexity: plan.estimatedComplexity || "medium"
    };
  });
  const totals = { queued: 0, running: 0, passed: 0, failed: 0, other: 0 };
  for (const t of list) {
    if (totals[t.status] !== undefined) totals[t.status]++;
    else totals.other++;
  }
  return { total: list.length, totals, list };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deriveAlerts(alertsData: Record<string, any>): Record<string, any> {
  const entries = Array.isArray(alertsData?.entries) ? alertsData.entries : [];
  const recent = entries.slice(-20);
  return {
    total: entries.length,
    list: recent.map(a => ({
      timestamp: a.timestamp || null,
      severity: a.severity || "info",
      title: a.title || "",
      message: a.message || "",
      source: a.source || ""
    }))
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function derivePremiumUsageByWorker(log: any): Record<string, any> {
  const entries = Array.isArray(log) ? log : (Array.isArray(log?.entries) ? log.entries : []);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byWorker: Record<string, any> = {};
  for (const e of entries) {
    const w = e.worker || "unknown";
    if (!byWorker[w]) byWorker[w] = { count: 0, totalDurationMs: 0, models: {}, entries: [] };
    byWorker[w].count++;
    byWorker[w].totalDurationMs += Number(e.durationMs || 0);
    const m = e.model || "unknown";
    byWorker[w].models[m] = (byWorker[w].models[m] || 0) + 1;
    byWorker[w].entries.push({
      taskKind: e.taskKind || "",
      model: m,
      startedAt: e.startedAt || "",
      completedAt: e.completedAt || "",
      durationMs: e.durationMs || 0
    });
  }
  // Keep only last 10 entries per worker for dashboard payload size
  for (const w of Object.keys(byWorker)) {
    byWorker[w].entries = byWorker[w].entries.slice(-10);
  }
  return { totalRequests: entries.length, byWorker };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function derivePremiumEstimate(prometheusAnalysisRef: Record<string, any>, usedRequests: number | null, quota: number): Record<string, any> {
  const budget = prometheusAnalysisRef?.requestBudget || {};
  const estimated = Number(budget.estimatedPremiumRequestsTotal || 0);
  const confidence = String(budget.confidence || "").trim();
  const byRole = Array.isArray(budget.byRole) ? budget.byRole : [];
  const byWave = Array.isArray(budget.byWave) ? budget.byWave : [];
  return {
    estimatedTotal: estimated,
    confidence,
    used: Number(usedRequests || 0),
    quota: Number(quota || 0),
    remaining: Math.max(0, Number(quota || 0) - Number(usedRequests || 0)),
    afterProject: Math.max(0, Number(quota || 0) - Number(usedRequests || 0) - estimated),
    byRole,
    byWave
  };
}

async function collectDashboardData() {
  const [
    boxConfig,
    progressTail,
    oneTimeCost,
    copilotApiUsage,
    rawPlatformModeState,
    rawActiveTargetSession,
    workerSessions,
    athenaState,
    janusDirective,
    prometheusAnalysis,
    alertsData,
    suggestionsData,
    premiumUsageLog,
    completedProjects
  ] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    readJsonSafe<Record<string, any>>(path.join(ROOT, RUNTIME_CONFIG_FILE), {}),
    readTailLines(path.join(STATE_DIR, "progress.txt"), 80),
    getHourlyClaudeCost(),
    getHourlyCopilotUsage(),
    readJsonSafe(path.join(STATE_DIR, "platform", "mode_state.json"), null),
    readJsonSafe(path.join(STATE_DIR, "active_target_session.json"), null),
    readJsonSafe(path.join(STATE_DIR, "worker_sessions.json"), {}),
    readJsonSafe(path.join(STATE_DIR, "athena_plan_review.json"), {}),
    readJsonSafe(path.join(STATE_DIR, "janus_directive.json"), {}),
    readJsonSafe(path.join(STATE_DIR, "prometheus_analysis.json"), {}),
    readJsonSafe(path.join(STATE_DIR, "alerts.json"), { entries: [] }),
    readJsonSafe(path.join(STATE_DIR, "worker_suggestions.json"), { entries: [] }),
    readJsonSafe(path.join(STATE_DIR, "premium_usage_log.json"), []),
    readJsonSafe(path.join(STATE_DIR, "completed_projects.json"), [])
  ]);

  // Read pipeline progress, orchestrator health, and SLO metrics in parallel.
  // orchestrator_health.json is written by writeOrchestratorHealth() on any status change.
  // slo_metrics.json is written by persistSloMetrics() after each completed cycle.
  const [pipelineProgress, orchestratorHealth, sloMetrics, hypothesisScorecard] = await Promise.all([
    readPipelineProgress({ paths: { stateDir: STATE_DIR } }),
    readJsonSafe(path.join(STATE_DIR, "orchestrator_health.json"), {
      orchestratorStatus: "operational",
      reason: null,
      details: null,
      recordedAt: null,
    }),
    readJsonSafe(path.join(STATE_DIR, "slo_metrics.json"), {
      schemaVersion: 1,
      lastCycle: null,
      history: [],
      updatedAt: null,
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    collectHypothesisScorecard(STATE_DIR, undefined as any),
  ]);

  const [daemonStatus, prDeltaResult, gitActivity] = await Promise.all([getDaemonStatus(), getHourlyPrDeltaStats(), Promise.resolve(getGitActivity())]);
  const normalizedConfig = {
    ...boxConfig,
    paths: {
      ...(boxConfig?.paths && typeof boxConfig.paths === "object" ? boxConfig.paths : {}),
      stateDir: STATE_DIR,
      workspaceDir: String(boxConfig?.paths?.workspaceDir || path.join(ROOT, ".box-work")),
    },
    rootDir: ROOT,
  };
  const normalizedActiveTargetSessionResult = normalizeActiveTargetSession(rawActiveTargetSession, normalizedConfig);
  const normalizedActiveTargetSession = normalizedActiveTargetSessionResult.session;
  const normalizedPlatformModeState = normalizePlatformModeState(rawPlatformModeState, normalizedActiveTargetSession, normalizedConfig);
  const targetRuntime = deriveTargetRuntimeView({
    platformModeState: normalizedPlatformModeState,
    activeTargetSession: normalizedActiveTargetSession,
    targetRepo: TARGET_REPO,
    rootDir: ROOT,
  });
  const targetSessionProgressPath = normalizedActiveTargetSession?.projectId && normalizedActiveTargetSession?.sessionId
    ? getTargetSessionProgressLogPath(STATE_DIR, normalizedActiveTargetSession.projectId, normalizedActiveTargetSession.sessionId)
    : null;
  const targetSessionLogTail = targetSessionProgressPath
    ? await readTailLines(targetSessionProgressPath, 80).catch(() => [])
    : [];

  // Read last thinking snippet from each worker's debug file
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const thinkingMap: Record<string, any> = {};
  for (const role of Object.keys(workerSessions || {})) {
    try {
      const fname = `debug_worker_${role.replace(/\s+/g, "_")}.txt`;
      const raw = await fs.readFile(path.join(STATE_DIR, fname), "utf8");
      // Extract text before BOX_STATUS= markers, last 350 chars of meaningful content
      const beforeStatus = raw.split(/BOX_STATUS=/)[0];
      const lines = beforeStatus.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("```") && !l.startsWith("---") && !l.startsWith("##"));
      const snippet = lines.slice(-5).join(" ").replace(/\s+/g, " ").trim().slice(0, 350);
      if (snippet) thinkingMap[role] = snippet;
    } catch { /* file may not exist yet */ }
  }

  const docker = getDockerSummary();
  const currentMonth = getMonthKey();
  const hasPlatformOverride = CLAUDE_PLATFORM_TOTAL_COST_USD !== undefined && CLAUDE_PLATFORM_TOTAL_COST_USD !== null && CLAUDE_PLATFORM_TOTAL_COST_USD !== "";
  const hasAdminCost = Number.isFinite(Number(oneTimeCost?.spentUsd));
  const hasAdminTokenCost = Number.isFinite(Number(oneTimeCost?.tokenSpentUsd));
  const claudeEstimatedSpentUsd = hasAdminTokenCost
    ? Number(oneTimeCost.tokenSpentUsd)
    : (hasAdminCost
        ? Number(oneTimeCost.spentUsd)
        : (hasPlatformOverride ? Number(CLAUDE_PLATFORM_TOTAL_COST_USD) : 0));
  const claudeEstimatedRemainingUsd = Math.max(0, CLAUDE_CREDIT_USD - claudeEstimatedSpentUsd);

  const fallbackQuota = COPILOT_TIER1_MONTHLY_REQUESTS;
  const apiQuota = toFiniteNumber(copilotApiUsage?.quotaRequests);
  const apiUsed = toFiniteNumber(copilotApiUsage?.usedRequests);
  const apiRemaining = toFiniteNumber(copilotApiUsage?.remainingRequests);
  const copilotQuota = apiQuota !== null ? apiQuota : fallbackQuota;
  const copilotUsedRequests = apiUsed !== null
    ? apiUsed
    : (apiQuota !== null && apiRemaining !== null ? Math.max(0, apiQuota - apiRemaining) : 0);
  const copilotRemainingRequests = apiRemaining !== null
    ? apiRemaining
    : Math.max(0, copilotQuota - copilotUsedRequests);
  const copilotUsedPercent = copilotQuota > 0 ? (copilotUsedRequests / copilotQuota) * 100 : 0;
  const prometheusPlanBoard = buildPrometheusPlanBoard(prometheusAnalysis, workerSessions, athenaState);

  // Check if current target repo is in the completion ledger
  const completedEntry = Array.isArray(completedProjects)
    ? completedProjects.find(e => e.repo === TARGET_REPO)
    : null;

  // Derive system status from canonical event-driven sources (pipeline_progress.json +
  // orchestrator_health.json).  Heuristic fallback is used only when those are absent
  // or stale — see deriveSystemStatus() for full decision tree.
  const statusResult = deriveSystemStatus(
    pipelineProgress, orchestratorHealth, daemonStatus, workerSessions, completedEntry
  );
  const systemStatus = statusResult.systemStatus;
  const systemStatusText = statusResult.systemStatusText;

  const decisionQualityTrend = await getDecisionQualityTrend(STATE_DIR);

  // Optional control state and live log carried over from the base runtime.
  const siControlRaw = await readJsonSafe(path.join(STATE_DIR, "self_improvement_control.json"), { enabled: true, reason: "", updatedAt: null, updatedBy: "" });
  let siLiveLogTail = [];
  try {
    const siLogContent = await fs.readFile(path.join(STATE_DIR, "si_live.log"), "utf8");
    siLiveLogTail = siLogContent.split("\n").filter(l => l.trim()).slice(-30);
  } catch { /* file may not exist yet */ }

  return {
    generatedAt: new Date().toISOString(),
    monthKey: currentMonth,
    runtime: {
      targetRepo: targetRuntime.targetRepo || TARGET_REPO,
      projectLabel: targetRuntime.projectLabel,
      systemStatus,
      systemStatusText,
      currentMode: targetRuntime.currentMode,
      fallbackModeAfterCompletion: targetRuntime.fallbackModeAfterCompletion,
      activeTarget: {
        ...targetRuntime,
        sessionProgressLogPath: targetSessionProgressPath,
      },
      /** Source freshness timestamp from the authoritative event-driven state file. */
      statusFreshnessAt: statusResult.statusFreshnessAt,
      /** "event-driven" when status came from pipeline_progress/orchestrator_health; "fallback-heuristic" otherwise. */
      statusSource: statusResult.statusSource,
      /** Reason code when systemStatus === "degraded"; null otherwise. */
      degradedReason: statusResult.degradedReason,
      daemonPid: daemonStatus.pid,
      roleRegistry: {
        ceo: String(boxConfig?.roleRegistry?.ceoSupervisor?.name || "Janus"),
        lead: String(boxConfig?.roleRegistry?.qualityReviewer?.name || "Athena"),
        workers: (boxConfig?.roleRegistry?.workers && typeof boxConfig.roleRegistry.workers === "object")
          ? boxConfig.roleRegistry.workers
          : {}
      }
    },
    billing: {
      claudeCreditUsd: CLAUDE_CREDIT_USD,
      claudeEstimatedSpentUsd,
      claudeEstimatedRemainingUsd,
      source: hasAdminTokenCost
        ? `admin-api-token-cost-${CLAUDE_COST_WINDOW_DAYS}d`
        : (hasAdminCost ? `admin-api-total-cost-${CLAUDE_COST_WINDOW_DAYS}d` : (hasPlatformOverride ? "platform-override" : "no-data"))
    },
    admin: {
      fetchedAt: oneTimeCost.fetchedAt,
      source: oneTimeCost.source,
      lastError: oneTimeCost.lastError,
      refreshInSec: oneTimeCost.refreshInSec
    },
    docker,
    pipeline: pipelineProgress,
    tasks: deriveTasks(prometheusAnalysis, workerSessions),
    prometheusPlanBoard,
    taskInsights: {},
    issues: { total: 0, list: [] },
    alerts: deriveAlerts(alertsData),
    suggestions: {
      total: Array.isArray(suggestionsData?.entries) ? suggestionsData.entries.length : 0,
      list: Array.isArray(suggestionsData?.entries) ? suggestionsData.entries.slice(-30).reverse() : []
    },
    tests: {},
    premiumRequestEstimate: derivePremiumEstimate(prometheusAnalysis, copilotUsedRequests, copilotQuota),
    usage: {
      copilot: {
        totalEntries: 0,
        monthly: {
          totalCalls: 0,
          opusCalls: 0,
          autoFallbacks: 0,
          byModel: {},
          quota: Number(copilotQuota),
          remainingRequests: copilotRemainingRequests,
          usedPercent: Number(copilotUsedPercent.toFixed(2)),
          refreshInSec: Number(copilotApiUsage?.refreshInSec || 0),
          sourceAccount: COPILOT_SOURCE_ACCOUNT,
          source: copilotApiUsage?.source || "github-billing-api"
        },
        recent: []
      },
      claude: {
        totalEntries: 0,
        monthly: { totalCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, byStage: {} },
        recent: []
      }
    },
    codeDelta: {
      projectLinesAdded: (prDeltaResult && prDeltaResult.prCount > 0) ? prDeltaResult.additions : 0,
      projectLinesDeleted: (prDeltaResult && prDeltaResult.prCount > 0) ? prDeltaResult.deletions : 0,
      source: (prDeltaResult && prDeltaResult.prCount > 0) ? prDeltaResult.source : "no-data"
    },
    activityPulse: {
      git: gitActivity,
      requestsSpent: {
        premium: Array.isArray(premiumUsageLog) ? premiumUsageLog.length : 0,
        copilotUsedPct: Number(copilotUsedPercent.toFixed(2)),
        copilotUsed: copilotUsedRequests,
        copilotQuota: Number(copilotQuota),
        copilotRemaining: copilotRemainingRequests,
        copilotByModel: Array.isArray(copilotApiUsage?.byModel)
          ? copilotApiUsage.byModel.map(m => ({ model: m.model, qty: m.grossQuantity }))
          : []
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      workersActive: Object.entries(workerSessions || {}).filter(([, s]: any) => s?.status === "working").map(([name, s]: any) => ({
        name,
        task: String(s.lastTask || "").slice(0, 80),
        since: s.lastActiveAt || null
      })),
      daemonPid: daemonStatus.pid,
      daemonRunning: daemonStatus.running
    },
    premiumUsageByWorker: derivePremiumUsageByWorker(premiumUsageLog),
    workerActivity: (function() {
      const sessions = workerSessions || {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cleaned: Record<string, any> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const [role, s] of Object.entries(sessions) as any[]) {
        // Cross-check: if status is "working" but last non-orchestrator history says "done",
        // the worker actually finished — session file is stale
        let effectiveStatus = s.status || "idle";
        if (effectiveStatus === "working" && Array.isArray(s.history) && s.history.length > 0) {
          const lastEntry = s.history.filter(h => h && h.role !== "Athena").pop();
          if (lastEntry && ["done", "partial", "blocked"].includes(String(lastEntry.status || "").toLowerCase())) {
            effectiveStatus = "idle";
          }
        }
        cleaned[role] = {
          role,
          status: effectiveStatus,
          lastTask: s.lastTask || "",
          lastActiveAt: s.lastActiveAt || null,
          historyLength: Array.isArray(s.history) ? s.history.length : 0,
          lastThinking: thinkingMap[role] || ""
        };
      }
      return cleaned;
    })(),
    leadership: {
      athena: athenaState,
      janus: janusDirective,
      prometheus: prometheusAnalysis
    },
    guardian: {
      report: {},
      lastRecovery: {},
      history: [],
      rebase: {
        running: REBASE_STATE.running,
        lastStartedAt: REBASE_STATE.lastStartedAt,
        lastCompletedAt: REBASE_STATE.lastCompletedAt,
        lastExitCode: REBASE_STATE.lastExitCode,
        lastOutput: REBASE_STATE.lastOutput
      }
    },
    decisionQualityTrend,
    logs: progressTail,
    targetSessionLogs: targetSessionLogTail,
    projectCompleted: completedEntry ? {
      repo: completedEntry.repo,
      completionTag: completedEntry.completionTag || null,
      releaseUrl: completedEntry.releaseUrl || null,
      totalMergedPrs: completedEntry.totalMergedPrs || 0,
      completedAt: completedEntry.completedAt || null
    } : null,
    slo: {
      orchestratorStatus: String(orchestratorHealth?.orchestratorStatus || "operational"),
      orchestratorReason: orchestratorHealth?.reason || null,
      orchestratorRecordedAt: orchestratorHealth?.recordedAt || null,
      lastCycle: sloMetrics?.lastCycle || null,
      sloUpdatedAt: sloMetrics?.updatedAt || null,
    },
    hypothesisScorecard,
    selfImprovement: {
      manualEnabled: siControlRaw.enabled !== false,
      configEnabled: Boolean(boxConfig?.selfImprovement?.enabled ?? true),
      reason: String(siControlRaw.reason || ""),
      updatedAt: siControlRaw.updatedAt || null,
      updatedBy: String(siControlRaw.updatedBy || ""),
      liveLog: siLiveLogTail,
    },
  };
}

function renderHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BOX Mission Control</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap');
    :root {
      --bg-a: #e9f3ee;
      --bg-b: #ddeaf6;
      --ink: #1a2b38;
      --muted: #506779;
      --card: rgba(238, 247, 252, 0.84);
      --line: rgba(89, 124, 148, 0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font-family: "Space Grotesk", "Trebuchet MS", sans-serif;
      background:
        radial-gradient(900px 500px at 5% -5%, rgba(86, 187, 158, 0.26), transparent 60%),
        radial-gradient(900px 520px at 95% 0%, rgba(109, 175, 226, 0.24), transparent 58%),
        linear-gradient(160deg, var(--bg-a), var(--bg-b));
      padding: 16px;
    }
    .shell { max-width: 1320px; margin: 0 auto; }
    .hero, .card, .panel {
      border: 1px solid var(--line);
      border-radius: 14px;
      background: var(--card);
      box-shadow: 0 14px 28px rgba(20, 42, 59, 0.12);
      transition: transform 180ms ease, box-shadow 180ms ease;
    }
    .card:hover, .panel:hover { transform: translateY(-2px); box-shadow: 0 18px 34px rgba(20, 42, 59, 0.18); }
    .hero { padding: 14px 16px; margin-bottom: 12px; }
    .hero-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    .hero h1 { margin: 0; font-size: clamp(24px, 4vw, 36px); }
    .hero-live {
      position: relative;
      min-width: 210px;
      max-width: 300px;
      height: 28px;
      border-radius: 999px;
      padding: 0 10px;
      display: flex;
      align-items: center;
      justify-content: flex-start;
      gap: 8px;
      color: #d7ffe9;
      border: 1px solid rgba(63, 203, 130, 0.65);
      background:
        linear-gradient(115deg, rgba(7, 74, 41, 0.9), rgba(9, 123, 66, 0.78)),
        radial-gradient(120% 180% at 15% 20%, rgba(138, 255, 191, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(180, 255, 214, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.28),
        0 10px 18px rgba(8, 81, 43, 0.36);
      transform: perspective(520px) rotateX(9deg);
      transform-style: preserve-3d;
      overflow: hidden;
    }
    .hero-live.is-offline {
      color: #ffe1e1;
      border: 1px solid rgba(227, 96, 96, 0.75);
      background:
        linear-gradient(115deg, rgba(96, 15, 15, 0.95), rgba(166, 35, 35, 0.86)),
        radial-gradient(120% 180% at 15% 20%, rgba(255, 165, 165, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(255, 214, 214, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.3),
        0 10px 18px rgba(120, 24, 24, 0.34);
    }
    .hero-live::before {
      content: "";
      position: absolute;
      inset: -1px;
      background: linear-gradient(90deg, rgba(61, 206, 128, 0.02), rgba(137, 255, 192, 0.4), rgba(61, 206, 128, 0.02));
      animation: missionSweep 2.8s linear infinite;
      mix-blend-mode: screen;
      pointer-events: none;
    }
    .hero-live::selection { background: transparent; }
    .hero-live::after {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #77ffb1;
      box-shadow: 0 0 0 0 rgba(119, 255, 177, 0.8);
      animation: missionPulse 1.9s ease-out infinite;
      flex: 0 0 auto;
    }
    .hero-live.is-offline::before {
      background: linear-gradient(90deg, rgba(227, 85, 85, 0.02), rgba(255, 176, 176, 0.5), rgba(227, 85, 85, 0.02));
    }
    .hero-live.is-offline::after {
      background: #ff8f8f;
      box-shadow: 0 0 0 0 rgba(255, 143, 143, 0.8);
    }
    .hero-live.is-workers-active {
      color: #fff8e0;
      border: 1px solid rgba(210, 165, 40, 0.75);
      background:
        linear-gradient(115deg, rgba(100, 72, 8, 0.92), rgba(168, 130, 15, 0.84)),
        radial-gradient(120% 180% at 15% 20%, rgba(255, 220, 100, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(255, 240, 180, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.28),
        0 10px 18px rgba(130, 95, 8, 0.34);
    }
    .hero-live.is-workers-active::before {
      background: linear-gradient(90deg, rgba(200, 160, 20, 0.02), rgba(255, 220, 100, 0.4), rgba(200, 160, 20, 0.02));
    }
    .hero-live.is-workers-active::after {
      background: #ffd95c;
      box-shadow: 0 0 0 0 rgba(255, 220, 100, 0.8);
    }
    .hero-live.is-idle {
      color: #d3ecff;
      border: 1px solid rgba(80, 160, 220, 0.65);
      background:
        linear-gradient(115deg, rgba(10, 50, 90, 0.9), rgba(20, 90, 150, 0.78)),
        radial-gradient(120% 180% at 15% 20%, rgba(130, 200, 255, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(180, 220, 255, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.28),
        0 10px 18px rgba(10, 60, 110, 0.34);
    }
    .hero-live.is-idle::before {
      background: linear-gradient(90deg, rgba(80, 160, 220, 0.02), rgba(140, 210, 255, 0.4), rgba(80, 160, 220, 0.02));
    }
    .hero-live.is-idle::after {
      background: #7dc4ff;
      box-shadow: 0 0 0 0 rgba(125, 196, 255, 0.8);
    }
    .hero-live.is-completed {
      color: #d3ffec;
      border: 1px solid rgba(0, 204, 128, 0.75);
      background:
        linear-gradient(115deg, rgba(8, 60, 42, 0.92), rgba(12, 100, 68, 0.84)),
        radial-gradient(120% 180% at 15% 20%, rgba(100, 255, 180, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(180, 255, 220, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.28),
        0 10px 18px rgba(8, 80, 50, 0.34);
    }
    .hero-live.is-completed::before {
      background: linear-gradient(90deg, rgba(0,200,128,0.02), rgba(100,255,180,0.4), rgba(0,200,128,0.02));
    }
    .hero-live.is-completed::after {
      background: #5cffa8;
      box-shadow: 0 0 0 0 rgba(92, 255, 168, 0.8);
      animation: none;
    }
    .hero-live.is-degraded {
      color: #fff0d0;
      border: 1px solid rgba(220, 130, 20, 0.75);
      background:
        linear-gradient(115deg, rgba(90, 50, 5, 0.94), rgba(165, 100, 10, 0.86)),
        radial-gradient(120% 180% at 15% 20%, rgba(255, 190, 80, 0.35), transparent 55%);
      box-shadow:
        inset 0 1px 0 rgba(255, 220, 140, 0.34),
        inset 0 -8px 14px rgba(0, 0, 0, 0.3),
        0 10px 18px rgba(130, 70, 8, 0.34);
    }
    .hero-live.is-degraded::before {
      background: linear-gradient(90deg, rgba(220, 130, 20, 0.02), rgba(255, 200, 80, 0.4), rgba(220, 130, 20, 0.02));
    }
    .hero-live.is-degraded::after {
      background: #ffb84d;
      box-shadow: 0 0 0 0 rgba(255, 184, 77, 0.8);
    }
    .hero-live span {
      position: relative;
      z-index: 1;
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 11px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.35);
      white-space: nowrap;
    }
    @keyframes missionSweep {
      0% { transform: translateX(-115%); }
      100% { transform: translateX(115%); }
    }
    @keyframes missionPulse {
      0% { box-shadow: 0 0 0 0 rgba(119, 255, 177, 0.8); }
      70% { box-shadow: 0 0 0 10px rgba(119, 255, 177, 0); }
      100% { box-shadow: 0 0 0 0 rgba(119, 255, 177, 0); }
    }
    @media (max-width: 680px) {
      .hero-live {
        width: 100%;
        max-width: none;
        transform: perspective(520px) rotateX(6deg);
      }
    }
    .hero p { margin: 7px 0 0 0; color: var(--muted); font-family: "IBM Plex Mono", Consolas, monospace; font-size: 12px; }
    .grid { display: grid; gap: 10px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); margin-bottom: 12px; }
    .card { padding: 10px; }
    .k { color: var(--muted); font-size: 12px; text-transform: uppercase; font-family: "IBM Plex Mono", Consolas, monospace; }
    .v { margin-top: 4px; font-size: 25px; font-weight: 700; }
    .sub { margin-top: 4px; color: var(--muted); font-size: 11px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .rows { display: grid; gap: 12px; grid-template-columns: 1.7fr 1fr; margin-bottom: 12px; }
    .panel h2 { margin: 0; padding: 10px; border-bottom: 1px solid var(--line); font-size: 13px; text-transform: uppercase; font-family: "IBM Plex Mono", Consolas, monospace; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 7px 10px; border-bottom: 1px solid var(--line); text-align: left; }
    tr:last-child td { border-bottom: 0; }
    th { color: #4b6478; font-family: "IBM Plex Mono", Consolas, monospace; font-size: 12px; }
    .task-table-wrap {
      max-height: 420px;
      overflow-y: auto;
      overflow-x: hidden;
      overscroll-behavior: contain;
      scrollbar-gutter: stable;
    }
    .task-table-wrap::-webkit-scrollbar { width: 8px; }
    .task-table-wrap::-webkit-scrollbar-track { background: rgba(80,103,121,0.08); border-radius: 4px; }
    .task-table-wrap::-webkit-scrollbar-thumb { background: rgba(80,103,121,0.32); border-radius: 4px; }
    .task-table-wrap::-webkit-scrollbar-thumb:hover { background: rgba(80,103,121,0.52); }
    .task-table-wrap thead th {
      position: sticky;
      top: 0;
      background: rgba(233, 245, 252, 0.96);
      z-index: 2;
    }
    .badge { display: inline-block; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; }
    .queued { background: rgba(255, 205, 118, 0.24); color: #7d5c1f; border: 1px solid rgba(224, 163, 58, 0.38); }
    .running { background: rgba(125, 201, 255, 0.24); color: #1d5983; border: 1px solid rgba(71, 161, 224, 0.40); }
    .passed { background: rgba(124, 214, 178, 0.26); color: #1e6a4f; border: 1px solid rgba(64, 177, 133, 0.38); }
    .failed { background: rgba(255, 182, 167, 0.30); color: #8a3b30; border: 1px solid rgba(219, 114, 96, 0.38); }
    pre { margin: 0; padding: 10px; max-height: 310px; overflow: auto; font-size: 12px; font-family: "IBM Plex Mono", Consolas, monospace; color: #1f3a4c; background: rgba(222, 237, 247, 0.78); }
    #log-view { background: #0d1117; color: #d1d5db; max-height: 480px; line-height: 1.6; }
    .muted { color: var(--muted); }
    .status-wrap { margin-top: 7px; }
    .status-bar {
      display: grid;
      grid-auto-flow: column;
      width: 100%;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(255,255,255,0.1);
    }
    .seg { height: 100%; }
    .seg.queued { background: #f4c16c; }
    .seg.running { background: #79c9ff; }
    .seg.passed { background: #6fd4ac; }
    .seg.failed { background: #f8a69b; }
    .legend { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 8px; font-size: 11px; color: var(--muted); }
    tr.selectable { cursor: pointer; }
    tr.selectable:hover { background: rgba(128, 181, 212, 0.14); }
    .detail-grid { display: grid; gap: 10px; grid-template-columns: 1fr 1fr; }
    @media (max-width: 980px) { .detail-grid { grid-template-columns: 1fr; } }
    @media (max-width: 980px) { .rows { grid-template-columns: 1fr; } }
    .activity-card { display: flex; flex-direction: column; gap: 6px; padding: 12px; }
    .activity-worker { background: rgba(222, 237, 247, 0.68); border-radius: 10px; padding: 10px 14px; }
    .activity-worker .aw-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
    .activity-worker .aw-slot { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 700; font-size: 13px; }
    .activity-worker .aw-slot-sub { font-size: 11px; color: var(--muted); margin-left: 8px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .activity-worker .aw-phase { font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .phase-idle { color: #7a8d9c; }
    .phase-preparing { color: #b08c2a; }
    .phase-routing { color: #7d5c1f; }
    .phase-model-selection { color: #6b4fa2; }
    .phase-coding { color: #1d7b5f; }
    .phase-reviewing { color: #1d5983; }
    .activity-worker .aw-detail { font-size: 11px; color: var(--muted); font-family: "IBM Plex Mono", Consolas, monospace; }
    .activity-worker .aw-meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .calls-toolbar {
      display: flex;
      justify-content: flex-end;
      padding: 8px 10px 0 10px;
    }
    .calls-btn {
      border: 1px solid var(--line);
      background: rgba(222, 237, 247, 0.8);
      color: var(--ink);
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 11px;
      padding: 4px 8px;
      border-radius: 8px;
      cursor: pointer;
    }
    .action-btn {
      border: 1px solid rgba(176, 70, 70, 0.55);
      background: rgba(245, 196, 196, 0.56);
      color: #702828;
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 11px;
      padding: 6px 10px;
      border-radius: 8px;
      cursor: pointer;
      font-weight: 700;
      text-transform: uppercase;
    }
    .chain {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    }
    .chain-box {
      border-radius: 10px;
      border: 1px solid var(--line);
      box-shadow: 0 8px 16px rgba(20, 42, 59, 0.08);
      padding: 8px 10px;
      color: var(--ink);
      background: var(--card);
    }
    .chain-box.user, .chain-box.janus, .chain-box.Athena, .chain-box.workers { background: var(--card); }
    .chain-title {
      font-family: "IBM Plex Mono", Consolas, monospace;
      text-transform: uppercase;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
      margin: 0 0 5px 0;
      color: #4b6478;
    }
    .chain-body {
      background: rgba(222, 237, 247, 0.62);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 8px;
      font-size: 12px;
      line-height: 1.35;
    }
    .chain-arrow {
      display: none;
    }
    .worker-chips {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
      gap: 6px;
    }
    .worker-chip {
      border-radius: 6px;
      padding: 6px;
      color: var(--ink);
      border: 1px solid var(--line);
      font-size: 11px;
      font-family: "IBM Plex Mono", Consolas, monospace;
      line-height: 1.25;
      background: rgba(222, 237, 247, 0.62);
    }
    .worker-chip.green { background: rgba(124, 214, 178, 0.26); border-color: rgba(64, 177, 133, 0.38); }
    .worker-chip.yellow { background: rgba(255, 205, 118, 0.24); border-color: rgba(224, 163, 58, 0.38); }
    .worker-chip.red { background: rgba(255, 182, 167, 0.30); border-color: rgba(219, 114, 96, 0.38); }
    .prometheus-tabs { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px; border-bottom: 1px solid var(--line); }
    .prometheus-tab {
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(222, 237, 247, 0.82);
      color: var(--ink);
      padding: 5px 10px;
      font-size: 11px;
      font-family: "IBM Plex Mono", Consolas, monospace;
      cursor: pointer;
      transition: transform 140ms ease, background 140ms ease;
    }
    .prometheus-tab:hover { transform: translateY(-1px); background: rgba(212, 228, 241, 0.96); }
    .prometheus-tab.active { border-color: rgba(212, 160, 23, 0.65); background: rgba(212, 160, 23, 0.2); }
    .prometheus-plan-list { display: grid; gap: 8px; padding: 10px; }
    .prometheus-plan-item {
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(226, 239, 248, 0.72);
      padding: 8px 10px;
    }
    .prometheus-plan-item.green { border-left: 4px solid #38b977; background: rgba(203, 241, 222, 0.7); }
    .prometheus-plan-item.red { border-left: 4px solid #db6a63; background: rgba(249, 217, 214, 0.72); }
    .prometheus-plan-item.neutral { border-left: 4px solid #c8a648; background: rgba(243, 232, 201, 0.62); }
    .prometheus-plan-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 11px;
      color: var(--muted);
      margin-bottom: 5px;
    }
    .prometheus-plan-task { font-size: 13px; color: var(--ink); line-height: 1.3; }
    /* ── Leadership Flow Panel ─────────────────────────────────────── */
    .lf-panel { margin-bottom: 12px; }
    .lf-row {
      display: flex; align-items: stretch; justify-content: center;
      gap: 0; padding: 14px 10px; flex-wrap: wrap;
    }
    .lf-card {
      flex: 1 1 260px; max-width: 340px; border-radius: 12px;
      border: 1px solid var(--line); background: var(--card); padding: 12px 14px;
    }
    .lf-card.janus { border-left: 4px solid #4a9eff; }
    .lf-card.Athena { border-left: 4px solid #22c27e; }
    .lf-name { font-family: "IBM Plex Mono", Consolas, monospace; font-weight: 700; font-size: 14px; margin-bottom: 4px; }
    .lf-status { font-size: 12px; color: var(--muted); margin-bottom: 6px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .lf-detail { font-size: 12px; line-height: 1.4; }
    .lf-reasoning {
      margin-top: 4px; font-size: 11px; font-family: "IBM Plex Mono", Consolas, monospace;
      white-space: pre-wrap; color: #2a4a5e; background: rgba(200, 225, 245, 0.45);
      border-radius: 6px; padding: 6px; max-height: 120px; overflow-y: auto;
    }
    .lf-arrow-wrap {
      flex: 0 0 120px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 5px;
    }
    .lf-arrow-sym { font-size: 30px; color: #a0b8c8; transition: color 0.3s; line-height: 1; }
    .lf-arrow-label { font-size: 10px; font-family: "IBM Plex Mono", Consolas, monospace; color: var(--muted); text-align: center; }
    .lf-arrow-wrap.active .lf-arrow-sym { color: #22c27e; animation: arrowPulse 0.8s ease-in-out infinite; }
    @keyframes arrowPulse {
      0%, 100% { opacity: 0.35; transform: translateX(0); }
      50% { opacity: 1; transform: translateX(7px); }
    }
    @media (max-width: 720px) {
      .lf-row { flex-direction: column; align-items: center; }
      .lf-arrow-wrap { flex: 0 0 auto; flex-direction: row; gap: 10px; padding: 4px 0; }
    }
    /* ── Worker Grid ───────────────────────────────────────────────── */
    .workers-live { margin-bottom: 12px; }
    .workers-live h2 { margin: 0; padding: 10px; border-bottom: 1px solid var(--line); font-size: 13px; text-transform: uppercase; font-family: "IBM Plex Mono", Consolas, monospace; }
    .worker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; padding: 10px; }
    .ws-card {
      border-radius: 10px; border: 1px solid var(--line); background: rgba(222, 237, 247, 0.62);
      padding: 10px 12px; transition: box-shadow 0.2s;
    }
    .ws-card:hover { box-shadow: 0 4px 12px rgba(20, 42, 59, 0.14); }
    .ws-card.working { background: rgba(125, 201, 255, 0.18); border-color: rgba(71, 161, 224, 0.50); }
    .ws-card.blocked { background: rgba(255, 182, 120, 0.22); border-color: rgba(219, 130, 58, 0.45); }
    .ws-card.error   { background: rgba(255, 182, 167, 0.28); border-color: rgba(219, 114, 96, 0.45); }
    .ws-card.done    { background: rgba(124, 214, 178, 0.22); border-color: rgba(64, 177, 133, 0.38); }
    .ws-name { font-weight: 700; font-size: 13px; display: flex; align-items: center; gap: 5px; margin-bottom: 5px; }
    .ws-badge {
      display: inline-block; padding: 2px 7px; border-radius: 999px;
      font-size: 10px; font-weight: 700; text-transform: uppercase;
      font-family: "IBM Plex Mono", Consolas, monospace;
    }
    .ws-badge.idle    { background: rgba(120,140,160,0.15); color: #506779; border: 1px solid rgba(120,140,160,0.3); }
    .ws-badge.working { background: rgba(71,161,224,0.22); color: #1d5983; border: 1px solid rgba(71,161,224,0.4); animation: wsPulse 1.6s ease-in-out infinite; }
    .ws-badge.blocked { background: rgba(219,130,58,0.22); color: #7d4d1f; border: 1px solid rgba(219,130,58,0.4); }
    .ws-badge.error   { background: rgba(219,114,96,0.22); color: #8a3b30; border: 1px solid rgba(219,114,96,0.4); }
    .ws-badge.done    { background: rgba(64,177,133,0.22); color: #1e6a4f; border: 1px solid rgba(64,177,133,0.38); }
    @keyframes wsPulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }
    @keyframes celebrationPulse {
      0% { transform: scale(0.95); opacity: 0; }
      30% { transform: scale(1.02); opacity: 1; }
      60% { transform: scale(0.99); }
      100% { transform: scale(1); opacity: 1; }
    }
    @keyframes particleFade {
      0% { opacity: 0; transform: translateY(0) scale(0.5); }
      40% { opacity: 1; transform: translateY(-20px) scale(1.2); }
      100% { opacity: 0; transform: translateY(-60px) scale(0.3); }
    }
    .ws-task { font-size: 11px; font-family: "IBM Plex Mono", Consolas, monospace; color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .ws-time { font-size: 10px; color: var(--muted); margin-top: 3px; font-family: "IBM Plex Mono", Consolas, monospace; }
    .ws-details { margin-top: 5px; }
    .ws-details > summary {
      list-style: none; cursor: pointer; font-size: 11px;
      color: var(--muted); opacity: 0.75; transition: opacity 0.15s;
      display: flex; align-items: center; gap: 3px; user-select: none;
    }
    .ws-details > summary::-webkit-details-marker { display: none; }
    .ws-details > summary:hover { opacity: 1; }
    .ws-details .chevron { display: inline-block; transition: transform 0.2s; font-size: 10px; }
    .ws-details[open] .chevron { transform: rotate(180deg); }
    .ws-think {
      margin-top: 6px; padding: 7px 8px;
      background: rgba(0,0,0,0.06); border-radius: 6px;
      font-size: 10.5px; font-family: "IBM Plex Mono", Consolas, monospace;
      color: var(--ink); line-height: 1.5; white-space: pre-wrap; word-break: break-word;
    }
    .freshness-badge {
      display: inline-block; font-size: 9px; font-family: "IBM Plex Mono", Consolas, monospace;
      padding: 1px 6px; border-radius: 999px; font-weight: 700; margin-left: 6px; vertical-align: middle;
    }
    .freshness-badge.fresh  { background: rgba(64,177,133,0.2); color: #1e6a4f; border: 1px solid rgba(64,177,133,0.35); }
    .freshness-badge.warm   { background: rgba(210,165,40,0.2);  color: #7a5a00; border: 1px solid rgba(210,165,40,0.35); }
    .freshness-badge.stale  { background: rgba(219,114,96,0.2);  color: #8a3b30; border: 1px solid rgba(219,114,96,0.35); }
    .details-panel > summary {
      list-style: none;
      cursor: pointer;
      padding: 10px;
      border-bottom: 1px solid var(--line);
      font-size: 13px;
      text-transform: uppercase;
      font-family: "IBM Plex Mono", Consolas, monospace;
      user-select: none;
    }
    .details-panel > summary::-webkit-details-marker { display: none; }

    /* ── Leadership Pipeline ───────────────────────────────────── */
    .lp-panel { margin-bottom: 12px; position: relative; overflow: hidden; }
    .lp-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--line); }
    .lp-header h2 { margin: 0; font-size: 13px; text-transform: uppercase; font-family: "IBM Plex Mono", Consolas, monospace; }
    .lp-progress { display: flex; align-items: center; gap: 10px; }
    .lp-pct-ring {
      width: 52px; height: 52px; position: relative;
    }
    .lp-pct-ring svg { width: 52px; height: 52px; transform: rotate(-90deg); }
    .lp-pct-ring .ring-bg { fill: none; stroke: rgba(80,103,121,0.15); stroke-width: 5; }
    .lp-pct-ring .ring-fg { fill: none; stroke: #22c27e; stroke-width: 5; stroke-linecap: round; transition: stroke-dashoffset 0.8s ease, stroke 0.4s; }
    .lp-pct-text {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
      font-family: "IBM Plex Mono", Consolas, monospace; font-size: 13px; font-weight: 700; color: var(--ink);
    }
    .lp-chain {
      display: flex; align-items: center; justify-content: center;
      gap: 0; padding: 18px 10px 14px; flex-wrap: wrap;
    }
    .lp-node {
      flex: 0 1 180px; border-radius: 12px; border: 2px solid var(--line);
      background: var(--card); padding: 10px 12px; text-align: center;
      transition: border-color 0.4s, box-shadow 0.4s, transform 0.3s;
      position: relative; z-index: 1;
    }
    .lp-node.active { border-color: rgba(34,194,126,0.7); box-shadow: 0 0 18px rgba(34,194,126,0.25); }
    .lp-node.flash { animation: nodeFlash 0.6s ease; }
    .lp-node-emoji { font-size: 26px; margin-bottom: 2px; }
    .lp-node-name {
      font-family: "IBM Plex Mono", Consolas, monospace; font-size: 12px;
      font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .lp-node-role { font-size: 10px; color: var(--muted); margin-top: 1px; }
    .lp-node-status {
      margin-top: 4px; font-size: 11px; font-family: "IBM Plex Mono", Consolas, monospace;
      color: var(--muted); min-height: 15px;
    }
    @keyframes nodeFlash {
      0% { transform: scale(1); box-shadow: 0 0 0 rgba(34,194,126,0); }
      30% { transform: scale(1.06); box-shadow: 0 0 28px rgba(34,194,126,0.5); }
      100% { transform: scale(1); box-shadow: 0 0 18px rgba(34,194,126,0.25); }
    }
    .lp-arrow {
      flex: 0 0 60px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; position: relative;
      height: 50px;
    }
    .lp-arrow-line {
      width: 40px; height: 3px; background: rgba(120,140,160,0.25);
      border-radius: 2px; position: relative; overflow: hidden;
    }
    .lp-arrow-line::after {
      content: ""; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, #22c27e, transparent);
      transform: translateX(-110%); transition: none;
    }
    .lp-arrow.active .lp-arrow-line { background: rgba(34,194,126,0.35); }
    .lp-arrow.active .lp-arrow-line::after { animation: arrowTravel 1.2s ease-in-out; }
    .lp-arrow-tip {
      font-size: 16px; color: rgba(120,140,160,0.4); line-height: 1;
      transition: color 0.3s;
    }
    .lp-arrow.active .lp-arrow-tip { color: #22c27e; }
    .lp-arrow-label {
      font-size: 9px; color: var(--muted); font-family: "IBM Plex Mono", Consolas, monospace;
      text-align: center; margin-top: 2px; max-width: 70px; line-height: 1.1;
    }
    @keyframes arrowTravel {
      0% { transform: translateX(-110%); }
      100% { transform: translateX(110%); }
    }

    /* ── Message Feed ──────────────────────────────────────────── */
    .lp-feed {
      padding: 8px 14px 12px; max-height: 180px; overflow-y: auto;
      display: flex; flex-direction: column; gap: 5px;
    }
    .lp-msg {
      display: flex; align-items: flex-start; gap: 8px;
      font-size: 11px; font-family: "IBM Plex Mono", Consolas, monospace;
      padding: 5px 8px; border-radius: 8px;
      background: rgba(222, 237, 247, 0.5); border: 1px solid rgba(89,124,148,0.15);
      animation: msgSlideIn 0.4s ease;
    }
    .lp-msg-icon { font-size: 14px; flex-shrink: 0; margin-top: 1px; }
    .lp-msg-from { font-weight: 700; white-space: nowrap; }
    .lp-msg-text { color: var(--muted); line-height: 1.35; }
    .lp-msg-time { margin-left: auto; white-space: nowrap; color: rgba(80,103,121,0.5); font-size: 10px; }
    .lp-msg.new { background: rgba(34,194,126,0.12); border-color: rgba(34,194,126,0.3); }
    @keyframes msgSlideIn {
      0% { opacity: 0; transform: translateX(-12px); }
      100% { opacity: 1; transform: translateX(0); }
    }

    /* ── Request Flash Overlay ─────────────────────────────────── */
    .req-flash-container {
      position: fixed; top: 0; left: 0; right: 0;
      pointer-events: none; z-index: 9999;
      display: flex; flex-direction: column; align-items: center;
      padding-top: 80px; gap: 8px;
    }
    .req-flash {
      pointer-events: none;
      background: linear-gradient(135deg, rgba(0,30,60,0.95), rgba(0,70,140,0.92));
      border: 2px solid #00d4ff;
      border-radius: 16px; padding: 18px 32px;
      color: #fff; text-align: center;
      box-shadow: 0 0 60px rgba(0,212,255,0.4), 0 20px 40px rgba(0,0,0,0.3);
      animation: reqFlashIn 0.4s ease, reqFlashOut 0.5s ease 2.5s forwards;
    }
    .req-flash-emoji { font-size: 40px; margin-bottom: 4px; }
    .req-flash-title {
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 16px; font-weight: 800; letter-spacing: 0.08em;
      text-transform: uppercase; color: #00d4ff;
    }
    .req-flash-detail {
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 12px; color: rgba(200,230,255,0.8); margin-top: 4px;
    }
    .req-flash-model {
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 11px; color: rgba(180,220,255,0.6); margin-top: 2px;
    }
    @keyframes reqFlashIn {
      0% { opacity: 0; transform: scale(0.7) translateY(-20px); }
      60% { opacity: 1; transform: scale(1.05) translateY(0); }
      100% { transform: scale(1); }
    }
    @keyframes reqFlashOut {
      0% { opacity: 1; transform: scale(1); }
      100% { opacity: 0; transform: scale(0.9) translateY(-10px); }
    }

    /* ── Worker card flash on request ──────────────────────────── */
    .ws-card.req-pulse {
      animation: wsReqPulse 1.5s ease;
    }
    @keyframes wsReqPulse {
      0% { box-shadow: 0 0 0 rgba(0,212,255,0); }
      20% { box-shadow: 0 0 30px rgba(0,212,255,0.6), inset 0 0 20px rgba(0,212,255,0.15); }
      100% { box-shadow: 0 0 0 rgba(0,212,255,0); }
    }

    @media (max-width: 720px) {
      .lp-chain { flex-direction: column; align-items: center; }
      .lp-arrow { flex: 0 0 30px; height: 30px; }
      .lp-arrow-line { width: 3px; height: 20px; }
      .lp-arrow-tip { transform: rotate(90deg); }
    }

    /* ── Activity Pulse ────────────────────────────────────────── */
    .pulse-panel { margin-bottom: 12px; overflow: hidden; }
    .pulse-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 10px 14px; border-bottom: 1px solid var(--line);
    }
    .pulse-header h2 {
      margin: 0; font-size: 13px; text-transform: uppercase;
      font-family: "IBM Plex Mono", Consolas, monospace;
    }
    .pulse-header .pulse-live-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #22c27e;
      animation: pulseDot 1.6s ease-in-out infinite; margin-right: 6px; display: inline-block;
    }
    @keyframes pulseDot { 0%,100% { opacity: .5; transform: scale(.85); } 50% { opacity: 1; transform: scale(1.15); } }
    .pulse-grid {
      display: grid; gap: 0;
      grid-template-columns: repeat(5, 1fr);
      padding: 0;
    }
    @media (max-width: 900px) { .pulse-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 560px) { .pulse-grid { grid-template-columns: 1fr 1fr; } }
    .pulse-cell {
      padding: 14px 16px; border-right: 1px solid var(--line);
      border-bottom: 1px solid var(--line); position: relative;
    }
    .pulse-cell:last-child { border-right: none; }
    .pulse-cell-label {
      font-family: "IBM Plex Mono", Consolas, monospace;
      font-size: 10px; text-transform: uppercase; color: var(--muted);
      letter-spacing: 0.06em; margin-bottom: 4px;
    }
    .pulse-cell-value {
      font-size: 28px; font-weight: 800; line-height: 1.1;
      font-family: "Space Grotesk", sans-serif; color: var(--ink);
    }
    .pulse-cell-value .plus { color: #1e8a5f; }
    .pulse-cell-value .minus { color: #b34040; }
    .pulse-cell-value .dim { font-size: 14px; font-weight: 500; color: var(--muted); }
    .pulse-cell-sub {
      margin-top: 3px; font-size: 10px; color: var(--muted);
      font-family: "IBM Plex Mono", Consolas, monospace; line-height: 1.3;
    }
    .pulse-workers {
      padding: 10px 14px; border-top: 1px solid var(--line);
      display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    }
    .pulse-worker-chip {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 4px 10px; border-radius: 999px; font-size: 11px;
      font-family: "IBM Plex Mono", Consolas, monospace;
      background: rgba(34,194,126,0.12); border: 1px solid rgba(34,194,126,0.3); color: #1a6b47;
    }
    .pulse-worker-chip .pw-dot {
      width: 6px; height: 6px; border-radius: 50%; background: #22c27e;
      animation: pulseDot 1.6s ease-in-out infinite;
    }
    .pulse-worker-chip.idle { background: rgba(120,140,160,0.1); border-color: rgba(120,140,160,0.25); color: var(--muted); }
    .pulse-worker-chip.idle .pw-dot { background: #8a9daa; animation: none; }
    .pulse-commits {
      padding: 8px 14px 10px; border-top: 1px solid var(--line);
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .pulse-commit {
      font-size: 10px; font-family: "IBM Plex Mono", Consolas, monospace;
      color: var(--muted); background: rgba(222,237,247,0.6);
      padding: 3px 8px; border-radius: 6px; border: 1px solid rgba(89,124,148,0.12);
      max-width: 300px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .pulse-commit strong { color: var(--ink); font-weight: 600; }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-head">
        <h1>BOX Mission Control</h1>
        <div class="hero-live" id="hero-live"><span id="hero-live-text">All Systems Operational</span></div>
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <button id="daemon-start-btn" class="action-btn" type="button" style="background:#0d3320;border-color:#00ff88;color:#00ff88;font-size:13px;padding:5px 14px;font-weight:600">Start Daemon</button>
        <button id="daemon-stop-btn" class="action-btn" type="button" style="background:#3a1c1c;border-color:#ff4444;font-size:13px;padding:5px 14px">Stop Daemon</button>
        <span id="daemon-status-text" class="muted" style="font-size:12px"></span>
      </div>
      <p id="meta">Connecting...</p>
    </section>

    <!-- Activity Pulse — Real-time simplified view -->
    <section class="panel pulse-panel" id="pulse-panel">
      <div class="pulse-header">
        <h2><span class="pulse-live-dot"></span> Activity Pulse</h2>
        <span style="font-size:10px;color:var(--muted);font-family:'IBM Plex Mono',monospace" id="pulse-updated">—</span>
      </div>
      <div class="pulse-grid">
        <div class="pulse-cell">
          <div class="pulse-cell-label">Commits Today</div>
          <div class="pulse-cell-value" id="pulse-commits">0</div>
          <div class="pulse-cell-sub" id="pulse-commits-sub">total: 0</div>
        </div>
        <div class="pulse-cell">
          <div class="pulse-cell-label">Lines Written</div>
          <div class="pulse-cell-value" id="pulse-lines"><span class="plus">+0</span> <span class="dim">/</span> <span class="minus">-0</span></div>
          <div class="pulse-cell-sub" id="pulse-files-sub">0 files changed</div>
        </div>
        <div class="pulse-cell">
          <div class="pulse-cell-label">Premium Requests</div>
          <div class="pulse-cell-value" id="pulse-premium">0</div>
          <div class="pulse-cell-sub" id="pulse-premium-sub">this month</div>
        </div>
        <div class="pulse-cell">
          <div class="pulse-cell-label">Copilot Used</div>
          <div class="pulse-cell-value" id="pulse-copilot">0 <span class="dim">/ 1500</span></div>
          <div class="pulse-cell-sub" id="pulse-copilot-sub">loading...</div>
        </div>
        <div class="pulse-cell">
          <div class="pulse-cell-label">Workers</div>
          <div class="pulse-cell-value" id="pulse-workers-count">0 <span class="dim">active</span></div>
          <div class="pulse-cell-sub" id="pulse-workers-sub">idle</div>
        </div>
      </div>
      <div class="pulse-workers" id="pulse-workers-list"></div>
      <div class="pulse-commits" id="pulse-recent-commits"></div>
    </section>

    <!-- Celebration Banner (hidden until all tasks pass) -->
    <section id="celebration-banner" style="display:none;text-align:center;padding:32px 20px;margin-bottom:16px;border-radius:12px;background:linear-gradient(135deg,#0a2a1a 0%,#0d3320 40%,#1a4a2e 100%);border:2px solid #00ff88;position:relative;overflow:hidden">
      <div id="celebration-particles" style="position:absolute;inset:0;pointer-events:none;overflow:hidden"></div>
      <div style="position:relative;z-index:1">
        <div style="font-size:48px;margin-bottom:8px" id="celebration-emoji">🎉</div>
        <h2 style="font-size:28px;font-weight:800;color:#00ff88;margin:0 0 8px 0;letter-spacing:1px" id="celebration-title">TARGET REPO READY</h2>
        <p style="font-size:16px;color:#b0ffd0;margin:0 0 4px 0" id="celebration-repo">—</p>
        <p style="font-size:13px;color:#7ac9a0;margin:0" id="celebration-detail">All tasks completed successfully</p>
      </div>
    </section>

    <section class="grid">
      <article class="card"><div class="k">Project</div><div class="v" id="m-project">-</div><div class="sub" id="m-role-head">CEO: - | Lead: -</div></article>
      <article class="card"><div class="k">Mode / Stage</div><div class="v" id="m-mode">-</div><div class="sub" id="m-mode-sub">stage: -</div></article>
      <article class="card"><div class="k">Active Target</div><div class="v" id="m-target">-</div><div class="sub" id="m-target-sub">waiting: -</div></article>
      <article class="card"><div class="k">Tasks Total</div><div class="v" id="m-tasks">0</div><div class="sub" id="m-tasks-sub">queued: 0 | running: 0</div></article>
      <article class="card"><div class="k">Workers Active</div><div class="v" id="m-qr">0 / 0</div><div class="sub" id="m-qr-sub">working / total</div></article>
      <article class="card"><div class="k">Passed / Failed</div><div class="v" id="m-pf">0 / 0</div></article>
      <article class="card"><div class="k">Premium Req. Estimate</div><div class="v" id="m-premium">-</div><div class="sub" id="m-premium-sub">for current project</div></article>
      <article class="card"><div class="k">Copilot Quota Left</div><div class="v" id="m-copilot">0</div><div class="sub" id="m-copilot-sub">used: 0%</div></article>
      <article class="card"><div class="k">Code Delta (Project)</div><div class="v" id="m-delta">+0 / -0</div><div class="sub" id="m-delta-sub">from worker runs</div></article>
      <article class="card">
        <div class="k">Task Flow</div>
        <div class="sub">Queued -> Running -> Passed/Failed</div>
        <div class="status-wrap">
          <div class="status-bar" id="status-bar"></div>
          <div class="legend" id="status-legend"></div>
        </div>
      </article>
      <article class="card"><div class="k">Alerts</div><div class="v" id="m-alerts">0</div><div class="sub" id="m-alerts-sub">no alerts</div></article>
    </section>

    <!-- Leadership Pipeline: Janus → Prometheus → Athena → Workers -->
    <section class="panel lp-panel" id="lp-panel">
      <div class="lp-header">
        <h2>Leadership Pipeline</h2>
        <div class="lp-progress">
          <div class="lp-pct-ring" id="lp-pct-ring">
            <svg viewBox="0 0 52 52">
              <circle class="ring-bg" cx="26" cy="26" r="22"/>
              <circle class="ring-fg" id="lp-ring-fg" cx="26" cy="26" r="22"
                stroke-dasharray="138.23" stroke-dashoffset="138.23"/>
            </svg>
            <div class="lp-pct-text" id="lp-pct-text">0%</div>
          </div>
          <span style="font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace" id="lp-pct-label">0 / 0 tasks</span>
        </div>
      </div>
      <div class="lp-chain" id="lp-chain">
        <!-- Janus -->
        <div class="lp-node" id="lp-node-janus" data-entity="janus">
          <div class="lp-node-emoji">⚡</div>
          <div class="lp-node-name">Janus</div>
          <div class="lp-node-role">CEO Supervisor</div>
          <div class="lp-node-status" id="lp-janus-status">—</div>
        </div>
        <div class="lp-arrow" id="lp-arrow-jt">
          <div style="display:flex;align-items:center;gap:2px">
            <div class="lp-arrow-line"></div>
            <span class="lp-arrow-tip">▸</span>
          </div>
          <div class="lp-arrow-label" id="lp-arrow-jt-label">—</div>
        </div>
        <!-- Prometheus -->
        <div class="lp-node" id="lp-node-prometheus" data-entity="prometheus">
          <div class="lp-node-emoji">📊</div>
          <div class="lp-node-name">Prometheus</div>
          <div class="lp-node-role">Deep Planner</div>
          <div class="lp-node-status" id="lp-prometheus-status">—</div>
        </div>
        <div class="lp-arrow" id="lp-arrow-tm">
          <div style="display:flex;align-items:center;gap:2px">
            <div class="lp-arrow-line"></div>
            <span class="lp-arrow-tip">▸</span>
          </div>
          <div class="lp-arrow-label" id="lp-arrow-tm-label">—</div>
        </div>
        <!-- Athena -->
        <div class="lp-node" id="lp-node-Athena" data-entity="Athena">
          <div class="lp-node-emoji">📋</div>
          <div class="lp-node-name">Athena</div>
          <div class="lp-node-role">Lead Manager</div>
          <div class="lp-node-status" id="lp-Athena-status">—</div>
        </div>
        <div class="lp-arrow" id="lp-arrow-mw">
          <div style="display:flex;align-items:center;gap:2px">
            <div class="lp-arrow-line"></div>
            <span class="lp-arrow-tip">▸</span>
          </div>
          <div class="lp-arrow-label" id="lp-arrow-mw-label">—</div>
        </div>
        <!-- Workers -->
        <div class="lp-node" id="lp-node-workers" data-entity="workers">
          <div class="lp-node-emoji">👷</div>
          <div class="lp-node-name">Workers</div>
          <div class="lp-node-role">Execution Team</div>
          <div class="lp-node-status" id="lp-workers-status">—</div>
        </div>
      </div>
      <!-- Message Feed -->
      <div class="lp-feed" id="lp-feed">
        <div class="muted" style="font-size:11px;text-align:center">Waiting for leadership activity...</div>
      </div>
    </section>

    <!-- Request Flash Container (fixed overlay) -->
    <div class="req-flash-container" id="req-flash-container"></div>

    <!-- Workers Live Grid -->
    <section class="panel workers-live">
      <h2>Workers — Live Status</h2>
      <div class="worker-grid" id="worker-grid">
        <div class="muted" style="padding:6px">No worker data yet</div>
      </div>
    </section>

    <section class="panel" style="margin-bottom:12px">
      <h2>Prometheus Plan Board — Live + History</h2>
      <div id="prometheus-plan-meta" class="muted" style="padding:0 10px 8px 10px">Awaiting Prometheus plan snapshots...</div>
      <div id="prometheus-plan-tabs" class="prometheus-tabs"></div>
      <div id="prometheus-plan-list" class="prometheus-plan-list">
        <div class="muted">No plans yet</div>
      </div>
    </section>

    <!-- Premium Usage by Worker -->
    <section class="panel" style="margin-bottom:12px">
      <h2>💎 Premium Request Usage — Per Worker (Live)</h2>
      <div id="premium-usage-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px;margin-top:8px">
        <div class="muted" style="padding:6px">No premium usage data yet</div>
      </div>
      <div id="premium-usage-timeline" style="margin-top:12px;max-height:200px;overflow-y:auto;font-size:11px;font-family:'IBM Plex Mono',monospace;color:var(--muted)">
      </div>
    </section>

    <!-- Leadership Chain (advanced detail) -->
    <details class="panel details-panel" style="margin-bottom:12px">
      <summary>Advanced: Leadership Chain Detail</summary>
      <section class="chain" style="padding:8px">
        <article class="chain-box user">
          <h2 class="chain-title">User (You)</h2>
          <div class="chain-body">
            <div id="user-overview">System Overview</div>
            <div id="user-blocked">Blocked Tasks: -</div>
            <div id="user-queue">Queue: 0 Tasks</div>
          </div>
        </article>
        <article class="chain-box janus">
          <h2 class="chain-title">Janus (Central Monitor)</h2>
          <div class="chain-body">
            <div id="janus-status">System Status: -</div>
            <div id="janus-action">Next Action: -</div>
            <div id="janus-blocked">Blocked Task Alerts: 0</div>
            <div id="janus-queue">Queue Length: 0</div>
            <details style="margin-top:6px">
              <summary style="cursor:pointer;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace">AI Reasoning ▾</summary>
              <div id="janus-reasoning" style="margin-top:4px;font-size:11px;font-family:'IBM Plex Mono',monospace;white-space:pre-wrap;color:#2a4a5e;background:rgba(200,225,245,0.45);border-radius:6px;padding:6px;max-height:180px;overflow-y:auto">Awaiting AI analysis...</div>
            </details>
          </div>
        </article>
        <article class="chain-box Athena">
          <h2 class="chain-title">Athena (Lead Worker Manager)</h2>
          <div class="chain-body">
            <div>Worker Coordination</div>
            <div id="Athena-counts">Status: awaiting...</div>
            <div id="Athena-gates">Completed: 0 tasks</div>
            <details style="margin-top:6px">
              <summary style="cursor:pointer;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace">Coordination Report ▾</summary>
              <div id="Athena-statusreport" style="margin-top:4px;font-size:11px;font-family:'IBM Plex Mono',monospace;white-space:pre-wrap;color:#2a4a5e;background:rgba(200,225,245,0.45);border-radius:6px;padding:6px;max-height:180px;overflow-y:auto">Awaiting Athena coordination...</div>
              <div id="Athena-tasksplanned" style="margin-top:4px;font-size:10px;color:var(--muted);font-family:'IBM Plex Mono',monospace"></div>
            </details>
          </div>
        </article>
        <article class="chain-box" style="border-left:4px solid #d4a017;background:rgba(212,160,23,0.08)">
          <h2 class="chain-title" style="color:#b8860b">Prometheus (Deep Planner)</h2>
          <div class="chain-body">
            <div id="prometheus-health">Not yet analyzed</div>
            <div id="prometheus-requests" style="margin-top:4px;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace">Estimated Premium Requests: awaiting...</div>
            <details style="margin-top:6px">
              <summary style="cursor:pointer;font-size:11px;color:var(--muted);font-family:'IBM Plex Mono',monospace">Full Analysis ▾</summary>
              <div id="prometheus-analysis" style="margin-top:4px;font-size:11px;font-family:'IBM Plex Mono',monospace;white-space:pre-wrap;color:#2a2a0e;background:rgba(212,160,23,0.12);border-radius:6px;padding:6px;max-height:200px;overflow-y:auto">Awaiting Prometheus deep analysis...</div>
            </details>
          </div>
        </article>
        <article class="chain-box workers">
          <h2 class="chain-title">Workers</h2>
          <div class="chain-body">
            <div id="workers-chips" class="worker-chips"></div>
          </div>
        </article>
      </section>
    </details>

    <section class="panel" style="margin-bottom:12px">
      <h2>Recovery Control</h2>
      <div style="padding:10px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
        <div class="muted" id="recovery-summary">No recovery summary yet</div>
        <button id="force-rebase-btn" class="action-btn" type="button">Force Rebase</button>
      </div>
      <details class="details-panel" open>
        <summary>Recovery Output</summary>
        <pre id="recovery-detail">Recovery output waiting...</pre>
      </details>
    </section>

    <section class="rows">
      <div class="panel">
        <h2>Task Snapshot (Deduplicated)</h2>
        <div class="task-table-wrap" tabindex="0" aria-label="Task Snapshot table scroll area">
          <table>
            <thead><tr><th>Role</th><th>Status</th><th>Task</th><th>Gate</th></tr></thead>
            <tbody id="tasks-body"><tr><td colspan="4" class="muted">Waiting for data</td></tr></tbody>
          </table>
        </div>
      </div>
      <div class="panel">
        <h2>Model Usage</h2>
        <table>
          <thead><tr><th>Source</th><th>Metric</th><th>Value</th></tr></thead>
          <tbody id="usage-body"><tr><td colspan="3" class="muted">Waiting for data</td></tr></tbody>
        </table>
      </div>
    </section>

    <details class="panel details-panel" style="margin-bottom:12px">
      <summary>Advanced: Worker Activity</summary>
      <div class="activity-card" id="worker-activity">
        <div class="muted" style="padding:6px">No active workers</div>
      </div>
    </details>

    <details class="panel details-panel" style="margin-bottom:12px">
      <summary>Advanced: AI Calls and Docker</summary>
      <section class="rows" style="padding:10px;">
        <div class="panel" style="box-shadow:none">
          <h2>Recent AI Calls</h2>
          <div class="calls-toolbar">
            <button id="calls-toggle" class="calls-btn" type="button">Show more</button>
          </div>
          <table>
            <thead><tr><th>When</th><th>Source</th><th>Task</th><th>Model</th><th>Detail</th></tr></thead>
            <tbody id="calls-body"><tr><td colspan="5" class="muted">No calls yet</td></tr></tbody>
          </table>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Docker Services</h2>
          <table>
            <thead><tr><th>Service</th><th>Name</th><th>Role</th><th>Layer</th><th>State</th><th>Status</th></tr></thead>
            <tbody id="docker-body"><tr><td colspan="6" class="muted">No service data</td></tr></tbody>
          </table>
        </div>
      </section>
    </details>

    <details class="panel details-panel" style="margin-bottom:12px">
      <summary>Advanced: Issues, Alerts, and Runtime Logs</summary>
      <section style="padding:10px;display:grid;gap:10px;">
        <div class="panel" style="box-shadow:none">
          <h2>Issue Handoffs</h2>
          <table>
            <thead><tr><th>Issue</th><th>Status</th><th>Worker</th><th>Running Task</th><th>Summary</th></tr></thead>
            <tbody id="issues-body"><tr><td colspan="5" class="muted">No issue handoffs yet</td></tr></tbody>
          </table>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Autonomy Alerts</h2>
          <table>
            <thead><tr><th>When</th><th>Severity</th><th>Message</th></tr></thead>
            <tbody id="alerts-body"><tr><td colspan="3" class="muted">No alerts</td></tr></tbody>
          </table>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Worker Optimization Suggestions</h2>
          <table>
            <thead><tr><th>When</th><th>Worker</th><th>Suggestion</th><th>PR/Branch</th></tr></thead>
            <tbody id="suggestions-body"><tr><td colspan="4" class="muted">No suggestions</td></tr></tbody>
          </table>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Copilot Live Detail</h2>
          <pre id="copilot-live-detail">Worker detayi yukleniyor...</pre>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Live Runtime Log (state/progress.txt tail)</h2>
          <pre id="log-view">Waiting for log stream...</pre>
        </div>
        <div class="panel" style="box-shadow:none">
          <h2>Active Target Session Log</h2>
          <pre id="target-log-view">No active target session log.</pre>
        </div>
      </section>
    </details>
  </main>

  <script>
    let latestState = null;
    let selectedTaskId = null;
    let showAllCalls = false;
    let selectedPrometheusPlanKey = null;
    let prometheusPlanUserSelected = false;
    let prometheusPlanFingerprint = '';

    // ── Change detection state ────────────────────────────────
    var prevJanusDecidedAt = null;
    var prevPrometheusAnalyzedAt = null;
    var prevAthenaCoordinatedAt = null;
    var prevTotalPremiumReqs = 0;
    var prevWorkerStatuses = {};
    var prevPremiumByWorker = {};
    var leadershipMessages = [];
    var LP_MSG_LIMIT = 25;

    function esc(v) {
      var value = (v === null || v === undefined) ? "" : v;
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function pick(obj, key, fallback) {
      if (!obj || obj[key] === undefined || obj[key] === null) {
        return fallback;
      }
      return obj[key];
    }

    function formatUsd(value) {
      var n = Number(value || 0);
      if (!Number.isFinite(n)) {
        return "0";
      }
      return n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }

    function formatRequestCount(value) {
      var n = Number(value || 0);
      if (!Number.isFinite(n)) {
        return '0';
      }
      var roundedInt = Math.round(n);
      if (Math.abs(n - roundedInt) < 0.000001) {
        return String(roundedInt);
      }
      return n.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
    }

    function badge(status) {
      const s = String(status || "other").toLowerCase();
      const klass = ["queued", "running", "passed", "failed"].includes(s) ? s : "queued";
      return '<span class="badge ' + klass + '">' + esc(s) + '</span>';
    }

    function renderRows(rows, cols) {
      if (!rows.length) {
        return '<tr><td colspan="' + cols + '" class="muted">No data</td></tr>';
      }
      return rows.join("");
    }

    function buildRoleLayerMap(roleRegistry) {
      var map = {};
      var workers = roleRegistry && roleRegistry.workers ? roleRegistry.workers : {};
      if (roleRegistry && roleRegistry.ceo) {
        map[String(roleRegistry.ceo)] = 'Executive';
      }
      if (roleRegistry && roleRegistry.lead) {
        map[String(roleRegistry.lead)] = 'Lead';
      }

      function addWorkerLayer(workerKey, layer) {
        var workerObj = workers[workerKey] || {};
        var name = String(workerObj.name || '').trim();
        if (name) {
          map[name] = layer;
        }
      }

      addWorkerLayer('backend', 'Domain-Backend');
      addWorkerLayer('frontend', 'Domain-Frontend');
      addWorkerLayer('api', 'Domain-API');
      addWorkerLayer('integration', 'Domain-Integration');
      addWorkerLayer('test', 'Verification-Test');
      addWorkerLayer('qa', 'Verification-QA');
      addWorkerLayer('devops', 'Ops-DevOps');
      addWorkerLayer('security', 'Ops-Security');

      return map;
    }

    function roleLayer(roleName, roleLayerMap) {
      var key = String(roleName || '').trim();
      if (!key) {
        return '-';
      }
      return roleLayerMap[key] || 'Unmapped';
    }

    function expectedRoleByKind(kind, roleRegistry) {
      var k = String(kind || 'default').toLowerCase();
      var workers = roleRegistry && roleRegistry.workers ? roleRegistry.workers : {};
      var lead = String((roleRegistry && roleRegistry.lead) || '-');

      function pickName(workerKey) {
        return String((workers[workerKey] && workers[workerKey].name) || '').trim();
      }

      var map = {
        production: pickName('security') || pickName('devops') || lead,
        stability: pickName('backend') || lead,
        quality: pickName('test') || pickName('qa') || lead,
        refactor: pickName('integration') || lead,
        frontend: pickName('frontend') || lead,
        backend: pickName('backend') || lead,
        api: pickName('api') || lead,
        integration: pickName('integration') || lead,
        test: pickName('test') || lead,
        qa: pickName('qa') || lead,
        devops: pickName('devops') || lead,
        security: pickName('security') || lead,
        default: lead
      };

      return map[k] || map.default || '-';
    }

    function renderWorkerActivity(activity, taskInsights, roleLayerMap) {
      var container = document.getElementById("worker-activity");
      var slots = Object.keys(activity || {});
      if (!slots.length) {
        container.innerHTML = '<div class="muted" style="padding:6px">Worker calismiyor</div>';
        return;
      }

      function findInsightByTaskId(taskId) {
        var insights = taskInsights || {};
        var keys = Object.keys(insights);
        for (var i = 0; i < keys.length; i += 1) {
          var item = insights[String(keys[i])] || {};
          if (Number(item.taskId || 0) === Number(taskId || 0)) {
            return item;
          }
        }
        return null;
      }

      var html = slots.map(function(slot) {
        var w = activity[slot] || {};
        var taskId = Number(w.taskId || 0);
        var insight = findInsightByTaskId(taskId) || {};
        var roleName = String(insight.assignedRole || w.roleName || "").trim();
        var headerLabel = roleName || slot;
        var phase = String(w.phase || "idle").toLowerCase();
        var phaseClass = "phase-" + phase.replace(/[^a-z0-9-]/g, "-");
        var isRunning = ["preparing", "routing", "model-selection", "coding", "reviewing"].includes(phase);
        var statusLabel = isRunning ? "Working" : "Idle";
        var taskLine = taskId ? ("Task #" + esc(taskId) + ": " + esc(w.taskTitle || "-")) : "No task assigned";
        var linesAdded = Number(insight.linesAdded || 0);
        var linesDeleted = Number(insight.linesDeleted || 0);
        var logPreview = String(insight.liveLogTail || insight.responsePreview || "").trim();
        if (!logPreview || logPreview === "-") {
          logPreview = String(w.phaseDetail || "Waiting for logs...");
        }
        var logLines = logPreview.split(/\\r?\\n/).slice(-6).join("\\n");

        return '<div class="activity-worker">' +
          '<div class="aw-header"><span class="aw-slot">' + esc(headerLabel) + '<span class="aw-slot-sub">slot:' + esc(slot) + '</span></span><span class="aw-phase ' + phaseClass + '">' + esc(statusLabel) + '</span></div>' +
          '<div class="aw-detail">' + taskLine + '</div>' +
            '<div class="aw-detail">Lines: +' + String(linesAdded) + ' / -' + String(linesDeleted) + '</div>' +
            '<div class="aw-meta">role=' + esc(insight.assignedRole || w.roleName || "-") + ' | layer=' + esc(roleLayer(insight.assignedRole || w.roleName || "", roleLayerMap)) + ' | agent=' + esc(insight.selectedAgent || w.agent || "-") + '</div>' +
            '<div class="aw-meta">model=' + esc(w.model || "-") + (w.updatedAt ? ' | updated=' + esc(w.updatedAt) : '') + '</div>' +
          '<pre style="margin-top:6px;max-height:120px;overflow:auto;">' + esc(logLines) + '</pre>' +
          '</div>';
      }).join("");
      container.innerHTML = html;
    }

    function renderTaskDetail() {
      if (!latestState || !latestState.taskInsights) {
        return;
      }

      var keys = Object.keys(latestState.taskInsights || {});
      if (!keys.length) {
        document.getElementById("copilot-live-detail").textContent = "Copilot detayi henuz yok.";
        return;
      }

      var runningKey = keys.find(function(key) {
        var item = latestState.taskInsights[String(key)] || {};
        return String(item.status || "").toLowerCase() === "running";
      });

      // Keep the detail panel locked on the live running task while work is in progress.
      if (runningKey) {
        selectedTaskId = Number(runningKey);
      } else if (!selectedTaskId || !latestState.taskInsights[String(selectedTaskId)]) {
        selectedTaskId = Number(keys[0]);
      }

      var insight = latestState.taskInsights[String(selectedTaskId)];
      if (!insight) {
        return;
      }

      var isActive = String(insight.status || "").toLowerCase() === "running" || String(insight.phase || "").toLowerCase() === "coding";
      var liveText = String(
        insight.liveLogTail ||
        insight.responsePreview ||
        insight.stderrTail ||
        insight.stdoutTail ||
        insight.phaseDetail ||
        ""
      ).trim();
      if (!liveText || liveText === "-") {
        liveText = "Live output su an yok. Worker clone/prompt/coding asamasinda olabilir. Birazdan otomatik guncellenir.";
      }

      var phaseLabel = String(insight.phase || "-");

      document.getElementById("copilot-live-detail").textContent = [
        "Active: " + (isActive ? "YES" : "NO"),
        "Phase: " + phaseLabel,
        "Task: #" + String(insight.taskId || "-") + " - " + String(insight.title || "-"),
        "Lines Written: +" + String(Number(insight.linesAdded || 0)) + " / -" + String(Number(insight.linesDeleted || 0)),
        "",
        "Live Output:",
        liveText
      ].join("\\n");
    }

    function normalizeWorkerStatus(statusRaw) {
      var status = String(statusRaw || '').toLowerCase();
      if (status === 'running' || status === 'active') {
        return 'Running';
      }
      if (status === 'blocked' || status === 'failed') {
        return 'Blocked';
      }
      if (status === 'queued' || status === 'parked') {
        return 'Pending';
      }
      return 'Idle';
    }

    function gateIconFromColor(colorRaw) {
      var color = String(colorRaw || '').toLowerCase();
      if (color === 'red') {
        return '🔴 Red';
      }
      if (color === 'yellow') {
        return '🟡 Yellow';
      }
      return '🟢 Green';
    }

    function statusColor(statusRaw) {
      var status = String(statusRaw || '').toLowerCase();
      if (status === 'blocked' || status === 'failed') {
        return 'red';
      }
      if (status === 'running' || status === 'active' || status === 'queued' || status === 'parked') {
        return 'yellow';
      }
      return 'green';
    }

    function canonicalTaskParts(taskTitle) {
      var parts = String(taskTitle || '').split(' - ').map(function(p) { return p.trim(); }).filter(Boolean);
      var out = [];
      for (var i = 0; i < parts.length; i += 1) {
        var p = String(parts[i] || '').toLowerCase();
        if (!p) {
          continue;
        }
        if (!out.includes(p)) {
          out.push(p);
        }
      }
      return out.slice(0, 3);
    }

    function canonicalTaskText(taskTitle) {
      var parts = canonicalTaskParts(taskTitle);
      return parts.join(' - ');
    }

    function dedupeBlockedTasks(items) {
      var source = Array.isArray(items) ? items : [];
      var seen = {};
      var out = [];
      for (var i = 0; i < source.length; i += 1) {
        var it = source[i] || {};
        var worker = String(it.worker || '-').toLowerCase();
        var taskKey = canonicalTaskText(it.task || '-');
        var key = worker + '|' + taskKey;
        if (seen[key]) {
          continue;
        }
        seen[key] = true;
        out.push({
          ...it,
          task: taskKey || String(it.task || '-')
        });
      }
      return out;
    }

    function buildDedupedTaskRows(tasks, taskInsights, roleRegistry, roleLayerMap) {
      var source = Array.isArray(tasks) ? tasks : [];
      var seen = {};
      var out = [];
      for (var i = 0; i < source.length; i += 1) {
        var t = source[i] || {};
        var insight = (taskInsights || {})[String(t.id)] || {};
        var role = String(insight.assignedRole || t.assignedRole || expectedRoleByKind(t.kind, roleRegistry) || '-');
        var taskText = canonicalTaskText(t.title || '-');
        var key = role.toLowerCase() + '|' + taskText;
        if (seen[key]) {
          continue;
        }
        seen[key] = true;
        out.push({
          id: t.id,
          role: role,
          layer: roleLayer(role, roleLayerMap),
          status: String(t.status || 'unknown').toLowerCase(),
          task: taskText || String(t.title || '-'),
          gateColor: statusColor(t.status)
        });
      }
      return out;
    }

    function relativeTime(isoStr) {
      if (!isoStr) return '—';
      var delta = Date.now() - new Date(isoStr).getTime();
      if (delta < 0) return 'just now';
      var secs = Math.floor(delta / 1000);
      if (secs < 60) return secs + 's ago';
      var mins = Math.floor(secs / 60);
      if (mins < 60) return mins + 'm ago';
      return Math.floor(mins / 60) + 'h ago';
    }

    // ── Leadership Pipeline + Change Detection ─────────────────────────
    function detectLeadershipChanges(data) {
      var changes = { janusNew: false, prometheusNew: false, AthenaNew: false, newWorkers: [], reqFlashes: [], newMessages: [] };
      var janus = (data && data.leadership && data.leadership.janus) || {};
      var prometheus = (data && data.leadership && data.leadership.prometheus) || {};
      var Athena = (data && data.leadership && data.leadership.athena) || {};
      var wa = data && data.workerActivity ? data.workerActivity : {};
      var puBw = (data && data.premiumUsageByWorker && data.premiumUsageByWorker.byWorker) || {};

      // Janus decided
      if (janus.decidedAt && janus.decidedAt !== prevJanusDecidedAt) {
        changes.janusNew = true;
        if (prevJanusDecidedAt) {
          var newMsg = {
            icon: '⚡', from: 'Janus', to: janus.callPrometheus ? 'Prometheus' : 'Athena',
            text: janus.callPrometheus
              ? 'Activate Prometheus for deep analysis: ' + String(janus.prometheusReason || janus.briefForPrometheus || '').slice(0, 100)
              : 'Directive to Athena: ' + String(janus.briefForPrometheus || janus.decision || '').slice(0, 100),
            time: janus.decidedAt, isNew: true
          };
          leadershipMessages.unshift(newMsg);
          changes.newMessages.push(newMsg);
        }
        prevJanusDecidedAt = janus.decidedAt;
      }

      // Prometheus analyzed
      if (prometheus.analyzedAt && prometheus.analyzedAt !== prevPrometheusAnalyzedAt) {
        changes.prometheusNew = true;
        if (prevPrometheusAnalyzedAt) {
          var planCount = Array.isArray(prometheus.plans) ? prometheus.plans.length : 0;
          var newMsg = {
            icon: '📊', from: 'Prometheus', to: 'Athena',
            text: planCount + ' plans created, health: ' + String(prometheus.projectHealth || '?') + ' — ' + String(prometheus.analysis || '').slice(0, 80),
            time: prometheus.analyzedAt, isNew: true
          };
          leadershipMessages.unshift(newMsg);
          changes.newMessages.push(newMsg);
        }
        prevPrometheusAnalyzedAt = prometheus.analyzedAt;
      }

      // Athena coordinated
      if (Athena.coordinatedAt && Athena.coordinatedAt !== prevAthenaCoordinatedAt) {
        changes.AthenaNew = true;
        if (prevAthenaCoordinatedAt) {
          var activeSess = Number(Athena.activeSessions || 0);
          var newMsg = {
            icon: '📋', from: 'Athena', to: 'Workers',
            text: 'Dispatched ' + activeSess + ' workers: ' + String(Athena.summary || Athena.statusReport || '').slice(0, 100),
            time: Athena.coordinatedAt, isNew: true
          };
          leadershipMessages.unshift(newMsg);
          changes.newMessages.push(newMsg);
        }
        prevAthenaCoordinatedAt = Athena.coordinatedAt;
      }

      // Workers changed status (became working)
      Object.keys(wa).forEach(function(name) {
        var st = String((wa[name] || {}).status || '').toLowerCase();
        var prevSt = prevWorkerStatuses[name] || 'idle';
        if (st === 'working' && prevSt !== 'working') {
          changes.newWorkers.push(name);
          var newMsg = {
            icon: '👷', from: 'Athena', to: name,
            text: 'Task assigned: ' + String((wa[name] || {}).lastTask || '').slice(0, 100),
            time: (wa[name] || {}).lastActiveAt || new Date().toISOString(), isNew: true
          };
          leadershipMessages.unshift(newMsg);
          changes.newMessages.push(newMsg);
        }
        prevWorkerStatuses[name] = st;
      });

      // Premium request consumed
      Object.keys(puBw).forEach(function(name) {
        var w = puBw[name] || {};
        var prevCount = prevPremiumByWorker[name] || 0;
        var nowCount = Number(w.count || 0);
        if (nowCount > prevCount && prevCount > 0) {
          var diff = nowCount - prevCount;
          var lastEntry = (w.entries && w.entries.length) ? w.entries[w.entries.length - 1] : {};
          for (var ri = 0; ri < diff; ri++) {
            changes.reqFlashes.push({
              worker: name,
              model: String(lastEntry.model || '?'),
              taskKind: String(lastEntry.taskKind || ''),
              count: nowCount
            });
          }
        }
        prevPremiumByWorker[name] = nowCount;
      });

      // Trim old messages
      while (leadershipMessages.length > LP_MSG_LIMIT) leadershipMessages.pop();
      // Clear isNew flag after 6 seconds
      var cutoff = Date.now() - 6000;
      leadershipMessages.forEach(function(m) {
        if (m.isNew && m.time && new Date(m.time).getTime() < cutoff) m.isNew = false;
      });

      return changes;
    }

    function showRequestFlash(flash) {
      var container = document.getElementById('req-flash-container');
      if (!container) return;
      var emojis = {
        'King David': '👑', 'Esther': '💎', 'Aaron': '🔌', 'Joseph': '🔗',
        'Samuel': '🧪', 'Isaiah': '🔍', 'Noah': '🚢', 'Elijah': '🛡️',
        'Issachar': '📊', 'Ezra': '📝'
      };
      var emoji = emojis[flash.worker] || '🤖';
      var el = document.createElement('div');
      el.className = 'req-flash';
      el.innerHTML =
        '<div class="req-flash-emoji">💎</div>' +
        '<div class="req-flash-title">PREMIUM REQUEST</div>' +
        '<div class="req-flash-detail">' + emoji + ' ' + esc(flash.worker) + ' — #' + esc(flash.count) + '</div>' +
        '<div class="req-flash-model">model: ' + esc(flash.model) + (flash.taskKind ? ' | ' + esc(flash.taskKind) : '') + '</div>';
      container.appendChild(el);
      // Also pulse the worker card
      var wsCard = document.querySelector('.ws-card[data-worker="' + flash.worker.replace(/"/g, '\\"') + '"]');
      if (wsCard) {
        wsCard.classList.remove('req-pulse');
        void wsCard.offsetWidth;
        wsCard.classList.add('req-pulse');
      }
      // Remove flash after animation ends
      setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 3200);
    }

    function renderLeadershipPipeline(data, changes) {
      var janus = (data && data.leadership && data.leadership.janus) || {};
      var prometheus = (data && data.leadership && data.leadership.prometheus) || {};
      var Athena = (data && data.leadership && data.leadership.athena) || {};
      var wa = data && data.workerActivity ? data.workerActivity : {};

      // Progress ring
      var tasks = data && data.tasks ? data.tasks : {};
      var total = Math.max(1, Number(tasks.total || 0));
      var passed = Number((tasks.totals || {}).passed || 0);
      var pct = tasks.total > 0 ? Math.round((passed / total) * 100) : 0;
      var circumference = 2 * Math.PI * 22; // r=22
      var offset = circumference - (pct / 100) * circumference;
      var ringFg = document.getElementById('lp-ring-fg');
      var pctText = document.getElementById('lp-pct-text');
      var pctLabel = document.getElementById('lp-pct-label');
      if (ringFg) {
        ringFg.style.strokeDasharray = String(circumference);
        ringFg.style.strokeDashoffset = String(offset);
        ringFg.style.stroke = pct >= 100 ? '#00ff88' : pct >= 50 ? '#22c27e' : pct >= 25 ? '#d4a017' : '#7dc4ff';
      }
      if (pctText) pctText.textContent = pct + '%';
      if (pctLabel) pctLabel.textContent = passed + ' / ' + (tasks.total || 0) + ' tasks';

      // Janus node
      var health = String(janus.systemHealth || 'unknown');
      var healthIcon = health === 'healthy' ? '🟢' : health === 'critical' ? '🔴' : '🟡';
      var janusStatusEl = document.getElementById('lp-janus-status');
      if (janusStatusEl) janusStatusEl.textContent = healthIcon + ' ' + String(janus.decision || 'waiting');
      var janusNode = document.getElementById('lp-node-janus');
      if (janusNode) {
        janusNode.classList.toggle('active', !!janus.decidedAt);
        if (changes.janusNew) { janusNode.classList.remove('flash'); void janusNode.offsetWidth; janusNode.classList.add('flash'); }
      }

      // Janus → Prometheus arrow
      var arrowJT = document.getElementById('lp-arrow-jt');
      var arrowJTLabel = document.getElementById('lp-arrow-jt-label');
      if (arrowJT) arrowJT.classList.toggle('active', changes.janusNew);
      if (arrowJTLabel) arrowJTLabel.textContent = janus.callPrometheus ? 'analyze' : (janus.decidedAt ? 'directive' : '—');

      // Prometheus node
      var prometheusStatusEl = document.getElementById('lp-prometheus-status');
      var planCount = Array.isArray(prometheus.plans) ? prometheus.plans.length : 0;
      if (prometheusStatusEl) prometheusStatusEl.textContent = planCount > 0 ? (planCount + ' plans | ' + String(prometheus.projectHealth || '?')) : 'waiting';
      var prometheusNode = document.getElementById('lp-node-prometheus');
      if (prometheusNode) {
        prometheusNode.classList.toggle('active', planCount > 0);
        if (changes.prometheusNew) { prometheusNode.classList.remove('flash'); void prometheusNode.offsetWidth; prometheusNode.classList.add('flash'); }
      }

      // Prometheus → Athena arrow
      var arrowTM = document.getElementById('lp-arrow-tm');
      var arrowTMLabel = document.getElementById('lp-arrow-tm-label');
      if (arrowTM) arrowTM.classList.toggle('active', changes.prometheusNew);
      if (arrowTMLabel) arrowTMLabel.textContent = planCount > 0 ? (planCount + ' plans') : '—';

      // Athena node
      var AthenaStatusEl = document.getElementById('lp-Athena-status');
      var activeSessions = Number(Athena.activeSessions || 0);
      var completedCount = Array.isArray(Athena.completedTasks) ? Athena.completedTasks.length : 0;
      if (AthenaStatusEl) AthenaStatusEl.textContent = activeSessions + ' active | ' + completedCount + ' done';
      var AthenaNode = document.getElementById('lp-node-Athena');
      if (AthenaNode) {
        AthenaNode.classList.toggle('active', !!Athena.coordinatedAt);
        if (changes.AthenaNew) { AthenaNode.classList.remove('flash'); void AthenaNode.offsetWidth; AthenaNode.classList.add('flash'); }
      }

      // Athena → Workers arrow
      var arrowMW = document.getElementById('lp-arrow-mw');
      var arrowMWLabel = document.getElementById('lp-arrow-mw-label');
      if (arrowMW) arrowMW.classList.toggle('active', changes.AthenaNew || changes.newWorkers.length > 0);
      if (arrowMWLabel) arrowMWLabel.textContent = activeSessions > 0 ? ('dispatch ' + activeSessions) : '—';

      // Workers node
      var workingNames = Object.keys(wa).filter(function(n) { return String((wa[n] || {}).status || '').toLowerCase() === 'working'; });
      var workersStatusEl = document.getElementById('lp-workers-status');
      if (workersStatusEl) workersStatusEl.textContent = workingNames.length > 0 ? (workingNames.length + ' working') : 'idle';
      var workersNode = document.getElementById('lp-node-workers');
      if (workersNode) {
        workersNode.classList.toggle('active', workingNames.length > 0);
        if (changes.newWorkers.length > 0) { workersNode.classList.remove('flash'); void workersNode.offsetWidth; workersNode.classList.add('flash'); }
      }

      // Message feed — append-only (no full re-render)
      var feedEl = document.getElementById('lp-feed');
      if (feedEl) {
        // Remove 'new' class from any old messages after rendering
        if (changes.newMessages && changes.newMessages.length > 0) {
          // Only render new messages once, then just toggle classes
          changes.newMessages.forEach(function(msg, idx) {
            var div = document.createElement('div');
            div.className = 'lp-msg new';
            div.innerHTML =
              '<span class="lp-msg-icon">' + esc(msg.icon) + '</span>' +
              '<span class="lp-msg-from">' + esc(msg.from) + ' → ' + esc(msg.to) + '</span>' +
              '<span class="lp-msg-text">' + esc(msg.text) + '</span>' +
              '<span class="lp-msg-time">' + esc(relativeTime(msg.time)) + '</span>';
            // Prepend (oldest messages at bottom)
            if (feedEl.firstChild) {
              feedEl.insertBefore(div, feedEl.firstChild);
            } else {
              feedEl.appendChild(div);
            }
          });
        }
        // Remove 'new' class from any old messages
        var msgEls = feedEl.querySelectorAll('.lp-msg.new');
        msgEls.forEach(function(el) {
          if (!el.classList.contains('keep-new')) {
            el.classList.remove('new');
          }
        });
        // Clear 'keep-new' marker after 6 seconds
        msgEls.forEach(function(el) {
          if (el.classList.contains('keep-new')) {
            setTimeout(function() {
              el.classList.remove('keep-new');
              el.classList.remove('new');
            }, 6000);
          }
        });
      } else if (feedEl && feedEl.children.length === 0) {
        // Only show empty state if no messages ever existed
        if (!feedEl.hasAttribute('data-had-messages')) {
          feedEl.innerHTML = '<div class="muted" style="font-size:11px;text-align:center">Waiting for leadership activity...</div>';
        }
      }

      // Request flashes
      if (changes.reqFlashes.length > 0) {
        changes.reqFlashes.forEach(function(flash) {
          showRequestFlash(flash);
        });
      }
    }

    // Keep old renderLeadershipFlow as a no-op since applyState still calls it
    function renderLeadershipFlow(data) {
      // Replaced by renderLeadershipPipeline — called separately
    }

    function renderWorkerGrid(data) {
      var workerActivity = (data && data.workerActivity) ? data.workerActivity : {};
      var container = document.getElementById('worker-grid');
      if (!container) return;

      var roleRegistry = (data && data.runtime && data.runtime.roleRegistry) ? data.runtime.roleRegistry : {};
      var registryWorkers = roleRegistry.workers || {};

      // Always show all known workers + any extra from live sessions
      var workerNames = new Set();
      Object.values(registryWorkers).forEach(function(w) { if (w && w.name) workerNames.add(String(w.name)); });
      Object.keys(workerActivity).forEach(function(name) { workerNames.add(name); });
      // Ensure Issachar and Ezra always appear (scan/doc workers not in default registry)
      ['Issachar', 'Ezra'].forEach(function(n) { workerNames.add(n); });

      var emojis = {
        'King David': '👑', 'Esther': '💎', 'Aaron': '🔌', 'Joseph': '🔗',
        'Samuel': '🧪', 'Isaiah': '🔍', 'Noah': '🚢', 'Elijah': '🛡️',
        'Issachar': '📊', 'Ezra': '📝'
      };

      var preferredOrder = ['King David', 'Esther', 'Aaron', 'Joseph', 'Samuel', 'Isaiah', 'Noah', 'Elijah', 'Issachar', 'Ezra'];
      var orderedNames = preferredOrder.filter(function(n) { return workerNames.has(n); });
      workerNames.forEach(function(n) { if (!preferredOrder.includes(n)) orderedNames.push(n); });

      var html = orderedNames.map(function(name) {
        var session = workerActivity[name] || {};
        var status = String(session.status || 'idle').toLowerCase();
        var cardClass = ['working', 'blocked', 'error', 'done'].includes(status) ? status : '';
        var badgeClass = ['working', 'blocked', 'error', 'done', 'idle'].includes(status) ? status : 'idle';
        var lastTask = String(session.lastTask || '—');
        if (lastTask.length > 55) lastTask = lastTask.slice(0, 55) + '…';
        var emoji = emojis[name] || '🤖';
        var thinking = String(session.lastThinking || '').trim();
        var safeId = 'ws-details-' + name.replace(/[^a-zA-Z0-9]/g, '-');
        var expandBtn = thinking
          ? '<details class="ws-details" id="' + safeId + '"><summary><span class="chevron">&#9662;</span> last output</summary>' +
            '<div class="ws-think">' + esc(thinking) + '</div></details>'
          : '';
        return '<div class="ws-card ' + cardClass + '" data-worker="' + esc(name) + '">' +
          '<div class="ws-name">' + emoji + ' ' + esc(name) + '</div>' +
          '<span class="ws-badge ' + badgeClass + '">' + esc(status) + '</span>' +
          '<div class="ws-task">' + esc(lastTask) + '</div>' +
          '<div class="ws-time">' + esc(session.lastActiveAt ? relativeTime(session.lastActiveAt) : '—') + '</div>' +
          expandBtn +
          '</div>';
      }).join('');

      // Preserve open details state across re-renders
      var openDetails = {};
      container.querySelectorAll('details.ws-details[id]').forEach(function(el) {
        if (el.open) openDetails[el.id] = true;
      });

      container.innerHTML = html || '<div class="muted" style="padding:6px">No workers registered</div>';

      // Restore open state
      Object.keys(openDetails).forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.open = true;
      });
    }

    var celebrationAnimated = false;
    function renderCelebration(data) {
      var banner = document.getElementById('celebration-banner');
      if (!banner) return;

      // Only show completion/celebration banner in true completed mode.
      // While daemon is running (working/idle), keep monitoring UI focused on live state.
      var runtimeStatus = String((data && data.runtime && data.runtime.systemStatus) || 'offline').toLowerCase();
      if (runtimeStatus !== 'completed') {
        banner.style.display = 'none';
        celebrationAnimated = false;
        return;
      }

      // Project completion from ledger takes priority
      var pc = data.projectCompleted;
      if (pc) {
        banner.style.display = 'block';
        banner.style.background = 'linear-gradient(135deg,#0a1a2a 0%,#0d2033 40%,#1a3a4e 100%)';
        banner.style.borderColor = '#00aaff';
        document.getElementById('celebration-emoji').textContent = '\u2705';
        document.getElementById('celebration-title').textContent = 'PROJECT COMPLETED';
        document.getElementById('celebration-title').style.color = '#00ccff';
        document.getElementById('celebration-repo').textContent = pc.repo || '—';
        document.getElementById('celebration-repo').style.color = '#b0d8ff';
        var detailParts = [];
        if (pc.totalMergedPrs) detailParts.push(pc.totalMergedPrs + ' PRs merged');
        if (pc.completionTag) detailParts.push('tag: ' + pc.completionTag);
        if (pc.completedAt) detailParts.push('completed: ' + pc.completedAt.slice(0, 10));
        detailParts.push('Waiting for next project...');
        document.getElementById('celebration-detail').textContent = detailParts.join(' | ');
        document.getElementById('celebration-detail').style.color = '#7aa9c9';
        if (!celebrationAnimated) {
          celebrationAnimated = true;
          banner.style.animation = 'none';
          void banner.offsetHeight;
          banner.style.animation = 'celebrationPulse 2s ease-in-out';
        }
        return;
      }

      var tasks = data.tasks || {};
      var totals = tasks.totals || {};
      var total = Number(tasks.total || 0);
      var passed = Number(totals.passed || 0);
      var failed = Number(totals.failed || 0);
      var running = Number(totals.running || 0);
      var queued = Number(totals.queued || 0);
      var allDone = total > 0 && passed === total && running === 0 && queued === 0 && failed === 0;
      if (!allDone) {
        banner.style.display = 'none';
        celebrationAnimated = false;
        return;
      }
      banner.style.display = 'block';
      banner.style.background = 'linear-gradient(135deg,#0a2a1a 0%,#0d3320 40%,#1a4a2e 100%)';
      banner.style.borderColor = '#00ff88';
      document.getElementById('celebration-emoji').textContent = '\uD83C\uDF89';
      document.getElementById('celebration-title').textContent = 'TARGET REPO READY';
      document.getElementById('celebration-title').style.color = '#00ff88';
      var repo = (data.runtime && data.runtime.targetRepo) || '—';
      document.getElementById('celebration-repo').textContent = repo;
      document.getElementById('celebration-repo').style.color = '#b0ffd0';
      document.getElementById('celebration-detail').textContent =
        passed + '/' + total + ' tasks completed | ' +
        String(Number((data.codeDelta || {}).projectLinesAdded || 0)) + ' lines added';
      document.getElementById('celebration-detail').style.color = '#7ac9a0';
      if (!celebrationAnimated) {
        celebrationAnimated = true;
        banner.style.animation = 'none';
        void banner.offsetHeight;
        banner.style.animation = 'celebrationPulse 2s ease-in-out';
        spawnParticles();
      }
    }

    function spawnParticles() {
      var container = document.getElementById('celebration-particles');
      if (!container) return;
      container.innerHTML = '';
      var emojis = ['\u2728', '\u{1F389}', '\u{1F38A}', '\u2B50', '\u{1F680}', '\u{1F525}', '\u{1F4A5}', '\u{1F3AF}'];
      for (var i = 0; i < 30; i++) {
        var span = document.createElement('span');
        span.textContent = emojis[i % emojis.length];
        span.style.cssText = 'position:absolute;font-size:' + (14 + Math.random() * 18) + 'px;' +
          'left:' + (Math.random() * 100) + '%;top:' + (Math.random() * 100) + '%;' +
          'opacity:0;animation:particleFade ' + (1.5 + Math.random() * 2) + 's ease-out ' + (Math.random() * 1.5) + 's forwards;' +
          'pointer-events:none';
        container.appendChild(span);
      }
    }

    function renderPremiumUsagePanel(data) {
      var pu = (data && data.premiumUsageByWorker) ? data.premiumUsageByWorker : {};
      var byWorker = pu.byWorker || {};
      var totalReqs = Number(pu.totalRequests || 0);
      var gridEl = document.getElementById('premium-usage-grid');
      var timelineEl = document.getElementById('premium-usage-timeline');
      if (!gridEl) return;

      var workerNames = Object.keys(byWorker).sort(function(a, b) {
        return (byWorker[b].count || 0) - (byWorker[a].count || 0);
      });

      if (workerNames.length === 0) {
        gridEl.innerHTML = '<div class="muted" style="padding:6px">No premium usage data yet — starts tracking when workers run</div>';
        if (timelineEl) timelineEl.innerHTML = '';
        return;
      }

      var emojis = {
        'King David': '👑', 'Esther': '💎', 'Aaron': '🔌', 'Joseph': '🔗',
        'Samuel': '🧪', 'Isaiah': '🔍', 'Noah': '🚢', 'Elijah': '🛡️',
        'Issachar': '📊', 'Ezra': '📝'
      };

      var cards = workerNames.map(function(name) {
        var w = byWorker[name];
        var emoji = emojis[name] || '🤖';
        var avgMs = w.count > 0 ? Math.round(w.totalDurationMs / w.count / 1000) : 0;
        var models = Object.keys(w.models || {}).map(function(m) {
          return esc(m) + ': ' + String(w.models[m]);
        }).join(', ');
        var lastEntry = (w.entries && w.entries.length > 0) ? w.entries[w.entries.length - 1] : null;
        var lastTime = lastEntry ? relativeTime(lastEntry.completedAt || lastEntry.startedAt) : '—';
        var pctOfTotal = totalReqs > 0 ? ((w.count / totalReqs) * 100).toFixed(1) : '0';
        return '<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:10px">' +
          '<div style="font-weight:600;margin-bottom:4px">' + emoji + ' ' + esc(name) +
          '<span style="float:right;font-size:20px;font-weight:700;color:#00d4ff">' + String(w.count) + '</span></div>' +
          '<div style="font-size:11px;color:var(--muted)">' + pctOfTotal + '% of total | avg ' + avgMs + 's/req</div>' +
          '<div style="font-size:11px;color:var(--muted);margin-top:2px">Models: ' + (models || 'n/a') + '</div>' +
          '<div style="font-size:10px;color:var(--muted);margin-top:2px">Last: ' + esc(lastTime) + '</div>' +
          '<div style="margin-top:6px;height:4px;background:var(--chart-bg);border-radius:2px;overflow:hidden">' +
          '<div style="height:100%;width:' + pctOfTotal + '%;background:linear-gradient(90deg,#00d4ff,#7b61ff);border-radius:2px"></div></div>' +
          '</div>';
      }).join('');

      gridEl.innerHTML = '<div style="margin-bottom:8px;font-size:12px;color:var(--muted)">Total premium requests tracked: <strong style="color:#00d4ff">' +
        String(totalReqs) + '</strong></div>' + cards;

      // Timeline: last 20 entries across all workers
      if (timelineEl) {
        var allEntries = [];
        workerNames.forEach(function(name) {
          (byWorker[name].entries || []).forEach(function(e) {
            allEntries.push({ worker: name, taskKind: e.taskKind, model: e.model, completedAt: e.completedAt, durationMs: e.durationMs });
          });
        });
        allEntries.sort(function(a, b) { return (a.completedAt || '').localeCompare(b.completedAt || ''); });
        var recent = allEntries.slice(-20);
        if (recent.length > 0) {
          var tl = '<div style="font-weight:600;margin-bottom:4px;font-size:12px;color:var(--fg)">Recent Activity Timeline</div>';
          tl += recent.map(function(e) {
            var emoji2 = emojis[e.worker] || '🤖';
            var durSec = Math.round(Number(e.durationMs || 0) / 1000);
            var time = e.completedAt ? new Date(e.completedAt).toLocaleTimeString() : '?';
            return '<div>' + time + ' ' + emoji2 + ' ' + esc(e.worker) + ' — ' +
              esc(e.taskKind || '?') + ' (' + esc(e.model || '?') + ', ' + durSec + 's)</div>';
          }).join('');
          timelineEl.innerHTML = tl;
        } else {
          timelineEl.innerHTML = '';
        }
      }
    }

    function renderLeadershipPanel(data) {
      var janus = (data && data.leadership && data.leadership.janus) ? data.leadership.janus : {};
      var Athena = (data && data.leadership && data.leadership.athena) ? data.leadership.athena : {};
      var prometheus = (data && data.leadership && data.leadership.prometheus) ? data.leadership.prometheus : {};
      var workerActivity = (data && data.workerActivity) ? data.workerActivity : {};
      var latestTasks = (data && data.tasks && Array.isArray(data.tasks.list)) ? data.tasks.list : [];

      var blockedFromQueue = latestTasks
        .filter(function(task) {
          var status = String(task && task.status || '').toLowerCase();
          return status === 'blocked';
        })
        .map(function(task) {
          return {
            worker: String(task && (task.assignedRole || task.assignedWorker) || '-'),
            task: String(task && task.title || '-')
          };
        });

      var failedFromQueue = latestTasks
        .filter(function(task) {
          var status = String(task && task.status || '').toLowerCase();
          return status === 'failed';
        })
        .map(function(task) {
          return {
            worker: String(task && (task.assignedRole || task.assignedWorker) || '-'),
            task: String(task && task.title || '-')
          };
        });

      var blockedTasks = dedupeBlockedTasks(blockedFromQueue);
      var failedFamilies = dedupeBlockedTasks(failedFromQueue);
      var topBlocked = blockedTasks[0] || null;
      var health = String(janus.systemHealth || 'unknown');
      var healthText = health === 'healthy' ? '🟢 Healthy' : health === 'critical' ? '🔴 Critical' : '🟡 Attention';
      var nextAction = janus.briefForPrometheus ? String(janus.briefForPrometheus).slice(0, 120) : 'No immediate action';

      document.getElementById('user-overview').textContent = 'System: ' + healthText + ' | Decision: ' + String(janus.decision || 'unknown');
      document.getElementById('user-blocked').textContent = topBlocked
        ? ('Blocked: ' + String(topBlocked.worker || '-') + ' - ' + String(topBlocked.task || '-'))
        : 'No blocked tasks';
      document.getElementById('user-queue').textContent = 'Workers Active: ' + Object.keys(workerActivity).length;

      // Freshness helpers
      function freshnessBadge(isoDate) {
        if (!isoDate) return '<span class="freshness-badge stale">no data</span>';
        var ageMin = (Date.now() - new Date(isoDate).getTime()) / 60000;
        if (ageMin < 10) return '<span class="freshness-badge fresh">' + (ageMin < 1 ? 'just now' : Math.round(ageMin) + 'm ago') + '</span>';
        if (ageMin < 30) return '<span class="freshness-badge warm">' + Math.round(ageMin) + 'm ago</span>';
        return '<span class="freshness-badge stale">stale · ' + Math.round(ageMin) + 'm ago</span>';
      }

      var janusStatusEl = document.getElementById('janus-status');
      if (janusStatusEl) janusStatusEl.innerHTML = 'Health: ' + healthText + ' | Mode: ' + esc(String(janus.decision || '?')) + freshnessBadge(janus.decidedAt);
      document.getElementById('janus-action').textContent = 'Brief to Athena: ' + nextAction;
      document.getElementById('janus-blocked').textContent = 'Prometheus needed: ' + (janus.callPrometheus ? 'YES — ' + String(janus.prometheusReason || '').slice(0, 80) : 'No');
      document.getElementById('janus-queue').textContent = 'Priorities: ' + (Array.isArray(janus.priorities) ? janus.priorities.join(', ') : 'none');

      var janusReasoningEl = document.getElementById('janus-reasoning');
      if (janusReasoningEl) {
        var janusReasoning = String(janus.reasoning || '');
        janusReasoningEl.textContent = janusReasoning || 'Awaiting Janus analysis...';
        janusReasoningEl.title = 'Decided: ' + String(janus.decidedAt || '') + ' | Model: ' + String(janus.model || '');
      }

      var AthenaCountsEl = document.getElementById('Athena-counts');
      if (AthenaCountsEl) AthenaCountsEl.innerHTML =
        'Status: ' + esc(String(Athena.statusReport || 'No coordination yet')) +
        ' | Workers: ' + esc(String(Athena.activeSessions || 0)) +
        freshnessBadge(Athena.coordinatedAt || Athena.updatedAt || null);
      document.getElementById('Athena-gates').textContent = 'Completed: ' + (Array.isArray(Athena.completedTasks) ? Athena.completedTasks.length : 0) + ' tasks';

      var AthenaReportEl = document.getElementById('Athena-statusreport');
      if (AthenaReportEl) {
        AthenaReportEl.textContent = String(Athena.summary || 'Awaiting Athena coordination...');
      }
      var AthenaPlannedEl = document.getElementById('Athena-tasksplanned');
      if (AthenaPlannedEl) {
        var completed = Array.isArray(Athena.completedTasks) ? Athena.completedTasks : [];
        AthenaPlannedEl.textContent = completed.length ? ('Done: ' + completed.join(' | ')) : '';
      }

      // Prometheus panel
      var prometheusEl = document.getElementById('prometheus-analysis');
      if (prometheusEl) {
        var prometheusText = prometheus.analysis ? String(prometheus.analysis).slice(0, 800) : 'No deep analysis yet';
        prometheusEl.textContent = prometheusText;
      }
      var prometheusHealthEl = document.getElementById('prometheus-health');
      if (prometheusHealthEl) {
        prometheusHealthEl.textContent = prometheus.projectHealth
          ? ('Project Health: ' + prometheus.projectHealth + ' | Plans: ' + (Array.isArray(prometheus.plans) ? prometheus.plans.length : 0) + ' items')
          : 'Not yet analyzed';
      }
      var prometheusRequestsEl = document.getElementById('prometheus-requests');
      if (prometheusRequestsEl) {
        var requestBudget = (prometheus && prometheus.requestBudget) ? prometheus.requestBudget : {};
        var totalRequests = Number(requestBudget.estimatedPremiumRequestsTotal || 0);
        var confidence = String(requestBudget.confidence || '').trim();
        prometheusRequestsEl.textContent = requestBudget && Number.isFinite(totalRequests) && totalRequests > 0
          ? ('Estimated Premium Requests: ' + formatRequestCount(totalRequests) + (confidence ? (' | Confidence: ' + confidence) : ''))
          : 'Estimated Premium Requests: not available';
      }

      var AthenaWorkers = (Athena && Athena.workers) ? { ...Athena.workers } : {};
      var names = Object.keys(AthenaWorkers || {});
      var activeSlots = Object.keys(workerActivity || {}).filter(function(slot) {
        var live = workerActivity[slot] || {};
        return String(live.status || '').toLowerCase() === 'active';
      });

      // Make leadership table reflect live worker slot activity when role summary is stale.
      var roleBySlot = {};
      Object.keys(AthenaWorkers || {}).forEach(function(name) {
        var item = AthenaWorkers[name] || {};
        var slot = String(item.slot || '').trim();
        if (slot) {
          roleBySlot[slot] = name;
        }
      });

      Object.keys(workerActivity || {}).forEach(function(slot) {
        var live = workerActivity[slot] || {};
        var mappedName = roleBySlot[slot] || String(live.roleName || '').trim() || slot;
        if (!AthenaWorkers[mappedName]) {
          AthenaWorkers[mappedName] = {
            status: String(live.status || 'idle').toLowerCase(),
            task: live.taskTitle || null,
            gate_color: String(live.status || '').toLowerCase() === 'active' ? 'yellow' : 'green',
            slot: slot
          };
          names.push(mappedName);
        } else if (String(live.status || '').toLowerCase() === 'active') {
          AthenaWorkers[mappedName] = {
            ...AthenaWorkers[mappedName],
            status: 'running',
            task: live.taskTitle || AthenaWorkers[mappedName].task || null,
            gate_color: AthenaWorkers[mappedName].gate_color === 'red' ? 'red' : 'yellow',
            slot: slot
          };
        }
      });

      // If no slot is active, do not keep stale "running" labels from old summaries.
      if (activeSlots.length === 0) {
        names.forEach(function(name) {
          var item = AthenaWorkers[name] || {};
          var st = String(item.status || '').toLowerCase();
          if (st === 'running' || st === 'active') {
            AthenaWorkers[name] = {
              ...item,
              status: 'idle',
              task: null,
              gate_color: (String(item.gate_color || '').toLowerCase() === 'red') ? 'red' : 'green'
            };
          }
        });
      }

      var chips = [];
      names.sort(function(a, b) { return String(a).localeCompare(String(b)); });
      names.forEach(function(name) {
        var item = AthenaWorkers[name] || {};
        var gateColor = String(item.gate_color || statusColor(item.status));
        chips.push('<div class="worker-chip ' + esc(gateColor) + '">' +
          '<div><strong>' + esc(name) + '</strong></div>' +
          '<div>' + esc(normalizeWorkerStatus(item.status || 'idle')) + '</div>' +
          '<div>' + esc(item.task || '-') + '</div>' +
          '<div>' + gateIconFromColor(gateColor) + '</div>' +
          '</div>');
      });

      document.getElementById('workers-chips').innerHTML = chips.length
        ? chips.join('')
        : '<div class="muted">No workers</div>';
    }

    function renderPrometheusPlanBoard(data) {
      var board = data && data.prometheusPlanBoard ? data.prometheusPlanBoard : { activeKey: null, active: null, history: [] };
      var history = Array.isArray(board.history) ? board.history : [];

      // Build a fingerprint from active key + item statuses to skip re-render when unchanged
      var currentKey = prometheusPlanUserSelected ? selectedPrometheusPlanKey : (board.activeKey || null);
      var selected = history.find(function(entry) { return entry.key === currentKey; }) || board.active || history[0] || null;
      if (!prometheusPlanUserSelected) {
        selectedPrometheusPlanKey = board.activeKey || null;
      }
      if (selected && selected.key) {
        if (!prometheusPlanUserSelected) selectedPrometheusPlanKey = selected.key;
      }

      var items = selected ? (Array.isArray(selected.items) ? selected.items : []) : [];
      var fp = String(selectedPrometheusPlanKey || '') + '|' +
        String(history.length) + '|' +
        items.map(function(it) { return it.role + ':' + it.status; }).join(',');
      if (fp === prometheusPlanFingerprint) return; // nothing changed — skip DOM update
      prometheusPlanFingerprint = fp;

      var tabsEl = document.getElementById('prometheus-plan-tabs');
      var listEl = document.getElementById('prometheus-plan-list');
      var metaEl = document.getElementById('prometheus-plan-meta');
      if (!tabsEl || !listEl || !metaEl) return;

      if (!selected) {
        tabsEl.innerHTML = '<div class="muted">No snapshot history</div>';
        listEl.innerHTML = '<div class="muted">No plans yet</div>';
        metaEl.textContent = 'Awaiting Prometheus plan snapshots...';
        return;
      }

      var tabs = history.map(function(entry, idx) {
        var at = entry.analyzedAt ? String(entry.analyzedAt).replace('T', ' ').replace('Z', '') : ('snapshot-' + (idx + 1));
        var shortAt = at.length > 19 ? at.slice(0, 19) : at;
        var cls = entry.key === selectedPrometheusPlanKey ? 'prometheus-tab active' : 'prometheus-tab';
        return '<button type="button" class="' + cls + '" data-prometheus-key="' + esc(entry.key) + '">' +
          esc(shortAt) + ' · ' + esc(entry.projectHealth || 'unknown') +
          '</button>';
      });
      tabsEl.innerHTML = tabs.length ? tabs.join('') : '<div class="muted">No snapshot history</div>';

      Array.from(tabsEl.querySelectorAll('button[data-prometheus-key]')).forEach(function(btn) {
        btn.addEventListener('click', function() {
          prometheusPlanUserSelected = true;
          selectedPrometheusPlanKey = String(btn.getAttribute('data-prometheus-key') || '');
          prometheusPlanFingerprint = ''; // force re-render on manual tab switch
          if (latestState) renderPrometheusPlanBoard(latestState);
        });
      });

      var rows = items.map(function(item, idx) {
        var rawStatus = String(item.status || 'queued').toLowerCase();
        var color = (rawStatus === 'done' || rawStatus === 'running') ? 'green' : ((rawStatus === 'skipped' || rawStatus === 'error' || rawStatus === 'failed') ? 'red' : 'neutral');
        var label = (rawStatus === 'done') ? 'done' : ((rawStatus === 'running') ? 'in-progress' : ((rawStatus === 'skipped') ? 'skipped/failed' : 'queued'));
        return '<div class="prometheus-plan-item ' + color + '">' +
          '<div class="prometheus-plan-head">' +
            '<span>P' + esc(item.priority) + ' · ' + esc(item.role) + ' · ' + esc(item.kind || '-') + '</span>' +
            '<span>' + esc(label) + '</span>' +
          '</div>' +
          '<div class="prometheus-plan-task">' + esc(item.task || '-') + '</div>' +
        '</div>';
      });
      listEl.innerHTML = rows.length ? rows.join('') : '<div class="muted">No plans in selected snapshot</div>';

      metaEl.textContent = 'Active snapshot: ' + String(selected.analyzedAt || 'unknown') +
        ' | source=' + String(selected.source || 'unknown') +
        ' | health=' + String(selected.projectHealth || 'unknown') +
        ' | plans=' + String(items.length) +
        (function() {
          if (!selected.analyzedAt) return '';
          var ageMs = Date.now() - new Date(selected.analyzedAt).getTime();
          if (ageMs > 3600000) return ' | ⚠ stale (' + Math.round(ageMs / 3600000) + 'h ago)';
          if (ageMs > 600000) return ' | ' + Math.round(ageMs / 60000) + 'm ago';
          return '';
        })();
    }

    function renderActivityPulse(data) {
      var pulse = (data && data.activityPulse) || {};
      var git = pulse.git || {};
      var reqs = pulse.requestsSpent || {};
      var workers = Array.isArray(pulse.workersActive) ? pulse.workersActive : [];

      // Update timestamp
      var updEl = document.getElementById('pulse-updated');
      if (updEl) updEl.textContent = 'live · ' + new Date().toLocaleTimeString();

      // Commits today
      var commitsEl = document.getElementById('pulse-commits');
      if (commitsEl) commitsEl.textContent = String(git.commitsToday || 0);
      var commitsSub = document.getElementById('pulse-commits-sub');
      if (commitsSub) commitsSub.textContent = 'total: ' + String(git.totalCommits || 0);

      // Lines written
      var linesEl = document.getElementById('pulse-lines');
      if (linesEl) {
        linesEl.innerHTML =
          '<span class="plus">+' + String(git.linesAdded || 0) + '</span>' +
          ' <span class="dim">/</span> ' +
          '<span class="minus">-' + String(git.linesDeleted || 0) + '</span>';
      }
      var filesSub = document.getElementById('pulse-files-sub');
      if (filesSub) filesSub.textContent = String(git.filesChanged || 0) + ' files changed';

      // Premium requests
      var premEl = document.getElementById('pulse-premium');
      if (premEl) premEl.textContent = String(reqs.premium || 0);
      var premSub = document.getElementById('pulse-premium-sub');
      if (premSub) premSub.textContent = 'this month';

      // Copilot used / quota
      var copilotEl = document.getElementById('pulse-copilot');
      if (copilotEl) {
        var used = Math.round(Number(reqs.copilotUsed || 0));
        var quota = Number(reqs.copilotQuota || 1500);
        copilotEl.innerHTML = String(used) + ' <span class="dim">/ ' + formatRequestCount(quota) + '</span>';
      }
      var copilotSub = document.getElementById('pulse-copilot-sub');
      if (copilotSub) {
        var pct = Number(reqs.copilotUsedPct || 0).toFixed(1);
        var models = reqs.copilotByModel || [];
        if (models.length > 0) {
          var top3 = models.slice().sort(function(a,b){ return (b.qty||0)-(a.qty||0); }).slice(0,3);
          copilotSub.textContent = pct + '% — ' + top3.map(function(m){ return (m.model||'').replace(/^Auto:\\s*/,'').split(' ').slice(-2).join(' ') + ': ' + Math.round(m.qty); }).join(', ');
        } else {
          copilotSub.textContent = pct + '% used';
        }
      }

      // Workers active count
      var wcountEl = document.getElementById('pulse-workers-count');
      if (wcountEl) {
        wcountEl.innerHTML = String(workers.length) + ' <span class="dim">active</span>';
      }
      var wsub = document.getElementById('pulse-workers-sub');
      if (wsub) {
        wsub.textContent = workers.length > 0
          ? workers.map(function(w) { return w.name; }).join(', ')
          : 'all idle';
      }

      // Worker chips
      var wListEl = document.getElementById('pulse-workers-list');
      if (wListEl) {
        var wa = data && data.workerActivity ? data.workerActivity : {};
        var emojis = {
          'King David': '👑', 'Esther': '💎', 'Aaron': '🔌', 'Joseph': '🔗',
          'Samuel': '🧪', 'Isaiah': '🔍', 'Noah': '🚢', 'Elijah': '🛡️',
          'Issachar': '📊', 'Ezra': '📝'
        };
        var chipHtml = '';
        var allNames = Object.keys(wa);
        if (allNames.length > 0) {
          chipHtml = allNames.map(function(name) {
            var st = String((wa[name] || {}).status || 'idle').toLowerCase();
            var isActive = st === 'working';
            var chipClass = isActive ? '' : ' idle';
            var task = String((wa[name] || {}).lastTask || '').slice(0, 50);
            var emoji = emojis[name] || '🤖';
            return '<span class="pulse-worker-chip' + chipClass + '" title="' + esc(task) + '">' +
              '<span class="pw-dot"></span>' + emoji + ' ' + esc(name) +
              (isActive ? ' — ' + esc(task) : '') + '</span>';
          }).join('');
        } else {
          chipHtml = '<span style="font-size:11px;color:var(--muted)">No workers registered</span>';
        }
        wListEl.innerHTML = chipHtml;
      }

      // Recent commits
      var rcEl = document.getElementById('pulse-recent-commits');
      if (rcEl) {
        var msgs = Array.isArray(git.recentMessages) ? git.recentMessages : [];
        if (msgs.length > 0) {
          rcEl.innerHTML = msgs.map(function(c) {
            return '<span class="pulse-commit"><strong>' + esc(c.hash) + '</strong> ' + esc(c.message) + '</span>';
          }).join('');
        } else {
          rcEl.innerHTML = '<span style="font-size:10px;color:var(--muted)">No commits today</span>';
        }
      }
    }

    function applyState(data) {
      latestState = data;

      const total = Math.max(1, Number(data.tasks.total || 0));
      const queued = Number(data.tasks.totals.queued || 0);
      const running = Number(data.tasks.totals.running || 0);
      const passed = Number(data.tasks.totals.passed || 0);
      const failed = Number(data.tasks.totals.failed || 0);
      const admin = data && data.admin ? data.admin : {};
      const refreshInSec = Math.max(0, Number(admin.refreshInSec || 0));
      const refreshMin = Math.floor(refreshInSec / 60);
      const refreshSec = refreshInSec % 60;
      const refreshLabel = refreshInSec > 0 ? (String(refreshMin) + 'm ' + String(refreshSec) + 's') : 'now';
      const adminError = admin.lastError ? String(admin.lastError) : null;
      const pct = (v) => Math.round((v / total) * 100);

      document.getElementById("meta").textContent = 'Updated ' + data.generatedAt + ' | Month ' + data.monthKey;
      var heroLive = document.getElementById("hero-live");
      var heroLiveText = document.getElementById("hero-live-text");
      var runtimeStatus = String((data.runtime && data.runtime.systemStatus) || "offline").toLowerCase();
      var statusText = String((data.runtime && data.runtime.systemStatusText) || "System Offline");
      if (heroLive && heroLiveText) {
        heroLiveText.textContent = statusText;
        heroLive.classList.remove("is-offline", "is-workers-active", "is-idle", "is-completed", "is-degraded");
        if (runtimeStatus === "completed") {
          heroLive.classList.add("is-completed");
        } else if (runtimeStatus === "offline") {
          heroLive.classList.add("is-offline");
        } else if (runtimeStatus === "degraded") {
          heroLive.classList.add("is-degraded");
        } else if (runtimeStatus === "working") {
          heroLive.classList.add("is-workers-active");
        } else {
          heroLive.classList.add("is-idle");
        }
      }

      // Update daemon control buttons based on status
      var daemonRunning = runtimeStatus !== "offline";
      var dStartBtn = document.getElementById("daemon-start-btn");
      var dStopBtn = document.getElementById("daemon-stop-btn");
      var dStatusSpan = document.getElementById("daemon-status-text");
      if (dStartBtn) dStartBtn.style.display = daemonRunning ? "none" : "";
      if (dStopBtn) dStopBtn.style.display = daemonRunning ? "" : "none";
      if (dStatusSpan && data.runtime.daemonPid) {
        dStatusSpan.textContent = daemonRunning ? "PID " + data.runtime.daemonPid : "";
      }

      var activeTarget = (data.runtime && data.runtime.activeTarget) ? data.runtime.activeTarget : {};
      var modeLabel = String((activeTarget.currentMode || data.runtime.currentMode || "single_target") || "single_target").replace(/_/g, ' ');
      var stageLabel = String(activeTarget.stage || (modeLabel === 'single target' ? 'target_home' : 'none')).replace(/_/g, ' ');
      var blockers = Array.isArray(activeTarget.blockers) ? activeTarget.blockers.filter(Boolean) : [];
      var waitingReason = String(activeTarget.waitingReason || 'none');
      var executionWorkspace = String(activeTarget.executionWorkspacePath || '').trim();
      var repoState = String(activeTarget.repoState || '').trim();
      var clarificationAgent = String(activeTarget.clarificationAgent || activeTarget.selectedOnboardingAgent || '').trim();
      var clarificationStatus = String(activeTarget.clarificationStatus || '').trim();
      var targetLabel = activeTarget.hasActiveTargetSession
        ? (activeTarget.projectLabel || activeTarget.targetRepo || activeTarget.activeProjectId || 'active target')
        : 'No active target';
      var targetSub = '';
      if (blockers.length > 0) {
        targetSub = 'blocked: ' + String(blockers[0]).slice(0, 96);
      } else if (clarificationAgent) {
        targetSub = 'onboarding: ' + clarificationAgent
          + (repoState ? (' | repo: ' + repoState) : '')
          + (clarificationStatus ? (' | status: ' + clarificationStatus) : '');
      } else if (repoState) {
        targetSub = 'repo: ' + repoState
          + (waitingReason && waitingReason !== 'none' ? (' | waiting: ' + waitingReason.slice(0, 48)) : '');
      } else if (waitingReason && waitingReason !== 'none') {
        targetSub = 'waiting: ' + waitingReason.slice(0, 96);
      } else {
        targetSub = 'workspace: ' + (executionWorkspace || 'n/a');
      }

      document.getElementById("m-project").textContent = activeTarget.projectLabel || data.runtime.projectLabel || data.runtime.targetRepo || "unknown";
      var roleRegistry = (data.runtime && data.runtime.roleRegistry) ? data.runtime.roleRegistry : {};
      var roleLayerMap = buildRoleLayerMap(roleRegistry);
      document.getElementById("m-role-head").textContent = 'CEO: ' + String(roleRegistry.ceo || '-') + ' | Lead: ' + String(roleRegistry.lead || '-');
      document.getElementById("m-mode").textContent = modeLabel;
      document.getElementById("m-mode-sub").textContent = 'stage: ' + stageLabel + ' | fallback: ' + String(activeTarget.fallbackModeAfterCompletion || 'self_dev').replace(/_/g, ' ') + (activeTarget.bootstrapStatus ? ' | bootstrap: ' + String(activeTarget.bootstrapStatus).replace(/_/g, ' ') : '');
      document.getElementById("m-target").textContent = targetLabel;
      document.getElementById("m-target-sub").textContent = targetSub;
      document.getElementById("m-tasks").textContent = String(data.tasks.total || 0);
      document.getElementById("m-tasks-sub").textContent = 'queued: ' + queued + ' | running: ' + running;

      // Workers active card: count working vs total registered
      var workerAct = data.workerActivity || {};
      var workerNames = Object.keys(workerAct);
      var workingCount = workerNames.filter(function(n) { return String((workerAct[n] || {}).status || '').toLowerCase() === 'working'; }).length;
      document.getElementById("m-qr").textContent = String(workingCount) + ' / ' + String(workerNames.length);
      document.getElementById("m-qr-sub").textContent = 'working / total';

      document.getElementById("m-pf").textContent = String(data.tasks.totals.passed || 0) + ' / ' + String(data.tasks.totals.failed || 0);

      // Premium request card — show ACTUAL usage from premium_usage_log, with Prometheus estimate for context
      var pre = data.premiumRequestEstimate || {};
      var preEstimated = Number(pre.estimatedTotal || 0);
      var preUsed = Number(pre.used || 0);
      var preAfter = Number(pre.afterProject || 0);
      var completedTasks = Number(data.tasks.totals.passed || 0);
      var totalTasks = Number(data.tasks.total || 0);
      var actualPremiumUsed = Number((data.premiumUsageByWorker && data.premiumUsageByWorker.totalRequests) || 0);
      if (actualPremiumUsed > 0 || preEstimated > 0) {
        document.getElementById("m-premium").textContent = String(actualPremiumUsed) + ' used';
        var subParts = [];
        if (preEstimated > 0) subParts.push('budget: ~' + formatRequestCount(preEstimated));
        subParts.push('done: ' + completedTasks + '/' + totalTasks + ' tasks');
        document.getElementById("m-premium-sub").textContent = subParts.join(' | ');
      } else {
        document.getElementById("m-premium").textContent = '-';
        document.getElementById("m-premium-sub").textContent = 'no usage data';
      }

      var copilotRemaining = Number(data.usage.copilot.monthly.remainingRequests || 0);
      document.getElementById("m-copilot").textContent = formatRequestCount(copilotRemaining);

      // Alerts card
      var alertTotal = Number((data.alerts && data.alerts.total) || 0);
      var alertsEl = document.getElementById("m-alerts");
      var alertsSubEl = document.getElementById("m-alerts-sub");
      if (alertsEl) alertsEl.textContent = String(alertTotal);
      if (alertsSubEl) {
        if (alertTotal === 0) alertsSubEl.textContent = 'no alerts';
        else {
          var lastAlert = (data.alerts.list || []).slice(-1)[0];
          alertsSubEl.textContent = lastAlert ? esc(String(lastAlert.source || '') + ': ' + String(lastAlert.title || '').slice(0, 40)) : '';
        }
      }
      document.getElementById("m-delta").textContent = '+' + String(Number(data.codeDelta?.projectLinesAdded || 0)) + ' / -' + String(Number(data.codeDelta?.projectLinesDeleted || 0));
      document.getElementById("m-delta-sub").textContent = data.codeDelta?.source === 'github-merged-prs' ? 'from github merged PRs' : 'from completed copilot entries';
      const copilotRefreshInSec = Math.max(0, Number(data.usage.copilot.monthly.refreshInSec || 0));
      const copilotRefreshMin = Math.floor(copilotRefreshInSec / 60);
      const copilotRefreshSec = copilotRefreshInSec % 60;
      document.getElementById("m-copilot-sub").textContent =
        'used: ' + String(Number(data.usage.copilot.monthly.usedPercent || 0).toFixed(2)) + '% | refresh: ' +
        String(copilotRefreshMin) + 'm ' + String(copilotRefreshSec) + 's';

      document.getElementById("status-bar").innerHTML =
        '<div class="seg queued" style="width:' + pct(queued) + '%"></div>' +
        '<div class="seg running" style="width:' + pct(running) + '%"></div>' +
        '<div class="seg passed" style="width:' + pct(passed) + '%"></div>' +
        '<div class="seg failed" style="width:' + pct(failed) + '%"></div>';
      document.getElementById("status-legend").innerHTML =
        '<span>Queued ' + queued + '</span>' +
        '<span>Running ' + running + '</span>' +
        '<span>Passed ' + passed + '</span>' +
        '<span>Failed ' + failed + '</span>';

      const dedupedTasks = buildDedupedTaskRows(data.tasks.list || [], data.taskInsights || {}, roleRegistry, roleLayerMap);
      const taskRows = dedupedTasks.map((t) => {
        return '<tr class="selectable" data-taskid="' + esc(t.id) + '"><td>' + esc(t.role) + '</td><td>' + badge(t.status) + '</td><td>' + esc(t.task) + '</td><td>' + gateIconFromColor(t.gateColor) + '</td></tr>';
      });
      document.getElementById("tasks-body").innerHTML = renderRows(taskRows, 4);

      Array.from(document.querySelectorAll('#tasks-body tr.selectable')).forEach(function(row) {
        row.addEventListener('click', function() {
          selectedTaskId = Number(row.getAttribute('data-taskid') || 0);
          renderTaskDetail();
        });
      });

      const usageRows = [
        '<tr><td>Copilot</td><td>Monthly Calls</td><td>' + esc(data.usage.copilot.monthly.totalCalls || 0) + '</td></tr>',
        '<tr><td>Copilot</td><td>Quota</td><td>' + esc(formatRequestCount(data.usage.copilot.monthly.quota || 0)) + '</td></tr>',
        '<tr><td>Copilot</td><td>Remaining</td><td>' + esc(formatRequestCount(data.usage.copilot.monthly.remainingRequests || 0)) + '</td></tr>',
        '<tr><td>Copilot</td><td>Used</td><td>' + esc(Number(data.usage.copilot.monthly.usedPercent || 0).toFixed(1)) + '%</td></tr>',
        '<tr><td>Copilot</td><td>Models</td><td>' + esc(Object.keys(data.usage.copilot.monthly.byModel || {}).join(', ') || '-') + '</td></tr>',
        '<tr><td>Copilot</td><td>Source</td><td>' + esc(data.usage.copilot.monthly.source || '-') + '</td></tr>',
        '<tr><td>Code Delta</td><td>Source</td><td>' + esc(data.codeDelta?.source || '-') + '</td></tr>'
      ];
      document.getElementById("usage-body").innerHTML = usageRows.join("");

      const copilotCalls = (data.usage.copilot.recent || []).map((u) => {
        const copilotObj = u && u.copilot ? u.copilot : {};
        return '<tr><td>' + esc(u.timestamp) + '</td><td>Copilot</td><td>' + esc(u.taskId) + '</td><td>' + esc(pick(copilotObj, 'model', '-')) + '</td><td>' + esc(pick(copilotObj, 'invocation', '-')) + '</td></tr>';
      });
      const allCalls = [...copilotCalls];
      const visibleCalls = showAllCalls ? allCalls : allCalls.slice(0, 3);
      document.getElementById("calls-body").innerHTML = renderRows(visibleCalls, 5);

      const callsToggle = document.getElementById("calls-toggle");
      if (callsToggle) {
        callsToggle.style.display = allCalls.length > 3 ? "inline-block" : "none";
        callsToggle.textContent = showAllCalls ? "Daha az goster" : ("Daha fazla goster (" + String(allCalls.length - 3) + ")");
      }

      const runningInsight = Object.values(data.taskInsights || {}).find((item) => String(item.status || '').toLowerCase() === 'running') || null;
      const dockerRows = (data.docker.services || []).map((s) => {
        const isWorker = String(s.service || '').toLowerCase() === 'worker';
        const role = isWorker ? (runningInsight?.assignedRole || '-') : '-';
        const layer = isWorker ? roleLayer(role, roleLayerMap) : '-';
        return '<tr><td>' + esc(s.service) + '</td><td>' + esc(s.name) + '</td><td>' + esc(role) + '</td><td>' + esc(layer) + '</td><td>' + esc(s.state) + '</td><td>' + esc(s.status) + '</td></tr>';
      });
      document.getElementById("docker-body").innerHTML = renderRows(dockerRows, 6);

      const issueRows = (data.issues.list || []).map((issue) => {
        const issueLabel = issue.issueUrl
          ? ('<a href="' + esc(issue.issueUrl) + '" target="_blank" rel="noopener noreferrer">#' + esc(issue.issueNumber) + '</a>')
          : ('#' + esc(issue.issueNumber));
        return '<tr><td>' + issueLabel + '</td><td>' + esc(issue.status) + '</td><td>' + esc(issue.worker || '-') + '</td><td>' + esc(issue.runningTaskId || '-') + '</td><td>' + esc(issue.summary || '-') + '</td></tr>';
      });
      document.getElementById("issues-body").innerHTML = renderRows(issueRows, 5);

      const alertRows = (data.alerts.list || []).map((a) => {
        const title = String(a.title || '').trim();
        const message = String(a.message || '').trim();
        const source = String(a.source || '').trim();
        const full = [source ? ('[' + source + ']') : '', title, message]
          .filter(Boolean)
          .join(' ');
        return '<tr><td>' + esc(a.timestamp || '-') + '</td><td>' + esc(a.severity || '-') + '</td><td>' + esc(full || '-') + '</td></tr>';
      });
      document.getElementById("alerts-body").innerHTML = renderRows(alertRows, 3);

      const suggestionRows = (data.suggestions && data.suggestions.list ? data.suggestions.list : []).map((s) => {
        const link = s.prUrl
          ? ('<a href="' + esc(s.prUrl) + '" target="_blank" rel="noopener noreferrer">PR</a>')
          : esc(s.branch || '-');
        return '<tr><td>' + esc(s.timestamp || '-') + '</td><td>' + esc(s.worker || '-') + '</td><td>' + esc(s.message || '-') + '</td><td>' + link + '</td></tr>';
      });
      document.getElementById("suggestions-body").innerHTML = renderRows(suggestionRows, 4);

      renderWorkerActivity(data.workerActivity || {}, data.taskInsights || {}, roleLayerMap);
      renderLeadershipPanel(data);

      // ── Leadership pipeline with change detection ──
      var changes = detectLeadershipChanges(data);
      renderLeadershipPipeline(data, changes);

      renderPrometheusPlanBoard(data);
      renderWorkerGrid(data);
      renderPremiumUsagePanel(data);
      renderCelebration(data);
      renderActivityPulse(data);
      renderTaskDetail();

      var recoveryText = data.guardian && data.guardian.lastRecovery
        ? ('Last recovery: ' + String(data.guardian.lastRecovery.id || '-') + ' trigger=' + String(data.guardian.lastRecovery.trigger || '-') + ' removed=' + String(data.guardian.lastRecovery.queue?.removedCorrupted || 0) + ' pruned=' + String(data.guardian.lastRecovery.queue?.prunedRemoved || 0))
        : 'No recovery summary yet';
      document.getElementById("recovery-summary").textContent = recoveryText;
      var rebaseOutput = (data.guardian && data.guardian.rebase && data.guardian.rebase.lastOutput)
        ? String(data.guardian.rebase.lastOutput)
        : 'Recovery output waiting...';
      document.getElementById("recovery-detail").textContent = rebaseOutput;

      var forceBtn = document.getElementById("force-rebase-btn");
      if (forceBtn) {
        var guardianRunning = !!(data.guardian && data.guardian.rebase && data.guardian.rebase.running);
        forceBtn.disabled = guardianRunning;
        forceBtn.textContent = guardianRunning ? 'Rebase Running...' : 'Force Rebase';
      }

      document.getElementById("log-view").innerHTML = (function(lines) {
        if (!lines || lines.length === 0) return '<span style="color:#6b7280">No runtime logs yet</span>';
        return lines.map(function(line) {
          var text = line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          var style = 'color:#d1d5db';
          if (line.includes('[CYCLE START]') || line.includes('[CYCLE DONE]')) {
            style = 'color:#00d4aa;font-weight:bold;font-size:1.05em';
          } else if (line.includes('[AGENT]') && line.includes('ACTIVATED')) {
            style = 'color:#ffd700;font-weight:bold;font-size:1.08em';
          } else if (line.includes('[JANUS] \u2713')) {
            style = 'color:#f0a500;font-weight:bold';
          } else if (line.includes('[PROMETHEUS] \u2713')) {
            style = 'color:#5b9bd5;font-weight:bold';
          } else if (line.includes('[ATHENA] \u2713')) {
            style = 'color:#c084fc;font-weight:bold';
          } else if (line.includes('[RESEARCH_SCOUT] \u2713')) {
            style = 'color:#22d3ee;font-weight:bold';
          } else if (line.includes('[WORKER_BATCH] \u2713')) {
            style = 'color:#4ade80;font-weight:bold';
          } else if (line.includes('[WORKER') && (line.includes('Error') || line.includes('error') || line.includes('FAIL'))) {
            style = 'color:#f87171';
          } else if (line.includes('[LOOP]')) {
            style = 'color:#fb923c';
          } else if (line.includes('[SLO]') && (line.includes('breach') || line.includes('BREACH'))) {
            style = 'color:#f87171;font-weight:bold';
          } else if (line.includes('[CYCLE] \u2500\u2500')) {
            style = 'color:#93c5fd';
          } else if (line.includes('[RUN]')) {
            style = 'color:#a3e635;font-weight:bold';
          } else if (line.includes('[DRIFT_CHECK]') || line.includes('[CAPABILITY_POOL]') || line.includes('[CLOSURE_SLA]')) {
            style = 'color:#94a3b8';
          }
          var bracketEnd = text.indexOf('] ');
          if (bracketEnd > 0 && text.charAt(0) === '[') {
            text = '<span style="color:#4b5563">' + text.slice(0, bracketEnd + 1) + '</span>' + text.slice(bracketEnd + 1);
          }
          return '<span style="' + style + '">' + text + '</span>';
        }).join('\\n');
      })(data.logs || []);

      document.getElementById("target-log-view").textContent = (function(lines, activeTarget) {
        if (!Array.isArray(lines) || lines.length === 0) {
          return activeTarget && activeTarget.hasActiveTargetSession
            ? 'Active target session has no dedicated log lines yet.'
            : 'No active target session log.';
        }
        return lines.join('\\n');
      })(data.targetSessionLogs || [], activeTarget);
    }

    async function triggerForceRebase() {
      var btn = document.getElementById("force-rebase-btn");
      if (btn) {
        btn.disabled = true;
        btn.textContent = 'Rebase Running...';
      }

      try {
        const response = await fetch('/api/force-rebase', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'dashboard-force-rebase' })
        });
        const payload = await response.json();
        document.getElementById('recovery-detail').textContent = JSON.stringify(payload, null, 2);
      } catch (error) {
        document.getElementById('recovery-detail').textContent = 'force-rebase failed: ' + String(error);
      } finally {
        await tick();
      }
    }

    async function tick() {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        const data = await res.json();
        applyState(data);
      } catch (error) {
        document.getElementById("meta").textContent = 'Dashboard fetch error: ' + String(error);
      }
    }

    tick();
    setInterval(tick, 2000);

    var callsToggle = document.getElementById("calls-toggle");
    if (callsToggle) {
      callsToggle.addEventListener("click", function() {
        showAllCalls = !showAllCalls;
        if (latestState) {
          applyState(latestState);
        }
      });
    }

    var forceRebaseBtn = document.getElementById("force-rebase-btn");
    if (forceRebaseBtn) {
      forceRebaseBtn.addEventListener("click", triggerForceRebase);
    }

    // ── Daemon control buttons ────────────────────────────────
    var daemonStartBtn = document.getElementById("daemon-start-btn");
    var daemonStopBtn = document.getElementById("daemon-stop-btn");
    var daemonStatusText = document.getElementById("daemon-status-text");

    async function triggerDaemonStart() {
      if (daemonStartBtn) { daemonStartBtn.disabled = true; daemonStartBtn.textContent = "Starting..."; }
      try {
        const resp = await fetch("/api/daemon-start", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const payload = await resp.json();
        if (daemonStatusText) daemonStatusText.textContent = payload.message || (payload.ok ? "Started" : "Failed");
      } catch (err) {
        if (daemonStatusText) daemonStatusText.textContent = "Start failed: " + String(err);
      } finally {
        setTimeout(function() { tick(); }, 1500);
        if (daemonStartBtn) { daemonStartBtn.disabled = false; daemonStartBtn.textContent = "Start Daemon"; }
      }
    }

    async function triggerDaemonStop() {
      if (daemonStopBtn) { daemonStopBtn.disabled = true; daemonStopBtn.textContent = "Stopping..."; }
      try {
        const resp = await fetch("/api/daemon-stop", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const payload = await resp.json();
        if (daemonStatusText) daemonStatusText.textContent = payload.message || (payload.ok ? "Stopped" : "Failed");
      } catch (err) {
        if (daemonStatusText) daemonStatusText.textContent = "Stop failed: " + String(err);
      } finally {
        setTimeout(function() { tick(); }, 1500);
        if (daemonStopBtn) { daemonStopBtn.disabled = false; daemonStopBtn.textContent = "Stop Daemon"; }
      }
    }

    if (daemonStartBtn) daemonStartBtn.addEventListener("click", triggerDaemonStart);
    if (daemonStopBtn) daemonStopBtn.addEventListener("click", triggerDaemonStop);
  </script>
</body>
</html>`;
}

/**
 * Verify a Bearer token from the Authorization header using a timing-safe comparison.
 * Returns an object describing the auth result.
 *
 * @param {string|undefined} authHeader - value of req.headers.authorization
 * @returns {{ ok: boolean, status: number, error: string } | { ok: true }}
 */
export function checkDashboardAuth(authHeader: string | undefined): { ok: true } | { ok: false; status: number; error: string } {
  // Read token lazily — allows env injection in tests and avoids caching a secret in memory longer than needed.
  const token = process.env.BOX_DASHBOARD_TOKEN?.trim() || "";

  // Fail-safe: if operator did not configure a token, mutations must be blocked.
  if (!token) {
    return { ok: false, status: 403, error: "Dashboard auth token not configured — set BOX_DASHBOARD_TOKEN" };
  }

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  const provided = authHeader.slice(7); // strip "Bearer "
  if (!provided) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  // Constant-time comparison to prevent timing attacks.
  // Pad both buffers to equal length before comparison.
  const tokenBuf = Buffer.from(token, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");

  if (tokenBuf.length !== providedBuf.length) {
    // Lengths differ — do a dummy comparison to keep timing consistent, then reject.
    crypto.timingSafeEqual(tokenBuf, tokenBuf);
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  if (!crypto.timingSafeEqual(tokenBuf, providedBuf)) {
    return { ok: false, status: 401, error: "Unauthorized" };
  }

  return { ok: true };
}

/**
 * Enforce Bearer token auth on a mutation request.
 * Writes a JSON error response and returns false if the request is not authorized.
 * Returns true if the caller should proceed.
 *
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @returns {boolean}
 */
function requireDashboardAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const result = checkDashboardAuth(req.headers["authorization"]);
  if (!result.ok) {
    const fail = result as { ok: false; status: number; error: string };
    res.writeHead(fail.status, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: fail.error }));
    return false;
  }
  return true;
}

async function serve(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/api/force-rebase") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
      return;
    }

    if (!requireDashboardAuth(req, res)) return;

    if (REBASE_STATE.running) {
      res.writeHead(409, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "rebase-already-running" }));
      return;
    }

    REBASE_STATE.running = true;
    REBASE_STATE.lastStartedAt = new Date().toISOString();
    REBASE_STATE.lastOutput = "";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await runRebaseCommand();
    REBASE_STATE.running = false;
    REBASE_STATE.lastCompletedAt = new Date().toISOString();
    REBASE_STATE.lastExitCode = Number(result?.exitCode || (result?.ok ? 0 : 1));
    REBASE_STATE.lastOutput = String(result?.output || "");

    const statusCode = result?.ok ? 200 : 500;
    res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: Boolean(result?.ok),
      startedAt: REBASE_STATE.lastStartedAt,
      completedAt: REBASE_STATE.lastCompletedAt,
      exitCode: REBASE_STATE.lastExitCode,
      output: REBASE_STATE.lastOutput
    }));
    return;
  }

  if (url.pathname === "/api/state") {
    const data = await collectDashboardData();
    // Criterion 5: enforce < 50 KB payload size per poll cycle.
    // If the serialised payload exceeds DASHBOARD_PAYLOAD_MAX_BYTES, trim large leaf
    // arrays (logs, premiumUsageByWorker entries, suggestions) and set payloadTruncated.
    let body = JSON.stringify(data);
    if (Buffer.byteLength(body, "utf8") > DASHBOARD_PAYLOAD_MAX_BYTES) {
      // Trim the largest arrays in-place and re-serialise.
      if (Array.isArray(data.logs)) {
        data.logs = data.logs.slice(-20);
      }
      if (Array.isArray(data.targetSessionLogs)) {
        data.targetSessionLogs = data.targetSessionLogs.slice(-20);
      }
      if (data.premiumUsageByWorker?.byWorker) {
        for (const w of Object.keys(data.premiumUsageByWorker.byWorker)) {
          const entry = data.premiumUsageByWorker.byWorker[w];
          if (Array.isArray(entry.entries)) entry.entries = entry.entries.slice(-3);
        }
      }
      if (Array.isArray(data.suggestions?.list)) {
        data.suggestions.list = data.suggestions.list.slice(0, 10);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (data as any).payloadTruncated = true;
      body = JSON.stringify(data);
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(body);
    return;
  }

  if (url.pathname === "/api/escalations") {
    // Expose unresolved escalation count and age for dashboard consumers.
    // File: state/escalation_queue.json  Age unit: milliseconds since oldest unresolved createdAt.
    try {
      const { readJson: readJsonCore } = await import("../core/fs_utils.js");
      const { sortEscalationQueue } = await import("../core/escalation_queue.js");
      const raw = await readJsonCore(path.join(STATE_DIR, "escalation_queue.json"), { entries: [] });
      const entries = Array.isArray(raw?.entries) ? raw.entries : [];
      const unresolved = entries.filter(e => !e.resolved);
      const prioritised = sortEscalationQueue(unresolved);
      const oldest = [...unresolved].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      )[0];
      const oldestAgeMs = oldest ? Math.floor(Date.now() - new Date(oldest.createdAt).getTime()) : null;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        unresolvedCount: unresolved.length,
        oldestUnresolvedAgeMs: oldestAgeMs,
        oldestUnresolvedCreatedAt: oldest ? oldest.createdAt : null,
        top: prioritised.slice(0, 5).map(e => ({
          role: e.role,
          taskSnippet: e.taskSnippet,
          blockingReasonClass: e.blockingReasonClass,
          nextAction: e.nextAction,
          attempts: e.attempts,
          createdAt: e.createdAt
        })),
        generatedAt: new Date().toISOString()
      }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  if (url.pathname === "/api/daemon-start") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
      return;
    }
    if (!requireDashboardAuth(req, res)) return;
    const status = await getDaemonStatus();
    if (status.running) {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, message: `Daemon already running pid=${status.pid}` }));
      return;
    }
    // Remove stale stop request (daemon.stop.json) before starting — daemon_control.js contract
    try { await fs.rm(path.join(STATE_DIR, "daemon.stop.json"), { force: true }); } catch { /* best effort */ }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await startDaemonDetached();
    res.writeHead(result.ok ? 200 : 500, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === "/api/daemon-stop") {
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
      return;
    }
    if (!requireDashboardAuth(req, res)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = await stopDaemon();
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(result));
    return;
  }

  if (url.pathname === "/api/hypothesis-scorecard") {
    // Hypothesis scorecard endpoint — supports filtering by phase and risk.
    // Query params: ?phase=<value>&risk=<value> (both optional)
    // Returns: ScorecardResult (see src/core/hypothesis_scorecard.js)
    try {
      const phase = url.searchParams.get("phase") || null;
      const risk  = url.searchParams.get("risk")  || null;
      const filters = { phase, risk };
      const scorecard = await collectHypothesisScorecard(STATE_DIR, filters);
      const statusCode = scorecard.ok ? 200 : (scorecard.filterErrors ? 400 : 503);
      res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(scorecard));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  if (url.pathname === "/api/cycle-analytics") {
    // Returns lastCycle and a trimmed history (up to 10 entries) to keep response small.
    try {
      const configModule = await import("../config.js");
      const cfg = configModule.loadConfig ? configModule.loadConfig() : {};
      const data = await readCycleAnalytics(cfg);
      if (!data) {
        res.writeHead(204, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, data: null, reason: "NO_DATA_YET" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok: true,
        schemaVersion: data.schemaVersion,
        lastCycle: data.lastCycle,
        recentHistory: Array.isArray(data.history) ? data.history.slice(0, 10) : [],
        updatedAt: data.updatedAt,
        generatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  if (url.pathname === "/api/compounding-effects") {
    // Returns the latest compounding-effects analysis result and monthly report.
    // Source: state/compounding_effects_latest.json (per-run)
    //         state/compounding_effects_monthly_{YYYY-MM}.json (monthly top-N)
    try {
      const { readJson: readJsonSafe } = await import("../core/fs_utils.js");
      const now       = new Date();
      const monthKey  = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
      const latestPath  = path.join(STATE_DIR, "compounding_effects_latest.json");
      const monthlyPath = path.join(STATE_DIR, `compounding_effects_monthly_${monthKey}.json`);

      const [latest, monthly] = await Promise.all([
        readJsonSafe(latestPath, null),
        readJsonSafe(monthlyPath, null),
      ]);

      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        ok:          true,
        latest:      latest ?? null,
        monthly:     monthly ?? null,
        monthKey,
        generatedAt: new Date().toISOString(),
      }));
    } catch (err) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }));
    }
    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(renderHtml());
}

let _server = null;

/**
 * Start the dashboard HTTP server.
 * Safe to call multiple times — subsequent calls are no-ops if already listening.
 * @param {{ port?: number }} [opts]
 * @returns {http.Server}
 */
export function startDashboard(opts: { port?: number } = {}): http.Server | null {
  if (_server) return _server;
  const port = Number(opts.port || PORT);
  _server = http.createServer((req, res) => {
    serve(req, res).catch((error) => {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    });
  });
  _server.listen(port, () => {
    console.log(`[atlas] dashboard started at http://localhost:${port}`);
  });
  _server.on("error", (err) => {
    // Port busy (e.g. standalone dashboard already running) — non-fatal
    console.error(`[atlas] dashboard failed to bind port ${port}: ${err.message}`);
    _server = null;
  });
  return _server;
}

// Auto-start when run directly (node src/dashboard/live_dashboard.ts)
const _isDirectRun = process.argv[1] && (
  process.argv[1].endsWith("live_dashboard.ts") ||
  process.argv[1].endsWith("live_dashboard.js") ||
  process.argv[1].endsWith("live_dashboard")
);
if (_isDirectRun) {
  startDashboard();
}

