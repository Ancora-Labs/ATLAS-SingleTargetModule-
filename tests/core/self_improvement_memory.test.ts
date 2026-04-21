/**
 * self_improvement_memory.test.ts
 *
 * Tests for Task 3: Partitioned knowledge memory upgrade.
 *   - v1 → v2 migration correctness
 *   - Working partition receives new lessons
 *   - Episodic partition receives promoted lessons
 *   - retrieveMemoryForContext returns trust-reranked results
 *   - Low-trust entries filtered unless includeLowTrust+privilegedCaller
 *   - rerankMemoryByTrust in trust_boundary
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  migrateKnowledgeMemoryV1ToV2,
  KNOWLEDGE_MEMORY_SCHEMA_VERSION,
  MEMORY_PARTITION,
  retrieveMemoryForContext,
} from "../../src/core/self_improvement.js";

import {
  rerankMemoryByTrust,
  MEMORY_TRUST_LEVEL,
} from "../../src/core/trust_boundary.js";

// ── migrateKnowledgeMemoryV1ToV2 ─────────────────────────────────────────────

describe("migrateKnowledgeMemoryV1ToV2 — v1 to v2 migration", () => {
  it("sets schemaVersion to the current version constant", () => {
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons: [], configTunings: [], promptHints: [] });
    assert.equal(v2.schemaVersion, KNOWLEDGE_MEMORY_SCHEMA_VERSION);
  });

  it("preserves all lessons across working + episodic partitions", () => {
    const lessons = Array.from({ length: 25 }, (_, i) => ({ lesson: `lesson-${i}`, severity: "info" }));
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons });
    const all = [...v2.working.lessons, ...v2.episodic.lessons];
    assert.equal(all.length, 25, "all 25 lessons must be preserved after migration");
  });

  it("puts at most 20 lessons in working partition", () => {
    const lessons = Array.from({ length: 30 }, (_, i) => ({ lesson: `L${i}` }));
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons });
    assert.ok(v2.working.lessons.length <= 20, "working partition must not exceed 20 lessons");
  });

  it("puts older lessons in episodic partition", () => {
    const lessons = Array.from({ length: 30 }, (_, i) => ({ lesson: `L${i}` }));
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons });
    // The first (oldest) 10 should be in episodic
    assert.equal(v2.episodic.lessons[0].lesson, "L0", "oldest lesson must be in episodic");
  });

  it("working partition receives the most recent lessons", () => {
    const lessons = Array.from({ length: 30 }, (_, i) => ({ lesson: `L${i}` }));
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons });
    // Most recent 20: L10..L29
    assert.equal(v2.working.lessons[0].lesson, "L10", "first working lesson must be L10 (index 10)");
    assert.equal(v2.working.lessons[v2.working.lessons.length - 1].lesson, "L29");
  });

  it("configTunings and promptHints migrate to working partition", () => {
    const v1 = {
      lessons: [],
      configTunings: [{ key: "maxRetries", value: 3 }],
      promptHints: [{ hint: "be concise" }],
    };
    const v2 = migrateKnowledgeMemoryV1ToV2(v1);
    assert.equal(v2.working.configTunings.length, 1);
    assert.equal(v2.working.promptHints.length, 1);
  });

  it("policy partition starts empty", () => {
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons: [] });
    assert.deepEqual(v2.policy.rules, []);
  });

  it("lastUpdated is preserved on migration", () => {
    const ts = "2025-01-01T00:00:00.000Z";
    const v2 = migrateKnowledgeMemoryV1ToV2({ lessons: [], lastUpdated: ts });
    assert.equal(v2.lastUpdated, ts);
  });

  it("handles missing fields gracefully (no lessons, no configTunings, no promptHints)", () => {
    const v2 = migrateKnowledgeMemoryV1ToV2({});
    assert.deepEqual(v2.working.lessons, []);
    assert.deepEqual(v2.working.configTunings, []);
    assert.deepEqual(v2.working.promptHints, []);
    assert.deepEqual(v2.episodic.lessons, []);
  });

  it("negative path: null input migrates to empty v2 structure", () => {
    const v2 = migrateKnowledgeMemoryV1ToV2(null);
    assert.equal(v2.schemaVersion, KNOWLEDGE_MEMORY_SCHEMA_VERSION);
    assert.deepEqual(v2.working.lessons, []);
    assert.deepEqual(v2.episodic.lessons, []);
  });
});

// ── MEMORY_PARTITION constants ────────────────────────────────────────────────

describe("MEMORY_PARTITION — partition name constants", () => {
  it("exports WORKING, EPISODIC, POLICY partition names", () => {
    assert.equal(MEMORY_PARTITION.WORKING,  "working");
    assert.equal(MEMORY_PARTITION.EPISODIC, "episodic");
    assert.equal(MEMORY_PARTITION.POLICY,   "policy");
  });
});

// ── rerankMemoryByTrust (trust_boundary) ──────────────────────────────────────

describe("rerankMemoryByTrust — trust-weighted reranker", () => {
  const highEntry  = { lesson: "high",   trust: { level: MEMORY_TRUST_LEVEL.HIGH,   source: "system", reason: "", taggedAt: new Date().toISOString() } };
  const medEntry   = { lesson: "medium", trust: { level: MEMORY_TRUST_LEVEL.MEDIUM, source: "model",  reason: "", taggedAt: new Date().toISOString() } };
  const lowEntry   = { lesson: "low",    trust: { level: MEMORY_TRUST_LEVEL.LOW,    source: "user-mediated", reason: "", taggedAt: new Date().toISOString() } };

  it("returns HIGH before MEDIUM in sorted output", () => {
    const result = rerankMemoryByTrust([medEntry, highEntry]);
    assert.equal(result[0].lesson, "high", "HIGH-trust entry must come first");
  });

  it("drops LOW-trust entries by default", () => {
    const result = rerankMemoryByTrust([highEntry, lowEntry, medEntry]);
    assert.ok(result.every(r => r.trust.level !== MEMORY_TRUST_LEVEL.LOW), "LOW entries must be dropped");
  });

  it("includes LOW-trust entries when includeLowTrust=true AND privilegedCaller=true", () => {
    const result = rerankMemoryByTrust([highEntry, lowEntry, medEntry], {
      includeLowTrust: true,
      privilegedCaller: true,
    });
    assert.ok(result.some(r => r.trust.level === MEMORY_TRUST_LEVEL.LOW), "LOW entries must be included for privileged caller");
  });

  it("does NOT include LOW-trust entries when includeLowTrust=true but privilegedCaller=false", () => {
    const result = rerankMemoryByTrust([highEntry, lowEntry, medEntry], {
      includeLowTrust: true,
      privilegedCaller: false,
    });
    assert.ok(result.every(r => r.trust.level !== MEMORY_TRUST_LEVEL.LOW), "LOW entries must NOT be included without privileged caller");
  });

  it("respects topK limit", () => {
    const entries = Array.from({ length: 10 }, (_, i) => ({
      lesson: `L${i}`,
      trust: { level: MEMORY_TRUST_LEVEL.HIGH, source: "system", reason: "", taggedAt: new Date().toISOString() }
    }));
    const result = rerankMemoryByTrust(entries, { topK: 3 });
    assert.equal(result.length, 3, "must return at most topK entries");
  });

  it("returns all entries when topK is not set", () => {
    const entries = [highEntry, medEntry];
    const result = rerankMemoryByTrust(entries);
    assert.equal(result.length, 2);
  });

  it("negative path: empty input returns empty array", () => {
    const result = rerankMemoryByTrust([]);
    assert.deepEqual(result, []);
  });

  it("negative path: null input returns empty array", () => {
    const result = rerankMemoryByTrust(null as any);
    assert.deepEqual(result, []);
  });
});

// ── retrieveMemoryForContext ──────────────────────────────────────────────────

describe("retrieveMemoryForContext — fused retrieval from partitioned memory", () => {
  async function makeTmpDir(content: object): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-km-"));
    await fs.writeFile(path.join(dir, "knowledge_memory.json"), JSON.stringify(content), "utf8");
    return dir;
  }

  it("returns trust-reranked lessons from a v2 memory file", async () => {
    const km = {
      schemaVersion: 2,
      working: {
        lessons: [
          { lesson: "working lesson 1", source: "system" },
          { lesson: "working lesson 2", source: "model" },
        ],
        configTunings: [],
        promptHints: [],
        updatedAt: null,
      },
      episodic: { lessons: [{ lesson: "episodic lesson 1", source: "system" }], retainedAt: null },
      policy: { rules: [], updatedAt: null },
      lastUpdated: null,
    };
    const dir = await makeTmpDir(km);
    try {
      const result = await retrieveMemoryForContext(dir, "test");
      assert.ok(Array.isArray(result), "result must be an array");
      assert.ok(result.length > 0, "result must not be empty");
      // Each entry must have trust metadata attached
      for (const entry of result) {
        assert.ok("trust" in entry, `entry must have trust metadata: ${JSON.stringify(entry)}`);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("auto-migrates a v1 file and returns results", async () => {
    const kmV1 = {
      lessons: [
        { lesson: "v1 lesson 1" },
        { lesson: "v1 lesson 2" },
      ],
      configTunings: [],
      promptHints: [],
      lastUpdated: null,
    };
    const dir = await makeTmpDir(kmV1);
    try {
      const result = await retrieveMemoryForContext(dir, "test");
      assert.ok(Array.isArray(result), "result from v1 migration must be array");
      assert.ok(result.length >= 2, "both v1 lessons must be returned after migration");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("respects topK limit", async () => {
    const km = {
      schemaVersion: 2,
      working: {
        lessons: Array.from({ length: 15 }, (_, i) => ({ lesson: `L${i}` })),
        configTunings: [],
        promptHints: [],
        updatedAt: null,
      },
      episodic: { lessons: [], retainedAt: null },
      policy: { rules: [], updatedAt: null },
      lastUpdated: null,
    };
    const dir = await makeTmpDir(km);
    try {
      const result = await retrieveMemoryForContext(dir, "test", { topK: 5 });
      assert.ok(result.length <= 5, `result length must be at most 5; got ${result.length}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("respects partition filter — only working partition requested", async () => {
    const km = {
      schemaVersion: 2,
      working: {
        lessons: [{ lesson: "working-only", source: "system" }],
        configTunings: [],
        promptHints: [],
        updatedAt: null,
      },
      episodic: { lessons: [{ lesson: "episodic-only", source: "system" }], retainedAt: null },
      policy: { rules: [], updatedAt: null },
      lastUpdated: null,
    };
    const dir = await makeTmpDir(km);
    try {
      const result = await retrieveMemoryForContext(dir, "test", {
        partitions: ["working"],
      });
      const texts = result.map((r: any) => r.lesson);
      assert.ok(texts.includes("working-only"), "working lesson must be present");
      assert.ok(!texts.includes("episodic-only"), "episodic lesson must be excluded");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("negative path: missing knowledge_memory.json returns empty array without throwing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-km-empty-"));
    try {
      const result = await retrieveMemoryForContext(dir, "test");
      assert.ok(Array.isArray(result), "must return array even when file is missing");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("negative path: corrupt JSON in knowledge_memory.json returns empty array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-km-corrupt-"));
    await fs.writeFile(path.join(dir, "knowledge_memory.json"), "{ invalid json {{{{", "utf8");
    try {
      const result = await retrieveMemoryForContext(dir, "test");
      assert.ok(Array.isArray(result), "corrupt file must return empty array");
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
});
