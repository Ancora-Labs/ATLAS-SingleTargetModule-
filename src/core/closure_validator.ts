/**
 * closure_validator.js — Validates that escalated items are resolved within SLA.
 *
 * Escalation entries that remain open beyond the SLA window are promoted
 * to critical severity. This prevents the escalation queue from becoming
 * a graveyard of forgotten items.
 *
 * Integration: called by orchestrator at cycle start to audit stale escalations.
 */

/** Default SLA in milliseconds (24 hours). */
export const DEFAULT_SLA_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {object} SLAViolation
 * @property {string} title — escalation item title
 * @property {string} source — original source
 * @property {number} ageMs — how old the item is
 * @property {string} ageHuman — human-readable age
 */

/**
 * Check escalation queue entries for SLA violations.
 *
 * @param {object[]} escalations — entries from escalation_queue.json
 * @param {{ slaMs?: number, now?: number }} opts
 * @returns {SLAViolation[]}
 */
export function checkClosureSLA(escalations, opts: any = {}) {
  if (!Array.isArray(escalations)) return [];

  const slaMs = opts.slaMs || DEFAULT_SLA_MS;
  const now = opts.now || Date.now();

  /** @type {SLAViolation[]} */
  const violations = [];

  for (const entry of escalations) {
    if (!entry || entry.resolved) continue;

    const createdAt = entry.createdAt || entry.detectedAt || entry.escalatedAt;
    if (!createdAt) continue;

    const ageMs = now - new Date(createdAt).getTime();
    if (ageMs > slaMs) {
      const hours = Math.round(ageMs / (60 * 60 * 1000));
      violations.push({
        title: entry.title || "untitled escalation",
        source: entry.source || "unknown",
        ageMs,
        ageHuman: `${hours}h`
      });
    }
  }

  return violations;
}
