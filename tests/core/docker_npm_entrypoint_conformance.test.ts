/**
 * Docker/npm Entrypoint Conformance Test
 *
 * Static assertions ensuring that Docker CMD directives, docker-compose command
 * overrides, and npm scripts remain executable together.
 *
 * Checked invariants:
 *  1. Every `npm run <script>` used in docker-compose.yml exists in package.json.
 *  2. Every `npm run <script>` used in any Dockerfile exists in package.json.
 *  3. Every TypeScript/JS entry point referenced in Dockerfile CMD exists on disk.
 *  4. Every TypeScript/JS entry point referenced in docker-compose commands exists on disk.
 *  5. The worker Dockerfile CMD entry point matches the corresponding npm script.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

/** Extract all `npm run <script>` references from a string. */
function extractNpmRunScripts(text: string): string[] {
  const matches = [...text.matchAll(/npm\s+run\s+([\w:@-]+)/g)];
  return matches.map((m) => m[1]);
}

/** Extract Dockerfile CMD array entries (handles JSON array syntax only). */
function extractDockerfileCmdFiles(text: string): string[] {
  // Match: CMD ["node", "--import", "tsx", "some/path.ts"] or similar
  const cmdMatch = text.match(/^CMD\s+(\[.+?\])/m);
  if (!cmdMatch) return [];
  try {
    const parts: unknown = JSON.parse(cmdMatch[1]);
    if (!Array.isArray(parts)) return [];
    // Return the last entry that looks like a .ts or .js file path
    return (parts as string[]).filter(
      (p) => typeof p === "string" && (p.endsWith(".ts") || p.endsWith(".js")) && p.includes("/")
    );
  } catch {
    return [];
  }
}

/** Extract file path entries from docker-compose command strings (sh -c "... node ... path.ts"). */
function extractComposeCommandFiles(text: string): string[] {
  const results: string[] = [];
  const nodeRefs = [...text.matchAll(/node\s+(?:--\S+\s+)*([^\s"'\\]+\.ts)/g)];
  for (const m of nodeRefs) {
    results.push(m[1]);
  }
  return results;
}

// ─── Load artifacts ───────────────────────────────────────────────────────────

const pkgPath = path.join(ROOT, "package.json");
const composePath = path.join(ROOT, "docker-compose.yml");
const orchestratorDockerfilePath = path.join(ROOT, "docker", "orchestrator", "Dockerfile");
const workerDockerfilePath = path.join(ROOT, "docker", "worker", "Dockerfile");

const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
  scripts?: Record<string, string>;
};
const packageScripts: Record<string, string> = pkg.scripts ?? {};

const composeText = fs.readFileSync(composePath, "utf8");
const orchestratorDockerfile = fs.readFileSync(orchestratorDockerfilePath, "utf8");
const workerDockerfile = fs.readFileSync(workerDockerfilePath, "utf8");

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("docker_npm_entrypoint_conformance", () => {
  it("all npm run scripts referenced in docker-compose.yml exist in package.json", () => {
    const scripts = extractNpmRunScripts(composeText);
    assert.ok(scripts.length > 0, "docker-compose.yml should reference at least one npm run script");
    const missing = scripts.filter((s) => !(s in packageScripts));
    assert.deepStrictEqual(
      missing,
      [],
      `docker-compose.yml references missing npm scripts: ${missing.join(", ")}`
    );
  });

  it("all npm run scripts referenced in worker Dockerfile exist in package.json", () => {
    const scripts = extractNpmRunScripts(workerDockerfile);
    if (scripts.length === 0) return; // worker Dockerfile may use CMD directly — acceptable
    const missing = scripts.filter((s) => !(s in packageScripts));
    assert.deepStrictEqual(
      missing,
      [],
      `worker Dockerfile references missing npm scripts: ${missing.join(", ")}`
    );
  });

  it("all npm run scripts referenced in orchestrator Dockerfile exist in package.json", () => {
    const scripts = extractNpmRunScripts(orchestratorDockerfile);
    if (scripts.length === 0) return; // orchestrator Dockerfile may delegate to compose — acceptable
    const missing = scripts.filter((s) => !(s in packageScripts));
    assert.deepStrictEqual(
      missing,
      [],
      `orchestrator Dockerfile references missing npm scripts: ${missing.join(", ")}`
    );
  });

  it("worker Dockerfile CMD entry point file exists on disk", () => {
    const files = extractDockerfileCmdFiles(workerDockerfile);
    assert.ok(files.length > 0,
      "worker Dockerfile must have a CMD referencing at least one .ts or .js entry point file"
    );
    for (const relPath of files) {
      const fullPath = path.join(ROOT, relPath);
      assert.ok(
        fs.existsSync(fullPath),
        `worker Dockerfile CMD references non-existent file: ${relPath} (full path: ${fullPath})`
      );
    }
  });

  it("docker-compose.yml command entry point files exist on disk", () => {
    const files = extractComposeCommandFiles(composeText);
    for (const relPath of files) {
      const fullPath = path.join(ROOT, relPath);
      assert.ok(
        fs.existsSync(fullPath),
        `docker-compose.yml command references non-existent file: ${relPath}`
      );
    }
  });

  it("npm scripts referenced in docker contexts reference entry point files that exist", () => {
    // Collect all npm scripts used in Docker artifacts
    const allDockerScripts = [
      ...extractNpmRunScripts(composeText),
      ...extractNpmRunScripts(workerDockerfile),
      ...extractNpmRunScripts(orchestratorDockerfile),
    ];
    const uniqueScripts = [...new Set(allDockerScripts)];

    for (const scriptName of uniqueScripts) {
      const scriptCmd = packageScripts[scriptName];
      if (!scriptCmd) continue; // already caught by earlier tests
      // Extract any .ts or .js file reference from the script command
      const fileRefs = [...scriptCmd.matchAll(/src\/[^\s"']+\.ts/g)].map((m) => m[0]);
      for (const relPath of fileRefs) {
        const fullPath = path.join(ROOT, relPath);
        assert.ok(
          fs.existsSync(fullPath),
          `npm script "${scriptName}" (used in Docker) references non-existent file: ${relPath}`
        );
      }
    }
  });

  it("worker Dockerfile CMD is consistent with worker:run npm script", () => {
    const workerRunScript = packageScripts["worker:run"];
    assert.ok(workerRunScript,
      'package.json must define a "worker:run" script — this is the canonical container entrypoint'
    );

    const cmdFiles = extractDockerfileCmdFiles(workerDockerfile);
    assert.ok(cmdFiles.length > 0,
      "worker Dockerfile must have a CMD with at least one .ts or .js file entry point (no CMD found or CMD uses unsupported non-array syntax)"
    );

    const cmdEntryPoint = cmdFiles[0];
    assert.ok(
      workerRunScript.includes(cmdEntryPoint),
      `worker Dockerfile CMD entry point "${cmdEntryPoint}" must appear verbatim in the "worker:run" npm script ("${workerRunScript}") — CMD and npm script have drifted`
    );
  });

  it("docker-compose.yml command uses sh -c form consistent with npm script chaining", () => {
    // Verify the compose command uses "sh -c" which is the correct form for
    // running "npm ci && npm run ..." as a single container entrypoint
    assert.ok(
      composeText.includes("sh") && composeText.includes("npm ci"),
      'docker-compose.yml command should use "sh -c" with "npm ci" bootstrap'
    );
    // Also verify box:start is the startup script (not an arbitrary one)
    assert.ok(
      composeText.includes("npm run box:start"),
      'docker-compose.yml command should launch via "npm run box:start"'
    );
  });

  it("negative: npm run scripts in docker contexts are not empty or whitespace-only", () => {
    const allDockerScripts = [
      ...extractNpmRunScripts(composeText),
      ...extractNpmRunScripts(workerDockerfile),
      ...extractNpmRunScripts(orchestratorDockerfile),
    ];
    assert.ok(allDockerScripts.length > 0,
      "expected at least one npm run script across Docker artifacts (compose + worker + orchestrator Dockerfiles)"
    );
    for (const s of allDockerScripts) {
      assert.ok(s.trim().length > 0,
        `every npm run script name extracted from Docker artifacts must be non-empty; got: "${s}"`
      );
    }
  });
});
