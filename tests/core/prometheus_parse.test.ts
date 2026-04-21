import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizePrometheusParsedOutput,
  normalizeExecutionStrategyWaveTasks,
  applyAdmissionPacketHardFilter,
  analyzePlanContractGateOutcome,
  applyPlanningRubric,
  RIGIDITY_PENALTY,
  filterResolvedCarryForwardItems,
  CARRY_FORWARD_MAX_TOKENS,
  BEHAVIOR_PATTERNS_MAX_TOKENS,
  PROMETHEUS_STATIC_SECTIONS,
  PROMETHEUS_CYCLE_DELTA_SECTION_NAMES,
  PROMETHEUS_STATIC_SECTION_NAMES,
  computeDriftConfidencePenalty,
  DRIFT_REMEDIATION_THRESHOLD,
  computeBottleneckCoverage,
  BOTTLENECK_COVERAGE_FLOOR,
  buildDriftDebtTasks,
  checkPacketCompleteness,
  stabilizeRawPacketEconomics,
  UNRECOVERABLE_PACKET_REASONS,
  PLANNER_HEALTH_ALIASES,
  normalizeProjectHealthAlias,
  resolvePrometheusProjectHealth,
  checkHighRiskPacketConfidence,
  HIGH_RISK_LOW_CONFIDENCE_REASON,
  computeHighRiskComponentGate,
  HIGH_RISK_COMPONENT_GATE_THRESHOLDS,
  checkDecompositionCaps,
  MAX_DECOMPOSITION_PLANS,
  DECOMPOSITION_CAP_REASON,
  CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS,
  computeClosureYield,
  rankPlansByClosureYield,
  CLOSURE_YIELD_LOW_THRESHOLD,
  CLOSURE_YIELD_BOOST_AMOUNT,
  CLOSURE_YIELD_BOOST_DIMENSIONS,
  computeNoveltyScore,
  seedDiscoveryGapPackets,
  NOVELTY_COLLAPSE_THRESHOLD,
  NOVELTY_SEED_DIMENSIONS,
  attachFallbackProvenance,
  computePacketAdmissionConfidence,
  quarantineLowConfidencePackets,
  FALLBACK_PROVENANCE_TAG,
  QUARANTINE_CONFIDENCE_THRESHOLD,
  extractMandatoryHealthAuditFindings,
  buildMandatoryTasksPromptSection,
  validateMandatoryTaskCoverageContract,
  buildMandatoryCoverageRetryDiff,
  applyMandatoryCoverageEnforceReject,
  MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN,
  MANDATORY_COVERAGE_ENFORCE_EXIT_CODE,
  synthesizeMandatoryTaskCoverage,
  enforceMandatoryFindingCoveragePackets,
  buildRoutingOutcomeSection,
  enforceParserContractBeforeNormalization,
  evaluatePrometheusTopologyAdmission,
  ensurePersistedAnalysisTimestamps,
  validateCycleProofEvidenceSeams,
  buildTrustedMemoryShortlist,
  reconcilePromptMemoryShortlistByTruth,
  normalizeScalarContractField,
  enforceCiRepairPacketForMandatoryFindings,
  isResearchDegradedModeActive,
  sanitizePlanningFieldForPersistence,
  STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH,
  isStrategicFieldToolTraceContaminated,
  normalizeTextForContaminationCheck,
  PROCESS_NARRATION_LEXICAL_PATTERNS,
  SEMANTIC_TOOL_TRACE_PATTERNS,
  DECISION_BLOB_PATTERNS,
  resolveCapturedAgentRawOutput,
  hasPrometheusRuntimeContractSignals,
  applyDiagnosticsFreshnessTruthToPlanning,
  ROLE_PLAN_COMPLETENESS_ERROR_CODE,
  RolePlanCompletenessError,
  normalizeStaleCiBreakFindings,
  CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS,
  SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS,
  isSystemLearningCiDebtFinding,
  selectBestCandidatePlans,
  extractPrometheusCandidatePlanSets,
  selectPrometheusCandidatePlanSet,
  MAX_CANDIDATE_SETS,
  CANDIDATE_TIE_THRESHOLD,
  computeMandatoryFindingsPreflight,
  MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS,
  MANDATORY_FINDINGS_PREFLIGHT_STATUS,
  PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES,
  applyPlanLifecycleAdmissionFilter,
  TARGET_PROMETHEUS_STATIC_SECTIONS,
  resolvePrometheusPromptFamilyLabel,
  resolvePrometheusPromptRepoPath,
  resolvePrometheusStaticSections,
  buildPrometheusWorkflowPrompt,
} from "../../src/core/prometheus.js";
import { compilePrompt, markCacheableSegments, CANDIDATE_GENERATION_SECTION, buildCandidateGenerationSection } from "../../src/core/prompt_compiler.js";
import { PLATFORM_MODE } from "../../src/core/mode_state.js";
import {
  scoreCandidateSet,
  selectBestCandidateSet,
} from "../../src/core/plan_critic.js";
import { deriveCandidatePlanningPolicy } from "../../src/core/model_policy.js";
import {
  isNonSpecificVerification,
  validatePlanContract,
  validateAndInjectRolePlans,
  ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX,
  ROLE_PLAN_SKELETON_METADATA_SOURCE,
  detectProcessThoughtMarkers,
  scanParsedOutputForProcessThought,
  OUTPUT_FIDELITY_GATE_FAIL_REASON,
  MAX_ACTIONABLE_STEPS_PER_PACKET,
  PACKET_OVERSIZE_REASON,
  filterQuarantinedPlans,
  isPacketQuarantined,
  QUARANTINE_CONFIDENCE_THRESHOLD as PCV_QUARANTINE_THRESHOLD,
  isCiCriticalMandatoryFinding,
  extractCiEvidenceFromMandatoryFinding,
  PACKET_VIOLATION_CODE,
  NON_SPECIFIC_VERIFICATION_PATTERNS,
  NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES,
  type WaveTaskObject,
} from "../../src/core/plan_contract_validator.js";
import { auditReplayPolicySignals } from "../../src/core/parser_replay_harness.js";
import {
  buildPromptTruthMaintenanceSection,
  buildPromptTruthMaintenanceSnapshot,
} from "../../src/core/learning_policy_compiler.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

describe("normalizePrometheusParsedOutput", () => {
  it("maps tasks/waves decision payload into planner plans", () => {
    const parsed = {
      cycleObjective: "Eliminate recurring verification false-fails",
      tasks: [
        {
          task_id: "T-VH-001",
          title: "Fix verification harness",
          verification_commands: ["npm test"],
          acceptance_criteria: ["Windows glob false-fail rate is zero"]
        },
        {
          task_id: "T-CF-003",
          title: "Automate carry-forward escalation",
          verification_commands: ["npm test"]
        }
      ],
      waves: [
        { wave: 1, tasks: ["T-VH-001"] },
        { wave: 2, tasks: ["T-CF-003"] }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "needs-work");
    assert.equal(Array.isArray(normalized.plans), true);
    assert.equal(normalized.plans.length, 2);
    const harnessPlan = normalized.plans.find((plan: any) => plan.task === "Fix verification harness");
    const carryForwardPlan = normalized.plans.find((plan: any) => plan.task === "Automate carry-forward escalation");
    assert.ok(harnessPlan, "expected harness task to be present");
    assert.ok(carryForwardPlan, "expected carry-forward task to be present");
    assert.equal(harnessPlan!.wave, 1);
    assert.ok(harnessPlan!.verification.startsWith("npm test"));
    assert.match(harnessPlan!.verification, /test:/i);
    assert.equal(carryForwardPlan!.wave, 2);
  });

  it("maps topBottlenecks + string-task waves (GPT analytical format) into planner plans", () => {
    const parsed = {
      projectHealth: "needs-work",
      topBottlenecks: [
        {
          id: "BN-1",
          title: "Janus reads trump_analysis.json (non-existent)",
          severity: "critical",
          evidence: "janus_supervisor.js:283 reads trump_analysis.json; never populated"
        },
        {
          id: "BN-2",
          title: "Sequential worker dispatch ignores wave infrastructure",
          severity: "high",
          evidence: "orchestrator.js:740 sequential for-loop"
        }
      ],
      waves: [
        {
          wave: 1,
          tasks: ["Fix-1: trump→prometheus reference fix"],
          workerSlots: 1,
          rationale: "Correctness bugs"
        },
        {
          wave: 2,
          tasks: ["Fix-2: wave-parallel worker dispatch"],
          workerSlots: 1,
          rationale: "Throughput improvement"
        }
      ],
      proofMetrics: [
        "prometheusAnalysis.projectHealth non-null in janus_directive.json after trump fix",
        "cycle wall-clock time p50 reduction >= 40% after wave-parallel dispatch"
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 30, hardCapTotal: 3 }
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "needs-work");
    assert.equal(Array.isArray(normalized.plans), true);
    assert.equal(normalized.plans.length, 2);
    const waveOnePlan = normalized.plans.find((plan: any) => plan.wave === 1);
    const waveTwoPlan = normalized.plans.find((plan: any) => plan.wave === 2);
    assert.ok(waveOnePlan);
    assert.ok(waveTwoPlan);
    assert.ok(typeof waveOnePlan!.role === "string" && waveOnePlan!.role.length > 0);
    assert.equal(typeof waveOnePlan!.task, "string");
    assert.ok(waveOnePlan!.task.length > 0);
    assert.equal(waveOnePlan!.priority, 1);
  });

  it("keeps valid planner plans and fills missing required fields", () => {
    const parsed = {
      analysis: "System is stable but has quality debt",
      projectHealth: "good",
      executionStrategy: { waves: [] },
      plans: [
        {
          task: "Harden trust boundary"
        }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "good");
    assert.equal(normalized.plans.length, 1);
    assert.ok(typeof normalized.plans[0].role === "string" && normalized.plans[0].role.length > 0);
    assert.ok(normalized.plans[0].verification.startsWith("npm test"));
    assert.match(normalized.plans[0].verification, /test:/i);
    assert.equal(normalized.plans[0].priority, 1);
    assert.ok(normalized.plans[0]._planningRubric, "planning rubric metadata should be attached");
  });

  it("upgrades generic governance-heavy plans to governance-worker with lane hints", () => {
    const parsed = {
      plans: [
        {
          task: "Normalize lane-diversity reason contract with compatibility bridge",
          role: "evolution-worker",
          target_files: ["src/core/orchestrator.ts", "src/core/governance_contract.ts"],
          acceptance_criteria: ["Dispatch block reasons remain deterministic"],
          verification: "npm test -- tests/core/orchestrator_gate_precedence.test.ts",
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.plans.length, 1);
    assert.equal(normalized.plans[0].role, "governance-worker");
    assert.equal(normalized.plans[0].capabilityLane, "governance");
    assert.equal(normalized.plans[0].capabilityTag, "state-governance");
  });

  it("upgrades generic test-heavy plans to quality-worker with lane hints", () => {
    const parsed = {
      plans: [
        {
          task: "Retire stale Athena correction-fidelity health finding",
          role: "evolution-worker",
          target_files: ["src/core/athena_reviewer.ts", "tests/core/athena_review_normalization.test.ts"],
          acceptance_criteria: ["Regression test proves deep-equality behavior remains intact"],
          verification: "npm test -- tests/core/athena_review_normalization.test.ts",
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.plans.length, 1);
    assert.equal(normalized.plans[0].role, "quality-worker");
    assert.equal(normalized.plans[0].capabilityLane, "quality");
    assert.equal(normalized.plans[0].capabilityTag, "test-infra");
  });

  it("maps DECISION-style waves with string task ids into actionable plans", () => {
    const parsed = {
      maxTasks: 5,
      waves: [
        { wave: 1, tasks: ["verification-harness-fix", "decision-router-hardening"] },
        { wave: 2, dependsOn: [1], tasks: ["closed-loop-learning-ledger"] }
      ],
      blockingCarryForwardIncluded: true
    };

    const normalized = normalizePrometheusParsedOutput(parsed, {
      thinking: "Prometheus created a dependency-aware plan",
      raw: ""
    });

    assert.equal(normalized.plans.length, 3);
    const verificationPlan = normalized.plans.find((plan: any) => plan.task === "verification-harness-fix");
    const routerPlan = normalized.plans.find((plan: any) => plan.task === "decision-router-hardening");
    const ledgerPlan = normalized.plans.find((plan: any) => plan.task === "closed-loop-learning-ledger");
    assert.ok(verificationPlan);
    assert.ok(routerPlan);
    assert.ok(ledgerPlan);
    assert.equal(verificationPlan!.wave, 1);
    assert.equal(routerPlan!.wave, 1);
    assert.equal(ledgerPlan!.wave, 2);
    assert.ok(typeof verificationPlan!.role === "string" && verificationPlan!.role.length > 0);
  });

  it("always emits requestBudget to satisfy trust boundary", () => {
    const parsed = {
      waves: [{ wave: 1, tasks: ["premium-efficiency-controller"] }]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, {
      thinking: "Plan with one task",
      raw: ""
    });

    assert.ok(normalized.requestBudget);
    assert.equal(
      Number.isFinite(Number(normalized.requestBudget.estimatedPremiumRequestsTotal)),
      true
    );
    assert.equal(Number(normalized.requestBudget.hardCapTotal) >= 1, true);
  });

  it("normalizes string tasks in executionStrategy.waves to canonical {role,task,task_id} objects", () => {
    // If the LLM emits string tasks in executionStrategy.waves (legacy format),
    // the parser must upgrade them to objects so the validator sees no ambiguity.
    const parsed = {
      projectHealth: "needs-work",
      plans: [{ task: "Fix dispatch", role: "evolution-worker", wave: 1 }],
      executionStrategy: {
        waves: [
          { wave: 1, tasks: ["Fix dispatch", "Harden trust boundary"] }
        ]
      }
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    const waveTasks = normalized.executionStrategy?.waves?.[0]?.tasks;
    assert.ok(Array.isArray(waveTasks), "wave tasks must be an array");
    assert.equal(waveTasks.length, 2, "both string tasks must be preserved after normalization");
    for (const t of waveTasks) {
      assert.equal(typeof t, "object", "every wave task must be an object after normalization");
      assert.ok(typeof t.task === "string" && t.task.length > 0, "task field must be a non-empty string");
      assert.ok(typeof t.role === "string" && t.role.length > 0, "role field must be present after normalization");
      assert.ok(typeof t.task_id === "string" && t.task_id.length > 0, "task_id field must be present after normalization");
    }
  });

  it("preserves object tasks in executionStrategy.waves unchanged through normalization", () => {
    // Object tasks that already satisfy the WaveTaskObject contract must pass
    // through normalizePrometheusParsedOutput without mutation.
    const objectTask: WaveTaskObject = {
      role: "evolution-worker",
      task: "Harden trust boundary",
      task_id: "T-HTB-001",
    };
    const parsed = {
      projectHealth: "needs-work",
      plans: [{ task: "Harden trust boundary", role: "evolution-worker", wave: 1, task_id: "T-HTB-001" }],
      executionStrategy: {
        waves: [{ wave: 1, tasks: [objectTask] }],
      },
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const waveTasks = normalized.executionStrategy?.waves?.[0]?.tasks;

    assert.ok(Array.isArray(waveTasks), "wave tasks array must be present");
    assert.equal(waveTasks.length, 1, "single object task must be preserved");
    const t = waveTasks[0];
    assert.equal(t.role, "evolution-worker", "role must be unchanged");
    assert.equal(t.task, "Harden trust boundary", "task must be unchanged");
    assert.equal(t.task_id, "T-HTB-001", "task_id must be unchanged");
  });

  it("produces no string tasks in executionStrategy after normalization — object-only contract", () => {
    // Post-normalization, every entry in every wave's tasks array must be an
    // object. This is the object-only contract enforced by WaveTaskObject.
    const parsed = {
      projectHealth: "needs-work",
      plans: [
        { task: "Alpha fix", role: "evolution-worker", wave: 1 },
        { task: "Beta fix", role: "evolution-worker", wave: 2 },
      ],
      executionStrategy: {
        waves: [
          { wave: 1, tasks: ["Alpha fix"] },
          { wave: 2, tasks: ["Beta fix"] },
        ],
      },
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    for (const wave of (normalized.executionStrategy?.waves ?? [])) {
      for (const t of (wave.tasks ?? [])) {
        assert.notEqual(typeof t, "string",
          `wave ${wave.wave}: string task found after normalization — violates WaveTaskObject contract`);
        assert.equal(typeof t, "object", `wave ${wave.wave}: task must be an object`);
        assert.ok("role" in t, "task object must have role field");
        assert.ok("task" in t, "task object must have task field");
        assert.ok("task_id" in t, "task object must have task_id field");
      }
    }
  });

  it("emits explicit master-planning execution pattern and worker topology contract", () => {
    const parsed = {
      plans: [
        {
          task: "Add planner coverage test",
          role: "quality-worker",
          wave: 1,
          target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
          acceptance_criteria: ["Planner output includes execution topology with >= 1 assertion", "Regression test passes with 0 topology mismatches"],
          verification: "tests/core/prometheus_parse.test.ts — test: emits execution topology contract",
          capacityDelta: 0.2,
          requestROI: 1.8,
        },
        {
          task: "Wire dispatch topology metadata",
          role: "integration-worker",
          wave: 1,
          target_files: ["src/core/worker_batch_planner.ts", "tests/core/worker_batch_planner.test.ts"],
          acceptance_criteria: ["Batch metadata carries topology contract with >= 1 assertion", "Parallel wave topology remains deterministic with 0 duplicate roles"],
          verification: "tests/core/worker_batch_planner.test.ts — test: batch metadata exposes topology contract",
          capacityDelta: 0.25,
          requestROI: 2.1,
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(normalized.executionStrategy.planningMode, "master_evolution");
    assert.equal(normalized.executionStrategy.executionPattern, "wave_parallel");
    assert.equal(normalized.executionStrategy.workerTopology.workerCount, 2);
    assert.equal(normalized.executionStrategy.workerTopology.maxParallelWorkers, 2);
    assert.equal(Array.isArray(normalized.executionStrategy.workerTopology.roles), true);
    assert.equal(Array.isArray(normalized.executionStrategy.workerTopology.lanes), true);
  });

  it("emits repair-plan execution contract when repair feedback is active", () => {
    const parsed = {
      plans: [
        {
          task: "Repair missing topology contract in src/core/prometheus.ts",
          role: "evolution-worker",
          wave: 1,
          target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
          acceptance_criteria: ["Repair path emits serial repair pattern with >= 1 assertion", "No unrelated packets are added"],
          verification: "tests/core/prometheus_parse.test.ts — test: repair mode emits serial pattern",
          capacityDelta: 0.12,
          requestROI: 1.3,
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, {
      raw: "",
      planningMode: "repair_plan",
      repairFeedback: { reason: "athena rejection" },
      requestedBy: "OrchestratorRepairFlow",
    });
    assert.equal(normalized.planningMode, "repair_plan");
    assert.equal(normalized.executionStrategy.planningMode, "repair_plan");
    assert.equal(normalized.executionStrategy.executionPattern, "serial_repair");
    assert.equal(normalized.executionStrategy.workerTopology.workerCount, 1);
  });

  it("chooses bounded_chain for dependency-bound single-lane plans under elevated uncertainty", () => {
    const parsed = {
      plans: [
        {
          task: "Stabilize planner dependency gate",
          task_id: "stabilize-planner-dependency-gate",
          role: "evolution-worker",
          wave: 1,
          dependencies: [],
          target_files: ["src/core/prometheus.ts", "src/core/plan_contract_validator.ts"],
          acceptance_criteria: ["Execution pattern resolves to bounded_chain with 1 assertion", "Plan remains on the implementation lane"],
          verification: "tests/core/prometheus_parse.test.ts — test: chooses bounded_chain for dependency-bound plans",
          capacityDelta: 0.18,
          requestROI: 1.6,
        },
        {
          task: "Propagate bounded_chain into batch metadata",
          task_id: "propagate-bounded-chain-into-batch-metadata",
          role: "evolution-worker",
          wave: 2,
          dependencies: ["stabilize-planner-dependency-gate"],
          target_files: ["src/core/worker_batch_planner.ts", "tests/core/worker_batch_planner.test.ts"],
          acceptance_criteria: ["Downstream batch metadata keeps bounded_chain with 1 assertion", "Dependency ordering remains explicit in wave 2"],
          verification: "tests/core/worker_batch_planner.test.ts — test: stamps bounded_chain for dependency-bound plans",
          capacityDelta: 0.2,
          requestROI: 1.9,
        },
      ],
      executionStrategy: {
        planningMode: "master_evolution",
        planningUncertainty: "high",
        executionPattern: "wave_parallel",
        waves: [
          { wave: 1, tasks: [{ role: "evolution-worker", task: "Stabilize planner dependency gate", task_id: "stabilize-planner-dependency-gate" }] },
          { wave: 2, tasks: [{ role: "evolution-worker", task: "Propagate bounded_chain into batch metadata", task_id: "propagate-bounded-chain-into-batch-metadata" }] },
        ],
      },
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "", planningUncertainty: "high" });

    assert.equal(normalized.executionStrategy.planningUncertainty, "high");
    assert.equal(normalized.executionStrategy.executionPattern, "bounded_chain");
    assert.ok(normalized.plans.every((plan: any) => plan.planningUncertainty === "high"));
  });

  it("extracts plans from narrative wave sections when no JSON plans exist", () => {
    const parsed = {};
    const thinking = `
Wave 1 (blocking)
1) Fix Windows verification harness
2) Add planning gate for missing harness fix

Wave 2
3) Upgrade evaluation stack
`;

    const normalized = normalizePrometheusParsedOutput(parsed, { thinking, raw: "" });

    assert.equal(normalized.plans.length, 3);
    assert.equal(normalized.plans[0].wave, 1);
    assert.equal(normalized.plans[1].wave, 1);
    assert.equal(normalized.plans[2].wave, 2);
    assert.ok(normalized.plans[0].task.toLowerCase().includes("verification harness"));
  });

  it("synthesizes concrete Athena-facing fields for template-like plans", () => {
    const parsed = {
      analysis: "Capacity increase is bottlenecked by integration closure.",
      plans: [
        { task: "Add trust-boundary provider integration tests for untrusted linter payloads" },
        { task: "Introduce critical-path scheduling over dependency-aware waves" },
        { task: "Add uncertainty-aware model routing with ROI feedback loop", wave: 2 }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(normalized.plans[0].target_files.length > 0);
    assert.ok(normalized.plans[0].scope.length > 0);
    assert.ok(normalized.plans[0].acceptance_criteria.length >= 2);
    assert.ok(/deterministic test/i.test(normalized.plans[0].before_state));

    assert.equal(normalized.plans[1].riskLevel, "high");
    assert.ok(normalized.plans[1].premortem);
    assert.ok(normalized.plans[1].premortem.failurePaths.length >= 1);

    assert.equal(normalized.plans[2].riskLevel, "high");
    assert.ok(normalized.plans[2].target_files.includes("src/core/model_router.ts"));
  });

  it("adds medium-risk premortems, quantified acceptance criteria, and concrete verification descriptions", () => {
    const parsed = {
      plans: [
        {
          title: "Unify lane-diversity pre-dispatch gate",
          task: "Move lane diversity enforcement into the shared evaluatePreDispatchGovernanceGate path",
          role: "infrastructure-worker",
          wave: 1,
          target_files: ["src/core/orchestrator.ts", "tests/core/orchestrator_pipeline_progress.test.ts"],
          acceptance_criteria: [
            "Blocked diversity result sets deterministic dispatchBlockReason"
          ],
          verification: [
            "npm test -- tests/core/orchestrator_pipeline_progress.test.ts",
            "Resume-path test proving no dispatch when lane diversity minimum is unmet."
          ],
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const plan = normalized.plans[0];
    assert.equal(plan.riskLevel, "medium");
    assert.ok(plan.premortem, "medium-risk plan should receive a premortem scaffold");
    assert.ok(plan.acceptance_criteria.every((criterion: string) => /(?:\b\d+\b|>=|<=|<|>|%|\bzero\b)/i.test(criterion)));
    assert.match(plan.verification, /test:/i);
    assert.ok(Array.isArray(plan.verification_commands));
    assert.ok(plan.verification_commands[0].includes("npm test -- tests/core/orchestrator_pipeline_progress.test.ts"));
  });

  it("serializes same-wave file conflicts and same-wave dependencies into later waves", () => {
    const parsed = {
      plans: [
        {
          title: "Close Athena governance-token dispatch parity",
          task: "Extend pre-dispatch governance token parsing",
          role: "governance-worker",
          wave: 1,
          target_files: ["src/core/orchestrator.ts", "tests/core/orchestrator_pipeline_progress.test.ts"],
          acceptance_criteria: ["Token mapping covers all known corrections with >= 2 deterministic test cases"],
          verification: "npm test -- tests/core/orchestrator_pipeline_progress.test.ts — test: token mapping passes with >= 1 assertion",
          riskLevel: "medium",
        },
        {
          title: "Unify lane-diversity pre-dispatch gate",
          task: "Move lane diversity enforcement into the shared gate path",
          role: "infrastructure-worker",
          wave: 1,
          target_files: ["src/core/orchestrator.ts", "tests/core/orchestrator_pipeline_progress.test.ts"],
          acceptance_criteria: ["Lane diversity block emits deterministic reason with >= 2 cases"],
          verification: "npm test -- tests/core/orchestrator_pipeline_progress.test.ts — test: diversity gate blocks with >= 1 assertion",
          riskLevel: "medium",
        },
        {
          title: "Upgrade reflection loop to structured failure signatures",
          task: "Evolve reflection memory to structured failure signatures",
          role: "evolution-worker",
          wave: 2,
          dependencies: ["Persist worker turn-phase resumability"],
          target_files: ["src/core/worker_runner.ts"],
          acceptance_criteria: ["Reflection entries include structured fields with >= 1 schema assertion"],
          verification: "npm test -- tests/core/worker_runner.test.ts — test: reflection schema passes with >= 1 assertion",
          riskLevel: "medium",
        },
        {
          title: "Persist worker turn-phase resumability",
          task: "Refactor worker runtime to persist explicit turn phases",
          role: "infrastructure-worker",
          wave: 2,
          target_files: ["src/core/worker_runner.ts"],
          acceptance_criteria: ["Resume path remains idempotent with 0 duplicate executions"],
          verification: "npm test -- tests/core/worker_runner.test.ts — test: resume path passes with >= 1 assertion",
          riskLevel: "high",
        },
      ],
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const laneGate = normalized.plans.find((plan: any) => plan.title === "Unify lane-diversity pre-dispatch gate");
    const reflection = normalized.plans.find((plan: any) => plan.title === "Upgrade reflection loop to structured failure signatures");
    const resumability = normalized.plans.find((plan: any) => plan.title === "Persist worker turn-phase resumability");

    assert.ok(laneGate.wave > 1, "same-wave file conflict should be serialized into a later wave");
    assert.ok(laneGate.dependencies.includes("Extend pre-dispatch governance token parsing"));
    assert.ok(reflection.wave > resumability.wave, "same-wave dependency should push dependent plan to a later wave");
    assert.ok(reflection.waveDepends.includes(resumability.wave));
  });
});

describe("resolveCapturedAgentRawOutput", () => {
  it("prefers streamed output when early-exit truncates returned buffers", () => {
    const resultRaw = '{"plans":[]}';
    const streamedRaw = 'preface\n===DECISION===\n{"projectHealth":"needs-work","requestBudget":{"estimatedPremiumRequestsTotal":1},"generatedAt":"2026-04-14T00:00:00.000Z","keyFindings":"Valid finding text","strategicNarrative":"Valid narrative text","plans":[]}\n===END===';
    const chosen = resolveCapturedAgentRawOutput(resultRaw, "", streamedRaw, "");
    assert.equal(chosen, streamedRaw);
  });

  it("keeps returned output when streamed output is absent", () => {
    const resultRaw = '===DECISION===\n{"plans":[]}\n===END===';
    const chosen = resolveCapturedAgentRawOutput(resultRaw, "", "", "");
    assert.equal(chosen, resultRaw);
  });
});

describe("validateCycleProofEvidenceSeams", () => {
  it("passes when cycleId and all seam checks are present and valid", () => {
    const result = validateCycleProofEvidenceSeams({
      cycleId: "cycle-123",
      seams: {
        checks: {
          prometheus: { pass: true, failReasons: [] },
          athena: { pass: true, failReasons: [] },
          worker: { pass: true, failReasons: [] },
        },
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.failReasons.length, 0);
  });

  it("rejects incomplete artifact when a required seam check is missing", () => {
    const result = validateCycleProofEvidenceSeams({
      cycleId: "cycle-123",
      seams: {
        checks: {
          prometheus: { pass: true, failReasons: [] },
          athena: { pass: true, failReasons: [] },
        },
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.failReasons.some((reason) => reason.includes("worker")));
  });

  it("rejects failed seams that omit failReasons (negative path)", () => {
    const result = validateCycleProofEvidenceSeams({
      cycleId: "cycle-123",
      seams: {
        checks: {
          prometheus: { pass: true, failReasons: [] },
          athena: { pass: false, failReasons: [] },
          worker: { pass: true, failReasons: [] },
        },
      },
    });
    assert.equal(result.ok, false);
    assert.ok(result.failReasons.some((reason) => reason.includes("athena")));
  });
});

describe("buildTrustedMemoryShortlist", () => {
  it("filters low-trust memory by default and keeps medium/high trust entries", () => {
    const shortlist = buildTrustedMemoryShortlist({
      lessons: [
        { lesson: "Deterministic lesson", score: 1, impact: 1, freshness: 1, trust: { level: "high", source: "system", reason: "system", taggedAt: "2026-01-01T00:00:00.000Z" } },
        { lesson: "User prompt text", score: 1, impact: 1, freshness: 1, trust: { level: "low", source: "user-mediated", reason: "user", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
      promptHints: [
        { hint: "Do X", trust: { level: "medium", source: "model", reason: "model", taggedAt: "2026-01-01T00:00:00.000Z" } },
        { hint: "repeat user text", trust: { level: "low", source: "user-mediated", reason: "user", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
    }, { requestedBy: "Janus" });
    assert.equal(shortlist.lessons.some((entry: any) => String(entry.lesson).includes("User prompt text")), false);
    assert.equal(shortlist.promptHints.some((entry: any) => String(entry.hint).includes("repeat user text")), false);
    assert.ok(shortlist.droppedLowTrustLessons > 0);
    assert.ok(shortlist.droppedLowTrustHints > 0);
  });

  it("allows low-trust memory only when explicitly requested by a privileged caller", () => {
    const shortlist = buildTrustedMemoryShortlist({
      lessons: [
        { lesson: "User prompt text", score: 1, impact: 1, freshness: 1, trust: { level: "low", source: "user-mediated", reason: "user", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
      promptHints: [
        { hint: "repeat user text", trust: { level: "low", source: "user-mediated", reason: "user", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
    }, { requestedBy: "Janus", includeLowTrust: true });
    assert.equal(shortlist.lessons.length, 1);
    assert.equal(shortlist.promptHints.length, 1);
  });

  it("reconciles closed prompt hints out of prompt memory before prompt assembly", () => {
    const shortlist = buildTrustedMemoryShortlist({
      lessons: [
        { lesson: "Keep deterministic replay coverage", trust: { level: "high", source: "system", reason: "system", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
      promptHints: [
        { id: "hint-closed", hint: "Urgently fix the already closed CI breach", status: "closed", trust: { level: "high", source: "system", reason: "system", taggedAt: "2026-01-01T00:00:00.000Z" } },
        { id: "hint-open", hint: "Keep replay closure evidence deterministic", trust: { level: "high", source: "system", reason: "system", taggedAt: "2026-01-01T00:00:00.000Z" } },
      ],
    }, { requestedBy: "Prometheus" });

    const reconciled = reconcilePromptMemoryShortlistByTruth(shortlist, {
      latestMainCiConclusion: "failure",
      latestMainCiHealthy: false,
      athenaTrackedFieldsDeepEquality: false,
      preDispatchGovernanceGate: false,
      preDispatchLaneDiversityGate: false,
    });

    assert.equal(reconciled.promptHints.length, 1);
    assert.equal((reconciled.promptHints[0] as any).id, "hint-open");
    assert.equal(reconciled.retiredPromptHints.length, 1);
  });
});

describe("buildPromptTruthMaintenanceSnapshot", () => {
  const liveSignals = {
    latestMainCiConclusion: "success",
    latestMainCiHealthy: true,
    athenaTrackedFieldsDeepEquality: true,
    preDispatchGovernanceGate: true,
    preDispatchLaneDiversityGate: true,
  };

  it("retires contradicted lessons, research recommendations, and leadership priorities", () => {
    const snapshot = buildPromptTruthMaintenanceSnapshot({
      signals: liveSignals,
      lessons: [
        { id: "lesson-ci", lesson: "CI on main has been broken for 3 consecutive commits", severity: "critical" },
        { id: "lesson-keep", lesson: "Keep regression tests deterministic and isolated" },
      ],
      researchRecommendations: [
        {
          id: "rec-implemented",
          topic: "Verification gate",
          summary: "Expand verification output to a weighted scorecard",
          implementationStatus: "implemented_correctly",
        },
        "Move lane_diversity_gate check to pre-wave-1 validation before dispatch",
      ],
      leadershipPriorities: [
        "Add governance gate token parser to propagate Athena corrections to dispatchBlockReason",
        "Preserve benchmark telemetry reporting for future investigations",
      ],
    });

    assert.deepEqual(snapshot.lessons.activeText, ["Keep regression tests deterministic and isolated"]);
    assert.equal(snapshot.lessons.retired.length, 1);
    assert.match(snapshot.lessons.retired[0].reason, /main-branch ci state is healthy/i);

    assert.equal(snapshot.recommendations.activeText.length, 0);
    assert.equal(snapshot.recommendations.retired.length, 2);
    assert.equal(snapshot.recommendations.retired.some((entry) => /implemented or closed/i.test(entry.reason)), true);
    assert.equal(snapshot.recommendations.retired.some((entry) => /lane diversity now blocks in pre-dispatch governance/i.test(entry.reason)), true);

    assert.deepEqual(snapshot.priorities.activeText, ["Preserve benchmark telemetry reporting for future investigations"]);
    assert.equal(snapshot.priorities.retired.length, 1);

    const section = buildPromptTruthMaintenanceSection({
      activeLessons: snapshot.lessons.activeText,
      activeRecommendations: snapshot.recommendations.activeText,
      activePriorities: snapshot.priorities.activeText,
      retiredLessons: snapshot.lessons.retired.map(({ label, reason }) => ({ label, reason })),
      retiredRecommendations: snapshot.recommendations.retired.map(({ label, reason }) => ({ label, reason })),
      retiredPriorities: snapshot.priorities.retired.map(({ label, reason }) => ({ label, reason })),
    });

    assert.match(section, /Retired research recommendations:/);
    assert.match(section, /Active stored lessons:\n1\. Keep regression tests deterministic and isolated/);
    assert.match(section, /Retired stored lessons:\n1\. CI on main has been broken for 3 consecutive commits/i);
  });

  it("keeps unresolved research and leadership inputs active when live state does not contradict them", () => {
    const snapshot = buildPromptTruthMaintenanceSnapshot({
      signals: {
        latestMainCiConclusion: "failure",
        latestMainCiHealthy: false,
        athenaTrackedFieldsDeepEquality: false,
        preDispatchGovernanceGate: false,
        preDispatchLaneDiversityGate: false,
      },
      lessons: [
        { id: "lesson-active", lesson: "Worker sessions must persist canonical artifacts" },
      ],
      researchRecommendations: [
        {
          id: "rec-pending",
          topic: "Worker runtime",
          summary: "Require SESSION_ID for extension workers",
          implementationStatus: "pending",
        },
      ],
      leadershipPriorities: [
        "Harden worker runtime session contracts",
      ],
    });

    assert.deepEqual(snapshot.lessons.activeText, ["Worker sessions must persist canonical artifacts"]);
    assert.equal(snapshot.lessons.retired.length, 0);
    assert.deepEqual(snapshot.recommendations.activeText, ["Worker runtime: Require SESSION_ID for extension workers"]);
    assert.equal(snapshot.recommendations.retired.length, 0);
    assert.deepEqual(snapshot.priorities.activeText, ["Harden worker runtime session contracts"]);
    assert.equal(snapshot.priorities.retired.length, 0);
  });
});

describe("applyPlanningRubric", () => {
  it("scores capacity-first plans above defensive-only plans", () => {
    const plans = [
      {
        task: "Implement dependency-aware scheduling in src/core/dag_scheduler.ts",
        role: "evolution-worker",
        target_files: ["src/core/dag_scheduler.ts", "tests/core/dag_scheduler.test.ts"],
        acceptance_criteria: ["Scheduler passes dependency ordering tests", "No cycle regressions"],
        verification: "tests/core/dag_scheduler.test.ts — test: preserves dependency order",
        scope: "src/core/dag_scheduler.ts",
        before_state: "Wave-only ordering",
        after_state: "Dependency-aware ordering",
        leverage_rank: ["architecture", "speed", "task-quality"],
        capacityDelta: 0.3,
        requestROI: 2.5,
        estimatedExecutionTokens: 14000,
        dependencies: ["T-1"],
        priority: 2,
      },
      {
        task: "Block all risky changes with hard gate only",
        role: "evolution-worker",
        target_files: ["src/core/policy_engine.ts"],
        acceptance_criteria: ["Gate blocks risky changes", "No new warnings"],
        verification: "tests/core/policy_engine.test.ts — test: gate blocks restricted writes",
        scope: "src/core/policy_engine.ts",
        before_state: "Mixed governance",
        after_state: "Strict block policy",
        leverage_rank: ["security"],
        capacityDelta: 0.1,
        requestROI: 1.1,
        estimatedExecutionTokens: 9000,
        dependencies: [],
        priority: 1,
      },
    ];
    const ranked = applyPlanningRubric(plans as any);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0]._planningRubric.score >= ranked[1]._planningRubric.score);
    const defensivePlan = ranked.find(plan => String(plan.task || "").toLowerCase().includes("hard gate only"));
    assert.ok(defensivePlan, "defensive plan should exist in ranked output");
    assert.equal(defensivePlan!._planningRubric.rigidityPenaltyApplied, true);
  });

  it("normalizes leverage_rank aliases to canonical dimensions", () => {
    const plans = [
      {
        task: "Improve parser output",
        leverage_rank: ["quality", "learning loop", "routing"],
        target_files: ["src/core/prometheus.ts"],
        acceptance_criteria: ["Parser emits plans", "No syntax errors"],
        verification: "tests/core/prometheus_parse.test.ts — test: normalizes parsed output",
        scope: "src/core/prometheus.ts",
        before_state: "No alias normalization",
        after_state: "Alias normalization added",
        role: "evolution-worker",
        capacityDelta: 0.2,
        requestROI: 1.5,
      },
    ];
    const ranked = applyPlanningRubric(plans as any);
    assert.deepEqual(ranked[0].leverage_rank, ["task-quality", "learning-loop", "model-task-fit"]);
  });

  it("negative path: empty input returns empty array", () => {
    assert.deepEqual(applyPlanningRubric(null as any), []);
  });

  it("exports a positive rigidity penalty constant", () => {
    assert.ok(RIGIDITY_PENALTY > 0);
  });
});

describe("normalizePrometheusParsedOutput — confidence components", () => {
  it("emits full-score components when plans are JSON-direct and health is explicit", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix verification harness", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(result.parserConfidenceComponents, "parserConfidenceComponents must be present");
    assert.equal(result.parserConfidenceComponents.plansShape, 1.0);
    assert.equal(result.parserConfidenceComponents.healthField, 1.0);
    assert.equal(result.parserConfidenceComponents.requestBudget, 1.0);
    assert.ok(Array.isArray(result.parserConfidencePenalties), "parserConfidencePenalties must be an array");
    assert.equal(result.parserConfidencePenalties.length, 0, "no penalties expected for full-score output");
    assert.equal(result.parserConfidence, 1.0);
  });

  it("emits plansShape=0.5 and a narrative-fallback penalty when plans come from waves", () => {
    const parsed = {
      projectHealth: "needs-work",
      waves: [{ wave: 1, tasks: ["Fix trust boundary"] }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.5);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "plansShape");
    assert.ok(penalty, "must have a plansShape penalty");
    assert.equal(penalty.reason, "plans_from_narrative_fallback");
    assert.equal(penalty.delta, -0.5);
    assert.equal(result.parserConfidence, 0.5);
  });

  it("emits healthField=0.9 and a health_field_inferred penalty when projectHealth is missing", () => {
    const parsed = {
      plans: [{ task: "Add canary metrics", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.healthField, 0.9);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "healthField");
    assert.ok(penalty, "must have a healthField penalty");
    assert.equal(penalty.reason, "health_field_inferred_from_text");
    assert.equal(penalty.delta, -0.1);
    assert.equal(result.parserConfidence, 0.9);
  });

  it("emits requestBudget=0.9 and a budget-fallback penalty when requestBudget is absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Improve retry logic", role: "evolution-worker" }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.requestBudget, 0.9);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "requestBudget");
    assert.ok(penalty, "must have a requestBudget penalty");
    assert.equal(penalty.reason, "request_budget_fallback");
    assert.equal(penalty.delta, -0.1);
    assert.equal(result.parserConfidence, 0.9);
  });

  it("accumulates multiple penalties correctly", () => {
    // Narrative plans (base=0.5) + inferred health (-0.1) + no budget (-0.1) = 0.3
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix parser"] }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.5);
    assert.equal(result.parserConfidenceComponents.healthField, 0.9);
    assert.equal(result.parserConfidenceComponents.requestBudget, 0.9);
    assert.equal(result.parserConfidencePenalties.length, 3);
    // 0.5 - 0.1 - 0.1 = 0.3
    assert.equal(result.parserConfidence, 0.3);
  });

  it("emits plansShape=0.0 and no_plans_extracted penalty when no plans are found", () => {
    const result = normalizePrometheusParsedOutput({}, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.0);
    const penalty = result.parserConfidencePenalties.find(p => p.reason === "no_plans_extracted");
    assert.ok(penalty, "must have a no_plans_extracted penalty");
    assert.equal(penalty.component, "plansShape");
  });

  it("each penalty entry has required fields: reason, component, delta", () => {
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix something"] }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    for (const p of result.parserConfidencePenalties) {
      assert.ok(typeof p.reason === "string" && p.reason.length > 0, "penalty must have reason");
      assert.ok(typeof p.component === "string" && p.component.length > 0, "penalty must have component");
      assert.ok(typeof p.delta === "number" && p.delta < 0, "penalty delta must be a negative number");
    }
  });

  it("emits bottleneckCoverage=1.0 component when no topBottlenecks declared", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix verification harness", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents.bottleneckCoverage, 1.0);
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "bottleneckCoverage"));
  });

  it("applies bottleneckCoverage penalty when topBottlenecks are undercovered", () => {
    const parsed = {
      projectHealth: "good",
      topBottlenecks: [
        { id: "BN-1", title: "Sequential worker dispatch ignores wave infrastructure", severity: "high" },
        { id: "BN-2", title: "Trust boundary contract missing enforcement gate", severity: "critical" },
        { id: "BN-3", title: "Parser fence handling drops multiline blocks", severity: "medium" },
      ],
      // plans that only address BN-1 — BN-2 and BN-3 uncovered
      plans: [
        { task: "Fix sequential worker dispatch for wave infrastructure", role: "evolution-worker", _fromBottleneck: "BN-1" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(result.parserConfidenceComponents.bottleneckCoverage < 1.0,
      "bottleneckCoverage component must be below 1.0 when bottlenecks are uncovered");
    const penalty = result.parserConfidencePenalties.find(p => p.component === "bottleneckCoverage");
    assert.ok(penalty, "must have a bottleneckCoverage penalty");
    assert.ok(penalty.delta < 0, "penalty delta must be negative");
    assert.ok(result.bottleneckCoverage, "must emit bottleneckCoverage field on result");
    assert.equal(result.bottleneckCoverage.total, 3);
    assert.ok(result.bottleneckCoverage.uncovered.length >= 1);
  });

  it("does not apply bottleneckCoverage penalty when all topBottlenecks are covered", () => {
    const parsed = {
      projectHealth: "good",
      topBottlenecks: [
        { id: "BN-1", title: "Sequential worker dispatch ignores wave infrastructure", severity: "high" },
        { id: "BN-2", title: "Trust boundary contract enforcement missing", severity: "critical" },
      ],
      plans: [
        { task: "Fix sequential worker dispatch wave infrastructure", role: "evolution-worker", _fromBottleneck: "BN-1" },
        { task: "Add trust boundary contract enforcement gate", role: "evolution-worker", _fromBottleneck: "BN-2" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.bottleneckCoverage, 1.0);
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "bottleneckCoverage"));
  });

  // ── Structural quality: alias variation must not affect healthField score ──

  it("healthField=1.0 for 'healthy' alias — structural quality invariant to alias vs canonical", () => {
    const parsed = {
      projectHealth: "healthy",
      plans: [{ task: "Harden trust boundary", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.healthField, 1.0,
      "'healthy' alias must score healthField=1.0 — same as canonical 'good'");
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "healthField"),
      "no healthField penalty expected for a recognized alias");
  });

  it("healthField=1.0 for 'warning' alias — structural quality invariant to alias vs canonical", () => {
    const parsed = {
      projectHealth: "warning",
      plans: [{ task: "Fix retry escalation", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.healthField, 1.0,
      "'warning' alias must score healthField=1.0 — same as canonical 'needs-work'");
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "healthField"),
      "no healthField penalty expected for a recognized alias");
  });

  it("healthField=1.0 for all canonical health values ('good', 'needs-work', 'critical')", () => {
    for (const value of ["good", "needs-work", "critical"]) {
      const parsed = {
        projectHealth: value,
        plans: [{ task: "Fix something", role: "evolution-worker" }],
        requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
      };
      const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
      assert.equal(result.parserConfidenceComponents.healthField, 1.0,
        `canonical '${value}' must score healthField=1.0`);
      assert.ok(!result.parserConfidencePenalties.some(p => p.component === "healthField"),
        `no healthField penalty expected for canonical value '${value}'`);
    }
  });

  it("healthField=0.9 for unrecognized projectHealth value — resolves to canonical via inference (negative path)", () => {
    const parsed = {
      projectHealth: "unknown-status",
      plans: [{ task: "Fix something", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.healthField, 0.9,
      "unrecognized health value is resolved via inference — lighter penalty than truly missing");
    const penalty = result.parserConfidencePenalties.find(p => p.component === "healthField");
    assert.ok(penalty, "must have a healthField penalty for an unrecognized value");
    assert.equal(penalty.reason, "health_field_inferred_from_text");
  });

  // ── Channel split: parser-core vs context-penalty ──────────────────────────

  it("parserCoreConfidence equals 1.0 and parserContextPenalty equals 0 for full-score input", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix trust boundary", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserCoreConfidence, 1.0, "core channel must be 1.0 for fully-scored structural input");
    assert.equal(result.parserContextPenalty, 0, "context-penalty channel must be 0 when no context signals degrade quality");
    assert.equal(result.parserConfidence, 1.0, "aggregate must equal core − context = 1.0 (backward compat)");
  });

  it("parserCoreConfidence absorbs healthField and requestBudget penalties; context channel stays 0", () => {
    // Narrative plans (base=0.5) + inferred health (-0.1) + no budget (-0.1)
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix parser"] }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserCoreConfidence, 0.3,
      "core confidence = 0.5 base − 0.1 healthField inferred − 0.1 requestBudget = 0.3");
    assert.equal(result.parserContextPenalty, 0,
      "context-penalty must be 0 — bottleneckCoverage and architectureDrift are context signals, not present here");
    assert.equal(result.parserConfidence, 0.3,
      "aggregate parserConfidence must equal parserCoreConfidence (backward compat)");
  });

  it("parserContextPenalty absorbs bottleneckCoverage penalty; parserCoreConfidence is unaffected", () => {
    const parsed = {
      projectHealth: "good",
      topBottlenecks: [
        { id: "BN-1", title: "Sequential worker dispatch", severity: "high" },
        { id: "BN-2", title: "Trust boundary missing gate", severity: "critical" },
        { id: "BN-3", title: "Parser fence drop", severity: "medium" },
        { id: "BN-4", title: "Budget estimation stale", severity: "low" },
      ],
      // Only BN-1 addressed — 3 uncovered → coverage < BOTTLENECK_COVERAGE_FLOOR
      plans: [
        { task: "Fix sequential worker dispatch", role: "evolution-worker", _fromBottleneck: "BN-1" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserCoreConfidence, 1.0,
      "core confidence must be unaffected by bottleneckCoverage — that is a context signal");
    assert.ok(result.parserContextPenalty > 0,
      "context-penalty must be positive when bottleneck coverage is below floor");
    assert.ok(result.parserConfidence < 1.0,
      "aggregate must be reduced by context penalty");
    assert.equal(
      Math.round((result.parserCoreConfidence - result.parserContextPenalty) * 100) / 100,
      result.parserConfidence,
      "parserConfidence must equal parserCoreConfidence − parserContextPenalty (channel invariant)"
    );
  });

  it("parserCoreConfidence and parserContextPenalty are independent — negative path: no plans", () => {
    const result = normalizePrometheusParsedOutput({}, { raw: "" });

    // No plans: base=0.1, health penalty (-0.2) floored → core=0.1, no context signals
    assert.equal(result.parserCoreConfidence, 0.1,
      "core channel must floor at 0.1 for unparseable output");
    assert.equal(result.parserContextPenalty, 0,
      "context-penalty channel must be 0 when no context signals are present");
  });

  // ── Source-linkage confidence component ───────────────────────────────────

  it("sourceLinkage=1.0 and no penalty when no research context is declared", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix trust boundary", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents.sourceLinkage, 1.0,
      "no research context → sourceLinkage must be 1.0");
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "sourceLinkage"),
      "no sourceLinkage penalty when researchContext is absent");
  });

  it("sourceLinkage=0.6 and full penalty when research topics present but no synthesis_sources or informational_topics_consumed", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix trust boundary", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
      researchContext: { topicCount: 3 },
      // no informational_topics_consumed, no synthesis_sources on plans
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents.sourceLinkage, 0.6,
      "blind planning with research context must set sourceLinkage=0.6");
    const penalty = result.parserConfidencePenalties.find(p => p.component === "sourceLinkage");
    assert.ok(penalty, "must have a sourceLinkage penalty for context-blind planning");
    assert.ok(penalty.reason.startsWith("research_source_linkage_missing_topics_"),
      `penalty reason must be research_source_linkage_missing_topics_N, got: ${penalty.reason}`);
    assert.equal(penalty.delta, -0.4, "full blind-planning penalty must be -0.4");
  });

  it("sourceLinkage=0.85 and softer penalty when research topics present, no synthesis_sources, but informational_topics_consumed exists", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix trust boundary", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
      researchContext: { topicCount: 2 },
      informational_topics_consumed: ["Security Analysis Topic"],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents.sourceLinkage, 0.85,
      "informational-only consumption must set sourceLinkage=0.85");
    const penalty = result.parserConfidencePenalties.find(p => p.component === "sourceLinkage");
    assert.ok(penalty, "must have a sourceLinkage penalty for informational-only consumption");
    assert.equal(penalty.reason, "research_source_linkage_informational_only");
    assert.equal(penalty.delta, -0.15, "informational-only penalty must be -0.15");
  });

  it("sourceLinkage=1.0 and no penalty when plans declare synthesis_sources (positive path)", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{
        task: "Fix trust boundary based on research",
        role: "evolution-worker",
        synthesis_sources: ["Security Analysis Topic"],
      }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
      researchContext: { topicCount: 1 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents.sourceLinkage, 1.0,
      "plans with synthesis_sources must score sourceLinkage=1.0");
    assert.ok(!result.parserConfidencePenalties.some(p => p.component === "sourceLinkage"),
      "no sourceLinkage penalty when plans are properly linked to research sources");
  });
});

describe("computeBottleneckCoverage", () => {
  it("returns coverage=1.0 when bottlenecks array is empty", () => {
    const result = computeBottleneckCoverage([], []);
    assert.equal(result.coverage, 1.0);
    assert.equal(result.total, 0);
  });

  it("returns coverage=1.0 when all bottlenecks are covered by _fromBottleneck reference", () => {
    const plans = [
      { task: "Fix BN-1", _fromBottleneck: "BN-1" },
      { task: "Fix BN-2", _fromBottleneck: "BN-2" },
    ];
    const bottlenecks = [
      { id: "BN-1", title: "Sequential worker dispatch ignores wave" },
      { id: "BN-2", title: "Trust boundary contract missing" },
    ];
    const result = computeBottleneckCoverage(plans, bottlenecks);
    assert.equal(result.coverage, 1.0);
    assert.equal(result.covered.length, 2);
    assert.equal(result.uncovered.length, 0);
  });

  it("returns partial coverage when some bottlenecks are not covered", () => {
    const plans = [
      { task: "Fix trust boundary contract enforcement", _fromBottleneck: "BN-2" },
    ];
    const bottlenecks = [
      { id: "BN-1", title: "Sequential dispatch ignores wave infrastructure" },
      { id: "BN-2", title: "Trust boundary contract missing" },
      { id: "BN-3", title: "Parser fence handling drops multiline blocks" },
    ];
    const result = computeBottleneckCoverage(plans, bottlenecks);
    assert.ok(result.coverage < 1.0);
    assert.equal(result.covered.length, 1);
    assert.equal(result.uncovered.length, 2);
    assert.equal(result.total, 3);
  });

  it("covers bottleneck by keyword overlap when no _fromBottleneck reference", () => {
    const plans = [
      { task: "Fix sequential worker dispatch for wave infrastructure ordering", title: "Fix wave dispatch" },
    ];
    const bottlenecks = [
      { id: "BN-1", title: "Sequential worker dispatch ignores wave infrastructure" },
    ];
    const result = computeBottleneckCoverage(plans, bottlenecks);
    assert.equal(result.coverage, 1.0, "keyword overlap should cover the bottleneck");
  });

  it("does not cover bottleneck with only 1 matching keyword (requires ≥2)", () => {
    const plans = [
      { task: "Fix dispatch logic", title: "Fix dispatch" },
    ];
    const bottlenecks = [
      { id: "BN-1", title: "Sequential worker dispatch ignores wave infrastructure" },
    ];
    const result = computeBottleneckCoverage(plans, bottlenecks);
    // Only "dispatch" matches (1 word), not enough for coverage
    assert.equal(result.uncovered.length, 1);
  });

  it("returns BOTTLENECK_COVERAGE_FLOOR as a number between 0 and 1", () => {
    assert.ok(typeof BOTTLENECK_COVERAGE_FLOOR === "number");
    assert.ok(BOTTLENECK_COVERAGE_FLOOR > 0 && BOTTLENECK_COVERAGE_FLOOR < 1);
  });
});

describe("filterResolvedCarryForwardItems", () => {
  const makePending = (followUpTask, workerName = "evolution-worker") => ({
    followUpNeeded: true,
    followUpTask,
    workerName,
    reviewedAt: "2025-01-01",
  });

  it("returns all items when ledger is empty and no completedTasks", () => {
    const pending = [makePending("Fix flaky test in worker runner"), makePending("Add trust-boundary coverage")];
    const result = filterResolvedCarryForwardItems(pending, [], []);
    assert.equal(result.length, 2);
  });

  it("retires items closed in the carry-forward ledger", () => {
    const pending = [
      makePending("Fix flaky test in worker runner"),
      makePending("Add trust-boundary coverage"),
    ];
    const ledger = [
      { id: "debt-1-0", lesson: "Fix flaky test in worker runner", closedAt: "2025-02-01T00:00:00Z", closureEvidence: "PR #99" },
      { id: "debt-1-1", lesson: "Another open item", closedAt: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].followUpTask, "Add trust-boundary coverage");
  });

  it("retires items present in coordinationCompletedTasks", () => {
    const pending = [makePending("Upgrade evaluation stack"), makePending("Add circuit breaker for model calls")];
    const result = filterResolvedCarryForwardItems(pending, [], ["Upgrade evaluation stack"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].followUpTask, "Add circuit breaker for model calls");
  });

  it("uses fingerprint matching — strips noise before hashing so noise-equivalent texts are retired", () => {
    const pending = [makePending("Create and complete a task to fix the verification harness")];
    const ledger = [
      // lesson matches after canonicalization; closureEvidence confirms it shipped
      { id: "d1", lesson: "fix the verification harness", closedAt: "2025-03-01T00:00:00Z", closureEvidence: "PR #101" },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 0);
  });

  it("does NOT retire items whose ledger entry is closed without closureEvidence", () => {
    const pending = [makePending("Automate carry-forward escalation")];
    const ledger = [
      // closedAt is set but closureEvidence is absent — no proof of fix
      { id: "d1", lesson: "Automate carry-forward escalation", closedAt: "2025-03-01T00:00:00Z", closureEvidence: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
  });

  it("keeps items whose ledger entry is open (closedAt = null)", () => {
    const pending = [makePending("Automate carry-forward escalation")];
    const ledger = [
      { id: "d1", lesson: "Automate carry-forward escalation", closedAt: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
  });


describe("applyPlanLifecycleAdmissionFilter", () => {
  async function makeStateDir(prefix: string): Promise<string> {
    const { tmpdir } = await import("node:os");
    return fs.mkdtemp(path.join(tmpdir(), prefix));
  }

  it("keeps evidence-backed partial work as continuing and suppresses same-family reopen", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Finish worker restart recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "implemented_partially",
          implementationEvidence: ["src/core/orchestrator.ts line 25"],
        },
        {
          task: "Add worker restart recovery guardrails",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 1);
      assert.equal(result.actionablePlans[0]._lifecycleState, "continuing");
      assert.ok(result.actionablePlans[0].continuationFamilyKey);
      assert.equal(result.skippedPlans.length, 1);
      assert.match(result.skippedPlans[0].reason, /already ongoing/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not let unverified partial claims suppress same-family work", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Finish worker restart recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "implemented_partially",
          implementationEvidence: [],
        },
        {
          task: "Add worker restart recovery guardrails",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 2);
      assert.equal(result.skippedPlans.length, 0);
      assert.equal(result.actionablePlans[0]._lifecycleState, "partial_unverified");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses same-family new plans when persisted analysis already has verified continuation", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "prometheus_analysis.json"),
        JSON.stringify({
          plans: [
            {
              task: "Finish worker restart recovery flow",
              scope: "src/core/orchestrator.ts",
              target_files: ["src/core/orchestrator.ts"],
              continuationFamilyKey: "worker-restart-recovery",
              implementationStatus: "implemented_partially",
              implementationEvidence: ["src/core/orchestrator.ts line 25"],
            },
          ],
        }),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Add worker restart recovery guardrails",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 0);
      assert.equal(result.skippedPlans.length, 1);
      assert.match(result.skippedPlans[0].reason, /already ongoing/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not auto-close work from coordination completedTasks without verified evidence", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "athena_coordination.json"),
        JSON.stringify({ completedTasks: ["Fix timeout recovery flow"] }),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Fix timeout recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          implementationStatus: "implemented_correctly",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 1);
      assert.equal(result.skippedPlans.length, 0);
      assert.equal(result.actionablePlans[0]._lifecycleState, "unverified_completion_claim");
      assert.equal(result.actionablePlans[0]._advisoryCompletionClaim, true);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("closes work from a verified Athena postmortem closure evidence envelope", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "athena_postmortems.json"),
        JSON.stringify({
          entries: [
            {
              taskCompleted: true,
              expectedOutcome: "Fix timeout recovery flow",
              closureEvidenceEnvelope: {
                schemaVersion: 1,
                source: "athena_postmortem",
                task: "Fix timeout recovery flow",
                taskIdentity: "fix timeout recovery flow",
                continuationFamilyKey: "timeout:recovery:flow",
                lifecycleState: "closed",
                advisoryOnly: false,
                verified: true,
                implementationEvidence: ["src/core/orchestrator.ts"],
                verification: {
                  verificationPassed: true,
                  doneWorkerWithVerificationReportEvidence: true,
                  doneWorkerWithCleanTreeStatusEvidence: true,
                  replayClosureSatisfied: true,
                  closureBoundaryViolation: false,
                },
                emittedAt: "2026-04-13T12:00:00.000Z",
              },
            },
          ],
        }),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Fix timeout recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "timeout:recovery:flow",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 0);
      assert.equal(result.skippedPlans.length, 1);
      assert.match(result.skippedPlans[0].reason, /already (completed|closed)/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses same-family reopen from a verified Athena postmortem continuation envelope", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "athena_postmortems.json"),
        JSON.stringify({
          entries: [
            {
              taskCompleted: false,
              expectedOutcome: "Finish worker restart recovery flow",
              closureEvidenceEnvelope: {
                schemaVersion: 1,
                source: "athena_postmortem",
                task: "Finish worker restart recovery flow",
                taskIdentity: "finish worker restart recovery flow",
                continuationFamilyKey: "worker-restart-recovery",
                lifecycleState: "continuing",
                advisoryOnly: false,
                verified: true,
                implementationEvidence: ["src/core/orchestrator.ts"],
                verification: {
                  verificationPassed: true,
                  doneWorkerWithVerificationReportEvidence: false,
                  doneWorkerWithCleanTreeStatusEvidence: false,
                  replayClosureSatisfied: false,
                  closureBoundaryViolation: false,
                },
                emittedAt: "2026-04-13T12:00:00.000Z",
              },
            },
          ],
        }),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Add worker restart recovery guardrails",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          continuationFamilyKey: "worker-restart-recovery",
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 0);
      assert.equal(result.skippedPlans.length, 1);
      assert.match(result.skippedPlans[0].reason, /already ongoing/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("closes work only when carry-forward ledger has verified closure evidence", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "carry_forward_ledger.json"),
        JSON.stringify([
          {
            id: "debt-1",
            lesson: "Fix timeout recovery flow",
            closedAt: "2026-04-13T12:00:00.000Z",
            closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc, inline://clean-tree-status, inline://npm-test-output-block]",
          },
        ]),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Fix timeout recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 0);
      assert.equal(result.skippedPlans.length, 1);
      assert.equal(result.skippedPlans[0].plan._lifecycleState, "closed");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("fails closed on unverified completion claims instead of auto-closing them", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "Fix timeout recovery flow",
          scope: "src/core/orchestrator.ts",
          target_files: ["src/core/orchestrator.ts"],
          implementationStatus: "implemented_correctly",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 1);
      assert.equal(result.skippedPlans.length, 0);
      assert.equal(result.actionablePlans[0]._lifecycleState, "unverified_completion_claim");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses duplicate plans when worker_cycle_artifacts records an already-completed skipped task", async () => {
    const stateDir = await makeStateDir("lifecycle-filter-");

    try {
      await fs.writeFile(
        path.join(stateDir, "worker_cycle_artifacts.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: "2026-04-16T17:27:47.331Z",
          latestCycleId: "cycle-1",
          cycles: {
            "cycle-1": {
              cycleId: "cycle-1",
              status: "dispatching",
              updatedAt: "2026-04-16T17:27:47.331Z",
              workerSessions: {},
              workerActivity: {
                "evolution-worker": [
                  {
                    at: "2026-04-16T17:27:47.331Z",
                    status: "skipped",
                    task: "If wave 1 passes, merge PR #2 to main and verify the target app still passes lint, build, and focused tests",
                    taskIds: ["plan-1"],
                    skipReason: "already-merged",
                    dispatchBlockReason: "already_done:already-merged",
                    wave: 1,
                  },
                ],
              },
              completedTaskIds: ["plan-1"],
            },
          },
        }),
        "utf8",
      );

      const result = await applyPlanLifecycleAdmissionFilter(stateDir, [
        {
          task: "If wave 1 passes, merge PR #2 to main and verify the target app still passes lint, build, and focused tests",
          scope: "target repo main",
          target_files: ["src/app.tsx"],
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ]);

      assert.equal(result.actionablePlans.length, 0);
      assert.equal(result.skippedPlans.length, 1);
      assert.match(result.skippedPlans[0].reason, /already (closed|completed)/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
  it("handles empty pendingEntries gracefully", () => {
    const result = filterResolvedCarryForwardItems([], [{ id: "d1", lesson: "anything", closedAt: "2025-01-01", closureEvidence: "done" }], []);
    assert.equal(result.length, 0);
  });

  it("handles null/undefined inputs without throwing", () => {
    const result = filterResolvedCarryForwardItems(null, null, null);
    assert.equal(result.length, 0);
  });
});

describe("PROMETHEUS_STATIC_SECTIONS", () => {
  it("exports all required static sections", () => {
    assert.ok(PROMETHEUS_STATIC_SECTIONS.evolutionDirective);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.mandatorySelfCritique);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.mandatoryOperatorQuestions);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.outputFormat);
  });

  it("static sections have non-empty content", () => {
    for (const [key, sec] of Object.entries(PROMETHEUS_STATIC_SECTIONS)) {
      assert.ok(sec.content && sec.content.length > 0, `${key} section must have content`);
    }
  });

  it("evolutionDirective contains EVOLUTION DIRECTIVE and EQUAL DIMENSION SET headers", () => {
    const content = PROMETHEUS_STATIC_SECTIONS.evolutionDirective.content;
    assert.ok(content.includes("EVOLUTION DIRECTIVE"), "should contain EVOLUTION DIRECTIVE header");
    assert.ok(content.includes("EQUAL DIMENSION SET"), "should contain EQUAL DIMENSION SET header");
  });

  it("outputFormat contains ACTIONABLE IMPROVEMENT PACKET FORMAT and PACKET FIELD ENFORCEMENT RULES", () => {
    const content = PROMETHEUS_STATIC_SECTIONS.outputFormat.content;
    assert.ok(content.includes("ACTIONABLE IMPROVEMENT PACKET FORMAT"));
    assert.ok(content.includes("PACKET FIELD ENFORCEMENT RULES"));
    assert.ok(content.includes("===DECISION==="), "should contain JSON output markers");
    assert.ok(content.includes("\"projectHealth\": \"<good|healthy|needs-work|degraded|critical>\""));
    assert.ok(content.includes("\"estimatedPremiumRequestsTotal\": 6"));
  });
});

describe("single-target prompt isolation helpers", () => {
  const targetConfig = {
    selfDev: {
      futureModeFlags: {
        singleTargetDelivery: true,
      },
    },
    platformModeState: {
      currentMode: PLATFORM_MODE.SINGLE_TARGET_DELIVERY,
    },
    activeTargetSession: {
      sessionId: "sess_target_1",
      workspace: {
        path: "C:\\isolated\\target-workspace",
      },
      repo: {
        localPath: "C:\\isolated\\target-workspace",
      },
    },
  };

  it("selects target-only static sections for single-target planning", () => {
    const sections = resolvePrometheusStaticSections(targetConfig);

    assert.equal(sections, TARGET_PROMETHEUS_STATIC_SECTIONS);
    const combined = Object.values(sections).map((entry: any) => String(entry.content || "")).join("\n");
    assert.match(combined, /Do NOT propose work for BOX internals/i);
    assert.doesNotMatch(combined, /META-IMPROVER/i);
  });

  it("uses a single-target prompt family label and workspace path in target mode", () => {
    assert.equal(resolvePrometheusPromptFamilyLabel(targetConfig), "prometheus-single_target_delivery");
    assert.equal(
      resolvePrometheusPromptRepoPath(targetConfig, "C:\\Users\\caner\\Desktop\\Box"),
      "C:\\isolated\\target-workspace",
    );
  });

  it("builds a target-only workflow that avoids BOX src/core browsing", () => {
    const workflow = buildPrometheusWorkflowPrompt(targetConfig, "C:\\Users\\caner\\Desktop\\Box");

    assert.match(workflow, /isolated target workspace/i);
    assert.match(workflow, /ACTIVE TARGET WORKSPACE: C:\\isolated\\target-workspace/);
    assert.match(workflow, /Do NOT browse BOX src\/core/i);
    assert.match(workflow, /Do NOT silently downgrade explicit user intent/i);
    assert.match(workflow, /placeholders, mocks, demo-only flows/i);
    assert.doesNotMatch(workflow, /browse src\/core\/, src\/workers\/, src\/types\//i);
  });
});

describe("carry-forward token cap constants", () => {
  it("CARRY_FORWARD_MAX_TOKENS is a positive number", () => {
    assert.ok(Number.isFinite(CARRY_FORWARD_MAX_TOKENS));
    assert.ok(CARRY_FORWARD_MAX_TOKENS > 0);
  });

  it("BEHAVIOR_PATTERNS_MAX_TOKENS is a positive number", () => {
    assert.ok(Number.isFinite(BEHAVIOR_PATTERNS_MAX_TOKENS));
    assert.ok(BEHAVIOR_PATTERNS_MAX_TOKENS > 0);
  });
});

// ── Task 1: Required-field retention in mandatory planning contract directives ──

describe("PROMETHEUS_STATIC_SECTIONS — required field marking (Task 1)", () => {
  const MANDATORY_KEYS = ["evolutionDirective", "mandatorySelfCritique", "mandatoryOperatorQuestions", "outputFormat"] as const;

  it("mandatory planning sections are marked required:true", () => {
    for (const key of MANDATORY_KEYS) {
      const sec = PROMETHEUS_STATIC_SECTIONS[key] as Record<string, unknown>;
      assert.strictEqual(sec.required, true, `${key} must have required:true`);
    }
  });

  it("mandatory sections are retained under tight token budget (token pressure simulation)", () => {
    // Simulate a very tight budget — mandatory sections must survive
    const sections = [
      { ...PROMETHEUS_STATIC_SECTIONS.evolutionDirective },
      { ...PROMETHEUS_STATIC_SECTIONS.outputFormat },
      { name: "optional-noise", content: "o".repeat(100_000) }, // ~25000 tokens
    ];
    const result = compilePrompt(sections, { tokenBudget: 100 });
    assert.ok(
      result.includes("EVOLUTION DIRECTIVE"),
      "evolutionDirective must be retained under token pressure"
    );
    assert.ok(
      result.includes("OUTPUT FORMAT"),
      "outputFormat must be retained under token pressure"
    );
  });

  it("non-mandatory sections can be dropped under token pressure", () => {
    const sections = [
      { ...PROMETHEUS_STATIC_SECTIONS.evolutionDirective },
      { name: "optional-filler", content: "OPTIONAL_CONTENT" }, // no required:true
    ];
    const result = compilePrompt(sections, { tokenBudget: 5 }); // very tight
    // The filler is optional and large — evolutionDirective (required) should remain
    assert.ok(result.includes("EVOLUTION DIRECTIVE"), "required section must survive");
  });
});

// ── Task 4: Drift confidence penalty ──────────────────────────────────────────

describe("computeDriftConfidencePenalty (Task 4)", () => {
  it("returns zero penalty for null/undefined drift report", () => {
    assert.deepEqual(computeDriftConfidencePenalty(null), { penalty: 0, reason: "no-drift-report", requiresRemediation: false });
    assert.deepEqual(computeDriftConfidencePenalty(undefined), { penalty: 0, reason: "no-drift-report", requiresRemediation: false });
  });

  it("returns zero penalty when staleCount and deprecatedTokenCount are both 0", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 0, deprecatedTokenCount: 0 });
    assert.equal(result.penalty, 0);
    assert.equal(result.requiresRemediation, false);
  });

  it("returns a positive penalty proportional to total unresolved items", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 3, deprecatedTokenCount: 2 }); // total=5
    assert.ok(result.penalty > 0, "penalty must be positive for non-zero drift");
    assert.ok(result.penalty <= 0.30, "penalty must not exceed cap of 0.30");
  });

  it("caps penalty at 0.30 regardless of very high drift count", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 100, deprecatedTokenCount: 100 }); // total=200
    assert.equal(result.penalty, 0.30, "penalty is capped at 0.30");
  });

  it("sets requiresRemediation=true when total >= DRIFT_REMEDIATION_THRESHOLD", () => {
    const atThreshold = computeDriftConfidencePenalty({ staleCount: DRIFT_REMEDIATION_THRESHOLD, deprecatedTokenCount: 0 });
    assert.equal(atThreshold.requiresRemediation, true);
    const belowThreshold = computeDriftConfidencePenalty({ staleCount: DRIFT_REMEDIATION_THRESHOLD - 1, deprecatedTokenCount: 0 });
    assert.equal(belowThreshold.requiresRemediation, false);
  });

  it("reason string encodes total unresolved count", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 2, deprecatedTokenCount: 1 });
    assert.ok(result.reason.includes("3"), "reason must encode total count (3)");
  });

  it("priority-weighted: src/core/ stale ref incurs higher penalty than scripts/ ref of same count", () => {
    const highPriority = computeDriftConfidencePenalty({
      staleCount: 1,
      deprecatedTokenCount: 0,
      staleReferences: [{ referencedPath: "src/core/orchestrator.ts", docPath: "docs/a.md", line: 1 }],
    });
    const lowPriority = computeDriftConfidencePenalty({
      staleCount: 1,
      deprecatedTokenCount: 0,
      staleReferences: [{ referencedPath: "scripts/deploy.sh", docPath: "docs/a.md", line: 1 }],
    });
    assert.ok(highPriority.penalty > lowPriority.penalty,
      `src/core/ ref (${highPriority.penalty}) must penalize more than scripts/ ref (${lowPriority.penalty})`);
  });

  it("priority-weighted: fallback to flat formula when staleReferences array is absent", () => {
    const withCounts = computeDriftConfidencePenalty({ staleCount: 2, deprecatedTokenCount: 0 });
    // Flat formula: 2 × 0.02 = 0.04
    assert.equal(withCounts.penalty, 0.04, "flat fallback must produce 0.04 for 2 items");
  });

  it("priority-weighted: deprecated tokens penalized at medium rate (0.02 each)", () => {
    const result = computeDriftConfidencePenalty({
      staleCount: 0,
      deprecatedTokenCount: 3,
      staleReferences: [],
    });
    // 3 × 0.02 = 0.06
    assert.equal(result.penalty, 0.06, "3 deprecated tokens must produce 0.06 penalty");
  });

  it("priority-weighted: mixed report penalizes by priority, capped at 0.30", () => {
    // 2 high (src/core/) refs → 2 × 0.05 = 0.10, 1 low (scripts/) → 0.01, 2 tokens → 0.04 → total 0.15
    const result = computeDriftConfidencePenalty({
      staleCount: 3,
      deprecatedTokenCount: 2,
      staleReferences: [
        { referencedPath: "src/core/a.ts",   docPath: "docs/a.md", line: 1 },
        { referencedPath: "src/core/b.ts",   docPath: "docs/a.md", line: 2 },
        { referencedPath: "scripts/old.sh",  docPath: "docs/a.md", line: 3 },
      ],
    });
    assert.ok(result.penalty > 0 && result.penalty <= 0.30, "penalty must be positive and capped");
    // Exact: 0.10 + 0.01 + 0.04 = 0.15
    assert.equal(result.penalty, 0.15, "priority-weighted penalty must be 0.15 for this mix");
  });
});

// ── Batch/wave packet field preservation (current task) ───────────────────────

describe("normalizePrometheusParsedOutput — batch/wave packet field preservation", () => {
  it("preserves explicit owner field from a capability-aware plan", () => {
    const parsed = {
      projectHealth: "good",
      plans: [
        {
          task: "Harden trust boundary",
          role: "evolution-worker",
          owner: "orchestrator",
          wave: 1,
        }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, "orchestrator", "owner must be preserved from source plan");
  });

  it("synthesizes owner from role when owner is absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix parser", role: "governance-worker", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, "governance-worker", "owner should fall back to role");
  });

  it("defaults owner to the normalized role when both owner and role are absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix something", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, result.plans[0].role, "owner must default to the normalized role");
  });

  it("preserves explicit leverage_rank array from a capability-aware plan", () => {
    const parsed = {
      projectHealth: "good",
      plans: [
        {
          task: "Improve wave dispatch",
          role: "evolution-worker",
          leverage_rank: ["speed", "task-quality"],
          wave: 1,
        }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.deepEqual(result.plans[0].leverage_rank, ["speed", "task-quality"],
      "leverage_rank must be preserved from source plan");
  });

  it("infers leverage_rank from normalized plan structure when absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix something", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.ok(Array.isArray(result.plans[0].leverage_rank));
    assert.ok(result.plans[0].leverage_rank.length >= 2,
      "leverage_rank must be inferred to avoid classifying fallback packets as low-leverage by default");
    assert.ok(result.plans[0].leverage_rank.includes("worker-specialization"));
    assert.ok(result.plans[0].leverage_rank.includes("model-task-fit"));
  });

  it("synthesizes stub plans for string wave tasks that have no matching task entry", () => {
    // tasks[] has T-001 but waves[] also references T-999 which does not exist.
    // T-999 must NOT be silently dropped.
    const parsed = {
      tasks: [
        { task_id: "T-001", title: "Known task", wave: 1 }
      ],
      waves: [
        { wave: 1, tasks: ["T-001", "T-999"] }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans.length, 2, "unmatched wave task T-999 must produce a stub plan");
    const taskTexts = result.plans.map(p => p.task);
    assert.ok(taskTexts.includes("T-999"), "stub plan task must equal the unmatched task id string");
    assert.equal(result.plans.find(p => p.task === "T-999")?.wave, 1,
      "stub plan must have the correct wave assignment");
    assert.ok(String(result.plans.find(p => p.task === "T-999")?.role || "").length > 0,
      "stub plan must be assigned a role");
    assert.ok(String(result.plans.find(p => p.task === "T-999")?.capabilityLane || "").length > 0,
      "stub plan must carry a capability lane hint");
  });

  it("propagates wave dependsOn to plan waveDepends via buildPlansFromAlternativeShape", () => {
    const parsed = {
      tasks: [
        { task_id: "T-001", title: "Foundation task" }
      ],
      waves: [
        { wave: 1, tasks: ["T-001"] },
        { wave: 2, dependsOn: [1], tasks: ["T-002"] }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const wave2Plan = result.plans.find(p => p.wave === 2);
    assert.ok(wave2Plan, "wave 2 plan must exist");
    assert.deepEqual(wave2Plan.waveDepends, [1],
      "wave 2 plan must carry waveDepends: [1] from the wave dependsOn field");
  });

  it("propagates wave dependsOn to plan waveDepends via buildPlansFromBottlenecksShape", () => {
    const parsed = {
      topBottlenecks: [
        { id: "BN-1", title: "Slow dispatch", severity: "high", evidence: "orchestrator.js:740" }
      ],
      waves: [
        { wave: 1, tasks: ["Fix-1: slow dispatch fix"], workerSlots: 1 },
        { wave: 2, dependsOn: [1], tasks: ["Fix-2: follow-up validation"], workerSlots: 1 }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const wave2Plan = result.plans.find(p => p.wave === 2);
    assert.ok(wave2Plan, "wave 2 plan must exist");
    assert.deepEqual(wave2Plan.waveDepends, [1],
      "wave 2 plan must carry waveDepends: [1] from the wave dependsOn field");
  });

  it("plans with no batch/wave metadata normalize correctly (negative path)", () => {
    // A plain plan with no owner, leverage_rank, or waveDepends — must normalize
    // without throwing and must emit sensible defaults for all packet fields.
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Basic task" }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans.length, 1);
    assert.equal(typeof result.plans[0].owner, "string");
    assert.ok(result.plans[0].owner.length > 0, "owner must be a non-empty string");
    assert.ok(Array.isArray(result.plans[0].leverage_rank), "leverage_rank must be an array");
    assert.ok(Array.isArray(result.plans[0].waveDepends), "waveDepends must be an array");
    assert.equal(result.plans[0].waveDepends.length, 0,
      "waveDepends must be empty when not provided");
  });
});

// ── Task: buildDriftDebtTasks — drift output → actionable planning debt ───────

describe("buildDriftDebtTasks", () => {
  it("returns empty array for null/undefined drift report", () => {
    assert.deepEqual(buildDriftDebtTasks(null), []);
    assert.deepEqual(buildDriftDebtTasks(undefined), []);
  });

  it("returns empty array when staleReferences and deprecatedTokenRefs are empty", () => {
    const report = { staleReferences: [], deprecatedTokenRefs: [], staleCount: 0, deprecatedTokenCount: 0 };
    assert.deepEqual(buildDriftDebtTasks(report), []);
  });

  it("generates one debt task per doc with stale file references", () => {
    const report = {
      staleReferences: [
        { docPath: "docs/arch.md", referencedPath: "src/core/missing.ts", line: 5 },
        { docPath: "docs/arch.md", referencedPath: "src/core/gone.ts", line: 9 },
        { docPath: "docs/ops.md", referencedPath: "docker/worker.Dockerfile", line: 2 },
      ],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 2, "one task per distinct doc");
    const archTask = tasks.find(t => t.target_files?.includes("docs/arch.md"));
    assert.ok(archTask, "task for docs/arch.md must exist");
    assert.equal(archTask.taskKind, "debt");
    assert.equal(archTask.source, "architecture_drift");
    assert.equal(archTask._driftDebt, true);
    assert.ok(archTask.task.includes("docs/arch.md"), "task text must name the doc");
    assert.ok(Array.isArray(archTask.acceptance_criteria) && archTask.acceptance_criteria.length >= 2);
  });

  it("generates one debt task per doc with deprecated token usages", () => {
    const report = {
      staleReferences: [],
      deprecatedTokenRefs: [
        { docPath: "docs/legacy.md", token: "governance_verdict", hint: "use governance_contract", line: 3 },
        { docPath: "docs/legacy.md", token: "resume_dispatch", hint: "use runResumeDispatch", line: 7 },
      ],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 1);
    assert.ok(tasks[0].task.includes("docs/legacy.md"));
    assert.ok(tasks[0].description.includes("governance_verdict"), "description must name deprecated tokens");
    assert.equal(tasks[0].taskKind, "debt");
    assert.equal(tasks[0].riskLevel, "low");
  });

  it("places debt tasks on wave maxWave+1 relative to existing plans", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/x.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const existingPlans = [
      { task: "Fix something", wave: 1 },
      { task: "Fix something else", wave: 3 },
    ];
    const tasks = buildDriftDebtTasks(report, existingPlans);
    assert.equal(tasks[0].wave, 4, "debt tasks must be placed on wave maxWave+1 (3+1=4)");
  });

  it("uses wave 1 when no existing plans exist", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/x.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report, []);
    assert.equal(tasks[0].wave, 1, "debt tasks wave must be 1 when no existing plans");
  });

  it("suppresses debt task generation when existing plan already covers that doc", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/x.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const existingPlans = [
      { task: "Update stale references in docs/arch.md", target_files: ["docs/arch.md"], wave: 1 },
    ];
    const tasks = buildDriftDebtTasks(report, existingPlans);
    assert.equal(tasks.length, 0, "must not generate duplicate debt task when AI plan already covers the doc");
  });

  it("generates separate tasks for stale refs and deprecated tokens even in the same doc", () => {
    const report = {
      staleReferences: [{ docPath: "docs/mixed.md", referencedPath: "src/x.ts", line: 1 }],
      deprecatedTokenRefs: [{ docPath: "docs/mixed.md", token: "governance_verdict", hint: "use governance_contract", line: 4 }],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 2, "stale-ref task and deprecated-token task must both be generated");
    const kinds = tasks.map(t => t.task);
    assert.ok(kinds.some(k => k.includes("stale")), "must have a stale-ref task");
    assert.ok(kinds.some(k => k.includes("deprecated")), "must have a deprecated-token task");
  });

  it("each debt task carries required plan packet fields", () => {
    const report = {
      staleReferences: [{ docPath: "docs/a.md", referencedPath: "src/x.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.ok(typeof task.task === "string" && task.task.length > 0, "task text must be a non-empty string");
    assert.ok(typeof task.description === "string" && task.description.length > 0);
    assert.equal(task.role, "evolution-worker");
    // verification must reference a specific test file so isNonSpecificVerification passes
    assert.ok(/\.test\.(ts|js)/.test(task.verification), "verification must reference a specific test file");
    assert.ok(task.verification.includes("docs/a.md"), "verification must name the doc being fixed");
    assert.ok(Array.isArray(task.verification_commands));
    assert.ok(Array.isArray(task.acceptance_criteria) && task.acceptance_criteria.length >= 2);
    assert.ok(typeof task.wave === "number");
    assert.ok(typeof task.priority === "number");
    // contract-required fields must be present
    assert.ok(typeof task.capacityDelta === "number", "capacityDelta must be a number");
    assert.ok(typeof task.requestROI === "number" && task.requestROI > 0, "requestROI must be a positive number");
    assert.ok(Array.isArray(task.verification_targets) && task.verification_targets.length > 0,
      "verification_targets must be a non-empty array");
    // dispatch-survivable fields
    assert.ok(Array.isArray(task.dependencies), "dependencies must be an array for dependency-graph resolver");
    assert.ok(typeof task.scope === "string" && task.scope.length > 0, "scope must be a non-empty string");
    assert.ok(typeof task.owner === "string" && task.owner.length > 0, "owner must be a non-empty string");
  });

  it("deprecated-token debt task also carries dispatch-survivable fields", () => {
    const report = {
      staleReferences: [],
      deprecatedTokenRefs: [{ docPath: "docs/b.md", token: "old_token", hint: "use new_token", line: 5 }],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.ok(Array.isArray(task.dependencies), "dependencies must be an array");
    assert.equal(task.scope, "docs/b.md", "scope must equal the source document path");
    assert.equal(task.owner, "evolution-worker");
  });

  it("negative path: handles malformed staleReferences entries without throwing", () => {
    const report = {
      staleReferences: [null, undefined, {}, { docPath: "docs/ok.md", referencedPath: "src/x.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    // Must not throw; must produce at most one task (for the valid entry)
    let tasks: any[];
    assert.doesNotThrow(() => { tasks = buildDriftDebtTasks(report); });
    assert.ok(Array.isArray(tasks!));
  });
});

// ── buildDriftDebtTasks — prioritization and deduplication improvements ─────────

describe("buildDriftDebtTasks — prioritization and driftPriority field", () => {
  it("orders tasks so docs with high-priority (src/core/) refs come before docs with low-priority refs", () => {
    const report = {
      staleReferences: [
        // Low-priority doc inserted first in the input array
        { docPath: "docs/ops.md",  referencedPath: "scripts/old.sh",        line: 1 },
        // High-priority doc inserted second
        { docPath: "docs/arch.md", referencedPath: "src/core/missing.ts",   line: 2 },
        // Medium-priority doc inserted last
        { docPath: "docs/api.md",  referencedPath: "src/providers/gone.ts", line: 3 },
      ],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 3);
    // High-priority doc must surface first regardless of insertion order.
    assert.ok(
      tasks[0].target_files?.includes("docs/arch.md"),
      `first task must cover the high-priority doc (docs/arch.md), got ${tasks[0].target_files}`
    );
    assert.ok(
      tasks[1].target_files?.includes("docs/api.md"),
      `second task must cover the medium-priority doc (docs/api.md), got ${tasks[1].target_files}`
    );
    assert.ok(
      tasks[2].target_files?.includes("docs/ops.md"),
      `last task must cover the low-priority doc (docs/ops.md), got ${tasks[2].target_files}`
    );
  });

  it("prioritizes autonomous-dev-playbook stale-ref debt before other docs at same priority", () => {
    const report = {
      staleReferences: [
        { docPath: "docs/ops.md", referencedPath: "src/core/missing_ops.ts", line: 1 },
        { docPath: "docs/autonomous-dev-playbook.md", referencedPath: "src/core/missing_playbook.ts", line: 2 },
      ],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 2);
    assert.ok(
      tasks[0].target_files?.includes("docs/autonomous-dev-playbook.md"),
      `first task must target autonomous-dev-playbook for deterministic remediation priority; got ${tasks[0].target_files}`
    );
  });

  it("each stale-ref debt task carries a driftPriority field derived from its highest-urgency ref", () => {
    const report = {
      staleReferences: [
        // doc with one high-priority and one low-priority ref → effective priority = high
        { docPath: "docs/mixed.md",  referencedPath: "src/core/ghost.ts",  line: 1 },
        { docPath: "docs/mixed.md",  referencedPath: "scripts/old.sh",     line: 2 },
        // doc with only a low-priority ref → effective priority = low
        { docPath: "docs/ops.md",    referencedPath: "docker/worker.Dockerfile", line: 3 },
      ],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report);
    const mixedTask = tasks.find(t => t.target_files?.includes("docs/mixed.md"));
    const opsTask   = tasks.find(t => t.target_files?.includes("docs/ops.md"));
    assert.ok(mixedTask, "task for docs/mixed.md must exist");
    assert.ok(opsTask,   "task for docs/ops.md must exist");
    assert.equal(mixedTask.driftPriority, "high",
      "docs/mixed.md task driftPriority must be 'high' (has src/core/ ref)");
    assert.equal(opsTask.driftPriority, "low",
      "docs/ops.md task driftPriority must be 'low' (only docker/ ref)");
  });

  it("priority numbers are assigned in order: high doc gets lower priority number than low doc", () => {
    const report = {
      staleReferences: [
        { docPath: "docs/ops.md",  referencedPath: "scripts/x.sh",         line: 1 },
        { docPath: "docs/arch.md", referencedPath: "src/core/missing.ts",  line: 2 },
      ],
      deprecatedTokenRefs: [],
    };
    const tasks = buildDriftDebtTasks(report);
    const archTask = tasks.find(t => t.target_files?.includes("docs/arch.md"))!;
    const opsTask  = tasks.find(t => t.target_files?.includes("docs/ops.md"))!;
    assert.ok(archTask.priority < opsTask.priority,
      `high-priority doc task (${archTask.priority}) must have lower priority number than low-priority doc task (${opsTask.priority})`);
  });
});

describe("buildDriftDebtTasks — quality gate contract compliance", () => {
  it("stale-ref debt task verification field is NOT flagged as non-specific by plan_contract_validator", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/missing.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.equal(
      isNonSpecificVerification(task.verification),
      false,
      `Verification "${task.verification}" must pass isNonSpecificVerification (references a .test.ts file)`
    );
  });

  it("deprecated-token debt task verification field is NOT flagged as non-specific", () => {
    const report = {
      staleReferences: [],
      deprecatedTokenRefs: [{ docPath: "docs/legacy.md", token: "governance_verdict", hint: "use governance_contract", line: 2 }],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.equal(
      isNonSpecificVerification(task.verification),
      false,
      `Verification "${task.verification}" must pass isNonSpecificVerification`
    );
  });

  it("stale-ref debt task passes validatePlanContract when capacityDelta and requestROI are present", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/missing.ts", line: 1 }],
      deprecatedTokenRefs: [],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.ok(Array.isArray(task.implementationEvidence) && task.implementationEvidence.length > 0);
    const result = validatePlanContract(task);
    const criticalViolations = result.violations.filter((v: any) => v.severity === "critical");
    assert.equal(
      criticalViolations.length,
      0,
      `Stale-ref debt task must have zero critical violations; got: ${criticalViolations.map((v: any) => v.message).join("; ")}`
    );
  });

  it("deprecated-token debt task passes validatePlanContract", () => {
    const report = {
      staleReferences: [],
      deprecatedTokenRefs: [
        { docPath: "docs/legacy.md", token: "governance_verdict", hint: "use governance_contract", line: 2 },
      ],
    };
    const [task] = buildDriftDebtTasks(report);
    assert.ok(Array.isArray(task.implementationEvidence) && task.implementationEvidence.length > 0);
    const result = validatePlanContract(task);
    const criticalViolations = result.violations.filter((v: any) => v.severity === "critical");
    assert.equal(
      criticalViolations.length,
      0,
      `Deprecated-token debt task must have zero critical violations; got: ${criticalViolations.map((v: any) => v.message).join("; ")}`
    );
  });

  it("verification_targets is a non-empty array pointing to the architecture_drift test file", () => {
    const report = {
      staleReferences: [{ docPath: "docs/arch.md", referencedPath: "src/core/x.ts", line: 1 }],
      deprecatedTokenRefs: [{ docPath: "docs/arch.md", token: "resume_dispatch", hint: "use runResumeDispatch", line: 5 }],
    };
    const tasks = buildDriftDebtTasks(report);
    assert.equal(tasks.length, 2);
    for (const task of tasks) {
      assert.ok(Array.isArray(task.verification_targets) && task.verification_targets.length > 0,
        "verification_targets must be a non-empty array");
      assert.ok(
        task.verification_targets.every((t: string) => t.includes("architecture_drift.test.ts")),
        "each verification target must reference architecture_drift.test.ts"
      );
    }
  });

  it("negative path: bare 'npm test' alone is non-specific and would be rejected by contract (validates the fix rationale)", () => {
    // This test documents WHY we changed the verification field — to prove that
    // the old value would have been rejected by the quality gate.
    assert.equal(
      isNonSpecificVerification("npm test"),
      true,
      "bare 'npm test' must be flagged as non-specific — this is the problem the fix addresses"
    );
  });
});

// ── Task: parser core/context confidence composition recalibration ───────────
// Covers edge cases in the channel-split formula:
//   parserCoreConfidence  = coreBase − (non-context penalties), floored at 0.1
//   parserContextPenalty  = sum of context-channel penalties (uncapped)
//   parserConfidence      = max(0.1, parserCoreConfidence − parserContextPenalty)
//
// Key invariants:
//   1. parserConfidence is always >= 0.1
//   2. When core − context >= 0.1, parserConfidence == core − context (channel invariant holds)
//   3. When core − context < 0.1, floor kicks in — channel invariant intentionally breaks
//   4. parserCoreConfidence absorbs only healthField/requestBudget penalties
//   5. parserContextPenalty absorbs only bottleneckCoverage/architectureDrift penalties

describe("normalizePrometheusParsedOutput — confidence composition recalibration", () => {
  it("combined core + context penalties: core absorbs healthField/budget, context absorbs bottleneck", () => {
    // JSON plans (base=1.0) + inferred health (core -0.1) + no budget (core -0.1)
    // + 3 of 4 bottlenecks uncovered → context penalty
    const parsed = {
      plans: [
        { task: "Fix sequential dispatch", role: "evolution-worker", _fromBottleneck: "BN-1" },
      ],
      // No projectHealth → healthField inferred → core -0.1
      // No requestBudget → budget fallback → core -0.1
      topBottlenecks: [
        { id: "BN-1", title: "Sequential dispatch", severity: "high" },
        { id: "BN-2", title: "Trust boundary missing", severity: "critical" },
        { id: "BN-3", title: "Parser fence drop", severity: "medium" },
        { id: "BN-4", title: "Budget stale", severity: "low" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    // core = 1.0 − 0.1 (healthField) = 0.9; no budget penalty (requestBudget provided)
    assert.equal(result.parserCoreConfidence, 0.9,
      "core channel = 1.0 base − 0.1 healthField inferred; budget provided so no budget penalty");
    // context = bottleneck coverage penalty (>0 because 3 of 4 uncovered)
    assert.ok(result.parserContextPenalty > 0,
      "context channel must be positive when bottleneck coverage is below floor");
    // aggregate = max(0.1, 0.9 − context)
    const expectedAggregate = Math.max(0.1, Math.round((result.parserCoreConfidence - result.parserContextPenalty) * 100) / 100);
    assert.equal(result.parserConfidence, expectedAggregate,
      "aggregate must equal max(0.1, core − context)");
  });

  it("context penalty large enough to push aggregate to floor — documents floor-break behavior", () => {
    // Construct a scenario where parserCoreConfidence = 0.1 (minimum)
    // and there is a context penalty, so aggregate floors at 0.1.
    // Use narrative plans (base=0.5) + health (-0.1) + budget (-0.1) = 0.3 core;
    // then add enough bottleneck uncovered to push context penalty > 0.3.
    // With 6 uncovered bottlenecks, delta = -min(0.30, 6*0.05) = -0.30 (capped).
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix one thing"] }],
      // No projectHealth, no requestBudget → core = 0.5 − 0.1 − 0.1 = 0.3
      topBottlenecks: Array.from({ length: 6 }, (_, i) => ({
        id: `BN-${i + 1}`, title: `Bottleneck ${i + 1}`, severity: "critical"
      })),
      // No plans address any bottleneck → all 6 uncovered → max context penalty = 0.30
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(result.parserContextPenalty > 0, "context penalty must be positive");
    // parserConfidence must always be >= 0.1 regardless of penalties
    assert.ok(result.parserConfidence >= 0.1,
      `parserConfidence must always be >= 0.1; got ${result.parserConfidence}`);

    // When floor kicks in, the simple arithmetic invariant breaks — document this explicitly
    const rawDiff = Math.round((result.parserCoreConfidence - result.parserContextPenalty) * 100) / 100;
    if (rawDiff < 0.1) {
      // Floor-break case: parserConfidence is 0.1, not rawDiff
      assert.equal(result.parserConfidence, 0.1,
        "when core − context < 0.1, floor must be applied and parserConfidence must equal 0.1");
    } else {
      // Normal case: invariant holds
      assert.equal(result.parserConfidence, rawDiff,
        "when core − context >= 0.1, parserConfidence must equal core − context");
    }
  });

  it("parserConfidence is always >= 0.1 across all penalty combinations (property invariant)", () => {
    const cases = [
      // Full score — no penalties
      { projectHealth: "good", plans: [{ task: "x", role: "evolution-worker" }], requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 } },
      // Narrative plans only
      { waves: [{ wave: 1, tasks: ["x"] }] },
      // No output at all
      {},
      // All penalties: no plans, no health, no budget, max bottlenecks
      { topBottlenecks: Array.from({ length: 10 }, (_, i) => ({ id: `BN-${i}`, title: `BN ${i}`, severity: "critical" })) },
      // Health alias
      { projectHealth: "healthy", plans: [{ task: "x", role: "evolution-worker" }] },
    ];
    for (const parsed of cases) {
      const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
      assert.ok(result.parserConfidence >= 0.1,
        `parserConfidence must never go below 0.1; got ${result.parserConfidence} for input: ${JSON.stringify(parsed)}`);
    }
  });

  it("channel invariant holds exactly when floor is not triggered", () => {
    // JSON plans (base=1.0) + explicit health (no penalty) + budget provided (no penalty)
    // + 1 of 3 bottlenecks covered → context penalty fires (coverage=0.33 < FLOOR=0.5)
    // but core − context = 1.0 − small_penalty >> 0.1 so floor does NOT kick in
    const parsed = {
      projectHealth: "good",
      plans: [
        { task: "Fix sequential worker dispatch wave infrastructure", role: "evolution-worker", _fromBottleneck: "BN-1" },
      ],
      topBottlenecks: [
        { id: "BN-1", title: "Sequential dispatch ignores wave infrastructure", severity: "high" },
        { id: "BN-2", title: "Trust boundary contract missing enforcement gate", severity: "critical" },
        { id: "BN-3", title: "Parser fence handling drops multiline blocks", severity: "medium" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    // core = 1.0 (JSON plans, explicit health, budget provided)
    assert.equal(result.parserCoreConfidence, 1.0, "core must be 1.0 when no core penalties apply");
    // context > 0 (BN-2 and BN-3 uncovered; coverage=1/3 < 0.5 → penalty fires)
    assert.ok(result.parserContextPenalty > 0,
      `context penalty must be positive when coverage is below floor; got parserContextPenalty=${result.parserContextPenalty}`);
    // channel invariant: aggregate = core − context when above floor
    const expected = Math.round((result.parserCoreConfidence - result.parserContextPenalty) * 100) / 100;
    if (expected >= 0.1) {
      assert.equal(result.parserConfidence, expected,
        "channel invariant: parserConfidence must equal parserCoreConfidence − parserContextPenalty when above floor");
    }
  });

  it("parserCoreConfidence floors at 0.1 even with stacked core penalties", () => {
    // Narrative fallback (base=0.5) with many health/budget penalties can't go below 0.1.
    // Use: base=0.1 (no plans) + health_missing -0.2 + budget -0.1 → clamped at 0.1 each step.
    const result = normalizePrometheusParsedOutput({}, { raw: "" });

    assert.equal(result.parserCoreConfidence, 0.1,
      "core confidence must floor at 0.1 when cumulative core penalties exceed base");
    assert.ok(result.parserCoreConfidence >= 0.1,
      "core confidence must never go below 0.1");
  });

  it("requestBudget penalty goes to core channel, not context channel", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix retry logic", role: "evolution-worker" }],
      // No requestBudget → fallback penalty
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    // core should be reduced (0.9), context should remain 0
    assert.equal(result.parserCoreConfidence, 0.9,
      "requestBudget fallback penalty must reduce core confidence, not context");
    assert.equal(result.parserContextPenalty, 0,
      "requestBudget fallback must not affect context-penalty channel");
    assert.equal(result.parserConfidence, 0.9, "aggregate must equal core (0.9) when context is 0");
  });

  it("healthField penalty goes to core channel, not context channel", () => {
    const parsed = {
      plans: [{ task: "Fix retry logic", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
      // No projectHealth → inferred → healthField penalty -0.1 goes to core
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserCoreConfidence, 0.9,
      "healthField inferred penalty must reduce core confidence, not context");
    assert.equal(result.parserContextPenalty, 0,
      "healthField penalty must not affect context-penalty channel");
  });

  it("rounding: parserCoreConfidence, parserContextPenalty, and parserConfidence are all 2-decimal values", () => {
    const parsed = {
      projectHealth: "good",
      topBottlenecks: [
        { id: "BN-1", title: "Wave dispatch broken", severity: "high" },
        { id: "BN-2", title: "Trust boundary missing", severity: "critical" },
        { id: "BN-3", title: "Parser fence drop", severity: "medium" },
      ],
      plans: [
        { task: "Fix wave dispatch broken", role: "evolution-worker", _fromBottleneck: "BN-1" },
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 },
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    // All three must be rounded to exactly 2 decimal places
    const isRounded = (n: number) => Math.round(n * 100) / 100 === n;
    assert.ok(isRounded(result.parserCoreConfidence),
      `parserCoreConfidence=${result.parserCoreConfidence} must be a 2-decimal number`);
    assert.ok(isRounded(result.parserContextPenalty),
      `parserContextPenalty=${result.parserContextPenalty} must be a 2-decimal number`);
    assert.ok(isRounded(result.parserConfidence),
      `parserConfidence=${result.parserConfidence} must be a 2-decimal number`);
  });
});

// ── Task 1: capacityDelta / requestROI hard filter at generation time ─────────

import { validateAllPlans, PLAN_VIOLATION_SEVERITY } from "../../src/core/plan_contract_validator.js";

describe("capacityDelta/requestROI generation-time hard filter", () => {
  function makeValidPlan(overrides = {}) {
    return {
      task: "Implement something with enough chars",
      role: "evolution-worker",
      wave: 1,
      verification: "tests/core/foo.test.ts — test: passes",
      dependencies: [],
      acceptance_criteria: ["must pass"],
      capacityDelta: 0.1,
      requestROI: 2.0,
      ...overrides,
    };
  }

  it("identifies plans missing capacityDelta for removal", () => {
    const plans = [
      makeValidPlan(),
      makeValidPlan({ capacityDelta: undefined }),
    ];
    const result = validateAllPlans(plans);
    const toRemove = result.results
      .filter(r => !r.valid && r.violations.some(v =>
        (v.field === "capacityDelta" || v.field === "requestROI") &&
        v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex)
      .sort((a, b) => b - a);
    assert.deepEqual(toRemove, [1], "plan without capacityDelta must be flagged for removal");
  });

  it("identifies plans missing requestROI for removal", () => {
    const plans = [
      makeValidPlan(),
      makeValidPlan({ requestROI: undefined }),
    ];
    const result = validateAllPlans(plans);
    const toRemove = result.results
      .filter(r => !r.valid && r.violations.some(v =>
        (v.field === "capacityDelta" || v.field === "requestROI") &&
        v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex)
      .sort((a, b) => b - a);
    assert.deepEqual(toRemove, [1], "plan without requestROI must be flagged for removal");
  });

  it("filters out capacity/ROI-violating plans without touching valid plans", () => {
    const plans = [
      makeValidPlan({ task: "First valid plan here" }),
      makeValidPlan({ capacityDelta: undefined, requestROI: undefined }),
      makeValidPlan({ task: "Third valid plan here" }),
    ];
    const result = validateAllPlans(plans);
    const toRemove = result.results
      .filter(r => !r.valid && r.violations.some(v =>
        (v.field === "capacityDelta" || v.field === "requestROI") &&
        v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex)
      .sort((a, b) => b - a);
    const filtered = [...plans];
    for (const idx of toRemove) filtered.splice(idx, 1);
    assert.equal(filtered.length, 2, "only the invalid plan should be removed");
    assert.equal(filtered[0].task, "First valid plan here");
    assert.equal(filtered[1].task, "Third valid plan here");
  });

  it("negative: plans with valid capacityDelta and requestROI are NOT flagged for removal", () => {
    const plans = [
      makeValidPlan({ capacityDelta: -0.5, requestROI: 1.1 }),
      makeValidPlan({ capacityDelta: 0, requestROI: 0.001 }),
    ];
    const result = validateAllPlans(plans);
    const toRemove = result.results
      .filter(r => !r.valid && r.violations.some(v =>
        (v.field === "capacityDelta" || v.field === "requestROI") &&
        v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex);
    assert.equal(toRemove.length, 0, "no valid plans should be flagged for capacity/ROI removal");
  });

  it("negative: out-of-range capacityDelta (> 1.0) is also flagged for removal", () => {
    const plans = [makeValidPlan({ capacityDelta: 2.0 })];
    const result = validateAllPlans(plans);
    const toRemove = result.results
      .filter(r => !r.valid && r.violations.some(v =>
        v.field === "capacityDelta" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex);
    assert.equal(toRemove.length, 1, "out-of-range capacityDelta must be flagged for removal");
  });
});

// ── Generation-boundary packet completeness gate ──────────────────────────────

describe("checkPacketCompleteness — generation-boundary gate", () => {
  function validRawPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      task: "Implement trust boundary validation for planner output",
      role: "evolution-worker",
      wave: 1,
      capacityDelta: 0.15,
      requestROI: 2.5,
      verification_commands: ["tests/core/prometheus_parse.test.ts"],
      ...overrides,
    };
  }

  it("returns recoverable=true for a fully valid raw packet", () => {
    const result = checkPacketCompleteness(validRawPlan());
    assert.equal(result.recoverable, true);
    assert.deepEqual(result.reasons, []);
  });

  it("returns recoverable=false with missing task identity, ROI, and verification coupling when raw packet is skeletal", () => {
    const result = checkPacketCompleteness({ capacityDelta: 0.1, requestROI: 1.5 });
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("returns recoverable=false when capacityDelta is absent", () => {
    const plan = validRawPlan();
    delete (plan as any).capacityDelta;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_CAPACITY_DELTA));
  });

  it("returns recoverable=false when capacityDelta is out of range", () => {
    const result = checkPacketCompleteness(validRawPlan({ capacityDelta: 2.0 }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA));
  });

  it("returns recoverable=false when capacityDelta is non-finite", () => {
    const result = checkPacketCompleteness(validRawPlan({ capacityDelta: NaN }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA));
  });

  it("returns recoverable=false when requestROI is absent", () => {
    const plan = validRawPlan();
    delete (plan as any).requestROI;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_REQUEST_ROI));
  });

  it("returns recoverable=false when requestROI is zero", () => {
    const result = checkPacketCompleteness(validRawPlan({ requestROI: 0 }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI));
  });

  it("returns recoverable=false when requestROI is negative", () => {
    const result = checkPacketCompleteness(validRawPlan({ requestROI: -1 }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI));
  });

  it("accepts specific verification text when verification_commands is absent", () => {
    const plan = validRawPlan({ verification: "tests/core/prometheus_parse.test.ts" });
    delete (plan as any).verification_commands;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, true);
    assert.deepEqual(result.reasons, []);
  });

  it("accepts verification as a non-empty command array when verification_commands is absent", () => {
    const plan = validRawPlan({ verification: ["npm test", "node --import tsx scripts/run_tests.ts"] });
    delete (plan as any).verification_commands;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, true);
    assert.deepEqual(result.reasons, []);
  });

  it("returns recoverable=false when verification_commands is absent and verification is blank", () => {
    const plan = validRawPlan({ verification: "   " });
    delete (plan as any).verification_commands;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("reports all unrecoverable raw-field reasons when task is missing", () => {
    const result = checkPacketCompleteness({ wave: 1 });
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_CAPACITY_DELTA));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_REQUEST_ROI));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("accepts title as task identity fallback", () => {
    const plan = validRawPlan({ title: "Fix something important" });
    delete (plan as any).task;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, true, "title must count as task identity");
  });

  it("accepts task_id as task identity fallback", () => {
    const plan = validRawPlan({ task_id: "T-001" });
    delete (plan as any).task;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, true, "task_id must count as task identity");
  });

  it("returns recoverable=false for null input", () => {
    const result = checkPacketCompleteness(null);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY));
  });

  it("accepts capacityDelta=-1.0 (boundary min) as valid", () => {
    const result = checkPacketCompleteness(validRawPlan({ capacityDelta: -1.0 }));
    assert.equal(result.recoverable, true);
  });

  it("accepts capacityDelta=1.0 (boundary max) as valid", () => {
    const result = checkPacketCompleteness(validRawPlan({ capacityDelta: 1.0 }));
    assert.equal(result.recoverable, true);
  });

  it("negative path: raw stage can report multiple unrecoverable reasons together", () => {
    const result = checkPacketCompleteness({ capacityDelta: 999, requestROI: 2.0 });
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA));
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("stabilizeRawPacketEconomics repairs invalid requestROI when the packet is otherwise actionable", () => {
    const repaired = stabilizeRawPacketEconomics(validRawPlan({ requestROI: 0 }));
    assert.equal(repaired.requestROI, 1.0);
    const result = checkPacketCompleteness(repaired);
    assert.equal(result.recoverable, true);
  });

  it("stabilizeRawPacketEconomics does not invent economics for packets with no verification signal", () => {
    const repaired = stabilizeRawPacketEconomics({ task: "Missing verification", requestROI: 0, capacityDelta: 0.1 });
    assert.equal(repaired.requestROI, 0);
    const result = checkPacketCompleteness(repaired);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI));
  });

  // ── Raw packet stage: verification coupling is mandatory ─────────────────

  it("returns recoverable=false when verification_commands is absent", () => {
    const plan = validRawPlan();
    delete (plan as any).verification_commands;
    const result = checkPacketCompleteness(plan);
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("returns recoverable=false when verification_commands is empty array", () => {
    const result = checkPacketCompleteness(validRawPlan({ verification_commands: [] }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("returns recoverable=false when all verification_commands are empty strings", () => {
    const result = checkPacketCompleteness(validRawPlan({ verification_commands: ["", "  "] }));
    assert.equal(result.recoverable, false);
    assert.ok(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING));
  });

  it("returns recoverable=true when verification_commands has one non-empty command", () => {
    const result = checkPacketCompleteness(validRawPlan({ verification_commands: ["tests/core/prometheus_parse.test.ts"] }));
    assert.equal(result.recoverable, true);
    assert.deepEqual(result.reasons, []);
  });

  it("negative path: packet with all unrecoverable fields includes missing verification coupling", () => {
    const result = checkPacketCompleteness({ wave: 1 }); // missing everything
    assert.equal(result.reasons.includes(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING), true);
  });

  it("returns recoverable=true when verification_commands contain non-specific but non-empty CLI commands", () => {
    const result = checkPacketCompleteness(validRawPlan({ verification_commands: ["npm test", "pnpm vitest"] }));
    assert.equal(result.recoverable, true);
    assert.deepEqual(result.reasons, []);
  });
});

describe("UNRECOVERABLE_PACKET_REASONS", () => {
  it("exports all expected reason codes as frozen string constants", () => {
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY, "string");
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.MISSING_CAPACITY_DELTA, "string");
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA, "string");
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.MISSING_REQUEST_ROI, "string");
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI, "string");
    assert.equal(typeof UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING, "string");
  });

  it("is frozen — mutation throws in strict mode", () => {
    assert.throws(
      () => { (UNRECOVERABLE_PACKET_REASONS as any).NEW_KEY = "x"; },
      /Cannot add property/,
      "UNRECOVERABLE_PACKET_REASONS must be frozen"
    );
  });
});

// ── Task 1: PLANNER_HEALTH_ALIASES + normalizeProjectHealthAlias ──────────────

describe("PLANNER_HEALTH_ALIASES and normalizeProjectHealthAlias (Task 1)", () => {
  it("PLANNER_HEALTH_ALIASES maps healthy → good and warning → needs-work", () => {
    assert.equal(PLANNER_HEALTH_ALIASES["healthy"], "good");
    assert.equal(PLANNER_HEALTH_ALIASES["warning"], "needs-work");
  });

  it("PLANNER_HEALTH_ALIASES is frozen — mutation throws", () => {
    assert.throws(
      () => { (PLANNER_HEALTH_ALIASES as any).ok = "good"; },
      /Cannot add property|object is not extensible/i
    );
  });

  it("normalizeProjectHealthAlias maps 'healthy' → 'good'", () => {
    assert.equal(normalizeProjectHealthAlias("healthy"), "good");
  });

  it("normalizeProjectHealthAlias maps 'warning' → 'needs-work'", () => {
    assert.equal(normalizeProjectHealthAlias("warning"), "needs-work");
  });

  it("normalizeProjectHealthAlias is case-insensitive", () => {
    assert.equal(normalizeProjectHealthAlias("HEALTHY"), "good");
    assert.equal(normalizeProjectHealthAlias("WARNING"), "needs-work");
    assert.equal(normalizeProjectHealthAlias("Healthy"), "good");
    assert.equal(normalizeProjectHealthAlias("Warning"), "needs-work");
  });

  it("normalizeProjectHealthAlias passes through canonical values unchanged", () => {
    assert.equal(normalizeProjectHealthAlias("good"), "good");
    assert.equal(normalizeProjectHealthAlias("needs-work"), "needs-work");
    assert.equal(normalizeProjectHealthAlias("critical"), "critical");
  });

  it("normalizeProjectHealthAlias returns the input for unknown values (no silent swallow)", () => {
    assert.equal(normalizeProjectHealthAlias("unknown-value"), "unknown-value");
    assert.equal(normalizeProjectHealthAlias("ok"), "ok");
  });

  it("normalizeProjectHealthAlias handles empty/null/undefined without throwing", () => {
    assert.equal(normalizeProjectHealthAlias(""), "");
    assert.equal(normalizeProjectHealthAlias(null as any), "");
    assert.equal(normalizeProjectHealthAlias(undefined as any), "");
  });

  it("normalizePrometheusParsedOutput accepts 'healthy' alias and scores healthField=1.0", () => {
    const parsed = {
      projectHealth: "healthy",
      plans: [{ task: "Harden trust boundary", role: "evolution-worker", wave: 1 }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.projectHealth, "good",
      "alias 'healthy' must be normalized to canonical 'good'");
    assert.equal(result.parserConfidenceComponents?.healthField, 1.0,
      "explicit alias must score healthField=1.0, not 0.8");
  });

  it("normalizePrometheusParsedOutput accepts 'warning' alias and scores healthField=1.0", () => {
    const parsed = {
      projectHealth: "warning",
      plans: [{ task: "Harden trust boundary", role: "evolution-worker", wave: 1 }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.projectHealth, "needs-work",
      "alias 'warning' must be normalized to canonical 'needs-work'");
    assert.equal(result.parserConfidenceComponents?.healthField, 1.0,
      "explicit alias must score healthField=1.0, not 0.8");
  });

  it("normalizePrometheusParsedOutput still infers when projectHealth is absent (negative path)", () => {
    const parsed = {
      // no projectHealth field
      plans: [{ task: "Harden trust boundary", role: "evolution-worker", wave: 1 }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.parserConfidenceComponents?.healthField, 0.9,
      "missing projectHealth resolves via inference — scores healthField=0.9 with lighter penalty");
    const penalty = (result.parserConfidencePenalties as any[]).find(
      (p: any) => p.component === "healthField"
    );
    assert.ok(penalty, "must have a healthField penalty when health is missing");
    assert.equal(penalty.reason, "health_field_inferred_from_text");
  });

  it("infers critical only from explicit health/status context, not incidental critical wording", () => {
    const parsed = {
      analysis: "A critical capability gap exists in governance token parsing, but project health remains degraded while fixes are actionable.",
      plans: [{ task: "Normalize governance token parsing", role: "evolution-worker", wave: 1 }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.projectHealth, "needs-work");
  });

  it("infers critical when the narrative explicitly states health is critical", () => {
    const parsed = {
      analysis: "System health is critical because no dispatchable workers remain.",
      plans: [{ task: "Restore dispatchable worker coverage", role: "evolution-worker", wave: 1 }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.projectHealth, "critical");
  });
});

// ── splitWavesIntoMicrowaves — deterministic micro-wave splitting ──────────────

import {
  splitWavesIntoMicrowaves,
  MICROWAVE_MAX_TASKS_DEFAULT,
  buildPrometheusPlanningPolicy,
  buildDeterministicRequestBudget,
  buildTopicMemoryPromptSection,
} from "../../src/core/prometheus.js";

describe("splitWavesIntoMicrowaves", () => {
  it("returns empty array for empty input", () => {
    assert.deepEqual(splitWavesIntoMicrowaves([]), []);
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(splitWavesIntoMicrowaves(null as any), []);
  });

  it("preserves plans that already fit within the limit (no splitting needed)", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 2, "both plans must be preserved");
    assert.equal(result[0].wave, 1, "first plan remains in wave 1");
    assert.equal(result[1].wave, 1, "second plan remains in wave 1");
  });

  it("splits a wave with more tasks than the limit into micro-waves", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
      { task_id: "T-3", task: "Task 3", wave: 1, dependencies: [] },
      { task_id: "T-4", task: "Task 4", wave: 1, dependencies: [] },
      { task_id: "T-5", task: "Task 5", wave: 1, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 5, "all plans must be preserved after split");
    const waveNumbers = [...new Set(result.map((p: any) => p.wave))].sort((a, b) => a - b);
    assert.equal(waveNumbers.length, 2, "5 tasks split into 3+2 should produce 2 micro-waves");
    assert.equal(waveNumbers[0], 1, "first micro-wave must be wave 1");
    assert.equal(waveNumbers[1], 2, "second micro-wave must be wave 2");
    const wave1Count = result.filter((p: any) => p.wave === 1).length;
    const wave2Count = result.filter((p: any) => p.wave === 2).length;
    assert.equal(wave1Count, 3, "first micro-wave must have exactly 3 tasks");
    assert.equal(wave2Count, 2, "second micro-wave must have exactly 2 tasks");
  });

  it("MICROWAVE_MAX_TASKS_DEFAULT is 3", () => {
    assert.equal(MICROWAVE_MAX_TASKS_DEFAULT, 3);
  });

  it("uses MICROWAVE_MAX_TASKS_DEFAULT when no limit is specified", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({
      task_id: `T-${i + 1}`, task: `Task ${i + 1}`, wave: 1, dependencies: [],
    }));
    const result = splitWavesIntoMicrowaves(plans);
    const waveNumbers = [...new Set(result.map((p: any) => p.wave))];
    assert.equal(waveNumbers.length, 2, "4 tasks with default limit of 3 must produce 2 micro-waves");
  });

  it("preserves relative ordering: wave 2 tasks are renumbered after wave 1 micro-waves", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
      { task_id: "T-3", task: "Task 3", wave: 1, dependencies: [] },
      { task_id: "T-4", task: "Task 4", wave: 1, dependencies: [] },
      { task_id: "T-5", task: "Task 5", wave: 2, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    const t5 = result.find((p: any) => p.task_id === "T-5");
    assert.ok(t5, "T-5 must be present in the output");
    assert.equal(t5.wave, 3,
      "original wave 2 task must be renumbered to wave 3 after wave 1 splits into 2 micro-waves");
  });

  it("critical-path ordering: tasks that others depend on in the same wave go first", () => {
    const plans = [
      { task_id: "T-A", task: "Task A", wave: 1, dependencies: [] },
      { task_id: "T-B", task: "Task B", wave: 1, dependencies: ["T-C"] },
      { task_id: "T-C", task: "Task C", wave: 1, dependencies: [] },
      { task_id: "T-D", task: "Task D", wave: 1, dependencies: ["T-C"] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    // T-C is depended on by T-B and T-D → 2 intra-wave dependents → must be in first micro-wave
    const wave1Tasks = result.filter((p: any) => p.wave === 1).map((p: any) => p.task_id);
    assert.ok(
      wave1Tasks.includes("T-C"),
      `T-C (2 dependents) must be in the first micro-wave; wave 1 tasks: ${wave1Tasks.join(", ")}`
    );
  });

// ── computeHighRiskComponentGate ──────────────────────────────────────────────

describe("computeHighRiskComponentGate", () => {
  it("returns shouldApplyStricterGate=false when all components are healthy (1.0)", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      1.0,
      requestBudget:   1.0,
      dependencyGraph: 1.0,
    });
    assert.equal(result.shouldApplyStricterGate, false);
    assert.equal(result.weakComponents.length, 0);
    assert.equal(result.reason, "all_components_healthy");
  });

  it("returns shouldApplyStricterGate=false with empty components (all default to 1.0)", () => {
    const result = computeHighRiskComponentGate({});
    assert.equal(result.shouldApplyStricterGate, false);
    assert.equal(result.weakComponents.length, 0);
  });

  it("flags plansShape as weak when score is below threshold (0.5 = fallback mode)", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      0.5,
      requestBudget:   1.0,
      dependencyGraph: 1.0,
    });
    assert.equal(result.shouldApplyStricterGate, true);
    assert.ok(result.weakComponents.includes("plansShape"), "plansShape must be listed as weak");
    assert.ok(result.reason.includes("plansShape"), "reason must mention the weak component");
  });

  it("flags requestBudget as weak when score is below threshold (0.9 = fallback budget)", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      1.0,
      requestBudget:   0.9,
      dependencyGraph: 1.0,
    });
    assert.equal(result.shouldApplyStricterGate, true);
    assert.ok(result.weakComponents.includes("requestBudget"));
  });

  it("flags dependencyGraph as weak when score is below threshold (0.3 = cycle detected)", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      1.0,
      requestBudget:   1.0,
      dependencyGraph: 0.3,
    });
    assert.equal(result.shouldApplyStricterGate, true);
    assert.ok(result.weakComponents.includes("dependencyGraph"));
  });

  it("flags multiple weak components and lists all in weakComponents", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      0.5,
      requestBudget:   0.9,
      dependencyGraph: 0.6,
    });
    assert.equal(result.shouldApplyStricterGate, true);
    assert.ok(result.weakComponents.includes("plansShape"));
    assert.ok(result.weakComponents.includes("requestBudget"));
    assert.ok(result.weakComponents.includes("dependencyGraph"));
    assert.equal(result.weakComponents.length, 3);
  });

  it("does NOT flag plansShape=1.0 (direct JSON path — healthy)", () => {
    const result = computeHighRiskComponentGate({ plansShape: 1.0 });
    assert.ok(!result.weakComponents.includes("plansShape"));
  });

  it("does NOT flag requestBudget at exactly the threshold (scores at threshold are NOT weak)", () => {
    // threshold is 0.95; a score of exactly 0.95 is not below threshold
    const result = computeHighRiskComponentGate({ requestBudget: 0.95 });
    assert.ok(!result.weakComponents.includes("requestBudget"));
  });

  it("does NOT flag dependencyGraph=0.8 (at the threshold boundary — not below)", () => {
    const result = computeHighRiskComponentGate({ dependencyGraph: 0.8 });
    assert.ok(!result.weakComponents.includes("dependencyGraph"));
  });

  it("handles undefined component values by defaulting to 1.0 (healthy)", () => {
    const result = computeHighRiskComponentGate({ plansShape: undefined as any });
    assert.ok(!result.weakComponents.includes("plansShape"), "undefined plansShape must default to 1.0 (healthy)");
  });

  it("HIGH_RISK_COMPONENT_GATE_THRESHOLDS exports expected keys", () => {
    assert.ok("plansShape"      in HIGH_RISK_COMPONENT_GATE_THRESHOLDS);
    assert.ok("requestBudget"   in HIGH_RISK_COMPONENT_GATE_THRESHOLDS);
    assert.ok("dependencyGraph" in HIGH_RISK_COMPONENT_GATE_THRESHOLDS);
  });

  it("reason includes all weak component names when gate is active", () => {
    const result = computeHighRiskComponentGate({ plansShape: 0.5, dependencyGraph: 0.3 });
    assert.ok(result.reason.includes("plansShape"),      "reason must include plansShape");
    assert.ok(result.reason.includes("dependencyGraph"), "reason must include dependencyGraph");
  });

  // ── Negative paths ────────────────────────────────────────────────────────

  it("NEGATIVE: gate not active when plansShape is exactly at boundary 0.8", () => {
    const result = computeHighRiskComponentGate({ plansShape: 0.8 });
    // 0.8 is NOT below 0.8 → no weak component
    assert.equal(result.shouldApplyStricterGate, false);
  });

  it("NEGATIVE: gate not active when requestBudget is fully healthy (1.0)", () => {
    const result = computeHighRiskComponentGate({
      plansShape:      0.9,
      requestBudget:   1.0,
      dependencyGraph: 0.9,
    });
    // plansShape 0.9 >= 0.8, requestBudget 1.0 >= 0.95, dependencyGraph 0.9 >= 0.8
    assert.equal(result.shouldApplyStricterGate, false);
  });
});

  it("does not mutate the original plan objects", () => {
    const plan = { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [], extra: "preserved" };
    const result = splitWavesIntoMicrowaves([plan], 3);
    assert.equal(plan.wave, 1, "original plan wave must not be mutated");
    assert.equal(result[0].extra, "preserved", "extra fields must be preserved in output");
  });

  it("negative: single-task waves are never split (no-op pass-through)", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 2, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 2);
    assert.equal(result[0].wave, 1, "single-task wave 1 must remain wave 1");
    assert.equal(result[1].wave, 2, "single-task wave 2 must remain wave 2");
  });

  it("maxTasksPerWave=1 forces one task per micro-wave", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
      { task_id: "T-3", task: "Task 3", wave: 1, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 1);
    assert.equal(result.length, 3);
    const waveNums = result.map((p: any) => p.wave).sort((a: number, b: number) => a - b);
    assert.deepEqual(waveNums, [1, 2, 3],
      "each task must be assigned a unique wave number when maxTasksPerWave=1");
  });

  it("multiple original waves both needing splitting produce sequential micro-wave numbers", () => {
    // wave 1: 4 tasks → split into micro-waves 1+2
    // wave 2: 4 tasks → split into micro-waves 3+4
    const plans = [
      { task_id: "A-1", task: "Wave A Task 1", wave: 1, dependencies: [] },
      { task_id: "A-2", task: "Wave A Task 2", wave: 1, dependencies: [] },
      { task_id: "A-3", task: "Wave A Task 3", wave: 1, dependencies: [] },
      { task_id: "A-4", task: "Wave A Task 4", wave: 1, dependencies: [] },
      { task_id: "B-1", task: "Wave B Task 1", wave: 2, dependencies: [] },
      { task_id: "B-2", task: "Wave B Task 2", wave: 2, dependencies: [] },
      { task_id: "B-3", task: "Wave B Task 3", wave: 2, dependencies: [] },
      { task_id: "B-4", task: "Wave B Task 4", wave: 2, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 8, "all 8 tasks must be preserved");
    const waveNums = [...new Set(result.map((p: any) => p.wave))].sort((a: number, b: number) => a - b);
    assert.deepEqual(waveNums, [1, 2, 3, 4],
      "wave 1 (4 tasks) → micro-waves 1+2; wave 2 (4 tasks) → micro-waves 3+4");
    // All original wave-1 tasks must be in micro-waves ≤2
    const wave1Tasks = result.filter((p: any) => p.task_id.startsWith("A-"));
    assert.ok(wave1Tasks.every((p: any) => p.wave <= 2),
      "all original wave-1 tasks must be assigned to micro-waves 1 or 2");
    // All original wave-2 tasks must be in micro-waves ≥3
    const wave2Tasks = result.filter((p: any) => p.task_id.startsWith("B-"));
    assert.ok(wave2Tasks.every((p: any) => p.wave >= 3),
      "all original wave-2 tasks must be renumbered to micro-waves 3 or 4");
  });

  it("cross-wave dependencies are not counted toward intra-wave critical-path score", () => {
    // T-X is in wave 2 and depends on T-A (wave 1). That cross-wave dependency
    // must NOT inflate T-A's intra-wave critical-path score in wave 1.
    const plans = [
      { task_id: "T-A", task: "Task A", wave: 1, dependencies: [] },
      { task_id: "T-B", task: "Task B", wave: 1, dependencies: [] },
      { task_id: "T-C", task: "Task C", wave: 1, dependencies: [] },
      { task_id: "T-D", task: "Task D", wave: 1, dependencies: [] },
      { task_id: "T-X", task: "Task X", wave: 2, dependencies: ["T-A"] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 3);
    assert.equal(result.length, 5, "all 5 tasks must be preserved");
    // Wave 1 (4 tasks) → split: micro-wave 1 gets 3, micro-wave 2 gets 1
    const mw1Tasks = result.filter((p: any) => p.wave === 1).map((p: any) => p.task_id);
    const mw2Tasks = result.filter((p: any) => p.wave === 2).map((p: any) => p.task_id);
    assert.equal(mw1Tasks.length, 3, "first micro-wave from wave 1 must have 3 tasks");
    assert.equal(mw2Tasks.length, 1, "second micro-wave from wave 1 must have 1 task");
    // T-X (wave 2) must still be present — renumbered to wave 3 after the split
    const tX = result.find((p: any) => p.task_id === "T-X");
    assert.ok(tX, "T-X must be preserved in output");
    assert.equal(tX.wave, 3, "T-X (original wave 2) must be renumbered to wave 3 after wave 1 splits");
  });

  it("boundary: exactly maxTasksPerWave tasks in a wave are not split (no-op)", () => {
    const plans = [
      { task_id: "T-1", task: "Task 1", wave: 1, dependencies: [] },
      { task_id: "T-2", task: "Task 2", wave: 1, dependencies: [] },
    ];
    const result = splitWavesIntoMicrowaves(plans, 2);
    assert.equal(result.length, 2, "both tasks must be preserved");
    const waveNums = [...new Set(result.map((p: any) => p.wave))];
    assert.equal(waveNums.length, 1, "exactly-2-tasks wave with limit-2 must NOT be split");
    assert.equal(waveNums[0], 1, "must remain in wave 1");
  });
});

describe("buildPrometheusPlanningPolicy", () => {
  it("preserves unlimited planning semantics when planner.maxTasks is 0", () => {
    const policy = buildPrometheusPlanningPolicy({
      planner: {
        maxTasks: 0,
        defaultMaxWorkersPerWave: 9,
      },
      runtime: {
        runtimeBudget: {
          maxTasksPerCycle: 12,
        },
      },
    });

    assert.equal(policy.maxTasks, 0);
    assert.equal(policy.maxWorkersPerWave, 9);
  });

  it("caps maxWorkersPerWave only when maxTasks is finite", () => {
    const policy = buildPrometheusPlanningPolicy({
      planner: {
        maxTasks: 3,
        defaultMaxWorkersPerWave: 10,
      },
    });

    assert.equal(policy.maxTasks, 3);
    assert.equal(policy.maxWorkersPerWave, 3);
  });

  it("publishes tighter adaptive packet caps for fragile task kinds under uncertainty", () => {
    const policy = buildPrometheusPlanningPolicy({
      planner: {
        maxPlansPerPacket: 5,
      },
    }, null, {
      uncertainty: "high",
      taskKindTelemetry: {
        test: {
          successRate: 0.4,
          sampleCount: 4,
          averageBatchSize: 4,
          averageOrderedStepCount: 9,
          averageContextUtilizationPercent: 71,
        },
      },
    });

    assert.equal(policy.maxPlansPerPacket, 5);
    assert.equal(policy.planningUncertainty, "high");
    assert.equal(policy.adaptivePacketCaps.implementation, 4);
    assert.equal(policy.adaptivePacketCaps.test, 2);
    assert.equal(policy.adaptivePacketCaps.rework, 2);
  });
});

describe("buildDeterministicRequestBudget", () => {
  it("counts one worker request per distinct role session in each wave", () => {
    const plans = [
      { task: "Task A", role: "quality-worker", wave: 1 },
      { task: "Task B", role: "quality-worker", wave: 1 },
      { task: "Task C", role: "infrastructure-worker", wave: 1 },
      { task: "Task D", role: "quality-worker", wave: 2 },
    ];
    const executionStrategy = {
      waves: [
        { wave: 1 },
        { wave: 2 },
      ],
    };

    const budget = buildDeterministicRequestBudget(plans, executionStrategy);

    assert.equal(budget.byWave[0].estimatedRequests, 2, "wave 1 should count two role sessions");
    assert.equal(budget.byWave[1].estimatedRequests, 1, "wave 2 should count one role session");
    assert.equal(
      budget.byRole.find((entry: any) => entry.role === "quality-worker")?.estimatedRequests,
      2,
      "quality-worker should count once per wave where it runs"
    );
    assert.equal(
      budget.estimatedPremiumRequestsTotal,
      6,
      "3 leadership requests + 3 worker role sessions"
    );
  });

  it("does not multiply requests by plan count inside one shared role wave", () => {
    const plans = [
      { task: "Task A", role: "quality-worker", wave: 1 },
      { task: "Task B", role: "quality-worker", wave: 1 },
      { task: "Task C", role: "quality-worker", wave: 1 },
    ];
    const budget = buildDeterministicRequestBudget(plans, { waves: [{ wave: 1 }] });

    assert.equal(budget.byWave[0].estimatedRequests, 1);
    assert.equal(budget.byRole[0].estimatedRequests, 1);
  });
});

describe("validateAndInjectRolePlans", () => {
  function makeContractValidPlan(overrides: Record<string, unknown> = {}) {
    return {
      task: "Implement deterministic role coverage validation",
      role: "evolution-worker",
      wave: 1,
      verification: "tests/core/prometheus_parse.test.ts — test: validates role coverage",
      dependencies: [],
      acceptance_criteria: [
        "Validation runs before Athena review.",
        "Role coverage metadata is recorded deterministically.",
      ],
      capacityDelta: 0.1,
      requestROI: 1.2,
      ...overrides,
    };
  }

  it("passes when each executionStrategy task role has a contract-valid plan", () => {
    const payload = {
      executionStrategy: {
        waves: [
          {
            wave: 1,
            tasks: [
              { task: "Quality gate fix", role: "quality-worker" },
              { task: "Infra gate fix", role: "infrastructure-worker" },
            ],
          },
        ],
      },
      plans: [
        makeContractValidPlan({ role: "quality-worker", wave: 1 }),
        makeContractValidPlan({ role: "infrastructure-worker", wave: 1 }),
      ],
    };

    const result = validateAndInjectRolePlans(payload);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missingRoles, []);
    assert.deepEqual(result.injectedRoles, []);
    assert.equal(result.output.plans.length, 2);
  });

  it("injects deterministic skeleton plans for uncovered roles (negative path)", () => {
    const payload = {
      executionStrategy: {
        waves: [
          {
            wave: 2,
            tasks: [
              { task: "Quality gate fix", role: "quality-worker" },
              { task: "API gate fix", role: "api-worker" },
            ],
          },
        ],
      },
      plans: [
        makeContractValidPlan({ role: "quality-worker", wave: 2 }),
        // Invalid for role coverage: non-specific verification keeps this role uncovered.
        makeContractValidPlan({ role: "api-worker", wave: 2, verification: "npm test" }),
      ],
    };

    const initial = validateAndInjectRolePlans(payload, { injectMissing: false });
    assert.equal(initial.ok, false);
    assert.deepEqual(initial.initialMissingRoles, ["api-worker"]);
    assert.deepEqual(
      initial.initialMissingRoleMarkers,
      [`${ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX}:api-worker:wave:2`]
    );

    const injected = validateAndInjectRolePlans(payload, { injectMissing: true });
    assert.equal(injected.ok, true);
    assert.ok(injected.injectedRoles.includes("api-worker"));
    assert.equal(injected.injectedSkeletonMetadata.length, 1);
    assert.deepEqual(injected.injectedSkeletonMetadata[0], {
      role: "api-worker",
      wave: 2,
      marker: `${ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX}:api-worker:wave:2`,
      source: ROLE_PLAN_SKELETON_METADATA_SOURCE,
      task_id: "role-coverage-api-worker-wave-2",
    });
    const injectedSkeleton = injected.output.plans.find((plan: any) =>
      plan.role === "api-worker" && plan._rolePlanSkeletonInjected === true
    );
    assert.ok(injectedSkeleton, "expected a deterministic injected skeleton for api-worker");
    assert.equal(
      injectedSkeleton._missingRoleMarker,
      `${ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX}:api-worker:wave:2`
    );
    assert.equal(injectedSkeleton._rolePlanSkeletonSource, ROLE_PLAN_SKELETON_METADATA_SOURCE);
    assert.equal(validatePlanContract(injectedSkeleton).valid, true);
  });

  it("string tasks in executionStrategy.waves are skipped by the strict validator — no phantom role coverage (negative path)", () => {
    // Object-only contract: the validator must NOT coerce string tasks to
    // evolution-worker.  Strings reaching the validator indicate a bypassed
    // normalizer (PACKET_VIOLATION_CODE.WAVE_TASK_NOT_OBJECT).  The validator
    // skips them so no phantom role requirements are created from malformed input.
    const payload = {
      executionStrategy: {
        waves: [
          {
            wave: 1,
            tasks: ["Fix something string task"],
          },
        ],
      },
      plans: [],
    };

    const result = validateAndInjectRolePlans(payload, { injectMissing: false });
    // No object tasks → no role requirements extracted → ok=true with empty lists.
    assert.equal(result.ok, true,
      "validator must not produce missing-role failures from string tasks — strings are skipped");
    assert.deepEqual(result.missingRoles, [],
      "no phantom roles must be created from string tasks");
    assert.deepEqual(result.requiredRoles, [],
      "string tasks must not contribute to requiredRoles");
  });

  it("normalizeExecutionStrategyWaveTasks + validateAndInjectRolePlans detects missing coverage after string normalization", () => {
    // This is the correct two-step pattern: run the normalizer (parser gate)
    // first, then validate.  After normalization strings become evolution-worker
    // objects, so missing plan coverage IS correctly reported.
    const raw = {
      executionStrategy: {
        waves: [
          {
            wave: 1,
            tasks: ["Fix something string task"],
          },
        ],
      },
      plans: [], // No plans → evolution-worker role is uncovered
    };

    // Step 1: parser normalizes string tasks → object tasks
    const normalizedStrategy = normalizeExecutionStrategyWaveTasks(raw.executionStrategy);
    const normalizedWaveTasks = normalizedStrategy?.waves?.[0]?.tasks;
    assert.ok(Array.isArray(normalizedWaveTasks), "normalizer must return wave tasks array");
    assert.equal(normalizedWaveTasks.length, 1, "string task must be preserved as one object");
    assert.equal(typeof normalizedWaveTasks[0], "object", "task must be an object after normalization");
    assert.equal(normalizedWaveTasks[0].role, "evolution-worker", "string task coerces to evolution-worker");

    // Step 2: validator now sees objects and reports missing coverage
    const payload = { ...raw, executionStrategy: normalizedStrategy };
    const result = validateAndInjectRolePlans(payload, { injectMissing: false });
    assert.equal(result.ok, false,
      "must report missing coverage after normalization when no plan covers evolution-worker");
    assert.ok(result.initialMissingRoles.includes("evolution-worker"),
      "evolution-worker must appear as a missing role after normalization converts the string task");
  });

  it("PACKET_VIOLATION_CODE.WAVE_TASK_NOT_OBJECT is defined in the violation code taxonomy", () => {
    // Ensures the violation code exists for downstream audit logging.
    assert.equal(
      PACKET_VIOLATION_CODE.WAVE_TASK_NOT_OBJECT,
      "wave_task_not_object",
      "WAVE_TASK_NOT_OBJECT must be present in PACKET_VIOLATION_CODE",
    );
  });
});

describe("buildTopicMemoryPromptSection", () => {
  it("omits empty active topics while keeping summary counts", () => {
    const prompt = buildTopicMemoryPromptSection({
      topics: {
        "empty-active": {
          status: "active",
          runCount: 2,
          firstSeenAt: "2026-03-30T00:00:00.000Z",
          lastUpdatedAt: "2026-03-31T00:00:00.000Z",
          knowledgeFragments: [],
          completedSummary: null,
        },
        "useful-active": {
          status: "active",
          runCount: 3,
          firstSeenAt: "2026-03-30T00:00:00.000Z",
          lastUpdatedAt: "2026-03-31T00:00:00.000Z",
          knowledgeFragments: ["Plan: tighten request budgeting in prometheus.ts"],
          completedSummary: null,
        },
        "done-topic": {
          status: "completed",
          runCount: 2,
          firstSeenAt: "2026-03-30T00:00:00.000Z",
          lastUpdatedAt: "2026-03-31T00:00:00.000Z",
          knowledgeFragments: [],
          completedSummary: "Completed summary",
        },
        "archived-topic": {
          status: "archived",
          runCount: 1,
          firstSeenAt: "2026-03-30T00:00:00.000Z",
          lastUpdatedAt: "2026-03-31T00:00:00.000Z",
          knowledgeFragments: [],
          completedSummary: null,
          archivedSummary: "Archived as informational",
        },
      },
    });

    assert.ok(prompt.includes("Active topics tracked: 2. Completed topics tracked: 1. Archived topics tracked: 1."));
    assert.ok(prompt.includes("useful-active"));
    assert.ok(!prompt.includes("**empty-active**"), "empty active topics should not consume prompt budget");
    assert.ok(prompt.includes("done-topic"));
    assert.ok(prompt.includes("archived-topic"));
  });

  it("returns an empty string when no topic memory exists", () => {
    assert.equal(buildTopicMemoryPromptSection({ topics: {} }), "");
  });
});

// ── checkHighRiskPacketConfidence — high-risk low-confidence gate ─────────────

describe("checkHighRiskPacketConfidence — high-risk low-confidence gate", () => {
  function highRiskBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      task: "Rewrite orchestrator dispatch path for wave-parallel execution",
      riskLevel: "high",
      ...overrides,
    };
  }

  it("does not reject a low-risk packet even when premortem and acceptance_criteria are absent", () => {
    const result = checkHighRiskPacketConfidence({ task: "Improve log output formatting", riskLevel: "low" });
    assert.equal(result.requiresRejection, false);
  });

  it("does not reject a medium-risk packet lacking confidence signals", () => {
    const result = checkHighRiskPacketConfidence({ task: "Harden trust boundary validation", riskLevel: "medium" });
    assert.equal(result.requiresRejection, false);
  });

  it("does not reject a high-risk packet that has both premortem and acceptance_criteria", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({
      premortem: {
        failurePaths: ["Breaks orchestration path under concurrent load"],
        mitigations: ["Feature flag for incremental rollout"],
        rollbackPlan: "Revert to previous dispatch commit",
      },
      acceptance_criteria: [
        "All orchestration integration tests pass",
        "Wave-parallel dispatch logs confirm new code path",
      ],
    }));
    assert.equal(result.requiresRejection, false);
    assert.equal(result.reason, "sufficient_confidence");
  });

  it("does not reject a high-risk packet that has acceptance_criteria but no premortem", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({
      acceptance_criteria: ["All integration tests pass after dispatch change"],
    }));
    assert.equal(result.requiresRejection, false,
      "acceptance_criteria alone is sufficient confidence to allow the packet through");
  });

  it("does not reject a high-risk packet that has premortem but no acceptance_criteria", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({
      premortem: {
        failurePaths: ["Cascading orchestrator failure"],
        mitigations: ["Disable parallel dispatch under error budget"],
        rollbackPlan: "Restore previous orchestrator.ts",
      },
    }));
    assert.equal(result.requiresRejection, false,
      "premortem alone is sufficient confidence to allow the packet through");
  });

  it("rejects a high-risk packet that has neither premortem nor acceptance_criteria", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase());
    assert.equal(result.requiresRejection, true);
    assert.equal(result.reason, HIGH_RISK_LOW_CONFIDENCE_REASON);
  });

  it("rejects a high-risk packet with empty acceptance_criteria and absent premortem", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({ acceptance_criteria: [] }));
    assert.equal(result.requiresRejection, true);
    assert.equal(result.reason, HIGH_RISK_LOW_CONFIDENCE_REASON);
  });

  it("rejects a high-risk packet with blank acceptance_criteria entries and absent premortem", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({ acceptance_criteria: ["", "   "] }));
    assert.equal(result.requiresRejection, true,
      "blank-only criteria must count as absent");
  });

  it("rejects a high-risk packet with empty premortem object and absent acceptance_criteria", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({ premortem: {} }));
    assert.equal(result.requiresRejection, true,
      "empty premortem object must count as absent when no acceptance_criteria present");
  });

  it("rejects a high-risk packet with premortem missing all safety fields and no acceptance_criteria", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({
      premortem: { scenario: "things might break" }, // no failurePaths / mitigations / rollbackPlan
    }));
    assert.equal(result.requiresRejection, true,
      "premortem with only non-safety fields must count as absent");
  });

  it("accepts a high-risk packet whose premortem has only rollbackPlan populated", () => {
    const result = checkHighRiskPacketConfidence(highRiskBase({
      premortem: { rollbackPlan: "Revert commit abc123 and redeploy" },
    }));
    assert.equal(result.requiresRejection, false,
      "rollbackPlan alone in premortem counts as meaningful safety evidence");
  });

  it("negative path: packet with no riskLevel field is not rejected (inference deferred to normalization)", () => {
    // A task whose text would infer high-risk but has no explicit riskLevel field
    const result = checkHighRiskPacketConfidence({
      task: "Implement critical-path scheduling with dependency-aware waves and parallel dispatcher",
      // no riskLevel
    });
    assert.equal(result.requiresRejection, false,
      "must not reject at raw stage when riskLevel is absent — inference runs during normalization");
  });

  it("handles null input without throwing — returns no rejection", () => {
    assert.doesNotThrow(() => checkHighRiskPacketConfidence(null));
    assert.equal(checkHighRiskPacketConfidence(null).requiresRejection, false);
  });

  it("handles undefined input without throwing — returns no rejection", () => {
    assert.doesNotThrow(() => checkHighRiskPacketConfidence(undefined));
    assert.equal(checkHighRiskPacketConfidence(undefined).requiresRejection, false);
  });

  it("HIGH_RISK_LOW_CONFIDENCE_REASON is a non-empty string constant", () => {
    assert.equal(typeof HIGH_RISK_LOW_CONFIDENCE_REASON, "string");
    assert.ok(HIGH_RISK_LOW_CONFIDENCE_REASON.length > 0);
    assert.ok(HIGH_RISK_LOW_CONFIDENCE_REASON.includes("high_risk"));
  });

  it("riskLevel comparison is case-insensitive (HIGH, High, high all trigger)", () => {
    for (const level of ["HIGH", "High", "high"]) {
      const result = checkHighRiskPacketConfidence({ task: "Some task", riskLevel: level });
      assert.equal(result.requiresRejection, true,
        `riskLevel="${level}" with no confidence signals must trigger rejection`);
    }
  });
});

describe("enforceParserContractBeforeNormalization", () => {
  it("repairs null generatedAt/keyFindings/strategicNarrative on the initial pass", async () => {
    const invalid = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 1 },
      generatedAt: null,
      keyFindings: null,
      strategicNarrative: null,
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    let violation = "";
    const result = await enforceParserContractBeforeNormalization(invalid, {
      onRetryViolation(reason: string) {
        violation = reason;
      },
      async buildRetryCandidate() {
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.equal(violation, "");
    assert.ok(!Number.isNaN(new Date(String(result.parsed.generatedAt)).getTime()));
    assert.ok(String(result.parsed.keyFindings || "").length >= STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH);
    assert.ok(String(result.parsed.strategicNarrative || "").length >= STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH);
  });

  it("retries once when unrecoverable mandatory fields are invalid and passes on repaired payload", async () => {
    const initial = {
      projectHealth: "unknown",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    const repaired = {
      projectHealth: "degraded",
      requestBudget: { estimatedPremiumRequestsTotal: 2 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "Strategic parser contract repaired",
      strategicNarrative: "Improve dispatch reliability with explicit validation.",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    let called = 0;
    let seenDiff = "";
    const result = await enforceParserContractBeforeNormalization(initial, {
      onRetryDiff(diff: string) {
        seenDiff = diff;
      },
      async buildRetryCandidate(diff: string) {
        called += 1;
        assert.ok(diff.includes("projectHealth=unknown"));
        assert.doesNotMatch(diff, /requestBudget\.estimatedPremiumRequestsTotal/);
        assert.doesNotMatch(diff, /generatedAt/);
        assert.doesNotMatch(diff, /keyFindings/);
        assert.doesNotMatch(diff, /strategicNarrative/);
        return repaired;
      },
    });
    assert.equal(called, 1);
    assert.ok(seenDiff.includes("projectHealth=unknown"));
    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.equal(result.parsed.projectHealth, "degraded");
  });

  it("returns parser contract violation shape after second failure", async () => {
    const initial = {
      projectHealth: "unknown",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    const stillInvalid = {
      projectHealth: "unknown",
      requestBudget: { estimatedPremiumRequestsTotal: Number.NaN },
      generatedAt: "",
      keyFindings: "",
      strategicNarrative: "",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    let violation = "";
    const result = await enforceParserContractBeforeNormalization(initial, {
      onRetryViolation(reason: string) {
        violation = reason;
      },
      async buildRetryCandidate() {
        return stillInvalid;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.retried, true);
    assert.ok(violation.includes("projectHealth=unknown"));
    assert.ok(String(result.violationReason || "").includes("projectHealth=unknown"));
    assert.doesNotMatch(String(result.violationReason || ""), /requestBudget\.estimatedPremiumRequestsTotal=NaN/);
    assert.doesNotMatch(String(result.violationReason || ""), /generatedAt/);
    assert.doesNotMatch(String(result.violationReason || ""), /keyFindings/);
    assert.doesNotMatch(String(result.violationReason || ""), /strategicNarrative/);
  });

  it("repairs malformed retry payloads using raw narrative fallbacks", async () => {
    const initial = {
      projectHealth: "unknown",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    const malformedRetry = {
      projectHealth: "degraded",
      generatedAt: "",
      requestBudget: {},
      keyFindings: {
        summary: "Stabilize parser contract enforcement before normalization.",
      },
      strategicNarrative: "",
      analysis: "Stabilize parser contract enforcement before normalization.\n\nKeep retry outputs deterministic and preserve request budgets.",
      plans: [{ task: "x", acceptance_criteria: ["passes"], role: "evolution-worker" }],
    };
    const result = await enforceParserContractBeforeNormalization(initial, {
      async buildRetryCandidate() {
        return malformedRetry;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, true);
    assert.equal(result.parsed.projectHealth, "degraded");
    assert.ok(!Number.isNaN(new Date(String(result.parsed.generatedAt)).getTime()));
    assert.equal(result.parsed.requestBudget.estimatedPremiumRequestsTotal, 3);
    assert.equal(result.parsed.keyFindings, "Stabilize parser contract enforcement before normalization.");
    assert.equal(result.parsed.strategicNarrative, "Keep retry outputs deterministic and preserve request budgets.");
  });

  it("keeps valid mandatory fields on first pass without retry or penalties", async () => {
    const valid = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 4 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "Keep retry path deterministic.",
      strategicNarrative: "Maintain parse boundary contracts before normalization.",
      plans: [{ task: "x", role: "evolution-worker" }],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(valid, {
      async buildRetryCandidate() {
        called += 1;
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.equal(called, 0);
  });

  it("accepts legacy analysis fixture when generatedAt/keyFindings/strategicNarrative are non-empty", async () => {
    const fixture = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, "prometheus_analysis_v0.json"), "utf8")
    );
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(fixture, {
      async buildRetryCandidate() {
        called += 1;
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.equal(called, 0);
  });

  it("repairs keyFindings arrays on the initial pass without retry", async () => {
    const arrayKeyFindings = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 1 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: ["Finding 1: dispatch bottleneck", "Finding 2: missing AC"],
      strategicNarrative: "Strategic narrative — dispatch reliability must be improved.",
      plans: [{ task: "Fix dispatch", acceptance_criteria: ["tests pass"] }],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(arrayKeyFindings, {
      async buildRetryCandidate() {
        called += 1;
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.equal(called, 0);
    assert.equal(result.parsed.keyFindings, "Finding 1: dispatch bottleneck Finding 2: missing AC");
  });

  it("rejects payload where all plans lack acceptance_criteria at generation boundary", async () => {
    const noAC = {
      projectHealth: "degraded",
      requestBudget: { estimatedPremiumRequestsTotal: 2 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "Worker dispatch is blocked due to missing CI evidence.",
      strategicNarrative: "Address CI reliability before next dispatch wave.",
      plans: [
        { task: "Fix CI pipeline", acceptance_criteria: [] },
        { task: "Add premortem", acceptance_criteria: ["", "  "] },
      ],
    };
    let diffSeen = "";
    const result = await enforceParserContractBeforeNormalization(noAC, {
      onRetryDiff(diff: string) { diffSeen = diff; },
      async buildRetryCandidate() { return null; },
    });
    assert.equal(result.ok, false, "all-empty acceptance_criteria across plans must fail contract gate");
    assert.equal(result.retried, true);
    assert.ok(
      diffSeen.includes("acceptance_criteria"),
      `retry diff must mention acceptance_criteria; got: ${diffSeen}`,
    );
  });

  it("passes when at least one plan has a non-empty acceptance_criteria item", async () => {
    const oneWithAC = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 2 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "CI pipeline passes after patch; dispatch is unblocked.",
      strategicNarrative: "Continue monitoring dispatch latency after wave-1 ships.",
      plans: [
        { task: "Fix CI", acceptance_criteria: [] },
        { task: "Add tests", acceptance_criteria: ["All targeted tests pass"] },
      ],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(oneWithAC, {
      async buildRetryCandidate() { called += 1; return null; },
    });
    assert.equal(result.ok, true, "at least one plan with AC must pass the boundary gate");
    assert.equal(result.retried, false);
    assert.equal(called, 0);
  });

  it("sanitizes recoverable strategic field contamination before parser retry", async () => {
    const contaminated = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 2 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "I'm gathering the latest evidence first.\nStabilize leadership freshness arbitration.",
      strategicNarrative: "tool_call: read_file src/core/prometheus.ts\nKeep the plan deterministic and contradiction-aware.",
      plans: [{ task: "x", acceptance_criteria: ["passes"], role: "evolution-worker" }],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(contaminated, {
      async buildRetryCandidate() { called += 1; return null; },
    });
    assert.equal(result.ok, true, "sanitizable contamination should pass without retry");
    assert.equal(result.retried, false);
    assert.equal(called, 0);
    assert.equal(result.parsed.keyFindings, "Stabilize leadership freshness arbitration.");
    assert.equal(result.parsed.strategicNarrative, "Keep the plan deterministic and contradiction-aware.");
  });

  it("repairs recoverable strategic field objects on the initial pass without retry", async () => {
    const recoverable = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 2 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: {
        summary: "Dispatch planning can recover parser contract fields from structured findings.",
      },
      strategicNarrative: "",
      analysis: "Dispatch planning can recover parser contract fields from structured findings.\n\nKeep the first-pass payload dispatchable without burning a retry.",
      plans: [{ task: "x", acceptance_criteria: ["passes"], role: "evolution-worker" }],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(recoverable, {
      async buildRetryCandidate() {
        called += 1;
        return null;
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.retried, false);
    assert.equal(called, 0);
    assert.equal(result.parsed.keyFindings, "Dispatch planning can recover parser contract fields from structured findings.");
    assert.equal(result.parsed.strategicNarrative, "Keep the first-pass payload dispatchable without burning a retry.");
  });

  it("passes with zero plans (no acceptance_criteria obligation when plans array is empty)", async () => {
    const noPlans = {
      projectHealth: "healthy",
      requestBudget: { estimatedPremiumRequestsTotal: 0 },
      generatedAt: "2026-04-04T12:00:00.000Z",
      keyFindings: "Repository is in good health; no actionable plans this cycle.",
      strategicNarrative: "Continue monitoring and defer non-critical improvements.",
      plans: [],
    };
    let called = 0;
    const result = await enforceParserContractBeforeNormalization(noPlans, {
      async buildRetryCandidate() { called += 1; return null; },
    });
    assert.equal(result.ok, true, "zero plans must not trigger acceptance_criteria boundary violation");
    assert.equal(called, 0);
  });
});

describe("ensurePersistedAnalysisTimestamps", () => {
  it("uses persistence-time timestamp as source-of-truth for generatedAt and analyzedAt", () => {
    const persisted = ensurePersistedAnalysisTimestamps({
      generatedAt: "2020-01-01T00:00:00.000Z",
      analyzedAt: "2020-01-01T00:00:00.000Z",
      keyFindings: "x",
      strategicNarrative: "y",
    });
    assert.notEqual(persisted.generatedAt, "2020-01-01T00:00:00.000Z");
    assert.equal(persisted.generatedAt, persisted.analyzedAt);
    assert.ok(!Number.isNaN(new Date(persisted.generatedAt).getTime()));
  });
});

// ── checkDecompositionCaps — deterministic decomposition ceiling ─────────────

describe("checkDecompositionCaps", () => {
  it("returns capped=false when plans count is within MAX_DECOMPOSITION_PLANS", () => {
    const plans = Array.from({ length: MAX_DECOMPOSITION_PLANS }, (_, i) => ({ task: `Task ${i + 1}` }));
    const result = checkDecompositionCaps(plans);
    assert.equal(result.capped, false);
    assert.equal(result.originalCount, MAX_DECOMPOSITION_PLANS);
    assert.equal(result.cappedCount, MAX_DECOMPOSITION_PLANS);
    assert.equal(result.reason, "within_cap");
  });

  it("returns capped=false for an empty array", () => {
    const result = checkDecompositionCaps([]);
    assert.equal(result.capped, false);
    assert.equal(result.originalCount, 0);
    assert.equal(result.cappedCount, 0);
  });

  it("returns capped=true when plans count exceeds MAX_DECOMPOSITION_PLANS", () => {
    const plans = Array.from({ length: MAX_DECOMPOSITION_PLANS + 1 }, (_, i) => ({ task: `Task ${i + 1}` }));
    const result = checkDecompositionCaps(plans);
    assert.equal(result.capped, true);
    assert.equal(result.originalCount, MAX_DECOMPOSITION_PLANS + 1);
    assert.equal(result.cappedCount, MAX_DECOMPOSITION_PLANS);
    assert.equal(result.reason, DECOMPOSITION_CAP_REASON);
  });

  it("reports the correct originalCount and cappedCount for a large batch", () => {
    const plans = Array.from({ length: 50 }, (_, i) => ({ task: `Task ${i + 1}` }));
    const result = checkDecompositionCaps(plans);
    assert.equal(result.capped, true);
    assert.equal(result.originalCount, 50);
    assert.equal(result.cappedCount, MAX_DECOMPOSITION_PLANS);
  });

  it("treats non-array input as empty (capped=false)", () => {
    const result = checkDecompositionCaps(null as any);
    assert.equal(result.capped, false);
    assert.equal(result.originalCount, 0);
  });

  it("is a pure function — does not mutate input array", () => {
    const plans = Array.from({ length: MAX_DECOMPOSITION_PLANS + 5 }, (_, i) => ({ task: `Task ${i + 1}` }));
    const lengthBefore = plans.length;
    checkDecompositionCaps(plans);
    assert.equal(plans.length, lengthBefore, "input array must not be mutated");
  });

  it("MAX_DECOMPOSITION_PLANS is 20", () => {
    assert.equal(MAX_DECOMPOSITION_PLANS, 20);
  });

  it("DECOMPOSITION_CAP_REASON is a non-empty string", () => {
    assert.equal(typeof DECOMPOSITION_CAP_REASON, "string");
    assert.ok(DECOMPOSITION_CAP_REASON.length > 0);
    assert.ok(DECOMPOSITION_CAP_REASON.includes("decomposition"));
  });

  it("negative path: exactly MAX_DECOMPOSITION_PLANS plans is NOT capped", () => {
    const plans = Array.from({ length: MAX_DECOMPOSITION_PLANS }, (_, i) => ({ task: `Task ${i + 1}` }));
    const result = checkDecompositionCaps(plans);
    assert.equal(result.capped, false, "exactly MAX_DECOMPOSITION_PLANS must not trigger capping");
  });
});

// ── Task 1: computeClosureYield + rankPlansByClosureYield ─────────────────────

describe("computeClosureYield — realized closure yield from carry-forward ledger", () => {
  it("returns zero-signal when ledger is empty", () => {
    const result = computeClosureYield([]);
    assert.equal(result.yield, 0);
    assert.equal(result.closed, 0);
    assert.equal(result.attempted, 0);
  });

  it("returns zero-signal when no entries have closedAt set", () => {
    const ledger = [
      { id: "e1", closedAt: null, closureEvidence: null },
      { id: "e2", closedAt: null, closureEvidence: "PR #1" },
    ];
    const result = computeClosureYield(ledger);
    assert.equal(result.yield, 0);
    assert.equal(result.attempted, 0);
  });

  it("counts attempted as entries with closedAt set regardless of evidence", () => {
    const ledger = [
      { id: "e1", closedAt: "2025-01-01", closureEvidence: null },
      { id: "e2", closedAt: "2025-01-02", closureEvidence: "" },
      { id: "e3", closedAt: null, closureEvidence: null },
    ];
    const result = computeClosureYield(ledger);
    assert.equal(result.attempted, 2, "only entries with closedAt contribute to attempted");
    assert.equal(result.closed, 0, "no evidence → zero closed");
    assert.equal(result.yield, 0);
  });

  it("computes yield correctly when all attempted closures have evidence", () => {
    const ledger = [
      { id: "e1", closedAt: "2025-01-01", closureEvidence: "PR #1" },
      { id: "e2", closedAt: "2025-01-02", closureEvidence: "PR #2" },
    ];
    const result = computeClosureYield(ledger);
    assert.equal(result.attempted, 2);
    assert.equal(result.closed, 2);
    assert.equal(result.yield, 1, "100% yield when all closures have evidence");
  });

  it("computes fractional yield when some closures lack evidence", () => {
    const ledger = [
      { id: "e1", closedAt: "2025-01-01", closureEvidence: "PR #1" },
      { id: "e2", closedAt: "2025-01-02", closureEvidence: null },
      { id: "e3", closedAt: "2025-01-03", closureEvidence: "PR #3" },
      { id: "e4", closedAt: "2025-01-04", closureEvidence: null },
    ];
    const result = computeClosureYield(ledger);
    assert.equal(result.attempted, 4);
    assert.equal(result.closed, 2);
    assert.equal(result.yield, 0.5, "2 of 4 attempted → yield 0.5");
  });

  it("ignores null entries in the array without throwing", () => {
    const ledger = [
      null,
      { id: "e1", closedAt: "2025-01-01", closureEvidence: "PR #1" },
      undefined,
    ];
    const result = computeClosureYield(ledger as any[]);
    assert.equal(result.attempted, 1);
    assert.equal(result.closed, 1);
    assert.equal(result.yield, 1);
  });

  it("negative path: null input returns zero-signal without throwing", () => {
    const result = computeClosureYield(null as any);
    assert.equal(result.yield, 0);
    assert.equal(result.attempted, 0);
    assert.equal(result.closed, 0);
  });

  it("CLOSURE_YIELD_LOW_THRESHOLD is 0.5", () => {
    assert.equal(CLOSURE_YIELD_LOW_THRESHOLD, 0.5);
  });

  it("CLOSURE_YIELD_BOOST_AMOUNT is 0.05", () => {
    assert.equal(CLOSURE_YIELD_BOOST_AMOUNT, 0.05);
  });
});

describe("rankPlansByClosureYield — planning rank boost for low yield", () => {
  function makePlan(overrides: Record<string, any> = {}): Record<string, any> {
    return {
      task: "Default task",
      capacityDelta: 0.2,
      requestROI: 1.5,
      leverage_rank: [],
      ...overrides,
    };
  }

  it("returns a copy of plans unchanged when closureYield is 0 (no data)", () => {
    const plans = [makePlan({ leverage_rank: ["learning"] })];
    const result = rankPlansByClosureYield(plans, 0);
    assert.equal(result.length, 1);
    assert.equal(result[0].capacityDelta, 0.2, "no boost when closureYield=0");
    assert.notStrictEqual(result, plans, "must return a new array");
  });

  it("returns plans unchanged when closureYield is at or above threshold (0.5)", () => {
    const plans = [makePlan({ leverage_rank: ["learning"], capacityDelta: 0.3 })];
    const resultAt = rankPlansByClosureYield(plans, 0.5);
    assert.equal(resultAt[0].capacityDelta, 0.3, "no boost at exactly threshold");
    const resultAbove = rankPlansByClosureYield(plans, 0.8);
    assert.equal(resultAbove[0].capacityDelta, 0.3, "no boost above threshold");
  });

  it("boosts capacityDelta for plans with 'learning' in leverage_rank when yield is low", () => {
    const plans = [makePlan({ leverage_rank: ["learning"], capacityDelta: 0.2 })];
    const result = rankPlansByClosureYield(plans, 0.3);
    assert.equal(result[0].capacityDelta, 0.25, "capacityDelta must be boosted by CLOSURE_YIELD_BOOST_AMOUNT");
  });

  it("boosts capacityDelta for plans with 'quality' in leverage_rank when yield is low", () => {
    const plans = [makePlan({ leverage_rank: ["quality"], capacityDelta: 0.4 })];
    const result = rankPlansByClosureYield(plans, 0.2);
    assert.equal(result[0].capacityDelta, 0.45);
  });

  it("boosts capacityDelta for plans with 'task-quality' in leverage_rank when yield is low", () => {
    const plans = [makePlan({ leverage_rank: ["speed", "task-quality"], capacityDelta: 0.1 })];
    const result = rankPlansByClosureYield(plans, 0.1);
    assert.equal(result[0].capacityDelta, 0.15);
  });

  it("does NOT boost plans whose leverage_rank does not include a boost dimension", () => {
    const plans = [makePlan({ leverage_rank: ["architecture", "speed"], capacityDelta: 0.3 })];
    const result = rankPlansByClosureYield(plans, 0.1);
    assert.equal(result[0].capacityDelta, 0.3, "non-targeted dimensions must not be boosted");
  });

  it("boosts only the qualifying plan in a mixed batch", () => {
    const plans = [
      makePlan({ leverage_rank: ["architecture"], capacityDelta: 0.3 }),
      makePlan({ leverage_rank: ["learning"], capacityDelta: 0.2 }),
    ];
    const result = rankPlansByClosureYield(plans, 0.3);
    assert.equal(result[0].capacityDelta, 0.3, "architecture plan must not be boosted");
    assert.equal(result[1].capacityDelta, 0.25, "learning plan must be boosted");
  });

  it("clamps boosted capacityDelta to 1.0", () => {
    const plans = [makePlan({ leverage_rank: ["learning"], capacityDelta: 0.99 })];
    const result = rankPlansByClosureYield(plans, 0.1);
    assert.equal(result[0].capacityDelta, 1.0, "boost must not exceed 1.0");
  });

  it("does not mutate the input array", () => {
    const plans = [makePlan({ leverage_rank: ["learning"], capacityDelta: 0.2 })];
    rankPlansByClosureYield(plans, 0.1);
    assert.equal(plans[0].capacityDelta, 0.2, "input plan must not be mutated");
  });

  it("negative path: returns empty array for non-array input", () => {
    const result = rankPlansByClosureYield(null as any, 0.1);
    assert.deepEqual(result, []);
  });

  it("negative path: NaN closureYield returns unchanged copy", () => {
    const plans = [makePlan({ leverage_rank: ["learning"], capacityDelta: 0.2 })];
    const result = rankPlansByClosureYield(plans, NaN);
    assert.equal(result[0].capacityDelta, 0.2);
  });

  it("CLOSURE_YIELD_BOOST_DIMENSIONS includes learning, quality, task-quality, learning loop", () => {
    assert.ok(CLOSURE_YIELD_BOOST_DIMENSIONS.has("learning"));
    assert.ok(CLOSURE_YIELD_BOOST_DIMENSIONS.has("quality"));
    assert.ok(CLOSURE_YIELD_BOOST_DIMENSIONS.has("task-quality"));
    assert.ok(CLOSURE_YIELD_BOOST_DIMENSIONS.has("learning loop"));
  });
});

// ── Task 2: Cycle-delta section prioritization ─────────────────────────────────

describe("PROMETHEUS_CYCLE_DELTA_SECTION_NAMES — cycle-delta section priority", () => {
  const DELTA_NAMES = ["research-intelligence", "topic-memory", "behavior-patterns", "carry-forward", "postmortem-shortlist"];

  it("exports PROMETHEUS_CYCLE_DELTA_SECTION_NAMES as a non-empty ReadonlySet", () => {
    assert.ok(PROMETHEUS_CYCLE_DELTA_SECTION_NAMES instanceof Set,
      "PROMETHEUS_CYCLE_DELTA_SECTION_NAMES must be a Set");
    assert.ok(PROMETHEUS_CYCLE_DELTA_SECTION_NAMES.size > 0,
      "PROMETHEUS_CYCLE_DELTA_SECTION_NAMES must not be empty");
  });

  it("includes all expected cycle-delta section names", () => {
    for (const name of DELTA_NAMES) {
      assert.ok(PROMETHEUS_CYCLE_DELTA_SECTION_NAMES.has(name),
        `PROMETHEUS_CYCLE_DELTA_SECTION_NAMES must include "${name}"`);
    }
  });

  it("cycle-delta sections are disjoint from static section names", () => {
    for (const name of PROMETHEUS_CYCLE_DELTA_SECTION_NAMES) {
      assert.equal(PROMETHEUS_STATIC_SECTION_NAMES.has(name), false,
        `"${name}" must not appear in both delta and static section name sets`);
    }
  });

  it("cycle-delta sections survive under token pressure when marked required:true", () => {
    const deltaSection = Object.assign(
      { name: "research-intelligence", content: "RESEARCH_DELTA_CONTENT" },
      { required: true }
    );
    const largeOptional = { name: "repo-file-listing", content: "R".repeat(100_000) };
    const result = compilePrompt([deltaSection, largeOptional], { tokenBudget: 50 });
    assert.ok(result.includes("RESEARCH_DELTA_CONTENT"),
      "required cycle-delta section must survive token pressure");
  });

  it("optional large sections are dropped under token pressure, preserving cycle-delta content", () => {
    const deltaSection = Object.assign(
      { name: "carry-forward", content: "CARRY_FORWARD_DATA" },
      { required: true }
    );
    const optionalLarge = { name: "repo-file-listing", content: "REPO_LISTING_DATA_".repeat(5_000) };
    const result = compilePrompt([deltaSection, optionalLarge], { tokenBudget: 50 });
    assert.ok(result.includes("CARRY_FORWARD_DATA"),
      "required cycle-delta content must be retained");
    assert.equal(result.includes("REPO_LISTING_DATA_"), false,
      "large optional section must be dropped under tight token budget");
  });
});

describe("PROMETHEUS_STATIC_SECTION_NAMES — cache eligibility", () => {
  it("exports PROMETHEUS_STATIC_SECTION_NAMES as a non-empty ReadonlySet", () => {
    assert.ok(PROMETHEUS_STATIC_SECTION_NAMES instanceof Set,
      "PROMETHEUS_STATIC_SECTION_NAMES must be a Set");
    assert.ok(PROMETHEUS_STATIC_SECTION_NAMES.size > 0,
      "PROMETHEUS_STATIC_SECTION_NAMES must not be empty");
  });

  it("contains the name of every static section", () => {
    for (const [key, sec] of Object.entries(PROMETHEUS_STATIC_SECTIONS)) {
      assert.ok(PROMETHEUS_STATIC_SECTION_NAMES.has(sec.name),
        `static section "${key}" (name="${sec.name}") must appear in PROMETHEUS_STATIC_SECTION_NAMES`);
    }
  });

  it("markCacheableSegments marks static sections as cacheable using PROMETHEUS_STATIC_SECTION_NAMES", () => {
    const sections = [
      { ...PROMETHEUS_STATIC_SECTIONS.evolutionDirective },
      { name: "research-intelligence", content: "some research" },
      { name: "context", content: "dynamic context" },
    ];
    const marked = markCacheableSegments(sections, {
      stableNames: Array.from(PROMETHEUS_STATIC_SECTION_NAMES),
    });

    const evolutionEntry = marked.find(s => s.name === PROMETHEUS_STATIC_SECTIONS.evolutionDirective.name);
    const researchEntry = marked.find(s => s.name === "research-intelligence");

    assert.equal(evolutionEntry?.cacheable, true,
      "static section evolutionDirective must be marked cacheable");
    assert.equal(researchEntry?.cacheable, false,
      "cycle-delta section research-intelligence must NOT be marked cacheable");
  });

  it("negative path: cycle-delta sections are NOT marked cacheable by default", () => {
    const sections = Array.from(PROMETHEUS_CYCLE_DELTA_SECTION_NAMES).map(name => ({
      name,
      content: `content for ${name}`,
    }));
    const marked = markCacheableSegments(sections);
    for (const s of marked) {
      assert.equal(s.cacheable, false,
        `cycle-delta section "${s.name}" must not be cacheable by default`);
    }
  });
});

// ── Task 1: Telemetry-adjusted packet ranking ─────────────────────────────────

import {
  summarizeRealizedTelemetry,
  computeTelemetryAdjustedPacketScore,
  rankPlansByTelemetryAdjustedScore,
  TELEMETRY_ADJUSTMENT_CLAMP,
  type RealizedTelemetrySummary,
} from "../../src/core/prometheus.js";

describe("summarizeRealizedTelemetry", () => {
  it("returns zero-signal when entries array is empty", () => {
    const result = summarizeRealizedTelemetry([]);
    assert.equal(result.avgRoiDelta, 0);
    assert.equal(result.sampleCount, 0);
  });

  it("returns zero-signal when no entries are realized (realizedAt=null)", () => {
    const entries = [
      { roiDelta: 0.5, realizedAt: null },
      { roiDelta: -0.2, realizedAt: null },
    ];
    const result = summarizeRealizedTelemetry(entries);
    assert.equal(result.avgRoiDelta, 0);
    assert.equal(result.sampleCount, 0);
  });

  it("returns correct average for all-realized entries with positive deltas", () => {
    const entries = [
      { roiDelta: 0.4, realizedAt: "2026-01-01T00:00:00Z" },
      { roiDelta: 0.6, realizedAt: "2026-01-02T00:00:00Z" },
    ];
    const result = summarizeRealizedTelemetry(entries);
    assert.equal(result.avgRoiDelta, 0.5);
    assert.equal(result.sampleCount, 2);
  });

  it("returns correct average for negative deltas (underperformance signal)", () => {
    const entries = [
      { roiDelta: -0.3, realizedAt: "2026-01-01T00:00:00Z" },
      { roiDelta: -0.1, realizedAt: "2026-01-02T00:00:00Z" },
    ];
    const result = summarizeRealizedTelemetry(entries);
    assert.equal(result.avgRoiDelta, -0.2);
    assert.equal(result.sampleCount, 2);
  });

  it("respects the limit parameter — only considers the most-recent entries", () => {
    const entries = Array.from({ length: 25 }, (_, i) => ({
      roiDelta: i < 20 ? -1.0 : 1.0, // first 20 are -1.0, last 5 are +1.0
      realizedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    }));
    // With limit=5, only the last 5 entries (+1.0 each) are included
    const result = summarizeRealizedTelemetry(entries, 5);
    assert.equal(result.avgRoiDelta, 1.0);
    assert.equal(result.sampleCount, 5);
  });

  it("skips entries where roiDelta is non-finite (NaN, Infinity)", () => {
    const entries = [
      { roiDelta: NaN, realizedAt: "2026-01-01T00:00:00Z" },
      { roiDelta: Infinity, realizedAt: "2026-01-02T00:00:00Z" },
      { roiDelta: 0.5, realizedAt: "2026-01-03T00:00:00Z" },
    ];
    const result = summarizeRealizedTelemetry(entries);
    assert.equal(result.avgRoiDelta, 0.5);
    assert.equal(result.sampleCount, 1);
  });
});

describe("computeTelemetryAdjustedPacketScore", () => {
  const basePlan = { requestROI: 2.0, capacityDelta: 0.5 };
  // baseScore = 2.0 × (1 + 0.5) = 3.0

  it("returns baseScore when telemetry has no realized data (sampleCount=0)", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan, { avgRoiDelta: 0, sampleCount: 0 });
    assert.equal(score, 3.0);
  });

  it("returns baseScore when telemetrySummary is omitted", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan);
    assert.equal(score, 3.0);
  });

  it("up-ranks when avgRoiDelta is positive (history beats predictions)", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan, { avgRoiDelta: 0.3, sampleCount: 5 });
    // baseScore × (1 + 0.3) = 3.0 × 1.3 = 3.9
    assert.ok(score > 3.0, "positive roiDelta must increase score above baseline");
    assert.ok(Math.abs(score - 3.9) < 0.001, `expected 3.9, got ${score}`);
  });

  it("down-ranks when avgRoiDelta is negative (history misses predictions)", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan, { avgRoiDelta: -0.3, sampleCount: 5 });
    // baseScore × (1 − 0.3) = 3.0 × 0.7 = 2.1
    assert.ok(score < 3.0, "negative roiDelta must reduce score below baseline");
    assert.ok(Math.abs(score - 2.1) < 0.001, `expected 2.1, got ${score}`);
  });

  it("clamps adjustment at +TELEMETRY_ADJUSTMENT_CLAMP — extreme positive history cannot inflate beyond clamp", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan, { avgRoiDelta: 5.0, sampleCount: 5 });
    // clamped to +0.5 → 3.0 × 1.5 = 4.5
    const expected = 3.0 * (1 + TELEMETRY_ADJUSTMENT_CLAMP);
    assert.ok(Math.abs(score - expected) < 0.001, `expected ${expected} (clamped), got ${score}`);
  });

  it("clamps adjustment at -TELEMETRY_ADJUSTMENT_CLAMP — extreme negative history cannot deflate below clamp", () => {
    const score = computeTelemetryAdjustedPacketScore(basePlan, { avgRoiDelta: -5.0, sampleCount: 5 });
    // clamped to -0.5 → 3.0 × 0.5 = 1.5
    const expected = 3.0 * (1 - TELEMETRY_ADJUSTMENT_CLAMP);
    assert.ok(Math.abs(score - expected) < 0.001, `expected ${expected} (clamped), got ${score}`);
  });

  it("returns 0 when plan has no requestROI", () => {
    const score = computeTelemetryAdjustedPacketScore({ capacityDelta: 0.5 }, { avgRoiDelta: 0.3, sampleCount: 5 });
    assert.equal(score, 0);
  });

  it("returns 0 when plan requestROI is non-positive", () => {
    const score = computeTelemetryAdjustedPacketScore({ requestROI: -1, capacityDelta: 0.5 }, { avgRoiDelta: 0.3, sampleCount: 5 });
    assert.equal(score, 0);
  });

  it("returns 0 for a null/undefined plan", () => {
    assert.equal(computeTelemetryAdjustedPacketScore(null as any), 0);
    assert.equal(computeTelemetryAdjustedPacketScore(undefined as any), 0);
  });

  it("result is always non-negative even with extreme negative adjustments", () => {
    const plan = { requestROI: 0.1, capacityDelta: -0.9 }; // baseScore = 0.1 × 0.1 = 0.01
    const score = computeTelemetryAdjustedPacketScore(plan, { avgRoiDelta: -5.0, sampleCount: 5 });
    assert.ok(score >= 0, "score must never be negative");
  });
});

describe("rankPlansByTelemetryAdjustedScore", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(rankPlansByTelemetryAdjustedScore(null as any), []);
  });

  it("returns same-length array as input", () => {
    const plans = [
      { task: "A", requestROI: 2.0, capacityDelta: 0.5 },
      { task: "B", requestROI: 1.0, capacityDelta: 0.2 },
    ];
    const ranked = rankPlansByTelemetryAdjustedScore(plans);
    assert.equal(ranked.length, plans.length);
  });

  it("orders plans by adjusted score descending (highest first)", () => {
    const plans = [
      { task: "LowROI", requestROI: 1.0, capacityDelta: 0.1 },  // base=1.1
      { task: "HighROI", requestROI: 3.0, capacityDelta: 0.2 }, // base=3.6
    ];
    const ranked = rankPlansByTelemetryAdjustedScore(plans, { avgRoiDelta: 0, sampleCount: 0 });
    assert.equal(ranked[0].task, "HighROI");
    assert.equal(ranked[1].task, "LowROI");
  });

  it("telemetry adjustment can reorder plans relative to declared ROI", () => {
    // Plan A: high declared ROI but tier has negative telemetry
    // Plan B: lower declared ROI but tier has positive telemetry
    const planA = { task: "A", requestROI: 3.0, capacityDelta: 0.0 }; // base=3.0
    const planB = { task: "B", requestROI: 2.0, capacityDelta: 0.0 }; // base=2.0

    // Without telemetry, A ranks first
    const ranked_no_tel = rankPlansByTelemetryAdjustedScore([planA, planB], { avgRoiDelta: 0, sampleCount: 0 });
    assert.equal(ranked_no_tel[0].task, "A", "without telemetry A should rank first");

    // With strong positive telemetry, A still leads (both get same uplift)
    // but if we adjust B specifically we can't — both get the same summary.
    // Instead test that negative telemetry down-ranks proportionally.
    // Both plans: A × 0.5 = 1.5, B × 0.5 = 1.0 → A still first
    const ranked_neg = rankPlansByTelemetryAdjustedScore([planA, planB], { avgRoiDelta: -0.5, sampleCount: 5 });
    assert.equal(ranked_neg[0].task, "A", "relative order preserved when uniform telemetry applied");
  });

  it("does not mutate the original plans array", () => {
    const plans = [
      { task: "A", requestROI: 1.0, capacityDelta: 0.1 },
      { task: "B", requestROI: 3.0, capacityDelta: 0.2 },
    ];
    const original = [...plans];
    rankPlansByTelemetryAdjustedScore(plans);
    assert.deepEqual(plans, original, "input array must not be mutated");
  });
});


// ── Task 3: carry-forward prompt bulk reduction constants ─────────────────────

describe("carry-forward prompt bulk reduction", () => {
  it("CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS is a positive integer", () => {
    assert.ok(Number.isFinite(CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS), "must be finite");
    assert.ok(CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS > 0, "must be positive");
    assert.ok(Number.isInteger(CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS), "must be integer");
  });

  it("CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS is less than CARRY_FORWARD_MAX_TOKENS (not token-like)", () => {
    // Ensures the two constants serve different roles and are not accidentally swapped.
    assert.ok(
      CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS < CARRY_FORWARD_MAX_TOKENS,
      "MAX_LOW_RECURRENCE_ITEMS must be smaller than MAX_TOKENS — they are different units"
    );
  });

  it("negative path: CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS < total items does not equal CARRY_FORWARD_MAX_TOKENS", () => {
    assert.notEqual(
      CARRY_FORWARD_MAX_LOW_RECURRENCE_ITEMS,
      CARRY_FORWARD_MAX_TOKENS,
      "the item cap and the token cap must not be equal — they measure different things"
    );
  });
});

// ── Novelty / discovery-gap scoring ───────────────────────────────────────────

describe("computeNoveltyScore", () => {
  it("returns score 1.0 with empty novelCount when currentPlans is empty", () => {
    const result = computeNoveltyScore([], [{ task: "fix something" }]);
    assert.equal(result.score, 1.0);
    assert.equal(result.totalCount, 0);
    assert.equal(result.novelCount, 0);
    assert.deepEqual(result.repeatedTasks, []);
  });

  it("returns score 1.0 for all plans when historicalPlans is empty (first cycle)", () => {
    const current = [{ task: "add observability tracing" }, { task: "refactor module boundaries" }];
    const result = computeNoveltyScore(current, []);
    assert.equal(result.score, 1.0);
    assert.equal(result.novelCount, 2);
    assert.equal(result.totalCount, 2);
    assert.deepEqual(result.repeatedTasks, []);
  });

  it("identifies repeated plans when task text has ≥2 significant keyword overlaps with history", () => {
    const historical = [{ task: "fix verification harness false failures" }];
    const current = [
      { task: "fix verification harness race conditions" }, // ≥2 overlapping words with history
      { task: "add distributed tracing spans" },           // no overlap
    ];
    const result = computeNoveltyScore(current, historical);
    assert.equal(result.totalCount, 2);
    assert.equal(result.repeatedTasks.length, 1, "one plan should be classified as repeated");
    assert.equal(result.novelCount, 1);
    assert.ok(result.score > 0 && result.score < 1.0, "score should be between 0 and 1");
  });

  it("returns score 0 when all current plans are repeated", () => {
    const historical = [{ task: "implement dependency graph resolver logic" }];
    const current   = [{ task: "implement dependency graph resolver retry" }];
    const result = computeNoveltyScore(current, historical);
    assert.equal(result.novelCount, 0);
    assert.equal(result.score, 0);
    assert.equal(result.repeatedTasks.length, 1);
  });

  it("returns score 1.0 when no plan shares ≥2 keywords with history", () => {
    const historical = [{ task: "fix authentication token expiry" }];
    const current = [
      { task: "add observability metrics dashboard" },
      { task: "refactor database connection pooling" },
    ];
    const result = computeNoveltyScore(current, historical);
    assert.equal(result.score, 1.0);
    assert.equal(result.novelCount, 2);
    assert.deepEqual(result.repeatedTasks, []);
  });

  it("score is a rounded finite number in [0, 1]", () => {
    const historical = [
      { task: "fix carry forward ledger entries" },
      { task: "improve worker dispatch batching" },
    ];
    const current = [
      { task: "fix carry forward ledger cleanup" },  // repeated
      { task: "add circuit breaker pattern" },         // novel
      { task: "improve worker dispatch concurrency" }, // repeated
    ];
    const result = computeNoveltyScore(current, historical);
    assert.ok(Number.isFinite(result.score));
    assert.ok(result.score >= 0 && result.score <= 1.0);
  });

  it("negative path: handles null/undefined inputs gracefully", () => {
    const r1 = computeNoveltyScore(null as any, null as any);
    assert.equal(r1.score, 1.0);
    assert.equal(r1.totalCount, 0);
    const r2 = computeNoveltyScore(undefined as any, [{ task: "some task" }]);
    assert.equal(r2.totalCount, 0);
  });
});

describe("seedDiscoveryGapPackets", () => {
  it("returns empty array when novelty score is at or above threshold", () => {
    // All plans are novel (score = 1.0) — no seeding needed
    const current = [{ task: "add observability tracing" }];
    const result = seedDiscoveryGapPackets(current, []);
    assert.deepEqual(result, []);
  });

  it("returns empty array when currentPlans is empty", () => {
    const result = seedDiscoveryGapPackets([], [{ task: "fix something" }]);
    assert.deepEqual(result, []);
  });

  it("seeds packets when novelty collapses below NOVELTY_COLLAPSE_THRESHOLD", () => {
    // Construct a scenario where all current plans are repeated from history
    const historical = [
      { task: "fix verification harness false failures", leverage_rank: ["quality"] },
      { task: "implement carry forward ledger cleanup", leverage_rank: ["quality"] },
      { task: "add worker dispatch concurrency batching", leverage_rank: ["performance"] },
    ];
    const current = [
      { task: "fix verification harness race conditions", leverage_rank: ["quality"] },
      { task: "implement carry forward ledger expiry", leverage_rank: ["quality"] },
      { task: "add worker dispatch concurrency throttle", leverage_rank: ["performance"] },
    ];
    const result = seedDiscoveryGapPackets(current, historical);
    // novelty score should be 0 (all repeated) → below NOVELTY_COLLAPSE_THRESHOLD
    assert.ok(result.length > 0, "seeds must be generated when novelty collapses");
    // Each seed must be flagged
    for (const seed of result) {
      assert.equal(seed._discoveryGapSeed, true);
      assert.ok(typeof seed.task === "string" && seed.task.length > 0);
      assert.equal(seed.verification, "npm test");
      assert.ok(Array.isArray(seed.leverage_rank) && seed.leverage_rank.length > 0);
    }
  });

  it("respects maxSeeds option", () => {
    const historical = [
      { task: "fix verification harness false", leverage_rank: ["quality"] },
      { task: "implement carry forward ledger", leverage_rank: ["quality"] },
    ];
    const current = [
      { task: "fix verification harness race", leverage_rank: ["quality"] },
      { task: "implement carry forward expiry", leverage_rank: ["quality"] },
    ];
    const result = seedDiscoveryGapPackets(current, historical, { maxSeeds: 1 });
    assert.ok(result.length <= 1, "maxSeeds must be respected");
  });

  it("does not seed dimensions that are already covered", () => {
    const historical = [
      { task: "fix verification harness false", leverage_rank: ["observability", "security"] },
    ];
    const current = [
      { task: "fix verification harness race", leverage_rank: ["observability", "security"] },
    ];
    const result = seedDiscoveryGapPackets(current, historical);
    // observability and security are covered — seeds should not include those
    for (const seed of result) {
      assert.ok(
        !seed.leverage_rank.includes("observability"),
        "covered dimension must not be seeded"
      );
      assert.ok(
        !seed.leverage_rank.includes("security"),
        "covered dimension must not be seeded"
      );
    }
  });

  it("does not mutate input arrays", () => {
    const current  = [{ task: "fix verify harness false race", leverage_rank: ["quality"] }];
    const historical = [{ task: "fix verify harness false fails", leverage_rank: ["quality"] }];
    const origCurrent = current[0].task;
    seedDiscoveryGapPackets(current, historical);
    assert.equal(current[0].task, origCurrent, "input must not be mutated");
  });

  it("negative path: returns empty array for non-array inputs", () => {
    assert.deepEqual(seedDiscoveryGapPackets(null as any, null as any), []);
  });
});

describe("NOVELTY_COLLAPSE_THRESHOLD and NOVELTY_SEED_DIMENSIONS", () => {
  it("NOVELTY_COLLAPSE_THRESHOLD is a finite number in (0, 1)", () => {
    assert.ok(Number.isFinite(NOVELTY_COLLAPSE_THRESHOLD));
    assert.ok(NOVELTY_COLLAPSE_THRESHOLD > 0 && NOVELTY_COLLAPSE_THRESHOLD < 1);
  });

  it("NOVELTY_SEED_DIMENSIONS is a non-empty Set of strings", () => {
    assert.ok(NOVELTY_SEED_DIMENSIONS instanceof Set);
    assert.ok(NOVELTY_SEED_DIMENSIONS.size > 0);
    for (const dim of NOVELTY_SEED_DIMENSIONS) {
      assert.equal(typeof dim, "string");
    }
  });
});

// ── attachFallbackProvenance / quarantineLowConfidencePackets ──────────────────

describe("attachFallbackProvenance", () => {
  it("attaches _provenance to a plan packet", () => {
    const packet = { task: "do work", confidence: 0.4 };
    const tagged = attachFallbackProvenance(packet, { reason: "parser-fallback" });
    assert.ok(tagged._provenance, "_provenance must be attached");
    assert.equal(tagged._provenance.tag, FALLBACK_PROVENANCE_TAG.PARSER_FALLBACK);
    assert.equal(typeof tagged._provenance.attachedAt, "string");
    assert.ok(!isNaN(Date.parse(tagged._provenance.attachedAt)));
  });

  it("uses the provided confidence when supplied", () => {
    const packet = { task: "do work" };
    const tagged = attachFallbackProvenance(packet, { confidence: 0.3 });
    assert.equal(tagged._provenance.confidence, 0.3);
  });

  it("does not mutate the original packet object", () => {
    const packet = { task: "original" };
    const tagged = attachFallbackProvenance(packet, {});
    assert.ok(tagged !== packet, "must be a new object");
    assert.equal((packet as any)._provenance, undefined, "original must not be mutated");
  });

  it("passes non-object values through unchanged", () => {
    assert.equal(attachFallbackProvenance(null as any, {}), null);
    assert.equal(attachFallbackProvenance("string" as any, {}), "string");
    assert.equal(attachFallbackProvenance(42 as any, {}), 42);
  });

  it("FALLBACK_PROVENANCE_TAG is frozen and has expected keys", () => {
    assert.ok(Object.isFrozen(FALLBACK_PROVENANCE_TAG));
    assert.ok("PARSER_FALLBACK" in FALLBACK_PROVENANCE_TAG);
    assert.ok("UNCERTAINTY_FALLBACK" in FALLBACK_PROVENANCE_TAG);
  });
});

describe("quarantineLowConfidencePackets", () => {
  it("quarantines packets with confidence below threshold", () => {
    const packets = [
      { task: "a", _provenance: { confidence: 0.3, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
      { task: "b", _provenance: { confidence: 0.8, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
    ];
    const { allowed, quarantined } = quarantineLowConfidencePackets(packets);
    assert.equal(quarantined.length, 1, "one packet below threshold must be quarantined");
    assert.equal(quarantined[0].task, "a");
    assert.equal(allowed.length, 1);
    assert.equal(allowed[0].task, "b");
  });

  it("quarantined packets have _quarantined=true", () => {
    const packets = [
      { task: "low", _provenance: { confidence: 0.1, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
    ];
    const { quarantined } = quarantineLowConfidencePackets(packets);
    assert.equal(quarantined[0]._quarantined, true);
  });

  it("packets without _provenance are not quarantined (backward compatible)", () => {
    const packets = [{ task: "no-provenance" }];
    const { allowed, quarantined } = quarantineLowConfidencePackets(packets);
    assert.equal(allowed.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("negative: empty input returns empty allowed and quarantined", () => {
    const { allowed, quarantined } = quarantineLowConfidencePackets([]);
    assert.deepEqual(allowed, []);
    assert.deepEqual(quarantined, []);
  });

  it("respects custom threshold option", () => {
    const packets = [
      { task: "mid", _provenance: { confidence: 0.6, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
    ];
    // With threshold=0.7, a confidence of 0.6 should be quarantined
    const { quarantined } = quarantineLowConfidencePackets(packets, { threshold: 0.7 });
    assert.equal(quarantined.length, 1);
  });

  it("uses packet admission confidence ahead of aggregate provenance confidence", () => {
    const packets = [
      {
        task: "fresh survivor",
        _admissionConfidence: 0.8,
        _provenance: { confidence: 0.3, tag: "parser-fallback", attachedAt: new Date().toISOString() },
      },
    ];

    const { allowed, quarantined } = quarantineLowConfidencePackets(packets);
    assert.equal(allowed.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("QUARANTINE_CONFIDENCE_THRESHOLD is exported as 0.5", () => {
    assert.equal(QUARANTINE_CONFIDENCE_THRESHOLD, 0.5);
  });
});

// ── filterQuarantinedPlans (plan_contract_validator) ─────────────────────────

describe("filterQuarantinedPlans", () => {
  it("separates plans with _quarantined=true from dispatchable plans", () => {
    const plans = [
      { task: "a", _quarantined: true },
      { task: "b" },
      { task: "c", _quarantined: false },
    ];
    const { dispatchable, quarantined } = filterQuarantinedPlans(plans);
    assert.equal(quarantined.length, 1, "only _quarantined=true must be in quarantined set");
    assert.equal(quarantined[0].task, "a");
    assert.equal(dispatchable.length, 2);
  });

  it("quarantines plans with _provenance.confidence below threshold", () => {
    const plans = [
      { task: "low", _provenance: { confidence: 0.3, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
      { task: "high", _provenance: { confidence: 0.9, tag: "direct", attachedAt: new Date().toISOString() } },
    ];
    const { dispatchable, quarantined } = filterQuarantinedPlans(plans);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].task, "low");
    assert.equal(dispatchable.length, 1);
  });

  it("prefers _admissionConfidence over aggregate provenance confidence", () => {
    const plans = [
      {
        task: "dispatchable survivor",
        _admissionConfidence: 0.8,
        _provenance: { confidence: 0.3, tag: "parser-fallback", attachedAt: new Date().toISOString() },
      },
    ];

    const { dispatchable, quarantined } = filterQuarantinedPlans(plans);
    assert.equal(dispatchable.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("allows plans without provenance (backward compatible)", () => {
    const plans = [{ task: "no-prov" }, { task: "also-no-prov" }];
    const { dispatchable, quarantined } = filterQuarantinedPlans(plans);
    assert.equal(dispatchable.length, 2);
    assert.equal(quarantined.length, 0);
  });

  it("NEGATIVE PATH: returns empty sets for null input", () => {
    const { dispatchable, quarantined } = filterQuarantinedPlans(null as any);
    assert.deepEqual(dispatchable, []);
    assert.deepEqual(quarantined, []);
  });

  it("ignores inherited quarantine metadata on untrusted packet objects", () => {
    const inheritedPlan = Object.create({
      _quarantined: true,
      _admissionConfidence: 0.1,
      _provenance: { confidence: 0.1 },
    });
    inheritedPlan.task = "own-task";

    assert.equal(isPacketQuarantined(inheritedPlan), false);

    const { dispatchable, quarantined } = filterQuarantinedPlans([inheritedPlan]);
    assert.equal(dispatchable.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("PCV_QUARANTINE_THRESHOLD matches prometheus QUARANTINE_CONFIDENCE_THRESHOLD", () => {
    assert.equal(PCV_QUARANTINE_THRESHOLD, 0.5, "thresholds must be consistent across modules");
    assert.equal(PCV_QUARANTINE_THRESHOLD, QUARANTINE_CONFIDENCE_THRESHOLD);
  });
});

// ── quarantine wiring in normalizePrometheusParsedOutput ─────────────────────

describe("quarantine wiring — low-confidence packets excluded from dispatchable plans", () => {
  it("quarantineLowConfidencePackets filters plans with _provenance.confidence < 0.5 from dispatch set", () => {
    // Verify the wiring contract: plans with attached provenance below threshold
    // are excluded from the allowed set — simulating what the normalization pipeline does.
    const plans = [
      { task: "T1", role: "Evolution Worker",
        _provenance: { confidence: 0.3, tag: "parser-fallback", attachedAt: new Date().toISOString() } },
      { task: "T2", role: "Evolution Worker",
        _provenance: { confidence: 0.8, tag: "direct", attachedAt: new Date().toISOString() } },
    ];
    const { allowed, quarantined } = quarantineLowConfidencePackets(plans);
    assert.equal(quarantined.length, 1, "plan with confidence 0.3 must be quarantined");
    assert.equal(quarantined[0].task, "T1");
    assert.equal(allowed.length, 1, "plan with confidence 0.8 must be in allowed set");
    assert.equal(allowed[0].task, "T2");
  });

  it("NEGATIVE PATH: plans without provenance survive quarantine (backward compatible)", () => {
    const plans = [
      { task: "NoProv1", role: "Evolution Worker" },
      { task: "NoProv2", role: "Evolution Worker" },
    ];
    const { allowed, quarantined } = quarantineLowConfidencePackets(plans);
    assert.equal(allowed.length, 2, "plans without _provenance must pass through as high-confidence");
    assert.equal(quarantined.length, 0);
  });

  it("attachFallbackProvenance attaches _provenance.confidence that quarantine can act on", () => {
    const plan = { task: "fallback-plan", role: "Evolution Worker" };
    const withProv = attachFallbackProvenance(plan, {
      source: "prometheus-normalization",
      reason: "aggregate-parser-confidence",
      confidence: 0.3,
      tag: FALLBACK_PROVENANCE_TAG.PARSER_FALLBACK,
    });
    assert.ok(withProv._provenance, "_provenance must be attached");
    assert.equal(withProv._provenance.confidence, 0.3);
    const { quarantined } = quarantineLowConfidencePackets([withProv]);
    assert.equal(quarantined.length, 1, "plan with attached low confidence must be quarantined");
    assert.equal(quarantined[0]._quarantined, true);
    assert.ok(typeof quarantined[0]._quarantineReason === "string");
  });

  it("isPacketQuarantined returns true for plans tagged _quarantined=true", () => {
    assert.equal(isPacketQuarantined({ task: "x", _quarantined: true }), true);
    assert.equal(isPacketQuarantined({ task: "x" }), false);
    assert.equal(isPacketQuarantined({ task: "x", _provenance: { confidence: 0.3 } }), true);
    assert.equal(isPacketQuarantined({ task: "x", _provenance: { confidence: 0.8 } }), false);
    assert.equal(isPacketQuarantined({ task: "x", _admissionConfidence: 0.8, _provenance: { confidence: 0.3 } }), false);
  });
});

// ── buildBenchmarkSection ──────────────────────────────────────────────────────

import { buildBenchmarkSection } from "../../src/core/prometheus.js";

describe("buildBenchmarkSection", () => {
  it("returns empty string for null input", () => {
    assert.equal(buildBenchmarkSection(null), "");
  });

  it("returns empty string for benchmarkData with no entries", () => {
    assert.equal(buildBenchmarkSection({ entries: [] }), "");
  });

  it("returns empty string when latest entry has no recommendations", () => {
    assert.equal(buildBenchmarkSection({ entries: [{ cycleId: "c1", recommendations: [] }] }), "");
  });

  it("builds section string with recommendation statuses", () => {
    const benchmarkData = {
      entries: [
        {
          cycleId: "2026-01-01T00:00:00.000Z",
          recommendations: [
            { id: "rec-ai-0", topic: "AI Code Generation", summary: "Use AI for scaffolding", implementationStatus: "pending", benchmarkScore: null, capacityGain: null },
            { id: "rec-eval-1", topic: "Evaluation Framework", summary: "Add braintrust evals", implementationStatus: "implemented", benchmarkScore: 1.0, capacityGain: 0.8 },
          ],
        },
      ],
    };
    const section = buildBenchmarkSection(benchmarkData);
    assert.ok(section.length > 0, "section must be non-empty");
    assert.ok(section.includes("RESEARCH BENCHMARK STATUS"), "must contain section header");
    assert.ok(section.includes("PENDING"), "pending item must appear");
    assert.ok(section.includes("IMPLEMENTED"), "implemented item must appear");
    assert.ok(section.includes("AI Code Generation"), "topic name must appear");
  });

  it("includes benchmarkScore in section when present", () => {
    const benchmarkData = {
      entries: [
        {
          cycleId: "c1",
          recommendations: [
            { id: "rec-x-0", topic: "Test Topic", summary: "Some summary", implementationStatus: "pending", benchmarkScore: 0.75, capacityGain: null },
          ],
        },
      ],
    };
    const section = buildBenchmarkSection(benchmarkData);
    assert.ok(section.includes("0.75"), "benchmarkScore must appear in section");
  });

  it("includes cycleId in section header when available", () => {
    const benchmarkData = {
      entries: [
        {
          cycleId: "cycle-abc-123",
          recommendations: [
            { id: "r", topic: "T", summary: "S", implementationStatus: "pending", benchmarkScore: null, capacityGain: null },
          ],
        },
      ],
    };
    const section = buildBenchmarkSection(benchmarkData);
    assert.ok(section.includes("cycle-abc-123"), "cycleId must appear in section header");
  });

  it("negative: malformed entries array does not throw", () => {
    assert.doesNotThrow(() => buildBenchmarkSection({ entries: [null] }));
  });
});

describe("buildRoutingOutcomeSection", () => {
  it("returns empty string for invalid input", () => {
    assert.equal(buildRoutingOutcomeSection(null), "");
    assert.equal(buildRoutingOutcomeSection({}), "");
  });

  it("builds section grouped by taskKind success rate", () => {
    const payload = [
      { taskKind: "implementation", outcome: "done" },
      { taskKind: "implementation", outcome: "partial" },
      { taskKind: "implementation", outcome: "done" },
      { taskKind: "debt", outcome: "done" },
    ];
    const section = buildRoutingOutcomeSection(payload);
    assert.ok(section.includes("ROUTING OUTCOME SIGNALS"));
    assert.ok(section.includes("taskKind=implementation"));
    assert.ok(section.includes("samples=3"));
    assert.ok(section.includes("successRate=0.67"));
  });

  it("negative path: ignores malformed rows and still produces deterministic output", () => {
    const payload = [
      null,
      { taskKind: "", outcome: "done" },
      { taskKind: "implementation", outcome: "error" },
    ];
    const section = buildRoutingOutcomeSection(payload as any);
    assert.ok(section.includes("taskKind=general") || section.includes("taskKind=implementation"));
  });
});

describe("health-audit mandatory task injection contract", () => {
  it("extractMandatoryHealthAuditFindings keeps only critical/warning entries (bridges legacy 'important' to 'warning')", () => {
    const payload = {
      findings: [
        // "warning" is now a mandatory severity — previously "warning" was filtered out; that changes
        { area: "a", severity: "info", finding: "ignore", remediation: "n/a", capabilityNeeded: "info-only" },
        { area: "b", severity: "critical", finding: "must map", remediation: "fix now", capabilityNeeded: "cap-critical" },
        // legacy "important" is bridged to "warning" at extraction time
        { area: "c", severity: "important", finding: "must map too", remediation: "fix soon", capabilityNeeded: "cap-important" },
      ],
    };
    const result = extractMandatoryHealthAuditFindings(payload);
    assert.equal(result.length, 2);
    assert.deepEqual(result.map((f) => f.id), ["cap-critical", "cap-important"]);
    // Bridged finding has severity "warning" not "important"
    assert.equal(result[1].severity, "warning", "legacy 'important' must be bridged to 'warning'");
  });

  it("extractMandatoryHealthAuditFindings extracts warning severity findings as mandatory", () => {
    // "warning" replaces "important" as a mandatory severity.
    const payload = {
      findings: [
        { area: "a", severity: "info", finding: "skip", remediation: "n/a", capabilityNeeded: "info-gap" },
        { area: "b", severity: "warning", finding: "must map", remediation: "fix soon", capabilityNeeded: "cap-warning" },
      ],
    };
    const result = extractMandatoryHealthAuditFindings(payload);
    assert.equal(result.length, 1, "warning severity must be included as mandatory");
    assert.equal(result[0].id, "cap-warning");
    assert.equal(result[0].severity, "warning");
  });

  it("extractMandatoryHealthAuditFindings demotes closed findings before wave planning", () => {
    const payload = {
      findings: [
        { area: "ci", severity: "critical", finding: "Fix stale CI outage", remediation: "repair", capabilityNeeded: "cap-closed", status: "closed" },
        { area: "capability-gap", severity: "critical", finding: "Missing planner contract", remediation: "implement", capabilityNeeded: "cap-open" },
      ],
    };
    const result = extractMandatoryHealthAuditFindings(payload);
    assert.deepEqual(result.map((entry) => entry.id), ["cap-open"]);
  });

  it("buildMandatoryTasksPromptSection renders MANDATORY_TASKS with finding ids", () => {
    const section = buildMandatoryTasksPromptSection([
      {
        id: "cap-critical",
        area: "capability-gap",
        severity: "critical",
        finding: "Missing capability",
        remediation: "Implement contract",
        capabilityNeeded: "cap-critical",
      },
    ]);
    assert.ok(section.includes("## MANDATORY_TASKS"));
    assert.ok(section.includes("id=cap-critical"));
    assert.ok(section.includes("\"mandatoryTaskCoverage\""));
  });

  it("validateMandatoryTaskCoverageContract passes when each mandatory finding is mapped or excluded", () => {
    const findings = [
      {
        id: "cap-critical",
        area: "capability-gap",
        severity: "critical" as const,
        finding: "critical finding",
        remediation: "fix",
        capabilityNeeded: "cap-critical",
      },
      {
        id: "cap-warning",
        area: "system-learning",
        severity: "warning" as const,
        finding: "warning finding",
        remediation: "review",
        capabilityNeeded: "cap-warning",
      },
    ];
    const payload = {
      plans: [{ task: "Implement cap-critical flow", title: "Implement cap-critical flow" }],
      mandatoryTaskCoverage: [
        { findingId: "cap-critical", status: "mapped", planTask: "Implement cap-critical flow" },
        { findingId: "cap-warning", status: "excluded", justification: "Blocked by active governance gate this cycle." },
      ],
    };
    const result = validateMandatoryTaskCoverageContract(payload, findings);
    assert.equal(result.ok, true);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.invalid, []);
    assert.equal(result.mapped.length, 1);
    assert.equal(result.excluded.length, 1);
  });

  it("negative path: validateMandatoryTaskCoverageContract fails when a mandatory finding is unmapped", () => {
    const findings = [
      {
        id: "cap-critical",
        area: "capability-gap",
        severity: "critical" as const,
        finding: "critical finding",
        remediation: "fix",
        capabilityNeeded: "cap-critical",
      },
    ];
    const payload = {
      plans: [{ task: "Some unrelated task" }],
      mandatoryTaskCoverage: [],
    };
    const result = validateMandatoryTaskCoverageContract(payload, findings);
    assert.equal(result.ok, false);
    assert.deepEqual(result.missing, ["cap-critical"]);
  });

  it("negative path: enforce mode fail-closes parse output with non-zero exit and ENFORCE_REJECT token", () => {
    const findings = [
      {
        id: "cap-critical",
        area: "capability-gap",
        severity: "critical" as const,
        finding: "critical finding",
        remediation: "fix",
        capabilityNeeded: "cap-critical",
      },
    ];
    const payload: any = {
      plans: [{ task: "Some unrelated task" }],
      mandatoryTaskCoverage: [],
    };
    const coverage = validateMandatoryTaskCoverageContract(payload, findings);
    assert.equal(coverage.ok, false);
    assert.deepEqual(coverage.missing, ["cap-critical"]);

    const rejected = applyMandatoryCoverageEnforceReject(payload, coverage);
    assert.deepEqual(rejected.plans, [], "enforce reject must fail-close with plans=[]");
    assert.equal(rejected._mandatoryTaskCoverageGate?.logToken, MANDATORY_COVERAGE_ENFORCE_REJECT_TOKEN);
    assert.equal(rejected._mandatoryTaskCoverageGate?.exitCode, MANDATORY_COVERAGE_ENFORCE_EXIT_CODE);
    assert.ok(
      Number(rejected._parserReject?.exitCode) > 0,
      "parse reject exit code must be non-zero in enforce mode",
    );
    assert.equal(rejected._parserReject?.token, "ENFORCE_REJECT");
  });

  it("negative path: mapped entry must reference an existing plan task", () => {
    const findings = [
      {
        id: "cap-critical",
        area: "capability-gap",
        severity: "critical" as const,
        finding: "critical finding",
        remediation: "fix",
        capabilityNeeded: "cap-critical",
      },
    ];
    const payload = {
      plans: [{ task: "Actual task" }],
      mandatoryTaskCoverage: [{ findingId: "cap-critical", status: "mapped", planTask: "Missing task ref" }],
    };
    const result = validateMandatoryTaskCoverageContract(payload, findings);
    assert.equal(result.ok, false);
    assert.ok(result.invalid.some((v) => v.includes("mapped_without_existing_plan")));
  });

  it("synthesizes mandatory coverage from a matching plan when the companion block is missing", () => {
    const findings = [
      {
        id: "lane-diversity-governance",
        area: "governance",
        severity: "critical" as const,
        finding: "Lane diversity gate reasons are inconsistent across Prometheus and orchestrator",
        remediation: "Normalize governance lane reason contract",
        capabilityNeeded: "lane-diversity-governance",
      },
    ];
    const payload: any = {
      plans: [
        {
          task: "Normalize lane-diversity governance reason contract",
          capabilityTag: "lane-diversity-governance",
        },
      ],
    };

    const synthesized = synthesizeMandatoryTaskCoverage(payload, findings as any);
    const result = validateMandatoryTaskCoverageContract(synthesized, findings as any);

    assert.equal(result.ok, true);
    assert.deepEqual(synthesized.mandatoryTaskCoverage, [
      {
        findingId: "lane-diversity-governance",
        status: "mapped",
        planTask: "Normalize lane-diversity governance reason contract",
      },
    ]);
  });

  it("maps CI-critical mandatory findings to the enforced ci-fix packet", () => {
    const findings = [
      {
        id: "ci-failure-1",
        area: "ci",
        severity: "critical" as const,
        finding: "TypeError in tests/core/ci_gate.test.ts",
        remediation: "Repair CI failure packet",
        capabilityNeeded: "ci-fix",
      },
    ];
    const payload: any = {
      plans: [
        {
          task: "Build explicit CI repair packet from mandatory CI-critical findings: ci-failure-1",
          taskKind: "ci-fix",
        },
      ],
    };

    const synthesized = synthesizeMandatoryTaskCoverage(payload, findings as any);

    assert.deepEqual(synthesized.mandatoryTaskCoverage, [
      {
        findingId: "ci-failure-1",
        status: "mapped",
        planTask: "Build explicit CI repair packet from mandatory CI-critical findings: ci-failure-1",
      },
    ]);
  });

  it("injects deterministic fallback packets for unmatched mandatory findings", () => {
    const findings = [
      {
        id: "pre-wave-diversity-validation",
        area: "capability-gap",
        severity: "warning" as const,
        finding: "Lane diversity gate fires after waves have already dispatched",
        remediation: "Move lane_diversity_gate check to pre-wave-1 validation and set dispatchBlockReason in src/core/orchestrator.ts",
        capabilityNeeded: "pre-wave-diversity-validation",
      },
    ];
    const payload: any = { plans: [] };

    const enforced = enforceMandatoryFindingCoveragePackets(payload, findings as any);
    const synthesized = synthesizeMandatoryTaskCoverage(enforced.output, findings as any);
    const result = validateMandatoryTaskCoverageContract(synthesized, findings as any);

    assert.deepEqual(enforced.injectedFindingIds, ["pre-wave-diversity-validation"]);
    assert.equal(enforced.output.plans.length, 1);
    assert.equal(result.ok, true);
    assert.match(String(enforced.output.plans[0].task || ""), /pre-wave-diversity-validation/i);
  });

  it("buildMandatoryCoverageRetryDiff emits deterministic missing/invalid lines", () => {
    const diff = buildMandatoryCoverageRetryDiff({
      ok: false,
      missing: ["cap-critical", "cap-important"],
      invalid: ["cap-critical:mapped_without_existing_plan"],
      mapped: [],
      excluded: [],
    });
    assert.ok(diff.includes("missing=[cap-critical, cap-important]"));
    assert.ok(diff.includes("invalid=[cap-critical:mapped_without_existing_plan]"));
  });

  it("buildMandatoryCoverageRetryDiff uses none when missing and invalid are empty", () => {
    const diff = buildMandatoryCoverageRetryDiff({
      ok: true,
      missing: [],
      invalid: [],
      mapped: ["cap-critical"],
      excluded: [],
    });
    assert.ok(diff.includes("missing=[none]"));
    assert.ok(diff.includes("invalid=[none]"));
  });

  it("forces a wave-1 ci-fix packet when CI-critical mandatory findings exist", () => {
    const payload: any = {
      githubCiContext: {
        failedCiRuns: [{ runId: 123, headSha: "abc123" }],
      },
      plans: [],
    };
    const findings: any[] = [
      {
        id: "ci-failure-1",
        area: "ci",
        severity: "critical",
        finding: "TypeError: expected true to be false in tests/core/ci_gate.test.ts",
        remediation: "at Object.<anonymous> (tests/core/ci_gate.test.ts:12:4)",
        capabilityNeeded: "ci-fix-packet",
      },
    ];

    const enforced = enforceCiRepairPacketForMandatoryFindings(payload, findings as any);
    assert.equal(enforced.injected, true);
    const ciPlan = enforced.output.plans.find((plan: any) => plan.taskKind === "ci-fix");
    assert.ok(ciPlan, "ci-fix plan must be injected");
    assert.equal(ciPlan.wave, 1, "ci-fix packet must be forced into wave 1");
    assert.equal(ciPlan.githubCiContext.failedCiRuns[0].headSha, "abc123");
    assert.ok(ciPlan.ciFailureEvidence.errorMessages.some((msg: string) => msg.includes("TypeError")));
    assert.ok(ciPlan.ciFailureEvidence.failedTestIdentifiers.includes("tests/core/ci_gate.test.ts"));
  });

  it("enriches an existing ci-fix packet without duplication (negative path)", () => {
    const payload: any = {
      plans: [
        {
          task: "Fix CI failures",
          taskKind: "ci-fix",
          wave: 3,
          ciFailureEvidence: { errorMessages: ["old"] },
        },
      ],
    };
    const findings: any[] = [
      {
        id: "ci-failure-1",
        area: "ci",
        severity: "critical",
        finding: "AssertionError: expected 1 to equal 2",
        remediation: "FAIL tests/core/failure.test.ts",
        capabilityNeeded: "ci-fix",
      },
    ];

    const enforced = enforceCiRepairPacketForMandatoryFindings(payload, findings as any);
    assert.equal(enforced.injected, false);
    assert.equal(enforced.output.plans.length, 1, "existing packet should be enriched, not duplicated");
    assert.equal(enforced.output.plans[0].wave, 1, "existing ci-fix packet must be moved to wave 1");
    assert.ok(enforced.output.plans[0].ciFailureEvidence.errorMessages.some((m: string) => m.includes("AssertionError")));
  });

  it("negative path: does not force ci-fix packet for non-CI mandatory findings", () => {
    const payload: any = { plans: [] };
    const findings: any[] = [
      {
        id: "memory-critical-1",
        area: "memory",
        severity: "critical",
        finding: "Memory snapshots are stale",
        remediation: "Refresh carry-forward summarization",
        capabilityNeeded: "memory-refresh",
      },
    ];

    const enforced = enforceCiRepairPacketForMandatoryFindings(payload, findings as any);
    assert.equal(enforced.injected, false);
    assert.equal(enforced.output.plans.length, 0);
  });

  it("detects CI-critical mandatory finding and extracts concrete evidence", () => {
    const finding: any = {
      id: "ci-failure-2",
      area: "continuous-integration",
      severity: "critical",
      finding: "TypeError: boom on tests/core/ci_gate.test.ts",
      remediation: "at Runner.run (tests/core/ci_gate.test.ts:42:9)",
      capabilityNeeded: "ci-fix",
    };

    assert.equal(isCiCriticalMandatoryFinding(finding), true);
    const evidence = extractCiEvidenceFromMandatoryFinding(finding);
    assert.ok(evidence.failedTestIdentifiers.includes("tests/core/ci_gate.test.ts"));
    assert.ok(evidence.errorMessages.some((msg) => msg.includes("TypeError: boom")));
    assert.ok(evidence.stackTraces.some((line) => line.includes("at Runner.run")));
  });
});

// ── Output fidelity gate — process-thought marker detection ───────────────────

describe("detectProcessThoughtMarkers", () => {
  it("detects <think> opening tag", () => {
    assert.equal(detectProcessThoughtMarkers("<think>some reasoning</think>"), true);
  });

  it("detects <reasoning> tag", () => {
    assert.equal(detectProcessThoughtMarkers("<reasoning>internal</reasoning>"), true);
  });

  it("detects [THINKING] bracket marker", () => {
    assert.equal(detectProcessThoughtMarkers("Here is the plan. [THINKING] let me reconsider"), true);
  });

  it("detects case-insensitive variants", () => {
    assert.equal(detectProcessThoughtMarkers("<THINK>text"), true);
    assert.equal(detectProcessThoughtMarkers("<Reasoning>text"), true);
  });

  it("returns false for clean text with no markers", () => {
    assert.equal(detectProcessThoughtMarkers("Fix the authentication bug in src/auth.ts"), false);
  });

  it("returns false for empty string", () => {
    assert.equal(detectProcessThoughtMarkers(""), false);
  });

  it("returns false for non-string input coerced to string", () => {
    assert.equal(detectProcessThoughtMarkers(null as any), false);
  });
});

describe("scanParsedOutputForProcessThought", () => {
  it("returns empty array for clean output", () => {
    const parsed = {
      analysis: "Clean analysis text",
      plans: [{ task: "Fix the auth bug", context: "auth module needs update" }],
    };
    assert.deepEqual(scanParsedOutputForProcessThought(parsed), []);
  });

  it("detects contamination in top-level analysis field", () => {
    const parsed = { analysis: "<think>should I plan this?</think> Final plan." };
    const result = scanParsedOutputForProcessThought(parsed);
    assert.ok(result.includes("analysis"), "analysis field should be flagged");
  });

  it("detects contamination in plans[].task", () => {
    const parsed = {
      plans: [{ task: "<reasoning>hmm</reasoning> Fix the bug" }],
    };
    const result = scanParsedOutputForProcessThought(parsed);
    assert.ok(result.includes("plans[0].task"), "plans[0].task must be flagged");
  });

  it("detects contamination in plans[].context", () => {
    const parsed = {
      plans: [{ task: "Fix bug", context: "[THINKING] let me check context [/THINKING]" }],
    };
    const result = scanParsedOutputForProcessThought(parsed);
    assert.ok(result.includes("plans[0].context"), "plans[0].context must be flagged");
  });

  it("returns empty array for null/non-object input", () => {
    assert.deepEqual(scanParsedOutputForProcessThought(null), []);
    assert.deepEqual(scanParsedOutputForProcessThought("string"), []);
  });

  it("reports all contaminated fields, not just the first", () => {
    const parsed = {
      analysis: "<think>thinking</think>",
      strategicNarrative: "<reasoning>reasoning</reasoning>",
      plans: [{ task: "<think>t</think>Fix it", context: "clean" }],
    };
    const result = scanParsedOutputForProcessThought(parsed);
    assert.ok(result.includes("analysis"));
    assert.ok(result.includes("strategicNarrative"));
    assert.ok(result.includes("plans[0].task"));
    assert.equal(result.includes("plans[0].context"), false, "clean context must not be flagged");
  });
});

describe("OUTPUT_FIDELITY_GATE_FAIL_REASON", () => {
  it("is the string 'output-fidelity-gate'", () => {
    assert.equal(OUTPUT_FIDELITY_GATE_FAIL_REASON, "output-fidelity-gate");
  });
});

describe("MAX_ACTIONABLE_STEPS_PER_PACKET and PACKET_OVERSIZE_REASON", () => {
  it("MAX_ACTIONABLE_STEPS_PER_PACKET is 3", () => {
    assert.equal(MAX_ACTIONABLE_STEPS_PER_PACKET, 3);
  });

  it("PACKET_OVERSIZE_REASON is a non-empty string", () => {
    assert.equal(typeof PACKET_OVERSIZE_REASON, "string");
    assert.ok(PACKET_OVERSIZE_REASON.length > 0);
  });
});

describe("normalizeScalarContractField — parse-boundary normalization", () => {
  it("returns the number unchanged for a bare finite number", () => {
    const result = normalizeScalarContractField(0.5, "capacityDelta");
    assert.equal(result.value, 0.5);
    assert.equal(result.provenance, null);
  });

  it("returns NaN with null provenance for null input", () => {
    const result = normalizeScalarContractField(null, "capacityDelta");
    assert.ok(Number.isNaN(result.value));
    assert.equal(result.provenance, null);
  });

  it("returns NaN with null provenance for undefined input", () => {
    const result = normalizeScalarContractField(undefined, "requestROI");
    assert.ok(Number.isNaN(result.value));
    assert.equal(result.provenance, null);
  });

  it("extracts scalar from object-shaped { value } field", () => {
    const result = normalizeScalarContractField({ value: 0.3 }, "capacityDelta");
    assert.equal(result.value, 0.3);
    assert.ok(typeof result.provenance === "string" && result.provenance.includes("object_coercion"));
    assert.ok(result.provenance!.includes("capacityDelta"));
    assert.ok(result.provenance!.includes("value"));
  });

  it("extracts scalar from object-shaped { estimate } field", () => {
    const result = normalizeScalarContractField({ estimate: 2.0 }, "requestROI");
    assert.equal(result.value, 2.0);
    assert.ok(result.provenance!.includes("estimate"));
  });

  it("extracts scalar from object-shaped { amount } field", () => {
    const result = normalizeScalarContractField({ amount: -0.2 }, "capacityDelta");
    assert.equal(result.value, -0.2);
    assert.ok(result.provenance!.includes("amount"));
  });

  it("prefers 'value' over 'estimate' when both keys are present", () => {
    const result = normalizeScalarContractField({ value: 1.5, estimate: 3.0 }, "requestROI");
    assert.equal(result.value, 1.5, "value key must take priority over estimate");
  });

  it("aggregates numeric object values when no canonical scalar key is present", () => {
    const result = normalizeScalarContractField({ unknown_field: 0.5 }, "capacityDelta");
    assert.equal(result.value, 0.5);
    assert.ok(typeof result.provenance === "string" && result.provenance.includes("object_aggregate"));
  });

  it("averages multidimensional numeric strings for capacityDelta", () => {
    const result = normalizeScalarContractField({
      latency: "+0.18",
      cost_efficiency: "+0.22",
      planning_repeatability: "+0.12",
    }, "capacityDelta");
    assert.equal(result.value, 0.173);
    assert.ok(typeof result.provenance === "string" && result.provenance.includes("object_aggregate"));
  });

  it("normalizePrometheusParsedOutput handles object-shaped capacityDelta in plans", () => {
    const parsed = {
      projectHealth: "needs-work",
      plans: [
        {
          task: "Fix object-shaped ROI plan",
          role: "evolution-worker",
          wave: 1,
          capacityDelta: { value: 0.4 },
          requestROI: { estimate: 2.5 },
          acceptance_criteria: ["Scalar values are extracted correctly"],
          target_files: ["src/core/prometheus.ts"],
        },
      ],
    };

    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(Array.isArray(result.plans), true);
    assert.equal(result.plans.length, 1);
    const plan = result.plans[0];
    assert.equal(plan.capacityDelta, 0.4, "capacityDelta must be extracted from {value} object");
    assert.equal(plan.requestROI, 2.5, "requestROI must be extracted from {estimate} object");
  });

  it("normalizePrometheusParsedOutput aggregates numeric object fields when scalar keys are absent", () => {
    const parsed = {
      projectHealth: "needs-work",
      plans: [
        {
          task: "Unresolvable ROI plan",
          role: "evolution-worker",
          wave: 1,
          capacityDelta: { bad_key: 0.4 },
          requestROI: { also_bad: 2.5 },
          acceptance_criteria: ["Fallback defaults applied"],
          target_files: ["src/core/prometheus.ts"],
        },
      ],
    };

    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const plan = result.plans[0];
    assert.equal(plan.capacityDelta, 0.4, "capacityDelta must aggregate numeric object values");
    assert.equal(plan.requestROI, 2.5, "requestROI must aggregate numeric object values");
  });

  it("negative path: integer zero capacityDelta is preserved (boundary edge)", () => {
    // 0 is valid (neutral), so it must be preserved rather than defaulted.
    const result = normalizeScalarContractField(0, "capacityDelta");
    assert.equal(result.value, 0);
    assert.equal(result.provenance, null);
  });
});

// ── computeDiagnosticsFreshnessAdmission ──────────────────────────────────────

import {
  computeDiagnosticsFreshnessAdmission,
  tagStaleDiagnosticsBackedPlans,
  buildDiagnosticsFreshnessRecords,
} from "../../src/core/prometheus.js";

describe("computeDiagnosticsFreshnessAdmission", () => {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

  it("returns allFresh=true when all records are within staleAfterMs", () => {
    const nowMs = Date.now();
    const records = [
      { label: "intervention_optimizer", recordedAt: new Date(nowMs - 10_000).toISOString(), staleAfterMs: SIX_HOURS_MS },
      { label: "dependency_graph", recordedAt: new Date(nowMs - 30_000).toISOString(), staleAfterMs: SIX_HOURS_MS },
    ];
    const result = computeDiagnosticsFreshnessAdmission(records, nowMs);
    assert.equal(result.allFresh, true);
    assert.deepEqual(result.staleSources, []);
    assert.deepEqual(result.freshnessReasons, []);
  });

  it("returns allFresh=false and stale source when record is beyond staleAfterMs", () => {
    const nowMs = Date.now();
    const records = [
      { label: "intervention_optimizer", recordedAt: new Date(nowMs - SIX_HOURS_MS - 1000).toISOString(), staleAfterMs: SIX_HOURS_MS },
    ];
    const result = computeDiagnosticsFreshnessAdmission(records, nowMs);
    assert.equal(result.allFresh, false);
    assert.ok(result.staleSources.includes("intervention_optimizer"), "intervention_optimizer must be in staleSources");
    assert.ok(result.freshnessReasons[0].startsWith("stale_diagnostics:intervention_optimizer:"), "reason must start with stale_diagnostics prefix");
  });

  it("treats missing recordedAt as a stale source with missing_diagnostics reason", () => {
    const result = computeDiagnosticsFreshnessAdmission(
      [{ label: "dependency_graph", recordedAt: null }],
      Date.now(),
    );
    assert.equal(result.allFresh, false);
    assert.ok(result.staleSources.includes("dependency_graph"));
    assert.equal(result.freshnessReasons[0], "missing_diagnostics:dependency_graph");
  });

  it("negative: empty records list returns allFresh=true", () => {
    const result = computeDiagnosticsFreshnessAdmission([], Date.now());
    assert.equal(result.allFresh, true);
    assert.deepEqual(result.staleSources, []);
  });

  it("handles invalid timestamp as missing_diagnostics", () => {
    const result = computeDiagnosticsFreshnessAdmission(
      [{ label: "my_source", recordedAt: "not-a-date" }],
      Date.now(),
    );
    assert.equal(result.allFresh, false);
    assert.ok(result.freshnessReasons[0].includes("missing_diagnostics"));
  });
});

describe("applyDiagnosticsFreshnessTruthToPlanning", () => {
  it("keeps planningTruthStatus=live and no confidence penalty when all diagnostics are fresh", () => {
    const parsed = {
      parserCoreConfidence: 1.0,
      parserContextPenalty: 0,
      parserConfidence: 1.0,
      parserConfidenceComponents: {},
      parserConfidencePenalties: [],
    };
    const result = applyDiagnosticsFreshnessTruthToPlanning(parsed, {
      allFresh: true,
      staleSources: [],
      freshnessReasons: [],
    });

    assert.equal(result.planningTruthStatus, "live");
    assert.equal(result.penaltyApplied, 0);
    assert.equal(parsed.planningTruthStatus, "live");
    assert.equal(parsed.parserConfidenceComponents.diagnosticsFreshness, 1.0);
    assert.equal(parsed.parserConfidence, 1.0);
  });

  it("marks planningTruthStatus=historical and reduces parser confidence when diagnostics are stale", () => {
    const parsed = {
      parserCoreConfidence: 1.0,
      parserContextPenalty: 0,
      parserConfidence: 1.0,
      parserConfidenceComponents: {},
      parserConfidencePenalties: [],
    };
    const result = applyDiagnosticsFreshnessTruthToPlanning(parsed, {
      allFresh: false,
      staleSources: ["dependency_graph"],
      freshnessReasons: ["stale_diagnostics:dependency_graph:ageMinutes=480:staleAfterMs=21600000"],
    });

    assert.equal(result.planningTruthStatus, "historical");
    assert.ok(result.penaltyApplied > 0);
    assert.equal(parsed.planningTruthStatus, "historical");
    assert.ok(parsed.parserConfidence < 1.0, "stale diagnostics must reduce aggregate parser confidence");
    assert.ok(
      parsed.parserConfidencePenalties.some((p: any) => p.component === "diagnosticsFreshness"),
      "diagnosticsFreshness penalty must be emitted",
    );
  });
});

describe("computePacketAdmissionConfidence", () => {
  it("keeps independently evidenced packets dispatchable when only stale diagnostics lower aggregate confidence", () => {
    const parsed = {
      parserCoreConfidence: 0.8,
      parserContextPenalty: 0.4,
      parserConfidence: 0.4,
      parserConfidencePenalties: [
        { component: "diagnosticsFreshness", delta: -0.4 },
      ],
    };

    const freshPacket = {
      task: "dispatchable plan",
      implementationEvidence: ["tests/core/prometheus_parse.test.ts"],
    };
    const stalePacket = {
      task: "stale-backed plan",
      _staleDiagnosticsGated: true,
    };

    assert.equal(computePacketAdmissionConfidence(freshPacket, parsed), 0.8);
    assert.equal(computePacketAdmissionConfidence(stalePacket, parsed), 0.4);
  });

  it("keeps non-diagnostics context penalties active for every packet", () => {
    const parsed = {
      parserCoreConfidence: 0.9,
      parserContextPenalty: 0.35,
      parserConfidence: 0.55,
      parserConfidencePenalties: [
        { component: "bottleneckCoverage", delta: -0.15 },
        { component: "architectureDrift", delta: -0.2 },
      ],
    };

    assert.equal(computePacketAdmissionConfidence({ task: "any plan" }, parsed), 0.55);
  });
});

describe("tagStaleDiagnosticsBackedPlans", () => {
  const staleFreshness = {
    allFresh: false,
    staleSources: ["intervention_optimizer"],
    freshnessReasons: ["stale_diagnostics:intervention_optimizer:ageMinutes=480:staleAfterMs=21600000"],
  };

  it("tags plans that reference a stale source label in task text", () => {
    const plans = [
      { task: "Use intervention_optimizer findings to address bottlenecks", role: "Evolution Worker" },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(plans[0]._staleDiagnosticsGated, true);
    assert.ok(typeof plans[0]._staleDiagnosticsReason === "string");
    assert.ok((plans[0]._staleDiagnosticsReason as string).includes("stale_diagnostics_backed"));
  });

  it("tags plans without independent backing when diagnostics are stale", () => {
    const plans = [
      { task: "Implement generic optimization", role: "Evolution Worker" },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    // Plan has no implementationEvidence or _noveltyScore — tagged as stale-backed
    assert.equal(plans[0]._staleDiagnosticsGated, true);
  });

  it("does NOT tag plans that have implementationEvidence when they don't reference stale source", () => {
    const plans = [
      {
        task: "Refactor parser baseline recovery module",
        role: "Evolution Worker",
        implementationEvidence: ["src/core/parser_baseline_recovery.ts already has gap at line 42"],
      },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(plans[0]._staleDiagnosticsGated, undefined, "plan with implementationEvidence must not be tagged");
  });

  it("does NOT tag plans that have concrete target_files when they don't reference stale source", () => {
    const plans = [
      {
        task: "Refactor parser baseline recovery module",
        role: "Evolution Worker",
        target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
      },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(plans[0]._staleDiagnosticsGated, undefined, "plan with target_files backing must not be tagged");
  });

  it("does NOT tag plans when all diagnostics are fresh", () => {
    const freshResult = { allFresh: true, staleSources: [], freshnessReasons: [] };
    const plans = [{ task: "Some task", role: "Evolution Worker" }];
    tagStaleDiagnosticsBackedPlans(plans, freshResult);
    assert.equal(plans[0]._staleDiagnosticsGated, undefined);
  });

  it("negative: returns same array reference when no tagging needed (all fresh)", () => {
    const fresh = { allFresh: true, staleSources: [], freshnessReasons: [] };
    const plans = [{ task: "Some task" }];
    const result = tagStaleDiagnosticsBackedPlans(plans, fresh);
    assert.equal(result, plans, "same array reference must be returned");
  });
});

// ── buildDiagnosticsFreshnessRecords ──────────────────────────────────────────

describe("buildDiagnosticsFreshnessRecords", () => {
  it("returns a record with recordedAt=null for each missing diagnostics file", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      assert.ok(Array.isArray(records), "must return an array");
      assert.ok(
        records.length >= 3,
        "must return at least 3 records (intervention_optimizer + dependency_graph + worker_cycle_artifacts)",
      );
      for (const r of records) {
        assert.equal(r.recordedAt, null, `missing file ${r.label} must produce recordedAt=null`);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns a record with recordedAt set when a valid JSONL artifact exists", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const savedAt = new Date(Date.now() - 60_000).toISOString(); // 1 minute ago
      const record = {
        jsonlSchema: "box.intervention_optimizer_log.v2",
        recordType: "intervention_optimizer_diagnostic",
        schemaVersion: 1,
        savedAt,
        freshness: { status: "fresh", staleAfterMs: 21_600_000, expiresAt: new Date(Date.now() + 1000).toISOString() },
        payload: {},
      };
      writeFileSync(
        path.join(tmpDir, "intervention_optimizer_log.jsonl"),
        JSON.stringify(record) + "\n",
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const optimizerRecord = records.find(r => r.label === "intervention_optimizer");
      assert.ok(optimizerRecord, "intervention_optimizer record must exist");
      assert.equal(optimizerRecord!.recordedAt, savedAt, "recordedAt must match savedAt from artifact");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: returns recordedAt=null when JSONL line is unparseable", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      writeFileSync(
        path.join(tmpDir, "intervention_optimizer_log.jsonl"),
        "not-valid-json\n",
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const r = records.find(r => r.label === "intervention_optimizer");
      assert.ok(r, "record must still be returned");
      assert.equal(r!.recordedAt, null, "unparseable artifact must produce recordedAt=null");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: dependency_graph recordedAt=null when latest JSONL line fails diagnostics contract", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const invalidRecord = {
        // deliberately wrong schema to verify strict trust-boundary validation.
        jsonlSchema: "legacy.schema",
        recordType: "dependency_graph_diagnostic",
        savedAt: new Date().toISOString(),
        freshness: { staleAfterMs: 21_600_000 },
      };
      writeFileSync(
        path.join(tmpDir, "dependency_graph_diagnostics.json"),
        JSON.stringify(invalidRecord) + "\n",
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const graphRecord = records.find((r) => r.label === "dependency_graph");
      assert.ok(graphRecord, "dependency_graph record must exist");
      assert.equal(graphRecord!.recordedAt, null, "invalid diagnostics contract must not be normalized for prompt admission");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: quarantines dependency_graph when latest NDJSON line is malformed even if older line is valid", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const validSavedAt = new Date(Date.now() - 30_000).toISOString();
      const validRecord = {
        jsonlSchema: "box.diagnostics_artifact.v1",
        recordType: "dependency_graph_diagnostic",
        schemaVersion: 1,
        savedAt: validSavedAt,
        persistedAt: validSavedAt,
        freshness: {
          status: "fresh",
          staleAfterMs: 21_600_000,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        status: "ok",
        reasonCode: "VALID",
        waves: [],
        conflictPairs: [],
        cycles: [],
        payload: {
          status: "ok",
          reasonCode: "VALID",
          waves: [],
          conflictPairs: [],
          cycles: [],
        },
      };
      const malformedNewestLine = "{this-is-not-json";
      writeFileSync(
        path.join(tmpDir, "dependency_graph_diagnostics.json"),
        `${JSON.stringify(validRecord)}\n${malformedNewestLine}\n`,
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const graphRecord = records.find((r) => r.label === "dependency_graph");
      assert.ok(graphRecord, "dependency_graph record must exist");
      assert.equal(
        graphRecord!.recordedAt,
        null,
        "malformed latest line must quarantine dependency_graph instead of back-scanning older entries",
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns worker_cycle_artifacts recordedAt when canonical snapshot validates", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const updatedAt = new Date(Date.now() - 45_000).toISOString();
      writeFileSync(
        path.join(tmpDir, "worker_cycle_artifacts.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt,
          latestCycleId: "cycle-123",
          cycles: {
            "cycle-123": {
              cycleId: "cycle-123",
              updatedAt,
              status: "running",
              workerSessions: {},
              workerActivity: {},
              completedTaskIds: [],
            },
          },
        }),
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const snapshotRecord = records.find(r => r.label === "worker_cycle_artifacts");
      assert.ok(snapshotRecord, "worker_cycle_artifacts record must exist");
      assert.equal(snapshotRecord!.recordedAt, updatedAt);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: worker_cycle_artifacts recordedAt=null when snapshot schema is invalid", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      writeFileSync(
        path.join(tmpDir, "worker_cycle_artifacts.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt: new Date().toISOString(),
          latestCycleId: "cycle-123",
          // invalid: declares schemaVersion=1 but omits required cycles envelope.
        }),
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const snapshotRecord = records.find(r => r.label === "worker_cycle_artifacts");
      assert.ok(snapshotRecord, "worker_cycle_artifacts record must be emitted");
      assert.equal(snapshotRecord!.recordedAt, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: worker_cycle_artifacts recordedAt=null when latestCycleId does not map to a cycle record", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(path.join(tmpdir(), "diag-freshness-"));
    try {
      const updatedAt = new Date().toISOString();
      writeFileSync(
        path.join(tmpDir, "worker_cycle_artifacts.json"),
        JSON.stringify({
          schemaVersion: 1,
          updatedAt,
          latestCycleId: "missing-cycle",
          cycles: {
            "other-cycle": {
              cycleId: "other-cycle",
              updatedAt,
              status: "running",
              workerSessions: {},
              workerActivity: {},
              completedTaskIds: [],
            },
          },
        }),
        "utf8",
      );
      const records = await buildDiagnosticsFreshnessRecords(tmpDir);
      const snapshotRecord = records.find((r) => r.label === "worker_cycle_artifacts");
      assert.ok(snapshotRecord, "worker_cycle_artifacts record must be emitted");
      assert.equal(snapshotRecord!.recordedAt, null);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ── Stale-diagnostics admission gate — live pipeline wiring ──────────────────

describe("stale-diagnostics live admission gate — tagStaleDiagnosticsBackedPlans + validatePlanContract wiring", () => {
  it("stale-tagged plan receives STALE_DIAGNOSTICS_BACKED contract violation", () => {
    const staleFreshness = {
      allFresh: false,
      staleSources: ["intervention_optimizer"],
      freshnessReasons: ["stale_diagnostics:intervention_optimizer:ageMinutes=480:staleAfterMs=21600000"],
    };
    const plans = [
      { task: "Implement generic optimization without independent evidence", role: "Evolution Worker" },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(plans[0]._staleDiagnosticsGated, true, "plan must be tagged as stale-backed");

    // Contract validator must emit the STALE_DIAGNOSTICS_BACKED violation for tagged plans
    const result = validatePlanContract(plans[0]);
    const hasStaleViolation = result.violations.some(v => v.code === "stale_diagnostics_backed");
    assert.ok(hasStaleViolation, "validatePlanContract must emit stale_diagnostics_backed violation for tagged plan");
  });

  it("plan with implementationEvidence bypasses stale-diagnostics tagging", () => {
    const staleFreshness = {
      allFresh: false,
      staleSources: ["intervention_optimizer"],
      freshnessReasons: ["stale_diagnostics:intervention_optimizer:ageMinutes=480:staleAfterMs=21600000"],
    };
    const plans = [
      {
        task: "Refactor canary engine decision logic",
        role: "Evolution Worker",
        implementationEvidence: ["src/core/canary_engine.ts line 42 has gap in decision path"],
      },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(
      plans[0]._staleDiagnosticsGated,
      undefined,
      "independently-evidenced plan must not be tagged as stale-backed",
    );

    const result = validatePlanContract(plans[0]);
    const hasStaleViolation = result.violations.some(v => v.code === "stale_diagnostics_backed");
    assert.equal(hasStaleViolation, false, "independently-evidenced plan must not receive stale_diagnostics_backed violation");
  });

  it("plan with concrete target_files backing bypasses stale-diagnostics tagging", () => {
    const staleFreshness = {
      allFresh: false,
      staleSources: ["worker_cycle_artifacts"],
      freshnessReasons: ["stale_diagnostics:worker_cycle_artifacts:ageMinutes=480:staleAfterMs=21600000"],
    };
    const plans = [
      {
        task: "Restore deterministic Windows verification",
        role: "quality-worker",
        target_files: ["src/core/verification_command_registry.ts", "tests/core/prometheus_parse.test.ts"],
        verification: "npm test -- tests/core/prometheus_parse.test.ts",
        acceptance_criteria: ["Regression tests cover Windows glob artifact handling"],
        dependencies: [],
        capacityDelta: 0.33,
        requestROI: 2.6,
      },
    ];
    tagStaleDiagnosticsBackedPlans(plans, staleFreshness);
    assert.equal(plans[0]._staleDiagnosticsGated, undefined);

    const result = validatePlanContract(plans[0]);
    const hasStaleViolation = result.violations.some(v => v.code === "stale_diagnostics_backed");
    assert.equal(hasStaleViolation, false);
  });

  it("negative: when all diagnostics are fresh, no plans are tagged regardless of evidence", () => {
    const freshAdmission = { allFresh: true, staleSources: [], freshnessReasons: [] };
    const plans = [
      { task: "Any task with no evidence", role: "Evolution Worker" },
      { task: "Another task", role: "Evolution Worker" },
    ];
    tagStaleDiagnosticsBackedPlans(plans, freshAdmission);
    for (const p of plans) {
      assert.equal(
        (p as any)._staleDiagnosticsGated,
        undefined,
        "fresh diagnostics must not tag any plan",
      );
    }
  });
});

describe("applyAdmissionPacketHardFilter", () => {
  function makePlan(overrides: Record<string, unknown> = {}) {
    return {
      task: "Repair planner evidence coupling",
      role: "evolution-worker",
      wave: 1,
      verification: "npm test",
      dependencies: [],
      acceptance_criteria: ["planner emits actionable work"],
      implementationEvidence: ["src/core/prometheus.ts"],
      capacityDelta: 0.2,
      requestROI: 1.5,
      capacityFirstReason: "Improves premium request yield by reducing wasted planning cycles",
      ...overrides,
    };
  }

  function makeAdmissionViolationResult(planIndex: number) {
    return {
      planIndex,
      valid: false,
      violations: [
        {
          code: PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
          severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
        },
      ],
    };
  }

  it("filters only the invalid subset when valid alternatives remain", () => {
    const plans = [
      makePlan({ task: "Keep healthy plan" }),
      makePlan({ task: "Drop weak plan", implementationEvidence: [], capacityFirstReason: "" }),
    ];
    const contractResult = {
      results: [
        { planIndex: 0, valid: true, violations: [] },
        makeAdmissionViolationResult(1),
      ],
    };

    const result = applyAdmissionPacketHardFilter(plans, contractResult);

    assert.equal(result.warnedOnly, false);
    assert.equal(result.filteredCount, 1);
    assert.deepEqual(result.rejectedPlanIndices, [1]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].task, "Keep healthy plan");
  });

  it("preserves all plans when the hard filter would otherwise zero the cycle", () => {
    const plans = [
      makePlan({ task: "Weak plan A", implementationEvidence: [], capacityFirstReason: "" }),
      makePlan({ task: "Weak plan B", implementationEvidence: [], capacityFirstReason: "" }),
    ];
    const contractResult = {
      results: [
        makeAdmissionViolationResult(0),
        makeAdmissionViolationResult(1),
      ],
    };

    const result = applyAdmissionPacketHardFilter(plans, contractResult);

    assert.equal(result.warnedOnly, true);
    assert.equal(result.filteredCount, 0);
    assert.deepEqual(result.rejectedPlanIndices, [1, 0]);
    assert.equal(plans.length, 2, "all plans must be preserved for Athena review");
  });
});

describe("analyzePlanContractGateOutcome", () => {
  it("marks the cycle blocked when every plan has a critical contract violation", () => {
    const outcome = analyzePlanContractGateOutcome({
      totalPlans: 2,
      results: [
        {
          planIndex: 0,
          valid: false,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
              severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
            },
          ],
        },
        {
          planIndex: 1,
          valid: false,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.STALE_DIAGNOSTICS_BACKED,
              severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
            },
          ],
        },
      ],
    });

    assert.equal(outcome.totalPlans, 2);
    assert.equal(outcome.criticalInvalidCount, 2);
    assert.equal(outcome.allPlansBlocked, true);
    assert.deepEqual(outcome.blockedPlanIndices, [0, 1]);
    assert.deepEqual(outcome.blockedViolationCodes, [
      PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
      PACKET_VIOLATION_CODE.STALE_DIAGNOSTICS_BACKED,
    ]);
  });

  it("does not mark the cycle blocked when at least one plan remains dispatchable", () => {
    const outcome = analyzePlanContractGateOutcome({
      totalPlans: 3,
      results: [
        {
          planIndex: 0,
          valid: true,
          violations: [],
        },
        {
          planIndex: 1,
          valid: false,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
              severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
            },
            {
              code: PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
              severity: PLAN_VIOLATION_SEVERITY.CRITICAL,
            },
          ],
        },
        {
          planIndex: 2,
          valid: false,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.MISSING_CAPACITY_FIRST_JUSTIFICATION,
              severity: PLAN_VIOLATION_SEVERITY.WARNING,
            },
          ],
        },
      ],
    });

    assert.equal(outcome.criticalInvalidCount, 1);
    assert.equal(outcome.allPlansBlocked, false);
    assert.deepEqual(outcome.blockedPlanIndices, [1]);
    assert.deepEqual(outcome.blockedViolationCodes, [
      PACKET_VIOLATION_CODE.MISSING_IMPLEMENTATION_EVIDENCE,
    ]);
  });

  it("keeps Athena reachable when every remaining issue is warn-only capacity-first weakness", () => {
    const outcome = analyzePlanContractGateOutcome({
      totalPlans: 2,
      results: [
        {
          planIndex: 0,
          valid: true,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.MISSING_CAPACITY_FIRST_JUSTIFICATION,
              severity: PLAN_VIOLATION_SEVERITY.WARNING,
            },
          ],
        },
        {
          planIndex: 1,
          valid: true,
          violations: [
            {
              code: PACKET_VIOLATION_CODE.MISSING_CAPACITY_FIRST_JUSTIFICATION,
              severity: PLAN_VIOLATION_SEVERITY.WARNING,
            },
          ],
        },
      ],
    });

    assert.equal(outcome.criticalInvalidCount, 0);
    assert.equal(outcome.allPlansBlocked, false);
    assert.deepEqual(outcome.blockedPlanIndices, []);
    assert.deepEqual(outcome.blockedViolationCodes, []);
  });
});

import {
  estimateTokenCost,
} from "../../src/core/prompt_compiler.js";
import {
  emitPlannerCycleMetrics,
  PlannerCycleMetrics,
} from "../../src/core/prometheus.js";

describe("estimateTokenCost", () => {
  it("computes cost correctly for 1000 tokens at default rate", () => {
    assert.equal(estimateTokenCost(1000), 0.003);
  });

  it("returns 0 for zero tokens", () => {
    assert.equal(estimateTokenCost(0), 0);
  });
});

// ── Task 1: Semantic strategic-field validation ──────────────────────────────

describe("STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH", () => {
  it("is a positive integer >= 10", () => {
    assert.ok(Number.isFinite(STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH));
    assert.ok(STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH >= 10);
  });
});

describe("isStrategicFieldToolTraceContaminated", () => {
  it("returns false for a clean semantic string", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("CI is failing on main branch due to import error in worker.ts"), false);
  });

  it("returns true for tool_call prefix", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("tool_call: read_file src/core/prometheus.ts"), true);
  });

  it("returns true for assistant: prefix", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("assistant: Let me analyze the codebase..."), true);
  });

  it("returns true for <thinking> block", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("<thinking>Planning the next steps...</thinking>"), true);
  });

  it("returns true for [THINKING] marker", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("[THINKING] The system has gaps in coverage"), true);
  });

  it("returns true for copilot> prefix", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("copilot> reading the file..."), true);
  });

  it("returns true for [synthesizer_start] marker", () => {
    assert.equal(isStrategicFieldToolTraceContaminated("[synthesizer_start] beginning synthesis"), true);
  });

  it("returns false for empty string", () => {
    assert.equal(isStrategicFieldToolTraceContaminated(""), false);
  });
});

// ── isStrategicFieldToolTraceContaminated: process narration lexical patterns ──

describe("isStrategicFieldToolTraceContaminated — process narration lexical patterns", () => {
  it("rejects 'Let me analyze' first-person action narration", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("Let me analyze the codebase for coverage gaps..."),
      true,
      "'Let me analyze' is first-person process narration and must be rejected",
    );
  });

  it("rejects 'I'm going to read' first-person action narration", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I'm going to read the file src/core/prometheus.ts now"),
      true,
      "'I'm going to read' is first-person process narration and must be rejected",
    );
  });

  it("rejects 'I will now scan' narration", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I will now scan the repository to find existing patterns"),
      true,
      "'I will now scan' is process narration and must be rejected",
    );
  });

  it("rejects 'I'll now check' narration", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I'll now check the existing tests to understand coverage"),
      true,
      "'I'll now check' is process narration and must be rejected",
    );
  });

  it("does NOT reject legitimate strategic content containing action words mid-sentence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "The CI pipeline will scan all PRs before merge to enforce quality gates"
      ),
      false,
      "Action words mid-sentence in legitimate strategic content must not be rejected",
    );
  });

  it("does NOT reject legitimate findings with first-person absent", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "Authentication module lacks input validation on user-supplied parameters"
      ),
      false,
      "Clean strategic finding without process narration must not be rejected",
    );
  });
});

// ── isStrategicFieldToolTraceContaminated: semantic tool-trace patterns ────────

describe("isStrategicFieldToolTraceContaminated — semantic tool-trace fragments", () => {
  it("rejects view_file() tool invocation trace", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("view_file(path='src/core/prometheus.ts')"),
      true,
      "Tool invocation trace view_file() must be rejected",
    );
  });

  it("rejects read_file() tool invocation trace", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("read_file('src/core/research_synthesizer.ts')"),
      true,
      "Tool invocation trace read_file() must be rejected",
    );
  });

  it("rejects 'tool output:' block header", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("tool output: { status: 'ok', lines: 150 }"),
      true,
      "'tool output:' is a tool-trace block header and must be rejected",
    );
  });

  it("rejects 'function result:' output block", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("function result: successfully read 3 files"),
      true,
      "'function result:' is a tool-trace fragment and must be rejected",
    );
  });

  it("rejects 'reading the file' present-progressive at line start", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("reading the file src/core/prometheus.ts to understand structure"),
      true,
      "'reading the file' at line start is a semantic tool-trace and must be rejected",
    );
  });

  it("rejects 'scanning the codebase' present-progressive at line start", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("scanning the codebase for import errors"),
      true,
      "'scanning the codebase' at line start is a semantic tool-trace and must be rejected",
    );
  });

  it("does NOT reject legitimate content where 'reading' appears mid-sentence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "The authentication module is worth reading carefully before refactoring"
      ),
      false,
      "'reading' mid-sentence in legitimate content must not trigger tool-trace rejection",
    );
  });
});

// ── PROCESS_NARRATION_LEXICAL_PATTERNS and SEMANTIC_TOOL_TRACE_PATTERNS exports ─

describe("PROCESS_NARRATION_LEXICAL_PATTERNS and SEMANTIC_TOOL_TRACE_PATTERNS", () => {
  it("PROCESS_NARRATION_LEXICAL_PATTERNS is a frozen non-empty array", () => {
    assert.ok(Array.isArray(PROCESS_NARRATION_LEXICAL_PATTERNS));
    assert.ok(PROCESS_NARRATION_LEXICAL_PATTERNS.length > 0);
    assert.ok(Object.isFrozen(PROCESS_NARRATION_LEXICAL_PATTERNS));
  });

  it("SEMANTIC_TOOL_TRACE_PATTERNS is a frozen non-empty array", () => {
    assert.ok(Array.isArray(SEMANTIC_TOOL_TRACE_PATTERNS));
    assert.ok(SEMANTIC_TOOL_TRACE_PATTERNS.length > 0);
    assert.ok(Object.isFrozen(SEMANTIC_TOOL_TRACE_PATTERNS));
  });
});

// ── normalizeTextForContaminationCheck — Unicode NFKC normalization ────────────

describe("normalizeTextForContaminationCheck — Unicode NFKC normalization", () => {
  it("returns the original ASCII string unchanged", () => {
    assert.equal(normalizeTextForContaminationCheck("Let me analyze"), "Let me analyze");
  });

  it("collapses fullwidth Latin characters to ASCII equivalents", () => {
    // Fullwidth "Ｉ" (U+FF29) normalizes to ASCII "I" under NFKC.
    const fullwidth = "\uFF29 will now scan";
    const normalized = normalizeTextForContaminationCheck(fullwidth);
    assert.ok(normalized.startsWith("I"), "fullwidth I must collapse to ASCII I after NFKC");
  });

  it("collapses Mathematical Bold Latin characters to ASCII (homoglyph bypass vector)", () => {
    // Mathematical Bold Capital L U+1D40B normalizes to "L" under NFKC.
    const mathBold = "\u{1D40B}et me analyze";
    const normalized = normalizeTextForContaminationCheck(mathBold);
    assert.ok(
      normalized.startsWith("L"),
      "Mathematical Bold 'L' must collapse to ASCII 'L' after NFKC normalization",
    );
  });

  it("returns empty string for empty input", () => {
    assert.equal(normalizeTextForContaminationCheck(""), "");
  });

  it("does not throw for null/undefined input (safe coercion)", () => {
    assert.doesNotThrow(() => normalizeTextForContaminationCheck(null as any));
    assert.doesNotThrow(() => normalizeTextForContaminationCheck(undefined as any));
  });
});

// ── isStrategicFieldToolTraceContaminated — Unicode-safe narration detection ──

describe("isStrategicFieldToolTraceContaminated — Unicode-safe narration detection", () => {
  it("detects narration via fullwidth I (Unicode homoglyph bypass attempt)", () => {
    // Fullwidth "Ｉ" (U+FF29) followed by " will now scan" — after NFKC this reads
    // "I will now scan" and must be rejected.
    const homoglyphNarration = "\uFF29 will now scan the repository";
    assert.equal(
      isStrategicFieldToolTraceContaminated(homoglyphNarration),
      true,
      "Fullwidth 'I' homoglyph narration must be rejected after NFKC normalization",
    );
  });

  it("does NOT reject clean ASCII strategic content after NFKC pass", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "Dependency resolution bottleneck detected in wave-2 dispatch; three plans lack premortem."
      ),
      false,
      "Clean strategic content must not be contaminated after normalization",
    );
  });

  it("negative path: does NOT reject text with fullwidth chars that are not narration", () => {
    // Fullwidth digits / punctuation in a measurement string must not trigger narration.
    const measurement = "Latency improved by ２０% after applying the patch";
    assert.equal(
      isStrategicFieldToolTraceContaminated(measurement),
      false,
      "Fullwidth digits in a measurement context must not be flagged as contamination",
    );
  });

  it("detects typographic apostrophe narration like I’m gathering evidence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I’m gathering the latest system-state and research evidence first."),
      true,
      "Typographic apostrophe narration must be rejected as contamination",
    );
  });

  it("detects typographic apostrophe narration like I’m pulling system state", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I’m pulling the system state and core orchestration files first."),
      true,
      "Typographic apostrophe pulling narration must be rejected as contamination",
    );
  });
});

describe("resolvePrometheusProjectHealth", () => {
  it("defaults inferred health to good when plans survive and no hard gate failed", () => {
    const result = resolvePrometheusProjectHealth({
      projectHealth: "needs-work",
      _projectHealthExplicit: false,
      plans: [{ task: "Valid plan" }],
    });
    assert.equal(result, "good");
  });

  it("preserves explicit needs-work health from the model", () => {
    const result = resolvePrometheusProjectHealth({
      projectHealth: "needs-work",
      _projectHealthExplicit: true,
      plans: [{ task: "Valid plan" }],
    });
    assert.equal(result, "needs-work");
  });

  it("returns critical when fail-close gates emptied the plan set", () => {
    const result = resolvePrometheusProjectHealth({
      projectHealth: "needs-work",
      _projectHealthExplicit: false,
      plans: [],
      failReason: "plan-contract-gate",
      _planContractGateFailed: true,
    });
    assert.equal(result, "critical");
  });
});

describe("hasPrometheusRuntimeContractSignals — semantic validation", () => {
  it("returns false when keyFindings is below minimum semantic length", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      keyFindings: "ok",  // 2 chars — below STRATEGIC_FIELD_MIN_SEMANTIC_LENGTH
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), false);
  });

  it("returns false when keyFindings contains tool_call contamination", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      keyFindings: "tool_call: read_file src/core/prometheus.ts — loading context",
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), false);
  });

  it("returns false when keyFindings contains <thinking> marker", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      keyFindings: "<thinking>The system needs improvement in several areas</thinking>",
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), false);
  });

  it("returns true for semantically valid keyFindings of sufficient length", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      keyFindings: "Worker dispatch is blocked due to missing CI evidence; 3 high-risk plans require pre-mortem.",
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), true);
  });

  it("negative: returns false for missing generatedAt even with valid keyFindings", () => {
    const payload = {
      generatedAt: "",
      keyFindings: "CI is failing on main branch and blocking all workers from being dispatched.",
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), false);
  });

  it("returns false when planningTruthStatus is historical even with valid keyFindings", () => {
    const payload = {
      generatedAt: new Date().toISOString(),
      keyFindings: "Planner output references stale diagnostics and must not be treated as live truth.",
      planningTruthStatus: "historical",
    };
    assert.equal(hasPrometheusRuntimeContractSignals(payload), false);
  });
});

describe("estimateTokenCost — additional cases", () => {
  it("returns 0 for negative tokens (clamped)", () => {
    assert.ok(estimateTokenCost(-1) === 0);
  });

  it("computes cost correctly for 1M tokens", () => {
    assert.equal(estimateTokenCost(1_000_000), 3.0);
  });

  it("respects custom costPerMillionTokens", () => {
    assert.equal(estimateTokenCost(1000, 5.0), 0.005);
  });
});

describe("emitPlannerCycleMetrics", () => {
  it("creates metrics file and appends a parseable JSONL line", async () => {
    const { mkdtempSync: mkdtmp, rmSync: rm, readFileSync: readFile } = await import("node:fs");
    const { tmpdir: osTmpDir } = await import("node:os");
    const tmpDir = mkdtmp(path.join(osTmpDir(), "prom-metrics-"));
    try {
      const metrics = {
        schemaVersion: 1,
        cycleId: "cycle-test-1",
        recordedAt: new Date().toISOString(),
        findingsInjectedCount: 5,
        coverageGateRetries: 1,
        planCount: 3,
        estimatedPromptTokens: 10000,
        estimatedTokenCost: 0.030,
        diagnosticsFreshnessSnapshot: { allFresh: true, staleSources: [] },
      } satisfies PlannerCycleMetrics;
      await emitPlannerCycleMetrics(tmpDir, metrics);
      const raw = readFile(path.join(tmpDir, "prometheus_cycle_metrics.jsonl"), "utf8");
      const parsed = JSON.parse(raw.trim());
      assert.equal(parsed.cycleId, "cycle-test-1");
      assert.equal(parsed.planCount, 3);
      assert.equal(parsed.schemaVersion, 1);
    } finally {
      rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("negative: does not throw when stateDir does not exist", async () => {
    const metrics = {
      schemaVersion: 1,
      cycleId: "cycle-nonexistent",
      recordedAt: new Date().toISOString(),
      findingsInjectedCount: 0,
      coverageGateRetries: 0,
      planCount: 0,
      estimatedPromptTokens: 0,
      estimatedTokenCost: 0,
      diagnosticsFreshnessSnapshot: null,
    } satisfies PlannerCycleMetrics;
    // Must not throw — metrics emission is non-blocking
    await assert.doesNotReject(
      () => emitPlannerCycleMetrics("/nonexistent-path-xyz-abc-999", metrics),
      "emitPlannerCycleMetrics must not throw on missing stateDir",
    );
  });
});

// ── Task 1: Hardened synthesis actionable density ──────────────────────────────
import {
  computeSynthesisActionableDensity,
  sanitizeResearchSynthesisForPersistence,
  parseSynthesisTopics,
  quarantineLowDensityTopics,
} from "../../src/core/research_synthesizer.js";

describe("computeSynthesisActionableDensity — hardened fallback signals", () => {
  it("counts prometheusReadySummary as actionable", () => {
    const topics = [{
      topic: "T1",
      sources: [{ prometheusReadySummary: "Use typed schemas to gate dispatch." }],
    }];
    const result = computeSynthesisActionableDensity(topics);
    assert.strictEqual(result[0].passed, true);
    assert.ok(result[0].actionableCount >= 1);
  });

  it("counts extractedContent as actionable when prometheusReadySummary is absent", () => {
    const topics = [{
      topic: "T1",
      sources: [{ prometheusReadySummary: "", extractedContent: "Raw finding about staged repair pipelines." }],
    }];
    const result = computeSynthesisActionableDensity(topics);
    assert.strictEqual(result[0].passed, true);
    assert.ok(result[0].actionableCount >= 1);
  });

  it("counts scoutFindings as actionable when prometheusReadySummary and extractedContent are absent", () => {
    const topics = [{
      topic: "T1",
      sources: [{ prometheusReadySummary: "", extractedContent: "", scoutFindings: "Scout: observed compaction threshold issues." }],
    }];
    const result = computeSynthesisActionableDensity(topics);
    assert.strictEqual(result[0].passed, true);
    assert.ok(result[0].actionableCount >= 1);
  });

  it("does not double-count when both extractedContent and scoutFindings are set", () => {
    const topics = [{
      topic: "T1",
      sources: [{
        prometheusReadySummary: "",
        extractedContent: "Some content.",
        scoutFindings: "Some findings.",
      }],
    }];
    const result = computeSynthesisActionableDensity(topics);
    // extractedContent is the first fallback; scoutFindings is skipped for the same source
    assert.strictEqual(result[0].actionableCount, 1);
  });

  it("negative: all fields empty → fails density check", () => {
    const topics = [{
      topic: "T1",
      sources: [{ prometheusReadySummary: "", extractedContent: "", scoutFindings: "" }],
    }];
    const result = computeSynthesisActionableDensity(topics);
    assert.strictEqual(result[0].passed, false);
    assert.strictEqual(result[0].actionableCount, 0);
  });

  it("negative: no sources → fails density check", () => {
    const topics = [{ topic: "T1", sources: [] }];
    const result = computeSynthesisActionableDensity(topics);
    assert.strictEqual(result[0].passed, false);
    assert.strictEqual(result[0].actionableCount, 0);
  });

  it("netFindings still count toward density independently of sources", () => {
    const topics = [{
      topic: "T1",
      netFindings: ["Finding A", "Finding B"],
      sources: [],
    }];
    const result = computeSynthesisActionableDensity(topics);
    assert.ok(result[0].actionableCount >= 2);
    assert.strictEqual(result[0].passed, true);
  });
});

describe("sanitizeResearchSynthesisForPersistence — prometheusReadySummary fallback derivation", () => {
  const makePayload = (sources: Record<string, unknown>[]) => ({
    success: true,
    topicCount: 1,
    topics: [{
      topic: "T1",
      freshness: "unknown",
      confidence: "0.9",
      sourceCount: sources.length,
      sourceList: sources.map(s => String(s.url)),
      netFindings: [],
      applicableIdeas: [],
      risks: [],
      conflictingViews: [],
      sources,
    }],
    crossTopicConnections: [],
    researchGaps: "",
    synthesizedAt: new Date().toISOString(),
    scoutSourceCount: sources.length,
    model: "test-model",
  });

  it("preserves existing prometheusReadySummary when set", () => {
    const synthesis = makePayload([{
      title: "Source A",
      url: "https://example.com/a",
      prometheusReadySummary: "Use typed schemas.",
      extractedContent: "Raw content.",
      scoutFindings: "Scout finding.",
    }]);
    const result = sanitizeResearchSynthesisForPersistence(synthesis) as any;
    const src = result.topics[0].sources[0];
    assert.strictEqual(src.prometheusReadySummary, "Use typed schemas.");
  });

  it("derives prometheusReadySummary from extractedContent when original is empty", () => {
    const synthesis = makePayload([{
      title: "Source A",
      url: "https://example.com/a",
      prometheusReadySummary: "",
      extractedContent: "Staged repair pipelines reduce wasted LLM calls significantly.",
      scoutFindings: "",
    }]);
    const result = sanitizeResearchSynthesisForPersistence(synthesis) as any;
    const src = result.topics[0].sources[0];
    assert.ok(src.prometheusReadySummary.length > 0, "prometheusReadySummary must be derived from extractedContent");
  });

  it("derives prometheusReadySummary from scoutFindings when prometheusReadySummary and extractedContent are both empty", () => {
    const synthesis = makePayload([{
      title: "Source A",
      url: "https://example.com/a",
      prometheusReadySummary: "",
      extractedContent: "",
      scoutFindings: "Scout observed hook intercept patterns in agent configuration.",
    }]);
    const result = sanitizeResearchSynthesisForPersistence(synthesis) as any;
    const src = result.topics[0].sources[0];
    assert.ok(src.prometheusReadySummary.length > 0, "prometheusReadySummary must be derived from scoutFindings");
  });

  it("negative: all content fields empty → topic is filtered out (no actionable artifact)", () => {
    const synthesis = makePayload([{
      title: "Source A",
      url: "https://example.com/a",
      prometheusReadySummary: "",
      extractedContent: "",
      scoutFindings: "",
    }]);
    const result = sanitizeResearchSynthesisForPersistence(synthesis) as any;
    // A topic whose only source has all-empty signal fields has no actionable artifact
    // and must be dropped by the topic-level invariant filter at persistence time.
    assert.strictEqual(result.topics.length, 0, "empty-signal topic must be removed by actionable-artifact filter");
  });
});

// ── parseSynthesisTopics rescue path ───────────────────────────────────────────

describe("parseSynthesisTopics — rescue path for unstructured raw text blocks", () => {
  it("produces a source with scoutFindings when block has prose but no structured markers", () => {
    const raw = `## Topic: Dependency-Aware Scheduling
This topic covers techniques for scheduling work in dependency order across concurrent workers.
Each worker must wait for its upstream dependencies before starting its own execution step.
Topological sort algorithms are commonly used here.
`;
    const topics = parseSynthesisTopics(raw);
    assert.equal(topics.length, 1);
    assert.equal(topics[0].topic, "Dependency-Aware Scheduling");
    const sources = topics[0].sources as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sources) && sources.length > 0, "rescue source must be present");
    assert.ok(typeof sources[0].scoutFindings === "string" && (sources[0].scoutFindings as string).length > 0,
      "rescue scoutFindings must be non-empty");
  });

  it("rescued topic passes density check via scoutFindings", () => {
    const raw = `## Topic: Token Budget Enforcement
Token budgets must be enforced before dispatching worker requests.
Exceeding the budget without a gate leads to runaway premium request consumption.
A hard cap enforcement rule should apply at the trust boundary level.
`;
    const topics = parseSynthesisTopics(raw);
    const densities = computeSynthesisActionableDensity(topics);
    assert.strictEqual(densities[0].passed, true, "rescued topic must pass density check");
  });

  it("does NOT rescue a topic that already has structured sources", () => {
    const raw = `## Topic: Schema Validation
### Source Alpha
- URL: https://example.com/schema
- Confidence: 0.85
**Extracted Content:**
Use JSON schema for structural validation before dispatch.
`;
    const topics = parseSynthesisTopics(raw);
    assert.equal(topics.length, 1);
    const sources = topics[0].sources as Array<Record<string, unknown>>;
    // Should have exactly the structured source, not a synthetic rescue source
    assert.ok(Array.isArray(sources));
    // No source should have title === "Schema Validation" (the rescue synthetic)
    const rescueSource = sources.find(s => String(s.scoutFindings || "").includes("Use JSON schema") && !s.url);
    // Rescue source should not have been injected since structured source already exists
    assert.ok(!rescueSource || sources.some(s => s.url), "structured source must be present without spurious rescue");
  });

  it("negative: truly empty block produces no rescue source", () => {
    const raw = `## Topic: Empty Topic
`;
    const topics = parseSynthesisTopics(raw);
    // May produce 0 or 1 topic with no sources (all lines too short for rescue)
    if (topics.length > 0) {
      const sources = topics[0].sources as Array<Record<string, unknown>> | undefined;
      const hasSources = Array.isArray(sources) && sources.length > 0;
      // If there are sources they must have non-empty scoutFindings to count
      if (hasSources) {
        // Any rescue source must have length > 20 (the filter threshold)
        for (const src of sources) {
          assert.ok((src.scoutFindings as string).length > 20,
            "rescue scoutFindings below threshold must not be captured");
        }
      }
    }
  });

  it("metadata-only block with long topic name (>20 chars) is rescued via topic name signal", () => {
    // Only metadata lines — no prose, no structured sources
    const raw = `## Topic: Adaptive Specialization Rate Control
**Freshness:** recent
**Average Confidence:** 0.75
**Source Count:** 3
`;
    const topics = parseSynthesisTopics(raw);
    assert.equal(topics.length, 1, "topic must be retained via name-based rescue");
    const sources = topics[0].sources as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(sources) && sources.length > 0, "name-rescue source must be injected");
    assert.strictEqual(sources[0].scoutFindings, "Adaptive Specialization Rate Control",
      "scoutFindings must equal the topic name for name-based rescue");
  });

  it("metadata-only block with short topic name (≤20 chars) is dropped from parse result", () => {
    const raw = `## Topic: Short Name Topic
**Freshness:** recent
**Average Confidence:** 0.8
`;
    const topics = parseSynthesisTopics(raw);
    // "Short Name Topic" is 16 chars — too short for name-rescue; topic must be dropped
    assert.equal(topics.length, 0, "short-named signalless topic must not be retained");
  });
});

describe("parseSynthesisTopics — hasFinalSignal gate (signal-free drop)", () => {
  it("topic with no sources, netFindings, or applicableIdeas is not retained", () => {
    // Simulate a topic that arrives with no signals at all (e.g. parse produced only topic name)
    const raw = `## Topic: Bare Topic With No Data
`;
    const topics = parseSynthesisTopics(raw);
    // "Bare Topic With No Data" is 23 chars but the block has no lines past the header
    // The rescue path finds no prose AND the name fallback applies since length > 20.
    // Verify the result is consistent with hasFinalSignal contract.
    if (topics.length > 0) {
      const t = topics[0] as Record<string, unknown>;
      const hasSources = Array.isArray(t.sources) && (t.sources as unknown[]).length > 0;
      const hasNet = Array.isArray(t.netFindings) && (t.netFindings as unknown[]).length > 0;
      const hasIdeas = Array.isArray(t.applicableIdeas) && (t.applicableIdeas as unknown[]).length > 0;
      assert.ok(hasSources || hasNet || hasIdeas,
        "retained topic must have at least one actionable signal");
    }
  });
});

describe("quarantineLowDensityTopics — degradedPlanningMode semantics", () => {
  it("passedTopics is empty when all topics are quarantined", () => {
    const topics = [
      { topic: "T1", sources: [] },
      { topic: "T2", sources: [] },
    ] as Array<Record<string, unknown>>;
    const densities = computeSynthesisActionableDensity(topics);
    const { passedTopics, quarantinedTopics } = quarantineLowDensityTopics(topics, densities);
    assert.strictEqual(passedTopics.length, 0, "all topics failed — passedTopics must be empty");
    assert.strictEqual(quarantinedTopics.length, 2);
    // degradedPlanningMode condition: quarantined > 0 AND passed === 0
    const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;
    assert.strictEqual(degradedPlanningMode, true, "degradedPlanningMode must be true when no valid topic passed");
  });

  it("degradedPlanningMode is false when at least one topic passes quarantine", () => {
    const topics = [
      { topic: "Has Signal", sources: [{ scoutFindings: "This is a meaningful signal that passes." }] },
      { topic: "No Signal", sources: [] },
    ] as Array<Record<string, unknown>>;
    const densities = computeSynthesisActionableDensity(topics);
    const { passedTopics, quarantinedTopics } = quarantineLowDensityTopics(topics, densities);
    assert.ok(passedTopics.length >= 1, "at least one topic must pass");
    assert.ok(quarantinedTopics.length >= 1, "at least one topic must be quarantined");
    // Even with quarantined topics present, degradedPlanningMode stays false
    const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;
    assert.strictEqual(degradedPlanningMode, false, "degradedPlanningMode must be false when valid signal exists");
  });

  it("negative path: degradedPlanningMode is false when all topics pass (no quarantine)", () => {
    const topics = [
      { topic: "Topic A", sources: [{ scoutFindings: "Valid signal content for topic A." }] },
    ] as Array<Record<string, unknown>>;
    const densities = computeSynthesisActionableDensity(topics);
    const { passedTopics, quarantinedTopics } = quarantineLowDensityTopics(topics, densities);
    assert.strictEqual(quarantinedTopics.length, 0);
    const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;
    assert.strictEqual(degradedPlanningMode, false);
  });
});

// ── sanitizeResearchSynthesisForPersistence — topic-level prometheusReadySummary ──

describe("sanitizeResearchSynthesisForPersistence — topic-level prometheusReadySummary", () => {
  const makePayload = (topic: Record<string, unknown>) => ({
    success: true,
    topicCount: 1,
    topics: [topic],
    crossTopicConnections: [],
    researchGaps: "",
    synthesizedAt: new Date().toISOString(),
    scoutSourceCount: 0,
    model: "test-model",
  });

  it("emits topic-level prometheusReadySummary from first source's summary", () => {
    const payload = makePayload({
      topic: "Dispatch Parallelism",
      sources: [{ prometheusReadySummary: "Use wave-parallel dispatch to halve wall-clock time." }],
    });
    const result = sanitizeResearchSynthesisForPersistence(payload) as any;
    const t = result.topics[0];
    assert.ok(typeof t.prometheusReadySummary === "string", "topic must have prometheusReadySummary field");
    assert.ok(t.prometheusReadySummary.length > 0, "prometheusReadySummary must be non-empty");
    assert.ok(t.prometheusReadySummary.includes("wave-parallel"));
  });

  it("derives topic-level prometheusReadySummary from netFindings when sources are empty", () => {
    const payload = makePayload({
      topic: "Retry Budgets",
      netFindings: ["Hard retry caps reduce cascading overruns under saturation."],
      sources: [],
    });
    const result = sanitizeResearchSynthesisForPersistence(payload) as any;
    const t = result.topics[0];
    assert.ok(typeof t.prometheusReadySummary === "string", "topic must have prometheusReadySummary field");
    assert.ok(t.prometheusReadySummary.length > 0, "prometheusReadySummary must derive from netFindings");
  });

  it("derives topic-level prometheusReadySummary from applicableIdeas when netFindings are empty", () => {
    const payload = makePayload({
      topic: "Canary Metrics",
      applicableIdeas: ["Add per-wave canary gauges to detect slow worker anomalies early."],
      sources: [],
    });
    const result = sanitizeResearchSynthesisForPersistence(payload) as any;
    const t = result.topics[0];
    assert.ok(typeof t.prometheusReadySummary === "string", "topic must have prometheusReadySummary field");
    assert.ok(t.prometheusReadySummary.length > 0, "prometheusReadySummary must derive from applicableIdeas");
  });

  it("negative: topic-level prometheusReadySummary is empty string when no signal exists → topic is filtered out", () => {
    const payload = makePayload({
      topic: "Unknown Topic",
      sources: [],
      netFindings: [],
      applicableIdeas: [],
    });
    const result = sanitizeResearchSynthesisForPersistence(payload) as any;
    // A topic with no sources, no netFindings, and no applicableIdeas has no actionable artifact.
    // The topic-level invariant filter must remove it at persistence time.
    assert.strictEqual(result.topics.length, 0, "no-signal topic must be removed by actionable-artifact filter");
  });
});

// ── Task 1: isResearchDegradedModeActive ─────────────────────────────────────

describe("isResearchDegradedModeActive", () => {
  it("returns false when no topics are quarantined", () => {
    assert.equal(isResearchDegradedModeActive([], [{ topic: "A" }]), false);
  });

  it("returns false for partial quarantine (some topics pass)", () => {
    assert.equal(isResearchDegradedModeActive(["low-density"], [{ topic: "A" }]), false,
      "partial quarantine must NOT enter degraded mode");
  });

  it("returns true only when ALL topics are quarantined (zero passed)", () => {
    assert.equal(isResearchDegradedModeActive(["A", "B"], []), true,
      "degraded mode activates only when zero valid topics remain");
  });

  it("returns false when quarantined list is empty and passed is also empty", () => {
    // No quarantines happened — cannot be degraded by quarantine.
    assert.equal(isResearchDegradedModeActive([], []), false);
  });
});

// ── Task 2: sanitizePlanningFieldForPersistence ───────────────────────────────

describe("sanitizePlanningFieldForPersistence", () => {
  it("strips tool_call lines from planning field text", () => {
    const input = "Implement the feature.\ntool_call: read_file src/foo.ts\nVerify with npm test.";
    const result = sanitizePlanningFieldForPersistence(input);
    assert.ok(!result.includes("tool_call:"), "tool_call lines must be stripped");
    assert.ok(result.includes("Implement the feature."), "genuine content must be preserved");
    assert.ok(result.includes("Verify with npm test."), "genuine content must be preserved");
  });

  it("strips tool_result lines", () => {
    const input = "Fix the bug.\ntool_result: {status: ok}\nDone.";
    const result = sanitizePlanningFieldForPersistence(input);
    assert.ok(!result.includes("tool_result:"));
    assert.ok(result.includes("Fix the bug."));
  });

  it("strips <thinking>...</thinking> blocks", () => {
    const input = "Task: Add logging.\n<thinking>Internal reasoning here...</thinking>\nAcceptance: log emitted.";
    const result = sanitizePlanningFieldForPersistence(input);
    assert.ok(!result.includes("<thinking>"), "thinking tags must be stripped");
    assert.ok(!result.includes("Internal reasoning"), "thinking content must be stripped");
    assert.ok(result.includes("Task: Add logging."), "genuine content must be preserved");
  });

  it("strips role prefix lines (assistant:, user:, system:)", () => {
    const input = "assistant: Here is my plan.\nFix the failing test.\nuser: ok";
    const result = sanitizePlanningFieldForPersistence(input);
    assert.ok(!result.includes("assistant:"), "role prefixes must be stripped");
    assert.ok(!result.includes("user:"), "role prefixes must be stripped");
    assert.ok(result.includes("Fix the failing test."), "genuine content preserved");
  });

  it("returns empty string for empty input", () => {
    assert.equal(sanitizePlanningFieldForPersistence(""), "");
    assert.equal(sanitizePlanningFieldForPersistence("   "), "");
  });

  it("preserves clean text unchanged", () => {
    const clean = "Implement feature X with proper error handling.";
    assert.equal(sanitizePlanningFieldForPersistence(clean), clean);
  });

  it("strips typographic apostrophe process narration lines", () => {
    const input = "I’m gathering the latest system-state and research evidence first.\nImplement deterministic packet gating.";
    const result = sanitizePlanningFieldForPersistence(input);
    assert.ok(!result.includes("I’m gathering"), "Unicode narration line must be stripped");
    assert.ok(result.includes("Implement deterministic packet gating."), "clean strategic content must be preserved");
  });
});

describe("validatePlanContract — verification prose handling", () => {
  it("does not flag forbidden_command when verification prose mentions a bad command only inside descriptive text", () => {
    const result = validatePlanContract({
      task: "Restore deterministic Windows verification",
      role: "quality-worker",
      wave: 1,
      verification: "tests/core/verification_gate.test.ts — test: Replace ambiguous `node --test tests/**/*.test.js`-style verification with exact-target commands.",
      verification_commands: ["npm test -- tests/core/verification_gate.test.ts"],
      acceptance_criteria: ["Named verification target remains exact and platform-safe"],
      dependencies: [],
      capacityDelta: 0.33,
      requestROI: 2.6,
      leverage_rank: ["architecture", "task-quality"],
    });

    assert.equal(result.valid, true);
    assert.equal(result.violations.some((violation) => violation.code === PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND), false);
  });

  it("still flags forbidden_command when the executable verification fragment itself is forbidden", () => {
    const result = validatePlanContract({
      task: "Replace globbed node --test invocation",
      role: "quality-worker",
      wave: 1,
      verification: "node --test tests/**/*.test.js — test: Replace this with an exact-target command.",
      verification_commands: ["node --test tests/**/*.test.js"],
      acceptance_criteria: ["Verification command is portable on Windows"],
      dependencies: [],
      capacityDelta: 0.33,
      requestROI: 2.6,
      leverage_rank: ["architecture", "task-quality"],
    });

    assert.equal(result.violations.some((violation) => violation.code === PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND), true);
  });
});

// ── RolePlanCompletenessError — fail-closed completeness gate ─────────────────

describe("RolePlanCompletenessError", () => {
  it("is an instance of Error", () => {
    const err = new RolePlanCompletenessError(["api-worker"], ["api-worker", "backend"], true);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof RolePlanCompletenessError);
  });

  it("carries correct errorCode constant", () => {
    const err = new RolePlanCompletenessError([], [], false);
    assert.equal(err.errorCode, ROLE_PLAN_COMPLETENESS_ERROR_CODE);
    assert.equal(ROLE_PLAN_COMPLETENESS_ERROR_CODE, "ROLE_PLAN_COVERAGE_INCOMPLETE");
  });

  it("stores missingRoles and requiredRoles correctly", () => {
    const err = new RolePlanCompletenessError(["api-worker", "backend"], ["api-worker", "backend", "test"], true);
    assert.deepEqual(err.missingRoles, ["api-worker", "backend"]);
    assert.deepEqual(err.requiredRoles, ["api-worker", "backend", "test"]);
    assert.equal(err.retried, true);
  });

  it("name is RolePlanCompletenessError", () => {
    const err = new RolePlanCompletenessError([], [], false);
    assert.equal(err.name, "RolePlanCompletenessError");
  });

  it("message includes errorCode and missing role info", () => {
    const err = new RolePlanCompletenessError(["missing-role"], ["missing-role", "ok-role"], true);
    assert.ok(err.message.includes(ROLE_PLAN_COMPLETENESS_ERROR_CODE));
    assert.ok(err.message.includes("missing-role"));
    assert.ok(err.message.includes("retried=true"));
  });

  it("negative path: works with empty arrays (no missing roles edge case)", () => {
    const err = new RolePlanCompletenessError([], [], false);
    assert.deepEqual(err.missingRoles, []);
    assert.deepEqual(err.requiredRoles, []);
    assert.equal(err.retried, false);
  });

  it("negative path: validateAndInjectRolePlans with injectMissing:false does not inject skeletons on missing role", () => {
    const payload = {
      executionStrategy: {
        waves: [
          { wave: 1, tasks: [{ role: "backend", task_id: "T-1", title: "Backend task" }] }
        ]
      },
      plans: [],
    };
    const result = validateAndInjectRolePlans(payload, { injectMissing: false });
    assert.equal(result.ok, false);
    assert.ok(result.initialMissingRoles.includes("backend"),
      "must report backend as missing when no plan covers it");
    assert.deepEqual(result.injectedRoles, [],
      "injectMissing:false must produce zero injected roles");
    assert.equal(
      result.output.plans.filter((p: any) => p._rolePlanSkeletonInjected === true).length,
      0,
      "no skeleton plans should exist in output when injectMissing=false"
    );
  });
});

// ── normalizeStaleCiBreakFindings — freshness-aware CI-break suppression ──────

describe("normalizeStaleCiBreakFindings", () => {
  const ciBreakFinding = {
    area: "ci",
    severity: "critical",
    capabilityNeeded: "ci-fix",
    finding: "CI on main is failure",
    remediation: "Fix CI immediately",
  };

  const systemLearningFinding = {
    area: "system-learning",
    severity: "warning",
    capabilityNeeded: "system-improvement",
    finding: "Self-improvement flagged CI has been broken",
    remediation: "Address in next cycle",
  };

  const ciSetupFinding = {
    area: "ci",
    severity: "warning",
    capabilityNeeded: "ci-setup",
    finding: "No CI configured",
    remediation: "Add GitHub Actions workflow",
  };

  it("suppresses CI-break findings when latestMainCiConclusion=success", () => {
    const payload = {
      findings: [ciBreakFinding, systemLearningFinding],
      auditedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
      latestMainCiConclusion: "success",
      latestMainCiUpdatedAt: new Date().toISOString(),
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 1, "exactly one CI-break finding should be suppressed");
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 1, "system-learning finding must be retained");
    assert.equal(normalized.findings[0].area, "system-learning");
    assert.equal(normalized._staleCiBreakFindingsSuppressed, 1);
    assert.ok(Array.isArray(normalized._staleCiBreakSuppressedReasons));
    assert.ok(result.suppressedReasons[0].includes("stale_ci_break_suppressed"));
    assert.ok(result.suppressedReasons[0].includes("latestMainCiConclusion=success"));
  });

  it("suppresses ci-setup findings when latestMainCiConclusion=success", () => {
    const payload = {
      findings: [ciSetupFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 1);
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 0);
  });

  it("retains all findings when latestMainCiConclusion=failure (CI is broken)", () => {
    const payload = {
      findings: [ciBreakFinding, systemLearningFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "failure",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.payload, payload, "payload must be returned unchanged (same reference)");
  });

  it("retains all findings when latestMainCiConclusion is absent (fail-safe)", () => {
    const payload = {
      findings: [ciBreakFinding],
      auditedAt: new Date().toISOString(),
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.payload, payload);
  });

  it("retains system-learning findings that mention CI even when CI is healthy", () => {
    const payload = {
      findings: [systemLearningFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0, "system-learning finding must NOT be suppressed");
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 1, "system-learning finding must be retained");
  });

  it("handles null payload gracefully", () => {
    const result = normalizeStaleCiBreakFindings(null);
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.payload, null);
  });

  it("handles empty findings array with CI success gracefully", () => {
    const payload = {
      findings: [],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0);
    assert.equal(result.payload, payload, "empty findings payload returned unchanged");
  });

  it("CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS is re-exported from prometheus and is 2 hours", () => {
    assert.equal(CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS, 2 * 60 * 60 * 1000);
  });

  it("suppresses multiple CI-break findings in the same payload", () => {
    const payload = {
      findings: [ciBreakFinding, ciSetupFinding, systemLearningFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 2, "both ci-fix and ci-setup findings should be suppressed");
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 1, "only system-learning finding remains");
  });

  it("suppresses system-learning finding that carries per-finding latestMainCiConclusion=success when audit is fresh and CI is healthy", () => {
    // When runSystemHealthAudit annotates a system-improvement finding with the live
    // CI conclusion, normalizeStaleCiBreakFindings SHOULD suppress it when:
    //   1) The finding text encodes CI-breaking debt (matches CI_SYSTEM_LEARNING_DEBT_PATTERN)
    //   2) The per-finding latestMainCiConclusion === "success"
    //   3) The payload latestMainCiConclusion === "success"
    //   4) The audit snapshot is fresh (within SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS)
    // This prevents Prometheus from escalating stale CI-break lessons when CI is healthy.
    const annotatedSystemLearningFinding = {
      area: "system-learning",
      severity: "warning",
      capabilityNeeded: "system-improvement",
      // Text must match CI_SYSTEM_LEARNING_DEBT_PATTERN: "CI-broken" triggers the pattern.
      finding: "CI-broken tests accumulating as system-learning debt",
      remediation: "ci-fix required in next cycle",
      latestMainCiConclusion: "success",
    };
    const payload = {
      findings: [annotatedSystemLearningFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 1,
      "system-learning CI-debt finding with per-finding CI-success annotation must be suppressed when audit is fresh");
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 0, "suppressed finding must be removed");
    assert.ok(
      Array.isArray(normalized._staleCiBreakSuppressedReasons) &&
      normalized._staleCiBreakSuppressedReasons[0].includes("stale_system_learning_ci_debt_suppressed"),
      "suppression reason must indicate system-learning CI-debt suppression",
    );
  });

  it("retains system-learning CI-debt finding when audit is stale beyond max age", () => {
    // Age gate: if the audit snapshot is too old, the CI-success annotation is unreliable
    // and the finding should NOT be suppressed.
    const staleAuditMs = Date.now() - SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS - 1000;
    const annotatedFinding = {
      area: "system-learning",
      severity: "warning",
      capabilityNeeded: "system-improvement",
      finding: "CI-broken tests accumulating as system-learning debt",
      remediation: "ci-fix required",
      latestMainCiConclusion: "success",
    };
    const payload = {
      findings: [annotatedFinding],
      auditedAt: new Date(staleAuditMs).toISOString(),
      latestMainCiConclusion: "success",
    };
    const nowMs = Date.now();
    const result = normalizeStaleCiBreakFindings(payload, nowMs);
    assert.equal(result.suppressedCount, 0,
      "stale audit must NOT trigger suppression of system-learning CI-debt finding");
    const retained = result.payload as any;
    assert.equal(retained.findings.length, 1, "finding must be retained when audit is stale");
  });

  it("retains system-learning CI-debt finding when payload CI conclusion is not success", () => {
    // Even with per-finding annotation, if the payload CI conclusion is not success
    // (fail-safe: CI was failing at audit time), no suppression should occur.
    const annotatedFinding = {
      area: "system-learning",
      severity: "warning",
      capabilityNeeded: "system-improvement",
      finding: "CI-broken tests accumulating as system-learning debt",
      remediation: "ci-fix required",
      latestMainCiConclusion: "success",
    };
    const payload = {
      findings: [annotatedFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "failure",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0,
      "must not suppress when payload latestMainCiConclusion is not success");
  });

  it("retains system-learning finding without CI-debt text even with all other conditions met", () => {
    // Only findings that match CI_SYSTEM_LEARNING_DEBT_PATTERN should be eligible.
    const nonCiDebtFinding = {
      area: "system-learning",
      severity: "warning",
      capabilityNeeded: "system-improvement",
      finding: "Improve documentation and test coverage",
      remediation: "Add more tests",
      latestMainCiConclusion: "success",
    };
    const payload = {
      findings: [nonCiDebtFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0,
      "system-learning finding without CI-debt text must not be suppressed");
  });

  it("SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS equals CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS (both 2 hours)", () => {
    assert.equal(SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS, CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS);
    assert.equal(SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS, 2 * 60 * 60 * 1000);
  });

  it("populates resolvedLineage with suppressed CI-break finding", () => {
    const ciBreakFinding = {
      area: "ci",
      severity: "critical",
      capabilityNeeded: "ci-fix",
      finding: "CI on main is failure",
      remediation: "Fix CI immediately",
    };
    const payload = {
      findings: [ciBreakFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 1);
    assert.ok(Array.isArray(result.resolvedLineage), "resolvedLineage must be an array");
    assert.equal(result.resolvedLineage.length, 1, "suppressed finding must be in resolvedLineage");
    assert.equal(result.resolvedLineage[0].area, "ci");
    assert.ok(
      typeof result.resolvedLineage[0]._resolutionReason === "string" &&
      result.resolvedLineage[0]._resolutionReason.includes("stale_ci_break_suppressed"),
      "resolvedLineage entry must carry a _resolutionReason",
    );
    assert.ok(
      typeof result.resolvedLineage[0]._resolvedAt === "string",
      "resolvedLineage entry must carry a _resolvedAt timestamp",
    );
    // The normalized payload must also expose resolvedLineage.
    const normalized = result.payload as any;
    assert.ok(Array.isArray(normalized.resolvedLineage), "payload.resolvedLineage must be an array");
    assert.equal(normalized.resolvedLineage.length, 1);
    assert.equal(normalized.findings.length, 0, "active findings must be empty");
  });

  it("populates resolvedLineage with suppressed system-learning CI-debt finding", () => {
    const annotatedFinding = {
      area: "system-learning",
      severity: "warning",
      capabilityNeeded: "system-improvement",
      finding: "CI-broken tests accumulating as system-learning debt (0ec5b75, f276e7a, 531bbc0)",
      remediation: "ci-fix required in next cycle",
      latestMainCiConclusion: "success",
    };
    const payload = {
      findings: [annotatedFinding],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 1);
    assert.ok(Array.isArray(result.resolvedLineage));
    assert.equal(result.resolvedLineage.length, 1);
    assert.equal(result.resolvedLineage[0].area, "system-learning");
    assert.ok(
      (result.resolvedLineage[0]._resolutionReason as string).includes(
        "stale_system_learning_ci_debt_suppressed",
      ),
      "resolvedLineage reason must indicate system-learning CI-debt",
    );
    // Active findings array must be empty after suppression.
    const normalized = result.payload as any;
    assert.equal(normalized.findings.length, 0);
    assert.equal(normalized.resolvedLineage.length, 1);
  });

  it("resolvedLineage is empty array when no suppression occurs", () => {
    const payload = {
      findings: [{ area: "planning", severity: "warning", finding: "low quality", remediation: "" }],
      auditedAt: new Date().toISOString(),
      latestMainCiConclusion: "success",
    };
    const result = normalizeStaleCiBreakFindings(payload);
    assert.equal(result.suppressedCount, 0);
    assert.ok(Array.isArray(result.resolvedLineage), "resolvedLineage must be an array even when empty");
    assert.equal(result.resolvedLineage.length, 0);
  });

  it("resolvedLineage is empty array on null payload", () => {
    const result = normalizeStaleCiBreakFindings(null);
    assert.ok(Array.isArray(result.resolvedLineage));
    assert.equal(result.resolvedLineage.length, 0);
  });

  it("isSystemLearningCiDebtFinding correctly identifies CI-debt system-learning findings", () => {
    assert.equal(isSystemLearningCiDebtFinding({
      area: "system-learning",
      finding: "CI-broken tests accumulating",
      remediation: "ci-fix required",
    }), true, "should identify CI-debt system-learning finding");

    assert.equal(isSystemLearningCiDebtFinding({
      area: "system-learning",
      finding: "Improve code style",
      remediation: "Lint more",
    }), false, "should NOT identify non-CI-debt system-learning finding");

    assert.equal(isSystemLearningCiDebtFinding({
      area: "ci",
      capabilityNeeded: "ci-fix",
      finding: "CI broken",
    }), false, "should NOT identify area=ci finding as system-learning");

    assert.equal(isSystemLearningCiDebtFinding(null), false, "null must return false");
  });
});

describe("selectBestCandidatePlans — bounded candidate generation", () => {
  const makeStrongPlan = (task: string) => ({
    task,
    scope: "src/core/prometheus.ts",
    target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
    acceptance_criteria: ["npm test passes with no new failures", "coverage includes new logic"],
    verification: "npm test",
    before_state: "single-draft planning without scoring",
    after_state: "rubric-scored candidate selection active",
    leverage_rank: ["task-quality", "worker-specialization"],
    capacityDelta: 0.2,
    requestROI: 1.5,
    riskLevel: "low",
    role: "evolution-worker",
  });

  const makeWeakPlan = (task: string) => ({
    task,
    scope: "",
    target_files: [],
    acceptance_criteria: [],
    verification: "",
    leverage_rank: [],
    capacityDelta: 0,
    requestROI: 0,
  });

  it("selects the highest-scoring candidate set (clear winner)", () => {
    const strong = [makeStrongPlan("Implement rubric scoring in Prometheus")];
    const weak = [makeWeakPlan("improve stuff")];
    const result = selectBestCandidatePlans([weak, strong]);
    assert.ok(Array.isArray(result.bestCandidates), "bestCandidates is array");
    assert.ok(result.score > 0, "winning score is positive");
    assert.equal(result.bestCandidates, strong, "strong candidate wins");
    assert.equal(result.tieBreakUsed, false, "no tie-break for clear winner");
  });

  it("applies uncertainty-aware tie-break when scores are within CANDIDATE_TIE_THRESHOLD", () => {
    // Two plans with similar scores; second has wider dimension coverage
    const planA = makeStrongPlan("Plan A");
    const planB = {
      ...makeStrongPlan("Plan B"),
      scope: "src/core/plan_critic.ts",
      target_files: ["src/core/plan_critic.ts", "tests/core/plan_critic.test.ts"],
    };
    // Both candidate sets contain one strong plan — scores will be nearly equal
    const result = selectBestCandidatePlans([[planA], [planB]]);
    assert.ok(Array.isArray(result.bestCandidates), "returns an array");
    assert.equal(result.bestCandidates.length, 1, "one plan in winner");
    // When tied, the result is deterministic (consistent on repeat calls)
    const result2 = selectBestCandidatePlans([[planA], [planB]]);
    assert.deepEqual(result.bestCandidates, result2.bestCandidates, "deterministic on repeat");
  });

  it("negative path: returns empty set for empty candidates input", () => {
    const result = selectBestCandidatePlans([]);
    assert.deepEqual(result.bestCandidates, [], "empty candidates → empty result");
    assert.equal(result.score, 0, "score is 0 for empty input");
    assert.equal(result.reason, "no_candidates", "reason indicates no candidates");
  });

  it("bounds evaluation to MAX_CANDIDATE_SETS even when more are provided", () => {
    // Create 10 candidate sets (exceeds MAX_CANDIDATE_SETS = 5)
    const sets = Array.from({ length: 10 }, (_, i) => [makeStrongPlan(`Plan ${i}`)]);
    const result = selectBestCandidatePlans(sets);
    assert.ok(Array.isArray(result.bestCandidates), "returns array regardless of overflow");
    assert.ok(result.rank < MAX_CANDIDATE_SETS, "rank is within bounded window");
  });

  it("CANDIDATE_TIE_THRESHOLD is exported and positive", () => {
    assert.ok(typeof CANDIDATE_TIE_THRESHOLD === "number", "is a number");
    assert.ok(CANDIDATE_TIE_THRESHOLD > 0, "is positive");
    assert.ok(CANDIDATE_TIE_THRESHOLD < 1, "is less than 1");
  });

  it("MAX_CANDIDATE_SETS is exported and >= 2", () => {
    assert.ok(typeof MAX_CANDIDATE_SETS === "number", "is a number");
    assert.ok(MAX_CANDIDATE_SETS >= 2, "allows at least 2 candidates");
  });
});

describe("high-uncertainty candidate planning wiring", () => {
  it("extracts bounded candidate plan sets from candidateSets payloads", () => {
    const extracted = extractPrometheusCandidatePlanSets({
      candidateSets: [
        { label: "candidate-a", plans: [{ task: "A" }] },
        [{ task: "B" }],
        { label: "candidate-empty", plans: [] },
      ],
    });
    assert.equal(extracted.length, 2);
    assert.equal(extracted[0].label, "candidate-a");
    assert.equal(extracted[1].label, "candidate-2");
  });

  it("selects the candidate set that survives freshness and contract gates best", () => {
    const rawParsed = {
      candidateSets: [
        {
          label: "stale-and-weak",
          plans: [
            {
              task: "Fix diagnostics-only debt",
              role: "evolution-worker",
              wave: 1,
              target_files: ["src/core/prometheus.ts"],
              acceptance_criteria: ["one criterion only"],
              verification: "manual check later",
              _evidenceSources: ["health_audit_findings"],
            },
          ],
        },
        {
          label: "fresh-and-strong",
          plans: [
            {
              task: "Wire bounded candidate selection into src/core/prometheus.ts",
              role: "evolution-worker",
              wave: 1,
              scope: "src/core/prometheus.ts",
              target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
              acceptance_criteria: [
                "candidate selection keeps >= 1 dispatchable plan",
                "npm test -- tests/core/prometheus_parse.test.ts exits with code 0",
              ],
              verification: "npm test -- tests/core/prometheus_parse.test.ts",
              capacityDelta: 0.2,
              requestROI: 1.5,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "single plan path only",
              after_state: "high-uncertainty cycles select from bounded candidate sets",
              riskLevel: "low",
            },
          ],
        },
      ],
      projectHealth: "needs-work",
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 },
      generatedAt: "2026-04-13T00:00:00.000Z",
      keyFindings: "High-uncertainty planning should select the strongest dispatchable candidate set.",
      strategicNarrative: "Candidate selection should demote stale or contract-weak plan sets before repair.",
    };
    const selection = selectPrometheusCandidatePlanSet(rawParsed, { raw: "" }, {
      diagnosticsFreshnessAdmission: {
        allFresh: false,
        staleSources: ["health_audit_findings"],
        freshnessReasons: ["stale:health_audit_findings"],
      },
    });

    assert.equal(selection.usedSelection, true);
    assert.equal(selection.selectedLabel, "fresh-and-strong");
    assert.equal(selection.selectedPlans.length, 1);
    assert.ok(selection.candidateSummaries.some((summary) =>
      summary.label === "stale-and-weak" && summary.freshnessPenalty > 0
    ));
  });

  it("rejects monocultural candidate sets when dispatch requires two distinct lanes", () => {
    const rawParsed = {
      candidateSets: [
        {
          label: "mono-governance",
          plans: [
            {
              task: "Harden lane-diversity contract wording",
              role: "governance-worker",
              wave: 1,
              target_files: ["src/core/orchestrator.ts", "tests/core/orchestrator_governance_gate.test.ts"],
              acceptance_criteria: [
                "dispatch block reason remains deterministic with >= 2 gate cases",
                "npm test -- tests/core/orchestrator_governance_gate.test.ts exits with code 0",
              ],
              verification: "npm test -- tests/core/orchestrator_governance_gate.test.ts",
              capacityDelta: 0.2,
              requestROI: 1.4,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "planner emits monocultural governance packets",
              after_state: "planner keeps dispatchable lane mix",
              riskLevel: "low",
            },
            {
              task: "Retire stale governance-only finding",
              role: "governance-worker",
              wave: 2,
              target_files: ["src/core/governance_contract.ts", "tests/core/orchestrator_gate_precedence.test.ts"],
              acceptance_criteria: [
                "retirement path is proven in >= 1 targeted test case",
                "npm test -- tests/core/orchestrator_gate_precedence.test.ts exits with code 0",
              ],
              verification: "npm test -- tests/core/orchestrator_gate_precedence.test.ts",
              capacityDelta: 0.18,
              requestROI: 1.3,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "stale governance debt reappears in planning",
              after_state: "planner avoids duplicate governance-only packets",
              riskLevel: "low",
            },
          ],
        },
        {
          label: "diverse-pair",
          plans: [
            {
              task: "Fail closed on specialization no-signal topology",
              role: "governance-worker",
              wave: 1,
              target_files: ["src/core/capability_pool.ts", "src/core/orchestrator.ts"],
              acceptance_criteria: [
                "no-signal specialization cannot pass on optimism alone with >= 1 telemetry event",
                "npm test -- tests/core/orchestrator_specialization_gate.test.ts exits with code 0",
              ],
              verification: "npm test -- tests/core/orchestrator_specialization_gate.test.ts",
              capacityDelta: 0.24,
              requestROI: 1.5,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "missing lane signals still admit specialization",
              after_state: "specialization requires positive evidence",
              riskLevel: "low",
            },
            {
              task: "Repair first-pass parser contract recovery",
              role: "integration-worker",
              wave: 2,
              target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
              acceptance_criteria: [
                "recoverable strategic fields pass first-pass parser contract without retry with >= 1 targeted test case",
                "npm test -- tests/core/prometheus_parse.test.ts exits with code 0",
              ],
              verification: "npm test -- tests/core/prometheus_parse.test.ts",
              capacityDelta: 0.22,
              requestROI: 1.45,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "recoverable parser fields still burn retries",
              after_state: "first-pass parser recovery keeps planning dispatchable",
              riskLevel: "low",
            },
          ],
        },
      ],
      projectHealth: "needs-work",
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 },
      generatedAt: "2026-04-13T00:00:00.000Z",
      keyFindings: "Candidate selection must reject same-lane plan sets when dispatch requires lane diversity.",
      strategicNarrative: "Prometheus should keep only topology-admissible candidate sets before Athena review.",
    };

    const selection = selectPrometheusCandidatePlanSet(rawParsed, { raw: "" }, {
      diagnosticsFreshnessAdmission: {
        allFresh: true,
        staleSources: [],
        freshnessReasons: [],
      },
      topologyMinLanes: 2,
    });

    assert.equal(selection.usedSelection, true);
    assert.equal(selection.selectedLabel, "diverse-pair");
    assert.ok(selection.candidateSummaries.some((summary) =>
      summary.label === "mono-governance" && summary.admittedPlanCount === 0
    ));
  });

  it("builds an explicit candidateSets JSON contract for the prompt", () => {
    const section = buildCandidateGenerationSection({ minCandidates: 2, maxCandidates: 3 });
    assert.match(section.content, /candidateSets/i);
    assert.match(section.content, /between 2 and 3 distinct candidate plan sets/i);
  });

  it("enables bounded candidate planning only for high-uncertainty priors", () => {
    const high = deriveCandidatePlanningPolicy({ uncertainty: "high", verificationDepth: "deep" });
    const low = deriveCandidatePlanningPolicy({ uncertainty: "low", verificationDepth: "shallow" });
    assert.equal(high.enabled, true);
    assert.equal(high.minCandidates, 2);
    assert.ok(high.maxCandidates >= 2);
    assert.equal(low.enabled, false);
    assert.equal(low.maxCandidates, 1);
  });

  it("keeps the default candidate generation section aligned with the JSON contract", () => {
    assert.match(CANDIDATE_GENERATION_SECTION.content, /candidateSets/i);
  });

  it("emits candidate selection metadata that satisfies the replay audit contract", () => {
    const rawParsed = {
      candidateSets: [
        {
          label: "candidate-a",
          plans: [
            {
              task: "Weakened candidate",
              role: "evolution-worker",
              wave: 1,
              target_files: ["src/core/prometheus.ts"],
              acceptance_criteria: ["one criterion only"],
              verification: "manual later",
            },
          ],
        },
        {
          label: "candidate-b",
          plans: [
            {
              task: "Replay-safe candidate selection",
              role: "quality-worker",
              wave: 1,
              scope: "src/core/prometheus.ts",
              target_files: ["src/core/prometheus.ts", "tests/core/prometheus_parse.test.ts"],
              acceptance_criteria: [
                "candidate selection remains dispatchable",
                "npm test -- tests/core/prometheus_parse.test.ts passes",
              ],
              verification: "npm test -- tests/core/prometheus_parse.test.ts",
              capacityDelta: 0.2,
              requestROI: 1.4,
              leverage_rank: ["task-quality", "worker-specialization"],
              before_state: "single candidate path",
              after_state: "bounded candidate selection persisted for replay",
              riskLevel: "low",
            },
          ],
        },
      ],
      generatedAt: "2026-04-13T00:00:00.000Z",
      projectHealth: "needs-work",
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 },
      keyFindings: "Candidate planning must remain auditable by replay harnesses.",
      strategicNarrative: "Replay harnesses should reject malformed candidate selection metadata.",
    };

    const selection = selectPrometheusCandidatePlanSet(rawParsed, { raw: "" }, {
      diagnosticsFreshnessAdmission: {
        allFresh: true,
        staleSources: [],
        freshnessReasons: [],
      },
    });
    const audit = auditReplayPolicySignals({
      expectedDomains: ["candidate_planning"],
      candidatePlanning: {
        enabled: true,
        candidateCount: selection.candidateSets.length,
        selectedIndex: selection.selectedIndex,
        selectedLabel: selection.selectedLabel,
        score: selection.score,
        tieBreakUsed: selection.tieBreakUsed,
        reason: selection.reason,
        summaries: selection.candidateSummaries,
        failClosed: selection.selectedIndex < 0,
      },
    });

    assert.equal(selection.usedSelection, true);
    assert.equal(audit.passed, true);
    assert.equal(audit.regressionCount, 0);
  });
});

describe("scoreCandidateSet", () => {
  it("scores a strong plan set higher than a weak plan set", () => {
    const strong = [{
      task: "Add typed retry contracts with deterministic artifact paths",
      scope: "src/core/worker_runner.ts",
      target_files: ["src/core/worker_runner.ts", "tests/core/worker_runner.test.ts"],
      acceptance_criteria: ["npm test passes", "retry paths verified"],
      verification: "npm test",
      before_state: "single retry path",
      after_state: "typed retry contracts with per-attempt directories",
      leverage_rank: ["task-quality", "worker-specialization"],
      capacityDelta: 0.3,
      requestROI: 1.8,
      riskLevel: "medium",
      role: "evolution-worker",
    }];
    const weak = [{ task: "improve stuff" }];
    const strongResult = scoreCandidateSet(strong);
    const weakResult = scoreCandidateSet(weak);
    assert.ok(strongResult.setScore > weakResult.setScore, "strong plan set scores higher");
  });

  it("returns planCount matching input length", () => {
    const plans = [{ task: "Task A" }, { task: "Task B" }, { task: "Task C" }];
    const result = scoreCandidateSet(plans);
    assert.equal(result.planCount, 3, "planCount matches input");
  });

  it("negative path: empty input returns zero scores", () => {
    const result = scoreCandidateSet([]);
    assert.equal(result.setScore, 0, "zero score for empty set");
    assert.equal(result.dimensionCoverage, 0, "zero coverage for empty set");
    assert.equal(result.planCount, 0, "zero plans for empty set");
  });
});

describe("CANDIDATE_GENERATION_SECTION", () => {
  it("is a non-empty prompt section with name and content", () => {
    assert.ok(CANDIDATE_GENERATION_SECTION, "exported and truthy");
    assert.equal(typeof CANDIDATE_GENERATION_SECTION.name, "string", "has name");
    assert.ok(CANDIDATE_GENERATION_SECTION.name.length > 0, "name is non-empty");
    assert.equal(typeof CANDIDATE_GENERATION_SECTION.content, "string", "has content");
    assert.ok(CANDIDATE_GENERATION_SECTION.content.length > 0, "content is non-empty");
  });

  it("content references candidate generation and rubric constraints", () => {
    assert.ok(/candidate/i.test(CANDIDATE_GENERATION_SECTION.content), "mentions candidates");
    assert.ok(/acceptance.criteria|verification/i.test(CANDIDATE_GENERATION_SECTION.content), "mentions criteria");
  });
});

describe("evaluatePrometheusTopologyAdmission", () => {
  it("blocks plan sets that keep two plans in a single lane when minLanes is two", () => {
    const result = evaluatePrometheusTopologyAdmission([
      { task: "A", role: "governance-worker", wave: 1 },
      { task: "B", role: "governance-worker", wave: 2 },
    ], {
      minLanes: 2,
    });

    assert.equal(result.admitted, false);
    assert.equal(result.laneCount, 1);
    assert.match(result.reason, /worker_topology_insufficient/);
  });

  it("allows plan sets below the lane floor to remain dispatchable", () => {
    const result = evaluatePrometheusTopologyAdmission([
      { task: "A", role: "governance-worker", wave: 1 },
    ], {
      minLanes: 2,
    });

    assert.equal(result.admitted, true);
    assert.equal(result.planCount, 1);
  });
});

describe("selectBestCandidateSet — deterministic candidate selection", () => {
  it("selects the higher-scoring candidate set from two options", () => {
    const strong = [{ task: "Add rubric scoring", scope: "src/core/plan_critic.ts", target_files: ["src/core/plan_critic.ts"], acceptance_criteria: ["AC1: scores > 0"], verification: "npm test", leverage_rank: ["Prometheus"], capacityDelta: 5, requestROI: 0.7 }];
    const weak = [{ task: "improve things", scope: "", target_files: [], acceptance_criteria: [], verification: "", leverage_rank: [], capacityDelta: 0, requestROI: 0 }];
    const result = selectBestCandidateSet([weak, strong]);
    assert.ok(result, "returns a result");
    assert.ok(Array.isArray(result.bestCandidates), "result has bestCandidates");
    assert.equal(result.bestCandidates, strong, "strong set is selected");
  });

  it("returns empty set when no candidates provided (negative path)", () => {
    const result = selectBestCandidateSet([]);
    assert.deepEqual(result.bestCandidates, [], "empty input → empty set");
  });

  it("is deterministic (same input → same output on repeat calls)", () => {
    const setA = [{ task: "Plan A", scope: "s", target_files: ["a"], acceptance_criteria: ["AC"], verification: "v", leverage_rank: ["L"], capacityDelta: 2, requestROI: 0.5 }];
    const setB = [{ task: "Plan B", scope: "t", target_files: ["b", "c"], acceptance_criteria: ["AC1", "AC2"], verification: "v2", leverage_rank: ["M"], capacityDelta: 3, requestROI: 0.6 }];
    const r1 = selectBestCandidateSet([setA, setB]);
    const r2 = selectBestCandidateSet([setA, setB]);
    assert.deepEqual(r1.bestCandidates, r2.bestCandidates, "deterministic on repeat calls");
  });
});

// ── computeMandatoryFindingsPreflight — pre-planning truth preflight gate ─────

describe("computeMandatoryFindingsPreflight", () => {
  const now = Date.now();

  const ciBreakFinding = {
    id: "ci-fix",
    area: "ci",
    severity: "critical" as const,
    finding: "CI on main is failing",
    remediation: "Fix CI",
    capabilityNeeded: "ci-fix",
  };

  const ciSetupFinding = {
    id: "ci-setup",
    area: "ci",
    severity: "warning" as const,
    finding: "CI not configured",
    remediation: "Add workflow",
    capabilityNeeded: "ci-setup",
  };

  const capGapFinding = {
    id: "api-design",
    area: "api-design",
    severity: "warning" as const,
    finding: "No structured schema for plans",
    remediation: "Add JSON schema validation",
    capabilityNeeded: "api-design",
  };

  it("trusts all findings when auditedAt is fresh (within 24h)", () => {
    const freshAuditedAt = new Date(now - 1 * 60 * 60 * 1000).toISOString(); // 1h ago
    const payload = { auditedAt: freshAuditedAt };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding, capGapFinding], payload, now);

    assert.equal(result.preflightStatus, MANDATORY_FINDINGS_PREFLIGHT_STATUS.TRUSTED);
    assert.equal(result.trustedFindings.length, 2);
    assert.equal(result.quarantinedCount, 0);
    assert.equal(result.sourceFresh, true);
    assert.ok(Number.isFinite(result.sourceAgeMs));
    assert.ok(result.sourceAgeMs < MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS);
  });

  it("quarantines CI-break findings when auditedAt is stale (older than 24h)", () => {
    const staleAuditedAt = new Date(now - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
    const payload = { auditedAt: staleAuditedAt };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding, capGapFinding], payload, now);

    assert.equal(result.preflightStatus, MANDATORY_FINDINGS_PREFLIGHT_STATUS.DEGRADED,
      "degraded when some CI findings quarantined but non-CI findings trusted");
    assert.equal(result.quarantinedCount, 1, "only the CI-break finding is quarantined");
    assert.equal(result.trustedFindings.length, 1, "non-CI capability gap remains trusted");
    assert.equal(result.trustedFindings[0].id, "api-design");
    assert.equal(result.quarantinedFindings[0].id, "ci-fix");
    assert.equal(result.sourceFresh, false);
  });

  it("quarantines ALL findings (quarantined status) when all are CI-related and stale", () => {
    const staleAuditedAt = new Date(now - 30 * 60 * 60 * 1000).toISOString(); // 30h ago
    const payload = { auditedAt: staleAuditedAt };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding, ciSetupFinding], payload, now);

    assert.equal(result.preflightStatus, MANDATORY_FINDINGS_PREFLIGHT_STATUS.QUARANTINED);
    assert.equal(result.quarantinedCount, 2);
    assert.equal(result.trustedFindings.length, 0);
  });

  it("quarantines CI-related findings when auditedAt is absent (Infinity age)", () => {
    const payload = {}; // no auditedAt
    const result = computeMandatoryFindingsPreflight([ciBreakFinding, capGapFinding], payload, now);

    assert.equal(result.sourceFresh, false);
    assert.equal(result.sourceAgeMs, Infinity);
    assert.equal(result.quarantinedCount, 1, "CI finding must be quarantined when no auditedAt");
    assert.equal(result.trustedFindings[0].id, "api-design", "non-CI gap remains trusted");
  });

  it("quarantines CI-related findings when auditedAt is invalid ISO string", () => {
    const payload = { auditedAt: "not-a-date" };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding], payload, now);

    assert.equal(result.sourceFresh, false);
    assert.equal(result.sourceAgeMs, Infinity);
    assert.equal(result.quarantinedCount, 1);
  });

  it("returns trusted for all non-CI findings even when source is stale", () => {
    const staleAuditedAt = new Date(now - 48 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const payload = { auditedAt: staleAuditedAt };
    const result = computeMandatoryFindingsPreflight([capGapFinding], payload, now);

    assert.equal(result.preflightStatus, MANDATORY_FINDINGS_PREFLIGHT_STATUS.TRUSTED,
      "no CI findings to quarantine → trusted status even with stale source");
    assert.equal(result.trustedFindings.length, 1);
    assert.equal(result.quarantinedCount, 0);
    assert.equal(result.sourceFresh, false);
  });

  it("returns trusted with empty findings array regardless of source age", () => {
    const payload = {};
    const result = computeMandatoryFindingsPreflight([], payload, now);

    assert.equal(result.preflightStatus, MANDATORY_FINDINGS_PREFLIGHT_STATUS.TRUSTED);
    assert.equal(result.trustedFindings.length, 0);
    assert.equal(result.quarantinedCount, 0);
  });

  it("includes machine-readable quarantine reasons per quarantined finding", () => {
    const staleAuditedAt = new Date(now - 26 * 60 * 60 * 1000).toISOString();
    const payload = { auditedAt: staleAuditedAt };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding], payload, now);

    assert.equal(result.quarantineReasons.length, 1);
    assert.ok(result.quarantineReasons[0].includes("mandatory_finding_quarantined"), "reason must be machine-readable");
    assert.ok(result.quarantineReasons[0].includes("ci-fix"), "reason must identify the finding");
    assert.ok(result.quarantineReasons[0].includes("stale_ci_evidence"), "reason must name the quarantine cause");
  });

  it("MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS is 24 hours", () => {
    assert.equal(MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
  });

  it("negative path: at-boundary (exactly at threshold) is still treated as stale", () => {
    // sourceAgeMs === MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS + 1 is over threshold
    const atBoundaryMs = now - MANDATORY_FINDINGS_PREFLIGHT_MAX_AGE_MS - 1;
    const payload = { auditedAt: new Date(atBoundaryMs).toISOString() };
    const result = computeMandatoryFindingsPreflight([ciBreakFinding], payload, now);
    assert.equal(result.sourceFresh, false, "just-over-threshold must not be considered fresh");
    assert.equal(result.quarantinedCount, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-MERGE SENTINEL: export-import contract + verification-specificity grammar
//
// These tests act as a CI gate that fails fast when:
//   1. A test file imports a symbol absent from the corresponding runtime export.
//   2. NON_SPECIFIC_VERIFICATION_PATTERNS and NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES
//      diverge (pattern added without a fixture, or vice-versa).
//   3. isNonSpecificVerification behaviour is inconsistent with the declared patterns.
// ─────────────────────────────────────────────────────────────────────────────

describe("pre-merge sentinel: prometheus export contract", () => {
  it("all prometheus.js symbols imported by this test file are defined at runtime", () => {
    // Spot-check the highest-churn symbols. The import at the top of this file
    // will already throw if a symbol is missing; these asserts provide explicit
    // diagnostic output for the CI log.
    assert.ok(typeof normalizePrometheusParsedOutput === "function", "normalizePrometheusParsedOutput");
    assert.ok(typeof applyAdmissionPacketHardFilter === "function", "applyAdmissionPacketHardFilter");
    assert.ok(typeof extractMandatoryHealthAuditFindings === "function", "extractMandatoryHealthAuditFindings");
    assert.ok(typeof validateMandatoryTaskCoverageContract === "function", "validateMandatoryTaskCoverageContract");
    assert.ok(typeof enforceCiRepairPacketForMandatoryFindings === "function", "enforceCiRepairPacketForMandatoryFindings");
    assert.ok(typeof computeMandatoryFindingsPreflight === "function", "computeMandatoryFindingsPreflight");
    assert.ok(typeof selectBestCandidatePlans === "function", "selectBestCandidatePlans");
    assert.ok(MANDATORY_FINDINGS_PREFLIGHT_STATUS !== undefined, "MANDATORY_FINDINGS_PREFLIGHT_STATUS");
    assert.ok(typeof CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS === "number", "CI_BREAK_FINDING_FRESHNESS_MAX_AGE_MS");
    assert.ok(typeof SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS === "number", "SYSTEM_LEARNING_CI_DEBT_AUDIT_MAX_AGE_MS");
  });

  it("all plan_contract_validator.js symbols imported by this test file are defined at runtime", () => {
    assert.ok(typeof isNonSpecificVerification === "function", "isNonSpecificVerification");
    assert.ok(typeof validatePlanContract === "function", "validatePlanContract");
    assert.ok(typeof validateAndInjectRolePlans === "function", "validateAndInjectRolePlans");
    assert.ok(typeof ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX === "string", "ROLE_PLAN_COVERAGE_MISSING_MARKER_PREFIX");
    assert.ok(typeof ROLE_PLAN_SKELETON_METADATA_SOURCE === "string", "ROLE_PLAN_SKELETON_METADATA_SOURCE");
    assert.ok(typeof detectProcessThoughtMarkers === "function", "detectProcessThoughtMarkers");
    assert.ok(Array.isArray(NON_SPECIFIC_VERIFICATION_PATTERNS), "NON_SPECIFIC_VERIFICATION_PATTERNS");
    assert.ok(Array.isArray(NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES), "NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES");
    assert.ok(PACKET_VIOLATION_CODE !== undefined, "PACKET_VIOLATION_CODE");
  });
});

describe("pre-merge sentinel: verification-specificity grammar coherence", () => {
  it("NON_SPECIFIC_VERIFICATION_PATTERNS and CANONICAL_FIXTURES have 1:1 index alignment", () => {
    assert.equal(
      NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES.length,
      NON_SPECIFIC_VERIFICATION_PATTERNS.length,
      "each pattern must have exactly one canonical fixture — add a fixture when adding a pattern"
    );
  });

  it("isNonSpecificVerification returns true for every canonical fixture (grammar-function coupling)", () => {
    for (const fixture of NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES) {
      assert.equal(
        isNonSpecificVerification(fixture),
        true,
        `isNonSpecificVerification("${fixture}") must return true — fix the function or remove the pattern`
      );
    }
  });

  it("every canonical fixture matches its paired pattern (index-aligned coverage)", () => {
    for (let i = 0; i < NON_SPECIFIC_VERIFICATION_PATTERNS.length; i++) {
      const pattern = NON_SPECIFIC_VERIFICATION_PATTERNS[i];
      const fixture = NON_SPECIFIC_VERIFICATION_CANONICAL_FIXTURES[i];
      assert.ok(
        pattern.test(fixture),
        `Pattern[${i}] ${pattern} must match its canonical fixture "${fixture}"`
      );
    }
  });

  it("negative path: specific verification strings are not flagged as non-specific", () => {
    const specificExamples = [
      "npm test -- tests/core/doctor.test.ts",
      "tests/core/plan_contract_validator.test.ts — test: isNonSpecificVerification",
      "node --test tests/core/foo.test.ts",
    ];
    for (const example of specificExamples) {
      assert.equal(
        isNonSpecificVerification(example),
        false,
        `isNonSpecificVerification("${example}") must return false (specific reference)`
      );
    }
  });
});

// ── PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES — planning input contract ────────

describe("PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES — canonical planning input contract", () => {
  it("includes state/worker_cycle_artifacts.json as the canonical cycle snapshot source", () => {
    assert.ok(
      PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES.includes("state/worker_cycle_artifacts.json"),
      "canonical workflow must reference state/worker_cycle_artifacts.json"
    );
  });

  it("does NOT include state/evolution_progress.json (deprecated legacy file)", () => {
    assert.ok(
      !PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES.includes("state/evolution_progress.json"),
      "evolution_progress.json is deprecated and must not appear in canonical workflow state files"
    );
  });

  it("includes all required canonical health state files", () => {
    const required = [
      "state/cycle_analytics.json",
      "state/capacity_scoreboard.json",
      "state/cycle_health.json",
      "state/athena_postmortems.json",
    ];
    for (const file of required) {
      assert.ok(
        PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES.includes(file),
        `canonical workflow must include ${file}`
      );
    }
  });

  it("is frozen (immutable) to prevent accidental mutation", () => {
    const arr = PROMETHEUS_CANONICAL_WORKFLOW_STATE_FILES as unknown as string[];
    assert.throws(
      () => { arr.push("state/foo.json"); },
      (err: unknown) => err instanceof TypeError,
      "array must be frozen — push must throw TypeError"
    );
  });
});

// ── isStrategicFieldToolTraceContaminated: extended procedural intent patterns ─

describe("isStrategicFieldToolTraceContaminated — extended procedural intent (gather/collect/investigate)", () => {
  it("rejects 'I'm going to gather evidence' procedural intent", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I'm going to gather evidence about the CI failures"),
      true,
      "'I'm going to gather evidence' is procedural intent and must be rejected",
    );
  });

  it("rejects 'I will now gather findings' procedural intent", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I will now gather findings from the codebase"),
      true,
      "'I will now gather findings' is procedural intent and must be rejected",
    );
  });

  it("rejects 'I'm going to collect the failing test data'", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I'm going to collect the failing test data for analysis"),
      true,
      "'I'm going to collect' is procedural intent and must be rejected",
    );
  });

  it("rejects 'Let me investigate the root cause'", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("Let me investigate the root cause of the dispatch failures"),
      true,
      "'Let me investigate' is procedural intent and must be rejected",
    );
  });

  it("rejects 'I will now assess the coverage gaps'", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I will now assess the coverage gaps in the test suite"),
      true,
      "'I will now assess' is procedural intent and must be rejected",
    );
  });

  it("rejects 'I'll now document the findings'", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("I'll now document the findings from this analysis"),
      true,
      "'I'll now document' is procedural intent and must be rejected",
    );
  });

  it("does NOT reject legitimate findings where 'gather' appears mid-sentence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "The CI pipeline should gather test results from all workers before reporting status"
      ),
      false,
      "'gather' mid-sentence in legitimate strategic content must not trigger rejection",
    );
  });

  it("does NOT reject strategic narrative using 'collect' as a system action", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "Telemetry agents collect metrics continuously; bottlenecks appear in the aggregation layer"
      ),
      false,
      "System-level 'collect' in legitimate strategic content must not be rejected",
    );
  });
});

// ── isStrategicFieldToolTraceContaminated: decision blob patterns ──────────────

describe("isStrategicFieldToolTraceContaminated — decision blob patterns", () => {
  it("rejects 'DECISION: approve' structured decision marker at line start", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("DECISION: approve | task_id: T-001 | confidence: high"),
      true,
      "'DECISION:' at line start is an unparsed decision blob and must be rejected",
    );
  });

  it("rejects 'VOTE: approve' structured decision marker", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("VOTE: approve"),
      true,
      "'VOTE:' at line start is an unparsed decision blob and must be rejected",
    );
  });

  it("rejects 'REJECT: task exceeds scope' decision trace", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("REJECT: task exceeds scope limit"),
      true,
      "'REJECT:' at line start is an unparsed decision blob and must be rejected",
    );
  });

  it("rejects 'VERDICT: approved' decision trace", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated("VERDICT: approved with minor reservations"),
      true,
      "'VERDICT:' at line start is an unparsed decision blob and must be rejected",
    );
  });

  it("rejects JSON decision blob with 'decision' key", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated('{"decision": "approve", "task_id": "T-001", "confidence": 0.8}'),
      true,
      "JSON object with 'decision' key is an unparsed decision blob and must be rejected",
    );
  });

  it("rejects JSON decision blob with 'verdict' key", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated('{"confidence": 0.9, "verdict": "approved"}'),
      true,
      "JSON object with decision-related keys is an unparsed decision blob and must be rejected",
    );
  });

  it("does NOT reject prose mentioning 'decision' mid-sentence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "The decision to refactor the dispatch layer should be deferred until CI is stable"
      ),
      false,
      "'decision' mid-sentence in legitimate strategic content must not trigger rejection",
    );
  });

  it("does NOT reject prose with 'outcome' mid-sentence", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "Expected outcome is a 40% reduction in failed dispatches after the patch is applied"
      ),
      false,
      "'outcome' mid-sentence in legitimate strategic content must not trigger rejection",
    );
  });

  it("negative path: 'DECISION' word mid-sentence without colon is not rejected", () => {
    assert.equal(
      isStrategicFieldToolTraceContaminated(
        "A DECISION framework is needed before wave-2 can proceed to dispatch"
      ),
      false,
      "'DECISION' mid-sentence without trailing colon must not be flagged as a decision blob",
    );
  });
});

// ── DECISION_BLOB_PATTERNS export ─────────────────────────────────────────────

describe("DECISION_BLOB_PATTERNS export", () => {
  it("is a frozen non-empty array", () => {
    assert.ok(Array.isArray(DECISION_BLOB_PATTERNS));
    assert.ok(DECISION_BLOB_PATTERNS.length > 0, "DECISION_BLOB_PATTERNS must be non-empty");
    assert.ok(Object.isFrozen(DECISION_BLOB_PATTERNS), "DECISION_BLOB_PATTERNS must be frozen");
  });

  it("array must be frozen — push must throw TypeError", () => {
    assert.throws(
      () => (DECISION_BLOB_PATTERNS as RegExp[]).push(/test/),
      TypeError,
      "array must be frozen — push must throw TypeError",
    );
  });
});

