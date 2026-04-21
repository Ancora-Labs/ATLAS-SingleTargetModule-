/**
 * Verification Glob Conformance Test (Packet 14)
 *
 * Scans all executable source files (src/, scripts/, .github/workflows/)
 * to ensure no forbidden shell-glob test invocations exist.
 *
 * The pattern `node --test tests/**` fails on Windows because the shell
 * does not expand globs. This test guarantees the pattern never reappears.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Recursively collect files matching extensions under a directory. */
function collectFiles(dir, extensions, results = []) {
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      collectFiles(full, extensions, results);
    } else if (entry.isFile() && extensions.some(ext => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Forbidden patterns: shell-glob based test invocations that break on Windows.
 * These must NEVER appear in executable code, configs, or CI scripts.
 */
const FORBIDDEN_PATTERNS = [
  /node\s+--test\s+tests\/\*\*/,
  /node\s+--test\s+tests\\\*\*/,
  /node\s+--test\s+"tests\/\*\*/,
  /node\s+--test\s+'tests\/\*\*/,
];

/**
 * Files that are ALLOWED to reference the forbidden pattern because they
 * are detection/policy code or test fixtures that test the detection.
 */
const ALLOWLIST = new Set([
  path.join("src", "core", "learning_policy_compiler.js"),
  path.join("tests", "core", "learning_policy_compiler.test.ts"),
  path.join("tests", "core", "verification_glob_conformance.test.ts"),
]);

describe("verification glob conformance", () => {
  it("no executable source file contains forbidden shell-glob test invocations", () => {
    const scanDirs = [
      path.join(ROOT, "src"),
      path.join(ROOT, "scripts"),
      path.join(ROOT, ".github"),
    ];
    const extensions = [".js", ".mjs", ".cjs", ".yml", ".yaml", ".json", ".ps1", ".sh"];
    const files = [];
    for (const dir of scanDirs) {
      collectFiles(dir, extensions, files);
    }

    const violations = [];
    for (const filePath of files) {
      const rel = path.relative(ROOT, filePath);
      if (ALLOWLIST.has(rel)) continue;

      const content = fs.readFileSync(filePath, "utf8");
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(content)) {
          violations.push(`${rel} matches ${pattern}`);
        }
      }
    }

    assert.deepStrictEqual(
      violations,
      [],
      `Forbidden shell-glob test invocations found:\n${violations.join("\n")}`
    );
  });

  it("package.json test script does not use shell globs", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    const testScript = pkg.scripts?.test || "";
    assert.ok(
      !testScript.includes("*"),
      `package.json test script contains glob: "${testScript}"`
    );
  });

  it("CI workflow uses npm test (not raw node --test with globs)", () => {
    const ciPath = path.join(ROOT, ".github", "workflows", "ci.yml");
    if (!fs.existsSync(ciPath)) return; // skip if no CI
    const content = fs.readFileSync(ciPath, "utf8");
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(
        !pattern.test(content),
        `CI workflow contains forbidden pattern: ${pattern}`
      );
    }
  });
});
