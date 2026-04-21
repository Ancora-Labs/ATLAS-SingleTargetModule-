import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const AUTH_TOKEN = "test-token";

function makeTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "box-daemon-ctrl-"));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

function requestJson(port, method, pathname, headers = {}, body = "") {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: pathname,
      method,
      headers
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += String(chunk);
      });
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          parsed = null;
        }
        resolve({ status: Number(res.statusCode || 0), body: parsed, text: raw });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("dashboard daemon control contracts", () => {
  let tempRoot;
  let stateDir;
  let port;
  let server;
  const spawnedPids = new Set();

  before(async () => {
    tempRoot = await makeTempRoot();
    stateDir = path.join(tempRoot, "state");
    await fs.mkdir(stateDir, { recursive: true });

    process.env.BOX_ROOT_DIR = tempRoot;
    process.env.BOX_DASHBOARD_TOKEN = AUTH_TOKEN;
    process.env.BOX_DASHBOARD_PORT = "9988";
    process.env.BOX_DAEMON_STOP_GRACE_MS = "200";

    const modulePath = `../../src/dashboard/live_dashboard.ts?daemon_contract=${Date.now()}`;
    const { startDashboard } = await import(modulePath);
    port = await getFreePort();
    server = startDashboard({ port });
    await new Promise((resolve, reject) => {
      if (server.listening) {
        resolve();
        return;
      }
      server.once("listening", resolve);
      server.once("error", reject);
    });
  });

  after(async () => {
    try {
      await requestJson(port, "POST", "/api/daemon-stop", {
        "content-type": "application/json",
        authorization: `Bearer ${AUTH_TOKEN}`
      }, "{}");
    } catch {}

    for (const pid of spawnedPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }

    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }

    // Detached daemon processes can release file handles slightly after stop.
    // Retry directory cleanup deterministically to avoid Windows EBUSY flakes.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await fs.rm(tempRoot, { recursive: true, force: true });
        break;
      } catch (error) {
        if (error?.code !== "EBUSY" || attempt === 7) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    delete process.env.BOX_ROOT_DIR;
    delete process.env.BOX_DASHBOARD_TOKEN;
    delete process.env.BOX_DASHBOARD_PORT;
    delete process.env.BOX_DAEMON_STOP_GRACE_MS;
  });

  it("daemon-start returns deterministic already-running status when pid is active", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    await fs.writeFile(daemonPidPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }), "utf8");

    const response = await requestJson(port, "POST", "/api/daemon-start", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");

    assert.equal(response.status, 200);
    assert.equal(response.body?.ok, true);
    if (Number.isFinite(Number(response.body?.pid)) && Number(response.body.pid) > 0) {
      spawnedPids.add(Number(response.body.pid));
    }
    assert.match(String(response.body?.message || ""), /already running/i);
  });

  it("daemon-stop returns deterministic not-running status when pid is absent", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    await fs.rm(daemonPidPath, { force: true });

    const response = await requestJson(port, "POST", "/api/daemon-stop", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");

    assert.equal(response.status, 200);
    assert.equal(response.body?.ok, true);
    assert.match(String(response.body?.message || ""), /not running/i);
  });

  it("daemon-stop writes standardized daemon.stop.json contract and not stale stop_request.json", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    const stopFile = path.join(stateDir, "daemon.stop.json");
    const staleStopFile = path.join(stateDir, "stop_request.json");

    await fs.rm(stopFile, { force: true });
    await fs.rm(staleStopFile, { force: true });
    const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: false,
      stdio: "ignore"
    });

    try {
      await fs.writeFile(daemonPidPath, JSON.stringify({
        pid: sleeper.pid,
        startedAt: new Date().toISOString()
      }), "utf8");

      const response = await requestJson(port, "POST", "/api/daemon-stop", {
        "content-type": "application/json",
        authorization: `Bearer ${AUTH_TOKEN}`
      }, "{}");

      assert.equal(response.status, 200);
      assert.equal(response.body?.ok, true);

      const stopContent = JSON.parse(await fs.readFile(stopFile, "utf8"));
      assert.equal(typeof stopContent.requestedAt, "string");
      assert.equal(stopContent.reason, "dashboard-stop");

      let staleExists = true;
      try {
        await fs.access(staleStopFile);
      } catch {
        staleExists = false;
      }
      assert.equal(staleExists, false);
    } finally {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {}
    }
  });

  it("daemon-start removes stale daemon.stop.json before starting a stopped daemon", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    const stopFile = path.join(stateDir, "daemon.stop.json");

    await fs.writeFile(stopFile, JSON.stringify({
      requestedAt: new Date().toISOString(),
      reason: "old-stop"
    }), "utf8");
    await fs.writeFile(daemonPidPath, JSON.stringify({
      pid: 9999999,
      startedAt: new Date().toISOString()
    }), "utf8");

    const response = await requestJson(port, "POST", "/api/daemon-start", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");

    assert.equal(response.status, 200);
    assert.equal(response.body?.ok, true);

    let stopExists = true;
    try {
      await fs.access(stopFile);
    } catch {
      stopExists = false;
    }
    assert.equal(stopExists, false);

    // Cleanup daemon that was started by this test.
    await requestJson(port, "POST", "/api/daemon-stop", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");
  });
});
