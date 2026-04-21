# Atlas Dependency-Trim Matrix

## Why This Exists

Atlas cannot be created by copying BOX as-is.

Reason:

- single-target delivery is real product behavior
- self-improvement and self-dev logic still hook into the same runtime
- if we copy the whole runtime without trimming those hooks, Atlas will inherit BOX-internal behavior and architectural noise

The main current risk is visible in:

- `src/core/orchestrator.ts` importing and running `self_improvement.js`
- `src/core/orchestrator.ts` importing and running `self_dev_exit_monitor.js`
- `src/cli.ts` importing `si_control.js`

So Atlas must be an extraction with dependency trimming, not a raw fork.

## Decision Rules

### Move As-Is

Use this when the file's primary job is user-facing single-target delivery and it does not pull BOX-self-evolution as a required runtime dependency.

### Move After Split

Use this when the file is important to Atlas but currently mixes:

- single-target delivery logic
- shared runtime logic
- BOX self-dev or self-improvement logic

### Do Not Move

Use this when the file's main purpose is improving BOX itself rather than delivering a user's target repo.

## First-Pass Matrix

| Path | Decision | Why |
| --- | --- | --- |
| `src/config.ts` | Move as-is | Atlas still needs env/config normalization and runtime config loading. |
| `package.json` | Move after split | Scripts and dependencies are mostly reusable, but BOX-only scripts should be removed. |
| `src/cli.ts` | Move after split | Atlas needs start/stop/once/activate, but CLI still imports SI controls and BOX-internal command surfaces. |
| `src/core/orchestrator.ts` | Move after split | Core dispatch engine is required, but it currently runs self-improvement and self-dev exit paths. |
| `src/core/daemon_control.ts` | Move as-is | Atlas still needs daemon pid, stop, reload, and safe single-daemon control. |
| `src/core/state_tracker.ts` | Move as-is | Single-target progress, alerts, and state logging are product runtime features. |
| `src/core/live_log.ts` | Move as-is | Runtime observability remains useful in Atlas. |
| `src/core/logger.ts` | Move as-is | Shared runtime utility. |
| `src/core/mode_state.ts` | Move after split | Atlas needs mode state, but likely only `single_target_delivery` and maybe `idle`; self-dev mode should be removed. |
| `src/core/prompt_overlay.ts` | Move after split | Atlas needs prompt assembly, but self-dev overlay branches should be deleted. |
| `src/core/agent_layer_contract.ts` | Move after split | Shared core and single-target profile belong in Atlas; self-dev profile does not. |
| `src/core/target_session_state.ts` | Move as-is | This is core Atlas product state. |
| `src/core/target_stage_contract.ts` | Move as-is | Single-target safety contract belongs directly in Atlas. |
| `src/core/target_execution_guard.ts` | Move as-is | Product runtime safety boundary for target execution. |
| `src/core/target_success_contract.ts` | Move as-is | Atlas still needs delivery closure and readiness evaluation. |
| `src/core/single_target_startup_guard.ts` | Move as-is | Atlas startup should enforce single-target prerequisites directly. |
| `src/core/onboarding_runner.ts` | Move as-is | Atlas needs onboarding and readiness shaping. |
| `src/core/clarification_runtime.ts` | Move as-is | Atlas needs clarification flow. |
| `src/core/worker_runner.ts` | Move as-is | Core delivery execution surface. |
| `src/workers/run_task.ts` | Move as-is | Worker entrypoint still required. |
| `src/providers/coder/copilot_cli_provider.ts` | Move as-is | Main implementation provider for Atlas runtime. |
| `src/providers/coder/fallback_provider.ts` | Move as-is | Safe runtime fallback. |
| `src/providers/reviewer/utils.js` | Move as-is | Shared reviewer/provider helper layer. |
| `src/core/janus_supervisor.ts` | Move after split | Strategic decision layer still useful, but any BOX-self signals should be removed. |
| `src/core/prometheus.ts` | Move after split | Planning engine is needed, but BOX self-improvement planning language and assumptions need trimming. |
| `src/core/athena_reviewer.ts` | Move after split | Review layer is needed, but self-dev-specific review assumptions must go. |
| `src/core/research_scout.ts` | Move after split | Useful if Atlas keeps research-assisted planning, but BOX-specific research obligations should be removed. |
| `src/core/research_synthesizer.ts` | Move after split | Same reason as scout. |
| `src/dashboard/live_dashboard.ts` | Move as-is | Optional, but safe to keep as Atlas operator UI. |
| `src/dashboard/render.ts` | Move as-is | Dashboard dependency. |
| `src/dashboard/auth.ts` | Move as-is | Dashboard dependency. |
| `src/core/self_dev_guard.ts` | Do not move | BOX self-dev protection wall, not an Atlas product feature. |
| `src/core/self_dev_exit_monitor.ts` | Do not move | Self-dev marginal return policy is BOX-internal. |
| `src/core/self_improvement.ts` | Do not move | This is BOX evolution logic, not target delivery runtime. |
| `src/core/self_improvement_repair.ts` | Do not move | Repair path for BOX self-improvement loop. |
| `src/core/si_control.ts` | Do not move | Directly controls BOX self-improvement. |
| `src/core/evolution_metrics.ts` | Do not move | Measures BOX evolution outcomes. |
| `src/core/learning_policy_compiler.ts` | Do not move | BOX learns from its own failures here. |
| `src/core/strategy_retuner.ts` | Do not move | Internal BOX adaptation logic. |
| `src/core/compounding_effects_analyzer.ts` | Do not move | Internal self-evolution analysis. |

## Immediate Split Targets

These are the highest-value files to split first because they control the Atlas boundary.

### `src/core/orchestrator.ts`

Keep in Atlas:

- target-session startup and checkpoint resume
- Janus -> Prometheus -> Athena -> worker loop
- dispatch, batching, verification, readiness, closure

Remove from Atlas:

- `runSelfImprovementCycle`
- `shouldTriggerSelfImprovement`
- `evaluateSelfDevExit`
- self-improvement state writes and logs

### `src/cli.ts`

Keep in Atlas:

- `start`
- `stop`
- `once`
- activation wizard
- clarification flow
- doctor if still product-facing

Remove from Atlas:

- SI control commands and logs
- BOX-internal recovery surfaces not needed for target delivery

### `src/core/mode_state.ts`

Atlas should probably reduce mode state to:

- `single_target_delivery`
- `idle`

Self-dev mode should not exist in Atlas v1.

### `src/core/prompt_overlay.ts`

Atlas should keep:

- single-target overlay
- stage overlay

Atlas should remove:

- self-dev overlay branches

## What This Means For Your Question

Yes, if we moved BOX blindly, Atlas would create problems because orchestration still contains self-improvement hooks even during single-target operation.

But if we follow this matrix, Atlas does not inherit that behavior because the split happens at the files that currently mix the concerns.

So the safe extraction model is:

1. move Atlas-facing runtime files
2. split mixed files
3. leave self-improvement stack behind

## Next Matrix Pass

The next useful pass is a dependency trace starting from these five files:

- `src/cli.ts`
- `src/core/orchestrator.ts`
- `src/core/target_session_state.ts`
- `src/core/onboarding_runner.ts`
- `src/core/worker_runner.ts`

That pass should expand each file into:

- direct imports to keep
- direct imports to replace
- direct imports to cut

That will become the implementation checklist for creating the Atlas repo.
