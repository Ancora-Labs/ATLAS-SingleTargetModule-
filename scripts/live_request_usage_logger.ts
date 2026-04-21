#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const stateDir = path.join(rootDir, "state");
const progressPath = path.join(stateDir, "progress.txt");
const outputPath = path.join(stateDir, "request_usage_live.log");

const POLL_MS = 1500;

type AgentStat = {
  requests: number;
  usedTokens: number;
  limitTokens: number;
};

const stats = new Map<string, AgentStat>();
let totalRequests = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function parseContextUsageLine(line: string): {
  agent: string;
  model: string;
  used: number;
  limit: number;
  pct: string;
  status: string;
} | null {
  const m = line.match(/\[CONTEXT_USAGE\]\s+agent=([^\s]+)\s+model=(.+?)\s+used=(\d+)\/(\d+)\s+\(([^)]+)\)\s+status=([^\s]+)/i);
  if (!m) return null;
  return {
    agent: m[1].trim(),
    model: m[2].trim(),
    used: Number(m[3]),
    limit: Number(m[4]),
    pct: m[5].trim(),
    status: m[6].trim(),
  };
}

function buildTotalsLine(): string {
  const byAgent = Array.from(stats.entries())
    .sort((a, b) => b[1].requests - a[1].requests)
    .map(([agent, s]) => `${agent}:req=${s.requests},used=${s.usedTokens},limit=${s.limitTokens}`)
    .join(" | ");

  return `[${nowIso()}] TOTAL requests=${totalRequests}${byAgent ? ` | ${byAgent}` : ""}`;
}

async function appendOutput(line: string): Promise<void> {
  await fs.appendFile(outputPath, `${line}\n`, "utf8");
}

async function processChunk(chunkText: string): Promise<void> {
  const lines = chunkText.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parsed = parseContextUsageLine(line);
    if (!parsed) continue;

    totalRequests += 1;
    const current = stats.get(parsed.agent) || { requests: 0, usedTokens: 0, limitTokens: 0 };
    current.requests += 1;
    current.usedTokens += Number.isFinite(parsed.used) ? parsed.used : 0;
    current.limitTokens += Number.isFinite(parsed.limit) ? parsed.limit : 0;
    stats.set(parsed.agent, current);

    await appendOutput(
      `[${nowIso()}] REQUEST agent=${parsed.agent} model=${parsed.model} used=${parsed.used}/${parsed.limit} (${parsed.pct}) status=${parsed.status}`
    );
    await appendOutput(buildTotalsLine());
  }
}

async function bootstrapHeader(): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await appendOutput(`[${nowIso()}] live_request_usage_logger started`);
  await appendOutput(`[${nowIso()}] source=${progressPath}`);
}

async function main(): Promise<void> {
  await bootstrapHeader();

  let lastSize = 0;
  try {
    const st = await fs.stat(progressPath);
    lastSize = st.size;
  } catch {
    lastSize = 0;
  }

  setInterval(async () => {
    try {
      const st = await fs.stat(progressPath);
      if (st.size < lastSize) {
        lastSize = 0;
      }
      if (st.size === lastSize) return;

      const fh = await fs.open(progressPath, "r");
      try {
        const len = st.size - lastSize;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, lastSize);
        lastSize = st.size;
        await processChunk(buf.toString("utf8"));
      } finally {
        await fh.close();
      }
    } catch {
      // Keep polling; file may not exist yet.
    }
  }, POLL_MS);
}

main().catch(async (err) => {
  const msg = err instanceof Error ? err.stack || err.message : String(err);
  await appendOutput(`[${nowIso()}] ERROR ${msg}`);
  process.exit(1);
});
