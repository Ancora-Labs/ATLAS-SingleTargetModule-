/**
 * Tests for T-003: Type and surface state read failures.
 *
 * Contract under test:
 *   readJsonSafe(filePath) → { ok, data, reason, error }
 *     reason ∈ { 'missing', 'invalid', null }
 *
 *   readJson(filePath, fallback) — backward-compat wrapper
 *     emits process event 'box:readError' with { filePath, reason, error, timestamp }
 *     on any failure before returning the fallback.
 *
 *   orchestrator runDaemon startup:
 *     - missing critical file  → operational (first-run expected)
 *     - invalid critical file  → degraded (orchestratorStatus=degraded in orchestrator_health.json)
 *
 *   Critical vs non-critical classification:
 *     Critical  : worker_sessions.json, janus_directive.json, prometheus_analysis.json
 *                 (handled by readJsonSafe in runDaemon)
 *     Non-critical: all other reads throughout the codebase
 *                 (handled by readJson with fallback + event emission)
 */

import { describe, it, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { readJson, readJsonSafe, READ_JSON_REASON } from "../../src/core/fs_utils.js";
import { runOnce, ORCHESTRATOR_STATUS } from "../../src/core/orchestrator.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function withReadErrorListener(fn) {
  return new Promise((resolve, reject) => {
    const events = [];
    const handler = (evt) => events.push(evt);
    process.on("box:readError", handler);
    Promise.resolve()
      .then(() => fn(events))
      .then(resolve, reject)
      .finally(() => process.off("box:readError", handler));
  });
}

// ── READ_JSON_REASON enum ─────────────────────────────────────────────────────

describe("READ_JSON_REASON", () => {
  it("exposes MISSING and INVALID as frozen string constants", () => {
    assert.equal(READ_JSON_REASON.MISSING, "missing");
    assert.equal(READ_JSON_REASON.INVALID, "invalid");
    assert.ok(Object.isFrozen(READ_JSON_REASON), "enum must be frozen");
  });
});

// ── readJsonSafe ──────────────────────────────────────────────────────────────

describe("readJsonSafe", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-fsutils-")); });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns ok=true with parsed data for a valid JSON file", async () => {
    const file = path.join(tmpDir, "valid.json");
    await fs.writeFile(file, JSON.stringify({ hello: "world" }), "utf8");
    const result = await readJsonSafe(file);
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { hello: "world" });
    assert.equal(result.reason, null);
    assert.equal(result.error, null);
  });

  it("returns ok=false with reason=missing for a non-existent file", async () => {
    const result = await readJsonSafe(path.join(tmpDir, "nonexistent.json"));
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.reason, READ_JSON_REASON.MISSING);
    assert.ok(result.error instanceof Error, "error must be an Error instance");
  });

  it("returns ok=false with reason=invalid for a file with corrupt JSON", async () => {
    const file = path.join(tmpDir, "corrupt.json");
    await fs.writeFile(file, "{ not valid json }", "utf8");
    const result = await readJsonSafe(file);
    assert.equal(result.ok, false);
    assert.equal(result.data, null);
    assert.equal(result.reason, READ_JSON_REASON.INVALID);
    assert.ok(result.error instanceof Error, "error must be a parse Error");
  });

  it("distinguishes missing from invalid — negative path: different reason codes", async () => {
    const missingResult = await readJsonSafe(path.join(tmpDir, "does-not-exist.json"));
    const corruptFile = path.join(tmpDir, "bad.json");
    await fs.writeFile(corruptFile, "INVALID", "utf8");
    const invalidResult = await readJsonSafe(corruptFile);

    assert.notEqual(missingResult.reason, invalidResult.reason,
      "missing and invalid must produce different reason codes");
    assert.equal(missingResult.reason, "missing");
    assert.equal(invalidResult.reason, "invalid");
  });

  it("never throws — always returns a structured object", async () => {
    // Even on an unreadable path, readJsonSafe resolves (never rejects)
    const result = await readJsonSafe(path.join(tmpDir, "___nope___", "deep", "file.json"));
    assert.equal(typeof result, "object");
    assert.equal(result.ok, false);
    assert.ok(result.error instanceof Error);
  });
});

// ── readJson (backward-compat wrapper) ───────────────────────────────────────

describe("readJson", () => {
  let tmpDir;
  before(async () => { tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-readjson-")); });
  after(async () => { await fs.rm(tmpDir, { recursive: true, force: true }); });

  it("returns parsed data for a valid JSON file without emitting events", async () => {
    const file = path.join(tmpDir, "ok.json");
    await fs.writeFile(file, JSON.stringify([1, 2, 3]), "utf8");
    await withReadErrorListener(async (events) => {
      const result = await readJson(file, null);
      assert.deepEqual(result, [1, 2, 3]);
      assert.equal(events.length, 0, "no error event should be emitted for a valid file");
    });
  });

  it("returns fallback and emits box:readError with reason=missing for a missing file", async () => {
    const filePath = path.join(tmpDir, "absent.json");
    await withReadErrorListener(async (events) => {
      const result = await readJson(filePath, { default: true });
      assert.deepEqual(result, { default: true });
      assert.equal(events.length, 1, "exactly one box:readError must be emitted");
      const evt = events[0];
      assert.equal(evt.filePath, filePath);
      assert.equal(evt.reason, READ_JSON_REASON.MISSING);
      assert.ok(evt.error instanceof Error);
      assert.ok(typeof evt.timestamp === "string" && evt.timestamp.length > 0);
    });
  });

  it("returns fallback and emits box:readError with reason=invalid for corrupt JSON", async () => {
    const file = path.join(tmpDir, "corrupt2.json");
    await fs.writeFile(file, "{ bad }", "utf8");
    await withReadErrorListener(async (events) => {
      const result = await readJson(file, "FALLBACK");
      assert.equal(result, "FALLBACK");
      assert.equal(events.length, 1);
      assert.equal(events[0].reason, READ_JSON_REASON.INVALID);
    });
  });

  it("negative path: does NOT return corrupt file content — always returns fallback on failure", async () => {
    const file = path.join(tmpDir, "bad3.json");
    await fs.writeFile(file, "definitely-not-json", "utf8");
    const result = await readJson(file, 42);
    assert.equal(result, 42, "must return the fallback, not the corrupt content");
  });
});

// ── Orchestrator degraded state on corrupt critical file ──────────────────────

describe("orchestrator startup — degraded state on corrupt critical state file", () => {
  let tmpDir;
  let config;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-degrade-"));
    config = {
      loopIntervalMs: 1000,
      maxParallelWorkers: 1,
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        workers: { backend: { name: "King David" } }
      },
      copilot: { leadershipAutopilot: false }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes orchestratorStatus=operational when all critical state files are missing (first run)", async () => {
    await runOnce(config);
    const healthPath = path.join(tmpDir, "orchestrator_health.json");
    const raw = await fs.readFile(healthPath, "utf8");
    const health = JSON.parse(raw);
    assert.equal(health.orchestratorStatus, ORCHESTRATOR_STATUS.OPERATIONAL);
    assert.equal(health.reason, null);
    assert.ok(typeof health.recordedAt === "string");
  });

  it("writes orchestratorStatus=degraded when worker_sessions.json contains corrupt JSON", async () => {
    // Write corrupt critical state file
    const sessionsFile = path.join(tmpDir, "worker_sessions.json");
    await fs.writeFile(sessionsFile, "{ corrupt: true, missing-quote }", "utf8");

    await runOnce(config);

    const healthPath = path.join(tmpDir, "orchestrator_health.json");
    const raw = await fs.readFile(healthPath, "utf8");
    const health = JSON.parse(raw);

    assert.equal(health.orchestratorStatus, ORCHESTRATOR_STATUS.DEGRADED,
      "orchestratorStatus must be 'degraded' when a critical state file is corrupt");
    assert.equal(health.reason, "corrupt_state_files");
    assert.ok(Array.isArray(health.details) && health.details.length > 0,
      "details array must list the corrupt file(s)");
    assert.ok(health.details[0].includes("worker_sessions.json"),
      "details must name the corrupt file");

    // Progress log must record the degraded startup
    const progress = await fs.readFile(config.paths.progressFile, "utf8");
    assert.ok(progress.includes("orchestratorStatus=degraded"),
      "progress log must record degraded orchestratorStatus");
    assert.ok(progress.includes("worker_sessions.json"),
      "progress log must name the corrupt file");

    // Clean up for subsequent tests
    await fs.rm(sessionsFile, { force: true });
  });

  it("negative path: corrupt prometheus_analysis.json triggers degraded state (not silent fallback)", async () => {
    const analysisFile = path.join(tmpDir, "prometheus_analysis.json");
    await fs.writeFile(analysisFile, "TOTALLY_INVALID", "utf8");

    await runOnce(config);

    const health = JSON.parse(await fs.readFile(path.join(tmpDir, "orchestrator_health.json"), "utf8"));
    assert.equal(health.orchestratorStatus, ORCHESTRATOR_STATUS.DEGRADED);
    assert.ok(health.details.some(d => d.includes("prometheus_analysis.json")));

    await fs.rm(analysisFile, { force: true });
  });
});

// ── AC5: No broad catch without telemetry ────────────────────────────────────

describe("AC5 — no broad catch without telemetry", () => {
  it("readJsonSafe always surfaces error in return value — never returns undefined error on failure", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-ac5-"));
    try {
      // Missing file
      const r1 = await readJsonSafe(path.join(tmpDir, "x.json"));
      assert.ok(r1.error instanceof Error, "missing: error must be surfaced");

      // Corrupt file
      const f = path.join(tmpDir, "bad.json");
      await fs.writeFile(f, "BAD", "utf8");
      const r2 = await readJsonSafe(f);
      assert.ok(r2.error instanceof Error, "invalid: error must be surfaced");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("readJson always emits box:readError before returning fallback — no silent swallow", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-ac5b-"));
    try {
      const emittedEvents = [];
      const handler = (e) => emittedEvents.push(e);
      process.on("box:readError", handler);
      try {
        await readJson(path.join(tmpDir, "missing.json"), null);
        const f = path.join(tmpDir, "invalid.json");
        await fs.writeFile(f, "BAD", "utf8");
        await readJson(f, null);
      } finally {
        process.off("box:readError", handler);
      }
      assert.equal(emittedEvents.length, 2, "both failures must emit box:readError");
      assert.equal(emittedEvents[0].reason, "missing");
      assert.equal(emittedEvents[1].reason, "invalid");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

