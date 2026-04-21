import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { appendCiFixContext } from "../../src/core/orchestrator.js";

describe("appendCiFixContext", () => {
  let stateDir: string;
  let config: any;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-ci-fix-context-"));
    config = {
      paths: { stateDir },
      env: { targetRepo: "CanerDoqdu/Box", githubToken: "token" }
    };
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("injects deterministic CI_FAILURE_CONTEXT from GitHub Actions logs", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("/actions/runs/123/jobs")) {
        return {
          ok: true,
          json: async () => ({
            jobs: [{ id: 456, name: "test", conclusion: "failure" }]
          })
        } as any;
      }
      if (url.includes("/actions/jobs/456/logs")) {
        return {
          ok: true,
          text: async () => [
            "not ok 1 - tests/core/ci_gate.test.ts",
            "TypeError: expected true to be false",
            "at Object.<anonymous> (tests/core/ci_gate.test.ts:12:4)"
          ].join("\n")
        } as any;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: {
        failedCiRuns: [
          {
            runId: 123,
            headSha: "abc123456789def",
            name: "CI",
            htmlUrl: "https://github.com/owner/repo/actions/runs/123"
          }
        ]
      }
    };
    const out = await appendCiFixContext(config, plan, "base context");

    assert.ok(out.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(out.includes("commit_sha: abc123456789def"));
    assert.ok(out.includes("failed_test_identifiers: tests/core/ci_gate.test.ts"));
    assert.ok(out.includes("error_messages: TypeError: expected true to be false"));
    assert.ok(out.includes("stack_traces: at Object.<anonymous> (tests/core/ci_gate.test.ts:12:4)"));
    assert.ok(out.includes("source: github_actions_logs"));
  });

  it("falls back to state artifacts when GitHub Actions logs are unavailable", async () => {
    mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 } as any));
    await fs.writeFile(
      path.join(stateDir, "evo_run_latest.log"),
      [
        "commit=def456789abc123",
        "FAIL tests/core/failure.test.ts",
        "Error: expected 2 to equal 3",
        "at run (tests/core/failure.test.ts:4:2)"
      ].join("\n"),
      "utf8"
    );

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: {
        failedCiRuns: [{ runId: 999, headSha: "def456789abc123" }]
      }
    };
    const out = await appendCiFixContext(config, plan, "");

    assert.ok(out.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(out.includes("commit_sha: def456789abc123"));
    assert.ok(out.includes("failed_test_identifiers: tests/core/failure.test.ts"));
    assert.ok(out.includes("error_messages: Error: expected 2 to equal 3"));
    assert.ok(out.includes("stack_traces: at run (tests/core/failure.test.ts:4:2)"));
    assert.ok(out.includes("source: state_fallback_artifacts"));
  });

  it("negative path: injects no-data marker when all evidence sources are exhausted", async () => {
    mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 } as any));
    await fs.writeFile(
      path.join(stateDir, "evo_run_latest.log"),
      "commit=deadbeef\njust noise without required identifiers",
      "utf8"
    );

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: { failedCiRuns: [{ runId: 999, headSha: "deadbeef" }] }
    };
    const out = await appendCiFixContext(config, plan, "original");
    assert.ok(out.includes("## CI_FAILURE_CONTEXT"), "CI_FAILURE_CONTEXT section must always be injected for ci-fix tasks");
    assert.ok(out.includes("no_evidence_available"), "explicit no-data marker must be present when evidence is exhausted");
  });

  it("falls back to npm_test_full.log when GitHub and evo_run_latest have no failures", async () => {
    mock.method(globalThis, "fetch", async () => ({ ok: false, status: 404 } as any));
    await fs.writeFile(
      path.join(stateDir, "npm_test_full.log"),
      [
        "commit=npm123sha",
        "FAIL tests/core/npm_test_artifact.test.ts",
        "AssertionError: expected 1 to equal 2",
        "at run (tests/core/npm_test_artifact.test.ts:8:2)"
      ].join("\n"),
      "utf8"
    );

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: { failedCiRuns: [{ runId: 999, headSha: "npm123sha" }] }
    };
    const out = await appendCiFixContext(config, plan, "");

    assert.ok(out.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(out.includes("failed_test_identifiers: tests/core/npm_test_artifact.test.ts"));
    assert.ok(out.includes("local_npm_test_artifact:npm_test_full.log"));
  });

  it("applies deterministic source priority and structured truncation", async () => {
    mock.method(globalThis, "fetch", async (url: string) => {
      if (url.includes("/actions/runs/123/jobs")) {
        return {
          ok: true,
          json: async () => ({
            jobs: [{ id: 456, name: "test", conclusion: "failure" }]
          })
        } as any;
      }
      if (url.includes("/actions/jobs/456/logs")) {
        return {
          ok: true,
          text: async () => [
            "not ok 1 - tests/core/ci_gate.test.ts",
            `TypeError: ${"x".repeat(500)}`,
            `at Object.<anonymous> (${`tests/core/ci_gate.test.ts:${"9".repeat(120)}:4`})`
          ].join("\n")
        } as any;
      }
      throw new Error(`unexpected fetch url: ${url}`);
    });

    await fs.writeFile(
      path.join(stateDir, "evo_run_latest.log"),
      [
        "commit=def456789abc123",
        "FAIL tests/core/fallback_failure.test.ts",
        "Error: should not win over github source",
        "at run (tests/core/fallback_failure.test.ts:4:2)"
      ].join("\n"),
      "utf8"
    );

    const plan = {
      taskKind: "ci-fix",
      githubCiContext: {
        failedCiRuns: [
          {
            runId: 123,
            headSha: "abc123456789def",
            name: "CI",
            htmlUrl: "https://github.com/owner/repo/actions/runs/123"
          }
        ]
      }
    };

    const out = await appendCiFixContext(config, plan, "");
    assert.ok(out.includes("source: github_actions_logs"), "GitHub source must take priority");
    assert.ok(out.includes("..."), "long evidence must be truncated deterministically");
    assert.ok(!out.includes("should not win over github source"), "fallback source must not override higher-priority source");
  });

  it("injects CI_FAILURE_CONTEXT from plan-carried mandatory finding evidence before external fetch", async () => {
    let fetchCalls = 0;
    mock.method(globalThis, "fetch", async () => {
      fetchCalls += 1;
      return { ok: false, status: 500 } as any;
    });

    const plan = {
      taskKind: "ci-fix",
      ciFailureEvidence: {
        source: "mandatory_ci_findings",
        headSha: "packetsha123",
        failedTestIdentifiers: ["tests/core/packet_ci_failure.test.ts"],
        errorMessages: ["AssertionError: expected 2 to equal 3"],
        stackTraces: ["at run (tests/core/packet_ci_failure.test.ts:8:2)"],
      },
      githubCiContext: {
        failedCiRuns: [{ runId: 123, headSha: "unusedsha" }],
      },
    };

    const out = await appendCiFixContext(config, plan, "base context");
    assert.ok(out.includes("## CI_FAILURE_CONTEXT"));
    assert.ok(out.includes("commit_sha: packetsha123"));
    assert.ok(out.includes("failed_test_identifiers: tests/core/packet_ci_failure.test.ts"));
    assert.ok(out.includes("error_messages: AssertionError: expected 2 to equal 3"));
    assert.ok(out.includes("source: mandatory_ci_findings"));
    assert.equal(fetchCalls, 0, "plan-carried evidence should bypass external CI fetch");
  });
});
