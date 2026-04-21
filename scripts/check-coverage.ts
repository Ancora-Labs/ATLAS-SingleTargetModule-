#!/usr/bin/env node
/**
 * check-coverage.js — Enforces minimum line coverage threshold.
 *
 * Reads Node.js built-in test runner coverage output from stdin,
 * parses the "All files" summary row, and exits non-zero if line
 * coverage falls below the configured minimum.
 *
 * Threshold is sourced from box.config.json gates.minCoveragePercent (default: 80).
 *
 * Usage (CI):
 *   node --test --experimental-test-coverage 2>&1 | tee /tmp/coverage-output.txt
 *   node scripts/check-coverage.ts < /tmp/coverage-output.txt
 */

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

// ---------------------------------------------------------------------------
// Load threshold from box.config.json (with fallback)
// ---------------------------------------------------------------------------
const _dir = dirname(fileURLToPath(import.meta.url));
let MIN_COVERAGE = 80; // fallback default

try {
  const configPath = resolve(_dir, "../box.config.json");
  const raw = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(raw);
  const configured = Number(parsed?.gates?.minCoveragePercent);
  if (!isNaN(configured) && configured > 0) {
    MIN_COVERAGE = configured;
  }
} catch {
  // box.config.json unreadable — use default
}

// ---------------------------------------------------------------------------
// Parse coverage from stdin
// ---------------------------------------------------------------------------
const rl = createInterface({ input: process.stdin, terminal: false });
const lines = [];

rl.on("line", (line) => lines.push(line));

rl.on("close", () => {
  // Node.js built-in test coverage (V8) renders a table that includes a row
  // for aggregated totals.  Two possible formats:
  //
  //   Format A (default reporter, Node ≥ 20.10):
  //     "all files | 85.00 | 75.00 | 90.00 | 85.00 |"
  //     columns: file | % Stmts | % Branch | % Funcs | % Lines
  //
  //   Format B (TAP / older nodes): lines that contain "% Lines" or "lines"
  //     "# lines .......... 89.47 %"
  //
  // We try Format A first, fall back to Format B.

  let lineCoverage = null;

  // --- Format A: pipe-delimited table summary row ---
  const allFilesRow = lines.find(
    (l) => /all\s+files/i.test(l) && l.includes("|")
  );

  if (allFilesRow) {
    const parts = allFilesRow.split("|").map((s) => s.trim());
    // parts[0]=name, [1]=% Stmts, [2]=% Branch, [3]=% Funcs, [4]=% Lines
    const candidate = parseFloat(parts[4]);
    if (!isNaN(candidate)) {
      lineCoverage = candidate;
    } else {
      // Fallback: take the first parseable numeric field after the file name
      for (let i = 1; i < parts.length; i++) {
        const v = parseFloat(parts[i]);
        if (!isNaN(v)) {
          lineCoverage = v;
          break;
        }
      }
    }
  }

  // --- Format B: "# lines .......... 89.47 %" style ---
  if (lineCoverage === null) {
    const linesPctRow = lines.find((l) =>
      /^\s*#?\s*lines\s*\.+\s*[\d.]+\s*%/i.test(l)
    );
    if (linesPctRow) {
      const m = linesPctRow.match(/([\d.]+)\s*%/);
      if (m) lineCoverage = parseFloat(m[1]);
    }
  }

  // --- No coverage data found ---
  if (lineCoverage === null) {
    console.log(
      "⚠️  No coverage data detected in test output.\n" +
      "   Ensure --experimental-test-coverage is passed to node --test.\n" +
      "   Skipping threshold check (non-blocking)."
    );
    process.exit(0);
  }

  // --- Threshold enforcement ---
  console.log(
    `📊 Line coverage: ${lineCoverage.toFixed(2)}%  (threshold: ${MIN_COVERAGE}%)`
  );

  if (lineCoverage < MIN_COVERAGE) {
    console.error(
      `❌ Coverage ${lineCoverage.toFixed(2)}% is BELOW the minimum threshold of ${MIN_COVERAGE}%.\n` +
      `   Source: box.config.json → gates.minCoveragePercent=${MIN_COVERAGE}\n` +
      `   Action: add tests to bring line coverage to ≥${MIN_COVERAGE}% before merging.`
    );
    process.exit(1);
  }

  console.log(
    `✅ Coverage ${lineCoverage.toFixed(2)}% meets the minimum threshold of ${MIN_COVERAGE}%.`
  );
  process.exit(0);
});
