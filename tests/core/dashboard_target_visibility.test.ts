import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveTargetRuntimeView } from "../../src/dashboard/live_dashboard.ts";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";

describe("dashboard target runtime visibility", () => {
  it("surfaces self_dev mode clearly when no target session is active", () => {
    const runtime = deriveTargetRuntimeView({
      platformModeState: {
        currentMode: PLATFORM_MODE.SELF_DEV,
        fallbackModeAfterCompletion: PLATFORM_MODE.SELF_DEV,
      },
      activeTargetSession: null,
      rootDir: "C:/box",
    });

    assert.equal(runtime.currentMode, PLATFORM_MODE.SELF_DEV);
    assert.equal(runtime.hasActiveTargetSession, false);
    assert.equal(runtime.canOpenNewSession, true);
    assert.equal(runtime.executionWorkspacePath, "C:/box");
    assert.equal(runtime.waitingReason, "BOX is operating in self_dev mode.");
  });

  it("surfaces waiting reason and blockers for awaiting_credentials target sessions", () => {
    const runtime = deriveTargetRuntimeView({
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        fallbackModeAfterCompletion: PLATFORM_MODE.SELF_DEV,
      },
      activeTargetSession: {
        projectId: "target_portal",
        sessionId: "sess_123",
        currentStage: "awaiting_credentials",
        repo: {
          repoUrl: "https://github.com/acme/portal.git",
          name: "portal",
        },
        objective: {
          summary: "Stabilize CI and auth flow",
        },
        prerequisites: {
          blockedReason: "Missing package registry token",
          missing: ["NPM_TOKEN"],
          requiredNow: ["NPM_TOKEN"],
        },
        handoff: {
          requiredHumanInputs: ["Provide package registry token"],
        },
        workspace: {
          path: "C:/box/.box-work/targets/portal/sess_123",
          bootstrap: {
            status: "awaiting_credentials",
            strategy: "git_clone",
            lastError: "Missing package registry token",
          },
        },
      },
      rootDir: "C:/box",
    });

    assert.equal(runtime.currentMode, PLATFORM_MODE.SINGLE_TARGET_DELIVERY);
    assert.equal(runtime.stage, "awaiting_credentials");
    assert.equal(runtime.targetWorkspacePath, "C:/box/.box-work/targets/portal/sess_123");
    assert.equal(runtime.executionWorkspacePath, "C:/box/.box-work/targets/portal/sess_123");
    assert.equal(runtime.bootstrapStatus, "awaiting_credentials");
    assert.equal(runtime.bootstrapStrategy, "git_clone");
    assert.equal(runtime.bootstrapLastError, "Missing package registry token");
    assert.ok(runtime.blockers.includes("Missing package registry token"));
    assert.equal(runtime.waitingReason, "Missing package registry token");
  });

  it("flags missing active target session when single target mode is set without session truth", () => {
    const runtime = deriveTargetRuntimeView({
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        fallbackModeAfterCompletion: PLATFORM_MODE.IDLE,
      },
      activeTargetSession: null,
      rootDir: "C:/box",
    });

    assert.equal(runtime.currentMode, PLATFORM_MODE.SINGLE_TARGET_DELIVERY);
    assert.equal(runtime.hasActiveTargetSession, false);
    assert.equal(runtime.waitingReason, "single_target_delivery is active but no active target session is loaded.");
    assert.equal(runtime.fallbackModeAfterCompletion, PLATFORM_MODE.IDLE);
  });

  it("surfaces clarification waiting reason when onboarding has routed into intent clarification", () => {
    const runtime = deriveTargetRuntimeView({
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        fallbackModeAfterCompletion: PLATFORM_MODE.SELF_DEV,
      },
      activeTargetSession: {
        projectId: "target_restaurant",
        sessionId: "sess_clarify_1",
        currentStage: "awaiting_intent_clarification",
        repo: {
          repoUrl: "https://github.com/acme/restaurant-site.git",
          name: "restaurant-site",
        },
        handoff: {
          requiredHumanInputs: ["Respond to onboarding-empty-repo so BOX can clarify the target intent before planning starts."],
          nextAction: "launch_onboarding-empty-repo",
        },
        repoProfile: {
          repoState: "empty",
          selectedOnboardingAgent: "onboarding-empty-repo",
        },
        clarification: {
          status: "pending",
          mode: "multi_turn_clarification",
          selectedAgentSlug: "onboarding-empty-repo",
          pendingQuestions: ["What should BOX build?", "Who is it for?"],
          packetPath: "C:/box/state/projects/target_restaurant/sess_clarify_1/clarification_packet.json",
          transcriptPath: "C:/box/state/projects/target_restaurant/sess_clarify_1/clarification_transcript.json",
          intentContractPath: "C:/box/state/projects/target_restaurant/sess_clarify_1/target_intent_contract.json",
        },
        workspace: {
          path: "C:/box/.box-work/targets/restaurant/sess_clarify_1",
          bootstrap: {
            status: "ready",
            strategy: "git_clone",
          },
        },
      },
      rootDir: "C:/box",
    });

    assert.equal(runtime.stage, "awaiting_intent_clarification");
    assert.equal(runtime.waitingReason, "Respond to onboarding-empty-repo so BOX can clarify the target intent before planning starts.");
    assert.equal(runtime.repoState, "empty");
    assert.equal(runtime.clarificationAgent, "onboarding-empty-repo");
    assert.equal(runtime.clarificationStatus, "pending");
    assert.deepEqual(runtime.clarificationPendingQuestions, ["What should BOX build?", "Who is it for?"]);
  });
});