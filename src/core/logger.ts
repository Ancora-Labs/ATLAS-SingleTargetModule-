import path from "node:path";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { buildEvent, EVENT_ERROR_CODE } from "./event_schema.js";

export function info(message, data = undefined) {
  if (data === undefined) {
    console.log(`[atlas] ${message}`);
    return;
  }
  console.log(`[atlas] ${message}`, data);
}

export function warn(message, data = undefined) {
  if (data === undefined) {
    console.warn(`[atlas][warn] ${message}`);
    return;
  }
  console.warn(`[atlas][warn] ${message}`, data);
}

export function error(message, data = undefined) {
  if (data === undefined) {
    console.error(`[atlas][error] ${message}`);
    return;
  }
  console.error(`[atlas][error] ${message}`, data);
}

function inferLiveLogMode(stateDir) {
  try {
    const sessionPath = path.join(stateDir, "active_target_session.json");
    if (!existsSync(sessionPath)) return "self";
    const raw = JSON.parse(readFileSync(sessionPath, "utf8"));
    return raw?.sessionId ? "target" : "self";
  } catch {
    return "self";
  }
}

export function chatLog(stateDir, speaker, message) {
  try {
    const normalizedSpeaker = String(speaker || "worker").trim();
    const body = String(message || "").trimEnd();
    if (!body.trim()) return;
    const mode = inferLiveLogMode(stateDir);
    const roleLine = `${body} [mode=${mode}]\n`;
    const combinedLine = `[${normalizedSpeaker}] ${body} [mode=${mode}]\n`;
    appendFileSync(path.join(stateDir, "leadership_live.txt"), combinedLine, "utf8");
    const slug = normalizedSpeaker.toLowerCase().replace(/\s+/g, "-");
    appendFileSync(path.join(stateDir, `live_worker_${slug}.log`), roleLine, "utf8");
  } catch { /* non-critical */ }
}

/**
 * Emit a typed, versioned, redacted observability event to stdout as JSON.
 *
 * The event is validated against EVENT_SHAPE_SCHEMA before emission.
 * Sensitive fields in payload are redacted via SENSITIVE_FIELD_DENYLIST.
 * If validation fails, an error is logged and the function returns the
 * validation result — it never throws, so emission failures never block
 * the caller's critical path.
 *
 * Degraded behavior: if the event cannot be built, status="degraded" and
 * reason code is set in the returned result (no silent fallback).
 *
 * @param {string} eventName   — one of EVENTS values
 * @param {string} domain      — one of EVENT_DOMAIN values
 * @param {string} correlationId — non-empty opaque correlation ID
 * @param {object} [payload]   — event-specific data (secrets will be redacted)
 * @returns {{ ok: boolean, code: string|null, event?: object }}
 */
export function emitEvent(eventName, domain, correlationId, payload: any = {}) {
  try {
    const envelope = buildEvent(eventName, domain, correlationId, payload);
    // Emit to stdout as a single JSON line — parseable by log aggregators
    console.log(JSON.stringify(envelope));
    return { ok: true, code: null, event: envelope };
  } catch (err) {
    // Build failed (validation error) — log and return degraded result
    const code = err.code || EVENT_ERROR_CODE.MISSING_INPUT;
    error(`[emitEvent] failed to emit event '${eventName}': ${err.message}`, { code, status: "degraded" });
    return { ok: false, code, status: "degraded", reason: err.message };
  }
}
