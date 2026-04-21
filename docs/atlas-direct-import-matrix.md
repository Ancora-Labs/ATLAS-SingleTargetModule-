# Atlas Direct Import Matrix

## Scope

This is the first technical matrix for Atlas extraction.

It focuses on the five boundary files that define most of the product surface:

- `src/cli.ts`
- `src/core/orchestrator.ts`
- `src/core/target_session_state.ts`
- `src/core/onboarding_runner.ts`
- `src/core/worker_runner.ts`

For each file, imports are grouped into:

- `keep` = move with Atlas
- `replace/split` = Atlas needs the capability, but not the current BOX-coupled implementation as-is
- `cut` = do not carry into Atlas

## 1. `src/cli.ts`

### keep

- `./config.js`
- `./core/orchestrator.js`
- `./core/doctor.js`
- `./core/target_session_state.js`
- `./core/clarification_runtime.js`
- `./core/single_target_startup_guard.js`
- `./core/onboarding_runner.js`
- `./core/daemon_control.js`

### replace/split

- `./core/mode_state.js`

Reason:

Atlas still needs mode handling, but it should be reduced to product-facing modes only. `self_dev` should not remain in the Atlas public runtime.

### cut

- `./core/si_control.js`

Reason:

This is BOX self-improvement control, not target delivery.

### extraction note

Atlas `cli.ts` should keep:

- `start`
- `stop`
- `once`
- activation and clarification flow
- target status / product status output

Atlas `cli.ts` should lose:

- SI commands
- self-dev operational controls
- BOX-only maintenance commands that do not help target delivery

## 2. `src/core/orchestrator.ts`

### keep

- `./state_tracker.js`
- `./daemon_control.js`
- `../config.js`
- `./janus_supervisor.js`
- `./prometheus.js`
- `./athena_reviewer.js`
- `./worker_runner.js`
- `./project_lifecycle.js`
- `./logger.js`
- `./event_schema.js`
- `./fs_utils.js`
- `./pipeline_progress.js`
- `./escalation_queue.js`
- `./slo_checker.js`
- `./cycle_analytics.js`
- `./parser_baseline_recovery.js`
- `./parser_replay_harness.js`
- `./schema_registry.js`
- `./governance_freeze.js`
- `./closure_validator.js`
- `./capacity_scoreboard.js`
- `./delta_analytics.js`
- `./capability_pool.js`
- `./doctor.js`
- `./plan_contract_validator.js`
- `./dependency_graph_resolver.js`
- `./rollback_engine.js`
- `./live_log.js`
- `./worker_batch_planner.js`
- `./dag_scheduler.js`
- `./agent_loader.js`
- `./role_registry.js`
- `./prompt_compiler.js`
- `./architecture_drift.js`
- `./ac_compiler.js`
- `./carry_forward_ledger.js`
- `./budget_controller.js`
- `./intervention_optimizer.js`
- `./intervention_judge.js`
- `./autonomy_band_monitor.js`
- `./mode_state.js`
- `./target_session_state.js`
- `./onboarding_runner.js`
- `./evidence_envelope.js`
- `./research_scout.js`
- `./research_synthesizer.js`
- `./verification_gate.js`
- `./failure_classifier.js`
- `./agent_control_plane.js`
- `./checkpoint_engine.js`
- `./model_policy.js`
- `./policy_engine.js`
- `./governance_contract.js`
- `./single_target_startup_guard.js`
- `./target_success_contract.js`
- `./target_stage_contract.js`

### replace/split

- `./mode_state.js`
- `./agent_loader.js`
- `./policy_engine.js`
- `./governance_contract.js`
- `./intervention_optimizer.js`
- `./intervention_judge.js`

Reason:

These belong in Atlas conceptually, but they may contain BOX-specific assumptions, naming, or self-evolution-oriented policy surfaces that should be trimmed.

### cut

- `./self_improvement.js`
- `./self_dev_exit_monitor.js`
- `./evolution_metrics.js`
- `./strategy_retuner.js`
- `./compileLessonsToPolicies` path from `./learning_policy_compiler.js` if used only for BOX self-evolution feedback

### extraction note

Atlas orchestrator should keep the delivery loop and drop all code whose purpose is "improve BOX itself after cycle completion".

This means the post-completion section in Atlas should end around:

- cleanup
- finalize target success
- analytics and observability

It should not continue into self-improvement or self-dev exit decisions.

## 3. `src/core/target_session_state.ts`

### keep

- `node:fs/promises`
- `node:path`
- `node:crypto`
- `./fs_utils.js`
- `./mode_state.js`

### replace/split

- `./mode_state.js`

Reason:

Atlas should keep the session pointer integration but not inherit self-dev mode semantics.

### cut

- none in the current top-level import graph

### extraction note

This file is close to product-pure already and should be one of the first modules copied to Atlas.

## 4. `src/core/onboarding_runner.ts`

### keep

- `node:fs/promises`
- `node:path`
- `./fs_utils.js`
- `./agent_loader.js`
- `./state_tracker.js`
- `./target_session_state.js`

### replace/split

- `./agent_loader.js`

Reason:

Atlas still needs agent bootstrapping and output parsing, but BOX-specific contract loading should be reduced to the public product surface.

### cut

- none from the current top-level imports

### extraction note

Onboarding is already target-product-facing. The main likely cleanup is agent/profile wiring, not business logic.

## 5. `src/core/worker_runner.ts`

### keep

- `node:path`
- `node:fs/promises`
- `node:crypto`
- `node:fs`
- `./fs_utils.js`
- `./schema_registry.js`
- `./role_registry.js`
- `./state_tracker.js`
- `./agent_loader.js`
- `./verification_profiles.js`
- `./verification_command_registry.js`
- `./verification_gate.js`
- `./checkpoint_engine.js`
- `./model_policy.js`
- `./policy_engine.js`
- `./prompt_compiler.js`
- `./project_scanner.js`
- `./prompt_overlay.js`
- `./target_execution_guard.js`
- `./target_session_state.js`
- `./escalation_queue.js`
- `./lineage_graph.js`
- `./event_schema.js`
- `./failure_classifier.js`
- `./retry_strategy.js`
- `./trust_boundary.js`
- `./logger.js`
- `./cycle_analytics.js`
- `./daemon_control.js`

### replace/split

- `./agent_loader.js`
- `./policy_engine.js`
- `./model_policy.js`
- `./prompt_overlay.js`

Reason:

All four belong in Atlas, but each may contain BOX-specific profiles, policy flags, or mixed self-dev wording that should be cleaned while extracting.

### cut

- `./self_dev_guard.js`

Reason:

Atlas should not carry BOX self-dev protection boundaries. Atlas needs only target execution boundaries.

### extraction note

`worker_runner.ts` is the most important runtime file after `orchestrator.ts`. Atlas should preserve its target execution behavior and remove self-dev branch protection behavior.

## First Extraction Order

If we were to begin code transfer right now, the safest order is:

1. `src/config.ts`
2. `src/core/target_session_state.ts`
3. `src/core/onboarding_runner.ts`
4. `src/core/worker_runner.ts`
5. `src/core/orchestrator.ts`
6. `src/cli.ts`

Reason:

This order lets Atlas gain product state first, then onboarding, then execution, then orchestration, then the CLI shell.

## Practical Rule For Atlas

If an import exists to protect, evaluate, or evolve BOX itself, cut it.

If an import exists to deliver and verify a target repo, keep it.

If an import does both, split it before Atlas release.
