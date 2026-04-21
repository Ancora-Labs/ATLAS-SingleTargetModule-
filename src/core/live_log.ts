import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";

export function aggregateLiveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_agents.log");
}

function prefixLiveLogLines(source: string, text: string): string {
  const message = String(text || "");
  if (!message) return "";
  return message.replace(/^/gm, `[${source}] `);
}

export function appendAggregateLiveLogSync(stateDir: string, source: string, text: string): void {
  const content = prefixLiveLogLines(source, text);
  if (!content) return;
  try {
    appendFileSync(aggregateLiveLogPath(stateDir), content, "utf8");
  } catch { /* best-effort */ }
}

export async function appendAggregateLiveLog(stateDir: string, source: string, text: string): Promise<void> {
  const content = prefixLiveLogLines(source, text);
  if (!content) return;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(aggregateLiveLogPath(stateDir), content, "utf8");
  } catch { /* best-effort */ }
}

export async function initializeAggregateLiveLog(stateDir: string, reason: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    aggregateLiveLogPath(stateDir),
    `[live_agents]\n[${reason}] Combined live agent log ready...\n`,
    "utf8"
  );
}

// ── Span-aware log helpers ─────────────────────────────────────────────────────

/**
 * Format a span-context prefix for structured log lines.
 * Short 8-char prefix keeps lines readable while retaining correlation ability.
 */
function formatSpanPrefix(spanContext: { spanId?: string; traceId?: string }): string {
  const parts: string[] = [];
  if (spanContext.traceId && typeof spanContext.traceId === "string") {
    parts.push(`trace:${spanContext.traceId.slice(0, 8)}`);
  }
  if (spanContext.spanId && typeof spanContext.spanId === "string") {
    parts.push(`span:${spanContext.spanId.slice(0, 8)}`);
  }
  return parts.length > 0 ? `[${parts.join("|")}] ` : "";
}

/**
 * Synchronously append a span-tagged line to the aggregate live log.
 * Includes a short prefix with traceId and spanId for deterministic correlation.
 *
 * Best-effort — never throws.
 *
 * @param stateDir    — directory containing live_agents.log
 * @param source      — agent/component identifier (used as the line prefix)
 * @param text        — log message body
 * @param spanContext — span fields from SPAN_CONTRACT.fields (traceId, spanId)
 */
export function appendAggregateLiveLogWithSpan(
  stateDir: string,
  source: string,
  text: string,
  spanContext: { spanId?: string; traceId?: string },
): void {
  const prefix = formatSpanPrefix(spanContext);
  appendAggregateLiveLogSync(stateDir, source, `${prefix}${text}`);
}