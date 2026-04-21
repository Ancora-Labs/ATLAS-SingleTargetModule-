import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getRoleRegistry,
  LANE_WORKER_NAMES,
  WORKER_CAPABILITIES,
  normalizePlanRoleToWorkerName,
} from "../../src/core/role_registry.js";

describe("role_registry", () => {
  it("returns fallback registry when config is missing", () => {
    const registry = getRoleRegistry(undefined);
    assert.equal(registry.ceoSupervisor.name, "Janus");
    assert.equal(registry.planner.name, "Prometheus");
    assert.equal(registry.workers.evolution.name, "evolution-worker");
  });

  it("negative path: merges custom workers without dropping fallback evolution worker", () => {
    const registry = getRoleRegistry({
      roleRegistry: {
        workers: { backend: { id: "worker-backend", name: "Backend Worker", model: "x" } }
      }
    });
    assert.equal(registry.workers.backend.name, "Backend Worker");
    assert.equal(registry.workers.evolution.name, "evolution-worker");
  });

  it("all six lane workers are registered", () => {
    const registry = getRoleRegistry(undefined);
    const lanes = ["implementation", "quality", "governance", "infrastructure", "integration", "observation"];
    const registeredLanes = Object.values(registry.workers).map((w: any) => w.lane);
    for (const lane of lanes) {
      assert.ok(registeredLanes.includes(lane), `Missing lane worker for: ${lane}`);
    }
  });

  it("LANE_WORKER_NAMES covers all six lanes", () => {
    const expected = ["implementation", "quality", "governance", "infrastructure", "integration", "observation"];
    for (const lane of expected) {
      assert.ok(LANE_WORKER_NAMES[lane], `LANE_WORKER_NAMES missing entry for lane: ${lane}`);
    }
  });

  it("implementation lane maps to kebab-case evolution-worker", () => {
    assert.equal(LANE_WORKER_NAMES["implementation"], "evolution-worker");
  });

  it("all lanes map to kebab-case hyphenated worker names", () => {
    assert.equal(LANE_WORKER_NAMES["quality"], "quality-worker");
    assert.equal(LANE_WORKER_NAMES["governance"], "governance-worker");
    assert.equal(LANE_WORKER_NAMES["infrastructure"], "infrastructure-worker");
    assert.equal(LANE_WORKER_NAMES["integration"], "integration-worker");
    assert.equal(LANE_WORKER_NAMES["observation"], "observation-worker");
  });
});

describe("WORKER_CAPABILITIES", () => {
  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(WORKER_CAPABILITIES));
  });

  it("has entries for all six lane workers", () => {
    const expected = Object.values(LANE_WORKER_NAMES);
    for (const workerName of expected) {
      assert.ok(workerName in WORKER_CAPABILITIES, `Missing WORKER_CAPABILITIES entry for: ${workerName}`);
    }
  });

  it("each worker declares at least one capability", () => {
    for (const [worker, caps] of Object.entries(WORKER_CAPABILITIES)) {
      assert.ok(Array.isArray(caps) && caps.length > 0, `${worker} must declare at least one capability`);
    }
  });

  it("governance-worker is the only worker declaring state-governance", () => {
    const declaring = Object.entries(WORKER_CAPABILITIES)
      .filter(([, caps]) => (caps as readonly string[]).includes("state-governance"))
      .map(([name]) => name);
    assert.deepEqual(declaring, ["governance-worker"]);
  });

  it("negative path: unknown worker name returns undefined (no throw)", () => {
    const caps = (WORKER_CAPABILITIES as any)["nonexistent-worker"];
    assert.equal(caps, undefined);
  });
});

// ── normalizePlanRoleToWorkerName ─────────────────────────────────────────────

describe("normalizePlanRoleToWorkerName", () => {
  it("normalizes 'Evolution Worker' to 'evolution-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("Evolution Worker"), "evolution-worker");
  });

  it("normalizes 'evolution-worker' to 'evolution-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("evolution-worker"), "evolution-worker");
  });

  it("normalizes 'quality-worker' to 'quality-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("quality-worker"), "quality-worker");
  });

  it("normalizes lane key 'governance' to 'governance-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("governance"), "governance-worker");
  });

  it("normalizes lane key 'infrastructure' to 'infrastructure-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("infrastructure"), "infrastructure-worker");
  });

  it("normalizes lane key 'integration' to 'integration-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("integration"), "integration-worker");
  });

  it("normalizes lane key 'observation' to 'observation-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("observation"), "observation-worker");
  });

  it("normalizes lane key 'quality' to 'quality-worker'", () => {
    assert.equal(normalizePlanRoleToWorkerName("quality"), "quality-worker");
  });

  it("falls back to 'evolution-worker' for unregistered name 'King David'", () => {
    assert.equal(normalizePlanRoleToWorkerName("King David"), "evolution-worker");
  });

  it("falls back to 'evolution-worker' for unregistered name 'Esther'", () => {
    assert.equal(normalizePlanRoleToWorkerName("Esther"), "evolution-worker");
  });

  it("falls back to 'evolution-worker' for null/undefined", () => {
    assert.equal(normalizePlanRoleToWorkerName(null), "evolution-worker");
    assert.equal(normalizePlanRoleToWorkerName(undefined), "evolution-worker");
  });

  it("negative: 'unknown' falls back to 'evolution-worker' (not kept as 'unknown')", () => {
    assert.equal(normalizePlanRoleToWorkerName("unknown"), "evolution-worker",
      "'unknown' must be remapped to evolution-worker, not left as an unresolvable role identity");
  });
});

