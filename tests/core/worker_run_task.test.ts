/**
 * Tests for src/workers/run_task.js entry-point validation logic.
 *
 * We exercise the env-var validation path by spawning the module as a
 * child process and inspecting exit code + stderr output, which keeps
 * the test isolated and deterministic.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { parseContractHealth, isContractHealthy, formatContractHealth, parseStartupContractAnchor, formatStartupContractAnchor, STARTUP_CONTRACT_ANCHOR_KEY } from "../../src/workers/contract_health.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "../../src/workers/run_task.ts");

function run(env = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", ENTRY], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("run_task.js — containerised worker entry point", () => {
  it("exits 1 and reports missing vars when all required env vars are absent", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1,
      "expected exit code 1 when all required env vars are absent (WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN)"
    );
    assert.match(result.stderr, /Missing required environment variable/,
      "stderr must name at least one missing required variable"
    );
    // Verify each required env var name appears in the combined output
    const combined = result.stderr + result.stdout;
    const requiredVars = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];
    const reported = requiredVars.filter(v => combined.includes(v));
    assert.ok(
      reported.length > 0,
      `at least one of [${requiredVars.join(", ")}] must be named in the missing-var output; got: ${combined.slice(0, 300)}`
    );
  });

  it("exits 1 when TASK_PAYLOAD is not valid JSON", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "not-json",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "expected exit code 1 when TASK_PAYLOAD is not valid JSON");
    assert.match(result.stderr, /not valid JSON/,
      'stderr must contain "not valid JSON" to describe the parse failure'
    );
  });

  it("exits 0 and logs startup info when all env vars are valid", () => {
    const task = JSON.stringify({ id: "t-1", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0,
      `expected exit 0 when all env vars are valid; stderr: ${result.stderr}`
    );
    assert.match(result.stdout, /role=noah/,
      'stdout must log "role=noah" to confirm the worker role is echoed on startup'
    );
    assert.match(result.stdout, /id=t-1/,
      'stdout must log "id=t-1" to confirm the task id is echoed on startup'
    );
  });
});

// ── Contract health gate ──────────────────────────────────────────────────────

describe("run_task.js — WORKER_CONTRACT_HEALTH runtime gate", () => {
  it("emits WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass on success", () => {
    const task = JSON.stringify({ id: "t-42", kind: "implementation" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass/,
      "stdout must contain the full-pass contract health line"
    );
  });

  it("emits WORKER_CONTRACT_HEALTH=env_vars:fail on missing env vars (written to stderr)", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /WORKER_CONTRACT_HEALTH=env_vars:fail/,
      "stderr must contain env_vars:fail when required env vars are missing"
    );
    assert.match(result.stderr, /payload:n\/a/, "payload must be n/a when env_vars fail");
    assert.match(result.stderr, /role:n\/a/, "role must be n/a when env_vars fail");
  });

  it("emits WORKER_CONTRACT_HEALTH=env_vars:pass;payload:fail on invalid JSON (written to stderr)", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "{broken json",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /WORKER_CONTRACT_HEALTH=env_vars:pass;payload:fail/,
      "stderr must show env_vars:pass and payload:fail when JSON is invalid"
    );
    assert.match(result.stderr, /role:n\/a/, "role must be n/a when payload fails to parse");
  });

  it("parseContractHealth correctly parses a full-pass health line", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass";
    const health = parseContractHealth(line);
    assert.ok(health !== null, "parseContractHealth must return a non-null object for a valid line");
    assert.equal(health!.env_vars, "pass");
    assert.equal(health!.payload, "pass");
    assert.equal(health!.role, "pass");
  });

  it("parseContractHealth correctly parses an env_vars:fail line", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:fail;payload:n/a;role:n/a";
    const health = parseContractHealth(line);
    assert.ok(health !== null);
    assert.equal(health!.env_vars, "fail");
    assert.equal(health!.payload, "n/a");
    assert.equal(health!.role, "n/a");
  });

  it("parseContractHealth returns null for lines without the health marker", () => {
    assert.equal(parseContractHealth(""), null);
    assert.equal(parseContractHealth("[run_task] Worker ready."), null);
    assert.equal(parseContractHealth("BOX_STATUS=done"), null);
  });

  it("isContractHealthy returns true only when all three slots are pass", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "pass" }), true);
    assert.equal(isContractHealthy({ env_vars: "fail", payload: "pass", role: "pass" }), false);
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "n/a", role: "pass" }), false);
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "fail" }), false);
  });

  it("formatContractHealth produces a deterministic, machine-parseable line", () => {
    const health = { env_vars: "pass" as const, payload: "pass" as const, role: "pass" as const };
    const line = formatContractHealth(health);
    assert.equal(line, "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass");
    const parsed = parseContractHealth(line);
    assert.deepEqual(parsed, health);
  });

  it("negative: contract health gate is unhealthy when env_vars fail", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: JSON.stringify({ id: "t-1" }),
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    const combinedOutput = result.stderr + result.stdout;
    const healthLine = combinedOutput.split("\n").find(l => l.includes("WORKER_CONTRACT_HEALTH="));
    assert.ok(healthLine, "WORKER_CONTRACT_HEALTH line must appear in combined output");
    const health = parseContractHealth(healthLine!);
    assert.ok(health !== null);
    assert.equal(isContractHealthy(health!), false,
      "startup contract must not be healthy when required env vars are missing"
    );
  });
});

// ── Carry-forward env/startup contract gap tests ──────────────────────────────

describe("run_task.js — startup ordering and env/startup contract gaps", () => {
  it("env_vars check runs before payload check: env failure reported when both ROLE and PAYLOAD are absent", () => {
    // When WORKER_ROLE is empty and TASK_PAYLOAD is also empty,
    // env_vars:fail must be emitted — not payload:fail — because env check runs first.
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1, "must exit 1 when all required vars are absent");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must appear in stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars slot must be 'fail' when env vars are absent — env check is first"
    );
    assert.equal(health!.payload, "n/a",
      "payload slot must be 'n/a' when env_vars fails (payload check not reached)"
    );
    assert.equal(health!.role, "n/a",
      "role slot must be 'n/a' when env_vars fails (role check not reached)"
    );
  });

  it("single missing env var triggers env_vars:fail (partial env_vars failure)", () => {
    // Only TARGET_REPO is missing — still an env_vars failure
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: JSON.stringify({ id: "t-99", kind: "implementation" }),
      TARGET_REPO: "",            // single missing required var
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when a single required env var is absent");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must appear in stderr for single-missing-var failure");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' even for a single missing variable"
    );
  });

  it("startup log line appears in stdout before the contract health line on success", () => {
    const task = JSON.stringify({ id: "t-88", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 when all env vars are valid");

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const startupIdx = lines.findIndex(l => l.includes("[run_task] Worker container started"));
    const healthIdx  = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));

    assert.ok(startupIdx >= 0, "'Worker container started' line must appear in stdout");
    assert.ok(healthIdx >= 0,  "WORKER_CONTRACT_HEALTH line must appear in stdout on success");
    assert.ok(startupIdx < healthIdx,
      "startup log line must appear BEFORE the contract health line (startup ordering contract)"
    );
  });

  it("contract health line appears before 'Worker ready' message on success (health gate is pre-ready)", () => {
    const task = JSON.stringify({ id: "t-77", kind: "infrastructure" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const healthIdx = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));
    const readyIdx  = lines.findIndex(l => l.includes("Worker ready"));

    assert.ok(healthIdx >= 0, "WORKER_CONTRACT_HEALTH line must appear in stdout");
    assert.ok(readyIdx >= 0,  "'Worker ready' message must appear in stdout");
    assert.ok(healthIdx < readyIdx,
      "contract health line must appear BEFORE 'Worker ready' (health gate precedes task dispatch)"
    );
  });

  it("WORKER_ROLE value is echoed in the startup log line for every successful start", () => {
    for (const role of ["noah", "evolution-worker", "quality-worker"]) {
      const task = JSON.stringify({ id: `t-${role}`, kind: "test" });
      const result = run({
        WORKER_ROLE: role,
        TASK_PAYLOAD: task,
        TARGET_REPO: "owner/repo",
        GITHUB_TOKEN: "ghp_fake",
      });
      assert.equal(result.status, 0, `must exit 0 for role=${role}`);
      assert.match(
        result.stdout,
        new RegExp(`role=${role}`),
        `stdout must echo role=${role} in the startup log line`
      );
    }
  });

  it("negative: WORKER_ROLE is NOT echoed to stdout when env_vars check fails", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    // The startup log line that echoes role= must not appear when env check fails
    // (it is written only after env validation passes)
    assert.ok(
      !result.stdout.includes("Worker container started"),
      "startup log must NOT appear in stdout when env_vars check fails — fail-fast before echoing role"
    );
  });

  it("TARGET_REPO value is echoed as repo= in the startup log line on success", () => {
    const task = JSON.stringify({ id: "t-repo", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/myrepo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 when all env vars are valid");
    assert.match(
      result.stdout,
      /repo=owner\/myrepo/,
      "stdout must echo repo=<TARGET_REPO> in the startup log line so the operator can confirm which repo the worker targets"
    );
  });
});

// ── Per-variable named env contract tests ────────────────────────────────────

/**
 * These tests verify the exact required env var contract for run_task.ts.
 * Each required variable is tested in isolation so that future renames or
 * additions are caught immediately by a named, scoped failure.
 *
 * Required env vars (authoritative set): WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN
 */
describe("run_task.js — exact named required-env-var contract", () => {
  it("documents the exact required env var set: WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN", () => {
    // This test pins the authoritative required-variable names.
    // If any variable is added or renamed in run_task.ts, this test must be
    // updated to reflect the new contract — preventing silent terminology drift.
    const REQUIRED_ENV_VARS = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];

    // Run with all vars absent and confirm each name appears in the error output
    const result = run(
      Object.fromEntries(REQUIRED_ENV_VARS.map(v => [v, ""]))
    );
    assert.equal(result.status, 1, "must exit 1 when all required vars are absent");

    const combined = result.stderr + result.stdout;
    for (const varName of REQUIRED_ENV_VARS) {
      assert.ok(
        combined.includes(varName),
        `required env var '${varName}' must be named in the error output; combined output: ${combined.slice(0, 400)}`
      );
    }
  });

  it("WORKER_ROLE alone missing → env_vars:fail with WORKER_ROLE named in stderr", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: JSON.stringify({ id: "t-wrmissing", kind: "devops" }),
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when WORKER_ROLE is absent");
    assert.match(result.stderr, /WORKER_ROLE/,
      "stderr must name WORKER_ROLE as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when WORKER_ROLE is missing");
    assert.equal(health!.payload, "n/a",
      "payload must be 'n/a' when env_vars check fails (not reached)");
    assert.equal(health!.role, "n/a",
      "role must be 'n/a' when env_vars check fails (not reached)");
  });

  it("GITHUB_TOKEN alone missing → env_vars:fail with GITHUB_TOKEN named in stderr", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: JSON.stringify({ id: "t-ghtoken", kind: "devops" }),
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1, "must exit 1 when GITHUB_TOKEN is absent");
    assert.match(result.stderr, /GITHUB_TOKEN/,
      "stderr must name GITHUB_TOKEN as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when GITHUB_TOKEN is missing");
    assert.equal(health!.payload, "n/a");
    assert.equal(health!.role, "n/a");
  });

  it("TASK_PAYLOAD alone missing → env_vars:fail with TASK_PAYLOAD named in stderr", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when TASK_PAYLOAD is absent");
    assert.match(result.stderr, /TASK_PAYLOAD/,
      "stderr must name TASK_PAYLOAD as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when TASK_PAYLOAD is missing (treated as absent by the env check)");
  });

  it("all four required vars present → exits 0 with full-pass contract health on stdout", () => {
    const task = JSON.stringify({ id: "t-allpresent", kind: "implementation" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 when all four required vars are present");
    const health = parseContractHealth(result.stdout);
    assert.ok(health !== null,
      "WORKER_CONTRACT_HEALTH must appear in stdout on success");
    assert.equal(health!.env_vars, "pass");
    assert.equal(health!.payload, "pass");
    assert.equal(health!.role, "pass");
  });
});

// ── Named startup-contract verification anchor ────────────────────────────────

/**
 * STARTUP_CONTRACT_ANCHOR — explicit named verification anchor.
 *
 * These tests pin the named anchor (WORKER_STARTUP_CONTRACT_ANCHOR=verified)
 * that closes carry-forward ambiguity: downstream gates use this line to
 * distinguish a freshly-verified contract from a stale health line carried
 * forward in logs from a previous startup cycle.
 */
describe("run_task.js — STARTUP_CONTRACT_ANCHOR named verification anchor", () => {
  it("STARTUP_CONTRACT_ANCHOR: emits WORKER_STARTUP_CONTRACT_ANCHOR=verified on successful startup", () => {
    const task = JSON.stringify({ id: "t-anchor", kind: "infrastructure" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 for a valid startup");
    assert.ok(
      result.stdout.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      `stdout must contain '${STARTUP_CONTRACT_ANCHOR_KEY}=verified' to confirm startup-contract verification completed`
    );
  });

  it("STARTUP_CONTRACT_ANCHOR: parseStartupContractAnchor returns true for the anchor line", () => {
    const anchorLine = formatStartupContractAnchor();
    assert.equal(anchorLine, `${STARTUP_CONTRACT_ANCHOR_KEY}=verified`);
    assert.equal(parseStartupContractAnchor(anchorLine), true);
  });

  it("STARTUP_CONTRACT_ANCHOR: parseStartupContractAnchor returns false for unrelated lines", () => {
    assert.equal(parseStartupContractAnchor(""), false);
    assert.equal(parseStartupContractAnchor("WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass"), false);
    assert.equal(parseStartupContractAnchor("BOX_STATUS=done"), false);
    assert.equal(parseStartupContractAnchor("[run_task] Worker ready."), false);
  });

  it("STARTUP_CONTRACT_ANCHOR: anchor appears after contract health line in stdout (post-gate ordering)", () => {
    const task = JSON.stringify({ id: "t-ordering", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const healthIdx = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));
    const anchorIdx = lines.findIndex(l => l.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`));

    assert.ok(healthIdx >= 0, "WORKER_CONTRACT_HEALTH line must appear in stdout");
    assert.ok(anchorIdx >= 0, `${STARTUP_CONTRACT_ANCHOR_KEY}=verified line must appear in stdout`);
    assert.ok(healthIdx < anchorIdx,
      "contract health line must appear BEFORE the anchor (health gate precedes anchor emission)"
    );
  });

  it("negative: STARTUP_CONTRACT_ANCHOR is NOT emitted when env_vars check fails", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      "startup-contract anchor must NOT appear when env_vars check fails — it is only emitted after all slots pass"
    );
  });

  it("negative: STARTUP_CONTRACT_ANCHOR is NOT emitted when TASK_PAYLOAD is invalid JSON", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "{broken",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1);
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      "startup-contract anchor must NOT appear when payload check fails"
    );
  });
});

// ── Docker entrypoint conformance and canonical named test proofs ─────────────

/**
 * CANONICAL_TEST_PROOF: These tests unify Docker entrypoint conformance with
 * worker startup contract verification.  Each test is explicitly named so that
 * downstream verification gates can match the test name against packet
 * verification fields (named test proof pattern).
 *
 * Invariants verified:
 *  1. The ENTRY constant used in tests matches the Docker worker CMD — production
 *     containers run the exact same file that tests exercise.
 *  2. The package.json "worker:run" script references the same entry point.
 *  3. The ENTRY file exists on disk (pre-condition for all startup contract tests).
 *  4. A healthy startup anchor is not emitted when Docker CMD cannot start cleanly
 *     (missing env vars simulation).
 */
describe("run_task.js — Docker entrypoint conformance and canonical named test proofs", () => {
  const ROOT = path.resolve(__dirname, "..", "..");
  const workerDockerfilePath = path.join(ROOT, "docker", "worker", "Dockerfile");

  function extractDockerfileCmdFiles(text: string): string[] {
    const cmdMatch = text.match(/^CMD\s+(\[.+?\])/m);
    if (!cmdMatch) return [];
    try {
      const parts: unknown = JSON.parse(cmdMatch[1]);
      if (!Array.isArray(parts)) return [];
      return (parts as string[]).filter(
        (p) => typeof p === "string" && (p.endsWith(".ts") || p.endsWith(".js")) && p.includes("/")
      );
    } catch {
      return [];
    }
  }

  it("CANONICAL_TEST_PROOF: worker Dockerfile CMD entry point matches the ENTRY constant used in tests", () => {
    const dockerfileText = fs.readFileSync(workerDockerfilePath, "utf8");
    const cmdFiles = extractDockerfileCmdFiles(dockerfileText);
    assert.ok(
      cmdFiles.length > 0,
      "worker Dockerfile must have a CMD referencing at least one .ts or .js entry point file"
    );
    const cmdEntryFile = cmdFiles[0];
    // ENTRY is an absolute path; convert to repo-relative for comparison
    const entryRelative = path
      .relative(ROOT, ENTRY)
      .split(path.sep)
      .join("/");
    assert.equal(
      cmdEntryFile,
      entryRelative,
      `worker Dockerfile CMD entry point "${cmdEntryFile}" must match ENTRY constant "${entryRelative}" — tests and container run the same file`
    );
  });

  it("CANONICAL_TEST_PROOF: worker:run npm script contains the same entry point as the Dockerfile CMD", () => {
    const pkgPath = path.join(ROOT, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const workerRun = pkg.scripts?.["worker:run"];
    assert.ok(
      workerRun,
      'package.json must define a "worker:run" script — this is the canonical container entrypoint'
    );
    const dockerfileText = fs.readFileSync(workerDockerfilePath, "utf8");
    const cmdFiles = extractDockerfileCmdFiles(dockerfileText);
    assert.ok(cmdFiles.length > 0, "worker Dockerfile must have a CMD with a .ts/.js entry point");
    const cmdEntryFile = cmdFiles[0];
    assert.ok(
      workerRun.includes(cmdEntryFile),
      `"worker:run" npm script must include the Docker CMD entry point "${cmdEntryFile}" (got: "${workerRun}")`
    );
  });

  it("CANONICAL_TEST_PROOF: ENTRY file exists on disk — startup contract requires the entry file to be present", () => {
    assert.ok(
      fs.existsSync(ENTRY),
      `ENTRY file must exist on disk: ${ENTRY}`
    );
  });

  it("CANONICAL_TEST_PROOF: Docker worker Dockerfile CMD is a valid JSON array with node and tsx", () => {
    const dockerfileText = fs.readFileSync(workerDockerfilePath, "utf8");
    const cmdMatch = dockerfileText.match(/^CMD\s+(\[.+?\])/m);
    assert.ok(cmdMatch, "worker Dockerfile must have a CMD directive using JSON array syntax");
    const parts: string[] = JSON.parse(cmdMatch![1]);
    assert.ok(
      parts.includes("node"),
      "Docker CMD must include 'node' as the runtime executable"
    );
    const hasTsx = parts.some(p => p.includes("tsx"));
    assert.ok(
      hasTsx,
      "Docker CMD must use '--import tsx' or similar tsx invocation to support TypeScript entry points"
    );
  });

  it("negative: CANONICAL_TEST_PROOF: startup contract anchor absent when env vars are missing — Docker CMD cannot produce healthy startup without env vars", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1,
      "exit code must be 1 when all required env vars are absent (Docker CMD startup failure)"
    );
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      "startup-contract anchor must NOT appear when Docker CMD cannot complete env var validation"
    );
  });

  it("CANONICAL_TEST_PROOF: NAMED_TEST_PROOF_PATTERN accepts worker_run_task.test.ts as a valid named test proof reference", async () => {
    // Meta-verification: the CANONICAL_TEST_PROOF naming convention used in this file
    // must be parseable by NAMED_TEST_PROOF_PATTERN in verification_gate.ts.
    // If the pattern is narrowed in a future change, this test will catch the regression.
    const { NAMED_TEST_PROOF_PATTERN } = await import("../../src/core/verification_gate.js");
    const sampleVerification = "tests/core/worker_run_task.test.ts \u2014 CANONICAL_TEST_PROOF: worker Dockerfile CMD entry point matches the ENTRY constant used in tests";
    const match = NAMED_TEST_PROOF_PATTERN.exec(sampleVerification);
    assert.ok(
      match !== null,
      `CANONICAL_TEST_PROOF naming must be parseable by NAMED_TEST_PROOF_PATTERN; tested: "${sampleVerification}"`
    );
    assert.ok(
      match![1].includes("worker_run_task.test.ts"),
      "parsed test file must reference worker_run_task.test.ts"
    );
  });
});

// ── Discovery-safe bypass — non-merge task kinds must not be done-blocked ─────
//
// Verifies that discovery-safe (non-merge) task kinds are exempt from the
// post-merge artifact gate and that the strict merge evidence gate is
// preserved for implementation/rework task kinds.
//
// Referenced by: src/core/verification_gate.ts — isDiscoverySafeTask,
//                DISCOVERY_SAFE_TASK_KINDS, NON_MERGE_TASK_KINDS

describe("run_task.js — discovery-safe bypass for non-merge task kinds", () => {
  it("DISCOVERY_SAFE: NON_MERGE_TASK_KINDS includes all canonical non-merge kinds", async () => {
    const { NON_MERGE_TASK_KINDS } = await import("../../src/core/verification_gate.js");
    const expected = ["scan", "doc", "observation", "diagnosis", "discovery", "research", "review", "audit"];
    for (const kind of expected) {
      assert.ok(
        NON_MERGE_TASK_KINDS.has(kind),
        `NON_MERGE_TASK_KINDS must include "${kind}" — non-merge tasks must bypass the artifact gate`
      );
    }
  });

  it("DISCOVERY_SAFE: DISCOVERY_SAFE_TASK_KINDS is a superset of NON_MERGE_TASK_KINDS", async () => {
    const { NON_MERGE_TASK_KINDS, DISCOVERY_SAFE_TASK_KINDS } = await import("../../src/core/verification_gate.js");
    for (const kind of NON_MERGE_TASK_KINDS) {
      assert.ok(
        DISCOVERY_SAFE_TASK_KINDS.has(kind),
        `"${kind}" is in NON_MERGE_TASK_KINDS but not in DISCOVERY_SAFE_TASK_KINDS — every non-merge kind must be discovery-safe`
      );
    }
  });

  it("DISCOVERY_SAFE: isDiscoverySafeTask returns true for all discovery-safe kinds", async () => {
    const { isDiscoverySafeTask } = await import("../../src/core/verification_gate.js");
    const safeKinds = ["scan", "doc", "observation", "diagnosis", "discovery", "research", "review", "audit"];
    for (const kind of safeKinds) {
      assert.equal(
        isDiscoverySafeTask(kind),
        true,
        `isDiscoverySafeTask("${kind}") must return true — discovery-safe tasks bypass the artifact gate`
      );
    }
  });

  it("DISCOVERY_SAFE: isDiscoverySafeTask returns false for merge-oriented kinds", async () => {
    const { isDiscoverySafeTask } = await import("../../src/core/verification_gate.js");
    const mergeKinds = ["implementation", "rework", "backend", "frontend", "devops", "infrastructure"];
    for (const kind of mergeKinds) {
      assert.equal(
        isDiscoverySafeTask(kind),
        false,
        `isDiscoverySafeTask("${kind}") must return false — merge tasks require artifact evidence`
      );
    }
  });

  it("DISCOVERY_SAFE: isDiscoverySafeTask returns false for null/undefined/empty inputs", async () => {
    const { isDiscoverySafeTask } = await import("../../src/core/verification_gate.js");
    assert.equal(isDiscoverySafeTask(null), false, "null must not be discovery-safe");
    assert.equal(isDiscoverySafeTask(undefined), false, "undefined must not be discovery-safe");
    assert.equal(isDiscoverySafeTask(""), false, "empty string must not be discovery-safe");
  });

  it("DISCOVERY_SAFE: isArtifactGateRequired returns false for all discovery-safe task kinds", async () => {
    const { isArtifactGateRequired, DISCOVERY_SAFE_TASK_KINDS } = await import("../../src/core/verification_gate.js");
    for (const kind of DISCOVERY_SAFE_TASK_KINDS) {
      assert.equal(
        isArtifactGateRequired("backend", kind),
        false,
        `isArtifactGateRequired("backend", "${kind}") must return false — discovery-safe tasks must never be artifact-gated`
      );
    }
  });

  it("DISCOVERY_SAFE: isArtifactGateRequired returns true for merge-oriented task kinds (strict gate preserved)", async () => {
    const { isArtifactGateRequired } = await import("../../src/core/verification_gate.js");
    const mergeKinds = ["implementation", "rework", null, undefined];
    for (const kind of mergeKinds) {
      assert.equal(
        isArtifactGateRequired("backend", kind),
        true,
        `isArtifactGateRequired("backend", ${JSON.stringify(kind)}) must return true — merge tasks must pass the strict artifact gate`
      );
    }
  });

  it("negative: DISCOVERY_SAFE: 'rework' kind is NOT discovery-safe — strict gate applies", async () => {
    const { isDiscoverySafeTask, isArtifactGateRequired } = await import("../../src/core/verification_gate.js");
    assert.equal(isDiscoverySafeTask("rework"), false, "rework tasks must not bypass the artifact gate");
    assert.equal(isArtifactGateRequired("backend", "rework"), true, "rework tasks must pass the strict artifact gate");
  });
});

