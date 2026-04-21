/**
 * Shared telemetry threshold constants.
 *
 * Kept in a leaf module (zero project-internal imports) so both cycle_analytics.ts
 * and model_policy.ts can import from a single source of truth without creating a
 * circular dependency via the cycle_analytics → prometheus → learning_policy_compiler
 * → model_policy chain.
 */

/**
 * Minimum number of usable samples required for a task-kind's telemetry to be
 * trusted by the expected-value routing logic.  Below this threshold the ranker
 * falls back to the original model order deterministically.
 *
 * Consumers: buildModelRoutingTelemetry (cycle_analytics.ts),
 *            rankModelsByTaskKindExpectedValue (model_policy.ts).
 */
export const MIN_TELEMETRY_SAMPLE_THRESHOLD = 3;
