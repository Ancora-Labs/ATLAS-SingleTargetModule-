import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileAcceptanceCriteria, enrichPlansWithAC } from "../../src/core/ac_compiler.js";

describe("ac_compiler", () => {
  describe("compileAcceptanceCriteria", () => {
    it("returns empty for null plan", () => {
      const result = compileAcceptanceCriteria(null);
      assert.deepEqual(result.criteria, []);
      assert.equal(result.wasEnriched, false);
    });

    it("keeps existing strong verification", () => {
      const plan = {
        verification: "npm test passes with all 2056 assertions; npm run lint clean; node -e 'import(\"./src/core/foo.js\")'",
      };
      const result = compileAcceptanceCriteria(plan);
      assert.equal(result.wasEnriched, true);
      assert.ok(result.criteria.length > 0);
    });

    it("enriches plan with missing verification", () => {
      const plan = { task: "Add new module", taskKind: "implementation" };
      const result = compileAcceptanceCriteria(plan);
      assert.equal(result.wasEnriched, true);
      assert.ok(result.criteria.length >= 2);
      assert.ok(result.verification.includes("npm test"));
    });

    it("uses task-kind-specific templates", () => {
      const plan = { task: "Fix bug in parser", taskKind: "bugfix" };
      const result = compileAcceptanceCriteria(plan);
      assert.equal(result.wasEnriched, true);
      assert.ok(result.criteria.some(c => /regression/i.test(c)));
    });

    it("adds keyword-specific criteria for new files", () => {
      const plan = { task: "Create new file src/core/bar.js", taskKind: "implementation" };
      const result = compileAcceptanceCriteria(plan);
      assert.ok(result.criteria.some(c => /path/i.test(c)));
    });

    it("defaults to implementation template for unknown kind", () => {
      const plan = { task: "Do something", taskKind: "unknown-kind" };
      const result = compileAcceptanceCriteria(plan);
      assert.equal(result.wasEnriched, true);
      assert.ok(result.criteria.some(c => /npm test/i.test(c)));
    });
  });

  describe("enrichPlansWithAC", () => {
    it("returns empty for non-array", () => {
      const result = enrichPlansWithAC(null);
      assert.deepEqual(result.plans, []);
      assert.equal(result.enrichedCount, 0);
    });

    it("enriches weak plans and leaves strong ones", () => {
      const plans = [
        { task: "Add module", taskKind: "implementation" },
        { task: "Update code", verification: "npm test passes with all suites; npm run lint clean; node --test runs all" },
      ];
      const result = enrichPlansWithAC(plans);
      assert.equal(result.plans.length, 2);
      assert.ok(result.enrichedCount >= 1);
    });

    it("marks enriched plans with _acCompiled flag", () => {
      const plans = [{ task: "Add feature", taskKind: "implementation" }];
      const result = enrichPlansWithAC(plans);
      assert.equal(result.plans[0]._acCompiled, true);
    });

    it("populates acceptance_criteria when enriching a weak plan", () => {
      const plans = [{ task: "Add trust-boundary provider integration tests for untrusted linter payloads", target_files: ["tests/core/trust_boundary_provider_integration.test.ts"] }];
      const result = enrichPlansWithAC(plans);
      assert.ok(Array.isArray(result.plans[0].acceptance_criteria));
      assert.ok(result.plans[0].acceptance_criteria.length >= 2);
      assert.ok(result.plans[0].verification.includes("node --test tests/core/trust_boundary_provider_integration.test.ts"));
    });
  });
});
