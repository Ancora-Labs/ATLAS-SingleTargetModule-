import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const AUTH_TOKEN = "test-token";

function createTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "box-dashboard-auth-"));
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

describe("dashboard API auth regression", () => {
  let tempRoot;
  let stateDir;
  let port;
  let server;

  before(async () => {
    tempRoot = await createTempRoot();
    stateDir = path.join(tempRoot, "state");
    await fs.mkdir(stateDir, { recursive: true });

    process.env.BOX_ROOT_DIR = tempRoot;
    process.env.BOX_DASHBOARD_TOKEN = AUTH_TOKEN;
    process.env.BOX_DASHBOARD_PORT = "9876";

    const modulePath = `../../src/dashboard/live_dashboard.ts?auth_test=${Date.now()}`;
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
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
    delete process.env.BOX_ROOT_DIR;
    delete process.env.BOX_DASHBOARD_TOKEN;
    delete process.env.BOX_DASHBOARD_PORT;
  });

  const mutationRoutes = ["/api/force-rebase", "/api/daemon-start", "/api/daemon-stop"];

  for (const route of mutationRoutes) {
    it(`${route} rejects missing token with 401`, async () => {
      const response = await requestJson(port, "POST", route, {
        "content-type": "application/json"
      }, "{}");
      assert.equal(response.status, 401);
      assert.equal(response.body?.ok, false);
    });

    it(`${route} rejects wrong token with 401 or 403`, async () => {
      const response = await requestJson(port, "POST", route, {
        "content-type": "application/json",
        authorization: "Bearer wrong-token"
      }, "{}");
      assert.ok([401, 403].includes(response.status));
      assert.equal(response.body?.ok, false);
    });
  }

  it("POST /api/force-rebase allows valid bearer token", async () => {
    const response = await requestJson(port, "POST", "/api/force-rebase", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");
    assert.ok(![401, 403].includes(response.status), `unexpected auth failure: ${response.status}`);
  });

  it("POST /api/daemon-start allows valid bearer token", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    await fs.writeFile(daemonPidPath, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString()
    }), "utf8");

    const response = await requestJson(port, "POST", "/api/daemon-start", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");
    assert.ok(![401, 403].includes(response.status), `unexpected auth failure: ${response.status}`);
    assert.equal(response.status, 200);
  });

  it("POST /api/daemon-stop allows valid bearer token", async () => {
    const daemonPidPath = path.join(stateDir, "daemon.pid.json");
    await fs.writeFile(daemonPidPath, JSON.stringify({
      pid: 9999999,
      startedAt: new Date().toISOString()
    }), "utf8");

    const response = await requestJson(port, "POST", "/api/daemon-stop", {
      "content-type": "application/json",
      authorization: `Bearer ${AUTH_TOKEN}`
    }, "{}");
    assert.ok(![401, 403].includes(response.status), `unexpected auth failure: ${response.status}`);
    assert.equal(response.status, 200);
  });

  it("GET /api/state remains readable without auth token", async () => {
    const response = await requestJson(port, "GET", "/api/state");
    assert.notEqual(response.status, 401);
    assert.notEqual(response.status, 403);
    assert.equal(response.status, 200);
  });
});
