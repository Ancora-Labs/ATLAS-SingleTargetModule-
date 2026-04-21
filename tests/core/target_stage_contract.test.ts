import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  SHADOW_SAFE_TASK_KINDS,
  splitTargetStagePlans,
} from "../../src/core/target_stage_contract.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";
import { TARGET_SESSION_STAGE } from "../../src/core/target_session_state.js";

function buildShadowConfig() {
  return {
    platformModeState: {
      currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    },
    activeTargetSession: {
      currentStage: TARGET_SESSION_STAGE.SHADOW,
      gates: {
        allowShadowExecution: true,
        allowActiveExecution: false,
      },
    },
  };
}

describe("target_stage_contract", () => {
  it("prunes shadow-incompatible plans while preserving compliant plans", () => {
    const result = splitTargetStagePlans([
      {
        title: "Capture baseline truth",
        task: "Collect current test output and document UI inventory",
        taskKind: "test",
        targetFiles: ["app.js", "index.html", "style.css", "tests/core/app.test.js"],
      },
      {
        title: "Ship premium shell",
        task: "Implement polished mobile-first shell and release it",
        taskKind: "implementation",
        targetFiles: ["app.js", "index.html", "style.css"],
      },
    ], buildShadowConfig());

    assert.equal(result.active, true);
    assert.deepEqual(SHADOW_SAFE_TASK_KINDS.includes("test"), true);
    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.rejectedPlans.length, 1);
    assert.match(result.summary || "", /shadow mode forbids high-risk action intent: release/);
  });

  it("allows one bounded low-risk implementation packet in shadow mode", () => {
    const result = splitTargetStagePlans([
      {
        title: "Prove a small safe UI slice",
        task: "Implement a bounded hero copy and CTA refinement without broad delivery changes.",
        taskKind: "implementation",
        targetFiles: ["index.html", "style.css", "app.js"],
        verification: "npm test -- tests/core/app.test.js",
      },
      {
        title: "Lock the verification baseline",
        task: "Run focused tests and document the proving step.",
        taskKind: "verification",
        targetFiles: ["tests/core/app.test.js"],
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 2);
    assert.equal(result.rejectedPlans.length, 0);
  });

  it("rejects multiple implementation packets in a single shadow cycle", () => {
    const result = splitTargetStagePlans([
      {
        title: "First bounded proving step",
        task: "Implement a small UI refinement only.",
        taskKind: "implementation",
        targetFiles: ["index.html", "style.css"],
        verification: "npm test -- tests/core/app.test.js",
      },
      {
        title: "Second bounded proving step",
        task: "Implement another independent change in the same shadow cycle.",
        taskKind: "implementation",
        targetFiles: ["app.js", "style.css"],
        verification: "npm test -- tests/core/other.test.js",
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.rejectedPlans.length, 1);
    assert.match(result.summary || "", /at most 1 bounded implementation packet/);
  });

  it("acts as a no-op outside shadow runtime", () => {
    const plans = [{ taskKind: "implementation", title: "Ship feature" }];
    const result = splitTargetStagePlans(plans, {
      platformModeState: {
        currentMode: PLATFORM_MODE.SELF_DEV,
      },
      activeTargetSession: {
        currentStage: TARGET_SESSION_STAGE.ACTIVE,
        gates: {
          allowShadowExecution: false,
          allowActiveExecution: true,
        },
      },
    });

    assert.equal(result.active, false);
    assert.equal(result.rejectedPlans.length, 0);
    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.admittedPlans[0], plans[0]);
  });

  it("allows broader low-risk audit scope in shadow mode", () => {
    const result = splitTargetStagePlans([
      {
        title: "Audit current source and lock the real baseline",
        task: "Read package.json, app.js, index.html, style.css, tests/core/app.test.js, and one generated audit test file.",
        taskKind: "test",
        targetFiles: [
          "package.json",
          "app.js",
          "index.html",
          "style.css",
          "tests/core/app.test.js",
          "tests/core/audit_baseline.test.ts",
        ],
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.rejectedPlans.length, 0);
  });

  it("rejects shadow implementation packets that do not carry concrete verification", () => {
    const result = splitTargetStagePlans([
      {
        title: "Prove a tiny UI slice",
        task: "Implement a tiny safe UI refinement only.",
        taskKind: "implementation",
        targetFiles: ["index.html", "style.css"],
        verification: "npm test",
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 0);
    assert.equal(result.rejectedPlans.length, 1);
    assert.match(result.summary || "", /must include concrete verification evidence/i);
  });

  it("rejects shadow batches that do not produce evidence", () => {
    const result = splitTargetStagePlans([
      {
        title: "Draft the proving-step notes",
        task: "Document the intended proving step without running verification.",
        taskKind: "docs",
        targetFiles: ["docs/proof.md"],
      },
      {
        title: "Refine planning notes",
        task: "Tighten the shadow plan summary only.",
        taskKind: "planning",
        targetFiles: ["docs/plan.md"],
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 0);
    assert.equal(result.rejectedPlans.length, 2);
    assert.match(result.summary || "", /requires at least one evidence-producing packet/i);
  });

  it("allows a bounded shadow bugfix packet when the extra file is only evidence", () => {
    const result = splitTargetStagePlans([
      {
        title: "Scaffold the first CLI slice",
        task: "Implement the initial modular CLI scaffold and verify it with one focused registry test.",
        taskKind: "bugfix",
        targetFiles: ["package.json", "tsconfig.json", "src/core/registry.ts", "src/index.ts", "tests/core/registry.test.ts"],
        verification: "npm run typecheck && node --test tests/core/registry.test.ts",
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.rejectedPlans.length, 0);
  });

  it("does not treat negated deployment wording as a high-risk shadow intent", () => {
    const result = splitTargetStagePlans([
      {
        title: "Bound the first scaffold",
        task: "Implement a small CLI foundation only. Do not add deployment, rollout, or release steps in this shadow cycle.",
        taskKind: "implementation",
        targetFiles: ["package.json", "src/index.ts"],
        verification: "node --test tests/core/registry.test.ts && npm run typecheck -- --pretty false",
      },
    ], buildShadowConfig());

    assert.equal(result.admittedPlans.length, 1);
    assert.equal(result.rejectedPlans.length, 0);
  });
});