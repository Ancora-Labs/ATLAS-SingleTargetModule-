import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildDirectDispatchAnalysisFromJanusDecision, runOnce } from "../../src/core/orchestrator.js";
import { PLATFORM_MODE, loadPlatformModeState } from "../../src/core/mode_state.js";
import { createTargetSession, saveActiveTargetSession } from "../../src/core/target_session_state.js";

describe("orchestrator startup chain fallback", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-startup-chain-"));

    config = {
      loopIntervalMs: 1000,
      maxParallelWorkers: 3,
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        // Force all Copilot agent calls (Janus/Prometheus/Athena) into deterministic fallback paths.
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        leadWorker: { name: "Athena", model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test: { name: "Samuel" }
        }
      },
      copilot: {
        leadershipAutopilot: false
      }
    };

    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns early and logs failure when leadership CLI is unavailable", async () => {
    await runOnce(config);

    // In the new architecture (Janus → Prometheus → Athena → Workers),
    // when the CLI binary is missing, Janus falls back to a deterministic decision
    // and then Prometheus also fails — no athena plan review file is created.
    const reviewPath = path.join(tmpDir, "athena_plan_review.json");
    const reviewExists = await fs.access(reviewPath).then(() => true).catch(() => false);
    assert.equal(reviewExists, false);

    const progress = await fs.readFile(config.paths.progressFile, "utf8");
    // Janus AI call fails but returns deterministic fallback, then Prometheus fails
    assert.ok(progress.includes("[JANUS]"));
    assert.ok(progress.includes("[CYCLE]"));
  });
});

describe("orchestrator — direct dispatch from Janus directive", () => {
  it("synthesizes quality-only plans without requiring Prometheus", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-direct-dispatch-"));
    const config = {
      paths: { stateDir, repoRoot: stateDir },
      env: { targetRepo: "dogducaner66-byte/TestRepoForSingleTargetMode" },
      platformModeState: { currentMode: "single_target_delivery" },
      activeTargetSession: {
        projectId: "target_testrepoforsingletargetmode",
        sessionId: "sess_test",
        currentStage: "active",
        repo: { repoUrl: "https://github.com/dogducaner66-byte/TestRepoForSingleTargetMode.git" },
      },
    } as any;

    try {
      const analysis = await buildDirectDispatchAnalysisFromJanusDecision(config, {
        callPrometheus: false,
        workItems: [
          {
            task: "Issue formal release sign-off for the delivered to-do app on main. Read index.html, style.css, app.js, README.md and confirm the app is ready for personal use.",
            taskKind: "qa",
            priority: 1,
            reason: "Final release sign-off only.",
            context: "Main already contains the delivered app.",
          },
        ],
      });

      assert.equal(analysis.directDispatch, true);
      assert.equal(analysis.plans.length, 1);
      assert.equal(analysis.plans[0].role, "quality-worker");
      assert.equal(analysis.plans[0].taskKind, "qa");
      assert.deepEqual(analysis.plans[0].target_files, ["index.html", "style.css", "app.js", "README.md"]);
      assert.ok(Array.isArray(analysis.plans[0].acceptance_criteria) && analysis.plans[0].acceptance_criteria.length > 0);
      assert.ok(String(analysis.plans[0].verification || "").length > 0);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

describe("orchestrator — fulfilled target short-circuit", () => {
  it("archives a fulfilled target before Janus spends a premium request", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-fulfilled-short-circuit-"));
    const config = {
      loopIntervalMs: 1000,
      maxParallelWorkers: 3,
      rootDir: tmpDir,
      paths: {
        stateDir: path.join(tmpDir, "state"),
        workspaceDir: path.join(tmpDir, ".box-work"),
        progressFile: path.join(tmpDir, "state", "progress.txt"),
        policyFile: path.join(tmpDir, "state", "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "dogducaner66-byte/TestRepoForSingleTargetMode",
        githubToken: "test-github-token",
        copilotGithubToken: "test-copilot-token",
      },
      selfDev: {
        futureModeFlags: {
          singleTargetDelivery: true,
          targetSessionState: true,
          targetWorkspaceLifecycle: true,
        },
      },
      roleRegistry: {
        ceoSupervisor: { name: "Janus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        leadWorker: { name: "Athena", model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test: { name: "Samuel" }
        }
      },
      copilot: {
        leadershipAutopilot: false
      }
    } as any;

    try {
      await fs.mkdir(config.paths.stateDir, { recursive: true });
      await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");

      const session = await createTargetSession({
        mode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        requestId: "req_target_001",
        target: {
          repoUrl: "https://github.com/dogducaner66-byte/TestRepoForSingleTargetMode.git",
          defaultBranch: "main",
          provider: "github",
        },
        objective: {
          summary: "i want simple to do list app",
          desiredOutcome: "completed working to-do app",
          acceptanceCriteria: ["clarified", "planning-ready"],
        },
      }, config);

      const workspacePath = session.workspace.path;
      await fs.mkdir(workspacePath, { recursive: true });
      await fs.writeFile(path.join(workspacePath, "index.html"), "<html><body>todo</body></html>", "utf8");
      await saveActiveTargetSession(config, {
        ...session,
        currentStage: "active",
        workspace: {
          ...session.workspace,
          path: workspacePath,
          prepared: true,
        },
        intent: {
          ...session.intent,
          preferredQualityBar: "Fast MVP, simple clean UI, add complete delete task flow first",
          mustHaveFlows: ["has to be a completed, working project"],
          scopeIn: ["i want simple to do list app", "has to be a completed, working project"],
        },
      });
      await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_evolution-worker.txt"), [
        "BOX_STATUS=skipped",
        "BOX_SKIP_REASON=already-merged",
        "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
        "BOX_ACTUAL_OUTCOME=the app was already merged on main, and current main passes build, lint, and targeted todo app tests without further edits",
      ].join("\n"), "utf8");
      await fs.writeFile(path.join(config.paths.stateDir, "debug_worker_quality-worker.txt"), [
        "DELIVERED: To-do list app is live on main. Open index.html in any browser. No build step. Session ready to close.",
        "BOX_STATUS=skipped",
        "BOX_SKIP_REASON=already-merged-on-main",
        "BOX_MERGED_SHA=8ac7ee06035bb0273801dcb4baa4c72d090b6460",
        "BOX_ACTUAL_OUTCOME=Verified live main already contains the simple to-do list app and all six release checks passed without requiring new changes.",
      ].join("\n"), "utf8");

      await runOnce(config);

      const progress = await fs.readFile(config.paths.progressFile, "utf8");
      const modeState = await loadPlatformModeState(config);
      assert.ok(progress.includes("[TARGET_DELIVERY]"));
      assert.ok(progress.includes("skipped planning and worker dispatch via success-contract=fulfilled"));
      assert.ok(!progress.includes("agent=janus reason=cycle_directive"));
      assert.equal(modeState.currentMode, PLATFORM_MODE.IDLE);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

