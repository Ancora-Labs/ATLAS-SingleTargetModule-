import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTargetSession, TARGET_INTENT_STATUS, TARGET_SESSION_STAGE } from "../../src/core/target_session_state.js";
import { runTargetOnboarding } from "../../src/core/onboarding_runner.js";
import { getTargetClarificationRuntimeState, submitTargetClarificationAnswer } from "../../src/core/clarification_runtime.js";

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
      summary: "Clarify the target before planning",
      acceptanceCriteria: ["clarified", "planning-ready"],
    },
    constraints: {
      protectedPaths: [],
      forbiddenActions: [],
    },
    operator: {
      requestedBy: "user",
      approvalMode: "human_required_for_high_risk",
    },
    ...overrides,
  };
}

describe("clarification_runtime", () => {
  it("records transcript turns and promotes empty-repo clarification into shadow planning", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-"));
    const localRepo = path.join(tempRoot, "empty-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "README.md"), "# Empty target\n");

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      copilotCliCommand: "__missing_copilot_binary__",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    const initialRuntime = await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    assert.equal(initialRuntime.currentQuestion.id, "product_goal");

    await submitTargetClarificationAnswer(config, {
      answerText: "Business website for a fish restaurant with menu and booking pages",
    });
    await submitTargetClarificationAnswer(config, {
      answerText: "Restaurant guests and staff who manage reservations",
      selectedOptions: ["Restaurant guests"],
    });
    await submitTargetClarificationAnswer(config, {
      selectedOptions: ["Homepage", "Booking flow", "Content management"],
      answerText: "Homepage, booking flow, and content editing must exist in v1",
    });
    const finalResult = await submitTargetClarificationAnswer(config, {
      selectedOptions: ["Business conversion"],
    });

    assert.equal(finalResult.readyForPlanning, true);
    assert.equal(finalResult.session.currentStage, TARGET_SESSION_STAGE.SHADOW);
    assert.equal(finalResult.session.clarification.status, "completed");
    assert.equal(finalResult.session.intent.status, TARGET_INTENT_STATUS.READY_FOR_PLANNING);
    assert.equal(finalResult.session.gates.allowPlanning, true);
    assert.equal(finalResult.session.gates.allowShadowExecution, true);
    assert.equal(finalResult.session.gates.allowActiveExecution, false);
    assert.match(String(finalResult.session.intent.summary || ""), /fish restaurant/i);
    assert.ok(Array.isArray(finalResult.transcript.turns));
    assert.ok(finalResult.transcript.turns.length >= 8);
  });

  it("asks an immediate follow-up when a clarification answer is too vague", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-"));
    const localRepo = path.join(tempRoot, "existing-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "src", "index.ts"), "export const ready = true;\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({ name: "target-repo" }, null, 2));

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      copilotCliCommand: "__missing_copilot_binary__",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    const initialRuntime = await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    assert.equal(initialRuntime.currentQuestion.id, "repo_purpose_confirmation");

    const result = await submitTargetClarificationAnswer(config, {
      answerText: "site",
      questionId: "repo_purpose_confirmation",
    });

    assert.equal(result.readyForPlanning, false);
    assert.equal(result.session.currentStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(String(result.currentQuestion?.id || "").startsWith("follow_up_repo_purpose_confirmation_"), true);
    assert.ok(result.session.intent.openQuestions.some((entry: string) => entry.includes("Follow-up for")));
  });

  it("asks for custom detail when Other is selected without any explanation", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-other-"));
    const localRepo = path.join(tempRoot, "empty-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "README.md"), "# Empty target\n");

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      copilotCliCommand: "__missing_copilot_binary__",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    const result = await submitTargetClarificationAnswer(config, {
      questionId: "product_goal",
      selectedOptions: ["Other"],
    });

    assert.equal(result.readyForPlanning, false);
    assert.equal(result.session.currentStage, TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION);
    assert.equal(String(result.currentQuestion?.id || "").startsWith("follow_up_product_goal_"), true);
  });

  it("keeps clarification fail-closed in shadow when no agent mode decision is available", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-simple-"));
    const localRepo = path.join(tempRoot, "existing-simple-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.mkdir(path.join(localRepo, "src"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "index.html"), "<main>Home</main>\n");
    await fs.writeFile(path.join(localRepo, "style.css"), "body { margin: 0; }\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({ name: "simple-target" }, null, 2));

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      copilotCliCommand: "__missing_copilot_binary__",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    await submitTargetClarificationAnswer(config, {
      questionId: "repo_purpose_confirmation",
      answerText: "Marketing site for a local business",
      selectedOptions: ["Marketing site"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "target_users",
      answerText: "Customers browsing the homepage",
      selectedOptions: ["Customers"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "requested_change",
      answerText: "Refresh the homepage hero copy and CTA styling only.",
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "protected_areas",
      answerText: "none",
    });
    const finalResult = await submitTargetClarificationAnswer(config, {
      questionId: "success_signal",
      answerText: "Homepage still renders correctly and tests stay green.",
    });

    assert.equal(finalResult.readyForPlanning, true);
    assert.equal(finalResult.session.currentStage, TARGET_SESSION_STAGE.SHADOW);
    assert.equal(finalResult.session.intent.planningMode, "shadow");
    assert.equal(finalResult.session.gates.allowPlanning, true);
    assert.equal(finalResult.session.gates.allowShadowExecution, true);
    assert.equal(finalResult.session.gates.allowActiveExecution, false);
    assert.equal(finalResult.session.handoff.nextAction, "run_shadow_planning");
  });

  it("honors an agent-authored delivery mode decision without any heuristic fallback", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-agent-route-"));
    const localRepo = path.join(tempRoot, "existing-agent-routed-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "index.html"), "<main>Home</main>\n");
    await fs.writeFile(path.join(localRepo, "style.css"), "body { margin: 0; }\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({ name: "agent-routed-target" }, null, 2));

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      mockClarificationDeliveryModeDecision: "shadow",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    await submitTargetClarificationAnswer(config, {
      questionId: "repo_purpose_confirmation",
      answerText: "Marketing site for a local business",
      selectedOptions: ["Marketing site"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "target_users",
      answerText: "Customers browsing the homepage",
      selectedOptions: ["Customers"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "requested_change",
      answerText: "Refresh the homepage hero copy and CTA styling only.",
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "protected_areas",
      answerText: "none",
    });

    const finalResult = await submitTargetClarificationAnswer(config, {
      questionId: "success_signal",
      answerText: "Homepage still renders correctly and tests stay green.",
    });

    assert.equal(finalResult.readyForPlanning, true);
    assert.equal(finalResult.session.currentStage, TARGET_SESSION_STAGE.SHADOW);
    assert.equal(finalResult.session.intent.planningMode, "shadow");
    assert.equal(finalResult.session.gates.allowShadowExecution, true);
    assert.equal(finalResult.session.gates.allowActiveExecution, false);
    assert.equal(finalResult.intentContract.deliveryModeDecision?.recommendation, "shadow");
    assert.equal(finalResult.intentContract.deliveryModeDecision?.source, "onboarding-existing-repo");
  });

  it("opens directly in active mode when the selected onboarding agent decides active", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "box-clarification-agent-active-"));
    const localRepo = path.join(tempRoot, "existing-agent-active-target-repo");
    await fs.mkdir(path.join(localRepo, ".git"), { recursive: true });
    await fs.writeFile(path.join(localRepo, "index.html"), "<main>Portal</main>\n");
    await fs.writeFile(path.join(localRepo, "style.css"), "body { color: #111; }\n");
    await fs.writeFile(path.join(localRepo, "package.json"), JSON.stringify({ name: "agent-active-target" }, null, 2));

    const config = buildConfig(tempRoot, {
      githubToken: "token",
      mockClarificationDeliveryModeDecision: "active",
    });
    const session = await createTargetSession(buildManifest({ localPath: localRepo }), config);
    await runTargetOnboarding(config, session);

    await getTargetClarificationRuntimeState(config, { persistPrompt: true });
    await submitTargetClarificationAnswer(config, {
      questionId: "repo_purpose_confirmation",
      answerText: "SaaS app with multiple admin workflows",
      selectedOptions: ["SaaS app"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "target_users",
      answerText: "Admins and staff",
      selectedOptions: ["Admins/staff"],
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "requested_change",
      answerText: "Add dashboard analytics and admin filters for internal operations.",
    });
    await submitTargetClarificationAnswer(config, {
      questionId: "protected_areas",
      answerText: "none",
    });
    const finalResult = await submitTargetClarificationAnswer(config, {
      questionId: "success_signal",
      answerText: "Admins can use the new dashboard without regressions.",
    });

    assert.equal(finalResult.readyForPlanning, true);
    assert.equal(finalResult.session.currentStage, TARGET_SESSION_STAGE.ACTIVE);
    assert.equal(finalResult.session.intent.planningMode, "active");
    assert.equal(finalResult.session.gates.allowPlanning, true);
    assert.equal(finalResult.session.gates.allowShadowExecution, false);
    assert.equal(finalResult.session.gates.allowActiveExecution, true);
    assert.equal(finalResult.intentContract.deliveryModeDecision?.recommendation, "active");
  });
});