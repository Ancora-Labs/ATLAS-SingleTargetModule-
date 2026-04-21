#!/usr/bin/env node
/**
 * Standalone Scout runner — one-shot research scan for testing/dev.
 */
import { loadConfig } from "../src/config.js";
import { runResearchScout } from "../src/core/research_scout.js";
import path from "node:path";
import { readFile } from "node:fs/promises";

const config = await loadConfig();
const stateDir = config.paths?.stateDir || "state";

console.log("[run_scout_once] Starting Research Scout standalone run...");
const result = await runResearchScout(config);

console.log("\n=== SCOUT RESULT ===");
console.log(JSON.stringify({ success: result.success, sourceCount: result.sourceCount, model: result.model }, null, 2));

// Show the first BLOCKED SOURCES section from latest prompt artifact
try {
  const files = await (await import("node:fs/promises")).readdir(stateDir);
  const promptFiles = files
    .filter(f => f.startsWith("prompt_research-scout_") && f.endsWith(".md"))
    .sort()
    .reverse();
  if (promptFiles.length > 0) {
    const promptPath = path.join(stateDir, promptFiles[0]);
    const content = await readFile(promptPath, "utf8");
    const blockSection = content.match(/## BLOCKED SOURCES[^#]*(?=##|$)/s)?.[0]?.slice(0, 800) || "section not found";
    console.log("\n=== BLOCKED SOURCES SECTION (first 800 chars) ===");
    console.log(blockSection);
    const chars = content.length;
    const blockedCount = (content.match(/BLOCKED SOURCES/g) || []).length;
    const exhaustedCount = (content.match(/Exhausted topic\+site/g) || []).length;
    console.log(`\n[prompt_stats] file=${promptFiles[0]} chars=${chars} BLOCKED_SECTION=${blockedCount} EXHAUSTED_HEADER=${exhaustedCount}`);
  }
} catch { /* best-effort */ }
