import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  scanProject,
  computeScanNoveltySignal,
  detectImplementationGaps,
  buildSemanticFileCandidatesFromScan,
  rankSemanticFileCandidates,
} from "../../src/core/project_scanner.js";

describe("project_scanner", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-scan-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("derives commands and repository signals from package.json", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "app.ts"), "export const x = 1;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "README.md"), "# test\n", "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "sample-box",
      scripts: { build: "tsc", test: "node --test", lint: "eslint ." },
      dependencies: { react: "1.0.0" },
      devDependencies: { typescript: "5.0.0" }
    }), "utf8");

    const result = await scanProject({ rootDir });
    assert.equal(result.hasPackageJson, true);
    assert.equal(result.packageName, "sample-box");
    assert.equal(result.commands.build, "npm run build");
    assert.ok(result.frameworks.includes("react"));
    assert.ok(result.frameworks.includes("typescript"));
    assert.ok(result.repositorySignals.srcFileCount >= 1);
  });

  it("negative path: falls back to defaults when package.json is invalid", async () => {
    await fs.writeFile(path.join(rootDir, "package.json"), "{ invalid", "utf8");
    const result = await scanProject({ rootDir });
    assert.equal(result.hasPackageJson, false);
    assert.equal(result.commands.install, "npm ci");
    assert.equal(result.commands.build, null);
  });

  it("scanProject includes implementationGaps array", async () => {
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "gap-test",
      scripts: { test: "node --test" }
    }), "utf8");
    const result = await scanProject({ rootDir });
    assert.ok(Array.isArray(result.implementationGaps), "implementationGaps must be an array");
  });

  it("scanProject detects missing-test gap for untested source file", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "orphan.ts"), "export const x = 1;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "gap-test",
      scripts: { test: "node --test" }
    }), "utf8");

    const result = await scanProject({ rootDir });
    const missingTest = result.implementationGaps.find(
      (g) => g.type === "missing-test" && g.file === "src/orphan.ts"
    );
    assert.ok(missingTest, "Should detect missing-test gap for src/orphan.ts");
    assert.ok(missingTest.evidence.length > 0, "Gap must carry evidence");
    assert.equal(missingTest.severity, "high");
  });

  it("scanProject does not emit missing-test for source files that have tests", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "tests"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "covered.ts"), "export const y = 2;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "tests", "covered.test.ts"), "// test\n", "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "covered-test",
      scripts: { test: "node --test" }
    }), "utf8");

    const result = await scanProject({ rootDir });
    const falseGap = result.implementationGaps.find(
      (g) => g.type === "missing-test" && g.file === "src/covered.ts"
    );
    assert.equal(falseGap, undefined, "Should NOT emit missing-test for a covered source file");
  });

  it("scanProject detects missing-ci when test runner present but no .github/workflows", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "app.ts"), "export const z = 3;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "no-ci-test",
      scripts: { test: "node --test" }
    }), "utf8");

    const result = await scanProject({ rootDir });
    const missingCi = result.implementationGaps.find((g) => g.type === "missing-ci");
    assert.ok(missingCi, "Should detect missing-ci when no GitHub Actions workflows found");
    assert.ok(missingCi.evidence.length > 0);
  });

  it("scanProject detects missing-tsconfig when .ts files present and no tsconfig.json", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "typed.ts"), "export const t = 1;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "no-tsconfig-test",
      scripts: {}
    }), "utf8");
    // Note: no tsconfig.json written

    const result = await scanProject({ rootDir });
    const missingTs = result.implementationGaps.find((g) => g.type === "missing-tsconfig");
    assert.ok(missingTs, "Should detect missing-tsconfig when .ts files exist without tsconfig.json");
  });

  it("scanProject does NOT emit missing-tsconfig when tsconfig.json is present", async () => {
    await fs.mkdir(path.join(rootDir, "src"), { recursive: true });
    await fs.writeFile(path.join(rootDir, "src", "typed.ts"), "export const t = 1;\n", "utf8");
    await fs.writeFile(path.join(rootDir, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8");
    await fs.writeFile(path.join(rootDir, "package.json"), JSON.stringify({
      name: "has-tsconfig-test",
      scripts: {}
    }), "utf8");

    const result = await scanProject({ rootDir });
    const missingTs = result.implementationGaps.find((g) => g.type === "missing-tsconfig");
    assert.equal(missingTs, undefined, "Should NOT emit missing-tsconfig when tsconfig.json exists");
  });
});

describe("detectImplementationGaps", () => {
  const baseSignals = {
    hasGithubActions: true,
    workflowFileCount: 1,
    tsFileCount: 0,
    hasTsConfig: true,
  };

  it("returns empty array when all source files have tests and setup is complete", () => {
    const gaps = detectImplementationGaps(
      ["src/core/foo.ts"],
      ["tests/core/foo.test.ts"],
      baseSignals,
      true,
    );
    assert.deepEqual(gaps, []);
  });

  it("emits missing-test gap with evidence for each untested source file", () => {
    const gaps = detectImplementationGaps(
      ["src/core/bar.ts", "src/utils/helper.ts"],
      [],
      baseSignals,
      true,
    );
    const types = gaps.map((g) => g.type);
    assert.ok(types.includes("missing-test"), "Should include missing-test type");
    const barGap = gaps.find((g) => g.file === "src/core/bar.ts");
    assert.ok(barGap, "Should emit gap for src/core/bar.ts");
    assert.ok(barGap.evidence.length >= 2, "Each gap must have at least 2 evidence strings");
    assert.equal(barGap.severity, "high");
  });

  it("output is sorted deterministically by id", () => {
    const gaps = detectImplementationGaps(
      ["src/z.ts", "src/a.ts"],
      [],
      baseSignals,
      true,
    );
    const ids = gaps.map((g) => g.id);
    const sorted = [...ids].sort((a, b) => a.localeCompare(b));
    assert.deepEqual(ids, sorted, "Gaps must be sorted by id");
  });

  it("emits low-test-ratio when ratio falls below threshold (>5 src files)", () => {
    const srcFiles = Array.from({ length: 10 }, (_, i) => `src/mod${i}.ts`);
    const gaps = detectImplementationGaps(srcFiles, [], baseSignals, true);
    const ratioGap = gaps.find((g) => g.type === "low-test-ratio");
    assert.ok(ratioGap, "Should emit low-test-ratio for 10 src / 0 test");
    assert.equal(ratioGap.severity, "medium");
  });

  it("does NOT emit low-test-ratio when ratio is above threshold", () => {
    const srcFiles = Array.from({ length: 4 }, (_, i) => `src/mod${i}.ts`);
    const testFiles = Array.from({ length: 4 }, (_, i) => `tests/mod${i}.test.ts`);
    const gaps = detectImplementationGaps(srcFiles, testFiles, baseSignals, true);
    const ratioGap = gaps.find((g) => g.type === "low-test-ratio");
    assert.equal(ratioGap, undefined);
  });

  it("emits missing-ci when test runner is configured but no GitHub Actions", () => {
    const signals = { ...baseSignals, hasGithubActions: false, workflowFileCount: 0 };
    const gaps = detectImplementationGaps(["src/app.ts"], [], signals, true);
    const ciGap = gaps.find((g) => g.type === "missing-ci");
    assert.ok(ciGap, "Should emit missing-ci");
    assert.equal(ciGap.severity, "high");
  });

  it("does NOT emit missing-ci when no test runner configured", () => {
    const signals = { ...baseSignals, hasGithubActions: false, workflowFileCount: 0 };
    const gaps = detectImplementationGaps(["src/app.ts"], [], signals, false);
    const ciGap = gaps.find((g) => g.type === "missing-ci");
    assert.equal(ciGap, undefined, "Should not emit missing-ci when no test runner");
  });

  it("emits missing-tsconfig when .ts files present but no tsconfig.json", () => {
    const signals = { ...baseSignals, tsFileCount: 5, hasTsConfig: false };
    const gaps = detectImplementationGaps([], [], signals, true);
    const tsGap = gaps.find((g) => g.type === "missing-tsconfig");
    assert.ok(tsGap, "Should emit missing-tsconfig");
    assert.equal(tsGap.severity, "medium");
  });

  it("emits no-test-runner when source files exist but no test runner configured", () => {
    const gaps = detectImplementationGaps(["src/app.ts"], [], baseSignals, false);
    const noRunner = gaps.find((g) => g.type === "no-test-runner");
    assert.ok(noRunner, "Should emit no-test-runner");
    assert.equal(noRunner.severity, "high");
  });

  it("negative path: handles empty and null inputs gracefully", () => {
    const gaps = detectImplementationGaps(null as any, null as any, baseSignals, false);
    assert.ok(Array.isArray(gaps), "Should return an array even for null inputs");
  });

  it("negative path: does not emit no-test-runner when srcFiles is empty", () => {
    const gaps = detectImplementationGaps([], [], baseSignals, false);
    const noRunner = gaps.find((g) => g.type === "no-test-runner");
    assert.equal(noRunner, undefined, "no-test-runner should not fire with no source files");
  });
});

describe("computeScanNoveltySignal", () => {
  it("returns low signal when all current domains were already known", () => {
    const result = computeScanNoveltySignal(["backend", "quality"], ["backend", "quality", "devops"]);
    assert.equal(result.noveltySignal, "low");
    assert.deepEqual(result.newDomains, []);
  });

  it("returns medium signal when one new domain is discovered", () => {
    const result = computeScanNoveltySignal(["backend", "quality", "devops"], ["backend", "quality"]);
    assert.equal(result.noveltySignal, "medium");
    assert.deepEqual(result.newDomains, ["devops"]);
  });

  it("returns high signal when more than half the current domains are new", () => {
    const result = computeScanNoveltySignal(["devops", "security", "backend"], ["backend"]);
    assert.equal(result.noveltySignal, "high");
    assert.ok(result.newDomains.includes("devops"));
    assert.ok(result.newDomains.includes("security"));
  });

  it("returns high signal when all current domains are new (first run against empty baseline)", () => {
    const result = computeScanNoveltySignal(["backend", "quality"], []);
    assert.equal(result.noveltySignal, "high");
    assert.deepEqual(result.newDomains, ["backend", "quality"]);
  });

  it("returns low signal for empty currentDomains", () => {
    const result = computeScanNoveltySignal([], ["backend"]);
    assert.equal(result.noveltySignal, "low");
    assert.deepEqual(result.newDomains, []);
  });

  it("negative path: handles null/undefined inputs gracefully", () => {
    const result = computeScanNoveltySignal(null as any, null as any);
    assert.equal(result.noveltySignal, "low");
    assert.deepEqual(result.newDomains, []);
  });
});

describe("semantic retrieval helpers", () => {
  it("ranks semantically relevant files deterministically under token budget", () => {
    const candidates = [
      { path: "src/core/orchestrator.ts", preview: "dispatch lane specialization and governance gates" },
      { path: "src/core/model_policy.ts", preview: "model routing and policy enforcement" },
      { path: "tests/core/orchestrator.test.ts", preview: "integration tests for orchestrator" },
    ];
    const ranked = rankSemanticFileCandidates("dispatch specialization lanes", candidates, {
      tokenBudget: 120,
      maxEntries: 2,
      cacheKey: "project-scanner-semantic-test",
    });
    assert.ok(ranked.length > 0, "must return at least one ranked entry");
    assert.equal(ranked[0].path, "src/core/orchestrator.ts", "most relevant file must rank first");
    assert.ok(ranked.length <= 2, "must respect maxEntries");
  });

  it("buildSemanticFileCandidatesFromScan deduplicates and normalizes paths", () => {
    const candidates = buildSemanticFileCandidatesFromScan({
      repositorySignals: {
        allSrcFiles: ["src\\core\\orchestrator.ts", "src/core/orchestrator.ts", "src/core/prometheus.ts"],
        allTestFiles: ["tests/core/orchestrator.test.ts"],
        keyFilePreviews: [
          { path: "src/core/orchestrator.ts", preview: "orchestrator preview" },
        ],
      },
    });
    const paths = candidates.map((entry) => entry.path);
    assert.deepEqual(paths, [
      "src/core/orchestrator.ts",
      "src/core/prometheus.ts",
      "tests/core/orchestrator.test.ts",
    ]);
    assert.equal(candidates[0].preview, "orchestrator preview");
  });
});

