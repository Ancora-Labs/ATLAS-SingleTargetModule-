import { getAgentLayerContract } from "./agent_layer_contract.js";
import { section, compilePrompt } from "./prompt_compiler.js";
import { DEFAULT_PLATFORM_MODE_STATE, PLATFORM_MODE } from "./mode_state.js";
import { buildShadowStageDisciplineLines } from "./target_stage_contract.js";

export const PROMPT_STAGE = Object.freeze({
  NONE: "none",
  ONBOARDING: "onboarding",
  AWAITING: "awaiting",
  SHADOW: "shadow",
  ACTIVE: "active",
});

const VALID_PROMPT_STAGES = new Set(Object.values(PROMPT_STAGE));

type PromptStage = typeof PROMPT_STAGE[keyof typeof PROMPT_STAGE];

const TARGET_SESSION_STAGE_TO_PROMPT_STAGE = Object.freeze({
  onboarding: PROMPT_STAGE.ONBOARDING,
  awaiting_credentials: PROMPT_STAGE.AWAITING,
  awaiting_manual_step: PROMPT_STAGE.AWAITING,
  awaiting_intent_clarification: PROMPT_STAGE.AWAITING,
  shadow: PROMPT_STAGE.SHADOW,
  active: PROMPT_STAGE.ACTIVE,
});

const SINGLE_TARGET_AGENT_OVERLAYS = Object.freeze({
  "research-scout": Object.freeze([
    "Research the active target repo's stack, framework, operational blockers, and objective-specific unknowns.",
    "Prefer sources that directly improve the target repo instead of BOX itself.",
  ]),
  "research-synthesizer": Object.freeze([
    "Condense research toward the active target repo's objective, risks, and implementation choices.",
    "Preserve target-relevant contradictions and recommended patterns for downstream planning.",
  ]),
  janus: Object.freeze([
    "Choose priorities for the active target session rather than BOX itself.",
    "Use target stage, blockers, and session objective as the primary decision material.",
  ]),
  prometheus: Object.freeze([
    "Plan for the active target repo using session gates, objective, and carried context.",
    "Respect target stage and do not produce full delivery plans before gates allow them.",
  ]),
  athena: Object.freeze([
    "Review target-repo plans for stage safety, risk, and handoff correctness.",
    "Apply stricter scrutiny when promotion, protected paths, or risky target actions are involved.",
  ]),
  worker: Object.freeze([
    "Operate inside the active target workspace, not the BOX workspace.",
    "Obey target scope, protected paths, and forbidden actions from session truth.",
  ]),
});

const STAGE_OVERLAY_LINES = Object.freeze({
  [PROMPT_STAGE.NONE]: Object.freeze([
    "No target-stage overlay is active in this prompt.",
    "Fail closed when target-stage context is missing instead of inventing broader runtime behavior.",
  ]),
  [PROMPT_STAGE.ONBOARDING]: Object.freeze([
    "Onboarding stage overlay: understand and classify the repo before execution begins.",
    "Do not perform normal delivery execution while onboarding is active.",
  ]),
  [PROMPT_STAGE.AWAITING]: Object.freeze([
    "Awaiting stage overlay: preserve blocked reasons and required human inputs clearly.",
    "Do not force forward execution while user-side prerequisites are unresolved.",
  ]),
  [PROMPT_STAGE.SHADOW]: Object.freeze([
    "Shadow stage overlay: use cautious, verification-heavy, low-risk behavior.",
    "Prefer confidence-building work over broad or aggressive delivery actions.",
  ]),
  [PROMPT_STAGE.ACTIVE]: Object.freeze([
    "Active stage overlay: full delivery behavior can operate within approved target boundaries.",
    "Stay scoped to the active target objective, verification plan, and session constraints.",
  ]),
});

const AGENT_SESSION_DIRECTIVES = Object.freeze({
  "research-scout": Object.freeze([
    "Research the target repo's actual stack, framework, dependencies, and blockers before broadening scope.",
    "Prefer target-relevant docs, integration guides, migration notes, and operational references over BOX-internal optimization material.",
  ]),
  "research-synthesizer": Object.freeze([
    "Preserve target-specific contradictions, readiness blockers, and recommended implementation paths for planning handoff.",
    "Organize synthesis around the active target objective, not BOX self-improvement themes, when delivery mode is active.",
  ]),
  janus: Object.freeze([
    "Use target objective, readiness state, and required human inputs to choose the next priority for the active session.",
    "If planning is blocked, prioritize unblock or quarantine decisions before asking for normal delivery work.",
  ]),
  prometheus: Object.freeze([
    "If allowPlanning=false, produce only prerequisite-clearing or onboarding follow-up plans and avoid normal delivery packets.",
    "If allowPlanning=true but allowActiveExecution=false, keep plans shadow-safe, verification-heavy, and low risk.",
  ]),
  athena: Object.freeze([
    "Review the proposed work against the target stage, readiness score, and quarantine conditions before approving progression.",
    "Treat protected paths, forbidden actions, and required human inputs as first-class review constraints.",
  ]),
  worker: Object.freeze([
    "Do not widen execution beyond the active target session's gates, stage, and protected-path contract.",
    "Treat required human inputs and quarantine reasons as hard stop conditions, not soft warnings.",
  ]),
});

function resolveEffectivePromptMode(config: any) {
  const platformModeState = config?.platformModeState && typeof config.platformModeState === "object"
    ? config.platformModeState
    : DEFAULT_PLATFORM_MODE_STATE;
  const requestedMode = String(platformModeState.currentMode || DEFAULT_PLATFORM_MODE_STATE.currentMode);
  const singleTargetEnabled = true;

  return {
    requestedMode,
    effectiveMode: requestedMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
      ? PLATFORM_MODE.SINGLE_TARGET_DELIVERY
      : PLATFORM_MODE.IDLE,
    singleTargetEnabled,
    fellBack: false,
  };
}

function resolveStage(stage: unknown) {
  const normalized = String(stage || "").trim().toLowerCase() as PromptStage;
  return VALID_PROMPT_STAGES.has(normalized) ? normalized : PROMPT_STAGE.NONE;
}

function resolveTargetSessionPromptStage(activeTargetSession: any) {
  const rawStage = String(activeTargetSession?.currentStage || "").trim().toLowerCase();
  return TARGET_SESSION_STAGE_TO_PROMPT_STAGE[rawStage as keyof typeof TARGET_SESSION_STAGE_TO_PROMPT_STAGE] || PROMPT_STAGE.NONE;
}

export function resolvePromptRuntimeContext(config: any, stage?: string | null) {
  const mode = resolveEffectivePromptMode(config);
  const activeTargetSession = config?.activeTargetSession && typeof config.activeTargetSession === "object"
    ? config.activeTargetSession
    : null;
  const resolvedStage = resolveStage(stage || resolveTargetSessionPromptStage(activeTargetSession));
  const targetRepo = mode.effectiveMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    ? String(activeTargetSession?.repo?.repoUrl || activeTargetSession?.repo?.name || config?.env?.targetRepo || "unknown")
    : String(config?.env?.targetRepo || "unknown");

  return {
    mode,
    activeTargetSession,
    stage: resolvedStage,
    targetRepo,
  };
}

export function resolvePromptTargetRepo(config: any) {
  return resolvePromptRuntimeContext(config).targetRepo;
}

export function buildPromptAssemblySections(input: {
  agentName: string;
  config: any;
  stage?: string | null;
}) {
  const contract = getAgentLayerContract(input.agentName, input.config);
  const runtime = resolvePromptRuntimeContext(input.config, input.stage);
  const { mode, activeTargetSession, targetRepo } = runtime;
  const stage = runtime.stage;
  const singleTargetSpecific = [
    ...(SINGLE_TARGET_AGENT_OVERLAYS[contract.agent as keyof typeof SINGLE_TARGET_AGENT_OVERLAYS] || []),
  ];

  const sections = [
    section("prompt-assembly-path", [
      "## PART 4 PROMPT ASSEMBLY SYSTEM",
      "This prompt is assembled at runtime from: base core behavior -> mode overlay -> stage overlay -> task/context packet.",
      "Do not duplicate prompt families per target; reuse stable agent identities and switch overlays instead.",
    ].join("\n")),
    section("base-core-behavior", [
      `## BASE CORE BEHAVIOR — ${contract.displayName}`,
      "These responsibilities must remain stable across modes:",
      ...contract.sharedCore.map((entry: string) => `- ${entry}`),
    ].join("\n")),
  ];

  if (mode.effectiveMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY) {
    sections.push(section("mode-overlay-single-target", [
      "## MODE OVERLAY — SINGLE_TARGET_DELIVERY",
      `Requested mode: ${mode.requestedMode}`,
      `Effective target repo: ${targetRepo}`,
      "Single-target delivery overlay is active for this prompt.",
      ...contract.singleTargetSpecific.map((entry: string) => `- ${entry}`),
      ...singleTargetSpecific.map((entry: string) => `- ${entry}`),
    ].join("\n")));

    if (activeTargetSession) {
      sections.push(section("target-session-contract", [
        "## TARGET SESSION CONTRACT",
        `projectId: ${String(activeTargetSession.projectId || "unknown")}`,
        `sessionId: ${String(activeTargetSession.sessionId || "unknown")}`,
        `repo: ${targetRepo}`,
        `objective: ${String(activeTargetSession.objective?.summary || "unknown")}`,
        `currentStage: ${String(activeTargetSession.currentStage || "unknown")}`,
        `readiness: ${String(activeTargetSession.onboarding?.readiness || "pending")}`,
        `recommendedNextStage: ${String(activeTargetSession.onboarding?.recommendedNextStage || "unknown")}`,
        `readinessScore: ${String(activeTargetSession.onboarding?.readinessScore ?? 0)}`,
        `repoState: ${String(activeTargetSession.repoProfile?.repoState || "unknown")}`,
        `repoStateReason: ${String(activeTargetSession.repoProfile?.repoStateReason || "none")}`,
        `repoMeaningfulEntryPoints: ${(Array.isArray(activeTargetSession.repoProfile?.meaningfulEntryPoints) ? activeTargetSession.repoProfile.meaningfulEntryPoints : []).join(", ") || "none"}`,
        `repoDominantSignals: ${(Array.isArray(activeTargetSession.repoProfile?.dominantSignals) ? activeTargetSession.repoProfile.dominantSignals : []).join(", ") || "none"}`,
        `selectedOnboardingAgent: ${String(activeTargetSession.repoProfile?.selectedOnboardingAgent || "none")}`,
        `clarificationStatus: ${String(activeTargetSession.clarification?.status || "pending")}`,
        `clarificationMode: ${String(activeTargetSession.clarification?.mode || "unknown")}`,
        `clarificationAgent: ${String(activeTargetSession.clarification?.selectedAgentSlug || "none")}`,
        `clarificationPendingQuestions: ${(Array.isArray(activeTargetSession.clarification?.pendingQuestions) ? activeTargetSession.clarification.pendingQuestions : []).join(", ") || "none"}`,
        `clarificationReadyForPlanning: ${activeTargetSession.clarification?.readyForPlanning === true}`,
        `intentStatus: ${String(activeTargetSession.intent?.status || "pending")}`,
        `intentSummary: ${String(activeTargetSession.intent?.summary || "none")}`,
        `intentPlanningMode: ${String(activeTargetSession.intent?.planningMode || "none")}`,
        `intentProductType: ${String(activeTargetSession.intent?.productType || "none")}`,
        `intentTargetUsers: ${(Array.isArray(activeTargetSession.intent?.targetUsers) ? activeTargetSession.intent.targetUsers : []).join(", ") || "none"}`,
        `intentMustHaveFlows: ${(Array.isArray(activeTargetSession.intent?.mustHaveFlows) ? activeTargetSession.intent.mustHaveFlows : []).join(", ") || "none"}`,
        `intentScopeIn: ${(Array.isArray(activeTargetSession.intent?.scopeIn) ? activeTargetSession.intent.scopeIn : []).join(", ") || "none"}`,
        `intentScopeOut: ${(Array.isArray(activeTargetSession.intent?.scopeOut) ? activeTargetSession.intent.scopeOut : []).join(", ") || "none"}`,
        `intentProtectedAreas: ${(Array.isArray(activeTargetSession.intent?.protectedAreas) ? activeTargetSession.intent.protectedAreas : []).join(", ") || "none"}`,
        `intentSuccessCriteria: ${(Array.isArray(activeTargetSession.intent?.successCriteria) ? activeTargetSession.intent.successCriteria : []).join(", ") || "none"}`,
        `intentAssumptions: ${(Array.isArray(activeTargetSession.intent?.assumptions) ? activeTargetSession.intent.assumptions : []).join(", ") || "none"}`,
        `intentOpenQuestions: ${(Array.isArray(activeTargetSession.intent?.openQuestions) ? activeTargetSession.intent.openQuestions : []).join(", ") || "none"}`,
        `allowPlanning: ${activeTargetSession.gates?.allowPlanning === true}`,
        `allowShadowExecution: ${activeTargetSession.gates?.allowShadowExecution === true}`,
        `allowActiveExecution: ${activeTargetSession.gates?.allowActiveExecution === true}`,
        `quarantine: ${activeTargetSession.gates?.quarantine === true}`,
        `quarantineReason: ${String(activeTargetSession.gates?.quarantineReason || "none")}`,
        `requiredNow: ${(Array.isArray(activeTargetSession.prerequisites?.requiredNow) ? activeTargetSession.prerequisites.requiredNow : []).join(", ") || "none"}`,
        `requiredLater: ${(Array.isArray(activeTargetSession.prerequisites?.requiredLater) ? activeTargetSession.prerequisites.requiredLater : []).join(", ") || "none"}`,
        `optionalPrerequisites: ${(Array.isArray(activeTargetSession.prerequisites?.optional) ? activeTargetSession.prerequisites.optional : []).join(", ") || "none"}`,
        `requiredHumanInputs: ${(Array.isArray(activeTargetSession.handoff?.requiredHumanInputs) ? activeTargetSession.handoff.requiredHumanInputs : []).join(", ") || "none"}`,
        `protectedPaths: ${(Array.isArray(activeTargetSession.constraints?.protectedPaths) ? activeTargetSession.constraints.protectedPaths : []).join(", ") || "none"}`,
        `forbiddenActions: ${(Array.isArray(activeTargetSession.constraints?.forbiddenActions) ? activeTargetSession.constraints.forbiddenActions : []).join(", ") || "none"}`,
        `carriedContextSummary: ${String(activeTargetSession.handoff?.carriedContextSummary || "none")}`,
        ...((AGENT_SESSION_DIRECTIVES[contract.agent as keyof typeof AGENT_SESSION_DIRECTIVES] || []).map((entry: string) => `- ${entry}`)),
      ].join("\n")));
    } else {
      sections.push(section("target-session-contract", [
        "## TARGET SESSION CONTRACT",
        "Target delivery mode is active, but no active target session was loaded into prompt context.",
        "Fail closed: do not invent missing target objective, stage, or gate state.",
      ].join("\n")));
    }
  } else {
    sections.push(section("mode-overlay-idle", [
      "## MODE OVERLAY — IDLE",
      `Requested mode: ${mode.requestedMode}`,
      "No active single-target delivery overlay is active for this prompt.",
      "Fail closed instead of widening into BOX-specific or self-dev behavior.",
    ].join("\n")));
  }

  sections.push(section("stage-overlay", [
    `## STAGE OVERLAY — ${stage}`,
    ...(STAGE_OVERLAY_LINES[stage as keyof typeof STAGE_OVERLAY_LINES] || STAGE_OVERLAY_LINES[PROMPT_STAGE.NONE]).map((entry: string) => `- ${entry}`),
  ].join("\n")));

  if (mode.effectiveMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY && stage === PROMPT_STAGE.SHADOW) {
    sections.push(section("shadow-stage-discipline", [
      "## SHADOW MODE DELIVERY DISCIPLINE",
      ...buildShadowStageDisciplineLines().map((entry: string) => `- ${entry}`),
    ].join("\n")));
  }

  return sections;
}

export function buildPromptAssemblyPrompt(input: {
  agentName: string;
  config: any;
  stage?: string | null;
}) {
  return compilePrompt(buildPromptAssemblySections(input));
}
