/**
 * Shared utilities for reviewer providers.
 * Provides type-safe helpers for parsing and validating LLM provider responses.
 */

/**
 * Return val as-is if it is an Array; otherwise return an empty array.
 * @param {unknown} val
 * @returns {Array}
 */
export function safeArray(val) {
  return Array.isArray(val) ? val : [];
}

/**
 * Attempt to parse a JSON object from a raw string.
 * First tries direct JSON.parse, then looks for the first {...} block in the text.
 * Returns null on failure.
 * @param {unknown} raw
 * @returns {object | null}
 */
export function tryExtractJson(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through to extraction
  }
  const match = s.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    return null;
  }
  return null;
}

/**
 * Validate and normalize a plan payload from a reviewer provider.
 * Returns { tasks } where tasks is the valid task array, or the fallback if invalid.
 *
 * Filtering rules:
 *   - tasks must be an array
 *   - each task must have a non-empty title, a numeric id, and a kind string
 *   - kind is lowercased
 *
 * @param {unknown} payload - parsed provider response object
 * @param {Array} fallback  - returned when payload is invalid or tasks array is empty
 * @returns {{ tasks: Array }}
 */
export function validatePlan(payload, fallback) {
  if (!payload || typeof payload !== "object") {
    return { tasks: fallback };
  }
  const raw = payload.tasks;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { tasks: fallback };
  }
  const valid = raw.filter(
    (t) =>
      t &&
      typeof t === "object" &&
      typeof t.id === "number" &&
      typeof t.title === "string" &&
      t.title.trim().length > 0 &&
      typeof t.kind === "string"
  ).map((t) => ({
    ...t,
    kind: t.kind.toLowerCase(),
  }));
  if (valid.length === 0) {
    return { tasks: fallback };
  }
  return { tasks: valid };
}

/**
 * Validate and normalize a binary reviewer decision (approved / rejected).
 * Returns fallback with _source="fallback" and _fallbackReason if the payload is invalid.
 *
 * @param {unknown} payload  - parsed provider response
 * @param {{ approved: boolean; reason: string }} fallback
 * @returns {{ approved: boolean; reason: string; _source?: string; _fallbackReason?: string }}
 */
export function validateDecision(payload, fallback) {
  if (!payload || typeof payload !== "object" || typeof payload.approved !== "boolean") {
    const _fallbackReason =
      payload && typeof payload === "object" && "approved" in payload
        ? "approved field is not boolean"
        : "payload is null or not an object";
    return { ...fallback, _source: "fallback", _fallbackReason };
  }
  return {
    approved: payload.approved,
    reason: typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason
      : fallback.reason,
  };
}

/**
 * Validate and normalize an Opus model allowance decision.
 * Returns fallback with _source="fallback" and _fallbackReason if the payload is invalid.
 *
 * @param {unknown} payload  - parsed provider response
 * @param {{ allowOpus: boolean; reason?: string }} fallback
 * @returns {{ allowOpus: boolean; reason: string; _source?: string; _fallbackReason?: string }}
 */
export function validateOpusDecision(payload, fallback) {
  if (!payload || typeof payload !== "object" || typeof payload.allowOpus !== "boolean") {
    const _fallbackReason =
      payload && typeof payload === "object" && "allowOpus" in payload
        ? "allowOpus field is not boolean"
        : "payload is null or not an object";
    const reason =
      typeof fallback?.reason === "string" && fallback.reason.trim()
        ? fallback.reason
        : "no reason provided";
    return { ...fallback, reason, _source: "fallback", _fallbackReason };
  }
  const reason =
    (typeof payload.reason === "string" && payload.reason.trim()
      ? payload.reason
      : null) ??
    (typeof fallback?.reason === "string" && fallback.reason.trim()
      ? fallback.reason
      : "no reason provided");
  return { allowOpus: payload.allowOpus, reason };
}
