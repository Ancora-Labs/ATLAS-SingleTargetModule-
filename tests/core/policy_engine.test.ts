import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validateShellCommand,
  isProtectedPath,
  getProtectedPathMatches,
  validateRoleInstruction,
  getRolePathViolations,
  applyGovernanceDecision,
  loadHookPolicy,
  validateHookTelemetryConsistency,
  auditAuthoritativeHookCoverage,
  type HookPolicy,
} from "../../src/core/policy_engine.js";

describe("policy_engine", () => {
  it("blocks configured dangerous command patterns", () => {
    const policy = { blockedCommands: ["git reset --hard"] };
    const result = validateShellCommand(policy, "Please run git reset --hard and continue");
    assert.equal(result.ok, false);
    assert.ok(String(result.reason || "").includes("git reset --hard"));
  });

  it("allows safe shell text when no blocked command matches", () => {
    const policy = { blockedCommands: ["git reset --hard"] };
    const result = validateShellCommand(policy, "run npm test and report output");
    assert.equal(result.ok, true);
  });

  it("matches protected prefix glob patterns", () => {
    const policy = { protectedPaths: ["src/core/**"] };
    assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), true);
    assert.equal(isProtectedPath(policy, "src/dashboard/live_dashboard.ts"), false);
  });

  it("returns all protected files from touched set", () => {
    const policy = { protectedPaths: ["src/core/**", "infra/**"] };
    const touched = [
      "src/core/orchestrator.js",
      "src/dashboard/live_dashboard.ts",
      "infra/deploy.sh"
    ];
    const protectedOnly = getProtectedPathMatches(policy, touched);
    assert.deepEqual(protectedOnly.sort(), ["infra/deploy.sh", "src/core/orchestrator.js"]);
  });

  it("blocks instruction by role blockedTaskPatterns", () => {
    const policy = {
      rolePolicies: {
        "king-david": {
          blockedTaskPatterns: ["terraform apply", "kubectl delete"]
        }
      }
    };
    const decision = validateRoleInstruction(policy, "King David", "please run terraform apply in prod");
    assert.equal(decision.ok, false);
    assert.ok(String(decision.reason || "").includes("role policy blocked"));
  });

  it("enforces requiredTaskPatterns when configured", () => {
    const policy = {
      rolePolicies: {
        samuel: {
          requiredTaskPatterns: ["test", "coverage"]
        }
      }
    };
    const blocked = validateRoleInstruction(policy, "Samuel", "implement api endpoint changes");
    assert.equal(blocked.ok, false);

    const allowed = validateRoleInstruction(policy, "Samuel", "add test coverage for auth module");
    assert.equal(allowed.ok, true);
  });

  it("reports denied and outside-allowlist role path violations", () => {
    const policy = {
      rolePolicies: {
        esther: {
          allowedPaths: ["src/dashboard/**", "src/ui/**"],
          deniedPaths: ["src/core/**"]
        }
      }
    };
    const result = getRolePathViolations(policy, "Esther", [
      "src/dashboard/live_dashboard.ts",
      "src/core/orchestrator.js",
      "README.md"
    ]);

    assert.equal(result.hasViolation, true);
    assert.deepEqual(result.deniedMatches, ["src/core/orchestrator.js"]);
    assert.deepEqual(result.outsideAllowed.sort(), ["README.md", "src/core/orchestrator.js"]);
  });

  // ── /** prefix (directory-subtree) glob ─────────────────────────────────
  describe("path matching — /** prefix (directory subtree) patterns", () => {
    const policy = { protectedPaths: ["src/core/**"] };

    it("matches the exact prefix directory (no trailing slash)", () => {
      assert.equal(isProtectedPath(policy, "src/core"), true);
    });

    it("matches direct children of the prefix directory", () => {
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), true);
    });

    it("matches deeply nested files under the prefix directory", () => {
      assert.equal(isProtectedPath(policy, "src/core/utils/helpers/deep.js"), true);
    });

    it("does not match a sibling directory that shares the prefix chars", () => {
      // "src/coreExtra" must NOT match "src/core/**"
      assert.equal(isProtectedPath(policy, "src/coreExtra/file.js"), false);
      assert.equal(isProtectedPath(policy, "src/coredump/file.js"), false);
    });

    it("does not match files in an unrelated directory", () => {
      assert.equal(isProtectedPath(policy, "src/dashboard/live.js"), false);
      assert.equal(isProtectedPath(policy, "README.md"), false);
    });
  });

  // ── **/ prefix (filename-anywhere) glob ─────────────────────────────────
  describe("path matching — **/ prefix (filename anywhere) patterns", () => {
    it("matches a file with the given exact name in any directory", () => {
      const policy = { protectedPaths: ["**/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), true);
      assert.equal(isProtectedPath(policy, "lib/orchestrator.js"), true);
    });

    it("matches a root-level file with no directory prefix", () => {
      const policy = { protectedPaths: ["**/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, "orchestrator.js"), true);
    });

    it("does not match a file whose name merely contains the pattern name as a substring", () => {
      // "bad_orchestrator.js" must NOT match "**/orchestrator.js"
      const policy = { protectedPaths: ["**/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, "src/core/bad_orchestrator.js"), false);
      assert.equal(isProtectedPath(policy, "my_orchestrator.js"), false);
    });

    it("matches files by extension pattern (**/*.test.ts)", () => {
      const policy = { protectedPaths: ["**/*.test.ts"] };
      assert.equal(isProtectedPath(policy, "tests/core/policy_engine.test.ts"), true);
      assert.equal(isProtectedPath(policy, "policy_engine.test.ts"), true);
    });

    it("does not match non-test-ts files against **/*.test.ts", () => {
      const policy = { protectedPaths: ["**/*.test.ts"] };
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), false);
      assert.equal(isProtectedPath(policy, "tests/core/policy_engine.spec.ts"), false);
    });

    it("matches deeply nested file by extension pattern", () => {
      const policy = { protectedPaths: ["**/*.test.ts"] };
      assert.equal(isProtectedPath(policy, "a/b/c/d/file.test.ts"), true);
    });
  });

  // ── nested folder matching ───────────────────────────────────────────────
  describe("path matching — nested folder normalization", () => {
    it("matches files multiple levels deep inside a protected tree", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      assert.equal(isProtectedPath(policy, "src/core/utils/helpers/math.js"), true);
      assert.equal(isProtectedPath(policy, "src/core/a/b/c/d/e/file.js"), true);
    });

    it("does not match partial directory name segments", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      // "src/core2" or "src/corelib" must not be treated as inside src/core
      assert.equal(isProtectedPath(policy, "src/core2/file.js"), false);
      assert.equal(isProtectedPath(policy, "src/corelib/util.js"), false);
    });

    it("handles multiple protected patterns simultaneously", () => {
      const policy = { protectedPaths: ["src/core/**", "infra/**", "**/*.env"] };
      assert.equal(isProtectedPath(policy, "src/core/gates.js"), true);
      assert.equal(isProtectedPath(policy, "infra/k8s/deploy.yaml"), true);
      assert.equal(isProtectedPath(policy, "config/prod.env"), true);
      assert.equal(isProtectedPath(policy, "src/dashboard/ui.js"), false);
    });
  });

  // ── Windows path normalization ───────────────────────────────────────────
  // Backslash-separated paths (as produced on Windows) must be normalized to
  // forward slashes before matching so that patterns are platform-consistent.
  describe("path matching — Windows path normalization", () => {
    it("normalizes backslash separators before matching a /** pattern", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      assert.equal(isProtectedPath(policy, "src\\core\\orchestrator.js"), true);
      assert.equal(isProtectedPath(policy, "src\\core\\utils\\helpers\\file.js"), true);
    });

    it("normalizes backslash separators before matching a **/ pattern", () => {
      const policy = { protectedPaths: ["**/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, "src\\core\\orchestrator.js"), true);
    });

    it("normalizes backslash separators in patterns as well as paths", () => {
      // A pattern written with backslashes must still work
      const policy = { protectedPaths: ["src\\core\\**"] };
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), true);
      assert.equal(isProtectedPath(policy, "src\\core\\orchestrator.js"), true);
    });

    it("does not produce false positives for Windows paths of unrelated files", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      assert.equal(isProtectedPath(policy, "src\\dashboard\\live.js"), false);
      assert.equal(isProtectedPath(policy, "src\\coreExtra\\file.js"), false);
    });

    it("getProtectedPathMatches works with Windows-style paths", () => {
      const policy = { protectedPaths: ["src/core/**", "infra/**"] };
      const touched = [
        "src\\core\\orchestrator.js",
        "src\\dashboard\\live.js",
        "infra\\deploy.sh"
      ];
      const result = getProtectedPathMatches(policy, touched);
      assert.deepEqual(result.sort(), ["infra\\deploy.sh", "src\\core\\orchestrator.js"]);
    });
  });

  // ── role path violations: deniedPaths and allowedPaths precedence ────────
  //
  // Precedence rules (documented here as the authoritative specification):
  //   1. deniedPaths and allowedPaths are evaluated independently.
  //   2. A file matching any deniedPaths pattern is always a violation
  //      (appears in deniedMatches), regardless of allowedPaths.
  //   3. When allowedPaths is non-empty, any file NOT matched by allowedPaths
  //      is also a violation (appears in outsideAllowed).
  //   4. A file can appear in BOTH deniedMatches and outsideAllowed simultaneously.
  //   5. hasViolation is true if either array is non-empty.
  describe("role path violations — deniedPaths and allowedPaths precedence", () => {
    it("deniedPaths marks a file as a violation even when it also appears in allowedPaths", () => {
      const policy = {
        rolePolicies: {
          worker: {
            allowedPaths: ["src/**"],
            deniedPaths: ["src/core/**"] // more-specific deny within allowed tree
          }
        }
      };
      const result = getRolePathViolations(policy, "worker", ["src/core/gates.js"]);
      assert.equal(result.hasViolation, true);
      assert.deepEqual(result.deniedMatches, ["src/core/gates.js"]);
    });

    it("file outside allowedPaths is a violation when allowedPaths is configured", () => {
      const policy = {
        rolePolicies: {
          frontend: { allowedPaths: ["src/ui/**"] }
        }
      };
      const result = getRolePathViolations(policy, "frontend", ["src/core/orchestrator.js"]);
      assert.equal(result.hasViolation, true);
      assert.deepEqual(result.outsideAllowed, ["src/core/orchestrator.js"]);
      assert.deepEqual(result.deniedMatches, []);
    });

    it("file matching deniedPaths also appears in outsideAllowed when allowedPaths is configured", () => {
      // This is the intended dual-violation: denied AND outside allowlist
      const policy = {
        rolePolicies: {
          esther: {
            allowedPaths: ["src/dashboard/**"],
            deniedPaths: ["src/core/**"]
          }
        }
      };
      const result = getRolePathViolations(policy, "esther", ["src/core/orchestrator.js"]);
      assert.equal(result.hasViolation, true);
      assert.deepEqual(result.deniedMatches, ["src/core/orchestrator.js"]);
      assert.deepEqual(result.outsideAllowed, ["src/core/orchestrator.js"]);
    });

    it("no violation when all files are within allowedPaths and none match deniedPaths", () => {
      const policy = {
        rolePolicies: {
          frontend: {
            allowedPaths: ["src/ui/**"],
            deniedPaths: ["src/core/**"]
          }
        }
      };
      const result = getRolePathViolations(policy, "frontend", ["src/ui/button.js"]);
      assert.equal(result.hasViolation, false);
      assert.deepEqual(result.deniedMatches, []);
      assert.deepEqual(result.outsideAllowed, []);
    });

    it("deniedPaths-only: file matching a denied pattern is a violation", () => {
      const policy = {
        rolePolicies: {
          reviewer: { deniedPaths: ["infra/**"] }
        }
      };
      const result = getRolePathViolations(policy, "reviewer", ["infra/deploy.sh"]);
      assert.equal(result.hasViolation, true);
      assert.deepEqual(result.deniedMatches, ["infra/deploy.sh"]);
      // outsideAllowed is empty — no allowedPaths configured
      assert.deepEqual(result.outsideAllowed, []);
    });

    it("deniedPaths-only: file not matching any denied pattern is not a violation", () => {
      const policy = {
        rolePolicies: {
          reviewer: { deniedPaths: ["infra/**"] }
        }
      };
      const result = getRolePathViolations(policy, "reviewer", ["src/core/orchestrator.js"]);
      assert.equal(result.hasViolation, false);
    });

    it("allowedPaths-only: file within allowedPaths is not a violation", () => {
      const policy = {
        rolePolicies: {
          writer: { allowedPaths: ["src/providers/**"] }
        }
      };
      const result = getRolePathViolations(policy, "writer", ["src/providers/openai/client.js"]);
      assert.equal(result.hasViolation, false);
    });

    it("Windows-style paths are normalized correctly in role path violations", () => {
      const policy = {
        rolePolicies: {
          esther: {
            allowedPaths: ["src/dashboard/**"],
            deniedPaths: ["src/core/**"]
          }
        }
      };
      const result = getRolePathViolations(policy, "esther", [
        "src\\dashboard\\live.js",
        "src\\core\\orchestrator.js"
      ]);
      assert.equal(result.hasViolation, true);
      assert.deepEqual(result.deniedMatches, ["src\\core\\orchestrator.js"]);
      assert.equal(result.outsideAllowed.includes("src\\core\\orchestrator.js"), true);
    });
  });

  // ── no false positives for unrelated files ───────────────────────────────
  describe("no false positives for unrelated files", () => {
    it("unrelated files do not match protected path patterns", () => {
      const policy = { protectedPaths: ["src/core/**", "infra/**"] };
      assert.equal(isProtectedPath(policy, "README.md"), false);
      assert.equal(isProtectedPath(policy, "package.json"), false);
      assert.equal(isProtectedPath(policy, "src/dashboard/live.js"), false);
      assert.equal(isProtectedPath(policy, "tests/core/policy_engine.test.ts"), false);
    });

    it("partial directory name does not trigger protection", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      assert.equal(isProtectedPath(policy, "src/core-backup/file.js"), false);
      assert.equal(isProtectedPath(policy, "src/cores/file.js"), false);
    });

    it("empty or blank paths do not match any pattern", () => {
      const policy = { protectedPaths: ["src/core/**", "**/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, ""), false);
      assert.equal(isProtectedPath(policy, "   "), false);
      assert.equal(isProtectedPath(policy, null), false);
    });

    it("exact match required when no wildcard is used in pattern", () => {
      const policy = { protectedPaths: ["src/core/orchestrator.js"] };
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js"), true);
      assert.equal(isProtectedPath(policy, "src/core/orchestrator.js.bak"), false);
      assert.equal(isProtectedPath(policy, "src/core/other.js"), false);
    });

    it("getProtectedPathMatches returns empty array when no file matches", () => {
      const policy = { protectedPaths: ["src/core/**"] };
      const result = getProtectedPathMatches(policy, ["README.md", "package.json"]);
      assert.deepEqual(result, []);
    });
  });
});

// ── Composed governance decision path (guardrail > freeze > canary precedence) ─

describe("applyGovernanceDecision — guardrail > freeze > canary precedence", () => {
  it("should apply guardrail>freeze>canary precedence deterministically", () => {
    // guardrail wins when all three are active
    const r1 = applyGovernanceDecision({
      guardrailActive: true, freezeActive: true, canaryBreachActive: true
    });
    assert.equal(r1.blocked, true);
    assert.ok(r1.reason.includes("guardrail"), `expected guardrail in reason, got: ${r1.reason}`);
    assert.equal(r1.precedenceLevel, 1);

    // freeze wins when guardrail is off but freeze + canary are on
    const r2 = applyGovernanceDecision({
      guardrailActive: false, freezeActive: true, canaryBreachActive: true
    });
    assert.equal(r2.blocked, true);
    assert.ok(r2.reason.includes("freeze"), `expected freeze in reason, got: ${r2.reason}`);
    assert.equal(r2.precedenceLevel, 2);

    // canary wins when only canary is active
    const r3 = applyGovernanceDecision({
      guardrailActive: false, freezeActive: false, canaryBreachActive: true
    });
    assert.equal(r3.blocked, true);
    assert.ok(r3.reason.includes("canary"), `expected canary in reason, got: ${r3.reason}`);
    assert.equal(r3.precedenceLevel, 3);

    // nothing active → not blocked
    const r4 = applyGovernanceDecision({
      guardrailActive: false, freezeActive: false, canaryBreachActive: false
    });
    assert.equal(r4.blocked, false);
    assert.equal(r4.precedenceLevel, 0);
  });

  it("returns blocked=false with precedenceLevel=0 when called with no arguments", () => {
    const result = applyGovernanceDecision();
    assert.equal(result.blocked, false);
    assert.equal(result.precedenceLevel, 0);
  });

  it("guardrail alone blocks regardless of freeze and canary state", () => {
    const r = applyGovernanceDecision({ guardrailActive: true });
    assert.equal(r.blocked, true);
    assert.equal(r.precedenceLevel, 1);
  });

  it("freeze alone blocks when guardrail is off", () => {
    const r = applyGovernanceDecision({ freezeActive: true });
    assert.equal(r.blocked, true);
    assert.equal(r.precedenceLevel, 2);
  });
});

// ── Hook policy: loadHookPolicy and validateHookTelemetryConsistency ─────────

const STUB_HOOK_POLICY: HookPolicy = {
  schemaVersion: "1.0.0",
  preToolUse: {
    required: true,
    mandatoryFields: ["scope", "intent", "impact", "clearance"],
    validImpactValues: ["low", "medium", "high", "critical"],
    validClearanceValues: ["read", "write", "admin"],
    impactMinClearance: { low: "read", medium: "write", high: "admin", critical: "admin" },
  },
  hookDecision: {
    required: true,
    validDecisions: ["allow", "deny"],
    mandatoryFields: ["tool", "decision", "reason_code", "rule_id", "envelope_scope", "envelope_intent", "envelope_impact", "envelope_clearance"],
  },
  enforcement: {
    requirePairedEnvelopeDecision: true,
    denyOnMissingEnvelope: true,
    denyOnMalformedEnvelope: true,
    denyOnDeniedDecision: true,
    requireEnvelopeBeforeDecision: true,
  },
};

describe("loadHookPolicy", () => {
  it("returns null for a non-existent policy path (fail-open)", async () => {
    const result = await loadHookPolicy("/nonexistent-path-that-cannot-exist-12345");
    assert.equal(result, null);
  });
});

describe("validateHookTelemetryConsistency", () => {
  it("returns consistent=true when envelopes and decisions are empty", () => {
    const result = validateHookTelemetryConsistency(
      { envelopes: [], hookDecisions: [], gaps: [] },
      STUB_HOOK_POLICY,
    );
    assert.equal(result.consistent, true);
    assert.equal(result.gaps.length, 0);
  });

  it("returns consistent=true for perfectly paired and matching envelope/decision", () => {
    const result = validateHookTelemetryConsistency(
      {
        envelopes: [{ scope: "src/core", intent: "update-gate", impact: "medium", clearance: "write" }],
        hookDecisions: [{ envelopeScope: "src/core", envelopeIntent: "update-gate", envelopeImpact: "medium", envelopeClearance: "write" }],
        gaps: [],
      },
      STUB_HOOK_POLICY,
    );
    assert.equal(result.consistent, true);
    assert.equal(result.gaps.length, 0);
  });

  it("produces HOOK_TELEMETRY_UNPAIRED gap when envelope count exceeds decision count", () => {
    const result = validateHookTelemetryConsistency(
      {
        envelopes: [
          { scope: "src/core", intent: "op-a", impact: "low", clearance: "read" },
          { scope: "src/core", intent: "op-b", impact: "medium", clearance: "write" },
        ],
        hookDecisions: [
          { envelopeScope: "src/core", envelopeIntent: "op-a", envelopeImpact: "low", envelopeClearance: "read" },
        ],
        gaps: [],
      },
      STUB_HOOK_POLICY,
    );
    assert.equal(result.consistent, false);
    assert.ok(result.gaps.some((g) => g.startsWith("HOOK_TELEMETRY_UNPAIRED")));
  });

  it("produces HOOK_TELEMETRY_UNPAIRED gap when decision count exceeds envelope count", () => {
    const result = validateHookTelemetryConsistency(
      {
        envelopes: [],
        hookDecisions: [{ envelopeScope: "src/core", envelopeIntent: "op-a", envelopeImpact: "low", envelopeClearance: "read" }],
        gaps: [],
      },
      STUB_HOOK_POLICY,
    );
    assert.equal(result.consistent, false);
    assert.ok(result.gaps.some((g) => g.startsWith("HOOK_TELEMETRY_UNPAIRED")));
  });

  it("produces HOOK_TELEMETRY_MISMATCH gap when envelope_scope does not match TOOL_INTENT scope", () => {
    const result = validateHookTelemetryConsistency(
      {
        envelopes: [{ scope: "src/core", intent: "update-gate", impact: "medium", clearance: "write" }],
        hookDecisions: [{ envelopeScope: "src/OTHER", envelopeIntent: "update-gate", envelopeImpact: "medium", envelopeClearance: "write" }],
        gaps: [],
      },
      STUB_HOOK_POLICY,
    );
    assert.equal(result.consistent, false);
    assert.ok(result.gaps.some((g) => g.startsWith("HOOK_TELEMETRY_MISMATCH")));
    assert.ok(result.gaps.some((g) => g.includes("envelope_scope")));
  });

  it("returns consistent=true when requirePairedEnvelopeDecision is false regardless of pairing state", () => {
    const relaxedPolicy = {
      ...STUB_HOOK_POLICY,
      enforcement: { ...STUB_HOOK_POLICY.enforcement, requirePairedEnvelopeDecision: false },
    };
    const result = validateHookTelemetryConsistency(
      {
        envelopes: [{ scope: "src/core", intent: "op", impact: "high", clearance: "admin" }],
        hookDecisions: [],
        gaps: [],
      },
      relaxedPolicy,
    );
    assert.equal(result.consistent, true);
    assert.equal(result.gaps.length, 0);
  });
});

describe("auditAuthoritativeHookCoverage", () => {
  it("passes when execute-capable sessions have deterministic runtime-backed coverage", () => {
    const result = auditAuthoritativeHookCoverage({
      sessionInputPolicy: "allow_all",
      hookCoverage: "required",
      telemetry: {
        envelopes: [{ scope: "src/core", intent: "patch-gate", impact: "high", clearance: "admin" }],
        hookDecisions: [{ envelopeScope: "src/core", envelopeIntent: "patch-gate", envelopeImpact: "high", envelopeClearance: "admin" }],
        gaps: [],
        hasDeterministicCoverage: true,
      },
      runtimeDecisions: [{ envelope: { scope: "src/core" }, decision: { decision: "allow" } }],
      runtimeAuditGaps: [],
    });

    assert.equal(result.required, true);
    assert.equal(result.covered, true);
    assert.equal(result.reasonCode, null);
  });

  it("fails closed when required hook coverage is missing runtime decisions", () => {
    const result = auditAuthoritativeHookCoverage({
      sessionInputPolicy: "allow_all",
      hookCoverage: "required",
      telemetry: {
        envelopes: [],
        hookDecisions: [],
        gaps: [],
        hasDeterministicCoverage: false,
      },
      runtimeDecisions: [],
      runtimeAuditGaps: [],
    });

    assert.equal(result.required, true);
    assert.equal(result.covered, false);
    assert.ok(result.gaps.includes("HOOK_COVERAGE_MISSING_RUNTIME_DECISIONS"));
  });

  it("does not require hook coverage for no-tools sessions", () => {
    const result = auditAuthoritativeHookCoverage({
      sessionInputPolicy: "no_tools",
      hookCoverage: "not_required",
      telemetry: null,
      runtimeDecisions: [],
      runtimeAuditGaps: [],
    });

    assert.equal(result.required, false);
    assert.equal(result.covered, true);
  });
});
