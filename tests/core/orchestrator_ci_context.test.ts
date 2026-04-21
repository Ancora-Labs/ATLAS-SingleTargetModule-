import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendCiFixContext, hydrateDispatchContextWithCiEvidence } from "../../src/core/orchestrator.js";

describe("orchestrator CI context hydration", () => {
  let stateDir: string;
  let config: any;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-ci-context-"));
    config = {
      paths: { stateDir },
      env: { targetRepo: "CanerDoqdu/Box", githubToken: "token" },
    };
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("hydrates ci-fix dispatch context with CI_FAILURE_CONTEXT evidence", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("/actions/runs/123/jobs")) {
        return { ok: true, json: async () => ({ jobs: [{ id: 456, conclusion: "failure" }] }) } as any;
      }
      if (url.includes("/actions/jobs/456/logs")) {
        return {
          ok: true,
          text: async () => [
            "not ok 1 - tests/core/ci_gate.test.ts",
            "TypeError: expected true to be false",
            "at Object.<anonymous> (tests/core/ci_gate.test.ts:12:4)",
          ].join("\n"),
        } as any;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: {
        failedCiRuns: [{ runId: 123, headSha: "abc123456789def" }],
      },
    };
    const hydrated = await hydrateDispatchContextWithCiEvidence(config, plan, "base context");
    assert.ok(hydrated.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(hydrated.includes("commit_sha: abc123456789def"));
  });

  it("negative path: non-ci-fix tasks keep context unchanged", async () => {
    const plan = {
      taskKind: "implementation",
      githubCiContext: {
        failedCiRuns: [{ runId: 123, headSha: "abc123456789def" }],
      },
    };
    const base = "existing context";
    const hydrated = await hydrateDispatchContextWithCiEvidence(config, plan, base);
    assert.equal(hydrated, base);
  });

  it("hydrates ci-fix evidence for hyphen/underscore variant taskKind values", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("/actions/runs/321/jobs")) {
        return { ok: true, json: async () => ({ jobs: [{ id: 654, conclusion: "failure" }] }) } as any;
      }
      if (url.includes("/actions/jobs/654/logs")) {
        return {
          ok: true,
          text: async () => "not ok 1 - tests/core/variant_ci_fix.test.ts\nError: boom",
        } as any;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const plan = {
      taskKind: "ci_fix",
      githubCiContext: {
        failedCiRuns: [{ runId: 321, headSha: "fedcba987654321" }],
      },
    };
    const hydrated = await hydrateDispatchContextWithCiEvidence(config, plan, "base context");
    assert.ok(hydrated.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(hydrated.includes("commit_sha: fedcba987654321"));
  });

  it("keeps compatibility with appendCiFixContext direct use", async () => {
    mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 } as any));
    await fs.writeFile(
      path.join(stateDir, "evo_run_latest.log"),
      [
        "commit=def456789abc123",
        "FAIL tests/core/failure.test.ts",
        "Error: expected 2 to equal 3",
        "at run (tests/core/failure.test.ts:4:2)",
      ].join("\n"),
      "utf8",
    );
    const plan = { taskKind: "ci-fix", githubCiContext: { failedCiRuns: [{ runId: 999, headSha: "def456789abc123" }] } };
    const out = await appendCiFixContext(config, plan, "");
    assert.ok(out.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(out.includes("source: state_fallback_artifacts"));
  });
});

