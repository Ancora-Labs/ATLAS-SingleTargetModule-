import { describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  loadCorpus,
  appendCorpusEntry,
  replayCorpus,
  MAX_CONFIDENCE_DELTA,
  computeDispatchStrictness,
  DISPATCH_STRICTNESS,
  persistReplayRegressionState,
  loadReplayRegressionState,
} from "../../src/core/parser_replay_harness.js";

describe("parser_replay_harness (Packet 10)", () => {
  describe("loadCorpus", () => {
    it("returns empty array for missing file", async () => {
      const corpus = await loadCorpus({ paths: { stateDir: "/nonexistent/path" } });
      assert.ok(Array.isArray(corpus));
      assert.equal(corpus.length, 0);
    });
  });

  describe("appendCorpusEntry", () => {
    it("is a callable function", () => {
      assert.equal(typeof appendCorpusEntry, "function");
    });
  });

  describe("MAX_CONFIDENCE_DELTA", () => {
    it("is a negative number", () => {
      assert.ok(MAX_CONFIDENCE_DELTA < 0);
    });
  });

  describe("replayCorpus", () => {
    it("returns empty results for empty corpus", () => {
      const result = replayCorpus([], () => ({ confidence: 0.5, plans: [] }));
      assert.ok(Array.isArray(result.results));
      assert.equal(result.results.length, 0);
      assert.equal(result.regressionCount, 0);
      assert.equal(result.passed, true);
    });

    it("detects regression when confidence drops significantly", () => {
      const corpus = [
        { id: "t1", raw: "test input", baselineConfidence: 0.9, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.5, plans: [] }));
      assert.ok(result.regressionCount > 0);
      assert.equal(result.passed, false);
    });

    it("passes when confidence is within threshold", () => {
      const corpus = [
        { id: "t1", raw: "test input", baselineConfidence: 0.8, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.75, plans: [] }));
      assert.equal(result.regressionCount, 0);
      assert.equal(result.passed, true);
    });

    it("handles multiple corpus entries", () => {
      const corpus = [
        { id: "a", raw: "a", baselineConfidence: 0.9, expectedPlanCount: 1 },
        { id: "b", raw: "b", baselineConfidence: 0.7, expectedPlanCount: 1 },
        { id: "c", raw: "c", baselineConfidence: 0.5, expectedPlanCount: 0 },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.6,
        plans: [],
      }));
      assert.equal(result.results.length, 3);
    });

    it("detects regression when required key is missing from a plan", () => {
      const corpus = [
        {
          id: "t-req",
          raw: "input",
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
        },
      ];
      // parser returns a plan missing 'priority'
      const result = replayCorpus(corpus, () => ({
        confidence: 0.9,
        plans: [{ title: "do something" }],
      }));
      assert.equal(result.regressionCount, 1);
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("priority"));
    });

    it("passes when all required keys are present in every plan", () => {
      const corpus = [
        {
          id: "t-full",
          raw: "input",
          baselineConfidence: 0.8,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
        },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.8,
        plans: [{ title: "task", priority: 1 }],
      }));
      assert.equal(result.regressionCount, 0);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("detects missing keys across multiple plans", () => {
      const corpus = [
        {
          id: "t-multi",
          raw: "input",
          baselineConfidence: 0.7,
          expectedPlanCount: 2,
          requiredKeys: ["id"],
        },
      ];
      // second plan missing 'id'
      const result = replayCorpus(corpus, () => ({
        confidence: 0.7,
        plans: [{ id: 1, title: "a" }, { title: "b" }],
      }));
      assert.equal(result.regressionCount, 1);
      assert.ok(result.results[0].omittedKeys.includes("id"));
    });

    it("emits empty omittedKeys for corpus entries without requiredKeys", () => {
      const corpus = [
        { id: "t-no-req", raw: "input", baselineConfidence: 0.5, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.5, plans: [{ title: "x" }] }));
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("flags regression when required keys missing even if confidence is stable", () => {
      const corpus = [
        {
          id: "t-stable-conf",
          raw: "input",
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["scope"],
        },
      ];
      // confidence unchanged but key absent
      const result = replayCorpus(corpus, () => ({
        confidence: 0.9,
        plans: [{ title: "task" }],
      }));
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("scope"));
    });

    // ── Mode-specific regression tests ────────────────────────────────────────

    it("json-direct mode: flags regression when required key is missing", () => {
      const corpus = [
        {
          id: "jd-1",
          raw: '{"plans":[{"title":"t"}]}',
          baselineConfidence: 0.95,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "json-direct",
        },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.95,
        plans: [{ title: "t" }], // missing 'priority'
      }));
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("priority"));
      assert.equal(result.results[0].parseMode, "json-direct");
    });

    it("json-direct mode: passes when all required keys present", () => {
      const corpus = [
        {
          id: "jd-2",
          raw: '{"plans":[{"title":"t","priority":1}]}',
          baselineConfidence: 0.95,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "json-direct",
        },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.95,
        plans: [{ title: "t", priority: 1 }],
      }));
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("fallback mode: flags regression when parser returns empty plans but plans were expected", () => {
      const corpus = [
        {
          id: "fb-1",
          raw: "some planner output that failed to parse",
          baselineConfidence: 0.8,
          expectedPlanCount: 2,
          requiredKeys: ["title", "scope"],
          parseMode: "fallback",
        },
      ];
      // Fallback parser returns no plans (degraded)
      const result = replayCorpus(corpus, () => ({
        confidence: 0.8,
        plans: [],
      }));
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("title"));
      assert.ok(result.results[0].omittedKeys.includes("scope"));
      assert.equal(result.results[0].parseMode, "fallback");
    });

    it("fallback mode: no regression when no plans were expected and parser returns empty", () => {
      const corpus = [
        {
          id: "fb-2",
          raw: "empty input",
          baselineConfidence: 0.5,
          expectedPlanCount: 0,
          requiredKeys: ["title"],
          parseMode: "fallback",
        },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.5, plans: [] }));
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("batch-normalized mode: flags regression when any plan in batch is missing required key", () => {
      const corpus = [
        {
          id: "bn-1",
          raw: "batch output with 3 plans",
          baselineConfidence: 0.85,
          expectedPlanCount: 3,
          requiredKeys: ["id", "title"],
          parseMode: "batch-normalized",
        },
      ];
      // Third plan missing 'id' after normalization
      const result = replayCorpus(corpus, () => ({
        confidence: 0.85,
        plans: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
          { title: "c" }, // missing 'id'
        ],
      }));
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("id"));
      assert.equal(result.results[0].parseMode, "batch-normalized");
    });

    it("batch-normalized mode: passes when all plans in batch have required keys", () => {
      const corpus = [
        {
          id: "bn-2",
          raw: "batch output with 2 plans",
          baselineConfidence: 0.85,
          expectedPlanCount: 2,
          requiredKeys: ["id", "title"],
          parseMode: "batch-normalized",
        },
      ];
      const result = replayCorpus(corpus, () => ({
        confidence: 0.85,
        plans: [
          { id: 1, title: "a" },
          { id: 2, title: "b" },
        ],
      }));
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("batch-normalized mode: flags regression when batch returns empty plans with expected count", () => {
      const corpus = [
        {
          id: "bn-3",
          raw: "batch raw output",
          baselineConfidence: 0.7,
          expectedPlanCount: 3,
          requiredKeys: ["id"],
          parseMode: "batch-normalized",
        },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.7, plans: [] }));
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("id"));
    });

    it("result carries parseMode through to output", () => {
      const corpus = [
        {
          id: "pm-1",
          raw: "input",
          baselineConfidence: 0.8,
          expectedPlanCount: 1,
          parseMode: "json-direct",
        },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.8, plans: [{ title: "x" }] }));
      assert.equal(result.results[0].parseMode, "json-direct");
    });

    it("result parseMode is undefined for corpus entries without parseMode", () => {
      const corpus = [
        { id: "no-pm", raw: "input", baselineConfidence: 0.8, expectedPlanCount: 1 },
      ];
      const result = replayCorpus(corpus, () => ({ confidence: 0.8, plans: [{ title: "x" }] }));
      assert.equal(result.results[0].parseMode, undefined);
    });

    // ── Adversarial marker / fence pattern corpus entries ──────────────────────

    it("===DECISION===/===END=== marker: parser correctly extracts plans — no regression", () => {
      // Simulates a planner response that wraps JSON in BOX decision markers.
      const raw = `Some thinking here.\n===DECISION===\n{"plans":[{"title":"t","priority":1}]}\n===END===`;
      const corpus = [
        {
          id: "adv-decision-marker",
          raw,
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "json-direct" as const,
        },
      ];
      // Parser that handles ===DECISION=== markers
      const parserFn = (input: string) => {
        const match = input.match(/===DECISION===\s*([\s\S]*?)===END===/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            return { confidence: 0.9, plans: parsed.plans || [] };
          } catch { /* fall through */ }
        }
        return { confidence: 0, plans: [] };
      };
      const result = replayCorpus(corpus, parserFn);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("===DECISION===/===END=== marker: parser regression when key missing after marker extraction", () => {
      const raw = `Thinking.\n===DECISION===\n{"plans":[{"title":"t"}]}\n===END===`;
      const corpus = [
        {
          id: "adv-marker-missing-key",
          raw,
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "json-direct" as const,
        },
      ];
      const parserFn = (input: string) => {
        const match = input.match(/===DECISION===\s*([\s\S]*?)===END===/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            return { confidence: 0.9, plans: parsed.plans || [] };
          } catch { /* fall through */ }
        }
        return { confidence: 0, plans: [] };
      };
      const result = replayCorpus(corpus, parserFn);
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("priority"));
    });

    it("===KARAR===/===SON=== legacy marker: parser handles legacy Turkish format", () => {
      const raw = `Düşünce.\n===KARAR===\n{"plans":[{"title":"t","priority":2}]}\n===SON===`;
      const corpus = [
        {
          id: "adv-karar-marker",
          raw,
          baselineConfidence: 0.85,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "fallback" as const,
        },
      ];
      const parserFn = (input: string) => {
        const match = input.match(/===KARAR===\s*([\s\S]*?)===SON===/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            return { confidence: 0.85, plans: parsed.plans || [] };
          } catch { /* fall through */ }
        }
        return { confidence: 0, plans: [] };
      };
      const result = replayCorpus(corpus, parserFn);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("```json fence: parser extracts JSON from fenced code block — no regression", () => {
      const raw = `Here is the plan:\n\`\`\`json\n{"plans":[{"id":1,"title":"implement feature"}]}\n\`\`\`\nEnd.`;
      const corpus = [
        {
          id: "adv-json-fence",
          raw,
          baselineConfidence: 0.88,
          expectedPlanCount: 1,
          requiredKeys: ["id", "title"],
          parseMode: "json-direct" as const,
        },
      ];
      const parserFn = (input: string) => {
        const match = input.match(/```json\s*([\s\S]*?)```/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1].trim());
            return { confidence: 0.88, plans: parsed.plans || [] };
          } catch { /* fall through */ }
        }
        return { confidence: 0, plans: [] };
      };
      const result = replayCorpus(corpus, parserFn);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("adversarial partial marker (no ===END===): parser degrades to empty plans → regression", () => {
      // Unclosed marker — parser cannot extract JSON; expected plans were 1 → regression.
      const raw = `===DECISION===\n{"plans":[{"title":"t","priority":1}]}\n<!-- missing end marker -->`;
      const corpus = [
        {
          id: "adv-partial-marker",
          raw,
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["title", "priority"],
          parseMode: "fallback" as const,
        },
      ];
      const parserFn = (input: string) => {
        // Strict marker parser — requires both open and close
        const match = input.match(/===DECISION===\s*([\s\S]*?)===END===/);
        if (!match) return { confidence: 0.9, plans: [] }; // degraded: no close marker
        try {
          const parsed = JSON.parse(match[1].trim());
          return { confidence: 0.9, plans: parsed.plans || [] };
        } catch {
          return { confidence: 0.9, plans: [] };
        }
      };
      const result = replayCorpus(corpus, parserFn);
      // No plans returned but 1 expected — required keys all omitted → regression
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("title"));
      assert.ok(result.results[0].omittedKeys.includes("priority"));
    });

    it("adversarial nested fence (```json inside ===DECISION===): parser uses outer marker", () => {
      const inner = '```json\n{"plans":[{"title":"nested"}]}\n```';
      const raw = `===DECISION===\n${inner}\n===END===`;
      const corpus = [
        {
          id: "adv-nested-fence",
          raw,
          baselineConfidence: 0.8,
          expectedPlanCount: 1,
          requiredKeys: ["title"],
          parseMode: "json-direct" as const,
        },
      ];
      // Parser that correctly extracts from the outer marker, then optionally from inner fence
      const parserFn = (input: string) => {
        const markerMatch = input.match(/===DECISION===\s*([\s\S]*?)===END===/);
        const section = markerMatch ? markerMatch[1].trim() : input;
        // Try direct JSON first
        try { const p = JSON.parse(section); return { confidence: 0.8, plans: p.plans || [] }; } catch {}
        // Try inner fence
        const fenceMatch = section.match(/```json\s*([\s\S]*?)```/);
        if (fenceMatch) {
          try { const p = JSON.parse(fenceMatch[1].trim()); return { confidence: 0.8, plans: p.plans || [] }; } catch {}
        }
        return { confidence: 0.8, plans: [] };
      };
      const result = replayCorpus(corpus, parserFn);
      assert.equal(result.passed, true);
      assert.deepEqual(result.results[0].omittedKeys, []);
    });

    it("adversarial confidence-stable marker regression: confidence unchanged but parser returns wrong type", () => {
      // Parser returns non-array plans — should be treated as empty
      const raw = `===DECISION===\n{"plans":"not-an-array"}\n===END===`;
      const corpus = [
        {
          id: "adv-wrong-type",
          raw,
          baselineConfidence: 0.9,
          expectedPlanCount: 1,
          requiredKeys: ["title"],
          parseMode: "json-direct" as const,
        },
      ];
      const parserFn = (_input: string) => {
        // Returns non-array plans — harness normalizes to []
        return { confidence: 0.9, plans: "not-an-array" as any };
      };
      const result = replayCorpus(corpus, parserFn);
      // plans normalized to [] — expectedPlanCount=1 → required keys omitted
      assert.equal(result.passed, false);
      assert.ok(result.results[0].omittedKeys.includes("title"));
    });
  });
});

// ── computeDispatchStrictness — calibration tests ─────────────────────────────

describe("computeDispatchStrictness — strictness calibration", () => {
  it("NORMAL: zero regressions and parser healthy", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 0, totalCount: 10, passed: true, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
    assert.equal(result.regressionRate, 0);
    assert.equal(result.recoveryActive, false);
  });

  it("NORMAL: no corpus state and parser healthy", () => {
    const result = computeDispatchStrictness(null, null);
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
    assert.equal(result.regressionRate, 0);
  });

  it("ELEVATED: 1 out of 10 regressions (10% rate)", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 1, totalCount: 10, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.ok(result.reason.includes("1 regression"));
  });

  it("ELEVATED: recovery active with high parser confidence (≥0.7)", () => {
    const result = computeDispatchStrictness(
      null,
      { recoveryActive: true, parserConfidence: 0.75, recordedAt: new Date().toISOString() } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.equal(result.recoveryActive, true);
    assert.ok(result.reason.toLowerCase().includes("recovery"));
  });

  it("STRICT: 3 out of 10 regressions (30% rate)", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 3, totalCount: 10, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.ok(result.regressionRate > 0.2);
  });

  it("STRICT: recovery active with deep confidence degradation (<0.7)", () => {
    const result = computeDispatchStrictness(
      null,
      { recoveryActive: true, parserConfidence: 0.5, recordedAt: new Date().toISOString() } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.ok(result.reason.includes("deep confidence"));
  });

  it("STRICT: exactly 21% regression rate (just over 20% boundary)", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 21, totalCount: 100, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
  });

  it("BLOCKED: 6 out of 10 regressions (60% rate)", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 6, totalCount: 10, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
    assert.ok(result.reason.includes("50%"));
  });

  it("BLOCKED: exactly 51% regression rate (just over 50% boundary)", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 51, totalCount: 100, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.BLOCKED);
  });

  it("result always includes regressionCount, totalCount, regressionRate, recoveryActive", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 2, totalCount: 20, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.equal(typeof result.regressionCount, "number");
    assert.equal(typeof result.totalCount, "number");
    assert.equal(typeof result.regressionRate, "number");
    assert.equal(typeof result.recoveryActive, "boolean");
    assert.equal(typeof result.reason, "string");
  });

  it("result.strictness is one of the four DISPATCH_STRICTNESS values", () => {
    const validValues = new Set(Object.values(DISPATCH_STRICTNESS));
    for (const regressionCount of [0, 1, 3, 6]) {
      const result = computeDispatchStrictness(
        { regressionCount, totalCount: 10, passed: regressionCount === 0, computedAt: new Date().toISOString() },
        null,
      );
      assert.ok(validValues.has(result.strictness as any), `Unexpected strictness: ${result.strictness}`);
    }
  });

  it("ELEVATED takes precedence over NORMAL when recovery is active regardless of corpus", () => {
    // No corpus (regressionRate=0) but recovery is active → ELEVATED
    const result = computeDispatchStrictness(
      { regressionCount: 0, totalCount: 5, passed: true, computedAt: new Date().toISOString() },
      { recoveryActive: true, parserConfidence: 0.9, recordedAt: new Date().toISOString() } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
  });

  it("negative path: NORMAL is not returned when any regression exists", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 1, totalCount: 100, passed: false, computedAt: new Date().toISOString() },
      null,
    );
    assert.notEqual(result.strictness, DISPATCH_STRICTNESS.NORMAL);
  });

  // ── Component confidence penalty tests ────────────────────────────────────

  it("STRICT: recovery active with severe component degradation (maxComponentGap >= 0.4, confidence >= 0.7)", () => {
    const result = computeDispatchStrictness(
      null,
      {
        recoveryActive: true,
        parserConfidence: 0.75,
        componentGap: { plansShape: 0.45, healthField: 0.1, requestBudget: 0.0, dependencyGraph: 0.0 },
        penalties: [{ reason: "plansShape degraded", component: "plansShape", delta: -0.45 }],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.ok(result.reason.includes("severe component degradation"));
    assert.ok(result.reason.includes("maxComponentGap=0.45"));
  });

  it("STRICT: recovery active with exactly 0.4 maxComponentGap (boundary case)", () => {
    const result = computeDispatchStrictness(
      null,
      {
        recoveryActive: true,
        parserConfidence: 0.8,
        componentGap: { plansShape: 0.0, healthField: 0.4, requestBudget: 0.0, dependencyGraph: 0.0 },
        penalties: [],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
  });

  it("ELEVATED (not STRICT): recovery active with maxComponentGap < 0.4 and confidence >= 0.7", () => {
    const result = computeDispatchStrictness(
      null,
      {
        recoveryActive: true,
        parserConfidence: 0.82,
        componentGap: { plansShape: 0.18, healthField: 0.1, requestBudget: 0.05, dependencyGraph: 0.0 },
        penalties: [{ reason: "minor plansShape gap", component: "plansShape", delta: -0.18 }],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
  });

  it("ELEVATED reason includes penalty count when penalties present", () => {
    const result = computeDispatchStrictness(
      null,
      {
        recoveryActive: true,
        parserConfidence: 0.85,
        componentGap: { plansShape: 0.15, healthField: 0.0, requestBudget: 0.0, dependencyGraph: 0.0 },
        penalties: [
          { reason: "plansShape degraded", component: "plansShape", delta: -0.1 },
          { reason: "requestBudget degraded", component: "requestBudget", delta: -0.05 },
        ],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.ELEVATED);
    assert.ok(result.reason.includes("penalties=2"), `Expected 'penalties=2' in reason: "${result.reason}"`);
  });

  it("result exposes penaltyCount and maxComponentGap fields", () => {
    const result = computeDispatchStrictness(
      { regressionCount: 0, totalCount: 5, passed: true, computedAt: new Date().toISOString() },
      {
        recoveryActive: true,
        parserConfidence: 0.88,
        componentGap: { plansShape: 0.12, healthField: 0.0, requestBudget: 0.0, dependencyGraph: 0.05 },
        penalties: [{ reason: "plansShape minor gap", component: "plansShape", delta: -0.12 }],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(typeof result.penaltyCount, "number");
    assert.equal(typeof result.maxComponentGap, "number");
    assert.equal(result.penaltyCount, 1);
    assert.ok(Math.abs(result.maxComponentGap - 0.12) < 0.001);
  });

  it("penaltyCount=0 and maxComponentGap=0 when no baseline record provided", () => {
    const result = computeDispatchStrictness(null, null);
    assert.equal(result.penaltyCount, 0);
    assert.equal(result.maxComponentGap, 0);
  });

  it("negative path: component gap below threshold does not escalate NORMAL to STRICT", () => {
    // maxComponentGap=0.2 (< 0.4) with recoveryActive=false → NORMAL
    const result = computeDispatchStrictness(
      { regressionCount: 0, totalCount: 10, passed: true, computedAt: new Date().toISOString() },
      {
        recoveryActive: false,
        parserConfidence: 0.92,
        componentGap: { plansShape: 0.2, healthField: 0.1, requestBudget: 0.0, dependencyGraph: 0.0 },
        penalties: [],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.NORMAL);
  });

  it("dependencyGraph component gap >= 0.4 triggers STRICT", () => {
    const result = computeDispatchStrictness(
      null,
      {
        recoveryActive: true,
        parserConfidence: 0.75,
        componentGap: { plansShape: 0.0, healthField: 0.0, requestBudget: 0.0, dependencyGraph: 0.7 },
        penalties: [{ reason: "cycle in dependency graph", component: "dependencyGraph", delta: -0.7 }],
        recordedAt: new Date().toISOString(),
      } as any,
    );
    assert.equal(result.strictness, DISPATCH_STRICTNESS.STRICT);
    assert.ok(result.reason.includes("severe component degradation"));
    assert.equal(result.penaltyCount, 1);
    assert.ok(Math.abs(result.maxComponentGap - 0.7) < 0.001);
  });
});

// ── Replay regression state persistence ───────────────────────────────────────

describe("persistReplayRegressionState / loadReplayRegressionState", () => {
  it("persists and loads regression state", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prh-test-"));
    try {
      const config = { paths: { stateDir: tmpDir } };
      const replayResult = {
        regressionCount: 3,
        results: [{}, {}, {}, {}, {}],
        passed: false,
      };
      await persistReplayRegressionState(config, replayResult);
      const loaded = await loadReplayRegressionState(config);
      assert.ok(loaded !== null);
      assert.equal(loaded!.regressionCount, 3);
      assert.equal(loaded!.totalCount, 5);
      assert.equal(loaded!.passed, false);
      assert.ok(typeof loaded!.computedAt === "string");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("loadReplayRegressionState returns null when file does not exist", async () => {
    const result = await loadReplayRegressionState({ paths: { stateDir: "/nonexistent/path/xyz" } });
    assert.equal(result, null);
  });

  it("persisted state matches replayCorpus output shape", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "prh-state-"));
    try {
      const config = { paths: { stateDir: tmpDir } };
      const corpus = [
        { id: "a", raw: "x", baselineConfidence: 0.9, expectedPlanCount: 1 },
        { id: "b", raw: "y", baselineConfidence: 0.5, expectedPlanCount: 1 },
      ];
      const replayOutput = replayCorpus(corpus, () => ({ confidence: 0.9, plans: [{ title: "x" }] }));
      await persistReplayRegressionState(config, replayOutput);
      const loaded = await loadReplayRegressionState(config);
      assert.ok(loaded !== null);
      assert.equal(loaded!.regressionCount, replayOutput.regressionCount);
      assert.equal(loaded!.totalCount, replayOutput.results.length);
      assert.equal(loaded!.passed, replayOutput.passed);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
