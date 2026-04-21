import { PLATFORM_MODE } from "./mode_state.js";
import { TARGET_SESSION_STAGE } from "./target_session_state.js";
import { isNonSpecificVerification } from "./plan_contract_validator.js";

export const SHADOW_SAFE_TASK_KINDS = Object.freeze([
  "planning",
  "test",
  "ci-fix",
  "observation",
  "analysis",
  "docs",
  "documentation",
  "verification",
  "implementation",
  "bugfix",
]);

const SHADOW_IMPLEMENTATION_LIKE_TASK_KINDS = Object.freeze([
  "implementation",
  "bugfix",
]);

export const SHADOW_MAX_TARGET_FILES = 4;
export const SHADOW_EXPANDED_TARGET_FILE_LIMIT = 8;
export const SHADOW_MAX_IMPLEMENTATION_PLANS = 1;
export const SHADOW_EVIDENCE_TASK_KINDS = Object.freeze([
  "test",
  "observation",
  "analysis",
  "verification",
]);

export const SHADOW_HIGH_RISK_PATTERNS = Object.freeze([
  "deploy",
  "production",
  "release",
  "rollout",
  "migrate",
  "schema",
  "secret rotation",
  "force push",
]);

export const TARGET_STAGE_CONTRACT_CODE = Object.freeze({
  SHADOW_TASK_KIND_NOT_ALLOWED: "shadow_task_kind_not_allowed",
  SHADOW_SCOPE_TOO_LARGE: "shadow_scope_too_large",
  SHADOW_HIGH_RISK_ACTION: "shadow_high_risk_action",
  SHADOW_TOO_MANY_IMPLEMENTATION_PLANS: "shadow_too_many_implementation_plans",
  SHADOW_IMPLEMENTATION_REQUIRES_VERIFICATION: "shadow_implementation_requires_verification",
  SHADOW_EVIDENCE_REQUIRED: "shadow_evidence_required",
});

function normalizeString(value: unknown): string {
  return String(value || "").trim();
}

function normalizeTaskKind(value: unknown): string {
  return normalizeString(value).toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeString(value);
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function getShadowTargetFileLimit(taskKind: string): number {
  if (["planning", "test", "observation", "analysis", "docs", "documentation", "verification"].includes(taskKind)) {
    return SHADOW_EXPANDED_TARGET_FILE_LIMIT;
  }
  return SHADOW_MAX_TARGET_FILES;
}

function isEvidenceOnlyFile(filePath: string): boolean {
  const normalized = normalizeString(filePath).replace(/\\/g, "/").toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith("tests/")
    || normalized.includes("/__tests__/")
    || normalized.startsWith("docs/")
    || /\.(test|spec)\.[a-z0-9]+$/i.test(normalized);
}

function getShadowScopedFileCount(taskKind: string, targetFiles: string[]): number {
  if (SHADOW_IMPLEMENTATION_LIKE_TASK_KINDS.includes(taskKind)) {
    return targetFiles.filter((filePath) => !isEvidenceOnlyFile(filePath)).length;
  }
  return targetFiles.length;
}

function extractTargetFiles(entry: Record<string, unknown>): string[] {
  return normalizeStringArray(
    entry?.target_files
    ?? entry?.targetFiles
    ?? entry?.changedFiles
    ?? entry?.filesTouched,
  );
}

function buildPlanSignal(entry: Record<string, unknown>): string {
  return [
    entry?.task,
    entry?.scope,
    entry?.context,
    entry?.verification,
    entry?.before_state,
    entry?.after_state,
    entry?.beforeState,
    entry?.afterState,
  ]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join("\n");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findUnnegatedHighRiskPattern(signal: string): string | null {
  const clauses = signal.split(/[\n.!?;]+/).map((entry) => entry.trim()).filter(Boolean);
  for (const pattern of SHADOW_HIGH_RISK_PATTERNS) {
    const patternRegex = new RegExp(`\\b${escapeRegExp(pattern)}\\b`, "i");
    for (const clause of clauses) {
      if (!patternRegex.test(clause)) continue;
      const negated = /\b(do not|don't|dont|avoid|without|forbid|forbidden|no)\b/i.test(clause);
      if (!negated) {
        return pattern;
      }
    }
  }
  return null;
}

function hasConcreteVerification(entry: Record<string, unknown>): boolean {
  const verification = normalizeString(entry?.verification);
  return verification.length >= 5 && !isNonSpecificVerification(verification);
}

function isEvidenceProducingEntry(entry: Record<string, unknown>): boolean {
  const taskKind = normalizeTaskKind(entry?.taskKind ?? entry?.kind ?? "implementation") || "implementation";
  return SHADOW_EVIDENCE_TASK_KINDS.includes(taskKind) || hasConcreteVerification(entry);
}

export function buildShadowStageDisciplineLines(): string[] {
  return [
    `Allowed task kinds only: ${SHADOW_SAFE_TASK_KINDS.join(", ")}.`,
    `Shadow mode only exists to prove one low-risk cycle outcome before active delivery broadens scope.`,
    `At most ${SHADOW_MAX_IMPLEMENTATION_PLANS} bounded implementation packet may appear in shadow mode; use it only for a small low-risk proving step.`,
    `Keep low-risk audit/planning packets scoped to at most ${SHADOW_EXPANDED_TARGET_FILE_LIMIT} target file(s); ci-fix packets remain capped at ${SHADOW_MAX_TARGET_FILES}.`,
    `Any shadow implementation packet must stay within ${SHADOW_MAX_TARGET_FILES} target file(s), avoid broad delivery or release intent, and carry concrete verification.`,
    `Every shadow cycle must produce evidence: keep at least one verification, test, observation, analysis, or concretely verified implementation packet in the admitted batch.`,
    `Forbidden high-risk intents in shadow mode: ${SHADOW_HIGH_RISK_PATTERNS.join(", ")}.`,
  ];
}

export function isShadowStageRuntime(config: any): boolean {
  return config?.platformModeState?.currentMode === PLATFORM_MODE.SINGLE_TARGET_DELIVERY
    && config?.activeTargetSession?.currentStage === TARGET_SESSION_STAGE.SHADOW
    && config?.activeTargetSession?.gates?.allowShadowExecution === true
    && config?.activeTargetSession?.gates?.allowActiveExecution !== true;
}

export type TargetStagePlanViolation = {
  code: string;
  message: string;
  planIndex: number | null;
  taskKind: string;
  task: string;
};

export type TargetStagePlanSplitResult = {
  active: boolean;
  stage: string | null;
  admittedPlans: unknown[];
  rejectedPlans: Array<{
    plan: unknown;
    planIndex: number | null;
    violations: TargetStagePlanViolation[];
  }>;
  summary: string | null;
};

export function evaluateShadowPlanEntryContract(
  entry: Record<string, unknown>,
  planIndex: number | null = null,
): TargetStagePlanViolation[] {
  const taskKind = normalizeTaskKind(entry?.taskKind ?? entry?.kind ?? "implementation") || "implementation";
  const task = normalizeString(entry?.task || entry?.title || "unknown");
  const targetFiles = extractTargetFiles(entry);
  const signal = buildPlanSignal(entry);
  const targetFileLimit = getShadowTargetFileLimit(taskKind);
  const scopedFileCount = getShadowScopedFileCount(taskKind, targetFiles);
  const violations: TargetStagePlanViolation[] = [];

  if (!SHADOW_SAFE_TASK_KINDS.includes(taskKind)) {
    violations.push({
      code: TARGET_STAGE_CONTRACT_CODE.SHADOW_TASK_KIND_NOT_ALLOWED,
      message: `shadow mode only allows low-risk task kinds; received ${taskKind}`,
      planIndex,
      taskKind,
      task,
    });
  }

  if (scopedFileCount > targetFileLimit) {
    violations.push({
      code: TARGET_STAGE_CONTRACT_CODE.SHADOW_SCOPE_TOO_LARGE,
      message: `shadow mode limits planned scope to ${targetFileLimit} files for ${taskKind}; received ${scopedFileCount}`,
      planIndex,
      taskKind,
      task,
    });
  }

  const matchedPattern = findUnnegatedHighRiskPattern(signal);
  if (matchedPattern) {
    violations.push({
      code: TARGET_STAGE_CONTRACT_CODE.SHADOW_HIGH_RISK_ACTION,
      message: `shadow mode forbids high-risk action intent: ${matchedPattern}`,
      planIndex,
      taskKind,
      task,
    });
  }

  if (SHADOW_IMPLEMENTATION_LIKE_TASK_KINDS.includes(taskKind) && !hasConcreteVerification(entry)) {
    violations.push({
      code: TARGET_STAGE_CONTRACT_CODE.SHADOW_IMPLEMENTATION_REQUIRES_VERIFICATION,
      message: "shadow implementation packets must include concrete verification evidence, not a vague or missing verification step",
      planIndex,
      taskKind,
      task,
    });
  }

  return violations;
}

export function evaluateTargetStagePlanContract(plans: unknown[], config: any): {
  active: boolean;
  valid: boolean;
  stage: string | null;
  dispatchBlockReason: string | null;
  summary: string | null;
  violations: TargetStagePlanViolation[];
} {
  if (!isShadowStageRuntime(config)) {
    return {
      active: false,
      valid: true,
      stage: normalizeString(config?.activeTargetSession?.currentStage).toLowerCase() || null,
      dispatchBlockReason: null,
      summary: null,
      violations: [],
    };
  }

  const normalizedPlans = Array.isArray(plans) ? plans : [];
  const violations = normalizedPlans.flatMap((plan, index) => (
    plan && typeof plan === "object"
      ? evaluateShadowPlanEntryContract(plan as Record<string, unknown>, index)
      : [{
        code: TARGET_STAGE_CONTRACT_CODE.SHADOW_TASK_KIND_NOT_ALLOWED,
        message: "shadow mode received a non-object plan entry",
        planIndex: index,
        taskKind: "implementation",
        task: "unknown",
      }]
  ));

  if (violations.length === 0 && normalizedPlans.length > 0) {
    const hasEvidence = normalizedPlans.some((plan) => plan && typeof plan === "object" && isEvidenceProducingEntry(plan as Record<string, unknown>));
    if (!hasEvidence) {
      violations.push({
        code: TARGET_STAGE_CONTRACT_CODE.SHADOW_EVIDENCE_REQUIRED,
        message: "shadow mode requires at least one evidence-producing packet in the admitted cycle outcome",
        planIndex: null,
        taskKind: "batch",
        task: "shadow-cycle",
      });
    }
  }

  return {
    active: true,
    valid: violations.length === 0,
    stage: TARGET_SESSION_STAGE.SHADOW,
    dispatchBlockReason: violations.length > 0 ? `target_stage_contract:${violations[0].code}` : null,
    summary: violations.length > 0
      ? violations.map((violation) => {
        const indexLabel = violation.planIndex === null ? "plan[unknown]" : `plan[${violation.planIndex}]`;
        return `${indexLabel} ${violation.message}`;
      }).join(" | ")
      : null,
    violations,
  };
}

export function splitTargetStagePlans(plans: unknown[], config: any): TargetStagePlanSplitResult {
  const normalizedPlans = Array.isArray(plans) ? plans : [];
  if (!isShadowStageRuntime(config)) {
    return {
      active: false,
      stage: normalizeString(config?.activeTargetSession?.currentStage).toLowerCase() || null,
      admittedPlans: normalizedPlans,
      rejectedPlans: [],
      summary: null,
    };
  }

  const admittedPlans: unknown[] = [];
  const rejectedPlans: Array<{
    plan: unknown;
    planIndex: number | null;
    violations: TargetStagePlanViolation[];
  }> = [];
  let admittedImplementationCount = 0;

  for (let index = 0; index < normalizedPlans.length; index += 1) {
    const plan = normalizedPlans[index];
    const violations = plan && typeof plan === "object"
      ? evaluateShadowPlanEntryContract(plan as Record<string, unknown>, index)
      : [{
        code: TARGET_STAGE_CONTRACT_CODE.SHADOW_TASK_KIND_NOT_ALLOWED,
        message: "shadow mode received a non-object plan entry",
        planIndex: index,
        taskKind: "implementation",
        task: "unknown",
      }];
    const taskKind = plan && typeof plan === "object"
      ? normalizeTaskKind((plan as Record<string, unknown>)?.taskKind ?? (plan as Record<string, unknown>)?.kind ?? "implementation") || "implementation"
      : "implementation";
    if (violations.length === 0 && SHADOW_IMPLEMENTATION_LIKE_TASK_KINDS.includes(taskKind)) {
      if (admittedImplementationCount >= SHADOW_MAX_IMPLEMENTATION_PLANS) {
        violations.push({
          code: TARGET_STAGE_CONTRACT_CODE.SHADOW_TOO_MANY_IMPLEMENTATION_PLANS,
          message: `shadow mode allows at most ${SHADOW_MAX_IMPLEMENTATION_PLANS} bounded implementation packet per cycle`,
          planIndex: index,
          taskKind,
          task: normalizeString((plan as Record<string, unknown>)?.task || (plan as Record<string, unknown>)?.title || "unknown"),
        });
      }
    }
    if (violations.length === 0) {
      admittedPlans.push(plan);
      if (SHADOW_IMPLEMENTATION_LIKE_TASK_KINDS.includes(taskKind)) {
        admittedImplementationCount += 1;
      }
      continue;
    }
    rejectedPlans.push({
      plan,
      planIndex: index,
      violations,
    });
  }

  if (admittedPlans.length > 0) {
    const hasEvidence = admittedPlans.some((plan) => plan && typeof plan === "object" && isEvidenceProducingEntry(plan as Record<string, unknown>));
    if (!hasEvidence) {
      while (admittedPlans.length > 0) {
        const plan = admittedPlans.pop();
        const planIndex = normalizedPlans.indexOf(plan);
        rejectedPlans.push({
          plan,
          planIndex: planIndex >= 0 ? planIndex : null,
          violations: [{
            code: TARGET_STAGE_CONTRACT_CODE.SHADOW_EVIDENCE_REQUIRED,
            message: "shadow mode requires at least one evidence-producing packet in the admitted cycle outcome",
            planIndex: planIndex >= 0 ? planIndex : null,
            taskKind: "batch",
            task: normalizeString((plan as Record<string, unknown>)?.task || (plan as Record<string, unknown>)?.title || "shadow-cycle"),
          }],
        });
      }
    }
  }

  return {
    active: true,
    stage: TARGET_SESSION_STAGE.SHADOW,
    admittedPlans,
    rejectedPlans,
    summary: rejectedPlans.length > 0
      ? rejectedPlans.flatMap(({ violations }) => violations.map((violation) => {
        const indexLabel = violation.planIndex === null ? "plan[unknown]" : `plan[${violation.planIndex}]`;
        return `${indexLabel} ${violation.message}`;
      })).join(" | ")
      : null,
  };
}