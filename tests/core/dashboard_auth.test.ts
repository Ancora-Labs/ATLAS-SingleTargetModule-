import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

/**
 * Tests for the dashboard Bearer token auth helper.
 *
 * We test checkDashboardAuth directly (pure function, no HTTP server needed)
 * and also exercise the full middleware path via a live HTTP server to cover
 * integration edge cases.
 */

// Set a known token before importing the module so the module-level constant is set.
const TEST_TOKEN = "test-token-abc123";
process.env.BOX_DASHBOARD_TOKEN = TEST_TOKEN;

const { checkDashboardAuth } = await import("../../src/dashboard/live_dashboard.ts");

describe("checkDashboardAuth — unit", () => {
  it("returns 401 when Authorization header is missing", () => {
    const result = checkDashboardAuth(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns 401 when Authorization header is empty string", () => {
    const result = checkDashboardAuth("");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns 401 when Authorization header is not Bearer scheme", () => {
    const result = checkDashboardAuth("Basic dXNlcjpwYXNz");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns 401 when Bearer token value is wrong", () => {
    const result = checkDashboardAuth("Bearer wrong-token");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns 401 when Bearer prefix present but token is empty", () => {
    const result = checkDashboardAuth("Bearer ");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  it("returns ok:true when correct token is provided", () => {
    const result = checkDashboardAuth(`Bearer ${TEST_TOKEN}`);
    assert.equal(result.ok, true);
  });
});

// --- Integration: HTTP server tests ---

import http from "node:http";
import { startDashboard } from "../../src/dashboard/live_dashboard.ts";

// Use a high ephemeral port to avoid conflicts with live dashboard (8787).
const TEST_PORT = 18787;

/** Helper: fire a POST request and return { status, body } */
function post(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: TEST_PORT, path, method: "POST",
        headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => { raw += chunk; });
        res.on("end", () => {
          let body;
          try { body = JSON.parse(raw); } catch { body = raw; }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.end("{}");
  });
}

let server;

before(async () => {
  server = startDashboard({ port: TEST_PORT });
  // Wait until server is listening
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once("listening", resolve);
    server.once("error", reject);
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe("dashboard mutation routes — HTTP integration", () => {
  const MUTATION_PATHS = ["/api/force-rebase", "/api/daemon-start", "/api/daemon-stop"];

  for (const route of MUTATION_PATHS) {
    it(`${route}: returns 403 when BOX_DASHBOARD_TOKEN configured but no Authorization header`, async () => {
      // Token is set (TEST_TOKEN), but request sends no Authorization header.
      const { status, body } = await post(route, {});
      // 401 = missing/wrong token (token IS configured)
      assert.equal(status, 401, `expected 401 for ${route}, got ${status}`);
      assert.equal(body.ok, false);
      assert.equal(body.error, "Unauthorized");
    });

    it(`${route}: returns 401 with wrong Bearer token`, async () => {
      const { status, body } = await post(route, { authorization: "Bearer badtoken" });
      assert.equal(status, 401, `expected 401 for ${route}, got ${status}`);
      assert.equal(body.ok, false);
    });
  }
});
