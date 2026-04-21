import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { resolveArchitectureDriftScanOptions } from "../../src/core/orchestrator.js";

describe("resolveArchitectureDriftScanOptions", () => {
  it("uses default docs traversal outside single-target mode", () => {
    const scanOptions = resolveArchitectureDriftScanOptions({
      paths: { repoRoot: "/repo" },
      platformModeState: { currentMode: "self_dev" },
      activeTargetSession: null,
    });

    assert.equal(scanOptions.rootDir, "/repo");
    assert.equal(scanOptions.docPaths, undefined);
    assert.equal(scanOptions.docDirs, undefined);
  });

  it("uses curated docPaths in single-target mode with an active session", () => {
    const scanOptions = resolveArchitectureDriftScanOptions({
      paths: { repoRoot: "/repo" },
      platformModeState: { currentMode: "single_target_delivery" },
      activeTargetSession: { sessionId: "sess_123" },
    });

    assert.equal(scanOptions.rootDir, "/repo");
    assert.deepEqual(scanOptions.docPaths, [
      "docs/single-target-startup-requirements.md",
      "docs/governance_contract.md",
      "docs/failure_taxonomy.md",
      "docs/prometheus.md",
    ]);
    assert.equal(scanOptions.docDirs, undefined);
  });

  it("falls back to default docs traversal if single-target mode has no active session", () => {
    const scanOptions = resolveArchitectureDriftScanOptions({
      paths: { repoRoot: "/repo" },
      platformModeState: { currentMode: "single_target_delivery" },
      activeTargetSession: null,
    });

    assert.equal(scanOptions.rootDir, "/repo");
    assert.equal(scanOptions.docPaths, undefined);
  });
});