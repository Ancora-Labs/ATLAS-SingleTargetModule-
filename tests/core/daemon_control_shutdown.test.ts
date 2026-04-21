/**
 * daemon_control_shutdown.test.ts
 *
 * Deterministic failure-path tests for daemon shutdown and daemon-control
 * stale-state and forced-termination flows.
 *
 * Coverage:
 *   writeDaemonPid   — stale PID overwrite + alive PID rejection (forced termination block)
 *   clearAllAIState  — removes declared state files; tolerates missing state dir
 *   requestDaemonStop / requestDaemonReload — write stop/reload contracts
 *   readStopRequest  — returns null when no stop file is present
 *   clearStopRequest — removes the stop file
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  writeDaemonPid,
  clearDaemonPid,
  readDaemonPid,
  requestDaemonStop,
  readStopRequest,
  clearStopRequest,
  requestDaemonReload,
  readReloadRequest,
  clearReloadRequest,
  clearAllAIState,
  isProcessAlive,
} from "../../src/core/daemon_control.js";

function makeConfig(stateDir: string) {
  return { paths: { stateDir } };
}

// ── writeDaemonPid — stale state ─────────────────────────────────────────────

describe("writeDaemonPid — stale PID overwrite", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-daemon-stale-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates PID file on first write", async () => {
    const config = makeConfig(tmpDir);
    await writeDaemonPid(config);
    const stored = await readDaemonPid(config);
    assert.equal(typeof stored?.pid, "number");
    assert.ok(stored.pid > 0);
    await clearDaemonPid(config);
  });

  it("silently overwrites a stale (dead) PID file without throwing", async () => {
    const config = makeConfig(tmpDir);
    const pidFile = path.join(tmpDir, "daemon.pid.json");

    // Write a PID that is astronomically unlikely to be alive
    await fs.writeFile(pidFile, JSON.stringify({ pid: 9999999, startedAt: new Date().toISOString() }), "utf8");
    assert.equal(isProcessAlive(9999999), false, "test precondition: PID 9999999 must not be alive");

    // Must not throw — stale PID should be overwritten
    await assert.doesNotReject(
      () => writeDaemonPid(config),
      "writeDaemonPid must overwrite a stale PID file without throwing"
    );

    const stored = await readDaemonPid(config);
    assert.equal(stored?.pid, process.pid, "overwritten PID must equal the current process PID");
    await clearDaemonPid(config);
  });
});

// ── writeDaemonPid — forced termination block ────────────────────────────────

describe("writeDaemonPid — forced termination: rejects when daemon is alive", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-daemon-alive-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws 'daemon already running' when PID file contains an alive PID", async () => {
    const config = makeConfig(tmpDir);
    const pidFile = path.join(tmpDir, "daemon.pid.json");

    // Write the current process PID — this is guaranteed to be alive
    await fs.writeFile(pidFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), "utf8");

    await assert.rejects(
      () => writeDaemonPid(config),
      (err: Error) => {
        assert.ok(
          /daemon already running/i.test(err.message),
          `error message must include 'daemon already running'; got: "${err.message}"`
        );
        return true;
      }
    );
  });
});

// ── clearAllAIState — stale state removal ────────────────────────────────────

describe("clearAllAIState — removes declared state files", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-shutdown-state-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("removes well-known state files and returns their names", async () => {
    const config = makeConfig(tmpDir);

    // Pre-create a subset of known shutdown-clear files
    const filesToCreate = ["daemon.pid.json", "worker_sessions.json", "janus_directive.json"];
    for (const f of filesToCreate) {
      await fs.writeFile(path.join(tmpDir, f), "{}", "utf8");
    }

    const cleared = await clearAllAIState(config);

    for (const f of filesToCreate) {
      assert.ok(cleared.includes(f), `cleared list must include ${f}`);
      let exists = true;
      try { await fs.access(path.join(tmpDir, f)); } catch { exists = false; }
      assert.equal(exists, false, `${f} must be removed after clearAllAIState`);
    }
  });

  it("succeeds even when state dir does not exist (empty stale state)", async () => {
    const missingDir = path.join(os.tmpdir(), `box-missing-state-${Date.now()}`);
    const config = makeConfig(missingDir);
    // Must not throw when state dir is absent
    await assert.doesNotReject(
      () => clearAllAIState(config),
      "clearAllAIState must not throw when state dir is absent"
    );
  });

  it("removes per-worker state files matching worker_*.json pattern", async () => {
    const config = makeConfig(tmpDir);

    const workerFile = "worker_king_david.json";
    await fs.writeFile(path.join(tmpDir, workerFile), "{}", "utf8");

    const cleared = await clearAllAIState(config);
    assert.ok(cleared.includes(workerFile), "per-worker state files must be cleared");

    let exists = true;
    try { await fs.access(path.join(tmpDir, workerFile)); } catch { exists = false; }
    assert.equal(exists, false, "per-worker file must be removed");
  });
});

// ── requestDaemonStop / readStopRequest / clearStopRequest ───────────────────

describe("daemon stop-request contract", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-stop-req-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no stop file exists (negative path)", async () => {
    const config = makeConfig(tmpDir);
    const result = await readStopRequest(config);
    assert.equal(result, null, "readStopRequest must return null when no stop file is present");
  });

  it("writes a stop file with requestedAt and reason fields", async () => {
    const config = makeConfig(tmpDir);
    await requestDaemonStop(config, "forced-shutdown");
    const stored = await readStopRequest(config);
    assert.ok(stored !== null, "stop file must be readable after requestDaemonStop");
    assert.equal(typeof stored.requestedAt, "string", "requestedAt must be a string");
    assert.equal(stored.reason, "forced-shutdown", "reason must match the argument passed");
    await clearStopRequest(config);
  });

  it("clearStopRequest removes the stop file so readStopRequest returns null", async () => {
    const config = makeConfig(tmpDir);
    await requestDaemonStop(config, "test-clear");
    await clearStopRequest(config);
    const result = await readStopRequest(config);
    assert.equal(result, null, "readStopRequest must return null after clearStopRequest");
  });
});

// ── requestDaemonReload / readReloadRequest / clearReloadRequest ─────────────

describe("daemon reload-request contract", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-reload-req-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when no reload file exists (negative path)", async () => {
    const config = makeConfig(tmpDir);
    const result = await readReloadRequest(config);
    assert.equal(result, null, "readReloadRequest must return null when no reload file is present");
  });

  it("writes a reload file with requestedAt and reason fields", async () => {
    const config = makeConfig(tmpDir);
    await requestDaemonReload(config, "config-hot-reload");
    const stored = await readReloadRequest(config);
    assert.ok(stored !== null, "reload file must be readable after requestDaemonReload");
    assert.equal(typeof stored.requestedAt, "string");
    assert.equal(stored.reason, "config-hot-reload");
    await clearReloadRequest(config);
  });

  it("clearReloadRequest removes the reload file so readReloadRequest returns null", async () => {
    const config = makeConfig(tmpDir);
    await requestDaemonReload(config, "test-clear-reload");
    await clearReloadRequest(config);
    const result = await readReloadRequest(config);
    assert.equal(result, null, "readReloadRequest must return null after clearReloadRequest");
  });
});

