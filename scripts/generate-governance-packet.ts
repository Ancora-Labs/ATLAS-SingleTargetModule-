#!/usr/bin/env node
/**
 * generate-governance-packet.mjs — CLI trigger for governance review packet generation.
 *
 * Generates a deterministic monthly governance review packet from state artifacts.
 *
 * Usage:
 *   node scripts/generate-governance-packet.ts [--month YYYY-MM] [--state-dir <path>] [--dry-run]
 *
 * Options:
 *   --month <YYYY-MM>    Target month for the packet (default: current UTC month)
 *   --state-dir <path>   Path to state directory (default: state)
 *   --dry-run            Generate packet but do not write to disk; print to stdout
 *
 * Exit codes:
 *   0 — packet generated and persisted successfully (or dry-run completed)
 *   1 — packet generation or persistence failed
 *   2 — invalid argument provided
 *
 * Output:
 *   state/governance_packets/governance_packet_{YYYY-MM}.json
 *
 * (Athena missing item #4 resolved — trigger mechanism is this CLI entrypoint)
 */

import { generateGovernancePacket, persistGovernancePacket } from "../src/core/governance_review_packet.js";

// ── Parse arguments ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let monthArg    = null;
let stateDirArg = "state";
let dryRun      = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--month"     && args[i + 1]) { monthArg    = args[++i]; continue; }
  if (args[i] === "--state-dir" && args[i + 1]) { stateDirArg = args[++i]; continue; }
  if (args[i] === "--dry-run")                  { dryRun      = true;      continue; }
}

if (monthArg && !/^\d{4}-\d{2}$/.test(monthArg)) {
  console.error(`[governance-packet] ERROR: --month must be YYYY-MM, got "${monthArg}"`);
  process.exit(2);
}

// ── Build minimal config ───────────────────────────────────────────────────────

const config = {
  paths: { stateDir: stateDirArg }
};

// ── Generate packet ────────────────────────────────────────────────────────────

const targetMonth = monthArg || undefined;
console.log(`[governance-packet] Generating packet for month: ${targetMonth ?? "(current)"} state-dir: ${stateDirArg}`);

let genResult;
try {
  genResult = await generateGovernancePacket(config, targetMonth);
} catch (err) {
  console.error(`[governance-packet] FATAL: unexpected error during generation: ${String(err?.message || err)}`);
  process.exit(1);
}

if (!genResult.ok) {
  console.error(`[governance-packet] ERROR: packet generation returned ok=false`);
  process.exit(1);
}

const { packet, status } = genResult;
console.log(`[governance-packet] status=${status} monthKey=${packet.monthKey} cycleId=${packet.cycleId}`);

if (status === "degraded") {
  const degradedSources = packet.degradedSources || [];
  console.warn(`[governance-packet] DEGRADED sources: ${JSON.stringify(degradedSources)}`);
}

// ── Dry-run: print and exit without writing ────────────────────────────────────

if (dryRun) {
  console.log("[governance-packet] dry-run: packet NOT written to disk");
  console.log(JSON.stringify(packet, null, 2));
  process.exit(0);
}

// ── Persist packet ─────────────────────────────────────────────────────────────

let persistResult;
try {
  persistResult = await persistGovernancePacket(config, packet);
} catch (err) {
  console.error(`[governance-packet] FATAL: unexpected error during persist: ${String(err?.message || err)}`);
  process.exit(1);
}

if (!persistResult.ok) {
  console.error(`[governance-packet] ERROR: persist failed — ${persistResult.reason}`);
  process.exit(1);
}

console.log(`[governance-packet] OK: packet written to ${persistResult.filePath}`);
