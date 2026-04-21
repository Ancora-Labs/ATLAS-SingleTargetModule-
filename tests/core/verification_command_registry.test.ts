import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getVerificationCommands, getTestCommand, VERIFICATION_DEFAULTS, checkForbiddenCommands, FORBIDDEN_VERIFICATION_PATTERNS, rewriteVerificationCommand, VERIFICATION_CMD_REWRITE_RULES, normalizeCommandBatch, validateDispatchCommands, NON_SPECIFIC_VERIFICATION_PATTERNS, isNonSpecificVerificationCommand } from "../../src/core/verification_command_registry.js";
import { applyDispatchCommandGate } from "../../src/core/verification_gate.js";

describe("verification_command_registry", () => {
  describe("getVerificationCommands", () => {
    it("returns defaults with no config", () => {
      const cmds = getVerificationCommands();
      assert.equal(cmds.test, "npm test");
      assert.equal(cmds.lint, "npm run lint");
      assert.equal(cmds.build, "npm run build");
    });

    it("returns defaults when config has no overrides", () => {
      const cmds = getVerificationCommands({});
      assert.equal(cmds.test, VERIFICATION_DEFAULTS.test);
    });

    it("allows overriding individual commands", () => {
      const cmds = getVerificationCommands({ verificationCommands: { test: "npx vitest" } });
      assert.equal(cmds.test, "npx vitest");
      assert.equal(cmds.lint, "npm run lint"); // not overridden
    });

    it("no wildcard globs in defaults (Windows-safe)", () => {
      const cmds = getVerificationCommands();
      for (const cmd of Object.values(cmds)) {
        assert.ok(!cmd.includes("*"), `Command contains wildcard glob: ${cmd}`);
        assert.ok(!cmd.includes("?"), `Command contains "?" glob: ${cmd}`);
      }
    });
  });

  describe("getTestCommand", () => {
    it("returns test command", () => {
      assert.equal(getTestCommand(), "npm test");
    });

    it("returns override when specified", () => {
      assert.equal(getTestCommand({ verificationCommands: { test: "yarn test" } }), "yarn test");
    });
  });

  describe("checkForbiddenCommands (Packet 4)", () => {
    it("detects glob wildcard in command", () => {
      const result = checkForbiddenCommands("node --test tests/**/*.test.ts");
      assert.equal(result.forbidden, true);
      assert.ok(result.violations.length > 0);
    });

    it("accepts npm test", () => {
      const result = checkForbiddenCommands("npm test");
      assert.equal(result.forbidden, false);
      assert.equal(result.violations.length, 0);
    });

    it("returns not forbidden for empty string", () => {
      const result = checkForbiddenCommands("");
      assert.equal(result.forbidden, false);
    });

    it("FORBIDDEN_VERIFICATION_PATTERNS is non-empty", () => {
      assert.ok(FORBIDDEN_VERIFICATION_PATTERNS.length > 0);
      for (const p of FORBIDDEN_VERIFICATION_PATTERNS) {
        assert.ok(p.pattern);
        assert.ok(p.reason);
      }
    });

    it("detects bash script invocation as forbidden", () => {
      const result = checkForbiddenCommands("bash scripts/run_tests.sh");
      assert.equal(result.forbidden, true);
      assert.ok(result.violations.length > 0);
    });

    it("detects sh script invocation as forbidden", () => {
      const result = checkForbiddenCommands("sh run.sh");
      assert.equal(result.forbidden, true);
    });
  });

  describe("rewriteVerificationCommand", () => {
    it("rewrites shell-glob node --test to npm test", () => {
      assert.equal(rewriteVerificationCommand("node --test tests/**/*.test.js"), "npm test");
      assert.equal(rewriteVerificationCommand("node --test tests/**/*.test.ts"), "npm test");
    });

    it("rewrites bash script invocations to npm test", () => {
      assert.equal(rewriteVerificationCommand("bash scripts/run_tests.sh"), "npm test");
    });

    it("rewrites sh script invocations to npm test", () => {
      assert.equal(rewriteVerificationCommand("sh run.sh"), "npm test");
    });

    it("rewrites BOX daemon commands to npm test", () => {
      assert.equal(rewriteVerificationCommand("node src/cli.js once"), "npm test");
      assert.equal(rewriteVerificationCommand("npm run box:once"), "npm test");
      assert.equal(rewriteVerificationCommand("node src/cli.js start"), "npm test");
      assert.equal(rewriteVerificationCommand("node src/cli.js doctor"), "npm test");
    });

  it("rewrites dashboard daemon to node --test", () => {
      assert.equal(rewriteVerificationCommand("node src/dashboard/live_dashboard.js"), "npm test");
  });

    it("passes through canonical npm test unchanged", () => {
      assert.equal(rewriteVerificationCommand("npm test"), "npm test");
      assert.equal(rewriteVerificationCommand("npm run lint"), "npm run lint");
      assert.equal(rewriteVerificationCommand("npm run build"), "npm run build");
    });

    it("passes through node --test without glob unchanged", () => {
      assert.equal(rewriteVerificationCommand("node --test"), "node --test");
      assert.equal(rewriteVerificationCommand("node --test tests/core/foo.test.ts"), "node --test tests/core/foo.test.ts");
    });

    it("returns npm test for empty/null-like input (negative path)", () => {
      // Empty string has no matching rule — passes through as empty then trimmed
      assert.equal(rewriteVerificationCommand(""), "");
    });

    it("VERIFICATION_CMD_REWRITE_RULES is non-empty array of match/replacement objects", () => {
      assert.ok(VERIFICATION_CMD_REWRITE_RULES.length > 0);
      for (const rule of VERIFICATION_CMD_REWRITE_RULES) {
        assert.ok(rule.match instanceof RegExp, "rule.match must be a RegExp");
        assert.equal(typeof rule.replacement, "string", "rule.replacement must be a string");
        assert.ok(rule.replacement.length > 0, "rule.replacement must be non-empty");
      }
    });

    it("every FORBIDDEN_VERIFICATION_PATTERNS entry has a corresponding rewrite rule", () => {
      // All forbidden patterns should be rewritable — not just detected but fixed
      const testCases = [
        "node --test tests/**/*.test.ts",
        "bash scripts/test.sh",
        "sh run.sh",
      ];
      for (const cmd of testCases) {
        const rewritten = rewriteVerificationCommand(cmd);
        assert.notEqual(rewritten, cmd, `"${cmd}" should be rewritten to a canonical form`);
      }
    });
  });
});

// ── Task 2 hardening: normalizeCommandBatch — batch portable normalization ────

describe("normalizeCommandBatch — end-to-end batch normalization", () => {
  it("rewrites each command in the batch using rewrite rules", () => {
    const raw = ["node --test tests/**/*.test.ts", "npm test", "npm run lint"];
    const result = normalizeCommandBatch(raw);
    // The glob-based command must be rewritten to npm test
    // Deduplication means "npm test" appears only once
    assert.ok(result.includes("npm test"));
    assert.ok(result.includes("npm run lint"));
    assert.ok(!result.some(cmd => cmd.includes("*")), "no glob patterns should remain after normalization");
  });

  it("deduplicates commands that rewrite to the same canonical form", () => {
    const raw = ["node --test tests/**/*.ts", "bash run.sh", "npm test"];
    const result = normalizeCommandBatch(raw);
    // All three rewrite to "npm test" — only one should remain
    const npmTestCount = result.filter(c => c === "npm test").length;
    assert.equal(npmTestCount, 1, "deduplication must collapse identical rewrites");
  });

  it("filters out empty strings after normalization", () => {
    const raw = ["", "  ", "npm test"];
    const result = normalizeCommandBatch(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0], "npm test");
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeCommandBatch(null as any), []);
    assert.deepEqual(normalizeCommandBatch(undefined as any), []);
    assert.deepEqual(normalizeCommandBatch("npm test" as any), []);
  });

  it("returns empty array for empty input array", () => {
    assert.deepEqual(normalizeCommandBatch([]), []);
  });

  it("preserves canonical commands unchanged", () => {
    const canonical = ["npm test", "npm run lint", "npm run build"];
    const result = normalizeCommandBatch(canonical);
    assert.deepEqual(result, canonical);
  });

  it("negative path: glob-based command does NOT survive normalization", () => {
    const result = normalizeCommandBatch(["node --test tests/**"]);
    assert.ok(!result.some(cmd => cmd.includes("*")),
      `glob must not survive normalization; got: [${result.join(", ")}]`
    );
  });
});

describe("isNonSpecificVerificationCommand — exact-proof hardening", () => {
  it("flags bare npm test as non-specific verification", () => {
    assert.equal(isNonSpecificVerificationCommand("npm test"), true);
    assert.equal(isNonSpecificVerificationCommand("npm run build"), true);
  });

  it("flags bare node --test runner invocations as non-specific", () => {
    assert.equal(isNonSpecificVerificationCommand("node --test"), true);
  });

  it("does not flag a concrete test file target", () => {
    assert.equal(
      isNonSpecificVerificationCommand("tests/core/verification_gate.test.ts — test: rejects generic verification"),
      false,
    );
    assert.equal(
      isNonSpecificVerificationCommand("npm test -- tests/core/verification_gate.test.ts"),
      false,
    );
  });

  it("negative path: placeholder-empty input is not treated as non-specific evidence", () => {
    assert.equal(isNonSpecificVerificationCommand(""), false);
  });

  it("exports a non-empty pattern registry for non-specific verification commands", () => {
    assert.ok(NON_SPECIFIC_VERIFICATION_PATTERNS.length > 0);
  });
});

// ── Task 2 hardening: Windows-safe conformance — npx tsx and ts-node glob patterns ──

describe("Windows-safe conformance — AI-generated glob patterns (Task 2)", () => {
  it("detects npx tsx with glob as forbidden", () => {
    const result = checkForbiddenCommands("npx tsx tests/**/*.test.ts");
    assert.equal(result.forbidden, true,
      "npx tsx with glob must be detected as forbidden (not Windows-safe)"
    );
    assert.ok(result.violations.length > 0, "must report at least one violation");
    assert.ok(
      result.violations.some(v => v.reason.includes("Windows")),
      "violation reason must mention Windows"
    );
  });

  it("detects ts-node with glob as forbidden", () => {
    const result = checkForbiddenCommands("ts-node tests/**/*.spec.ts");
    assert.equal(result.forbidden, true,
      "ts-node with glob must be detected as forbidden (not Windows-safe)"
    );
    assert.ok(result.violations.length > 0);
  });

  it("rewrites npx tsx glob to npm test", () => {
    assert.equal(rewriteVerificationCommand("npx tsx tests/**/*.test.ts"), "npm test");
    assert.equal(rewriteVerificationCommand("npx tsx src/**/*.spec.ts"), "npm test");
  });

  it("rewrites ts-node glob to npm test", () => {
    assert.equal(rewriteVerificationCommand("ts-node tests/**/*.test.ts"), "npm test");
  });

  it("passes npx tsx without glob through unchanged (registry-conformant)", () => {
    assert.equal(rewriteVerificationCommand("npx tsx"), "npx tsx");
    assert.equal(rewriteVerificationCommand("npx tsx tests/core/foo.test.ts"), "npx tsx tests/core/foo.test.ts");
  });

  it("every new FORBIDDEN_VERIFICATION_PATTERNS entry has a corresponding rewrite rule (registry completeness)", () => {
    // Each forbidden pattern must be rewritable — not just detected but fixed.
    // This test locks the registry contract: detection ↔ rewrite parity.
    const testCases = [
      "node --test tests/**/*.test.ts",
      "bash scripts/test.sh",
      "sh run.sh",
      "npx tsx tests/**/*.test.ts",
      "ts-node tests/**/*.spec.ts",
    ];
    for (const cmd of testCases) {
      const forbidden = checkForbiddenCommands(cmd);
      assert.ok(forbidden.forbidden, `"${cmd}" must be detected as forbidden`);
      const rewritten = rewriteVerificationCommand(cmd);
      assert.notEqual(rewritten, cmd, `"${cmd}" must be rewritten to a canonical form`);
      assert.ok(rewritten.length > 0, `rewrite of "${cmd}" must not be empty`);
    }
  });

  it("negative path: canonical commands are not forbidden (no false positives)", () => {
    const canonical = ["npm test", "npm run lint", "npm run build", "node --test"];
    for (const cmd of canonical) {
      const result = checkForbiddenCommands(cmd);
      assert.equal(result.forbidden, false,
        `canonical command "${cmd}" must not be flagged as forbidden`
      );
    }
  });

  it("normalizeCommandBatch eliminates all AI-generated glob patterns in a mixed batch", () => {
    const aiGeneratedBatch = [
      "npx tsx tests/**/*.test.ts",
      "ts-node src/**/*.spec.ts",
      "node --test tests/**",
      "npm test",
      "npm run lint",
    ];
    const result = normalizeCommandBatch(aiGeneratedBatch);
    assert.ok(!result.some(cmd => cmd.includes("*")),
      `no glob patterns must survive after normalizeCommandBatch; got: [${result.join(", ")}]`
    );
    assert.ok(result.includes("npm test"), "npm test must be in the result");
    assert.ok(result.includes("npm run lint"), "npm run lint must be in the result");
    // npx tsx glob, ts-node glob, node --test glob all rewrite to npm test — deduplicated to 1
    const npmTestCount = result.filter(c => c === "npm test").length;
    assert.equal(npmTestCount, 1, "all glob rewrites collapse to a single 'npm test' after deduplication");
  });
});

// ── Task 3: validateDispatchCommands — dispatch-time gate ─────────────────────

describe("validateDispatchCommands — dispatch-time gate (Task 3)", () => {
  it("safe=true when all commands are already canonical", () => {
    const result = validateDispatchCommands(["npm test", "npm run lint", "npm run build"]);
    assert.equal(result.safe, true);
    assert.deepEqual(result.rewrites, []);
    assert.deepEqual(result.sanitizedCommands, ["npm test", "npm run lint", "npm run build"]);
  });

  it("safe=false and rewrites populated when a non-portable command is present", () => {
    const result = validateDispatchCommands(["node --test tests/**/*.test.ts", "npm run lint"]);
    assert.equal(result.safe, false);
    assert.ok(result.rewrites.length > 0);
    assert.ok(result.rewrites[0].original === "node --test tests/**/*.test.ts");
    assert.equal(result.rewrites[0].rewritten, "npm test");
    assert.ok(result.rewrites[0].reason.length > 0);
  });

  it("sanitizedCommands contains only the rewritten (canonical) commands", () => {
    const result = validateDispatchCommands(["bash run.sh", "npm run lint"]);
    assert.ok(!result.sanitizedCommands.some(cmd => cmd.startsWith("bash")));
    assert.ok(result.sanitizedCommands.includes("npm test"));
    assert.ok(result.sanitizedCommands.includes("npm run lint"));
  });

  it("deduplicates commands that rewrite to the same canonical form", () => {
    const result = validateDispatchCommands([
      "node --test tests/**/*.test.ts",
      "bash scripts/test.sh",
      "npm test",
    ]);
    // All three collapse to "npm test" — only one should appear
    const count = result.sanitizedCommands.filter(c => c === "npm test").length;
    assert.equal(count, 1, "deduplication must collapse identical rewrites to one entry");
  });

  it("returns safe=true and empty arrays for empty input", () => {
    const result = validateDispatchCommands([]);
    assert.equal(result.safe, true);
    assert.deepEqual(result.sanitizedCommands, []);
    assert.deepEqual(result.rewrites, []);
  });

  it("returns safe=true and empty sanitizedCommands for non-array input", () => {
    const result = validateDispatchCommands(null as any);
    assert.equal(result.safe, true);
    assert.deepEqual(result.sanitizedCommands, []);
    assert.deepEqual(result.rewrites, []);
  });

  it("filters out empty strings from the command list", () => {
    const result = validateDispatchCommands(["", "  ", "npm test"]);
    assert.equal(result.sanitizedCommands.length, 1);
    assert.equal(result.sanitizedCommands[0], "npm test");
  });

  it("each rewrite entry has original, rewritten, and reason fields", () => {
    const result = validateDispatchCommands(["sh run.sh"]);
    assert.ok(result.rewrites.length > 0);
    const r = result.rewrites[0];
    assert.ok(typeof r.original === "string" && r.original.length > 0);
    assert.ok(typeof r.rewritten === "string" && r.rewritten.length > 0);
    assert.ok(typeof r.reason === "string" && r.reason.length > 0);
  });

  it("negative path: BOX daemon command is rewritten and gate reports unsafe", () => {
    const result = validateDispatchCommands(["npm run box:once"]);
    assert.equal(result.safe, false);
    assert.equal(result.rewrites[0].original, "npm run box:once");
    assert.equal(result.rewrites[0].rewritten, "npm test");
  });

  it("negative path: canonical npm commands are not flagged as unsafe (no false positives)", () => {
    for (const cmd of ["npm test", "npm run lint", "npm run build"]) {
      const result = validateDispatchCommands([cmd]);
      assert.equal(result.safe, true, `"${cmd}" should not be rewritten`);
      assert.deepEqual(result.rewrites, []);
    }
  });
});

// ── applyDispatchCommandGate — verification_gate integration ──────────────────

describe("applyDispatchCommandGate — dispatch-time integration (Task 3)", () => {
  it("returns task unchanged when all commands are canonical", () => {
    const task = { title: "My task", verification_commands: ["npm test", "npm run lint"] };
    const { task: result, gate } = applyDispatchCommandGate(task);
    assert.equal(gate.safe, true);
    assert.deepEqual(result.verification_commands, task.verification_commands);
    // Returned task is same reference when safe
    assert.equal(result, task);
  });

  it("returns sanitized task when non-portable commands are present", () => {
    const task = {
      title: "Fix bug",
      verification_commands: ["node --test tests/**/*.ts", "npm run lint"],
    };
    const { task: result, gate } = applyDispatchCommandGate(task);
    assert.equal(gate.safe, false);
    assert.ok(!(result.verification_commands as string[]).some(cmd => cmd.includes("*")));
    assert.ok((result.verification_commands as string[]).includes("npm test"));
    assert.ok((result.verification_commands as string[]).includes("npm run lint"));
  });

  it("gate rewrites array describes every substitution made", () => {
    const task = { verification_commands: ["bash test.sh", "sh run.sh"] };
    const { gate } = applyDispatchCommandGate(task);
    assert.ok(gate.rewrites.length > 0, "rewrites must be populated for non-portable commands");
    for (const r of gate.rewrites) {
      assert.ok(r.original && r.rewritten && r.reason);
    }
  });

  it("task without verification_commands is returned safely (no throw)", () => {
    const task = { title: "Scan task" };
    const { task: result, gate } = applyDispatchCommandGate(task);
    assert.equal(gate.safe, true);
    assert.deepEqual(gate.sanitizedCommands, []);
    assert.equal(result, task);
  });

  it("negative path: non-array verification_commands does not throw", () => {
    const task = { verification_commands: "npm test" as any };
    const { task: result, gate } = applyDispatchCommandGate(task);
    assert.equal(gate.safe, true);
    assert.ok(result !== undefined);
  });
});

// ── Task 3: Harden forbidden command checks — trimming and edge cases ──────────

describe("checkForbiddenCommands — trimmed input hardening (Task 3)", () => {
  it("detects bash with leading whitespace (trimming fix)", () => {
    const result = checkForbiddenCommands("  bash scripts/run_tests.sh");
    assert.equal(result.forbidden, true,
      "leading-whitespace bash must be detected as forbidden after trimming");
    assert.ok(result.violations.length > 0);
  });

  it("detects sh with leading whitespace (trimming fix)", () => {
    const result = checkForbiddenCommands("  sh run.sh");
    assert.equal(result.forbidden, true,
      "leading-whitespace sh must be detected as forbidden after trimming");
  });

  it("detects npx tsx glob with leading whitespace (trimming fix)", () => {
    const result = checkForbiddenCommands("  npx tsx tests/**/*.test.ts");
    assert.equal(result.forbidden, true,
      "leading-whitespace npx tsx with glob must be detected as forbidden after trimming");
  });

  it("detects ts-node glob with leading whitespace (trimming fix)", () => {
    const result = checkForbiddenCommands("  ts-node tests/**/*.spec.ts");
    assert.equal(result.forbidden, true,
      "leading-whitespace ts-node with glob must be detected as forbidden after trimming");
  });

  it("detects node --test glob with leading whitespace (trimming fix)", () => {
    const result = checkForbiddenCommands("  node --test tests/**/*.test.ts");
    assert.equal(result.forbidden, true,
      "leading-whitespace node --test glob must be detected as forbidden after trimming");
  });

  it("negative path: canonical command with leading whitespace is NOT forbidden", () => {
    // After trimming, "  npm test" becomes "npm test" which is NOT forbidden
    const result = checkForbiddenCommands("  npm test");
    assert.equal(result.forbidden, false,
      "canonical command with leading whitespace must not be flagged as forbidden");
    assert.equal(result.violations.length, 0);
  });

  it("rewriteVerificationCommand with leading whitespace produces canonical output", () => {
    // Ensure rewrite is consistent with detection after trimming
    assert.equal(rewriteVerificationCommand("  bash scripts/test.sh"), "npm test",
      "leading-whitespace bash must be rewritten to npm test");
    assert.equal(rewriteVerificationCommand("  node --test tests/**"), "npm test",
      "leading-whitespace node --test glob must be rewritten to npm test");
  });

  it("normalizeCommandBatch strips leading whitespace before detection and rewriting", () => {
    const raw = ["  bash run.sh", "  node --test tests/**/*.ts", "  npm test"];
    const result = normalizeCommandBatch(raw);
    assert.ok(!result.some(cmd => cmd.includes("bash") || cmd.includes("*")),
      "normalizeCommandBatch must strip and rewrite all leading-whitespace forbidden commands"
    );
    const npmTestCount = result.filter(c => c === "npm test").length;
    assert.equal(npmTestCount, 1,
      "all three rewrites collapse to a single 'npm test' after deduplication"
    );
  });
});
