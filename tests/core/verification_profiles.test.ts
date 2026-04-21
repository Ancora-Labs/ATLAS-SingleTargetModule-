/**
 * Negative-path tests for verification profiles and config gate enforcement.
 *
 * Tests assert only on return shape (passed boolean, gaps array content)
 * and never on internal function calls, ensuring no implementation coupling.
 *
 * Coverage map:
 *   AC1 — required fields missing causes failure across multiple roles
 *   AC2 — security role with missing/failed `security` evidence fails
 *   AC3 — fully-exempt and no-required-field roles pass with no report
 *   AC4 — applyConfigOverrides upgrades optional fields to required per config
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateWorkerContract, applyConfigOverrides } from "../../src/core/verification_gate.js";
import { getVerificationProfile } from "../../src/core/verification_profiles.js";

// ---------------------------------------------------------------------------
// AC1 — Roles with required fields fail when those fields are missing
// ---------------------------------------------------------------------------

describe("AC1 — required fields missing causes validation failure", () => {
  it("backend role fails when build is missing from report", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        // build is intentionally omitted
        "VERIFICATION_REPORT: TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/1"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /build/i.test(g)), `expected BUILD gap, got: ${result.gaps}`);
  });

  it("backend role fails when edgeCases is reported as n/a", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/1"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /edge.?cases/i.test(g)), `expected EDGE_CASES gap, got: ${result.gaps}`);
  });

  it("api role fails when api field is missing", () => {
    const result = validateWorkerContract("api", {
      status: "done",
      fullOutput: [
        // api field intentionally omitted
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/1"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /\bapi\b/i.test(g)), `expected API gap, got: ${result.gaps}`);
  });

  it("frontend role fails when prUrl is missing", () => {
    const result = validateWorkerContract("frontend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=pass; EDGE_CASES=pass",
        "RESPONSIVE_MATRIX: 320x568=pass, 360x640=pass, 375x667=pass, 390x844=pass, 412x915=pass"
        // BOX_PR_URL intentionally omitted
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /BOX_PR_URL/i.test(g)), `expected PR URL gap, got: ${result.gaps}`);
  });

  it("qa role fails when tests field is reported as fail", () => {
    const result = validateWorkerContract("qa", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/2"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /TESTS reported as FAIL/i.test(g)), `expected TESTS fail gap, got: ${result.gaps}`);
  });

  it("devops role fails when build is missing", () => {
    const result = validateWorkerContract("devops", {
      status: "done",
      fullOutput: [
        // no VERIFICATION_REPORT at all
        "BOX_PR_URL=https://github.com/org/repo/pull/3"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /VERIFICATION_REPORT missing/i.test(g)), `expected missing report gap, got: ${result.gaps}`);
  });

  it("test role fails when tests field is missing entirely", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        // EDGE_CASES present but tests missing
        "VERIFICATION_REPORT: EDGE_CASES=pass"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /TESTS/i.test(g)), `expected TESTS gap, got: ${result.gaps}`);
  });
});

// ---------------------------------------------------------------------------
// AC2 — Security role specifically fails when `security` evidence is absent
// ---------------------------------------------------------------------------

describe("AC2 — security role fails without security evidence", () => {
  it("fails when security field is absent from the report", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        // security field intentionally omitted
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/5"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /SECURITY/i.test(g)), `expected SECURITY gap, got: ${result.gaps}`);
  });

  it("fails when security field is reported as n/a", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/6"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /SECURITY/i.test(g)), `expected SECURITY gap, got: ${result.gaps}`);
  });

  it("fails when security field is reported as fail", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=fail",
        "BOX_PR_URL=https://github.com/org/repo/pull/7"
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /SECURITY reported as FAIL/i.test(g)), `expected SECURITY fail gap, got: ${result.gaps}`);
  });

  it("passes when all required security role fields including security=pass are present", () => {
    const result = validateWorkerContract("security", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/8",
        // Security is a done-capable lane — SHA + raw test output required
        "BOX_MERGED_SHA=abc1234",
        "CLEAN_TREE_STATUS=clean",
        "===NPM TEST OUTPUT START===",
        "# tests 5",
        "# pass 5",
        "# fail 0",
        "===NPM TEST OUTPUT END===",
      ].join("\n")
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// AC3 — Exempt roles pass with no verification report
// ---------------------------------------------------------------------------

describe("AC3 — exempt roles pass with no verification report", () => {
  it("scanA (all-exempt) passes with empty output", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: ""
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
    // reason should identify exemption path
    assert.match(result.reason, /exempt/i);
  });

  it("scanA passes with arbitrary prose output and no VERIFICATION_REPORT", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: "Scanned 150 files. Found 3 potential issues in documentation comments."
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("scanB (no required fields, build optional) passes with no report", () => {
    // scanB profile has build=optional and all others exempt — no required fields
    const result = validateWorkerContract("scanB", {
      status: "done",
      fullOutput: "Documentation audit complete."
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("scanB profile has no required evidence fields", () => {
    const profile = getVerificationProfile("scanB");
    const requiredFields = Object.entries(profile.evidence).filter(([, v]) => v === "required");
    assert.equal(requiredFields.length, 0, "scanB must have zero required evidence fields");
  });

  it("scanA profile has all-exempt evidence fields", () => {
    const profile = getVerificationProfile("scanA");
    const nonExempt = Object.entries(profile.evidence).filter(([, v]) => v !== "exempt");
    assert.equal(nonExempt.length, 0, "scanA must have all-exempt evidence fields");
  });
});

// ---------------------------------------------------------------------------
// AC4 — Config gate upgrades optional fields to required correctly
// ---------------------------------------------------------------------------

describe("AC4 — applyConfigOverrides upgrades optional fields per config", () => {
  it("upgrades tests from optional to required when requireTests is true", () => {
    // scanB has tests=exempt; use backend which has tests=required already
    // use devops which has tests=optional
    const profile = getVerificationProfile("devops");
    assert.equal(profile.evidence.tests, "optional", "baseline: devops tests must be optional");

    const upgraded = applyConfigOverrides(profile, { requireTests: true });
    assert.equal(upgraded.evidence.tests, "required");
  });

  it("upgrades build from optional to required when requireBuild is true", () => {
    // scanB has build=optional
    const profile = getVerificationProfile("scanB");
    assert.equal(profile.evidence.build, "optional", "baseline: scanB build must be optional");

    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.equal(upgraded.evidence.build, "required");
  });

  it("upgrades security from optional to required when requireSecurityScan is true", () => {
    // backend has security=optional
    const profile = getVerificationProfile("backend");
    assert.equal(profile.evidence.security, "optional", "baseline: backend security must be optional");

    const upgraded = applyConfigOverrides(profile, { requireSecurityScan: true });
    assert.equal(upgraded.evidence.security, "required");
  });

  it("does not upgrade when config flag is false", () => {
    const profile = getVerificationProfile("devops");
    const upgraded = applyConfigOverrides(profile, { requireTests: false });
    assert.equal(upgraded.evidence.tests, "optional", "false flag must not upgrade optional fields");
  });

  it("does not upgrade exempt fields even when config flag is true", () => {
    // devops has edgeCases=optional and api=exempt
    const profile = getVerificationProfile("devops");
    assert.equal(profile.evidence.api, "exempt", "baseline: devops api must be exempt");

    // requireBuild does not affect api; but also verify exempt is not upgraded by unrelated config
    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.equal(upgraded.evidence.api, "exempt", "exempt fields must never be upgraded");
  });

  it("does not downgrade already-required fields", () => {
    // backend has build=required
    const profile = getVerificationProfile("backend");
    assert.equal(profile.evidence.build, "required", "baseline: backend build must be required");

    const upgraded = applyConfigOverrides(profile, { requireBuild: true });
    assert.equal(upgraded.evidence.build, "required", "required fields must remain required");
  });

  it("returns original profile unchanged when gatesConfig is null/undefined", () => {
    const profile = getVerificationProfile("backend");
    assert.strictEqual(applyConfigOverrides(profile, null), profile);
    assert.strictEqual(applyConfigOverrides(profile, undefined), profile);
  });

  it("does not mutate the original profile", () => {
    const profile = getVerificationProfile("devops");
    const originalTests = profile.evidence.tests;

    applyConfigOverrides(profile, { requireTests: true });

    assert.equal(profile.evidence.tests, originalTests, "original profile must not be mutated");
  });

  it("end-to-end: scanB with requireBuild config gate fails when build evidence is missing", () => {
    // Baseline: scanB with no config passes (build is optional)
    const baselineResult = validateWorkerContract("scanB", {
      status: "done",
      fullOutput: "Documentation complete. No build needed."
    });
    assert.equal(baselineResult.passed, true, "scanB without config gate must pass");

    // With requireBuild gate active, missing build evidence must now fail
    const gatedResult = validateWorkerContract("scanB", {
      status: "done",
      fullOutput: "Documentation complete. No build needed."
    }, { gatesConfig: { requireBuild: true } });
    assert.equal(gatedResult.passed, false, "scanB with requireBuild gate must fail without build evidence");
    assert.ok(
      gatedResult.gaps.some(g => /build/i.test(g) || /VERIFICATION_REPORT/i.test(g)),
      `expected build-related gap, got: ${gatedResult.gaps}`
    );
  });

  it("end-to-end: backend with requireSecurityScan gate fails when security is optional-but-missing", () => {
    // Backend has security=optional. With requireSecurityScan gate, security becomes required.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        // security intentionally omitted (was optional, now required via gate)
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/9"
      ].join("\n")
    }, { gatesConfig: { requireSecurityScan: true } });

    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /SECURITY/i.test(g)), `expected SECURITY gap, got: ${result.gaps}`);
  });
});
