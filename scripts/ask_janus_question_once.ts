#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadConfig } from "../src/config.js";

function toCopilotSlug(name) {
  const normalized = String(name || "").trim().toLowerCase();
  const known = {
    "claude sonnet 4.6": "claude-sonnet-4.6",
    "claude opus 4.6": "claude-opus-4.6",
    "gpt-5.3-codex": "gpt-5.3-codex"
  };
  return known[normalized] || normalized.replace(/[^a-z0-9.\s-]/g, "").replace(/\s+/g, "-");
}

function tryParseJson(text) {
  const s = String(text || "");
  try {
    return JSON.parse(s);
  } catch {}

  const fence = s.match(/```json\s*([\s\S]*?)```/);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }

  const anyFence = s.match(/```\s*([\s\S]*?)```/);
  if (anyFence) {
    try {
      return JSON.parse(anyFence[1].trim());
    } catch {}
  }

  return null;
}

const config = await loadConfig();
const command = config?.env?.copilotCliCommand || "copilot";
const model = String(config?.roleRegistry?.ceoSupervisor?.model || "Claude Sonnet 4.6");
const slug = toCopilotSlug(model);

const prompt = `You are Janus, CEO/Supervisor AI of BOX.
User question (Turkish): "Janus gorevlerin ve calisma bicimini aciklar misin bana?"
Return ONLY strict JSON:
{
  "whatIDo": [string],
  "whatIDontDo": [string],
  "howIStrategicVsTactical": string,
  "howICoordinateAthenaAndWorkers": string,
  "operatorAdvice": string
}
Use concise Turkish.`;

const args = ["--allow-all-tools", "-p", prompt, "--model", slug];
const result = spawnSync(command, args, {
  encoding: "utf8",
  env: process.env,
  windowsHide: true
});

const stdout = String(result?.stdout || "");
const stderr = String(result?.stderr || "");
const merged = `${stdout}\n${stderr}`;
const parsed = tryParseJson(stdout) || tryParseJson(merged);

if (result.status !== 0) {
  console.log(JSON.stringify({ ok: false, exitCode: result.status, error: (stderr || stdout).slice(0, 600) }, null, 2));
  process.exit(1);
}

if (!parsed) {
  console.log(JSON.stringify({ ok: false, error: "json-parse-failed", stdoutPreview: stdout.slice(0, 800), stderrPreview: stderr.slice(0, 400) }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, model, answer: parsed }, null, 2));

