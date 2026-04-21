import path from "node:path";
import fs from "node:fs/promises";
import { readJson, writeJson } from "./fs_utils.js";
import { spawnAsync } from "./fs_utils.js";
import { agentFileExists, buildAgentArgs, parseAgentOutput, nameToSlug } from "./agent_loader.js";
import { getRoleRegistry } from "./role_registry.js";

export const INTERVENTION_DECISION = Object.freeze({
  PROMOTE: "promote",
  HOLD: "hold",
  REWORK: "rework",
  ROLLBACK: "rollback",
});

const DEFAULTS = Object.freeze({
  minSamples: 3,
  windowSize: 5,
  autoApplyLowRisk: false,
});

function toFiniteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp01(value: number | null): number | null {
  if (value === null) return null;
  return Math.max(0, Math.min(1, value));
}

function normalizeInterventionId(value: unknown, fallback: string): string {
  const text = String(value || "").trim();
  return text || fallback;
}

function average(nums: number[]): number | null {
  if (!Array.isArray(nums) || nums.length === 0) return null;
  const sum = nums.reduce((acc, n) => acc + n, 0);
  return sum / nums.length;
}

function decideIntervention(
  samples: Array<{ completionRate: number | null; premiumEfficiency: number | null; healthScore: string }>,
  riskLevel: string,
  minSamples: number
): { decision: string; reason: string } {
  if (!Array.isArray(samples) || samples.length < minSamples) {
    return {
      decision: INTERVENTION_DECISION.HOLD,
      reason: `insufficient_sample:${samples.length}/${minSamples}`,
    };
  }

  const completionAvg = average(samples.map((s) => s.completionRate).filter((v): v is number => typeof v === "number"));
  const efficiencyAvg = average(samples.map((s) => s.premiumEfficiency).filter((v): v is number => typeof v === "number"));
  const criticalCount = samples.filter((s) => s.healthScore === "critical").length;
  const degradedCount = samples.filter((s) => s.healthScore === "degraded").length;

  if (criticalCount >= 1 || degradedCount >= Math.ceil(samples.length / 2)) {
    if (["high", "critical", "medium"].includes(riskLevel)) {
      return {
        decision: INTERVENTION_DECISION.REWORK,
        reason: `health_signal_degraded:critical=${criticalCount},degraded=${degradedCount}`,
      };
    }
    return {
      decision: INTERVENTION_DECISION.ROLLBACK,
      reason: `health_signal_degraded:critical=${criticalCount},degraded=${degradedCount}`,
    };
  }

  if ((completionAvg ?? 0) >= 0.8 && (efficiencyAvg ?? 0) >= 0.5) {
    return {
      decision: INTERVENTION_DECISION.PROMOTE,
      reason: `strong_outcome:completion=${(completionAvg ?? 0).toFixed(3)},efficiency=${(efficiencyAvg ?? 0).toFixed(3)}`,
    };
  }

  if ((completionAvg ?? 0) < 0.5) {
    if (["high", "critical", "medium"].includes(riskLevel)) {
      return {
        decision: INTERVENTION_DECISION.REWORK,
        reason: `low_completion_with_value_risk:completion=${(completionAvg ?? 0).toFixed(3)}`,
      };
    }
    return {
      decision: INTERVENTION_DECISION.ROLLBACK,
      reason: `low_completion:completion=${(completionAvg ?? 0).toFixed(3)}`,
    };
  }

  return {
    decision: INTERVENTION_DECISION.HOLD,
    reason: `mixed_signal:completion=${(completionAvg ?? 0).toFixed(3)},efficiency=${(efficiencyAvg ?? 0).toFixed(3)}`,
  };
}

function isAmbiguousCandidate(
  candidate: { decision: string; reason: string; sampleCount: number },
  minSamples: number
): boolean {
  return candidate.decision === INTERVENTION_DECISION.HOLD
    && String(candidate.reason || "").startsWith("mixed_signal:")
    && Number(candidate.sampleCount) >= minSamples;
}

async function runAiInterventionReview(config: any, cycleMetrics: any, candidates: any[]) {
  const enabled = config?.runtime?.interventionJudgeAiEnabled !== false;
  if (!enabled || !Array.isArray(candidates) || candidates.length === 0) {
    return { ok: false, byId: {}, reason: "disabled_or_empty" };
  }

  const startedAt = Date.now();
  const command = config?.env?.copilotCliCommand || "copilot";
  const registry = getRoleRegistry(config);
  const reviewerName = registry?.qualityReviewer?.name || "Athena";
  const reviewerModel = config?.runtime?.interventionJudgeAiModel
    || registry?.qualityReviewer?.model
    || "Claude Sonnet 4.6";
  const dedicatedAgentSlug = "intervention-reviewer";
  const fallbackAgentSlug = nameToSlug(reviewerName);
  const agentSlug = agentFileExists(dedicatedAgentSlug) ? dedicatedAgentSlug : fallbackAgentSlug;

  await appendAiLiveLog(
    config,
    `[INTERVENTION_REVIEWER] AI review starting: agent=${agentSlug} model=${reviewerModel} candidates=${candidates.length}`
  );

  const compact = candidates.map((c) => ({
    interventionId: c.interventionId,
    riskLevel: c.riskLevel,
    sampleCount: c.sampleCount,
    deterministicDecision: c.decision,
    deterministicReason: c.reason,
    expectedImpact: c.expectedImpact || null,
    task: c.task,
    role: c.role,
  }));

  const prompt = `You are an intervention evaluator for a self-improving agent system.
Your task: classify each intervention as one of promote|hold|rework|rollback.
Use context-aware judgement from cycle metrics and deterministic baseline results.

Important constraints:
- Return strict JSON only inside markers.
- Do not invent intervention IDs.
- If evidence is weak, choose hold.

Cycle metrics:
${JSON.stringify(cycleMetrics, null, 2)}

Interventions:
${JSON.stringify(compact, null, 2)}

===DECISION===
{
  "reviews": [
    {
      "interventionId": "string",
      "decision": "promote|hold|rework|rollback",
      "confidence": 0.0,
      "rationale": "short reason"
    }
  ]
}
===END===`;

  const args = buildAgentArgs({
    agentSlug,
    prompt,
    model: reviewerModel,
    allowAll: false,
    noAskUser: true,
    autopilot: false,
    silent: true,
  });

  const result: any = await spawnAsync(command, args, {
    env: process.env,
    timeoutMs: Number(config?.runtime?.interventionJudgeAiTimeoutMs || 120000),
  });

  if (result.status !== 0 || !String(result.stdout || "").trim()) {
    const reason = `ai_call_failed:${String(result.stderr || "").slice(0, 120)}`;
    await appendAiLiveLog(
      config,
      `[INTERVENTION_REVIEWER] AI review failed: agent=${agentSlug} status=${result.status} elapsedMs=${Date.now() - startedAt} reason=${reason}`
    );
    return { ok: false, byId: {}, reason };
  }

  const parsed = parseAgentOutput(result.stdout || "");
  const payload = parsed?.parsed;
  const reviews = Array.isArray(payload?.reviews) ? payload.reviews : [];
  const byId: Record<string, { decision: string; confidence: number; rationale: string }> = {};

  for (const r of reviews) {
    const id = String(r?.interventionId || "").trim();
    const decision = String(r?.decision || "").trim().toLowerCase();
    const confidenceRaw = Number(r?.confidence);
    const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(1, confidenceRaw)) : 0;
    const rationale = String(r?.rationale || "").trim();
    if (!id) continue;
    if (![INTERVENTION_DECISION.PROMOTE, INTERVENTION_DECISION.HOLD, INTERVENTION_DECISION.REWORK, INTERVENTION_DECISION.ROLLBACK].includes(decision as any)) {
      continue;
    }
    byId[id] = { decision, confidence, rationale };
  }

  await appendAiLiveLog(
    config,
    `[INTERVENTION_REVIEWER] AI review completed: agent=${agentSlug} elapsedMs=${Date.now() - startedAt} reviews=${Object.keys(byId).length}`
  );

  return { ok: true, byId, reason: "ok" };
}

function blendDecisionWithSafetyGate(
  deterministicDecision: string,
  riskLevel: string,
  sampleCount: number,
  minSamples: number,
  aiReview?: { decision: string; confidence: number; rationale: string }
) {
  if (!aiReview) {
    return {
      decision: deterministicDecision,
      mode: "deterministic_only",
      reason: "ai_review_missing",
    };
  }

  // Deterministic hard safety rails always win.
  if (deterministicDecision === INTERVENTION_DECISION.ROLLBACK) {
    return { decision: INTERVENTION_DECISION.ROLLBACK, mode: "safety_gate", reason: "deterministic_rollback" };
  }
  if (deterministicDecision === INTERVENTION_DECISION.REWORK) {
    return { decision: INTERVENTION_DECISION.REWORK, mode: "safety_gate", reason: "deterministic_rework" };
  }

  // AI-first for non-critical states, with evidence floor.
  if (sampleCount < minSamples) {
    return { decision: INTERVENTION_DECISION.HOLD, mode: "safety_gate", reason: `sample_guard:${sampleCount}/${minSamples}` };
  }

  const aiDecision = aiReview.decision;
  const aiConfidence = aiReview.confidence;

  if (aiDecision === INTERVENTION_DECISION.PROMOTE && aiConfidence >= 0.75) {
    return { decision: INTERVENTION_DECISION.PROMOTE, mode: "ai_first", reason: `ai_promote_confident:${aiConfidence.toFixed(2)}` };
  }

  if (aiDecision === INTERVENTION_DECISION.ROLLBACK) {
    if (["high", "critical", "medium"].includes(riskLevel)) {
      return { decision: INTERVENTION_DECISION.REWORK, mode: "ai_first", reason: "ai_rollback_but_value_risk_rework" };
    }
    return { decision: INTERVENTION_DECISION.ROLLBACK, mode: "ai_first", reason: "ai_rollback" };
  }

  if (aiDecision === INTERVENTION_DECISION.REWORK) {
    return { decision: INTERVENTION_DECISION.REWORK, mode: "ai_first", reason: "ai_rework" };
  }

  return { decision: INTERVENTION_DECISION.HOLD, mode: "ai_first", reason: `ai_hold:${aiConfidence.toFixed(2)}` };
}

function historyFilePath(config: any): string {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "intervention_judge_state.json");
}

function reportFilePath(config: any): string {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "intervention_judge_report.json");
}

function aiLiveLogFilePath(config: any): string {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "live_worker_intervention-reviewer.log");
}

async function appendAiLiveLog(config: any, message: string) {
  try {
    const logPath = aiLiveLogFilePath(config);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `[${new Date().toISOString()}] ${String(message || "").trim()}\n`, "utf8");
  } catch {
    // best-effort only
  }
}

export async function evaluateInterventionsForCycle(
  config: any,
  input: {
    cycleId: string;
    plans: any[];
    analyticsRecord: any;
    healthRecord: any;
    workerResults: Array<{ roleName: string; status: string }>;
    requestBudget?: any;
  }
) {
  const judgeEnabled = config?.runtime?.interventionJudgeEnabled !== false;
  if (!judgeEnabled) {
    const disabledReport = {
      schemaVersion: 1,
      cycleId: String(input?.cycleId || new Date().toISOString()),
      generatedAt: new Date().toISOString(),
      metrics: {
        completionRate: null,
        premiumEfficiency: null,
        healthScore: String(input?.healthRecord?.healthScore || "unknown").toLowerCase(),
        dispatched: 0,
        completed: 0,
      },
      aiReview: {
        enabled: false,
        status: "skipped",
        reason: "intervention_judge_disabled",
        requestedCandidates: 0,
        reviewedCandidates: 0,
      },
      decisions: [],
    };
    await writeJson(reportFilePath(config), disabledReport);
    return disabledReport;
  }

  const minSamples = Number.isFinite(Number(config?.runtime?.interventionJudgeMinSamples))
    ? Math.max(1, Math.floor(Number(config.runtime.interventionJudgeMinSamples)))
    : DEFAULTS.minSamples;
  const windowSize = Number.isFinite(Number(config?.runtime?.interventionJudgeWindowSize))
    ? Math.max(1, Math.floor(Number(config.runtime.interventionJudgeWindowSize)))
    : DEFAULTS.windowSize;
  const autoApplyLowRisk = config?.runtime?.interventionJudgeAutoApplyLowRisk === true;

  const plans = Array.isArray(input?.plans) ? input.plans : [];
  const dispatched = plans.length;
  const workerResults = Array.isArray(input?.workerResults) ? input.workerResults : [];
  const completed = workerResults.filter((w) => {
    const s = String(w?.status || "").toLowerCase();
    return s === "done" || s === "success" || s === "partial";
  }).length;
  const completionRate = clamp01(toFiniteOrNull(input?.analyticsRecord?.funnel?.completionRate))
    ?? (dispatched > 0 ? completed / dispatched : null);
  const estimatedRequests = Number(input?.requestBudget?.estimatedPremiumRequestsTotal);
  const premiumEfficiency = dispatched > 0
    ? clamp01(dispatched / Math.max(1, Number.isFinite(estimatedRequests) && estimatedRequests > 0 ? estimatedRequests : dispatched))
    : null;
  const healthScore = String(input?.healthRecord?.healthScore || "unknown").toLowerCase();

  const sample = {
    cycleId: String(input?.cycleId || new Date().toISOString()),
    recordedAt: new Date().toISOString(),
    completionRate,
    premiumEfficiency,
    healthScore,
    dispatched,
    completed,
  };

  const historyPath = historyFilePath(config);
  const historyState = await readJson(historyPath, {
    schemaVersion: 1,
    interventions: {},
    updatedAt: null,
  });

  const interventions = (historyState && typeof historyState.interventions === "object" && historyState.interventions)
    ? historyState.interventions
    : {};

  const decisions: any[] = [];
  const deterministicCandidates: any[] = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i] || {};
    const interventionId = normalizeInterventionId(
      plan.intervention_id ?? plan.interventionId,
      `plan-${i + 1}:${String(plan.task_id || plan.task || "unknown").slice(0, 80)}`
    );

    const riskLevel = String(plan.riskLevel || "low").trim().toLowerCase() || "low";
    if (!interventions[interventionId]) {
      interventions[interventionId] = {
        interventionId,
        firstSeenAt: new Date().toISOString(),
        riskLevel,
        expectedImpact: plan.expectedImpact ?? null,
        samples: [],
      };
    }

    const item = interventions[interventionId];
    item.riskLevel = riskLevel;
    item.expectedImpact = item.expectedImpact ?? plan.expectedImpact ?? null;
    const samples = Array.isArray(item.samples) ? item.samples : [];
    samples.push(sample);
    if (samples.length > 50) samples.splice(0, samples.length - 50);
    item.samples = samples;

    const recent = samples.slice(-windowSize);
    const verdict = decideIntervention(recent, riskLevel, minSamples);
    deterministicCandidates.push({
      interventionId,
      cycleId: sample.cycleId,
      riskLevel,
      decision: verdict.decision,
      reason: verdict.reason,
      sampleCount: samples.length,
      recentWindowSize: recent.length,
      expectedImpact: item.expectedImpact,
      task: String(plan.task || "").slice(0, 200),
      role: String(plan.role || ""),
    });
  }

  const aiCandidates = deterministicCandidates.filter((c) => isAmbiguousCandidate(c, minSamples));

  const aiReview = await runAiInterventionReview(config, {
    cycleId: sample.cycleId,
    completionRate,
    premiumEfficiency,
    healthScore,
    dispatched,
    completed,
  }, aiCandidates);

  for (const c of deterministicCandidates) {
    const aiEligible = isAmbiguousCandidate(c, minSamples);
    const aiForId = aiEligible && aiReview.ok ? aiReview.byId[c.interventionId] : undefined;
    const finalVerdict = blendDecisionWithSafetyGate(
      c.decision,
      c.riskLevel,
      c.sampleCount,
      minSamples,
      aiForId,
    );
    const actionMode = autoApplyLowRisk && ["low", "unknown"].includes(c.riskLevel)
      ? "auto_apply_allowed"
      : "shadow_only";

    decisions.push({
      ...c,
      deterministicDecision: c.decision,
      deterministicReason: c.reason,
      aiDecision: aiForId?.decision ?? null,
      aiConfidence: typeof aiForId?.confidence === "number" ? aiForId.confidence : null,
      aiRationale: aiForId?.rationale ?? null,
      aiReviewStatus: !aiEligible
        ? "skipped:not_ambiguous"
        : aiReview.ok
          ? (aiForId ? "ok" : "missing_review")
          : `failed:${aiReview.reason}`,
      decision: finalVerdict.decision,
      reason: finalVerdict.reason,
      decisionMode: finalVerdict.mode,
      actionMode,
    });
  }

  await writeJson(historyPath, {
    schemaVersion: 1,
    interventions,
    updatedAt: new Date().toISOString(),
  });

  const report = {
    schemaVersion: 1,
    cycleId: sample.cycleId,
    generatedAt: new Date().toISOString(),
    metrics: {
      completionRate,
      premiumEfficiency,
      healthScore,
      dispatched,
      completed,
    },
    aiReview: {
      enabled: config?.runtime?.interventionJudgeAiEnabled !== false,
      status: aiCandidates.length === 0 ? "skipped" : (aiReview.ok ? "ok" : "failed"),
      reason: aiReview.reason,
      requestedCandidates: aiCandidates.length,
      reviewedCandidates: aiReview.ok ? Object.keys(aiReview.byId || {}).length : 0,
    },
    decisions,
  };
  await writeJson(reportFilePath(config), report);

  return report;
}
