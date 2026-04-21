# BOX Architecture Map

This document is an operator-focused map of the BOX runtime.
It explains module boundaries, data flow, role ownership, loop selection, and user-visible escalation behavior.

## 1) System Intent

BOX is an autonomous software delivery runtime.
It scans a target repository, plans work, dispatches isolated workers, validates quality gates, and escalates unresolved blockers.

Primary execution styles:
- Single cycle: `npm run box:once`
- Continuous daemon: `npm run box:start`
- Graceful stop: `npm run box:stop`

## 2) Runtime Layers

### Layer A: Entry and Config

Files:
- `src/cli.ts`
- `src/config.ts`
- `box.config.json`

Responsibilities:
- Parse command (`once`, `start`, `stop`, `doctor`).
- Load `.env` and config file.
- Resolve runtime feature flags, model policies, gate requirements, and state file paths.

Key output:
- Normalized config object consumed by orchestrator.

### Layer B: Orchestration Core

File:
- `src/core/orchestrator.ts`

Responsibilities:
- Recover stale task state and reconcile queue health.
- Select loop mode (`strategic` or `tactical`).
- Run project scan and optional deep analysis.
- Build roadmap and plan in strategic mode.
- Dispatch tasks to workers with routing and ownership enforcement.
- Finalize worker results through gates, review, checkpointing, queue updates, and escalation.

Key output:
- Task lifecycle transitions, progress logs, alerts, checkpoints, and follow-up tasks.

### Layer C: Planning and Queue

Files:
- `src/core/project_scanner.ts`
- `src/core/prometheus.ts`
- `src/core/orchestrator.ts`
- `src/core/dependency_graph_resolver.ts`
- `src/core/intervention_optimizer.ts`

Responsibilities:
- Generate repository summary and domain signals.
- Convert summary into roadmap tasks and complexity roof.
- Create normalized task contracts.
- Enqueue, prune, deduplicate, split, and recover tasks.
- Resolve task dependency graphs, detect cycles, serialize conflicting tasks into waves.
- Optimize intervention strategies across active worker lanes.

### Layer D: Worker Execution

Files:
- `src/core/worker_runner.ts`
- `src/workers/run_task.ts`
- `src/providers/coder/copilot_cli_provider.ts`
- `docker/worker/Dockerfile`

Responsibilities:
- Run each task in Docker (`docker run --rm ...`).
- Route prompts and models dynamically by role, kind, and complexity.
- Apply code edits and run gates inside worker.
- Push branch and optionally open PR.

### Layer E: Policy, Review, Escalation

Files:
- `src/core/verification_gate.ts`
- `src/core/verification_command_registry.ts`
- `src/core/escalation_queue.ts`
- `src/core/policy_engine.ts`

Responsibilities:
- Evaluate build/test/lint/security/coverage gates.
- Approve or reject task outcomes via reviewer.
- Escalate unresolved or environment-blocked failures (`L1 -> L4`).
- Enforce protected-path and blocked-command policies.
- Enforce Windows-safe verification command canonicals and forbidden-pattern rejection.
- Gate done-path worker outputs: require BOX_MERGED_SHA and npm test artifact block.

### Layer H: Architecture Health

Files:
- `src/core/architecture_drift.ts`

Responsibilities:
- Scan documentation for stale file references and deprecated API tokens.
- Convert drift findings into ranked remediation candidates for Prometheus.
- Persist drift backlog entries to `state/drift_backlog.json` for mandatory closure tracking.
- Prevent ghost-file-path planning by detecting and surfacing documentation staleness.

### Layer F: Observability and Control Plane

Files:
- `src/core/state_tracker.ts`
- `src/core/checkpoint_engine.ts`
- `src/core/live_log.ts`
- `src/dashboard/live_dashboard.ts`
- `src/core/daemon_control.ts`

Responsibilities:
- Persist progress, alerts, tests, usage, checkpoints, and worker phases.
- Serve dashboard and `/api/state` runtime snapshot.
- Manage daemon PID and stop requests.

### Layer G: Self-Improvement Control Layer

Files:
- `src/core/self_improvement.ts`

Responsibilities:
- Run cycle-end self-analysis and produce `SelfAnalysisReport` metrics.
- Generate system-level improvement tasks (`kind: system_improvement`) from failure/review trends.
- Enforce self-upgrade guard so protected core modules cannot be auto-modified by self-improvement tasks.
- Persist engineering knowledge and experiment candidates for long-term capability growth.

## 3) Role Registry and Humanized Ownership

Source of truth:
- `src/core/role_registry.ts`
- Runtime override: `box.config.json -> roleRegistry`

Current named roles:
- CEO Supervisor: `Janus`
- Lead Worker: `Athena`
- Backend: `King David`
- Frontend: `Esther`
- API: `Aaron`
- Integration: `Joseph`
- Test: `Samuel`
- QA: `Isaiah`
- DevOps: `Noah`
- Security: `Elijah`
- Scanner A: `Issachar`
- Scanner B: `Ezra`

Routing owner by task kind is enforced in:
- `src/core/capability_pool.ts`

Examples:
- `production` tasks map to security/devops ownership.
- `stability` tasks map to backend ownership.
- `quality` tasks map to test/qa ownership.
- `scan` tasks map to scanner ownership.

If ownership mismatch occurs, orchestration hard-fails that task and raises an alert.

## 4) End-to-End Sequence (One Task)

1. Orchestrator pops queued task from `state/tasks.json`.
2. Route resolves agent, prompt, and expected role.
3. Worker container starts with task metadata and model policy env vars.
4. In-container runner executes Copilot-driven implementation.
5. Worker runs gates (`build`, `test`, optional `lint`, `security`).
6. Worker returns markers (`BOX_STEP_*`) and exit status.
7. Orchestrator computes gate result and reviewer decision.
8. Checkpoint written to `state/checkpoint-*.json`.
9. Task marked `passed` or `failed`.
10. On failure, recovery tasks are generated, optionally split, and issue handoff can be opened.
11. Escalation policy decides whether user alert is required.
12. Alerts and progress lines are written and rendered in dashboard.

## 5) Loop Selector

Strategic/tactical decision lives in:
- `src/core/orchestrator.ts`

Current deterministic selector behavior:
- Strategic is due when interval threshold (`runtime.strategicLoopMinutes`) is reached.
- Tactical is preferred while active sprint inventory exists and strategic is not due.
- Tactical mode defers roadmap/plan regeneration and keeps current sprint queue.
- Strategic mode rebuilds roadmap, plan, and sprint freeze set.

State file used:
- `state/strategic_cycle.json`

## 6) Escalation Chain and User Visibility

Policy engine:
- `src/core/escalation_queue.ts`

Escalation levels:
- `L1-self-heal`
- `L2-lead`
- `L3-ceo`
- `L4-user`

Triggers for user visibility include:
- Environment blockers (`docker`, credentials, permissions, missing dependencies).
- Retry threshold exceeded.

User notification channel:
- Alert entries in `state/alerts.json`
- Dashboard reads and displays alerts in "Autonomy Alerts"
- Progress stream in `state/progress.txt`

Humanized chain messaging:
- Worker reports to `Athena`.
- `Athena` reports to `Janus`.
- `Janus` escalates to user when autonomous recovery cannot close the loop safely.

## 7) State Contract (Operational Files)

Primary runtime files under `state/`:
- `tasks.json`: task queue and lifecycle states.
- `progress.txt`: chronological event log.
- `alerts.json`: user-facing escalations and supervision alerts.
- `tests.json`: aggregated pass/fail/running stats.
- `worker_activity.json`: per-slot worker phases.
- `checkpoint-*.json`: forensic snapshot for each finalized task.
- `project_summary.json`: scanner output.
- `budget.json`: budget state.
- `copilot_usage.json`, `copilot_usage_monthly.json`: model usage telemetry.
- `claude_usage.json`, `claude_usage_monthly.json`: reviewer usage telemetry.
- `self_analysis.json`: cycle-by-cycle self-analysis reports.
- `engineering_knowledge_base.json`: persisted problem/solution learnings with confidence.
- `experiments.json`: A/B experiment records and candidate winners.
- `dependency_graph_diagnostics.json`: NDJSON diagnostics from dependency graph resolution (one entry per call, schema defined in `state/diagnostics_schema.json`).
- `drift_backlog.json`: NDJSON architecture drift backlog entries from `persistDriftBacklog()` (mandatory planner debt — one entry per drift scan).
- `carry_forward_backlog.json`: machine-checkable closure records for carry-forward verification debt items #1-#5.
- `diagnostics_schema.json`: canonical schema definitions for all diagnostics and state files.

## 8) Gates and Exit Codes

Gate evaluation file:
- `src/core/verification_gate.ts`

Worker gate markers parsed by:
- `src/core/worker_runner.ts`

Typical worker exits from `src/workers/run_task.ts`:
- `3`: build failed
- `4`: tests failed
- `6`: lint failed
- `7`: security scan failed

If worker exits non-zero without markers, all required checks are treated as failed for deterministic safety.

## 9) Model and Provider Behavior

Config and policy sources:
- `box.config.json -> runtime`, `copilot`, `planner`
- `src/config.ts`
- `src/providers/coder/copilot_cli_provider.ts`

Current runtime pattern:
- Reviewer provider is configurable (`copilot` or `claude`).
- Coder model selection is dynamic by role, task kind, and complexity band.
- Guardrails enforce allowlist/denylist and multiplier budget caps.

## 10) Failure Playbook (Operator Quick Actions)

If tasks repeatedly fail with same gate:
1. Check latest checkpoint in `state/checkpoint-*.json` for root cause.
2. Confirm worker environment health (Docker daemon, credentials, network).
3. Inspect `state/alerts.json` and `state/progress.txt` for escalation chain.
4. Resolve external blocker, then allow autonomous retry path to continue.

If system appears stuck in tactical loop:
1. Inspect `state/strategic_cycle.json` and active queue inventory.
2. Verify unresolved queued/running/blocked tasks in `state/tasks.json`.
3. Clear blocker cause, not just symptoms, so strategic interval can reassert.

If dashboard disagrees with expected behavior:
1. Query `http://localhost:8787/api/state`.
2. Compare against raw state files in `state/`.

## 11) Governance Rules

- Do not bypass required gates for production-like tasks.
- Keep task contracts deterministic (goal, non-goals, tests, rollback plan).
- Prefer reversible changes and explicit failure signals.
- Escalate to user on environment blockers or repeated unresolved failures.

## 12) Current Practical Reading

A healthy run should show this shape in `state/progress.txt`:
- `Loop mode=...`
- `Project scan completed`
- `Plan prepared ...` or tactical preservation line
- `Dispatching ...`
- Task start and routing lines
- Gate/review result
- `passed` or controlled failure with escalation details

This sequence is the canonical heartbeat for BOX runtime correctness.

## 13) Complete Internal Architecture Specification

The sections below define missing internal schemas and behavioral protocols for deterministic, loop-safe autonomous execution.

### 13.1 Task Contract Schema

#### Architecture Section - Task Contract Schema

Every task must be executable without ambiguity. A task contract is the single source of truth for execution boundaries, acceptance criteria, and rollback behavior.

#### Schema Definition - Task Contract Schema

```ts
type Domain = "quality" | "stability" | "production" | "security" | "general";
type TaskKind =
	| "bootstrap"
	| "quality"
	| "stability"
	| "production"
	| "refactor"
	| "frontend"
	| "backend"
	| "api"
	| "integration"
	| "test"
	| "qa"
	| "devops"
	| "security"
	| "scan"
	| "general";

interface TaskContract {
	contractVersion: "1.0";
	domain: Domain;
	goal: string;
	nonGoals: string[];
	filesInScope: string[];
	testsToAdd: string[];
	exitCriteria: string[];
	rollbackPlan: string;
	invariants: string[];
	riskLevel: "low" | "medium" | "high";
}

interface QueueTask {
	id: number;
	semanticKey: string;
	title: string;
	kind: TaskKind;
	priority: 1 | 2 | 3 | 4 | 5;
	status: "queued" | "running" | "blocked" | "failed" | "passed" | "parked";
	source: "roadmap" | "autonomous-retry" | "autonomous-split" | "autonomous-resume" | "autonomous-cycle";
	attempt: number;
	parentTaskId?: number;
	dependsOnIssueNumber?: number;
	linkedIssueNumber?: number;
	assignedRole?: string;
	assignedWorker?: string;
	failureReason?: string;
	contract: TaskContract;
	createdAt: string;
	updatedAt: string;
}
```

#### Integration Points - Task Contract Schema

- `src/core/prometheus.ts`: must always produce normalized `TaskContract`.
- `src/core/orchestrator.ts`: validates contract before dispatch.
- `src/core/orchestrator.ts`: stores `semanticKey`, `attempt`, and lineage.

#### Failure Prevention Logic - Task Contract Schema

- Reject dispatch if `goal`, `nonGoals`, `exitCriteria`, or `rollbackPlan` are missing.
- Reject contracts where `filesInScope` contains paths outside repository root.
- Reject contracts with empty `invariants` for `production` and `security` kinds.

### 13.2 Worker Communication Protocol

#### Architecture Section - Worker Communication Protocol

Worker and orchestrator communication must be machine-parseable and stage-aware. Free-form logs are supplemental only.

#### Schema Definition - Worker Communication Protocol

```json
{
	"$id": "box.worker.protocol.v1",
	"type": "object",
	"required": ["envelope", "event"],
	"properties": {
		"envelope": {
			"type": "object",
			"required": ["protocolVersion", "taskId", "workerSlot", "roleName", "timestamp"],
			"properties": {
				"protocolVersion": { "const": "1.0" },
				"taskId": { "type": "integer", "minimum": 1 },
				"workerSlot": { "type": "string" },
				"roleName": { "type": "string" },
				"timestamp": { "type": "string", "format": "date-time" },
				"correlationId": { "type": "string" }
			}
		},
		"event": {
			"type": "object",
			"required": ["name", "phase"],
			"properties": {
				"name": {
					"enum": [
						"task.received",
						"context.loaded",
						"plan.generated",
						"edit.applied",
						"gate.build",
						"gate.test",
						"gate.lint",
						"gate.security",
						"git.push",
						"pr.created",
						"task.completed",
						"task.failed"
					]
				},
				"phase": { "enum": ["prepare", "analyze", "implement", "validate", "publish", "finalize"] },
				"ok": { "type": "boolean" },
				"details": { "type": "object" },
				"error": { "type": "string" }
			}
		}
	}
}
```

#### Integration Points - Worker Communication Protocol

- `src/workers/run_task.ts`: emits protocol JSON lines in stdout.
- `src/core/worker_runner.ts`: parses protocol events before fallback text parsing.
- `src/core/live_log.ts`: updates phase based on event stream.

#### Failure Prevention Logic - Worker Communication Protocol

- If no valid protocol envelope is emitted within timeout window, mark task failed with `communication-timeout`.
- If event order is invalid (for example `publish` before `validate`), hard-fail as non-deterministic execution.

### 13.3 Task State Machine

#### Architecture Section - Task State Machine

Task lifecycle is a strict state machine. Illegal transitions are rejected and logged as policy violations.

#### Schema Definition - Task State Machine

```ts
type TaskState = "queued" | "running" | "blocked" | "failed" | "passed" | "parked";

const AllowedTransitions: Record<TaskState, TaskState[]> = {
	queued: ["running", "parked"],
	running: ["passed", "failed", "blocked"],
	blocked: ["queued", "parked"],
	failed: ["queued", "parked"],
	passed: [],
	parked: ["queued"]
};
```

#### Integration Points - Task State Machine

- `src/core/orchestrator.ts`: enforce transition map in `markTask` and requeue helpers.
- `src/core/orchestrator.ts`: disallow direct `queued -> passed` or `running -> queued` shortcuts.
- `state/tasks.json`: include `lastTransition`, `lastTransitionAt`, and `transitionBy`.

#### Failure Prevention Logic - Task State Machine

- Reject and alert on illegal transitions.
- Lock each task by `taskId` during transition to prevent concurrent writes.
- Add monotonic `version` field; update only if `expectedVersion` matches.

### 13.4 Loop Prevention Mechanism

#### Architecture Section - Loop Prevention Mechanism

Loop prevention combines semantic deduplication, retry budget, cooldown parking, and stale lineage suppression.

#### Schema Definition - Loop Prevention Mechanism

```ts
interface LoopGuardPolicy {
	semanticFailureWindowMinutes: number;
	semanticFailureMaxCount: number;
	maxAttemptsPerTask: number;
	maxDescendantDepth: number;
	cooldownMinutes: number;
	parkOnRepeatedFailure: boolean;
}

interface SemanticFailureIndex {
	semanticKey: string;
	failedCountInWindow: number;
	lastFailureAt: string;
	lastPassedAt?: string;
	parkedUntil?: string;
}
```

#### Integration Points - Loop Prevention Mechanism

- `src/core/orchestrator.ts`: existing semantic suppression extends to descendant depth checks.
- `src/core/orchestrator.ts`: stop creating split tasks when `maxDescendantDepth` exceeded.
- `state/tasks.json`: keep `splitDepth` and `lineageRootTaskId`.

#### Failure Prevention Logic - Loop Prevention Mechanism

- Park semantic family if max failures reached without newer pass.
- Refuse enqueue when parent lineage already parked.
- Trigger `L4-user` escalation when same `semanticKey` exceeds cap twice in one day.

### 13.5 Issue Intake Filtering Policy

#### Architecture Section - Issue Intake Filtering Policy

Not every external issue should become executable work. Intake must classify, deduplicate, and gate by policy.

#### Schema Definition - Issue Intake Filtering Policy

```ts
interface IssueIntakeRecord {
	issueNumber: number;
	sourceRepo: string;
	titleHash: string;
	semanticKey: string;
	classification: "actionable" | "duplicate" | "stale" | "policy-blocked";
	reason: string;
	acceptedTaskId?: number;
	createdAt: string;
}
```

#### Integration Points - Issue Intake Filtering Policy

- `src/core/orchestrator.ts`: before `createHandoffIssue` and before releasing blocked tasks.
- `src/core/orchestrator.ts`: check `semanticKey` against active or recently failed tasks.
- New file: `state/issue_intake.json`.

#### Failure Prevention Logic - Issue Intake Filtering Policy

- Ignore issues tied to already-closed semantic families unless a newer checkpoint indicates recovery.
- Reject stale issues older than configurable max age unless labeled `force-intake`.
- Reject policy-blocked scopes (for example protected paths requiring human approval).

### 13.6 Worker Behavior Policy

#### Architecture Section - Worker Behavior Policy

Workers must follow deterministic behavior constraints independent of model output quality.

#### Schema Definition - Worker Behavior Policy

```json
{
	"$id": "box.worker.behavior.v1",
	"type": "object",
	"required": ["allowedActions", "forbiddenActions", "requiredChecks", "gitRules"],
	"properties": {
		"allowedActions": {
			"type": "array",
			"items": { "enum": ["read", "edit", "test", "build", "lint", "audit", "git-add", "git-commit", "git-push", "pr-open"] }
		},
		"forbiddenActions": {
			"type": "array",
			"items": { "enum": ["force-push", "history-rewrite", "destructive-delete", "secret-exfiltration"] }
		},
		"requiredChecks": {
			"type": "object",
			"properties": {
				"build": { "type": "boolean" },
				"test": { "type": "boolean" },
				"security": { "type": "boolean" }
			}
		},
		"gitRules": {
			"type": "object",
			"properties": {
				"branchPrefix": { "type": "string" },
				"signedCommitsRequired": { "type": "boolean" },
				"singleTaskSingleBranch": { "type": "boolean" }
			}
		}
	}
}
```

#### Integration Points - Worker Behavior Policy

- `src/workers/run_task.ts`: enforce behavior file before execution.
- `src/core/policy_engine.ts`: merge repo policy and worker behavior policy.
- `src/core/orchestrator.ts`: include policy digest in checkpoint.

#### Failure Prevention Logic - Worker Behavior Policy

- Immediate fail on forbidden action attempt.
- If required check command missing, fail task as `policy-noncompliant`.
- If worker edits out-of-scope file, reset task to failed and escalate.

### 13.7 Context Envelope Schema

#### Architecture Section - Context Envelope Schema

Workers should receive bounded, deterministic context packets. Context size and content must be controlled.

#### Schema Definition - Context Envelope Schema

```ts
interface ContextEnvelope {
	envelopeVersion: "1.0";
	task: {
		id: number;
		title: string;
		kind: string;
		contract: TaskContract;
	};
	repository: {
		targetRepo: string;
		baseBranch: string;
		defaultBranch: string;
	};
	priorAttempts: Array<{
		attempt: number;
		failureReason: string;
		checkpointPath?: string;
	}>;
	constraints: {
		maxFilesToChange: number;
		maxPatchLines: number;
		forbiddenPaths: string[];
	};
	knowledgeRefs: {
		summaryPath: string;
		roadmapPath: string;
		policyPath: string;
	};
}
```

#### Integration Points - Context Envelope Schema

- `src/core/orchestrator.ts`: build envelope in `buildWorkerOverrides`.
- `src/workers/run_task.ts`: validate and print envelope hash to logs.
- `state/checkpoint-*.json`: include envelope hash and version.

#### Failure Prevention Logic - Context Envelope Schema

- Reject worker start if envelope validation fails.
- Reject envelope over max byte size.
- Strip stale context older than configurable window.

### 13.8 Strategic Planning Schema

#### Architecture Section - Strategic Planning Schema

Strategic planning output must be reproducible and auditable. Plans are immutable snapshots for a sprint window.

#### Schema Definition - Strategic Planning Schema

```ts
interface StrategicPlan {
	planVersion: "1.0";
	generatedAt: string;
	sprintId: string;
	strategicInputs: {
		summaryHash: string;
		policyHash: string;
		queueSnapshotHash: string;
	};
	complexityRoof: {
		domains: Array<{
			domain: string;
			currentScore: number;
			targetScore: number;
			delta: number;
			risk: "low" | "medium" | "high";
		}>;
	};
	tasks: QueueTask[];
	freezeSemanticKeys: string[];
}
```

#### Integration Points - Strategic Planning Schema

- `src/core/prometheus.ts`: generate normalized complexity roof.
- `src/core/prometheus.ts`: produce contracts and semantic keys.
- `state/roadmap.json` and `state/strategic_cycle.json`: persist plan metadata.

#### Failure Prevention Logic - Strategic Planning Schema

- Refuse strategic plan if no `freezeSemanticKeys` generated.
- Refuse plan where top-priority tasks have identical semantic keys.
- Use deterministic sort `(priority, semanticKey, id)`.

### 13.9 Worker Capability Profiles

#### Architecture Section - Worker Capability Profiles

Role assignment should be capability-based, not only task-kind based.

#### Schema Definition - Worker Capability Profiles

```ts
interface WorkerCapabilityProfile {
	roleName: string;
	workerId: string;
	capabilities: string[];
	prohibitedKinds: string[];
	preferredTaskKinds: string[];
	maxRiskLevel: "low" | "medium" | "high";
	maxConcurrentTasks: number;
	defaultModelPool: string[];
}

type CapabilityRegistry = Record<string, WorkerCapabilityProfile>;
```

#### Integration Points - Worker Capability Profiles

- `box.config.json`: add `capabilityProfiles`.
- `src/core/capability_pool.ts`: route by capability intersection first, then fallback by kind map.
- `src/providers/coder/copilot_cli_provider.ts`: consume profile model pool.

#### Failure Prevention Logic - Worker Capability Profiles

- Prevent assigning high-risk security task to profile with `maxRiskLevel=medium`.
- Prevent assignment when `maxConcurrentTasks` exceeded.
- Emit high-severity alert when no compatible profile exists.

### 13.10 Repository Knowledge Graph Schema

#### Architecture Section - Repository Knowledge Graph Schema

BOX needs persistent structural memory of modules, dependencies, critical paths, and ownership to avoid blind retries.

#### Schema Definition - Repository Knowledge Graph Schema

```ts
interface KnowledgeNode {
	id: string;
	type: "module" | "script" | "service" | "test" | "policy";
	path?: string;
	tags: string[];
}

interface KnowledgeEdge {
	from: string;
	to: string;
	relation: "imports" | "depends-on" | "validates" | "owned-by" | "protects";
}

interface RepositoryKnowledgeGraph {
	graphVersion: "1.0";
	generatedAt: string;
	repo: string;
	nodes: KnowledgeNode[];
	edges: KnowledgeEdge[];
}
```

#### Integration Points - Repository Knowledge Graph Schema

- `src/core/project_scanner.ts`: generate graph incrementally.
- New state file: `state/knowledge_graph.json`.
- `src/core/prometheus.ts`: prefer tasks touching high-centrality unresolved nodes.

#### Failure Prevention Logic - Repository Knowledge Graph Schema

- Reject tasks whose `filesInScope` reference unknown graph nodes unless explicitly marked `bootstrap`.
- Use graph edge validation to block invalid cross-domain edits.

### 13.11 Recovery Strategy System

#### Architecture Section - Recovery Strategy System

Recovery must be strategy-driven and finite. Each failure class maps to one recovery plan.

#### Schema Definition - Recovery Strategy System

```ts
type RecoveryClass =
	| "build-failure"
	| "test-failure"
	| "security-failure"
	| "environment-blocker"
	| "policy-violation"
	| "unknown";

interface RecoveryStrategy {
	class: RecoveryClass;
	maxAttempts: number;
	splitAllowed: boolean;
	splitKinds: TaskKind[];
	requiresIssueHandoff: boolean;
	parkAfterExhaustion: boolean;
	escalateAtLevel: "L2-lead" | "L3-ceo" | "L4-user";
}
```

#### Integration Points - Recovery Strategy System

- `src/core/orchestrator.ts`: replace ad hoc recovery branching with strategy map.
- `src/core/orchestrator.ts`: annotate each follow-up with `recoveryClass`.
- `state/checkpoint-*.json`: write selected recovery strategy.

#### Failure Prevention Logic - Recovery Strategy System

- Never split recursively without class-specific allowance.
- Always park after strategy exhaustion.
- Always escalate environment blockers directly to `L4-user`.

### 13.12 Worker Coordination Model

#### Architecture Section - Worker Coordination Model

Multi-worker execution needs explicit coordination to avoid duplicate work and write conflicts.

#### Schema Definition - Worker Coordination Model

```ts
interface CoordinationLock {
	resourceKey: string; // semanticKey or file scope hash
	ownerTaskId: number;
	ownerWorkerSlot: string;
	acquiredAt: string;
	expiresAt: string;
}

interface CoordinationPlan {
	planId: string;
	maxParallelWorkers: number;
	locks: CoordinationLock[];
	dependencies: Array<{ taskId: number; dependsOnTaskId: number }>;
}
```

#### Integration Points - Worker Coordination Model

- `src/core/orchestrator.ts`: acquire lock before dispatch.
- `src/core/orchestrator.ts`: block tasks that collide on lock key.
- `state/worker_activity.json`: include lock ownership metadata.

#### Failure Prevention Logic - Worker Coordination Model

- Hard-block dispatch if lock collision exists.
- Auto-release stale locks by TTL with alert entry.
- Detect and reject circular dependencies before enqueue.

### 13.13 Budget Guard System

#### Architecture Section - Budget Guard System

Budget guard must cover model usage, worker attempts, and recovery explosion risk.

#### Schema Definition - Budget Guard System

```ts
interface BudgetGuard {
	cycleBudgetUsd: number;
	monthlyBudgetUsd: number;
	maxWorkerRunsPerTask: number;
	maxReviewerCallsPerTask: number;
	highCostModelBudgetFloorUsd: number;
	stopOnBudgetExhaustion: boolean;
}

interface BudgetDecision {
	allowed: boolean;
	reason: string;
	remainingUsd: number;
	action: "continue" | "downgrade-model" | "pause-noncritical" | "stop-and-alert";
}
```

#### Integration Points - Budget Guard System

- `src/core/budget_controller.ts`: produce decision before each dispatch.
- `src/providers/coder/copilot_cli_provider.ts`: downgrade model on budget action.
- `src/core/orchestrator.ts`: pause low-priority queue on budget pressure.

#### Failure Prevention Logic - Budget Guard System

- Refuse high-cost model when below floor.
- Refuse new retries when `maxWorkerRunsPerTask` exceeded.
- Trigger `L4-user` when monthly budget hard limit reached.

### 13.14 Observability Event Schema

#### Architecture Section - Observability Event Schema

All modules must emit normalized telemetry to support forensics, dashboards, and deterministic incident review.

#### Schema Definition - Observability Event Schema

```json
{
	"$id": "box.observability.event.v1",
	"type": "object",
	"required": ["eventId", "timestamp", "component", "eventType", "severity", "message"],
	"properties": {
		"eventId": { "type": "string" },
		"timestamp": { "type": "string", "format": "date-time" },
		"component": {
			"enum": [
				"cli",
				"config",
				"orchestrator",
				"queue",
				"planner",
				"worker-runner",
				"worker",
				"gates",
				"reviewer",
				"escalation",
				"dashboard"
			]
		},
		"eventType": { "type": "string" },
		"severity": { "enum": ["debug", "info", "warning", "error", "critical"] },
		"taskId": { "type": "integer" },
		"correlationId": { "type": "string" },
		"message": { "type": "string" },
		"data": { "type": "object" }
	}
}
```

#### Integration Points - Observability Event Schema

- `src/core/state_tracker.ts`: write event stream to new `state/events.jsonl`.
- `src/dashboard/live_dashboard.ts`: aggregate by component, severity, and correlation.
- `state/checkpoint-*.json`: include related `eventId` list.

#### Failure Prevention Logic - Observability Event Schema

- Reject silent failures: every failed task must emit at least one `error` event.
- Enforce correlation id from dispatch to finalize.
- Alert on missing finalize event for running tasks past timeout.

## 14) Global Determinism and Safety Invariants

The following invariants are mandatory across all modules:

- A task cannot be executed without a valid `TaskContract`.
- A semantic task family cannot retry forever; it must park or escalate.
- Worker-to-lead-to-ceo-to-user escalation chain must be reflected in alerts.
- Every task finalize path must produce checkpoint, test-state update, and progress entry.
- Every failure must carry machine-parseable root cause classification.
- Tactical loop cannot hide unresolved systemic blockers beyond configured thresholds.

These invariants make BOX deterministic, loop-safe, and operationally auditable.

## 15) Loop-Proof Hardening Additions

The following additions were introduced to close remaining loop and runtime stability gaps.

### 15.1 Planner Regeneration Guard

- Tracks task fingerprint generation history and blocks repeated strategic regeneration after cap.
- Prevents `strategic -> regenerate same task -> fail -> strategic -> same task` loops.
- Schema: `PlannerGenerationRecord` in `src/core/orchestrator.ts`.

### 15.2 Context Drift Guard

- Retry requires meaningful context change, not just another attempt.
- Context seed combines repository structure, lockfile, issue/log signals, and commit reference.
- Retry rule: identical failure signature + unchanged context revision => retry forbidden.
- Functions: `computeContextRevisionSeed`, `deriveContextRevision`, `shouldAllowRetryForContext` in `src/core/orchestrator.ts`.

### 15.3 Split Explosion Guard

- Split is limited by depth and total split count per lineage root.
- Stops recursive split storms and parks lineage once budget is exhausted.
- Function: `evaluateSplitControl` in `src/core/orchestrator.ts`.

### 15.4 Semantic Duplicate Guard

- Adds deterministic semantic similarity check for near-duplicate tasks with different phrasing.
- Uses normalized token Jaccard scoring with threshold support.
- Functions: `semanticSimilarity`, `isSemanticDuplicate` in `src/core/orchestrator.ts`.

### 15.5 Tactical Drift Guard

- Forces strategic mode when tactical cycles exceed threshold or unresolved failure/blocker pressure persists.
- Prevents indefinite tactical lock-in.
- Function: `shouldForceStrategicMode` in `src/core/orchestrator.ts`.

### 15.6 Dependency Deadlock Guard

- Detects dependency graph cycles before enqueue/dispatch.
- Rejects cyclic task dependencies to avoid blocked deadlocks.
- Function: `detectDependencyCycle` in `src/core/orchestrator.ts`.

### 15.7 Runtime Safety Budget Guard

- Adds non-financial runtime limits: max tasks per cycle, worker spawns per cycle, splits per cycle.
- Prevents task storms, spawn storms, and split storms.
- Extended in `src/core/budget_controller.ts`.

### 15.8 Worker Action Guard

- Worker execution is rejected when changed-file count exceeds threshold or forbidden path prefixes are modified.
- Runtime-configurable via:
  - `runtime.workerMaxFilesChanged`
  - `runtime.workerForbiddenPathPrefixes`
- Implemented in:
  - `src/workers/run_task.ts`
  - `src/core/worker_runner.ts`
  - `src/config.ts`

### 15.9 Task Loop Metadata Contract

- `tasks.json` now supports loop metadata for deterministic lineage tracking:
  - fingerprint
  - attempts / semanticAttempts
  - repeatedFailureCount
  - failureSignature
  - contextRevision
  - cooldownUntil
  - lineageRootTaskId
  - splitDepth / splitCount
- Implemented in `src/core/schema_registry.ts`.

## 16) Self-Analysis and Upgrade Protocol

BOX now executes a dedicated post-cycle self-improvement sequence:

1. Runtime metrics are computed from queue, budget, and usage state.
2. A `SelfAnalysisReport` is appended to `state/self_analysis.json`.
3. Improvement planner derives `system_improvement` tasks from top failure categories.
4. Tasks are enqueued through the normal queue path and routed by ownership rules.
5. `Self-Upgrade Guard` blocks self-improvement tasks from editing protected core modules:
	- `src/core/orchestrator.ts`
	- `src/core/orchestrator.ts`
	- `src/core/policy_engine.ts`

Auto-improvable areas remain intentionally bounded:
- Worker prompts
- Analysis tools
- Monitoring tools
- Dev utilities

This keeps BOX self-optimizing without allowing unbounded autonomous mutation of its critical control core.

## 17) Leadership Chain Telemetry Contract

BOX leadership reporting now follows a strict chain:

- Worker (`King David`, `Esther`, etc.) -> `Athena`
- `Athena` -> `Janus`
- `Janus` -> User

### 17.1 Worker -> Athena (`state/worker_activity.json`)

Worker slot telemetry continues under `workers`, and role-centric worker reports are materialized under `roles`.

Role report fields:
- `status`: `idle | running | queued | blocked | failed | parked`
- `current_task`, `task_id`
- `gate_results`: `build`, `test`, `security`, `lint`
- `short_problem`
- `color`: `green | yellow | red`
- `slot`, `last_update`

Color policy:
- `green`: idle or healthy/passed context
- `yellow`: running, queued, parked, cooldown-like progression
- `red`: blocked/failed

### 17.2 Athena -> Janus (`state/athena_summary.json`)

Leader aggregation includes:
- Worker capacity snapshot: `active_workers`, `idle_workers`, `blocked_workers`
- Runtime loop context: `loop_status`, `strategic_due`, `queue_length`
- Retry and park pressure: `retries_total`, `parked_tasks_total`, `fingerprint_parked`
- Health ratio: `health_fraction`
- Fingerprint/loop signals: `fingerprint_summary`
- Per-worker compact status map in `workers`

### 17.3 Janus -> User (`state/janus_dashboard.json`)

Central monitor report includes:
- Global health: `system_status`, `loop_mode`, `strategic_due`
- Queue and backlog pressure: `queue_length`, `backlog_total`
- Problem task list: `blocked_tasks` with `suggested_action`
- Escalation context: `alerts`, `escalation_triggers`
- Embedded `athena_summary`

### 17.4 Dashboard API Exposure

`/api/state` exposes leadership reports under:
- `leadership.athena`
- `leadership.janus`

This enables direct rendering of Worker/Athena/Janus views in live monitoring surfaces
This enables direct rendering of Worker/Athena/Janus views in live monitoring surfaces.

