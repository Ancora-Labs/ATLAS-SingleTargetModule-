import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  safeArray,
  tryExtractJson,
  validatePlan,
  validateDecision,
  validateOpusDecision,
} from "../../../src/providers/reviewer/utils.js";

describe("safeArray", () => {
  it("returns the array unchanged when given an array", () => {
    assert.deepEqual(safeArray([1, 2, 3]), [1, 2, 3]);
  });

  it("returns empty array for non-array inputs", () => {
    assert.deepEqual(safeArray(null), []);
    assert.deepEqual(safeArray(undefined), []);
    assert.deepEqual(safeArray("string"), []);
    assert.deepEqual(safeArray(42), []);
    assert.deepEqual(safeArray({}), []);
  });
});

describe("tryExtractJson", () => {
  it("parses valid JSON string", () => {
    assert.deepEqual(tryExtractJson('{"a":1}'), { a: 1 });
  });

  it("extracts JSON embedded in surrounding text", () => {
    const result = tryExtractJson('Some preamble {"approved":true,"reason":"ok"} trailing');
    assert.deepEqual(result, { approved: true, reason: "ok" });
  });

  it("returns null for text with no JSON object", () => {
    assert.equal(tryExtractJson("no json here"), null);
  });

  it("returns null for empty/null input", () => {
    assert.equal(tryExtractJson(null), null);
    assert.equal(tryExtractJson(""), null);
  });
});

describe("validatePlan", () => {
  const fallback = [{ id: 99, title: "fallback", priority: 3, kind: "general" }];

  it("returns parsed tasks from a valid payload", () => {
    const payload = {
      tasks: [
        { id: 1, title: "Fix bug", priority: 1, kind: "quality" },
        { id: 2, title: "Add tests", priority: 2, kind: "test" },
      ],
    };
    const result = validatePlan(payload, fallback);
    assert.equal(result.tasks.length, 2);
    assert.equal(result.tasks[0].title, "Fix bug");
  });

  it("falls back when tasks array is empty", () => {
    const result = validatePlan({ tasks: [] }, fallback);
    assert.deepEqual(result.tasks, fallback);
  });

  it("falls back when payload is null", () => {
    const result = validatePlan(null, fallback);
    assert.deepEqual(result.tasks, fallback);
  });

  it("filters out tasks with missing required fields", () => {
    const payload = {
      tasks: [
        { id: 1, title: "", priority: 1, kind: "quality" }, // empty title — filtered
        { id: 2, title: "Valid task", priority: 2, kind: "test" },
      ],
    };
    const result = validatePlan(payload, fallback);
    assert.equal(result.tasks.length, 1);
    assert.equal(result.tasks[0].title, "Valid task");
  });

  it("lowercases kind", () => {
    const payload = { tasks: [{ id: 1, title: "T", priority: 1, kind: "BACKEND" }] };
    const result = validatePlan(payload, fallback);
    assert.equal(result.tasks[0].kind, "backend");
  });
});

describe("validateDecision", () => {
  const fallback = { approved: false, reason: "fallback reason" };

  it("returns a valid decision when approved is boolean", () => {
    const result = validateDecision({ approved: true, reason: "LGTM" }, fallback);
    assert.equal(result.approved, true);
    assert.equal(result.reason, "LGTM");
  });

  it("returns fallback when approved is not boolean", () => {
    const r1 = validateDecision({ approved: "yes" }, fallback);
    assert.equal(r1.approved, false);
    assert.equal(r1.reason, "fallback reason");
    assert.equal(r1._source, "fallback");

    const r2 = validateDecision(null, fallback);
    assert.equal(r2._source, "fallback");

    const r3 = validateDecision({}, fallback);
    assert.equal(r3._source, "fallback");
  });

  it("returns fallback with explicit _fallbackReason for malformed payloads", () => {
    const result = validateDecision({ approved: 42 }, fallback);
    assert.equal(result._source, "fallback");
    assert.equal(result._fallbackReason, "approved field is not boolean");
  });

  it("does not set _source on valid provider decisions", () => {
    const result = validateDecision({ approved: true, reason: "ok" }, fallback);
    assert.equal(result._source, undefined);
  });

  it("uses fallback reason when payload reason is missing", () => {
    const result = validateDecision({ approved: false }, fallback);
    assert.equal(result.reason, fallback.reason);
  });
});

describe("validateOpusDecision", () => {
  const fallback = { allowOpus: false, reason: "default" };

  it("returns valid decision when allowOpus is boolean", () => {
    const result = validateOpusDecision({ allowOpus: true, reason: "go ahead" }, fallback);
    assert.equal(result.allowOpus, true);
    assert.equal(result.reason, "go ahead");
  });

  it("returns fallback when allowOpus is not boolean", () => {
    const r1 = validateOpusDecision({ allowOpus: "true" }, fallback);
    assert.equal(r1.allowOpus, fallback.allowOpus);
    assert.equal(r1._source, "fallback");
    assert.ok(r1._fallbackReason);
    const r2 = validateOpusDecision(null, fallback);
    assert.equal(r2.allowOpus, fallback.allowOpus);
    assert.equal(r2._source, "fallback");
  });

  it("falls back to 'no reason provided' when both reasons are missing", () => {
    const result = validateOpusDecision({ allowOpus: false }, { allowOpus: false });
    assert.equal(result.reason, "no reason provided");
  });
});
