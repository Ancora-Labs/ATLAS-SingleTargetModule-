import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  evaluateTargetSuccessContract,
  isTargetSuccessContractTerminal,
  performTargetDeliveryHandoff,
  TARGET_SUCCESS_CONTRACT_STATUS,
} from "../../src/core/target_success_contract.js";

function buildConfig(tempRoot: string) {
  const rootDir = path.join(tempRoot, "box-root");
  return {
    rootDir,
    paths: {
      stateDir: path.join(rootDir, "state"),
      workspaceDir: path.join(rootDir, ".box-work"),
    },
    platformModeState: {
      currentMode: "single_target_delivery",
    },
  };
}

function buildSession() {
  return {
    projectId: "target_testrepoforsingletargetmode",
    sessionId: "sess_test_001",
    objective: {
      summary: "i want simple to do list app",
      acceptanceCriteria: ["clarified", "planning-ready"],
    },
    intent: {
      summary: "goal=simple to-do list app | success=Fast MVP, simple clean UI, add complete delete task flow first",
      scopeIn: ["i want simple to-do list app", "has to be a completed, working project"],
      mustHaveFlows: ["has to be a completed, working project"],
      preferredQualityBar: "Fast MVP, simple clean UI, add complete delete task flow first",
    },
    handoff: {
      requiredHumanInputs: ["Choose the main priority so BOX can optimize the first build correctly."],
      carriedContextSummary: "Target delivery is active.",
    },
  };
}

function buildStampedWorkerHeader(session: any, workspacePath?: string) {
  return [
    `TARGET_PROJECT_ID: ${String(session?.projectId || "")}`,
    `TARGET_SESSION_ID: ${String(session?.sessionId || "")}`,
    `TARGET_REPO_URL: ${String(session?.repo?.repoUrl || "")}`,
    `TARGET_REPO_FULL_NAME: ${String(session?.repo?.repoFullName || "")}`,
    `TARGET_WORKSPACE_PATH: ${String(workspacePath || session?.workspace?.path || "")}`,
  ].join("\n");
}

async function writeResearchState(config: any, session: any, opts: {
  refreshRecommended?: boolean;
  coveragePassed?: boolean;
  sourceCount?: number;
  completedPairs?: number;
  totalPairs?: number;
  scoutAt?: string;
  synthAt?: string;
  topicCount?: number;
} = {}) {
  const refreshRecommended = opts.refreshRecommended === true;
  const coveragePassed = opts.coveragePassed !== false;
  const sourceCount = Number(opts.sourceCount ?? 8);
  const topicCount = Number(opts.topicCount ?? 2);
  const totalPairs = Math.max(1, Number(opts.totalPairs ?? 3));
  const completedPairs = Math.max(0, Math.min(totalPairs, Number(opts.completedPairs ?? totalPairs)));
  const scoutAt = String(opts.scoutAt || new Date().toISOString());
  const synthAt = String(opts.synthAt || scoutAt);

  await fs.writeFile(path.join(config.paths.stateDir, "research_scout_output.json"), JSON.stringify({
    success: true,
    sourceCount,
    scoutedAt: scoutAt,
    sources: Array.from({ length: sourceCount }, (_, index) => ({
      title: `Source ${index + 1}`,
      url: `https://example.com/source-${index + 1}`,
      topicTags: ["visual_design", "trust_signals"],
    })),
    targetSession: {
      projectId: session.projectId,
      sessionId: session.sessionId,
    },
    coveragePlan: {
      obligations: ["visual_design", "trust_signals"],
      targetSourceCount: 6,
    },
  }, null, 2), "utf8");

  await fs.writeFile(path.join(config.paths.stateDir, "research_synthesis.json"), JSON.stringify({
    success: true,
    synthesizedAt: synthAt,
    topicCount,
    topics: [
      { topic: "visual_design", sources: [{ prometheusReadySummary: "Use premium hierarchy and card spacing." }] },
      { topic: "trust_signals", sources: [{ prometheusReadySummary: "Use testimonials, FAQ, and strong CTA trust cues." }] },
    ],
    targetSession: {
      projectId: session.projectId,
      sessionId: session.sessionId,
    },
    qualityGate: {
      passed: coveragePassed,
      retried: false,
      topicDensities: [
        { topic: "visual_design", actionableCount: 1, passed: true },
        { topic: "trust_signals", actionableCount: 1, passed: true },
      ],
      quarantinedTopics: [],
      degradedPlanningMode: false,
      planningMode: "normal",
      coverage: {
        passed: coveragePassed,
        missingObligations: coveragePassed ? [] : ["visual_design"],
      },
      refreshRecommended,
    },
  }, null, 2), "utf8");

  await fs.writeFile(path.join(config.paths.stateDir, "research_scout_topic_site_status.json"), JSON.stringify({
    updatedAt: new Date().toISOString(),
    entries: Array.from({ length: totalPairs }, (_, index) => ({
      site: `example-${index + 1}.com`,
      topic: index < completedPairs ? "visual_design" : "trust_signals",
      status: index < completedPairs ? "completed" : "in_progress",
      uniqueSourceCount: 3,
      lastSeenAt: new Date().toISOString(),
      completedAt: index < completedPairs ? new Date().toISOString() : undefined,
    })),
  }, null, 2), "utf8");
}

async function seedProjectReadinessLedger(config: any, session: any, samples: Array<{
  scoutAt: string;
  synthAt: string;
  sourceCount?: number;
  topicCount?: number;
  coveragePassed?: boolean;
  refreshRecommended?: boolean;
  completedPairs?: number;
  totalPairs?: number;
}>) {
  for (const sample of samples) {
    await writeResearchState(config, session, sample);
    await evaluateTargetSuccessContract(config, session);
  }
}

describe("target_success_contract", () => {
  let tempRoot: string;
  let config: any;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-target-success-"));
    config = buildConfig(tempRoot);
    await fs.mkdir(config.paths.stateDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("marks the target fulfilled when delivery and final sign-off evidence exist", async () => {
    const workspacePath = path.join(tempRoot, "delivered-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
    };
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_EXPECTED_OUTCOME=simple static to-do list app delivered in the target repository with browser-openable assets and verification coverage",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_EXPECTED_OUTCOME=Verify the live GitHub main branch has the simple to-do list app and only sign off if all six release checks pass.",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app and all six release checks passed without requiring new changes.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED);
    assert.equal(report.pendingHumanInputs.length, 0);
    assert.equal(isTargetSuccessContractTerminal(report), true);
    assert.equal(report.delivery.locationType, "local_path");
    assert.equal(report.delivery.workspacePath, workspacePath);
    assert.equal(report.delivery.autoOpenEligible, true);
    assert.equal(report.delivery.openTarget, path.join(workspacePath, "index.html"));
  });

  it("keeps the contract open when final release sign-off evidence is missing", async () => {
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, buildSession());
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.OPEN);
    assert.ok(report.blockers.includes("release_signoff_missing"));
    assert.equal(isTargetSuccessContractTerminal(report), false);
  });

  it("keeps the contract open when single_target_project_readiness is still pending", async () => {
    const workspacePath = path.join(tempRoot, "pending-readiness-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
      objective: {
        summary: "build the best possible premium food landing page",
        acceptanceCriteria: ["clarified", "single_target_project_readiness"],
      },
      feedback: {
        pendingResearchRefresh: true,
      },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the premium landing page is already live on main and tests pass",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: Premium landing page is live on main.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified build, lint, and release checks passed for the premium landing page.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.OPEN);
    assert.ok(report.blockers.includes("project_readiness_unverified"));
  });

  it("keeps readiness open when only one saturated research sample exists", async () => {
    const workspacePath = path.join(tempRoot, "single-sample-readiness-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
      objective: {
        summary: "build the best possible premium food landing page",
        acceptanceCriteria: ["clarified", "single_target_project_readiness"],
      },
      feedback: {
        pendingResearchRefresh: false,
      },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the premium landing page is already live on main and tests pass",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: Premium landing page is live on main.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified build, lint, and release checks passed for the premium landing page.",
    ].join("\n"), "utf8");
    await writeResearchState(config, session, {
      refreshRecommended: false,
      coveragePassed: true,
      sourceCount: 8,
      completedPairs: 3,
      totalPairs: 3,
      scoutAt: "2026-04-19T08:00:00.000Z",
      synthAt: "2026-04-19T08:01:00.000Z",
    });

    const report = await evaluateTargetSuccessContract(config, session);
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.OPEN);
    assert.equal(report.dimensions.researchSaturation.status, "missing");
    assert.equal(report.dimensions.researchSaturation.evidence.historyEnough, false);
  });

  it("marks the contract fulfilled when scoped research saturation is stable across multiple cycles", async () => {
    const workspacePath = path.join(tempRoot, "ready-research-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
      objective: {
        summary: "build the best possible premium food landing page",
        acceptanceCriteria: ["clarified", "single_target_project_readiness"],
      },
      feedback: {
        pendingResearchRefresh: false,
      },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the premium landing page is already live on main and tests pass",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: Premium landing page is live on main.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified build, lint, and release checks passed for the premium landing page.",
    ].join("\n"), "utf8");

    await seedProjectReadinessLedger(config, session, [
      {
        refreshRecommended: false,
        coveragePassed: true,
        sourceCount: 8,
        completedPairs: 3,
        totalPairs: 3,
        scoutAt: "2026-04-19T08:00:00.000Z",
        synthAt: "2026-04-19T08:01:00.000Z",
      },
      {
        refreshRecommended: false,
        coveragePassed: true,
        sourceCount: 8,
        completedPairs: 3,
        totalPairs: 3,
        scoutAt: "2026-04-19T09:00:00.000Z",
        synthAt: "2026-04-19T09:01:00.000Z",
      },
      {
        refreshRecommended: false,
        coveragePassed: true,
        sourceCount: 8,
        completedPairs: 3,
        totalPairs: 3,
        scoutAt: "2026-04-19T10:00:00.000Z",
        synthAt: "2026-04-19T10:01:00.000Z",
      },
    ]);

    const report = await evaluateTargetSuccessContract(config, session);
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED);
    assert.equal(report.dimensions.projectReadiness.status, "satisfied");
    assert.equal(report.dimensions.researchSaturation.status, "satisfied");
    assert.equal(report.dimensions.researchSaturation.evidence.historyEnough, true);
  });

  it("does not auto-fulfill a fresh existing-repo session from already-merged evidence", async () => {
    const session = {
      ...buildSession(),
      repoProfile: { repoState: "existing" },
      intent: {
        summary: "upgrade the existing repo",
        repoState: "existing",
        scopeIn: ["premium upgrade"],
        mustHaveFlows: [],
      },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the requested work is already merged on main and verified",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session),
      "DELIVERED: Premium to-do app is live on main.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the requested product state and release checks passed.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);

    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.OPEN);
    assert.ok(report.blockers.includes("delivery_evidence_missing"));
    assert.equal(report.dimensions.delivery.evidence.repoRequiresFreshWork, true);
  });

  it("ignores stale worker evidence from a different target repo", async () => {
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      "TASK: verify already-merged app on dogducaner66-byte/TestRepoForSingleTargetMode",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main for dogducaner66-byte/TestRepoForSingleTargetMode and current main passes build lint and targeted tests",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app for dogducaner66-byte/TestRepoForSingleTargetMode and all six release checks passed without requiring new changes.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, {
      ...buildSession(),
      projectId: "target_testrepoforsingletargetmodecomplextodo",
      sessionId: "sess_test_002",
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/TestRepoForSingleTargetModeComplexTodo.git",
        repoFullName: "dogducaner66-byte/TestRepoForSingleTargetModeComplexTodo",
        name: "TestRepoForSingleTargetModeComplexTodo",
      },
      objective: {
        summary: "build a more complex to-do app",
        acceptanceCriteria: ["clarified", "planning-ready"],
      },
      intent: {
        summary: "goal=complex to-do app | success=Strong design polish",
        scopeIn: ["complex to-do app"],
        mustHaveFlows: ["complex to-do app"],
        preferredQualityBar: "Strong design polish",
      },
    });

    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.OPEN);
    assert.ok(report.blockers.includes("delivery_evidence_missing"));
    assert.ok(report.blockers.includes("release_signoff_missing"));
    assert.equal(report.dimensions.evidenceAlignment.evidence.evolutionEvidenceAligned, false);
    assert.equal(report.dimensions.evidenceAlignment.evidence.qualityEvidenceAligned, false);
  });

  it("uses aligned non-evolution worker evidence when the global evolution debug file is stale", async () => {
    const session = {
      ...buildSession(),
      projectId: "target_wheatherappbox",
      sessionId: "sess_weather_001",
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/wheatherappbox.git",
        repoFullName: "dogducaner66-byte/wheatherappbox",
        name: "wheatherappbox",
      },
      workspace: { path: path.join(tempRoot, "weather-workspace") },
      objective: {
        summary: "Build the best possible premium weather app with polished forecasts and search.",
        acceptanceCriteria: ["clarified", "planning-ready"],
      },
      intent: {
        summary: "goal=premium weather app | success=Strong design polish",
        scopeIn: ["premium weather app", "hourly forecast", "location search"],
        mustHaveFlows: ["premium weather app"],
        preferredQualityBar: "Strong design polish",
      },
      handoff: {
        requiredHumanInputs: ["Choose the main priority so BOX can optimize the first build correctly."],
        carriedContextSummary: "Target delivery is active.",
      },
    };

    await fs.mkdir(session.workspace.path, { recursive: true });
    await fs.writeFile(path.join(session.workspace.path, "index.html"), "<html><body>weather</body></html>", "utf8");

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(buildSession()),
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=c57d721d85217ef03fd5b4b8bffeb59ba43d5b9a",
      "BOX_ACTUAL_OUTCOME=Delivered old todo app work for a different session.",
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_integration-worker.txt"), [
      buildStampedWorkerHeader(session, session.workspace.path),
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/dogducaner66-byte/wheatherappbox/pull/3",
      "BOX_MERGED_SHA=a0cfecd041b3dbdb6414c751744845f66542aa01",
      "BOX_EXPECTED_OUTCOME=Land the premium weather app foundation and interaction surface.",
      "BOX_ACTUAL_OUTCOME=Delivered the premium weather app search, saved-city controls, and app foundation through a merged PR and left main clean.",
    ].join("\n"), "utf8");

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, session.workspace.path),
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/dogducaner66-byte/wheatherappbox/pull/7",
      "BOX_MERGED_SHA=9063b0c01655947559e68baa5ead84245519f5d5",
      "BOX_EXPECTED_OUTCOME=Validate the weather app release gates.",
      "BOX_ACTUAL_OUTCOME=Verified the weather app release checks passed and all gates are green.",
      "DELIVERED: Weather app is live on main. Open index.html in the session workspace.",
      "I ran npm test, npm run lint, and npm run build.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);

    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED);
    assert.equal(report.dimensions.delivery.evidence.mergedSha, "a0cfecd041b3dbdb6414c751744845f66542aa01");
    assert.deepEqual(report.dimensions.evidenceAlignment.evidence.alignedRoles, [
      "global:integration-worker",
      "global:quality-worker",
    ]);
  });

  it("prefers session-scoped worker evidence over stale global debug files", async () => {
    const session = {
      ...buildSession(),
      projectId: "target_wheatherappbox",
      sessionId: "sess_weather_002",
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/wheatherappbox.git",
        repoFullName: "dogducaner66-byte/wheatherappbox",
        name: "wheatherappbox",
      },
      workspace: { path: path.join(tempRoot, "weather-workspace-2") },
      objective: {
        summary: "Build the best possible premium weather app.",
        acceptanceCriteria: ["clarified", "planning-ready"],
      },
      intent: {
        summary: "goal=premium weather app | success=Strong design polish",
        scopeIn: ["premium weather app"],
        mustHaveFlows: ["premium weather app"],
        preferredQualityBar: "Strong design polish",
      },
      handoff: {
        requiredHumanInputs: ["Choose the main priority so BOX can optimize the first build correctly."],
        carriedContextSummary: "Target delivery is active.",
      },
    };

    await fs.mkdir(session.workspace.path, { recursive: true });
    await fs.writeFile(path.join(session.workspace.path, "index.html"), "<html><body>weather</body></html>", "utf8");

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(buildSession()),
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=c57d721d85217ef03fd5b4b8bffeb59ba43d5b9a",
      "BOX_ACTUAL_OUTCOME=Stale unrelated global worker evidence.",
    ].join("\n"), "utf8");

    const sessionEvidenceDir = path.join(
      config.paths.stateDir,
      "projects",
      session.projectId,
      session.sessionId,
      "worker_evidence",
    );
    await fs.mkdir(sessionEvidenceDir, { recursive: true });
    await fs.writeFile(path.join(sessionEvidenceDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, session.workspace.path),
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/dogducaner66-byte/wheatherappbox/pull/7",
      "BOX_MERGED_SHA=9063b0c01655947559e68baa5ead84245519f5d5",
      "BOX_ACTUAL_OUTCOME=Verified the weather app release checks passed and all gates are green.",
      "DELIVERED: Weather app is live on main.",
      "I ran npm test, npm run lint, and npm run build.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);

    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED);
    assert.deepEqual(report.dimensions.evidenceAlignment.evidence.alignedRoles, ["session:quality-worker"]);
  });

  it("records delivery handoff and uses the presenter-selected local target", async () => {
    const workspacePath = path.join(tempRoot, "delivered-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const indexPath = path.join(workspacePath, "index.html");
    await fs.writeFile(indexPath, "<html><body>todo</body></html>", "utf8");
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
    };
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app and all six release checks passed without requiring new changes.",
    ].join("\n"), "utf8");
    const report = await evaluateTargetSuccessContract(config, session);

    const targets: string[] = [];
    const handoff = await performTargetDeliveryHandoff(config, report, {
      forceAutoOpen: true,
      resolvePresentation: async () => ({
        status: "ready_to_open",
        locationType: "local_path",
        primaryLocation: indexPath,
        openTarget: indexPath,
        preserveWorkspace: true,
        instructions: [`Open ${indexPath}.`],
        userMessage: "Product ready in the local workspace.",
      }),
      openTarget: async (target: string) => {
        targets.push(target);
        return { attempted: true, opened: true, reason: null };
      },
    });

    assert.deepEqual(targets, [indexPath]);
    assert.equal(handoff.autoOpen.opened, true);
    assert.equal(handoff.delivery.primaryLocation, indexPath);
    assert.equal(handoff.delivery.preserveWorkspace, true);
  });

  it("keeps the local preview as the handoff target when a presenter only documents the workspace", async () => {
    const workspacePath = path.join(tempRoot, "delivered-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
    };
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app and all six release checks passed without requiring new changes.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);

    const handoff = await performTargetDeliveryHandoff(config, report, {
      resolvePresentation: async () => ({
        status: "documented",
        locationType: "workspace",
        primaryLocation: workspacePath,
        openTarget: null,
        preserveWorkspace: false,
        instructions: [`Inspect workspace at ${workspacePath}.`],
        userMessage: "Workspace preserved only for manual inspection is not required.",
      }),
    });

    assert.equal(handoff.delivery.locationType, "local_path");
    assert.equal(handoff.delivery.autoOpenEligible, true);
    assert.equal(handoff.delivery.openTarget, path.join(workspacePath, "index.html"));
  });

  it("prefers the local product preview when the presenter tries to redirect fulfilled delivery to a PR", async () => {
    const workspacePath = path.join(tempRoot, "delivered-workspace-preview-first");
    await fs.mkdir(workspacePath, { recursive: true });
    const indexPath = path.join(workspacePath, "index.html");
    await fs.writeFile(indexPath, "<html><body>preview</body></html>", "utf8");
    const session = {
      ...buildSession(),
      projectId: "target_wheatherappbox",
      sessionId: "sess_weather_preview_first",
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/wheatherappbox.git",
        repoFullName: "dogducaner66-byte/wheatherappbox",
        name: "wheatherappbox",
      },
      workspace: { path: workspacePath },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_integration-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/dogducaner66-byte/wheatherappbox/pull/3",
      "BOX_MERGED_SHA=a0cfecd041b3dbdb6414c751744845f66542aa01",
      "BOX_ACTUAL_OUTCOME=Delivered the premium weather app search and interaction surface.",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=done",
      "BOX_PR_URL=https://github.com/dogducaner66-byte/wheatherappbox/pull/7",
      "BOX_MERGED_SHA=9063b0c01655947559e68baa5ead84245519f5d5",
      "BOX_ACTUAL_OUTCOME=Verified the weather app release checks passed and all gates are green.",
      "DELIVERED: Weather app is live on main. Open index.html in the session workspace.",
      "I ran npm test, npm run lint, and npm run build.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);
    const targets: string[] = [];
    const handoff = await performTargetDeliveryHandoff(config, report, {
      forceAutoOpen: true,
      resolvePresentation: async () => ({
        status: "documented",
        locationType: "repo",
        primaryLocation: "https://github.com/dogducaner66-byte/wheatherappbox",
        openTarget: "https://github.com/dogducaner66-byte/wheatherappbox/pull/7",
        preserveWorkspace: false,
        instructions: ["Open PR #7 to review the final packet."],
        userMessage: "Review PR #7 for final delivery details.",
      }),
      openTarget: async (target: string) => {
        targets.push(target);
        return { attempted: true, opened: true, reason: null };
      },
    });

    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED);
    assert.deepEqual(targets, [indexPath]);
    assert.equal(handoff.delivery.locationType, "local_path");
    assert.equal(handoff.delivery.openTarget, indexPath);
    assert.equal(handoff.delivery.preserveWorkspace, true);
    assert.equal(handoff.delivery.resolutionSource, "product_presenter_ai_preview_overridden");
  });

  it("does not auto-open the browser during handoff unless explicitly enabled", async () => {
    const workspacePath = path.join(tempRoot, "delivered-workspace-no-auto-open");
    await fs.mkdir(workspacePath, { recursive: true });
    const indexPath = path.join(workspacePath, "index.html");
    await fs.writeFile(indexPath, "<html><body>todo</body></html>", "utf8");
    const session = {
      ...buildSession(),
      workspace: { path: workspacePath },
    };
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app and all six release checks passed without requiring new changes.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);
    const targets: string[] = [];
    const handoff = await performTargetDeliveryHandoff(config, report, {
      resolvePresentation: async () => ({
        status: "ready_to_open",
        locationType: "local_path",
        primaryLocation: indexPath,
        openTarget: indexPath,
        preserveWorkspace: true,
        instructions: ["Inspect the local preview manually."],
        userMessage: "Product ready in the local workspace.",
      }),
      openTarget: async (target: string) => {
        targets.push(target);
        return { attempted: true, opened: true, reason: null };
      },
    });

    assert.deepEqual(targets, []);
    assert.equal(handoff.autoOpen.attempted, false);
    assert.equal(handoff.autoOpen.reason, "auto_open_disabled");
    assert.equal(handoff.delivery.openTarget, indexPath);
  });

  it("uses an explicit deployed preview URL as the conservative fallback", async () => {
    const session = {
      ...buildSession(),
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/TestRepoForSingleTargetMode.git",
        repoFullName: "dogducaner66-byte/TestRepoForSingleTargetMode",
        name: "TestRepoForSingleTargetMode",
      },
      workspace: { path: path.join(tempRoot, "missing-workspace") },
    };
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session),
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=the simple to-do list app delivery is already merged on main and verified on main",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session),
      "DELIVERED: Simple to-do list app is live at https://acme-demo.vercel.app and ready to use.",
      "BOX_STATUS=skipped",
      "BOX_SKIP_REASON=already-merged-on-main",
      "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
      "BOX_ACTUAL_OUTCOME=Verified the simple to-do list app release checks passed and preview is available at https://acme-demo.vercel.app .",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);

    const handoff = await performTargetDeliveryHandoff(config, report, {
      resolvePresentation: async () => {
        throw new Error("agent unavailable");
      },
    });

    assert.equal(handoff.delivery.locationType, "url");
    assert.equal(handoff.delivery.autoOpenEligible, true);
    assert.equal(handoff.delivery.openTarget, "https://acme-demo.vercel.app");
  });

  it("marks an existing-repo session fulfilled_with_handoff when merged delivery and local release verification evidence exist", async () => {
    const workspacePath = path.join(tempRoot, "premium-delivered-workspace");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "index.html"), "<html><body>premium todo</body></html>", "utf8");
    const session = {
      ...buildSession(),
      objective: {
        summary: "upgrade the existing basic todo app into the strongest personal todo product",
        acceptanceCriteria: ["clarified", "planning-ready"],
      },
      repoProfile: { repoState: "existing" },
      intent: {
        summary: "goal=premium personal todo app | success=design looks production-ready and tests are green",
        repoState: "existing",
        scopeIn: ["premium personal todo app", "ordering and bulk actions", "accessibility", "reliable persistence"],
        mustHaveFlows: [],
        preferredQualityBar: null,
      },
      handoff: {
        requiredHumanInputs: ["What outcome would make you say the target work is correct?"],
        carriedContextSummary: "Target delivery is active.",
      },
      workspace: { path: workspacePath },
      repo: {
        repoUrl: "https://github.com/dogducaner66-byte/TestRepoForSingleTargetMode.git",
        repoFullName: "dogducaner66-byte/TestRepoForSingleTargetMode",
        name: "TestRepoForSingleTargetMode",
      },
    };

    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=c57d721d85217ef03fd5b4b8bffeb59ba43d5b9a",
      "BOX_EXPECTED_OUTCOME=Add full keyboard navigation and semantic accessibility coverage for add/edit/select/bulk/reorder/subtask todo flows.",
      "BOX_ACTUAL_OUTCOME=Delivered accessible bulk selection and reorder controls with live announcements, focus restoration, Escape/Enter contracts, and updated regression coverage.",
    ].join("\n"), "utf8");
    await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
      buildStampedWorkerHeader(session, workspacePath),
      "BOX_STATUS=done",
      "BOX_MERGED_SHA=886a51516055193f26bcb320114f4f283279a3ac",
      "BOX_EXPECTED_OUTCOME=Expand core QA coverage past 32 passing tests and replace placeholder guidance with real README plus a subtle in-app power-user hint.",
      "BOX_ACTUAL_OUTCOME=Expanded the core suite to 40 passing tests, added verified power-user hint UI, replaced README with real product/setup guidance, merged PR #13, and left main clean.",
      "I ran npm test, npm run lint, and npm run build.",
    ].join("\n"), "utf8");

    const report = await evaluateTargetSuccessContract(config, session);
    assert.equal(report.status, TARGET_SUCCESS_CONTRACT_STATUS.FULFILLED_WITH_HANDOFF);
    assert.ok(report.blockers.includes("human_input_pending"));
    assert.equal(report.dimensions.delivery.status, "satisfied");
    assert.equal(report.dimensions.releaseVerification.status, "satisfied");
    assert.equal(report.delivery.locationType, "local_path");
    assert.equal(report.delivery.autoOpenEligible, true);
    assert.equal(report.delivery.openTarget, path.join(workspacePath, "index.html"));
  });
});