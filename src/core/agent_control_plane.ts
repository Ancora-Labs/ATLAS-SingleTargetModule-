import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

const AGENT_CONTROL_PLANE_FILE = "agent_control_plane.json";
const MAX_AGENT_EVENTS = 200;
const MAX_HANDOFF_EVENTS = 200;

type AgentSessionEvent = {
  agent: string;
  cycleId: string | null;
  phase: "start" | "complete" | "failed";
  status: string;
  summary: string | null;
  model: string | null;
  recordedAt: string;
};

type AgentHandoffEvent = {
  from: string;
  to: string;
  cycleId: string | null;
  status: string;
  summary: string | null;
  artifact: string | null;
  recordedAt: string;
};

function initialState() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    sessions: {},
    sessionEvents: [],
    handoffs: [],
  };
}

export async function loadAgentControlPlane(config) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, AGENT_CONTROL_PLANE_FILE);
  const raw = await readJson(filePath, initialState());
  const safe = raw && typeof raw === "object" ? raw : initialState();
  return {
    schemaVersion: 1,
    updatedAt: safe.updatedAt || null,
    sessions: safe.sessions && typeof safe.sessions === "object" && !Array.isArray(safe.sessions) ? safe.sessions : {},
    sessionEvents: Array.isArray(safe.sessionEvents) ? safe.sessionEvents : [],
    handoffs: Array.isArray(safe.handoffs) ? safe.handoffs : [],
  };
}

export async function recordAgentSession(config, input: {
  agent: string;
  cycleId?: string | null;
  phase: "start" | "complete" | "failed";
  status: string;
  summary?: string | null;
  model?: string | null;
}) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, AGENT_CONTROL_PLANE_FILE);
  const state = await loadAgentControlPlane(config);
  const agent = String(input?.agent || "").trim().toLowerCase();
  if (!agent) return;

  const recordedAt = new Date().toISOString();
  const event: AgentSessionEvent = {
    agent,
    cycleId: input?.cycleId ? String(input.cycleId) : null,
    phase: input.phase,
    status: String(input?.status || "unknown"),
    summary: input?.summary ? String(input.summary).slice(0, 400) : null,
    model: input?.model ? String(input.model) : null,
    recordedAt,
  };

  const prev = state.sessions[agent] && typeof state.sessions[agent] === "object" ? state.sessions[agent] : {};
  state.sessions[agent] = {
    agent,
    cycleId: event.cycleId,
    status: event.status,
    phase: event.phase,
    model: event.model,
    summary: event.summary,
    startedAt: event.phase === "start" ? recordedAt : (prev.startedAt || null),
    completedAt: event.phase === "complete" ? recordedAt : (event.phase === "failed" ? null : prev.completedAt || null),
    failedAt: event.phase === "failed" ? recordedAt : null,
    updatedAt: recordedAt,
  };
  state.sessionEvents = [...state.sessionEvents, event].slice(-MAX_AGENT_EVENTS);
  state.updatedAt = recordedAt;
  await writeJson(filePath, state);
}

export async function recordAgentHandoff(config, input: {
  from: string;
  to: string;
  cycleId?: string | null;
  status: string;
  summary?: string | null;
  artifact?: string | null;
}) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, AGENT_CONTROL_PLANE_FILE);
  const state = await loadAgentControlPlane(config);
  const from = String(input?.from || "").trim().toLowerCase();
  const to = String(input?.to || "").trim().toLowerCase();
  if (!from || !to) return;

  const recordedAt = new Date().toISOString();
  const handoff: AgentHandoffEvent = {
    from,
    to,
    cycleId: input?.cycleId ? String(input.cycleId) : null,
    status: String(input?.status || "unknown"),
    summary: input?.summary ? String(input.summary).slice(0, 400) : null,
    artifact: input?.artifact ? String(input.artifact).slice(0, 200) : null,
    recordedAt,
  };

  state.handoffs = [...state.handoffs, handoff].slice(-MAX_HANDOFF_EVENTS);
  state.updatedAt = recordedAt;
  await writeJson(filePath, state);
}

export async function summarizeAgentControlPlane(config, limit = 25): Promise<{
  activeAgents: string[];
  recentSessionCount: number;
  completionCount: number;
  failureCount: number;
  handoffCount: number;
  lastEventAt: string | null;
}> {
  const state = await loadAgentControlPlane(config);
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 25));
  const recentSessions = state.sessionEvents.slice(-safeLimit);
  const activeAgents = Object.values(state.sessions || {})
    .filter((session: any) => session && typeof session === "object" && String(session.phase || "") === "start")
    .map((session: any) => String(session.agent || "").trim().toLowerCase())
    .filter(Boolean);
  const completionCount = recentSessions.filter((entry: any) => String(entry?.phase || "") === "complete").length;
  const failureCount = recentSessions.filter((entry: any) => String(entry?.phase || "") === "failed").length;
  const handoffCount = state.handoffs.slice(-safeLimit).length;
  const lastSessionAt = recentSessions.length > 0 ? String(recentSessions[recentSessions.length - 1]?.recordedAt || "") : "";
  const lastHandoffAt = handoffCount > 0 ? String(state.handoffs[state.handoffs.length - 1]?.recordedAt || "") : "";
  const lastEventAt = [lastSessionAt, lastHandoffAt].filter(Boolean).sort().at(-1) || null;
  return {
    activeAgents,
    recentSessionCount: recentSessions.length,
    completionCount,
    failureCount,
    handoffCount,
    lastEventAt,
  };
}
