import path from "node:path";

export const POSTMORTEM_LIFECYCLE_STATE = Object.freeze({
  CONTINUING: "continuing",
  CLOSED: "closed",
  UNVERIFIED_COMPLETION_CLAIM: "unverified_completion_claim",
} as const);

export type PostmortemLifecycleEvidenceEnvelope = {
  schemaVersion: 1;
  source: "athena_postmortem";
  task: string;
  taskIdentity: string;
  continuationFamilyKey: string;
  lifecycleState: typeof POSTMORTEM_LIFECYCLE_STATE[keyof typeof POSTMORTEM_LIFECYCLE_STATE];
  advisoryOnly: boolean;
  verified: boolean;
  implementationEvidence: string[];
  verification: {
    verificationPassed: boolean | null;
    doneWorkerWithVerificationReportEvidence: boolean;
    doneWorkerWithCleanTreeStatusEvidence: boolean;
    replayClosureSatisfied: boolean;
    closureBoundaryViolation: boolean;
  };
  emittedAt: string;
};

export type JanusStrategyExpectedOutcomeArtifact = {
  expectedSystemHealthAfter: string | null;
  expectedNextDecision: string | null;
  expectedAthenaActivated: boolean | null;
  expectedPrometheusRan: boolean | null;
  expectedWorkItemCount: number | null;
  forecastConfidence: string | null;
};

export type JanusStrategyBriefArtifact = {
  schemaVersion: 1;
  source: "janus_strategy_brief";
  decision: string;
  systemHealth: string;
  wakeAthena: boolean;
  callPrometheus: boolean;
  briefForPrometheus: string;
  priorities: string[];
  workerSuggestions: string[];
  expectedOutcome: JanusStrategyExpectedOutcomeArtifact | null;
  capacityDelta: {
    topBottleneckAreas: string[];
    commandedInterventions: string[];
  };
  repo: string | null;
  emittedAt: string;
};

export type PrometheusPlanProvenanceArtifact = {
  source: string | null;
  reason: string | null;
  confidence: number | null;
  tag: string | null;
  attachedAt: string | null;
};

export type PrometheusPlanArtifact = {
  schemaVersion: 1;
  source: "prometheus_plan";
  taskIdentity: string;
  taskId: string;
  task: string;
  title: string;
  role: string;
  wave: number;
  scope: string;
  targetFiles: string[];
  acceptanceCriteria: string[];
  verificationCommands: string[];
  riskLevel: string;
  dependencies: string[];
  continuationFamilyKey: string;
  provenance: PrometheusPlanProvenanceArtifact;
  emittedAt: string;
};

export type AthenaReviewFinding = {
  planIndex: number;
  taskIdentity: string;
  role: string;
  measurable: boolean;
  successCriteriaClear: boolean;
  verificationConcrete: boolean;
  scopeDefined: boolean;
  preMortemComplete: boolean;
  issues: string[];
  suggestion: string;
};

export type AthenaReviewFindingArtifact = {
  schemaVersion: 1;
  source: "athena_review_findings";
  approved: boolean;
  overallScore: number | null;
  summary: string;
  corrections: string[];
  appliedFixes: string[];
  unresolvedIssues: string[];
  gateRisk: {
    level: string;
    reason: string | null;
    signals: string[];
    requiresCorrection: boolean;
  };
  findings: AthenaReviewFinding[];
  emittedAt: string;
};

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function normalizeBooleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeNumberOrNull(value: unknown): number | null {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function extractPlanTargetFiles(source: any): string[] {
  const raw = Array.isArray(source?.targetFiles)
    ? source.targetFiles
    : Array.isArray(source?.target_files)
      ? source.target_files
      : [];
  return normalizeStringList(raw);
}

function extractPlanVerificationCommands(source: any): string[] {
  const commands = normalizeStringList(source?.verificationCommands ?? source?.verification_commands);
  if (commands.length > 0) return commands;
  return normalizeStringList(source?.verification);
}

function extractPlanAcceptanceCriteria(source: any): string[] {
  return normalizeStringList(source?.acceptanceCriteria ?? source?.acceptance_criteria);
}

function extractPlanDependencies(source: any): string[] {
  return normalizeStringList(source?.dependencies);
}

export function buildJanusStrategyBriefArtifact(
  directive: any,
  expectedOutcome: any,
  opts: { repo?: string | null; emittedAt?: string } = {},
): JanusStrategyBriefArtifact {
  const emittedAt = String(opts.emittedAt || directive?.decidedAt || new Date().toISOString());
  const capacityDelta = directive?.capacityDelta && typeof directive.capacityDelta === "object"
    ? directive.capacityDelta
    : {};
  return {
    schemaVersion: 1,
    source: "janus_strategy_brief",
    decision: String(directive?.decision || "").trim(),
    systemHealth: String(directive?.systemHealth || "").trim(),
    wakeAthena: directive?.wakeAthena === true,
    callPrometheus: directive?.callPrometheus === true,
    briefForPrometheus: String(directive?.briefForPrometheus || "").trim(),
    priorities: normalizeStringList(directive?.priorities),
    workerSuggestions: normalizeStringList(directive?.workerSuggestions),
    expectedOutcome: expectedOutcome && typeof expectedOutcome === "object"
      ? {
          expectedSystemHealthAfter: String(expectedOutcome.expectedSystemHealthAfter || "").trim() || null,
          expectedNextDecision: String(expectedOutcome.expectedNextDecision || "").trim() || null,
          expectedAthenaActivated: normalizeBooleanOrNull(expectedOutcome.expectedAthenaActivated),
          expectedPrometheusRan: normalizeBooleanOrNull(expectedOutcome.expectedPrometheusRan),
          expectedWorkItemCount: normalizeNumberOrNull(expectedOutcome.expectedWorkItemCount),
          forecastConfidence: String(expectedOutcome.forecastConfidence || "").trim() || null,
        }
      : null,
    capacityDelta: {
      topBottleneckAreas: Array.isArray(capacityDelta?.topBottlenecks)
        ? capacityDelta.topBottlenecks
          .map((entry: any) => String(entry?.area || entry?.description || "").trim())
          .filter(Boolean)
        : [],
      commandedInterventions: Array.isArray(capacityDelta?.commandedInterventions)
        ? capacityDelta.commandedInterventions
          .map((entry: any) => String(entry?.action || entry?.capability || "").trim())
          .filter(Boolean)
        : [],
    },
    repo: typeof opts.repo === "string" && opts.repo.trim() ? opts.repo.trim() : null,
    emittedAt,
  };
}

function buildPrometheusPlanProvenanceArtifact(source: any): PrometheusPlanProvenanceArtifact {
  const provenance = source?._provenance && typeof source._provenance === "object"
    ? source._provenance
    : source?.provenance && typeof source.provenance === "object"
      ? source.provenance
      : null;
  return {
    source: provenance ? String(provenance.source || "").trim() || null : null,
    reason: provenance ? String(provenance.reason || "").trim() || null : null,
    confidence: provenance && Number.isFinite(Number(provenance.confidence))
      ? Number(provenance.confidence)
      : null,
    tag: provenance ? String(provenance.tag || "").trim() || null : null,
    attachedAt: provenance ? String(provenance.attachedAt || "").trim() || null : null,
  };
}

export function buildPrometheusPlanArtifact(
  source: any,
  opts: { emittedAt?: string } = {},
): PrometheusPlanArtifact {
  const task = String(source?.task || source?.title || source?.task_id || source?.id || "").trim();
  const taskId = String(source?.task_id || source?.id || task).trim();
  const targetFiles = extractPlanTargetFiles(source);
  const taskIdentity = normalizePlanIdentity(taskId || task);
  return {
    schemaVersion: 1,
    source: "prometheus_plan",
    taskIdentity,
    taskId,
    task,
    title: String(source?.title || task).trim(),
    role: String(source?.role || "unknown").trim() || "unknown",
    wave: Number.isFinite(Number(source?.wave)) ? Number(source.wave) : 1,
    scope: String(source?.scope || "").trim(),
    targetFiles,
    acceptanceCriteria: extractPlanAcceptanceCriteria(source),
    verificationCommands: extractPlanVerificationCommands(source),
    riskLevel: String(source?.riskLevel || "low").trim().toLowerCase() || "low",
    dependencies: extractPlanDependencies(source),
    continuationFamilyKey: derivePlanContinuationFamilyKey({
      ...source,
      targetFiles,
      target_files: targetFiles,
    }),
    provenance: buildPrometheusPlanProvenanceArtifact(source),
    emittedAt: String(opts.emittedAt || source?.emittedAt || new Date().toISOString()),
  };
}

export function getPrometheusPlanArtifact(
  source: any,
  opts: { emittedAt?: string } = {},
): PrometheusPlanArtifact | null {
  const embedded = source?.planArtifact;
  if (
    embedded
    && typeof embedded === "object"
    && embedded.source === "prometheus_plan"
    && typeof embedded.task === "string"
    && embedded.task.trim()
  ) {
    return embedded as PrometheusPlanArtifact;
  }
  const task = String(source?.task || source?.title || source?.task_id || source?.id || "").trim();
  return task ? buildPrometheusPlanArtifact(source, opts) : null;
}

export function buildAthenaReviewFindingArtifact(
  reviewResult: any,
  plans: any[] = [],
  opts: {
    emittedAt?: string;
    gateRisk?: {
      gateBlockRisk?: string;
      reason?: string | null;
      activeGateSignals?: string[];
      gateBlockSignals?: string[];
      requiresCorrection?: boolean;
    };
  } = {},
): AthenaReviewFindingArtifact {
  const reviews = Array.isArray(reviewResult?.planReviews) ? reviewResult.planReviews : [];
  const findings: AthenaReviewFinding[] = reviews.map((review: any, index: number) => {
    const planIndex = Number.isInteger(review?.planIndex) ? review.planIndex : index;
    const planArtifact = getPrometheusPlanArtifact(plans[planIndex] || {});
    return {
      planIndex,
      taskIdentity: planArtifact?.taskIdentity || normalizePlanIdentity(plans[planIndex]?.task || ""),
      role: String(review?.role || plans[planIndex]?.role || "unknown").trim() || "unknown",
      measurable: review?.measurable === true,
      successCriteriaClear: review?.successCriteriaClear === true,
      verificationConcrete: review?.verificationConcrete === true,
      scopeDefined: review?.scopeDefined === true,
      preMortemComplete: review?.preMortemComplete === true,
      issues: normalizeStringList(review?.issues),
      suggestion: String(review?.suggestion || "").trim(),
    };
  });
  const gateRisk = opts.gateRisk || {};
  const signals = normalizeStringList(gateRisk.activeGateSignals ?? gateRisk.gateBlockSignals);
  return {
    schemaVersion: 1,
    source: "athena_review_findings",
    approved: reviewResult?.approved === true,
    overallScore: Number.isFinite(Number(reviewResult?.overallScore)) ? Number(reviewResult.overallScore) : null,
    summary: String(reviewResult?.summary || "").trim(),
    corrections: normalizeStringList(reviewResult?.corrections),
    appliedFixes: normalizeStringList(reviewResult?.appliedFixes),
    unresolvedIssues: normalizeStringList(reviewResult?.unresolvedIssues),
    gateRisk: {
      level: String(
        reviewResult?.gateBlockRisk
          || reviewResult?.gateBlockRiskAtApproval
          || gateRisk.gateBlockRisk
          || "unknown",
      ).trim() || "unknown",
      reason: String(reviewResult?.gateBlockRiskReason || gateRisk.reason || "").trim() || null,
      signals,
      requiresCorrection: reviewResult?.gateRiskRequiresCorrection === true || gateRisk.requiresCorrection === true,
    },
    findings,
    emittedAt: String(opts.emittedAt || reviewResult?.reviewedAt || new Date().toISOString()),
  };
}

const PLAN_FAMILY_STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "into", "that", "this", "when", "then", "than", "while",
  "under", "over", "onto", "after", "before", "across", "only", "does", "not", "are",
  "is", "was", "were", "have", "has", "had", "will", "would", "should", "could", "must", "can",
  "your", "their", "them", "they", "each", "same", "keep", "more", "less", "very",
  "plan", "task", "worker", "route", "routing",
]);

export function normalizePlanIdentity(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePlanFamilySegment(value: unknown): string[] {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && !PLAN_FAMILY_STOP_WORDS.has(part));
}

function extractPlanFamilyFileTokens(targetFiles: unknown): string[] {
  if (!Array.isArray(targetFiles)) return [];
  const tokens: string[] = [];
  for (const file of targetFiles) {
    const base = path.basename(String(file || "")).replace(/\.[^.]+$/, "");
    tokens.push(...normalizePlanFamilySegment(base));
  }
  return Array.from(new Set(tokens)).sort().slice(0, 4);
}

export function derivePlanContinuationFamilyKey(source: any): string {
  const explicitKey = String(
    source?.continuationFamilyKey
      || source?.familyKey
      || source?._familyKey
      || "",
  ).trim();
  if (explicitKey) return explicitKey.toLowerCase();

  const textTokens = Array.from(new Set([
    ...normalizePlanFamilySegment(source?.scope),
    ...normalizePlanFamilySegment(source?.title),
    ...normalizePlanFamilySegment(source?.task),
    ...normalizePlanFamilySegment(source?.task_id),
  ])).slice(0, 6);
  const fileTokens = extractPlanFamilyFileTokens(source?.targetFiles ?? source?.target_files);
  return [...fileTokens, ...textTokens].slice(0, 8).join(":");
}

export function extractImplementationEvidencePaths(evidence: unknown): string[] {
  const values = Array.isArray(evidence)
    ? evidence
    : typeof evidence === "string"
      ? [evidence]
      : [];
  return values
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .map((item) => {
      const match = item.match(/(?:src|tests|scripts|docs)\/[A-Za-z0-9_./-]+/);
      return match ? match[0].replace(/[),.;:]+$/, "") : "";
    })
    .filter(Boolean);
}

