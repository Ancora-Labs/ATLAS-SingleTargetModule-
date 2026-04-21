# BOX Event Sampling Strategy

**Path:** `docs/sampling_strategy.md`  
**Status:** Active — required by T-011 event taxonomy (AC4)  
**Completeness check:** This file must contain all five required sections (Purpose, Strategy, Domains, Sensitive Fields, CI Check). CI will assert their presence.

---

## 1. Purpose

This document defines when, how, and at what rate BOX emits observability events.
It is the authoritative reference for log aggregators, dashboards, and future sampling
configuration. All emitted events conform to the schema defined in
`src/core/event_schema.ts`.

---

## 2. Sampling Strategy

BOX currently emits **all events** (sample rate = 1.0). No probabilistic or
rate-based downsampling is applied at the source. This is intentional during Phase 2
baseline observability: every major loop transition, billing record, and governance
action must be captured to establish usage baselines.

### Planned phases

| Phase | Strategy | Rationale |
|-------|----------|-----------|
| 2 (current) | 100% — emit all events | Baseline; no volume to justify sampling |
| 3 | Head-based sampling per `correlationId` | Once per-cycle event fan-out is measurable |
| 4 | Tail-based sampling on error/degraded status | Retain all failure events; sample success events at 10% |

### Overriding sampling per domain

No per-domain override is implemented yet. Future configuration will be added to
`box.config.json` under the key `observability.sampling.<domain>` as a float
between 0.0 and 1.0.

---

## 3. Domains and Event Rates

All six canonical domains emit events. Approximate expected rates during a single
orchestration cycle:

| Domain | Events per cycle | Notes |
|--------|-----------------|-------|
| `orchestration` | 2–20 | One per pipeline stage transition |
| `planning` | 2–6 | Prometheus analysis + Athena plan review |
| `verification` | 1–4 | Athena postmortem + gate results |
| `policy` | 0–5 | Budget checks, model selection, rate-limit hits |
| `billing` | 1–10 | One per LLM call (Claude + Copilot) |
| `governance` | 0–2 | Schema migrations, self-improvement runs |

---

## 4. Sensitive Field Handling

The `SENSITIVE_FIELD_DENYLIST` in `src/core/event_schema.ts` defines all field names
that are **always redacted** before event emission. The sentinel value `[REDACTED]`
replaces any matching field value.

Redaction is applied in `redactSensitiveFields()` before the event payload reaches
any sink (stdout, log file, dashboard). Callers **must not** embed raw token or key
values in event payloads.

Current denylist (see source for authoritative list):
- `token`, `apikey`, `api_key`, `secret`, `password`, `authorization`, `bearer`
- `credential`, `credentials`, `auth`, `cookie`, `sessionid`, `accesstoken`
- `refreshtoken`, `privatekey`, `clientsecret`, `githubtoken`, `github_token`
- `anthropic_api_key`, `claude_api_key`, `openai_api_key`

Adding new sensitive fields: edit `SENSITIVE_FIELD_DENYLIST` in
`src/core/event_schema.ts` and add a corresponding test in
`tests/core/event_schema.test.ts`.

---

## 5. CI Completeness Check

The test suite (`tests/core/event_schema.test.ts`) asserts that this file:

1. Exists at `docs/sampling_strategy.md`
2. Contains the five required section headings:
   - `## 1. Purpose`
   - `## 2. Sampling Strategy`
   - `## 3. Domains and Event Rates`
   - `## 4. Sensitive Field Handling`
   - `## 5. CI Completeness Check`

This makes AC4 (sampling strategy documented) machine-verifiable and not reliant
on code review alone.
