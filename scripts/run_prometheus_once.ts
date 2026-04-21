import { loadConfig } from "../src/config.js";
import { runPrometheusAnalysis } from "../src/core/prometheus.js";
import fs from "node:fs/promises";
import path from "node:path";

function appendLiveLog(filePath, text) {
  const content = String(text || "");
  if (!content) return;
  fs.appendFile(filePath, content, "utf8").catch(() => {
    // Best-effort live log write.
  });
}

const config = await loadConfig();
const stateDir = config?.paths?.stateDir || "state";
const analysisPath = path.join(stateDir, "prometheus_analysis.json");
const liveWorkerLogPath = path.join(stateDir, "live_worker_prometheus.log");

await fs.mkdir(stateDir, { recursive: true });
appendLiveLog(
  liveWorkerLogPath,
  [
    "",
    `${"=".repeat(80)}`,
    `[${new Date().toISOString()}] RUN_PROMETHEUS_ONCE start`,
    `${"-".repeat(80)}`,
    ""
  ].join("\n")
);

let result = null;
let runError = null;
try {
  result = await runPrometheusAnalysis(config, {
    prompt: "Standalone run requested by user: deeply analyze the repository and produce a self-evolution master plan focused on how BOX can evolve itself, improve Prometheus planning quality, redesign worker behavior, deepen model utilization, strengthen learning loops, and increase long-term capability per premium request. Security and governance are supporting concerns, not the main objective.",
    requestedBy: "user-standalone",
    bypassCache: true,
    bypassReason: "standalone-manual-run"
  });
} catch (error) {
  runError = error;
}

if (runError) {
  appendLiveLog(liveWorkerLogPath, `\n[run_prometheus_once][error] ${String(runError?.message || runError)}\n`);
  throw runError;
}

let plansCount = Array.isArray(result?.plans) ? result.plans.length : 0;
const health = result?.projectHealth || "unknown";

// Fallback: count narrative packets if JSON plans array is empty
if (plansCount === 0 && result?.analysis) {
  const packetMatches = String(result.analysis).match(/###\s*Packet\s+\d+/gi);
  if (packetMatches) plansCount = packetMatches.length;
}
if (plansCount === 0 && result?.strategicNarrative) {
  const packetMatches = String(result.strategicNarrative).match(/###\s*Packet\s+\d+/gi);
  if (packetMatches) plansCount = packetMatches.length;
}
console.log(`PROMETHEUS_DONE plans=${plansCount} health=${health}`);
appendLiveLog(
  liveWorkerLogPath,
  `\n[${new Date().toISOString()}] RUN_PROMETHEUS_ONCE done plans=${plansCount} health=${health}\n`
);

try {
  await fs.access(analysisPath);
  console.log(`PROMETHEUS_FILE ${analysisPath}`);
} catch {
  console.log(`PROMETHEUS_FILE_MISSING ${analysisPath}`);
}
