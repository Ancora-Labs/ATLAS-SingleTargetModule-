# Atlas Single-Target Extraction Map

## Goal

Create a new public repo that keeps BOX's single-target delivery product surface, while leaving BOX self-development and internal evolution machinery behind.

Target shape:

- `core/` = reusable runtime engine for autonomous delivery
- `single-target/` = target-session lifecycle, onboarding, readiness, prompt overlays
- `interface/` = CLI and optional dashboard

This is not a git-history split first. It is a controlled product extraction.

## First Principle

Do not move code by guessing file-by-file in one big copy.

Do it in three passes:

1. Copy the runtime that is required to boot single-target delivery.
2. Delete self-dev and self-improvement dependencies from that new repo.
3. Re-stabilize imports, config, and startup commands until `box:start` and `box:once` work in the new repo.

## What Moves

These are the modules that form the product runtime and should move first.

### Interface Layer

- `src/cli.ts`
- `src/config.ts`
- `src/dashboard/live_dashboard.ts`
- `src/dashboard/render.ts`
- `src/dashboard/auth.ts`
- `package.json`
- `tsconfig.json`
- `tsconfig.typecheck.json`
- `eslint.config.ts`

### Shared Core Runtime

- `src/core/orchestrator.ts`
- `src/core/daemon_control.ts`
- `src/core/state_tracker.ts`
- `src/core/live_log.ts`
- `src/core/logger.ts`
- `src/core/fs_utils.ts`
- `src/core/checkpoint_engine.ts`
- `src/core/event_schema.ts`
- `src/core/role_registry.ts`
- `src/core/capability_pool.ts`
- `src/core/worker_batch_planner.ts`
- `src/core/dag_scheduler.ts`
- `src/core/dependency_graph_resolver.ts`
- `src/core/plan_contract_validator.ts`
- `src/core/verification_gate.ts`
- `src/core/failure_classifier.ts`
- `src/core/model_policy.ts`
- `src/core/policy_engine.ts`
- `src/core/escalation_queue.ts`
- `src/core/cycle_analytics.ts`
- `src/core/prompt_compiler.ts`
- `src/core/agent_loader.ts`
- `src/core/agent_layer_contract.ts`

### Planning / Review / Worker Runtime

- `src/core/janus_supervisor.ts`
- `src/core/prometheus.ts`
- `src/core/athena_reviewer.ts`
- `src/core/research_scout.ts`
- `src/core/research_synthesizer.ts`
- `src/core/worker_runner.ts`
- `src/workers/run_task.ts`
- `src/providers/coder/copilot_cli_provider.ts`
- `src/providers/coder/fallback_provider.ts`
- `src/providers/reviewer/utils.js`

### Single-Target Product Layer

- `src/core/mode_state.ts`
- `src/core/prompt_overlay.ts`
- `src/core/target_session_state.ts`
- `src/core/target_stage_contract.ts`
- `src/core/target_execution_guard.ts`
- `src/core/target_success_contract.ts`
- `src/core/single_target_startup_guard.ts`
- `src/core/onboarding_runner.ts`
- `src/core/clarification_runtime.ts`

## What Stays In BOX

These are BOX-internal self-evolution surfaces and should not go into Atlas v1.

- `src/core/self_dev_guard.ts`
- `src/core/self_dev_exit_monitor.ts`
- `src/core/self_improvement.ts`
- `src/core/self_improvement_repair.ts`
- `src/core/si_control.ts`
- `src/core/evolution_metrics.ts`
- `src/core/learning_policy_compiler.ts`
- `src/core/strategy_retuner.ts`
- `src/core/compounding_effects_analyzer.ts`
- `src/core/intervention_judge.ts` if used only for BOX internal evolution tuning
- `src/core/intervention_optimizer.ts` pieces that only exist to improve BOX itself

Rule:

If a module's primary job is "make BOX smarter about BOX", leave it behind.

If a module's primary job is "deliver the user's target repo safely", move it.

## What Must Be Split Before Moving

Some files are mixed and should not be copied raw forever.

### `src/cli.ts`

Keep in Atlas:

- `start`
- `stop`
- `once`
- target activation / target status / clarification flow
- `doctor` if it checks user-facing runtime health

Drop from Atlas:

- self-dev toggles
- SI controls
- BOX-internal recovery / park / rebase flows unless they are still needed for target delivery

### `src/core/orchestrator.ts`

Keep in Atlas:

- tactical / strategic execution for target delivery
- planning, Athena review, worker dispatch, target gates, checkpoint resume
- readiness and closure logic for target sessions

Remove or extract behind flags:

- self-improvement loop
- self-dev exit logic
- BOX self-evolution analytics that do not affect target delivery correctness

### `src/core/agent_layer_contract.ts`

Keep the shared core and single-target definitions.

Remove the self-dev profile from Atlas, or make Atlas default directly to single-target runtime behavior.

## Actual Transfer Process

This is the concrete workflow.

### Phase 1: New Repo Bootstrap

1. Create new repo `atlas`.
2. Copy only the product runtime files listed in "What Moves".
3. Copy minimal config and scripts needed to run:
   - `box:start`
   - `box:stop`
   - `box:once`
   - `typecheck`
4. Do not copy `state/`, `tmp_*`, or BOX historical artifacts.

### Phase 2: Compile Failures As Dependency Map

1. Run typecheck in Atlas.
2. Every missing import is classified into one of three buckets:
   - required product dependency -> move it in
   - mixed module -> split source in BOX, then move the product half
   - self-dev only -> replace or delete usage

This is the safest way to discover the real extraction boundary.

### Phase 3: Product Hardening

1. Remove self-dev-only commands from CLI.
2. Remove self-improvement cycle calls from orchestrator.
3. Keep target-session startup guard and checkpoint recovery.
4. Keep dashboard only if you want Atlas to ship with the current operator UI.
5. Rename BOX-specific wording to Atlas branding.

### Phase 4: Product Contract Freeze

Atlas v1 should expose only these stable concepts:

- target repo intake
- target session state
- onboarding and clarification
- planning and dispatch
- worker verification and readiness closure
- dashboard / operator status

It should not expose:

- BOX self-dev
- self-improvement internals
- internal capability evolution metrics
- BOX-specific architectural research loop as a product promise

## How We "Pass" The System To The New Repo

This is the part that usually causes confusion.

We are not transferring a running daemon instance.

We are transferring:

1. Source files
2. Runtime commands
3. Config contract
4. State schema for target sessions
5. Provider wiring

So the move is:

- copy source
- restore imports
- trim commands
- run Atlas against its own fresh `state/`

The old BOX state does not need to move unless you explicitly want session migration.

## Recommended Extraction Strategy

Use a staged copy, not subtree split first.

Recommended order:

1. Bootstrap Atlas repo with package/config/scripts.
2. Copy `src/cli.ts`, `src/config.ts`, `src/core/orchestrator.ts` and immediate dependencies.
3. Copy all single-target modules.
4. Copy worker/provider modules.
5. Run typecheck.
6. Fix import graph until Atlas boots.
7. Delete or isolate remaining self-dev pieces.

## Minimum Viable Atlas v1

If you want the fastest clean product extraction, Atlas v1 should include only:

- CLI start/stop/once
- single-target activation
- target session state
- onboarding + clarification
- Prometheus + Athena + worker dispatch
- verification + readiness closure
- optional dashboard

Everything else can stay in BOX until needed.

## Practical Next Step

Before any repo copy, produce a dependency-trim matrix with three columns:

- move as-is
- move after split
- do not move

That matrix should be built starting from:

- `src/cli.ts`
- `src/core/orchestrator.ts`
- `src/core/target_session_state.ts`
- `src/core/onboarding_runner.ts`
- `src/core/worker_runner.ts`

Those five files define almost the entire product boundary.

