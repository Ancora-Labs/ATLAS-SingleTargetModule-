import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPromptAssemblyPrompt, resolvePromptTargetRepo } from "../../src/core/prompt_overlay.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";

describe("prompt_overlay", () => {
  it("builds a self_dev overlay by default with a clear runtime assembly path", () => {
    const prompt = buildPromptAssemblyPrompt({
      agentName: "prometheus",
      config: {
        selfDev: {
          enabled: true,
          futureModeFlags: {
            singleTargetDelivery: false,
            targetSessionState: false,
          },
        },
        env: {
          targetRepo: "Ancora-Labs/Box",
        },
      },
    });

    assert.ok(prompt.includes("PART 4 PROMPT ASSEMBLY SYSTEM"));
    assert.ok(prompt.includes("BASE CORE BEHAVIOR"));
    assert.ok(prompt.includes("MODE OVERLAY — SELF_DEV"));
    assert.ok(prompt.includes("STAGE OVERLAY — none"));
  });

  it("negative path: falls back to self_dev overlay when single target mode is requested but disabled", () => {
    const prompt = buildPromptAssemblyPrompt({
      agentName: "athena",
      config: {
        selfDev: {
          enabled: true,
          futureModeFlags: {
            singleTargetDelivery: false,
            targetSessionState: false,
          },
        },
        platformModeState: {
          currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        },
        env: {
          targetRepo: "Ancora-Labs/Box",
        },
      },
      stage: "active",
    });

    assert.ok(prompt.includes("MODE OVERLAY — SELF_DEV"));
    assert.ok(prompt.includes("feature flag is disabled"));
    assert.ok(prompt.includes("STAGE OVERLAY — active"));
  });

  it("activates single-target and stage overlays when mode truth and flags allow it", () => {
    const prompt = buildPromptAssemblyPrompt({
      agentName: "worker",
      config: {
        selfDev: {
          enabled: false,
          futureModeFlags: {
            singleTargetDelivery: true,
            targetSessionState: true,
          },
        },
        platformModeState: {
          currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        },
      },
      stage: "onboarding",
    });

    assert.ok(prompt.includes("MODE OVERLAY — SINGLE_TARGET_DELIVERY"));
    assert.ok(prompt.includes("Operate inside the active target workspace"));
    assert.ok(prompt.includes("target objective, protected paths, forbidden actions, and completion criteria"));
    assert.ok(prompt.includes("STAGE OVERLAY — onboarding"));
    assert.ok(prompt.includes("understand and classify the repo before execution begins"));
  });

  it("derives stage and target-session handoff context from the active target session", () => {
    const prompt = buildPromptAssemblyPrompt({
      agentName: "prometheus",
      config: {
        selfDev: {
          enabled: false,
          futureModeFlags: {
            singleTargetDelivery: true,
            targetSessionState: true,
          },
        },
        platformModeState: {
          currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        },
        activeTargetSession: {
          projectId: "target_portal",
          sessionId: "sess_001",
          currentStage: "shadow",
          repo: {
            repoUrl: "https://github.com/acme/portal",
          },
          objective: {
            summary: "Fix authentication regressions safely",
          },
          onboarding: {
            readiness: "partial",
            recommendedNextStage: "shadow",
            readinessScore: 68,
          },
          prerequisites: {
            requiredNow: [],
            requiredLater: ["vercel_access_token"],
            optional: ["sentry_access_token"],
          },
          gates: {
            allowPlanning: true,
            allowShadowExecution: true,
            allowActiveExecution: false,
            quarantine: false,
            quarantineReason: null,
          },
          handoff: {
            requiredHumanInputs: ["confirm staging URL"],
            carriedContextSummary: "Node auth service with medium confidence baseline.",
          },
          constraints: {
            protectedPaths: ["infra/prod"],
            forbiddenActions: ["force push"],
          },
        },
      },
    });

    assert.ok(prompt.includes("MODE OVERLAY — SINGLE_TARGET_DELIVERY"));
    assert.ok(prompt.includes("STAGE OVERLAY — shadow"));
    assert.ok(prompt.includes("TARGET SESSION CONTRACT"));
    assert.ok(prompt.includes("objective: Fix authentication regressions safely"));
    assert.ok(prompt.includes("allowActiveExecution: false"));
    assert.ok(prompt.includes("requiredLater: vercel_access_token"));
    assert.ok(prompt.includes("optionalPrerequisites: sentry_access_token"));
    assert.ok(prompt.includes("requiredHumanInputs: confirm staging URL"));
    assert.ok(prompt.includes("If allowPlanning=true but allowActiveExecution=false, keep plans shadow-safe"));
  });

  it("resolves the active target repo instead of the BOX repo in single target mode", () => {
    const targetRepo = resolvePromptTargetRepo({
      selfDev: {
        futureModeFlags: {
          singleTargetDelivery: true,
        },
      },
      platformModeState: {
        currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
      },
      env: {
        targetRepo: "Ancora-Labs/Box",
      },
      activeTargetSession: {
        repo: {
          repoUrl: "https://github.com/acme/portal",
        },
      },
    });

    assert.equal(targetRepo, "https://github.com/acme/portal");
  });

  it("injects repo-state and clarification context into target-mode prompts", () => {
    const prompt = buildPromptAssemblyPrompt({
      agentName: "research-scout",
      config: {
        selfDev: {
          enabled: false,
          futureModeFlags: {
            singleTargetDelivery: true,
            targetSessionState: true,
          },
        },
        platformModeState: {
          currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
        },
        activeTargetSession: {
          projectId: "target_restaurant",
          sessionId: "sess_clarify_1",
          currentStage: "awaiting_intent_clarification",
          repo: {
            repoUrl: "https://github.com/acme/restaurant-site",
          },
          objective: {
            summary: "Build a new restaurant website from an empty target repo",
          },
          onboarding: {
            readiness: "clarification_required",
            recommendedNextStage: "awaiting_intent_clarification",
            readinessScore: 58,
          },
          repoProfile: {
            repoState: "empty",
            repoStateReason: "Repository contains only scaffolding.",
            meaningfulEntryPoints: ["README.md"],
            dominantSignals: ["npm"],
            selectedOnboardingAgent: "onboarding-empty-repo",
          },
          clarification: {
            status: "pending",
            mode: "empty_repo",
            selectedAgentSlug: "onboarding-empty-repo",
            pendingQuestions: ["What should BOX build?", "Who is it for?"],
            readyForPlanning: false,
          },
          intent: {
            status: "clarifying",
            summary: "repoState=empty | goal=restaurant website | users=restaurant guests | scope=Homepage, Booking flow | protect=none_specified | success=Optimize for Business conversion",
            planningMode: null,
            productType: "restaurant website",
            targetUsers: ["restaurant guests"],
            mustHaveFlows: ["Homepage", "Booking flow"],
            scopeIn: ["Homepage", "Booking flow"],
            scopeOut: [],
            protectedAreas: [],
            successCriteria: ["Optimize for Business conversion"],
            assumptions: [],
            openQuestions: ["What matters most?"],
          },
          prerequisites: {
            requiredNow: [],
            requiredLater: [],
            optional: [],
          },
          gates: {
            allowPlanning: false,
            allowShadowExecution: false,
            allowActiveExecution: false,
            quarantine: false,
            quarantineReason: null,
          },
          handoff: {
            requiredHumanInputs: ["Respond to onboarding-empty-repo"],
            carriedContextSummary: "Empty repo routed into clarification.",
          },
          constraints: {
            protectedPaths: [],
            forbiddenActions: [],
          },
        },
      },
    });

    assert.ok(prompt.includes("STAGE OVERLAY — awaiting"));
    assert.ok(prompt.includes("repoState: empty"));
    assert.ok(prompt.includes("clarificationAgent: onboarding-empty-repo"));
    assert.ok(prompt.includes("clarificationPendingQuestions: What should BOX build?, Who is it for?"));
    assert.ok(prompt.includes("intentSummary: repoState=empty | goal=restaurant website"));
    assert.ok(prompt.includes("intentOpenQuestions: What matters most?"));
  });
});