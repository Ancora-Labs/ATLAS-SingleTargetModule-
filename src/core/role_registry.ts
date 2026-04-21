/**
 * Canonical lane-to-worker name mapping.
 * Each capability lane has a dedicated worker identity.
 * "implementation" maps to the base evolution-worker.
 * All other lanes get specialized workers that share the same agent tooling.
 */
export const LANE_WORKER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  implementation:  "evolution-worker",
  quality:         "quality-worker",
  governance:      "governance-worker",
  infrastructure:  "infrastructure-worker",
  integration:     "integration-worker",
  observation:     "observation-worker",
});

/**
 * Per-worker capability declarations.
 * Maps worker name → ordered list of capability tags it handles best.
 * Used by scoreWorkerTaskFit() in capability_pool to produce a numeric fit score.
 *
 * Workers may declare multiple capabilities when they handle adjacent task types.
 * Single-capability workers receive a specialist bonus in fit scoring.
 */
export const WORKER_CAPABILITIES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "evolution-worker":      Object.freeze(["runtime-refactor", "integration", "planner-improvement"]),
  "quality-worker":        Object.freeze(["test-infra", "planner-improvement"]),
  "governance-worker":     Object.freeze(["state-governance"]),
  "infrastructure-worker": Object.freeze(["infrastructure"]),
  "integration-worker":    Object.freeze(["integration", "runtime-refactor"]),
  "observation-worker":    Object.freeze(["observation"]),
});

export const PROMETHEUS_PLANNING_MODE = Object.freeze({
  MASTER_EVOLUTION: "master_evolution",
  REPAIR_PLAN: "repair_plan",
} as const);

export type PrometheusPlanningMode =
  typeof PROMETHEUS_PLANNING_MODE[keyof typeof PROMETHEUS_PLANNING_MODE];

export const EXECUTION_PATTERN = Object.freeze({
  WAVE_PARALLEL: "wave_parallel",
  SINGLE_WORKER: "single_worker",
  BOUNDED_CHAIN: "bounded_chain",
  SERIAL_REPAIR: "serial_repair",
} as const);

export type ExecutionPattern =
  typeof EXECUTION_PATTERN[keyof typeof EXECUTION_PATTERN];

export interface WorkerTopologyRoleContract {
  role: string;
  lane: string;
  taskCount: number;
  waves: number[];
  specialized: boolean;
}

export interface WorkerTopologyLaneContract {
  lane: string;
  worker: string;
  taskCount: number;
  roleCount: number;
  specialized: boolean;
}

export interface WorkerTopologyContinuationContract {
  admittedLaneCount: number;
  admittedWorkerCount: number;
  remainingLaneCount: number;
  remainingWorkerCount: number;
  preservedLanes: string[];
  preservedRoles: string[];
  missingLanes: string[];
  missingRoles: string[];
  preservesMultiLaneAdmission: boolean;
  continuationRequired: boolean;
  reason: string;
}

export interface WorkerTopologyContract {
  schemaVersion: 1;
  planningMode: PrometheusPlanningMode;
  workerCount: number;
  laneCount: number;
  maxParallelWorkers: number;
  roles: WorkerTopologyRoleContract[];
  lanes: WorkerTopologyLaneContract[];
  continuation?: WorkerTopologyContinuationContract | null;
}

function normalizeTopologyNameList(values: unknown[]): string[] {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b));
}

function buildContinuationContract(
  admittedTopology: WorkerTopologyContract | null,
  currentRoles: WorkerTopologyRoleContract[],
  currentLanes: WorkerTopologyLaneContract[],
): WorkerTopologyContinuationContract | null {
  if (!admittedTopology || typeof admittedTopology !== "object") return null;

  const admittedLaneCount = Math.max(0, Math.floor(Number(admittedTopology.laneCount || 0)));
  const admittedWorkerCount = Math.max(0, Math.floor(Number(admittedTopology.workerCount || 0)));
  const admittedLanes = normalizeTopologyNameList(
    Array.isArray(admittedTopology.lanes) ? admittedTopology.lanes.map((lane) => lane?.lane) : [],
  );
  const admittedRoles = normalizeTopologyNameList(
    Array.isArray(admittedTopology.roles) ? admittedTopology.roles.map((role) => role?.role) : [],
  );
  const preservedLanes = normalizeTopologyNameList(currentLanes.map((lane) => lane.lane));
  const preservedRoles = normalizeTopologyNameList(currentRoles.map((role) => role.role));
  const missingLanes = admittedLanes.filter((lane) => !preservedLanes.includes(lane));
  const missingRoles = admittedRoles.filter((role) => !preservedRoles.includes(role));
  const continuationRequired = missingLanes.length > 0 || missingRoles.length > 0;
  if (!continuationRequired) return null;

  const preservesMultiLaneAdmission = admittedLaneCount > 1 && preservedLanes.length > 0 && preservedLanes.length < admittedLaneCount;
  return {
    admittedLaneCount,
    admittedWorkerCount,
    remainingLaneCount: preservedLanes.length,
    remainingWorkerCount: preservedRoles.length,
    preservedLanes,
    preservedRoles,
    missingLanes,
    missingRoles,
    preservesMultiLaneAdmission,
    continuationRequired: true,
    reason: preservesMultiLaneAdmission
      ? "preserved_admitted_multi_lane_topology_for_continuation"
      : "continuation_subset_of_admitted_topology",
  };
}

export function normalizeWorkerName(name: unknown): string {
  const raw = String(name || "").trim().toLowerCase();
  if (!raw) return "evolution-worker";
  if (raw === "evolution worker" || raw === "evolution-worker") return "evolution-worker";
  return raw.replace(/\s+/g, "-");
}

export function normalizePrometheusPlanningMode(
  value: unknown,
  fallback: PrometheusPlanningMode | null = PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
): PrometheusPlanningMode | null {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION) {
    return PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  }
  if (normalized === PROMETHEUS_PLANNING_MODE.REPAIR_PLAN) {
    return PROMETHEUS_PLANNING_MODE.REPAIR_PLAN;
  }
  return fallback;
}

export function normalizeExecutionPattern(
  value: unknown,
  fallback: ExecutionPattern | null = EXECUTION_PATTERN.WAVE_PARALLEL,
): ExecutionPattern | null {
  const normalized = String(value || "").trim().toLowerCase();
  const valid = Object.values(EXECUTION_PATTERN) as readonly string[];
  return valid.includes(normalized) ? normalized as ExecutionPattern : fallback;
}

export function isSpecialistWorkerName(name: unknown): boolean {
  return normalizeWorkerName(name) !== "evolution-worker";
}

export function normalizeTaskKindLabel(taskKind: unknown): string {
  return String(taskKind || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

export function getLaneForWorkerName(name: unknown, fallback = "implementation"): string {
  const normalized = normalizeWorkerName(name);
  for (const [lane, worker] of Object.entries(LANE_WORKER_NAMES)) {
    if (normalizeWorkerName(worker) === normalized) return lane;
  }
  return fallback;
}

/**
 * Normalize a plan role string to a registered executable worker name.
 *
 * Maps raw plan role strings (from Prometheus output) to the canonical worker
 * names in LANE_WORKER_NAMES. Unrecognized role strings fall back to
 * "evolution-worker" (the base implementation worker) so budget accounting
 * always resolves to a real worker identity.
 *
 * Examples:
 *   "Evolution Worker"  → "evolution-worker"  (via normalizeWorkerName + LANE match)
 *   "quality-worker"    → "quality-worker"
 *   "King David"        → "evolution-worker"   (unregistered → fallback)
 *   "governance"        → "governance-worker"  (lane key → worker name)
 *
 * @param role - raw role string from a Prometheus plan item
 * @returns registered worker name from LANE_WORKER_NAMES or "evolution-worker"
 */
export function normalizePlanRoleToWorkerName(role: unknown): string {
  const normalized = normalizeWorkerName(role);
  // Check if it directly matches a registered worker name
  const registeredWorkers = Object.values(LANE_WORKER_NAMES).map(w => normalizeWorkerName(w));
  if (registeredWorkers.includes(normalized)) return normalized;
  // Check if it matches a lane key (e.g., "governance" → "governance-worker")
  const laneKey = String(role || "").trim().toLowerCase();
  if (laneKey in LANE_WORKER_NAMES) return normalizeWorkerName(LANE_WORKER_NAMES[laneKey]);
  // Unregistered role: fall back to evolution-worker
  return "evolution-worker";
}

export function getSpecialistLaneNames(): string[] {
  return Object.keys(LANE_WORKER_NAMES).filter((lane) => lane !== "implementation");
}

export const SPECIALIST_LANE_RESERVATION_ORDER: readonly string[] = Object.freeze(getSpecialistLaneNames());

export function isSpecialistLane(lane: unknown): boolean {
  const normalized = String(lane || "").trim().toLowerCase();
  return normalized.length > 0 && normalized !== "implementation" && normalized in LANE_WORKER_NAMES;
}

export function buildWorkerTopologyContract(
  plans: unknown[],
  opts: { planningMode?: unknown; admittedWorkerTopology?: WorkerTopologyContract | null } = {},
): WorkerTopologyContract {
  const planningMode = normalizePrometheusPlanningMode(
    opts.planningMode,
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const roleMap = new Map<string, {
    role: string;
    lane: string;
    taskCount: number;
    waves: Set<number>;
    specialized: boolean;
  }>();
  const laneMap = new Map<string, {
    lane: string;
    worker: string;
    taskCount: number;
    roles: Set<string>;
    specialized: boolean;
  }>();
  const waveRoleMap = new Map<number, Set<string>>();

  for (const plan of Array.isArray(plans) ? plans : []) {
    if (!plan || typeof plan !== "object") continue;
    const src = plan as Record<string, unknown>;
    const role = normalizePlanRoleToWorkerName(src.role);
    const lane = String(src.capabilityLane || getLaneForWorkerName(role, "implementation")).trim().toLowerCase() || "implementation";
    const wave = Math.max(1, Math.floor(Number(src.wave) || 1));

    if (!roleMap.has(role)) {
      roleMap.set(role, {
        role,
        lane,
        taskCount: 0,
        waves: new Set<number>(),
        specialized: isSpecialistWorkerName(role),
      });
    }
    const roleEntry = roleMap.get(role)!;
    roleEntry.taskCount += 1;
    roleEntry.waves.add(wave);

    if (!laneMap.has(lane)) {
      laneMap.set(lane, {
        lane,
        worker: normalizePlanRoleToWorkerName(LANE_WORKER_NAMES[lane] || role),
        taskCount: 0,
        roles: new Set<string>(),
        specialized: isSpecialistLane(lane),
      });
    }
    const laneEntry = laneMap.get(lane)!;
    laneEntry.taskCount += 1;
    laneEntry.roles.add(role);

    if (!waveRoleMap.has(wave)) {
      waveRoleMap.set(wave, new Set<string>());
    }
    waveRoleMap.get(wave)!.add(role);
  }

  const roles = [...roleMap.values()]
    .map((entry) => ({
      role: entry.role,
      lane: entry.lane,
      taskCount: entry.taskCount,
      waves: [...entry.waves].sort((a, b) => a - b),
      specialized: entry.specialized,
    }))
    .sort((a, b) => a.role.localeCompare(b.role));

  const lanes = [...laneMap.values()]
    .map((entry) => ({
      lane: entry.lane,
      worker: entry.worker,
      taskCount: entry.taskCount,
      roleCount: entry.roles.size,
      specialized: entry.specialized,
    }))
    .sort((a, b) => a.lane.localeCompare(b.lane));

  const maxParallelWorkers = [...waveRoleMap.values()]
    .reduce((max, rolesInWave) => Math.max(max, rolesInWave.size), 0);

  return {
    schemaVersion: 1,
    planningMode,
    workerCount: roles.length,
    laneCount: lanes.length,
    maxParallelWorkers,
    roles,
    lanes,
    continuation: buildContinuationContract(opts.admittedWorkerTopology || null, roles, lanes),
  };
}

export function selectExecutionPatternForPlans(
  plans: unknown[],
  opts: {
    planningMode?: unknown;
    workerTopology?: WorkerTopologyContract | null;
    admittedWorkerTopology?: WorkerTopologyContract | null;
    uncertainty?: unknown;
  } = {},
): ExecutionPattern {
  const planningMode = normalizePrometheusPlanningMode(
    opts.planningMode,
    PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION,
  ) || PROMETHEUS_PLANNING_MODE.MASTER_EVOLUTION;
  const workerTopology = opts.workerTopology || buildWorkerTopologyContract(plans, {
    planningMode,
    admittedWorkerTopology: opts.admittedWorkerTopology || null,
  });
  if (planningMode === PROMETHEUS_PLANNING_MODE.REPAIR_PLAN) {
    return EXECUTION_PATTERN.SERIAL_REPAIR;
  }
  if (workerTopology.continuation?.preservesMultiLaneAdmission) {
    return EXECUTION_PATTERN.WAVE_PARALLEL;
  }
  const normalizedUncertainty = String(opts.uncertainty || "").trim().toLowerCase();
  const dependencySignals = (Array.isArray(plans) ? plans : []).reduce<number>((count, plan) => {
    if (!plan || typeof plan !== "object") return count;
    const source = plan as Record<string, unknown>;
    const hasDependencyEdges =
      (Array.isArray(source.dependsOn) && source.dependsOn.length > 0)
      || (Array.isArray(source.dependencies) && source.dependencies.length > 0)
      || (Array.isArray(source.waveDepends) && source.waveDepends.length > 0);
    return hasDependencyEdges ? count + 1 : count;
  }, 0);
  const distinctWaves = new Set(
    (Array.isArray(plans) ? plans : [])
      .map((plan) => Math.max(1, Math.floor(Number((plan as any)?.wave) || 1)))
      .filter(Number.isFinite),
  ).size;
  const hasDependencyEvidence = dependencySignals > 0 || distinctWaves > 1;
  if (
    hasDependencyEvidence
    && (
      workerTopology.laneCount <= 1
      || workerTopology.maxParallelWorkers <= 1
      || normalizedUncertainty === "high"
      || (normalizedUncertainty === "medium" && distinctWaves > 1)
    )
  ) {
    return EXECUTION_PATTERN.BOUNDED_CHAIN;
  }
  if (workerTopology.workerCount <= 1 && workerTopology.maxParallelWorkers <= 1) {
    return EXECUTION_PATTERN.SINGLE_WORKER;
  }
  return EXECUTION_PATTERN.WAVE_PARALLEL;
}

// ── Task-Lane Classification ───────────────────────────────────────────────────

/**
 * Deterministic task-lane kinds.
 *
 * WORKFLOW — scripted, tool-executable, deterministic sequences (CI, infra, pipelines).
 *            These tasks have fixed steps, known acceptance criteria, and run without
 *            AI deliberation beyond initial dispatch.
 *
 * AGENT    — tasks requiring AI reasoning, code generation, research, or review.
 *            These tasks benefit from full specialist worker attention and should
 *            not be short-circuited to workflow-style execution.
 */
export const TASK_LANE_KIND = Object.freeze({
  WORKFLOW: "workflow",
  AGENT:    "agent",
} as const);

export type TaskLaneKind = typeof TASK_LANE_KIND[keyof typeof TASK_LANE_KIND];

/**
 * Task-kind tokens that signal workflow-lane tasks (scripted, tool-executable).
 * Any plan whose taskKind normalized form matches one of these tokens is routed
 * to the WORKFLOW lane.
 */
export const WORKFLOW_TASK_KIND_TOKENS: ReadonlySet<string> = new Set([
  "ci",
  "ci-fix",
  "ci-repair",
  "infra",
  "infrastructure",
  "pipeline",
  "deploy",
  "release",
  "migration",
  "scaffold",
  "debt",
  "architecture-drift",
]);

/**
 * Task-text patterns that signal workflow tasks even when taskKind is absent.
 * Matched case-insensitively against the plan's task field.
 */
const WORKFLOW_TASK_TEXT_PATTERN =
  /\b(ci[- ]fix|ci[- ]repair|deploy|pipeline|release|scaffold|migration|infra(structure)?|docker|architecture[- ]drift)\b/i;

/**
 * Classify a plan as WORKFLOW or AGENT lane.
 *
 * Rules (in order, first match wins):
 *   1. If plan.taskLane is explicitly set and is a valid TASK_LANE_KIND, use it.
 *   2. If plan.taskKind normalized matches any WORKFLOW_TASK_KIND_TOKENS, → WORKFLOW.
 *   3. If plan.task matches WORKFLOW_TASK_TEXT_PATTERN, → WORKFLOW.
 *   4. Default: AGENT.
 *
 * @param plan — plan object (any shape; robust to missing fields)
 * @returns "workflow" | "agent"
 */
export function classifyTaskLaneKind(plan: unknown): TaskLaneKind {
  if (!plan || typeof plan !== "object") return TASK_LANE_KIND.AGENT;
  const p = plan as Record<string, unknown>;

  // 1. Explicit override
  const explicitLane = String(p.taskLane || "").trim().toLowerCase();
  if (explicitLane === TASK_LANE_KIND.WORKFLOW) return TASK_LANE_KIND.WORKFLOW;
  if (explicitLane === TASK_LANE_KIND.AGENT)    return TASK_LANE_KIND.AGENT;

  // 2. taskKind token match
  const taskKind = normalizeTaskKindLabel(p.taskKind);
  if (taskKind && WORKFLOW_TASK_KIND_TOKENS.has(taskKind)) return TASK_LANE_KIND.WORKFLOW;

  // 3. Task text pattern
  const taskText = String(p.task || "");
  if (WORKFLOW_TASK_TEXT_PATTERN.test(taskText)) return TASK_LANE_KIND.WORKFLOW;

  return TASK_LANE_KIND.AGENT;
}

const ATHENA_REVIEW_KIND_TOKENS = Object.freeze([
  "athena",
  "review",
  "postmortem",
  "post-mortem",
  "retrospective",
]);

const ATHENA_REVIEW_TEXT_PATTERN = /\b(athena|review|post[- ]?mortem|retrospective)\b/i;

export function isAthenaReviewOrPostmortemTask(taskKind: unknown, taskText: unknown = ""): boolean {
  const normalizedKind = normalizeTaskKindLabel(taskKind);
  if (normalizedKind && ATHENA_REVIEW_KIND_TOKENS.some((token) => normalizedKind.includes(token))) return true;
  return ATHENA_REVIEW_TEXT_PATTERN.test(String(taskText || ""));
}

export function getRoleRegistry(config) {
  const fallback = {
    ceoSupervisor: { id: "ceo-supervisor", name: "Janus", model: "Claude Sonnet 4.6" },
    planner: { id: "planner", name: "Prometheus", model: "gpt-5.4" },
    reviewer: { id: "reviewer", name: "Athena", model: "Claude Sonnet 4.6" },
    workers: {
      evolution:      { id: "worker-evolution",      name: "evolution-worker",      model: "gpt-5.4", lane: "implementation" },
      quality:        { id: "worker-quality",         name: "quality-worker",        model: "gpt-5.4", lane: "quality" },
      governance:     { id: "worker-governance",      name: "governance-worker",     model: "gpt-5.4", lane: "governance" },
      infrastructure: { id: "worker-infrastructure",  name: "infrastructure-worker", model: "gpt-5.4", lane: "infrastructure" },
      integration:    { id: "worker-integration",     name: "integration-worker",    model: "gpt-5.4", lane: "integration" },
      observation:    { id: "worker-observation",     name: "observation-worker",    model: "gpt-5.4", lane: "observation" },
    }
  };

  return {
    ...fallback,
    ...(config?.roleRegistry || {}),
    workers: {
      ...fallback.workers,
      ...(config?.roleRegistry?.workers || {})
    }
  };
}

export function assertRoleCapabilityForTask(config, roleName: unknown, taskKind: unknown, taskText: unknown = "") {
  const registry = getRoleRegistry(config);
  const normalizedRole = normalizeWorkerName(roleName);
  const workers = Object.values(registry?.workers || {}) as Array<{ name?: string }>;
  const registeredWorkerNames = new Set(workers.map((worker) => normalizeWorkerName(worker?.name)));
  const registeredLeadershipNames = new Set([
    normalizeWorkerName(registry?.reviewer?.name || "Athena"),
    normalizeWorkerName(registry?.planner?.name || "Prometheus"),
    normalizeWorkerName(registry?.ceoSupervisor?.name || "Janus"),
    "athena",
    "prometheus",
    "janus",
  ]);

  const roleKnown = registeredWorkerNames.has(normalizedRole) || registeredLeadershipNames.has(normalizedRole);
  if (!roleKnown) {
    return {
      allowed: false,
      code: "ROLE_NOT_REGISTERED",
      message: `Role '${String(roleName || "unknown")}' is not present in role registry`,
      athenaRelated: false,
      requiresFileShellTools: false,
    };
  }

  const athenaRelated = isAthenaReviewOrPostmortemTask(taskKind, taskText);
  if (!athenaRelated) {
    return {
      allowed: true,
      code: "OK",
      message: "Role capability check passed",
      athenaRelated: false,
      requiresFileShellTools: false,
    };
  }

  const rolesWithAthenaReviewCapability = new Set([
    "evolution-worker",
    "quality-worker",
    "athena",
    "prometheus",
  ]);
  const hasCapability = rolesWithAthenaReviewCapability.has(normalizedRole);
  if (!hasCapability) {
    return {
      allowed: false,
      code: "ROLE_CAPABILITY_MISMATCH",
      message: `Role '${String(roleName || "unknown")}' lacks athena-review/postmortem capability`,
      athenaRelated: true,
      requiresFileShellTools: true,
    };
  }

  return {
    allowed: true,
    code: "OK",
    message: "Role capability check passed",
    athenaRelated: true,
    requiresFileShellTools: true,
  };
}

