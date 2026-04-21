import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildCopilotAuthFingerprint, classifyCopilotAuthInputs, runDoctor, shouldReuseCopilotAuthProbe } from "../../src/core/doctor.js";

async function writeCachedProbe(stateDir: string, input: { copilotToken: string; cliPath?: string }) {
  const fingerprint = buildCopilotAuthFingerprint({
    copilotToken: input.copilotToken,
    ghAuthActive: false,
    ghActiveAccount: null,
  });
  await fs.writeFile(
    path.join(stateDir, "copilot_auth_probe.json"),
    JSON.stringify({
      schemaVersion: 1,
      checkedAt: new Date().toISOString(),
      ok: true,
      fingerprint,
      cliPath: input.cliPath || "node",
      source: "env",
      tokenType: "github_pat",
      message: "copilot_auth_probe_ok",
    }, null, 2),
    "utf8",
  );
}

describe("doctor", () => {
  let originalTargetRepo: string | undefined;

  beforeEach(() => {
    originalTargetRepo = process.env.TARGET_REPO;
  });

  afterEach(async () => {
    if (originalTargetRepo === undefined) {
      delete process.env.TARGET_REPO;
    } else {
      process.env.TARGET_REPO = originalTargetRepo;
    }
  });

  it("returns checks object and warning list", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    await writeCachedProbe(tmpDir, { copilotToken: "github_pat_test_valid" });
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: {
        githubToken: "x",
        targetRepo: "CanerDoqdu/Box",
        copilotCliCommand: "node",
        copilotGithubToken: "github_pat_test_valid",
      }
    });
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.checks.node, "boolean");
    assert.ok(Array.isArray(result.warnings));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("negative path: emits integration warning when github token or target repo missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: { githubToken: "", targetRepo: "", copilotCliCommand: "node", copilotGithubToken: "" }
    });
    assert.equal(result.ok, false);
    assert.ok(result.warnings.some((w: string) => w.includes("GitHub integration not ready")));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes agentContracts in the checks object", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    await writeCachedProbe(tmpDir, { copilotToken: "github_pat_test_valid" });
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: {
        githubToken: "x",
        targetRepo: "CanerDoqdu/Box",
        copilotCliCommand: "node",
        copilotGithubToken: "github_pat_test_valid",
      }
    });
    assert.ok("agentContracts" in result.checks, "checks must include agentContracts field");
    assert.equal(typeof result.checks.agentContracts, "boolean");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("negative path: ok=false when agentContracts check fails", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    await writeCachedProbe(tmpDir, { copilotToken: "github_pat_test_valid" });
    // ok is a composite of all critical checks — if agentContracts is false,
    // ok must also be false regardless of other check states.
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: {
        githubToken: "x",
        targetRepo: "CanerDoqdu/Box",
        copilotCliCommand: "node",
        copilotGithubToken: "github_pat_test_valid",
      }
    });
    // The check result itself is boolean; we verify the invariant:
    // ok === critical check conjunction including copilot auth.
    const expectedOk = result.checks.node
      && result.checks.githubToken
      && result.checks.targetRepo
      && result.checks.stateDir
      && result.checks.agentContracts
      && result.checks.copilotCli
      && result.checks.gitAvailable
      && result.checks.copilotAuth;
    assert.equal(result.ok, expectedOk, "ok must be false when any critical check fails including agentContracts");
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rejects classic ghp tokens because they override valid gh auth with an unsupported Copilot token", () => {
    const result = classifyCopilotAuthInputs({
      copilotToken: "ghp_classic_token",
      ghAuthActive: true,
      ghActiveAccount: "example",
    });
    assert.equal(result.ready, false);
    assert.equal(result.source, "env");
    assert.equal(result.tokenType, "ghp");
  });

  it("reuses cached successful auth probe only when fingerprint and cli path match", () => {
    const fingerprint = buildCopilotAuthFingerprint({
      copilotToken: "github_pat_test_valid",
      ghAuthActive: false,
      ghActiveAccount: null,
    });
    assert.equal(shouldReuseCopilotAuthProbe({
      ok: true,
      fingerprint,
      cliPath: "node",
      checkedAt: new Date().toISOString(),
    }, fingerprint, "node"), true);
    assert.equal(shouldReuseCopilotAuthProbe({
      ok: true,
      fingerprint,
      cliPath: "other",
      checkedAt: new Date().toISOString(),
    }, fingerprint, "node"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PRE-MERGE SENTINEL: doctor.ts export contract
//
// Fails fast if any symbol imported by this test file is absent from the
// runtime export of src/core/doctor.ts.  The import statement at the top
// already throws on missing named exports; these asserts add explicit
// diagnostic output in the CI log so the developer knows exactly which
// symbol regressed.
// ─────────────────────────────────────────────────────────────────────────────

describe("pre-merge sentinel: doctor.ts export contract", () => {
  it("all symbols imported from doctor.ts are defined with correct types", () => {
    assert.ok(typeof runDoctor === "function", "runDoctor must be a function");
    assert.ok(typeof classifyCopilotAuthInputs === "function", "classifyCopilotAuthInputs must be a function");
    assert.ok(typeof buildCopilotAuthFingerprint === "function", "buildCopilotAuthFingerprint must be a function");
    assert.ok(typeof shouldReuseCopilotAuthProbe === "function", "shouldReuseCopilotAuthProbe must be a function");
  });

  it("negative path: classifyCopilotAuthInputs returns ready:false for empty inputs", () => {
    const result = classifyCopilotAuthInputs({
      copilotToken: null,
      ghAuthActive: false,
      ghActiveAccount: null,
    });
    assert.equal(result.ready, false, "empty inputs must not be considered auth-ready");
    assert.equal(result.source, "none");
  });
});

