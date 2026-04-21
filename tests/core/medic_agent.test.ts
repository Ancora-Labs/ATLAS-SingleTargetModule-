import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  shouldTriggerMedic,
  pauseLane,
  resumeLane,
  isLanePaused,
  getPausedLanes,
  MEDIC_TRIGGER,
} from "../../src/core/medic_agent.js";

describe("medic_agent", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-medic-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── shouldTriggerMedic ─────────────────────────────────────────────────

  describe("shouldTriggerMedic", () => {
    it("returns signal for plans=0", () => {
      const signal = shouldTriggerMedic({ plansCount: 0 });
      assert.ok(signal);
      assert.equal(signal.trigger, MEDIC_TRIGGER.PLANS_ZERO);
      assert.equal(signal.source, "Prometheus");
      assert.ok(signal.message.includes("0 plans"));
    });

    it("returns null when plans > 0", () => {
      const signal = shouldTriggerMedic({ plansCount: 5 });
      assert.equal(signal, null);
    });

    it("returns signal for system error (string)", () => {
      const signal = shouldTriggerMedic({ error: "connection refused" });
      assert.ok(signal);
      assert.equal(signal.trigger, MEDIC_TRIGGER.SYSTEM_ERROR);
      assert.ok(signal.message.includes("connection refused"));
    });

    it("returns signal for system error (Error object)", () => {
      const signal = shouldTriggerMedic({ error: new Error("spawn failed") });
      assert.ok(signal);
      assert.equal(signal.trigger, MEDIC_TRIGGER.SYSTEM_ERROR);
      assert.ok(signal.message.includes("spawn failed"));
    });

    it("returns signal for parser failure", () => {
      const signal = shouldTriggerMedic({ parserFailed: true });
      assert.ok(signal);
      assert.equal(signal.trigger, MEDIC_TRIGGER.PARSER_FAILURE);
    });

    it("returns null when no error signals", () => {
      const signal = shouldTriggerMedic({});
      assert.equal(signal, null);
    });

    it("returns null for undefined plansCount", () => {
      const signal = shouldTriggerMedic({ plansCount: undefined });
      assert.equal(signal, null);
    });

    it("prioritises plans=0 over parser failure", () => {
      const signal = shouldTriggerMedic({ plansCount: 0, parserFailed: true });
      assert.ok(signal);
      assert.equal(signal.trigger, MEDIC_TRIGGER.PLANS_ZERO);
    });
  });

  // ── Lane pause / resume ────────────────────────────────────────────────

  describe("lane pause/resume", () => {
    it("pauses and detects a lane", async () => {
      await pauseLane(tmpDir, "planning", "test reason");
      const paused = await isLanePaused(tmpDir, "planning");
      assert.equal(paused, true);
    });

    it("resumes a paused lane", async () => {
      await pauseLane(tmpDir, "planning", "test reason");
      await resumeLane(tmpDir, "planning");
      const paused = await isLanePaused(tmpDir, "planning");
      assert.equal(paused, false);
    });

    it("non-paused lane returns false", async () => {
      const paused = await isLanePaused(tmpDir, "nonexistent");
      assert.equal(paused, false);
    });

    it("getPausedLanes returns all paused lanes", async () => {
      await pauseLane(tmpDir, "planning", "reason1");
      await pauseLane(tmpDir, "review", "reason2");
      const paused = await getPausedLanes(tmpDir);
      assert.ok("planning" in paused);
      assert.ok("review" in paused);
      assert.equal(paused.planning.reason, "reason1");
      assert.equal(paused.review.reason, "reason2");
    });

    it("resume only removes specified lane", async () => {
      await pauseLane(tmpDir, "planning", "r1");
      await pauseLane(tmpDir, "review", "r2");
      await resumeLane(tmpDir, "planning");
      const paused = await getPausedLanes(tmpDir);
      assert.ok(!("planning" in paused));
      assert.ok("review" in paused);
    });

    it("pause overwrites existing pause entry", async () => {
      await pauseLane(tmpDir, "planning", "old reason");
      await pauseLane(tmpDir, "planning", "new reason");
      const paused = await getPausedLanes(tmpDir);
      assert.equal(paused.planning.reason, "new reason");
    });
  });

  // ── MEDIC_TRIGGER constants ────────────────────────────────────────────

  describe("MEDIC_TRIGGER constants", () => {
    it("has expected trigger types", () => {
      assert.equal(MEDIC_TRIGGER.PLANS_ZERO, "plans_zero");
      assert.equal(MEDIC_TRIGGER.AGENT_CRASH, "agent_crash");
      assert.equal(MEDIC_TRIGGER.PARSER_FAILURE, "parser_failure");
      assert.equal(MEDIC_TRIGGER.SYSTEM_ERROR, "system_error");
    });

    it("is frozen (immutable)", () => {
      assert.ok(Object.isFrozen(MEDIC_TRIGGER));
    });
  });
});
