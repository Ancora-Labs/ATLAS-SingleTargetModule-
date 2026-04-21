import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  checkArchitectureDrift,
  normalizeAliasPath,
  detectDeprecatedTokensInContent,
  DEPRECATED_TOKENS,
  rankStaleRefsAsRemediationCandidates,
  persistDriftBacklog,
  type ArchitectureDriftReport,
} from "../../src/core/architecture_drift.js";

describe("architecture_drift", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-arch-drift-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reports no stale references when all doc-mentioned paths exist", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      "# Arch\n\nMain entry: `src/core/orchestrator.ts`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 1);
    assert.deepEqual(report.staleReferences, []);
    assert.ok(report.scannedDocs.includes("docs/architecture.md"));
  });

  it("detects stale reference when a doc mentions a file that does not exist", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    // Only orchestrator.ts exists; task_queue.ts does not
    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      [
        "# Arch",
        "",
        "Present: `src/core/orchestrator.ts`",
        "Missing: `src/core/task_queue.ts`"
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 1);
    assert.equal(report.presentCount, 1);
    assert.equal(report.staleReferences[0].referencedPath, "src/core/task_queue.ts");
    assert.equal(report.staleReferences[0].docPath, "docs/architecture.md");
    assert.equal(report.staleReferences[0].line, 4);
  });

  it("treats .js references as present when a sibling .ts source file exists", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "fs_utils.ts"),
      "export {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      "Runtime helper: `src/core/fs_utils.js`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 1);
    assert.deepEqual(report.staleReferences, []);
  });

  it("negative path: ignores absolute and environment paths — no false positives", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    // These must NOT be picked up — they are not repo-local prefixes
    await fs.writeFile(
      path.join(rootDir, "docs", "notes.md"),
      [
        "# Notes",
        "",
        "System path: `/etc/hosts`",
        "Home dir: `/home/user/.bashrc`",
        "Windows path: `C:\\Windows\\System32\\cmd.exe`",
        "Relative no-prefix: `lib/utils.ts`"
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 0);
    assert.deepEqual(report.staleReferences, []);
  });

  it("handles multiple docs and aggregates stale refs across all of them", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "docker"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "policy_engine.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docker", "Dockerfile"),
      "FROM node:20\n",
      "utf8"
    );

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      "Core: `src/core/policy_engine.ts` and `src/core/gates.ts`\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "ops.md"),
      "Docker: `docker/Dockerfile` — missing: `docker/worker.Dockerfile`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.presentCount, 2);
    assert.equal(report.staleCount, 2);

    const stalePaths = report.staleReferences.map((r) => r.referencedPath);
    assert.ok(stalePaths.includes("src/core/gates.ts"));
    assert.ok(stalePaths.includes("docker/worker.Dockerfile"));
  });

  it("returns empty report when docs directory does not exist", async () => {
    // No docs/ directory created
    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 0);
    assert.deepEqual(report.scannedDocs, []);
  });

  it("deduplicates repeated mentions of the same path within a doc", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      [
        "# Arch",
        "`src/core/missing.ts` is referenced here.",
        "And again: `src/core/missing.ts` for clarity."
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    // Same path in same doc should only be counted once
    assert.equal(report.staleCount, 1);
  });

  it("scans only explicitly requested docPaths when provided", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {}\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "included.md"),
      "Present: `src/core/orchestrator.ts`\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "excluded.md"),
      "Missing: `src/core/ghost.ts`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({
      rootDir,
      docPaths: ["docs/included.md"],
    });

    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 1);
    assert.deepEqual(report.scannedDocs, ["docs/included.md"]);
  });

  it("keeps reporting a stale ref when neither the referenced extension nor its sibling exists", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      "Missing helper: `src/core/ghost_utils.js`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 1);
    assert.equal(report.staleReferences[0].referencedPath, "src/core/ghost_utils.js");
  });
});

describe("architecture_drift — recursive docs traversal (Task 1)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-arch-drift-rec-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("recurses into docs subdirectories and scans nested .md files", async () => {
    await fs.mkdir(path.join(rootDir, "docs", "subdir"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "subdir", "nested.md"),
      "# Nested\n\nSee `src/core/orchestrator.ts`.\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.ok(
      report.scannedDocs.some(d => d.includes("nested.md")),
      "nested doc file must appear in scannedDocs"
    );
    assert.equal(report.presentCount, 1, "nested doc reference must be checked and found present");
    assert.equal(report.staleCount, 0);
  });

  it("detects stale references in deeply nested docs subdirectory", async () => {
    await fs.mkdir(path.join(rootDir, "docs", "a", "b"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "a", "b", "deep.md"),
      "Ref: `src/core/ghost.ts`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 1, "stale reference in deeply nested doc must be detected");
    assert.equal(report.staleReferences[0].referencedPath, "src/core/ghost.ts");
  });
});

describe("architecture_drift — TS/JS alias normalization (Task 1)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-arch-drift-alias-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("normalizeAliasPath resolves @core/ to src/core/", () => {
    assert.equal(normalizeAliasPath("@core/orchestrator.ts"), "src/core/orchestrator.ts");
  });

  it("normalizeAliasPath resolves @/ to src/", () => {
    assert.equal(normalizeAliasPath("@/config.ts"), "src/config.ts");
  });

  it("normalizeAliasPath resolves @tests/ to tests/", () => {
    assert.equal(normalizeAliasPath("@tests/core/foo.test.ts"), "tests/core/foo.test.ts");
  });

  it("normalizeAliasPath returns null for non-alias paths", () => {
    assert.equal(normalizeAliasPath("src/core/foo.ts"), null);
    assert.equal(normalizeAliasPath("random/path.ts"), null);
  });

  it("detects stale @core/ alias reference in docs and classifies it as stale after normalization", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    // Do NOT create src/core/ghost.ts — alias ref should be stale
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      "See `@core/ghost.ts` for the implementation.\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    const staleAliasRef = report.staleReferences.find(r => r.referencedPath === "src/core/ghost.ts");
    assert.ok(staleAliasRef, "alias reference @core/ghost.ts must be normalized to src/core/ghost.ts and classified stale");
  });

  it("resolves @core/ alias reference as present when the real file exists", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      "Entry: `@core/orchestrator.ts`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.presentCount, 1, "normalized alias ref must count as present when file exists");
    assert.equal(report.staleCount, 0);
  });
});

describe("architecture_drift — deprecated token detection (Task 5)", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-arch-drift-dep-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("DEPRECATED_TOKENS is non-empty and each entry has pattern + hint", () => {
    assert.ok(Array.isArray(DEPRECATED_TOKENS) && DEPRECATED_TOKENS.length > 0,
      "DEPRECATED_TOKENS must be a non-empty array");
    for (const entry of DEPRECATED_TOKENS) {
      assert.ok(entry.pattern instanceof RegExp, "each deprecated token entry must have a RegExp pattern");
      assert.ok(typeof entry.hint === "string" && entry.hint.length > 0,
        "each deprecated token entry must have a non-empty hint string");
    }
  });

  it("detectDeprecatedTokensInContent finds governance_verdict in doc content", () => {
    const content = "The old API used governance_verdict to signal completion.";
    const refs = detectDeprecatedTokensInContent("docs/old.md", content);
    const found = refs.find(r => r.token === "governance_verdict");
    assert.ok(found, "governance_verdict must be detected as deprecated");
    assert.equal(found!.docPath, "docs/old.md");
    assert.ok(found!.hint.length > 0, "hint must be non-empty");
  });

  it("detectDeprecatedTokensInContent finds resume_dispatch as deprecated", () => {
    const content = "Calling resume_dispatch will trigger worker resumption.";
    const refs = detectDeprecatedTokensInContent("docs/resume.md", content);
    const found = refs.find(r => r.token === "resume_dispatch");
    assert.ok(found, "resume_dispatch must be detected as deprecated");
  });

  it("detectDeprecatedTokensInContent returns empty array for clean content", () => {
    const content = "Use runResumeDispatch and GOVERNANCE_GATE_EVALUATED instead.";
    const refs = detectDeprecatedTokensInContent("docs/clean.md", content);
    assert.equal(refs.length, 0, "no deprecated tokens should be found in clean content");
  });

  it("checkArchitectureDrift includes deprecatedTokenCount and deprecatedTokenRefs in report", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "legacy.md"),
      "Legacy docs reference governance_verdict and resume_dispatch.\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.ok(typeof report.deprecatedTokenCount === "number",
      "report must include deprecatedTokenCount");
    assert.ok(Array.isArray(report.deprecatedTokenRefs),
      "report must include deprecatedTokenRefs array");
    assert.ok(report.deprecatedTokenCount >= 2,
      "must detect at least 2 deprecated tokens in legacy doc");
  });

  it("negative path: clean docs with no deprecated tokens produce zero deprecatedTokenCount", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "clean.md"),
      "Use evaluatePreDispatchGovernanceGate and runAthenaPlanReview.\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.deprecatedTokenCount, 0,
      "clean docs must produce zero deprecated token count");
    assert.deepEqual(report.deprecatedTokenRefs, [],
      "clean docs must produce empty deprecated token refs");
  });

  it("deprecated token refs include line number and docPath", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "stale.md"),
      [
        "# Old API",
        "",
        "Step 1: call governance_verdict",
        "Step 2: use resumeDispatch"
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    const verdictRef = report.deprecatedTokenRefs.find(r => r.token === "governance_verdict");
    assert.ok(verdictRef, "governance_verdict ref must be in report");
    assert.equal(verdictRef!.line, 3, "line number must be 3 for governance_verdict");
    assert.ok(verdictRef!.docPath.includes("stale.md"), "docPath must reference stale.md");
  });
});

// ── rankStaleRefsAsRemediationCandidates (Task 1 planning bridge) ─────────────

describe("rankStaleRefsAsRemediationCandidates", () => {
  it("returns empty array for empty report", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: [],
      presentCount: 0,
      staleCount: 0,
      staleReferences: [],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.deepEqual(candidates, []);
  });

  it("assigns high priority to stale src/core/ references", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/arch.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/orchestrator.ts", line: 3 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].priority, "high");
    assert.ok(candidates[0].priorityScore >= 300);
    assert.equal(candidates[0].type, "stale_ref");
    assert.ok(candidates[0].referencedPath === "src/core/orchestrator.ts");
  });

  it("assigns medium priority to stale src/ (non-core) references", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/arch.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/config.ts", line: 5 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates[0].priority, "medium");
    assert.ok(candidates[0].priorityScore >= 200 && candidates[0].priorityScore < 300);
  });

  it("assigns low priority to stale docker/scripts/docs references", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/ops.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [{ docPath: "docs/ops.md", referencedPath: "docker/worker.Dockerfile", line: 2 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates[0].priority, "low");
    assert.ok(candidates[0].priorityScore >= 100 && candidates[0].priorityScore < 200);
  });

  it("boosts autonomous-dev-playbook drift findings ahead of equally-prioritized docs", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/autonomous-dev-playbook.md", "docs/ops.md"],
      presentCount: 0,
      staleCount: 2,
      staleReferences: [
        { docPath: "docs/ops.md", referencedPath: "src/core/missing_ops.ts", line: 3 },
        { docPath: "docs/autonomous-dev-playbook.md", referencedPath: "src/core/missing_playbook.ts", line: 7 },
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates[0].docPath, "docs/autonomous-dev-playbook.md");
    assert.ok(candidates[0].priorityScore > candidates[1].priorityScore);
  });

  it("assigns medium priority to all deprecated token findings", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/legacy.md"],
      presentCount: 0,
      staleCount: 0,
      staleReferences: [],
      deprecatedTokenCount: 1,
      deprecatedTokenRefs: [{ docPath: "docs/legacy.md", token: "governance_verdict", hint: "use governance_contract", line: 7 }],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].priority, "medium");
    assert.equal(candidates[0].type, "deprecated_token");
    assert.ok(candidates[0].token === "governance_verdict");
    assert.ok(candidates[0].hint === "use governance_contract");
  });

  it("sorts high before medium before low", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/a.md"],
      presentCount: 0,
      staleCount: 3,
      staleReferences: [
        { docPath: "docs/a.md", referencedPath: "docker/worker.Dockerfile", line: 1 },   // low
        { docPath: "docs/a.md", referencedPath: "src/core/policy_engine.ts", line: 2 },  // high
        { docPath: "docs/a.md", referencedPath: "src/config.ts", line: 3 },              // medium
      ],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates[0].priority, "high");
    assert.equal(candidates[1].priority, "medium");
    assert.equal(candidates[2].priority, "low");
  });

  it("each candidate has suggestedTask, reason, docPath, and line", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/arch.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/missing.ts", line: 12 }],
      deprecatedTokenCount: 0,
      deprecatedTokenRefs: [],
    };
    const [c] = rankStaleRefsAsRemediationCandidates(report);
    assert.ok(typeof c.suggestedTask === "string" && c.suggestedTask.length > 0, "suggestedTask must be non-empty");
    assert.ok(typeof c.reason === "string" && c.reason.length > 0, "reason must be non-empty");
    assert.equal(c.docPath, "docs/arch.md");
    assert.equal(c.line, 12);
  });

  it("negative path: interleaves stale refs and deprecated tokens by priority (medium mixed)", () => {
    const report: ArchitectureDriftReport = {
      scannedDocs: ["docs/a.md"],
      presentCount: 0,
      staleCount: 1,
      staleReferences: [
        // low priority
        { docPath: "docs/a.md", referencedPath: "scripts/deploy.sh", line: 1 },
      ],
      deprecatedTokenCount: 1,
      deprecatedTokenRefs: [
        // medium priority — should come before the low ref
        { docPath: "docs/a.md", token: "resume_dispatch", hint: "use runResumeDispatch", line: 4 },
      ],
    };
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].priority, "medium", "deprecated token (medium) must sort before stale scripts ref (low)");
    assert.equal(candidates[0].type, "deprecated_token");
    assert.equal(candidates[1].priority, "low");
    assert.equal(candidates[1].type, "stale_ref");
  });
});

// ── convertRemediationCandidatesToDebtTasks (Task 2 planning bridge) ──────────

import {
  convertRemediationCandidatesToDebtTasks,
  DEBT_CONFIDENCE_BY_PRIORITY,
  type PlannerDebtTask,
  type RemediationCandidate,
} from "../../src/core/architecture_drift.js";

describe("convertRemediationCandidatesToDebtTasks", () => {
  const FIXED_TS = "2026-01-01T00:00:00.000Z";

  function makeCandidate(overrides: Partial<RemediationCandidate>): RemediationCandidate {
    return {
      type: "stale_ref",
      docPath: "docs/arch.md",
      referencedPath: "src/core/orchestrator.ts",
      line: 1,
      priority: "medium",
      reason: "test reason",
      suggestedTask: "Fix stale ref",
      ...overrides,
    };
  }

  it("returns empty array for empty input", () => {
    assert.deepEqual(convertRemediationCandidatesToDebtTasks([]), []);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(convertRemediationCandidatesToDebtTasks(null as any), []);
  });

  it("maps a single high-priority candidate with confidence=0.50", () => {
    const candidates = [
      makeCandidate({ priority: "high", suggestedTask: "Fix core ref" }),
    ];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].confidence, 0.50);
    assert.equal(tasks[0].priority, "high");
    assert.equal(tasks[0].task, "Fix core ref");
    assert.equal(tasks[0].debtClass, "architecture_drift");
    assert.equal(tasks[0].createdAt, FIXED_TS);
  });

  it("maps a medium-priority candidate with confidence=0.75", () => {
    const candidates = [makeCandidate({ priority: "medium" })];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.equal(tasks[0].confidence, 0.75);
  });

  it("maps a low-priority candidate with confidence=0.90", () => {
    const candidates = [makeCandidate({ priority: "low", suggestedTask: "Fix docker ref" })];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.equal(tasks[0].confidence, 0.90);
  });

  it("output is sorted high → medium → low regardless of input order", () => {
    const candidates = [
      makeCandidate({ priority: "low",    docPath: "docs/c.md", line: 3 }),
      makeCandidate({ priority: "high",   docPath: "docs/a.md", line: 1 }),
      makeCandidate({ priority: "medium", docPath: "docs/b.md", line: 2 }),
    ];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.equal(tasks[0].priority, "high");
    assert.equal(tasks[1].priority, "medium");
    assert.equal(tasks[2].priority, "low");
  });

  it("is deterministic: same input always produces the same task IDs", () => {
    const candidates = [
      makeCandidate({ priority: "high", line: 7 }),
      makeCandidate({ priority: "low",  line: 14 }),
    ];
    const run1 = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    const run2 = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.deepEqual(
      run1.map(t => t.taskId),
      run2.map(t => t.taskId),
      "task IDs must be identical across invocations with the same input"
    );
  });

  it("each task has a non-empty unique taskId", () => {
    const candidates = [
      makeCandidate({ line: 1, docPath: "docs/a.md" }),
      makeCandidate({ line: 2, docPath: "docs/a.md" }),
    ];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    const ids = tasks.map(t => t.taskId);
    assert.equal(new Set(ids).size, 2, "each task must have a unique taskId");
    ids.forEach(id => assert.ok(id.length > 0, "taskId must be non-empty"));
  });

  it("deprecated_token candidates carry type and token info", () => {
    const candidates: RemediationCandidate[] = [
      {
        type: "deprecated_token",
        docPath: "docs/legacy.md",
        token: "governance_verdict",
        hint: "use governance_contract",
        line: 5,
        priority: "medium",
        reason: "deprecated",
        suggestedTask: "Replace governance_verdict in docs/legacy.md",
      },
    ];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates, FIXED_TS);
    assert.equal(tasks[0].type, "deprecated_token");
    assert.equal(tasks[0].source, "docs/legacy.md");
    assert.ok(tasks[0].task.includes("governance_verdict"));
  });

  it("DEBT_CONFIDENCE_BY_PRIORITY exports correct constants", () => {
    assert.equal(DEBT_CONFIDENCE_BY_PRIORITY.high,   0.50);
    assert.equal(DEBT_CONFIDENCE_BY_PRIORITY.medium, 0.75);
    assert.equal(DEBT_CONFIDENCE_BY_PRIORITY.low,    0.90);
  });

  it("negative path: uses current time when createdAt is omitted (non-deterministic ts only)", () => {
    const candidates = [makeCandidate({ priority: "medium" })];
    const tasks = convertRemediationCandidatesToDebtTasks(candidates);
    assert.ok(typeof tasks[0].createdAt === "string" && tasks[0].createdAt.length > 0,
      "createdAt must be a non-empty string even when caller omits the timestamp");
  });
});

// ── persistDriftBacklog ───────────────────────────────────────────────────────

describe("architecture_drift — persistDriftBacklog", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-drift-backlog-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  const emptyReport: ArchitectureDriftReport = {
    scannedDocs: [],
    presentCount: 0,
    staleCount: 0,
    staleReferences: [],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };

  const reportWithFindings: ArchitectureDriftReport = {
    scannedDocs: ["docs/architecture.md"],
    presentCount: 1,
    staleCount: 1,
    staleReferences: [
      { docPath: "docs/architecture.md", referencedPath: "src/core/missing.ts", line: 5 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };

  it("creates drift_backlog.json in the state directory on first call", async () => {
    await persistDriftBacklog(stateDir, emptyReport, { persistedAt: "2025-01-01T00:00:00.000Z" });
    const backlogPath = path.join(stateDir, "drift_backlog.json");
    const exists = await fs.access(backlogPath).then(() => true).catch(() => false);
    assert.ok(exists, "drift_backlog.json must be created after persistDriftBacklog");
  });

  it("writes a valid JSON line (NDJSON) that parses correctly", async () => {
    await persistDriftBacklog(stateDir, emptyReport, {
      persistedAt: "2025-01-01T00:00:00.000Z",
      source: "test-runner",
    });
    const backlogPath = path.join(stateDir, "drift_backlog.json");
    const raw = await fs.readFile(backlogPath, "utf8");
    const lines = raw.trim().split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 1, "one NDJSON line must be written per call");
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.schemaVersion, 1);
    assert.equal(entry.persistedAt, "2025-01-01T00:00:00.000Z");
    assert.equal(entry.source, "test-runner");
    assert.equal(entry.staleCount, 0);
    assert.equal(entry.deprecatedTokenCount, 0);
    assert.ok(Array.isArray(entry.debtTasks), "debtTasks must be an array");
  });

  it("appends a new line on successive calls (NDJSON format)", async () => {
    const meta = { persistedAt: "2025-01-01T00:00:00.000Z", source: "first" };
    const meta2 = { persistedAt: "2025-01-01T01:00:00.000Z", source: "second" };
    await persistDriftBacklog(stateDir, emptyReport, meta);
    await persistDriftBacklog(stateDir, emptyReport, meta2);
    const raw = await fs.readFile(path.join(stateDir, "drift_backlog.json"), "utf8");
    const lines = raw.trim().split("\n").filter(l => l.length > 0);
    assert.equal(lines.length, 2, "each call must append a new NDJSON line");
    assert.equal(JSON.parse(lines[0]).source, "first");
    assert.equal(JSON.parse(lines[1]).source, "second");
  });

  it("includes debtTasks derived from stale references in the entry", async () => {
    await persistDriftBacklog(stateDir, reportWithFindings, {
      persistedAt: "2025-06-01T00:00:00.000Z",
    });
    const raw = await fs.readFile(path.join(stateDir, "drift_backlog.json"), "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0]);
    assert.equal(entry.staleCount, 1);
    assert.equal(entry.debtTaskCount, 1);
    assert.ok(entry.debtTasks[0].taskId.startsWith("drift-"),
      "debtTask taskId must use drift- prefix");
    assert.equal(entry.debtTasks[0].debtClass, "architecture_drift");
  });

  it("NEGATIVE PATH: does not throw when stateDir does not exist (logs to stderr instead)", async () => {
    const badDir = path.join(stateDir, "nonexistent", "nested");
    // Must not throw — failure is logged, not propagated
    await assert.doesNotReject(
      () => persistDriftBacklog(badDir, emptyReport),
      "persistDriftBacklog must not throw on write failure"
    );
  });
});
