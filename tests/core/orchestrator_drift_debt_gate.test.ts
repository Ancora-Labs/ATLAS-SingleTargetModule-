/**
 * orchestrator_drift_debt_gate.test.ts
 *
 * Tests for the mandatory drift debt gate in evaluatePreDispatchGovernanceGate.
 *
 * The gate blocks dispatch when the provided ArchitectureDriftReport contains
 * high-priority findings (stale references to src/core/ files). These findings
 * represent mandatory drift debt that must be resolved before dispatch proceeds.
 *
 * Acceptance criteria:
 *   - Dispatch is blocked when any high-priority (src/core/) stale ref is present.
 *   - Dispatch proceeds when only medium/low-priority drift debt exists.
 *   - Dispatch proceeds when the drift report is null (no report provided).
 *   - Dispatch proceeds when config.runtime.disableDriftDebtGate === true.
 *   - The block reason starts with "mandatory_drift_debt_unresolved:".
 *   - Gate is fail-open: a malformed report does not block dispatch.
 *   - Negative path: medium-priority stale refs (src/ non-core) do not block.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluatePreDispatchGovernanceGate } from "../../src/core/orchestrator.js";
import type { ArchitectureDriftReport } from "../../src/core/architecture_drift.js";

// Minimal config sufficient to reach the drift debt gate (all other gates pass-through).
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    systemGuardian: { enabled: false },
    governance: { freeze: { active: false } },
    carryForward: { maxCriticalOverdue: 999 },
    budget: { enabled: false },
    workerPool: { minLanes: 1 },
    paths: { stateDir: "/tmp/box-drift-gate-test" },
    runtime: {},
    ...overrides,
  };
}

function makeEmptyDriftReport(): ArchitectureDriftReport {
  return {
    scannedDocs: [],
    presentCount: 0,
    staleCount: 0,
    staleReferences: [],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

function makeDriftReportWithHighPriority(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 1,
    staleReferences: [
      // src/core/ prefix → high priority
      { docPath: "docs/arch.md", referencedPath: "src/core/ghost_module.ts", line: 5 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

function makeDriftReportWithMediumPriority(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 1,
    staleReferences: [
      // src/ but not src/core/ → medium priority
      { docPath: "docs/arch.md", referencedPath: "src/workers/old_worker.ts", line: 3 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

function makeDriftReportWithLowPriority(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 1,
    staleReferences: [
      // scripts/ → low priority
      { docPath: "docs/arch.md", referencedPath: "scripts/deploy.sh", line: 7 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

function makeDriftReportWithDeprecatedTokensOnly(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 0,
    staleReferences: [],
    deprecatedTokenCount: 1,
    deprecatedTokenRefs: [
      { docPath: "docs/arch.md", token: "resume_dispatch", hint: "use runResumeDispatch", line: 2 },
    ],
  };
}

describe("evaluatePreDispatchGovernanceGate — mandatory drift debt gate", () => {
  it("returns blocked=false when driftReport is null", async () => {
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", null);
    assert.equal(result.blocked, false, "null driftReport must not block dispatch");
  });

  it("returns blocked=false when driftReport is omitted (default)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle");
    assert.equal(result.blocked, false, "missing driftReport must not block dispatch");
  });

  it("returns blocked=false for an empty drift report (no findings)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", makeEmptyDriftReport());
    assert.equal(result.blocked, false, "empty drift report must not block dispatch");
  });

  it("blocks dispatch when a high-priority stale ref (src/core/) is present", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makeConfig(), [], "test-cycle", makeDriftReportWithHighPriority()
    );
    assert.equal(result.blocked, true, "high-priority drift debt must block dispatch");
    assert.ok(
      typeof result.reason === "string" && result.reason.startsWith("mandatory_drift_debt_unresolved:"),
      `reason must start with 'mandatory_drift_debt_unresolved:' — got: ${result.reason}`
    );
  });

  it("block reason includes count of mandatory debt tasks", async () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/a.md"],
      presentCount: 0,
      staleCount: 2,
      staleReferences: [
        { docPath: "docs/a.md", referencedPath: "src/core/missing_a.ts", line: 1 },
        { docPath: "docs/a.md", referencedPath: "src/core/missing_b.ts", line: 2 },
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", report);
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.includes("2 high-priority"),
      `reason must mention count — got: ${result.reason}`
    );
  });

  it("does NOT block when only medium-priority drift debt exists (src/ non-core)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makeConfig(), [], "test-cycle", makeDriftReportWithMediumPriority()
    );
    assert.equal(result.blocked, false, "medium-priority drift debt must not block dispatch");
  });

  it("does NOT block when only low-priority drift debt exists (scripts/docker/docs)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makeConfig(), [], "test-cycle", makeDriftReportWithLowPriority()
    );
    assert.equal(result.blocked, false, "low-priority drift debt must not block dispatch");
  });

  it("does NOT block when only deprecated tokens are present (no stale refs)", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      makeConfig(), [], "test-cycle", makeDriftReportWithDeprecatedTokensOnly()
    );
    assert.equal(result.blocked, false, "deprecated token findings alone must not block dispatch");
  });

  it("does NOT block when config.runtime.disableDriftDebtGate is true even with high-priority debt", async () => {
    const config = makeConfig({ runtime: { disableDriftDebtGate: true } });
    const result = await evaluatePreDispatchGovernanceGate(
      config, [], "test-cycle", makeDriftReportWithHighPriority()
    );
    assert.equal(result.blocked, false, "gate must be skipped when disableDriftDebtGate=true");
  });

  it("is fail-open: malformed driftReport does not block dispatch", async () => {
    // Pass an object that looks like a drift report but rankStaleRefsAsRemediationCandidates
    // may handle gracefully — should never throw and block.
    const malformed = { staleReferences: null, deprecatedTokenRefs: null } as any;
    let result: any;
    try {
      result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", malformed);
    } catch {
      assert.fail("evaluatePreDispatchGovernanceGate must not throw on malformed drift report");
    }
    // Either passes through (blocked=false) or returns a non-drift-debt block reason
    // The key invariant: must not block with mandatory_drift_debt_unresolved reason
    if (result.blocked) {
      assert.ok(
        !result.reason?.startsWith("mandatory_drift_debt_unresolved:"),
        "malformed report must not produce a mandatory drift debt block — it must fail-open"
      );
    }
  });

  it("mixed report: blocks when high-priority exists even if medium/low also present", async () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/a.md"],
      presentCount: 0,
      staleCount: 3,
      staleReferences: [
        { docPath: "docs/a.md", referencedPath: "src/core/critical.ts", line: 1 },    // high
        { docPath: "docs/a.md", referencedPath: "src/providers/old.ts", line: 2 },    // medium
        { docPath: "docs/a.md", referencedPath: "scripts/old_script.sh", line: 3 },   // low
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", report);
    assert.equal(result.blocked, true, "mixed report with high-priority item must block dispatch");
    assert.ok(result.reason?.startsWith("mandatory_drift_debt_unresolved:"));
  });

  it("blocks for elevated-priority autonomous playbook drift even without src/core path", async () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/autonomous-dev-playbook.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [
        { docPath: "docs/autonomous-dev-playbook.md", referencedPath: "src/missing.ts", line: 8 },
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", report);
    assert.equal(result.blocked, true, "elevated-priority playbook drift debt must block dispatch");
    assert.ok(result.reason?.startsWith("mandatory_drift_debt_unresolved:"));
  });

  it("blocked result includes mandatoryDriftPaths listing the missing high-priority files", async () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/a.md"],
      presentCount: 0,
      staleCount: 2,
      staleReferences: [
        { docPath: "docs/a.md", referencedPath: "src/core/alpha.ts", line: 1 },
        { docPath: "docs/a.md", referencedPath: "src/core/beta.ts",  line: 2 },
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", report);
    assert.equal(result.blocked, true);
    assert.ok(
      Array.isArray((result as any).mandatoryDriftPaths),
      "blocked result must include mandatoryDriftPaths array"
    );
    assert.ok(
      (result as any).mandatoryDriftPaths.includes("src/core/alpha.ts"),
      "mandatoryDriftPaths must include src/core/alpha.ts"
    );
    assert.ok(
      (result as any).mandatoryDriftPaths.includes("src/core/beta.ts"),
      "mandatoryDriftPaths must include src/core/beta.ts"
    );
  });

  it("non-blocked result does not include mandatoryDriftPaths", async () => {
    const result = await evaluatePreDispatchGovernanceGate(makeConfig(), [], "test-cycle", makeEmptyDriftReport());
    assert.equal(result.blocked, false);
    assert.ok(
      !(result as any).mandatoryDriftPaths,
      "non-blocked result must not include mandatoryDriftPaths"
    );
  });
});
