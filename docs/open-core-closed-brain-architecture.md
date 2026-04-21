# Atlas Open-Core / Closed-Brain Architecture

## Goal

Atlas should be publicly installable and usable with the full product surface while keeping the highest-value decision logic outside the public repository.

This is not a paywall design.

This is an execution-boundary design:

- everyone can run Atlas
- everyone can access the same feature surface
- critical decision logic is executed remotely
- the public repo contains the product shell, not the full product brain

## Non-Negotiable Constraint

If code is shipped to the user's machine and executed there, it is accessible.

Because of that, anything that must stay private cannot be delivered as local source code, local config, local WASM, or obfuscated bundles. Those only increase extraction cost; they do not create a real protection boundary.

The only durable protection boundary is:

- public/local shell
- private/remote execution

## Product Model

Atlas is split into two layers.

### 1. Public Atlas Runtime

This layer lives in the public GitHub repository.

It includes:

- CLI entrypoints and operator UX
- dashboard and state rendering
- workspace/session lifecycle
- repo scanning and file packaging
- command routing shell
- worker execution shell
- event/log/state schemas
- public-safe fallback behaviors
- test infrastructure and build tooling

This layer is responsible for:

- collecting local project context
- preparing bounded packets
- calling remote decision endpoints when required
- applying returned decisions to the local workspace

### 2. Private Brain Layer

This layer does not live in the public repo.

It runs behind a private service boundary.

It includes:

- high-value evaluator logic
- final scoring heuristics
- routing weights and hidden thresholds
- calibration packs
- benchmark and replay comparison logic
- policy packs that should not be cloned as static source
- high-value prompt assembly or prompt transformation logic

This layer is responsible for:

- making critical decisions
- validating risky actions
- returning bounded decision packets
- never exposing internal tuning logic directly to the client

## What Stays Public And Local

The following Atlas modules should remain in the public repo and run locally.

### Operator Surface

- CLI commands
- local command parsing
- dashboard UI
- session and target workspace management
- state file generation
- local logs and progress views

### Execution Shell

- orchestration loop shell
- worker dispatch shell
- packet construction shell
- artifact collection
- repository scan and local diff inspection
- build/test invocation wrappers

### Contracts And Schemas

- packet schemas
- result schemas
- event schemas
- target-session schemas
- public documentation
- tests for public runtime behavior

### Public-Safe Decision Helpers

- deterministic parsing helpers
- non-sensitive batching helpers
- public-safe fallback rules
- feature toggles that are not strategic IP

## What Must Move Behind The Private Boundary

The following should be treated as remote/private if the goal is to keep the important logic uncloneable.

### Strategic Decision Engines

- Janus final strategic decision scoring
- Prometheus plan ranking weights
- Athena final approval/rejection policy packs
- trust-boundary scoring that encodes high-value tuning

### Hidden Quality Logic

- hidden thresholds for plan acceptance
- risk weighting
- hidden penalty/boost rules
- evaluator calibration logic
- benchmark similarity or replay comparison scoring

### Private Knowledge Assets

- curated benchmark corpora
- replay ground truth sets
- privileged calibration fixtures
- high-value correction memory
- high-value private prompt overlays

### Private Prompt Intelligence

Public prompts can exist.

But the following should be private if they are part of the real moat:

- final prompt transformation rules
- hidden ranking or repair overlays
- private critique passes
- calibration-specific instruction packs

## What Must Not Be Kept Private

The following should stay public because hiding them adds little value and creates unnecessary product fragility.

- CLI grammar
- build system
- dashboard rendering
- public file structure
- local test harnesses
- basic orchestration shell
- state schema
- logs and progress format

## Request Boundary Rule

The public runtime may send context to the private brain, but only in bounded packets.

A bounded packet should contain:

- active command or decision type
- reduced repository context
- relevant file excerpts
- current stage and risk envelope
- explicit requested output schema

It should not send:

- unlimited workspace dumps by default
- unrelated secrets
- full local environment snapshots without need

## Initial Cloudflare Worker Design

The first implementation should be intentionally small.

Cloudflare Workers is used as a private execution edge, not as a billing gate.

### Initial Endpoints

#### `POST /v1/janus/decide`

Purpose:

- receive bounded cycle context
- return strategic decision packet

#### `POST /v1/prometheus/evaluate-plan`

Purpose:

- accept normalized planning context
- apply hidden ranking and threshold logic
- return ranked, bounded plan decision data

#### `POST /v1/athena/review`

Purpose:

- apply hidden review/evaluator logic
- return approve/reject/repair packet

#### `POST /v1/policy/check`

Purpose:

- run sensitive trust or policy checks
- return pass/block plus minimal evidence payload

## Initial Flow

1. User runs Atlas locally.
2. Atlas scans the local repo and prepares a bounded packet.
3. Atlas sends only the relevant packet to a Cloudflare Worker endpoint.
4. The Worker authenticates the request.
5. The Worker loads private policy/config/calibration material from private bindings or storage.
6. The Worker runs the critical decision logic.
7. The Worker returns only a bounded result packet.
8. Atlas applies that result locally and continues normal execution.

## Authentication Model

This is not a paywall requirement.

Authentication is still needed for:

- abuse protection
- rate limiting
- request tracing
- secret separation

Initial acceptable models:

- simple API token per installation
- GitHub sign-in plus issued token
- invite token during early private rollout

Authentication answers "who is calling".

It does not have to mean "who paid".

## Storage Model For Private Brain

The first Worker should keep the storage model simple.

Recommended early split:

- Worker secrets: API keys, signing secrets, internal auth secrets
- KV: profile versions, lightweight policy bundles, feature flags
- D1: request ledger, audit rows, rollout states, calibration version tracking
- R2 only if large corpora or replay artifacts become too large for KV/D1 patterns

## Rollout Strategy

### Phase 1

- public repo contains full product shell
- private Worker handles only the highest-value decisions
- local runtime still owns everything else

### Phase 2

- move Athena hidden evaluator logic remote
- move Janus strategic scoring remote
- move Prometheus hidden ranking packs remote

### Phase 3

- move benchmark comparison and calibration packs fully remote
- keep client packets small and schema-driven

## Decision Standard

When deciding whether a module belongs in the public repo or private brain, use this rule:

- if the module is mostly operator UX, plumbing, or deterministic shell behavior, keep it public
- if the module's value comes from tuning, hidden weighting, evaluator judgment, calibration, or replay intelligence, move it private

## Final Summary

Atlas should not try to hide shipped code.

Atlas should instead:

- ship the whole product shell publicly
- execute the highest-value decision logic remotely
- preserve the full feature surface for all users
- protect the important logic by never shipping it as local source
