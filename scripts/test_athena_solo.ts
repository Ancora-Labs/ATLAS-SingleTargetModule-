/**
 * test_athena_solo.ts
 * Run Athena plan review in isolation using the last prometheus_analysis.json.
 * Does NOT start or touch the BOX daemon.
 *
 * Usage:
 *   node --import tsx scripts/test_athena_solo.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { runAthenaPlanReview } from "../src/core/athena_reviewer.js";

const stateDir = path.join(process.cwd(), "state");
const analysisPath = path.join(stateDir, "prometheus_analysis.json");

console.log("=== ATHENA SOLO TEST ===");
console.log(`Loading Prometheus analysis from: ${analysisPath}`);

const config = await loadConfig();
const raw = await fs.readFile(analysisPath, "utf8");
const prometheusAnalysis = JSON.parse(raw);

console.log(`Plans to review: ${prometheusAnalysis.plans?.length ?? 0}`);
console.log("Running Athena review...\n");

const result = await runAthenaPlanReview(config, prometheusAnalysis);

console.log("\n=== ATHENA RESULT ===");
console.log(`approved : ${result.approved}`);
const reason = (result as Record<string, unknown>).reason;
console.log(`reason   : ${typeof reason === "object" ? JSON.stringify(reason) : reason}`);
if (result.corrections?.length) {
  console.log(`corrections (${result.corrections.length}):`);
  for (const c of result.corrections) console.log(`  - ${c}`);
} else {
  console.log("corrections: none");
}
