import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  loadAgentControlPlane,
  recordAgentHandoff,
  recordAgentSession,
  summarizeAgentControlPlane,
} from "../../src/core/agent_control_plane.js";

async function makeConfig() {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-agent-control-"));
  return { config: { paths: { stateDir } }, stateDir };
}

describe("agent_control_plane", () => {
  it("persists latest agent session state and session event history", async () => {
    const { config, stateDir } = await makeConfig();
    try {
      await recordAgentSession(config, {
        agent: "janus",
        cycleId: "cycle-1",
        phase: "start",
        status: "running",
        summary: "starting",
      });
      await recordAgentSession(config, {
        agent: "janus",
        cycleId: "cycle-1",
        phase: "complete",
        status: "done",
        summary: "completed",
      });

      const state = await loadAgentControlPlane(config);
      assert.equal(state.sessions.janus.status, "done");
      assert.equal(state.sessions.janus.phase, "complete");
      assert.equal(Array.isArray(state.sessionEvents), true);
      assert.equal(state.sessionEvents.length, 2);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("persists durable handoff history between agents", async () => {
    const { config, stateDir } = await makeConfig();
    try {
      await recordAgentHandoff(config, {
        from: "janus",
        to: "prometheus",
        cycleId: "cycle-2",
        status: "ready",
        summary: "handoff summary",
        artifact: "prometheus_analysis.json",
      });

      const state = await loadAgentControlPlane(config);
      assert.equal(state.handoffs.length, 1);
      assert.equal(state.handoffs[0].from, "janus");
      assert.equal(state.handoffs[0].to, "prometheus");
      assert.equal(state.handoffs[0].artifact, "prometheus_analysis.json");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("summarizes recent agent activity for Janus context", async () => {
    const { config, stateDir } = await makeConfig();
    try {
      await recordAgentSession(config, {
        agent: "janus",
        cycleId: "cycle-3",
        phase: "start",
        status: "running",
      });
      await recordAgentSession(config, {
        agent: "prometheus",
        cycleId: "cycle-3",
        phase: "complete",
        status: "done",
      });
      await recordAgentHandoff(config, {
        from: "janus",
        to: "prometheus",
        cycleId: "cycle-3",
        status: "ready",
      });

      const summary = await summarizeAgentControlPlane(config, 10);
      assert.deepEqual(summary.activeAgents, ["janus"]);
      assert.equal(summary.completionCount, 1);
      assert.equal(summary.handoffCount, 1);
      assert.equal(typeof summary.lastEventAt, "string");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});

