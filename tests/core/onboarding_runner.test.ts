import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTargetSession, getTargetBaselinePath, getTargetClarificationPacketPath, getTargetIntentContractPath, getTargetOnboardingReportPath, getTargetPrerequisiteStatusPath, getTargetRepoAnalysisPath, TARGET_SESSION_STAGE } from "../../src/core/target_session_state.js";
import { refreshTargetSessionReadiness, runTargetOnboarding, TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG, TARGET_ONBOARDING_AGENT_SLUG } from "../../src/core/onboarding_runner.js";

function buildConfig(tempRoot: string, env: Record<string, unknown> = {}) {
  return {
    paths: {
      stateDir: path.join(tempRoot, "state"),
      workspaceDir: path.join(tempRoot, ".box-work"),
    },
    env,
  };
}

function buildManifest(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl: "https://github.com/acme/portal.git",
    objective: {
      summary: "Evaluate repo readiness before execution",
      acceptanceCriteria: ["classified", "gated"],
    },
    constraints: {
      protectedPaths: ["infra/prod"],
      forbiddenActions: [],
    },
    operator: {
      requestedBy: "user",
      approvalMode: "human_required_for_high_risk",
    },
    ...overrides,
  };
}

function createBareRemoteRepo(tempRoot: string) {
  const remoteRepo = path.join(tempRoot, "remote-origin.git");
  const seedRepo = path.join(tempRoot, "seed-repo");

  execFileSync("git", ["init", "--bare", remoteRepo], { stdio: "pipe" });
  execFileSync("git", ["init", "-b", "main", seedRepo], { stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "BOX Test"], { cwd: seedRepo, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "box@example.com"], { cwd: seedRepo, stdio: "pipe" });
  execFileSync("git", ["remote", "add", "origin", remoteRepo], { cwd: seedRepo, stdio: "pipe" });

  return {
    remoteRepo,
    seedRepo,
  };
}

describe("onboarding_runner", () => {
  it("moves onboarding to awaiting_credentials when repo access credentials are missing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const config = buildConfig(tempRoot);
    const session = await createTargetSession(buildManifest(), config);

    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.readiness.status, "blocked");
    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_CREDENTIALS);
    assert.equal(result.report.agent.slug, TARGET_ONBOARDING_AGENT_SLUG);
    assert.equal(result.session.gates.allowPlanning, false);
    assert.ok(result.prerequisiteStatus.requiredNow.includes("github_repo_access_token"));
  });

  it("moves onboarding to awaiting_manual_step when workspace checkout is still missing", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const config = buildConfig(tempRoot, { githubToken: "token" });
    const missingLocalRepo = path.join(tempRoot, "missing-target-repo");
    const session = await createTargetSession(buildManifest({ localPath: missingLocalRepo }), config);

    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP);
    assert.equal(result.session.gates.allowPlanning, false);
    assert.ok(result.report.blockers.length > 0);
  });

  it("persists onboarding artifacts and routes existing repos into clarification before planning", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "src", "index.ts"), "export const ready = true;\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({
      name: "target-repo",
      scripts: {
        build: "npm run build",
        test: "npm run test",
      },
    }, null, 2));

    const config = buildConfig(tempRoot, { githubToken: "token" });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    const result = await runTargetOnboarding(config, session);

    const onboardingPath = getTargetOnboardingReportPath(config.paths.stateDir, session.projectId, session.sessionId);
    const prerequisitePath = getTargetPrerequisiteStatusPath(config.paths.stateDir, session.projectId, session.sessionId);
    const baselinePath = getTargetBaselinePath(config.paths.stateDir, session.projectId, session.sessionId);
    const repoAnalysisPath = getTargetRepoAnalysisPath(config.paths.stateDir, session.projectId, session.sessionId);
    const clarificationPacketPath = getTargetClarificationPacketPath(config.paths.stateDir, session.projectId, session.sessionId);
    const intentContractPath = getTargetIntentContractPath(config.paths.stateDir, session.projectId, session.sessionId);

    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(result.report.clarification.selectedAgentSlug, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG);
    assert.equal(result.report.repo.repoState, "existing");
    assert.equal(result.session.gates.allowPlanning, false);
    assert.equal(result.session.gates.allowShadowExecution, false);
    assert.equal(result.session.gates.allowActiveExecution, false);
    assert.equal(result.session.clarification.selectedAgentSlug, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG);
    await assert.doesNotReject(() => fs.access(onboardingPath));
    await assert.doesNotReject(() => fs.access(prerequisitePath));
    await assert.doesNotReject(() => fs.access(baselinePath));
    await assert.doesNotReject(() => fs.access(repoAnalysisPath));
    await assert.doesNotReject(() => fs.access(clarificationPacketPath));
    await assert.doesNotReject(() => fs.access(intentContractPath));
  });

  it("classifies progressive later credentials without blocking initial onboarding", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "prisma"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "src", "app.ts"), "export const app = 'portal';\n");
    await fs.writeFile(path.join(localRepo, "prisma", "schema.prisma"), "datasource db { provider = \"postgresql\" url = env(\"DATABASE_URL\") }\n");
    await fs.writeFile(path.join(localRepo, "vercel.json"), "{}\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({
      name: "target-repo",
      scripts: {
        build: "npm run build",
        test: "npm run test",
      },
    }, null, 2));

    const config = buildConfig(tempRoot, { githubToken: "token" });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.ok(result.prerequisiteStatus.requiredLater.includes("vercel_access_token"));
    assert.ok(result.prerequisiteStatus.requiredLater.includes("database_access_credentials"));
  });

  it("routes even strong existing repos into clarification so intent is explicit before planning", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "app"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "app", "page.tsx"), "export default function Page(){ return null; }\n");
    await fs.writeFile(path.join(localRepo, "tsconfig.json"), "{}\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({
      name: "target-repo",
      scripts: {
        build: "npm run build",
        test: "npm run test",
        lint: "npm run lint",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "15.0.0",
      },
    }, null, 2));

    const config = buildConfig(tempRoot, { githubToken: "token" });
    const session = await createTargetSession(buildManifest({ localPath: localRepo, constraints: { protectedPaths: [], forbiddenActions: [] } }), config);
    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.readiness.status, "clarification_required");
    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(result.report.clarification.selectedAgentSlug, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG);
    assert.equal(result.session.gates.allowPlanning, false);
    assert.equal(result.session.gates.allowShadowExecution, false);
    assert.equal(result.session.gates.allowActiveExecution, false);
  });

  it("continues through onboarding after remote bootstrap clones the target repo", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const { remoteRepo, seedRepo } = createBareRemoteRepo(tempRoot);
    await fs.mkdir(path.join(seedRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(seedRepo, "src", "index.ts"), "export const remote = true;\n");
    await fs.writeFile(path.join(seedRepo, "tsconfig.json"), "{}\n");
    await fs.writeFile(path.join(seedRepo, "package.json"), JSON.stringify({
      name: "remote-portal",
      scripts: {
        build: "npm run build",
        test: "npm run test",
        lint: "npm run lint",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "15.0.0",
      },
    }, null, 2));
    execFileSync("git", ["add", "."], { cwd: seedRepo, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "seed remote repo"], { cwd: seedRepo, stdio: "pipe" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seedRepo, stdio: "pipe" });

    const config = buildConfig(tempRoot);
    const session = await createTargetSession(buildManifest({
      target: {
        repoUrl: remoteRepo,
        defaultBranch: "main",
        provider: "unknown",
      },
      constraints: {
        protectedPaths: [],
        forbiddenActions: [],
      },
    }), config);
    const result = await runTargetOnboarding(config, session);

    assert.equal(result.session.workspace.bootstrap.status, "ready");
    assert.equal(result.report.readiness.status, "clarification_required");
    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(result.report.clarification.selectedAgentSlug, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG);
  });

  it("routes effectively empty repos into the empty-repo clarification agent", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "empty-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "README.md"), "# Empty target\n");
    await fs.writeFile(path.join(localRepo, ".gitignore"), "node_modules\n");

    const config = buildConfig(tempRoot, { githubToken: "token" });
    const session = await createTargetSession(buildManifest({ localPath: localRepo, constraints: { protectedPaths: [], forbiddenActions: [] } }), config);
    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.repo.repoState, "empty");
    assert.equal(result.report.readiness.recommendedNextStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(result.report.clarification.selectedAgentSlug, TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG);
    assert.equal(result.session.clarification.mode, "empty_repo");
    assert.ok(result.session.handoff.requiredHumanInputs.some((entry: string) => entry.includes(TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG)));
  });

  it("uses an agent-authored clarification packet when available", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "empty-target-repo-agent");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "README.md"), "# Empty target\n");

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      mockTargetOnboardingClarificationPacket: JSON.stringify({
        openingPrompt: "Clarify the engineering intent before planning.",
        questions: [
          {
            id: "project_identity",
            title: "What kind of engineering artifact should BOX build?",
            prompt: "Describe the kind of system you want in this repository.",
            answerMode: "hybrid",
            options: ["CLI tool", "Backend service", "Library", "Game engine", "Other"],
          },
        ],
      }),
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo, constraints: { protectedPaths: [], forbiddenActions: [] } }), config);
    const result = await runTargetOnboarding(config, session);

    assert.equal(result.report.clarification.questions[0].id, "project_identity");
    assert.equal(result.report.clarification.questions[0].title, "What kind of engineering artifact should BOX build?");
    assert.equal(result.session.clarification.pendingQuestions[0], "What kind of engineering artifact should BOX build?");
  });

  it("resumes the same session after credentials are provided", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const config = buildConfig(tempRoot);
    const session = await createTargetSession(buildManifest(), config);
    const blocked = await runTargetOnboarding(config, session);

    assert.equal(blocked.session.currentStage, TARGET_SESSION_STAGE.AWAITING_CREDENTIALS);

    config.env.githubToken = "token";
    await fs.mkdir(path.join(blocked.session.workspace.path, ".git"), { recursive: true });
    await fs.writeFile(path.join(blocked.session.workspace.path, "package.json"), JSON.stringify({
      name: "target-repo",
      scripts: {
        build: "npm run build",
        test: "npm run test",
      },
    }, null, 2));
    const resumed = await refreshTargetSessionReadiness(config, blocked.session);

    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.session.currentStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(resumed.session.gates.allowPlanning, false);
    assert.equal(resumed.session.clarification.selectedAgentSlug, TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG);
  });

  it("resumes the same session after the missing workspace material appears", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-onboarding-"));
    const localRepo = path.join(tempRoot, "target-repo-late");
    const config = buildConfig(tempRoot, { githubToken: "token" });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    const blocked = await runTargetOnboarding(config, session);

    assert.equal(blocked.session.currentStage, TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP);

    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "src", "late.ts"), "export const late = true;\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({
      name: "target-repo",
      scripts: {
        build: "npm run build",
        test: "npm run test",
      },
    }, null, 2));

    const resumed = await refreshTargetSessionReadiness(config, blocked.session);

    assert.equal(resumed.session.sessionId, session.sessionId);
    assert.equal(resumed.session.currentStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(resumed.session.workspace.prepared, true);
    assert.equal(resumed.session.clarification.selectedAgentSlug, TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG);
  });
});