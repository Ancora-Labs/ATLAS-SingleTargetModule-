# Failure Taxonomy — BOX v1.0.0

**File**: `src/core/failure_classifier.ts`  
**Schema version**: `FAILURE_CLASSIFIER_SCHEMA_VERSION = 1`  
**Taxonomy version**: `CLASSIFIER_TAXONOMY_VERSION = "1.0.0"`

---

## Purpose

The failure classifier assigns every failed or blocked worker task to exactly one semantic failure class, with a confidence score and structured evidence.  The classification feeds intervention prioritization by adjusting `successProbability` before the EV-based scheduler ranks tasks.

---

## Failure Classes

| Class | Value | Description | Retry prognosis |
|---|---|---|---|
| Environment | `environment` | OS/filesystem/network/infra failures | May self-resolve; retry |
| Policy | `policy` | Policy gate rejections, access violations | Human intervention required |
| Verification | `verification` | Verification gate failures, rework exhausted | Rework needed |
| Model | `model` | AI model errors, rate limits, quota exceeded | May clear; retry next cycle |
| External API | `external_api` | GitHub/external API failures, HTTP 4xx/5xx | May clear; retry |
| Logic Defect | `logic_defect` | Code bugs, unexpected behaviour | Code fix required |

---

## Confidence Threshold

```
LOW_CONFIDENCE_THRESHOLD = 0.6
```

A classification with `confidence < 0.6` sets `flagged: true` to indicate it should be reviewed before the schedule acts on it.  Tests must use this constant — not a literal `0.6` — to remain in sync if the threshold changes.

---

## Classification Result Schema

Every classification result (`ClassificationResult`) contains:

| Field | Type | Source |
|---|---|---|
| `schemaVersion` | integer (1) | constant |
| `classifierVersion` | string ("1.0.0") | constant |
| `taskId` | string \| null | `input.taskId` |
| `primaryClass` | FAILURE_CLASS enum | classifier |
| `confidence` | number [0.0, 1.0] | classifier |
| `flagged` | boolean | `confidence < 0.6` |
| `evidence` | object | see below |
| `classifiedAt` | ISO 8601 string | `new Date().toISOString()` |

### Evidence Schema

| Field | Type | Source |
|---|---|---|
| `error_message` | string | `input.errorMessage` (or `""`) |
| `stack_trace` | string | `input.stackTrace` (or `""`) |
| `log_lines` | string[] (max 10) | `input.logLines` (or `[]`) |
| `blocking_reason_class` | string \| null | `input.blockingReasonClass` (or `null`) |
| `worker_status` | string | `input.workerStatus` |

---

## Classification Priority

1. **Known `BLOCKING_REASON_CLASS`** (highest confidence, 0.85–0.95)
2. **Error message / stack trace pattern matching** (0.65–0.85)
3. **`workerStatus` fallback** (lowest confidence, 0.40–0.50)

Low tier-3 results are always `flagged: true` since they lack strong evidence.

---

## Intervention Prioritization Integration

`applyClassificationToSuccessProbability(successProbability, classification)` in `failure_classifier.ts` adjusts a task's `successProbability` before the intervention optimizer ranks it:

| Class | Adjustment | Formula |
|---|---|---|
| `environment` | subtract 0.15 | `max(0.05, sp - 0.15)` |
| `policy` | multiply 0.20 | `max(0.05, sp × 0.20)` |
| `verification` | subtract 0.20 | `max(0.05, sp - 0.20)` |
| `model` | subtract 0.15 | `max(0.05, sp - 0.15)` |
| `external_api` | subtract 0.15 | `max(0.05, sp - 0.15)` |
| `logic_defect` | multiply 0.25 | `max(0.05, sp × 0.25)` |

If `flagged: true`, an additional `−0.05` penalty is applied after the primary adjustment.  Floor: `0.05` (never zero).

### Code path (AC #5)

```
runInterventionOptimizer(interventions, budget, { failureClassifications })
  ↓
applyClassificationsToInterventions  [internal loop]
  ↓  per matched role: applyClassificationToSuccessProbability()
rankInterventions                    [lower SP → lower EV → lower rank]
  ↓
reconcileBudgets                     [lower-ranked tasks rejected first under budget pressure]
```

The `failureClassificationsApplied` field in the optimizer result records how many interventions had their SP adjusted.

---

## Persistence

Classifications are appended to:

```
state/failure_classifications.json
{
  schemaVersion: 1,
  updatedAt: ISO,
  entries: ClassificationResult[]   // max 500
}
```

`appendFailureClassification(config, classification)` in `state_tracker.ts` performs the write.  Write failures return `{ ok: false, reason }` — never thrown.

---

## Validation Reason Codes

| Code | Meaning |
|---|---|
| `MISSING_INPUT` | Input is `null` or `undefined` |
| `INVALID_TYPE` | Input is not a plain object |
| `MISSING_FIELD` | Required field `workerStatus` is absent |
| `INVALID_FIELD` | `workerStatus` is empty or not a string |

---

## Versioning Policy

- Bump `FAILURE_CLASSIFIER_SCHEMA_VERSION` (integer) when `ClassificationResult` fields change incompatibly.
- Bump `CLASSIFIER_TAXONOMY_VERSION` (semver string) when class definitions, confidence formulas, or adjustment rules change.
