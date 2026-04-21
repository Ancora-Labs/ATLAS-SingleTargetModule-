/**
 * si_control.test.ts
 *
 * Unit tests for the Self-Improvement control, gate, and live logging module.
 *
 * Coverage:
 *   - SI_STATUS constants
 *   - readSiControl / writeSiControl: read, write, defaults
 *   - isSelfImprovementActive: config gate, manual gate, guardrail gate, all-pass
 *   - siLog / siLogAsync: writes to live log
 *   - readSiLiveLog: tail read
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  SI_STATUS,
  readSiControl,
  writeSiControl,
  isSelfImprovementActive,
  siLog,
  siLogAsync,
  readSiLiveLog,
} from "../../src/core/si_control.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

let tmpDir;

function makeConfig(overrides = {}) {
  return {
    paths: { stateDir: tmpDir },
    selfImprovement: { enabled: true, ...overrides.selfImprovement },
    ...overrides,
  };
}

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "si-ctrl-test-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ── SI_STATUS constants ──────────────────────────────────────────────────────

describe("SI_STATUS constants", () => {
  it("has expected values", () => {
    assert.equal(SI_STATUS.ACTIVE, "active");
    assert.equal(SI_STATUS.DISABLED_CONFIG, "disabled_config");
    assert.equal(SI_STATUS.DISABLED_MANUAL, "disabled_manual");
    assert.equal(SI_STATUS.DISABLED_GUARDRAIL, "disabled_guardrail");
  });

  it("is frozen", () => {
    assert.throws(() => { SI_STATUS.NEW = "x"; }, TypeError);
  });
});

// ── readSiControl / writeSiControl ───────────────────────────────────────────

describe("readSiControl", () => {
  it("returns defaults when no file exists", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "si-fresh-"));
    try {
      const config = { paths: { stateDir: freshDir }, selfImprovement: { enabled: true } };
      const result = await readSiControl(config);
      assert.equal(result.enabled, true);
      assert.equal(result.reason, "");
      assert.equal(result.updatedAt, null);
      assert.equal(result.updatedBy, "");
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });
});

describe("writeSiControl", () => {
  it("writes and reads back control state", async () => {
    const config = makeConfig();
    const record = await writeSiControl(config, {
      enabled: false,
      reason: "testing",
      updatedBy: "test-suite",
    });

    assert.equal(record.enabled, false);
    assert.equal(record.reason, "testing");
    assert.equal(record.updatedBy, "test-suite");
    assert.ok(record.updatedAt);

    // Read it back
    const readBack = await readSiControl(config);
    assert.equal(readBack.enabled, false);
    assert.equal(readBack.reason, "testing");
    assert.equal(readBack.updatedBy, "test-suite");
  });

  it("re-enables after disable", async () => {
    const config = makeConfig();
    await writeSiControl(config, { enabled: false, reason: "off", updatedBy: "test" });
    await writeSiControl(config, { enabled: true, reason: "back on", updatedBy: "test" });
    const result = await readSiControl(config);
    assert.equal(result.enabled, true);
    assert.equal(result.reason, "back on");
  });
});

// ── isSelfImprovementActive ──────────────────────────────────────────────────

describe("isSelfImprovementActive", () => {
  beforeEach(async () => {
    // Clean up control file + guardrail state
    try { await fs.unlink(path.join(tmpDir, "self_improvement_control.json")); } catch { /* ok */ }
    try { await fs.unlink(path.join(tmpDir, "guardrail_freeze_self_improvement.json")); } catch { /* ok */ }
  });

  it("returns active when all gates pass", async () => {
    const config = makeConfig();
    const gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, true);
    assert.equal(gate.status, SI_STATUS.ACTIVE);
  });

  it("returns disabled_config when config.selfImprovement.enabled=false", async () => {
    const config = makeConfig({ selfImprovement: { enabled: false } });
    const gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, false);
    assert.equal(gate.status, SI_STATUS.DISABLED_CONFIG);
  });

  it("returns disabled_manual when manual control is off", async () => {
    const config = makeConfig();
    await writeSiControl(config, { enabled: false, reason: "testing", updatedBy: "test" });
    const gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, false);
    assert.equal(gate.status, SI_STATUS.DISABLED_MANUAL);
    assert.ok(gate.reason.includes("Manually disabled"));
    assert.ok(gate.reason.includes("testing"));
  });

  it("returns disabled_guardrail when freeze guardrail is active", async () => {
    const config = makeConfig();
    // Write a freeze guardrail state file
    await fs.writeFile(
      path.join(tmpDir, "guardrail_freeze_self_improvement.json"),
      JSON.stringify({ enabled: true, revertedAt: null }),
      "utf8"
    );
    const gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, false);
    assert.equal(gate.status, SI_STATUS.DISABLED_GUARDRAIL);
  });

  it("priority: config > manual > guardrail", async () => {
    // If config is off, it takes priority even if manual and guardrail also say off
    const config = makeConfig({ selfImprovement: { enabled: false } });
    await writeSiControl(config, { enabled: false, reason: "also off", updatedBy: "test" });
    await fs.writeFile(
      path.join(tmpDir, "guardrail_freeze_self_improvement.json"),
      JSON.stringify({ enabled: true, revertedAt: null }),
      "utf8"
    );
    const gate = await isSelfImprovementActive(config);
    assert.equal(gate.status, SI_STATUS.DISABLED_CONFIG);
  });
});

// ── siLog / siLogAsync ───────────────────────────────────────────────────────

describe("siLog (sync)", () => {
  it("appends a line to si_live.log", async () => {
    const logFile = path.join(tmpDir, "si_live.log");
    try { await fs.unlink(logFile); } catch { /* ok */ }

    const config = makeConfig();
    siLog(config, "INFO", "test sync log");

    const content = await fs.readFile(logFile, "utf8");
    assert.ok(content.includes("[INFO"));
    assert.ok(content.includes("test sync log"));
  });
});

describe("siLogAsync", () => {
  it("appends a line to si_live.log", async () => {
    const logFile = path.join(tmpDir, "si_live.log");
    try { await fs.unlink(logFile); } catch { /* ok */ }

    const config = makeConfig();
    await siLogAsync(config, "GATE", "test async log");

    const content = await fs.readFile(logFile, "utf8");
    assert.ok(content.includes("[GATE"));
    assert.ok(content.includes("test async log"));
  });
});

// ── readSiLiveLog ────────────────────────────────────────────────────────────

describe("readSiLiveLog", () => {
  it("returns empty array if no log file", async () => {
    const freshDir = await fs.mkdtemp(path.join(os.tmpdir(), "si-nolog-"));
    try {
      const config = { paths: { stateDir: freshDir }, selfImprovement: { enabled: true } };
      const lines = await readSiLiveLog(config);
      assert.deepEqual(lines, []);
    } finally {
      await fs.rm(freshDir, { recursive: true, force: true });
    }
  });

  it("returns tail lines from log", async () => {
    const config = makeConfig();
    const logFile = path.join(tmpDir, "si_live.log");
    try { await fs.unlink(logFile); } catch { /* ok */ }

    // Write multiple lines
    for (let i = 0; i < 10; i++) {
      await siLogAsync(config, "INFO", "line-" + i);
    }

    const lines = await readSiLiveLog(config, 5);
    assert.equal(lines.length, 5);
    assert.ok(lines[4].includes("line-9"));
  });
});

// ── Integration: toggle round-trip ───────────────────────────────────────────

describe("toggle round-trip", () => {
  beforeEach(async () => {
    try { await fs.unlink(path.join(tmpDir, "self_improvement_control.json")); } catch { /* ok */ }
    try { await fs.unlink(path.join(tmpDir, "guardrail_freeze_self_improvement.json")); } catch { /* ok */ }
  });

  it("disable → check → re-enable → check", async () => {
    const config = makeConfig();

    // Initially active
    let gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, true);

    // Disable
    await writeSiControl(config, { enabled: false, reason: "maintenance", updatedBy: "operator" });
    gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, false);
    assert.equal(gate.status, SI_STATUS.DISABLED_MANUAL);

    // Re-enable
    await writeSiControl(config, { enabled: true, reason: "done", updatedBy: "operator" });
    gate = await isSelfImprovementActive(config);
    assert.equal(gate.active, true);
    assert.equal(gate.status, SI_STATUS.ACTIVE);
  });
});
