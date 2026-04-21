/**
 * Agent Layer Contract
 *
 * Part 2 extraction boundary for shared-core vs Atlas single-target behavior.
 */

export const AGENT_LAYER = Object.freeze({
  SHARED_CORE: "shared_core",
  SINGLE_TARGET_SPECIFIC: "single_target_specific",
});

const AGENT_LAYER_ALIASES = Object.freeze({
  "research-scout": "research-scout",
  research_scout: "research-scout",
  scout: "research-scout",
  "research-synthesizer": "research-synthesizer",
  research_synthesizer: "research-synthesizer",
  synthesizer: "research-synthesizer",
  janus: "janus",
  prometheus: "prometheus",
  athena: "athena",
  worker: "worker",
  workers: "worker",
});

const AGENT_LAYER_DEFINITIONS = Object.freeze({
  "research-scout": Object.freeze({
    displayName: "Research Scout",
    sharedCore: Object.freeze([
      "Find high-signal external sources instead of repository inventories.",
      "Prefer official docs, primary references, and directly applicable technical evidence.",
      "Dedupe repeated sources and rank findings by decision value.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Bias research toward the active target repo's stack, framework, operational blockers, and delivery objective.",
      "Treat target-specific docs, failure signatures, and repo-relevant examples as the active research subject.",
    ]),
  }),
  "research-synthesizer": Object.freeze({
    displayName: "Research Synthesizer",
    sharedCore: Object.freeze([
      "Compress research into structured, decision-ready knowledge without losing critical evidence.",
      "Preserve contradictions, confidence signals, and actionable findings for downstream planning.",
      "Improve usability of research output without inventing facts that were not in the sources.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Bias synthesis toward the active target repo's objective, risks, blockers, and implementation choices.",
      "Treat target delivery planning, not BOX self-improvement, as the immediate consumer when target mode is active.",
    ]),
  }),
  janus: Object.freeze({
    displayName: "Janus",
    sharedCore: Object.freeze([
      "Make strategic decisions from state, health signals, and recent execution evidence.",
      "Delegate verification and implementation instead of performing wide repo execution directly.",
      "Prefer the highest-leverage next decision, not broad unfocused commentary.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Optimize the active target session using its stage, blockers, risk, and objective as the primary decision material.",
      "Interpret target readiness, missing inputs, and delivery progress as the active strategic signal set.",
    ]),
  }),
  prometheus: Object.freeze({
    displayName: "Prometheus",
    sharedCore: Object.freeze([
      "Produce dependency-aware, measurable plans with explicit verification paths.",
      "Use evidence, root cause, implementation change, and verification as a complete chain.",
      "Prefer useful worker packets over vague strategic recommendations.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Plan delivery work for the active target repo using target objective, risk, and session gates as upstream truth.",
      "Treat target completion, handoff, and protected-path boundaries as first-class planning constraints.",
    ]),
  }),
  athena: Object.freeze({
    displayName: "Athena",
    sharedCore: Object.freeze([
      "Validate measurability, scope clarity, dependency ordering, and verification quality.",
      "Fix repairable plan issues directly and reject only structurally unsound work.",
      "Keep quality gates deterministic and evidence-backed.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Review target-repo plans against target stage, protected paths, risky actions, and promotion safety.",
      "Treat target-session transition quality and delivery safety as first-class review concerns.",
    ]),
  }),
  worker: Object.freeze({
    displayName: "Workers",
    sharedCore: Object.freeze([
      "Execute within explicit scope boundaries and produce required verification evidence.",
      "Prefer concrete implementation plus proof over narrative-only completion claims.",
      "Stop on real blockers and report them exactly instead of widening scope.",
    ]),
    selfDevSpecific: Object.freeze([]),
    singleTargetSpecific: Object.freeze([
      "Operate inside the active target workspace and keep BOX workspace state untouched during target delivery.",
      "Treat target objective, protected paths, forbidden actions, and completion criteria as the active execution contract.",
    ]),
  }),
});

function resolveAgentLayerKey(agentName: unknown) {
  const normalized = String(agentName || "").trim().toLowerCase().replace(/\s+/g, "_");
  return AGENT_LAYER_ALIASES[normalized as keyof typeof AGENT_LAYER_ALIASES] || null;
}

function resolveFutureModeFlags(config: any) {
  return {
    singleTargetDelivery: true,
    targetSessionState: true,
    targetPromptOverlay: true,
    targetWorkspaceLifecycle: true,
  };
}

export function getAgentLayerContract(agentName: unknown, config: any) {
  const key = resolveAgentLayerKey(agentName);
  if (!key) {
    throw new Error(`Unknown agent layer contract: ${String(agentName || "")}`);
  }

  const definition = AGENT_LAYER_DEFINITIONS[key as keyof typeof AGENT_LAYER_DEFINITIONS];
  const futureModeFlags = resolveFutureModeFlags(config);

  return {
    agent: key,
    displayName: definition.displayName,
    activeProfile: "single_target",
    sharedCore: [...definition.sharedCore],
    selfDevSpecific: [...definition.selfDevSpecific],
    singleTargetSpecific: [...definition.singleTargetSpecific],
    futureModeFlags,
    singleTargetLayerReserved: true,
  };
}

export function buildAgentLayerPrompt(agentName: unknown, config: any) {
  const contract = getAgentLayerContract(agentName, config);
  const disabledFutureFlags = Object.entries(contract.futureModeFlags)
    .filter(([, enabled]) => enabled !== true)
    .map(([flag]) => flag);

  return [
    "## PART 2 RUNTIME LAYER CONTRACT",
    `Agent surface: ${contract.displayName}`,
    `Protected runtime profile: ${contract.activeProfile}`,
    "Treat the following as SHARED CORE responsibilities that must stay reusable across future modes:",
    ...contract.sharedCore.map((item) => `- ${item}`),
    "Treat the following as SINGLE-TARGET-SPECIFIC responsibilities that must stay outside shared core and outside self_dev by default:",
    ...contract.singleTargetSpecific.map((item) => `- ${item}`),
    `Future single-target behavior remains disabled in this part: ${disabledFutureFlags.join(", ") || "none"}.`,
    "These single-target-specific responsibilities are defined now so runtime overlays can activate them later without prompt-copy drift.",
    "Do NOT invent target-session logic, target workspace behavior, or target-repo priorities yet.",
  ].join("\n");
}
