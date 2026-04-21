import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  scoreTopicApplicability,
  type TopicApplicabilityVerdict,
} from "../../src/core/research_synthesizer.js";
import {
  detectAndCompleteTopics,
  updateTopicKnowledge,
} from "../../src/core/prometheus.js";

// ── scoreTopicApplicability unit tests ────────────────────────────────────────

describe("scoreTopicApplicability — not_applicable detection", () => {
  it("marks Temporal.io topics as not_applicable", () => {
    const topic = {
      topic: "Durable side-effect safety patterns and workflow lifecycle signals",
      prometheusReadySummary: "Relevance: LOW - BOX does not run Temporal workflows.",
      sources: [
        {
          url: "https://raw.githubusercontent.com/temporalio/sdk-typescript/main/packages/common/src/activity-options.ts",
          title: "Temporal TypeScript SDK activity options",
          prometheusReadySummary: "Relevance: LOW - BOX does not run Temporal workflows.",
          scoutFindings: "ActivityCancellationType = { ABANDON, TRY_CANCEL, WAIT_CANCELLATION_COMPLETED }",
        },
      ],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "not_applicable");
    assert.equal(result.score, 0.0);
    assert.ok(result.detectedPlatform, "must carry detectedPlatform");
    assert.ok(result.evidence.length > 0, "must provide evidence");
    assert.ok(
      result.evidence.some(e => /Temporal/i.test(e)),
      "evidence must mention Temporal"
    );
  });

  it("marks Kubernetes topics as not_applicable", () => {
    const topic = {
      topic: "Kubernetes operator patterns for stateful workloads",
      prometheusReadySummary: "Deploy with kubectl and Helm chart.",
      sources: [],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "not_applicable");
    assert.equal(result.detectedPlatform, "Kubernetes");
  });

  it("marks Go runtime topics as not_applicable", () => {
    const topic = {
      topic: "Goroutine scheduling and Go channel semantics",
      prometheusReadySummary: "Use goroutines for concurrency in Go runtime.",
      sources: [],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "not_applicable");
  });
});

describe("scoreTopicApplicability — applicable detection", () => {
  it("marks Node.js/TypeScript topics as applicable", () => {
    const topic = {
      topic: "Copilot cloud-agent governance and custom-agent contracts",
      prometheusReadySummary: "Enforce explicit YAML frontmatter for .agent.md files used by Copilot CLI.",
      sources: [
        {
          url: "https://docs.github.com/en/copilot/reference/custom-agents-configuration",
          title: "Custom agents configuration (GitHub Copilot cloud agent)",
          prometheusReadySummary: "Node.js TypeScript integration for src/core/ files.",
          scoutFindings: "description field required in .agent.md frontmatter.",
        },
      ],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "applicable");
    assert.equal(result.score, 1.0);
  });

  it("marks agent memory topics as applicable when they reference BOX files", () => {
    const topic = {
      topic: "Long-horizon memory architectures for self-improving agents",
      prometheusReadySummary: "Implement tri-part memory in src/core/prometheus.ts.",
      sources: [],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "applicable");
  });
});

describe("scoreTopicApplicability — conditionally_applicable detection", () => {
  it("marks synthesizer-flagged-LOW topics as conditionally_applicable when no hard platform match", () => {
    const topic = {
      topic: "Generic distributed system pattern",
      prometheusReadySummary: "Relevance: LOW - pattern applies but no direct BOX integration path.",
      sources: [],
    };
    const result = scoreTopicApplicability(topic);
    assert.equal(result.verdict, "conditionally_applicable");
    assert.equal(result.score, 0.4);
    assert.ok(result.evidence.some(e => /Relevance.*LOW/i.test(e) || /LOW/i.test(e)));
  });

  it("marks mixed Temporal+BOX-indicator topics as conditionally_applicable", () => {
    const topic = {
      topic: "Idempotency patterns",
      prometheusReadySummary: "Relevance: LOW - BOX uses Node.js not Temporal. But idempotency key for npm runs applies.",
      sources: [
        {
          url: "https://temporal.io/blog/idempotency-and-durable-execution",
          title: "Idempotency in Temporal",
          prometheusReadySummary: "npm run commands benefit from idempotent execution.",
          scoutFindings: "pattern applicable to Node.js scripts via npm run",
        },
      ],
    };
    const result = scoreTopicApplicability(topic);
    // Has Temporal URL but also has Node.js/npm BOX indicators → conditionally_applicable
    assert.equal(result.verdict, "conditionally_applicable");
    assert.equal(result.score, 0.4);
  });
});

describe("scoreTopicApplicability — shape contract", () => {
  it("always returns verdict, score, and evidence array", () => {
    const topic = { topic: "some topic", prometheusReadySummary: "", sources: [] };
    const result = scoreTopicApplicability(topic);
    assert.ok(["applicable", "not_applicable", "conditionally_applicable"].includes(result.verdict));
    assert.equal(typeof result.score, "number");
    assert.ok(Array.isArray(result.evidence));
    assert.ok(result.evidence.length > 0, "evidence must always be non-empty");
  });

  it("negative path: empty topic object returns applicable (no patterns to trigger a block)", () => {
    const result = scoreTopicApplicability({});
    assert.equal(result.verdict, "applicable");
  });
});

describe("detectAndCompleteTopics — closure evidence gate", () => {
  function buildTopicMemory(topic: string) {
    return updateTopicKnowledge(
      { topics: {} },
      [topic],
      [],
      { topics: [{ topic, summary: "Topic evidence fragment for deterministic testing." }] },
    );
  }

  it("keeps a topic active when a plan only cites synthesis_sources without closure evidence", () => {
    const topic = "Closure evidence for research-backed planning";
    const memory = buildTopicMemory(topic);

    const result = detectAndCompleteTopics(
      memory,
      [topic],
      [
        {
          task: "Wire topic-backed plan",
          synthesis_sources: [topic],
          implementationStatus: "not_implemented",
          implementationEvidence: [],
        },
      ],
      {},
    );

    const entry = result.memory.topics[Object.keys(result.memory.topics)[0]];
    assert.equal(entry.status, "active");
    assert.deepEqual(result.completedThisRun, []);
    assert.deepEqual(result.archivedThisRun, []);
  });

  it("marks a topic completed when a linked plan carries verified execution evidence", () => {
    const topic = "Verified execution closes the linked research topic";
    const memory = buildTopicMemory(topic);

    const result = detectAndCompleteTopics(
      memory,
      [topic],
      [
        {
          task: "Ship the research-backed fix",
          synthesis_sources: [topic],
          implementationStatus: "implemented_correctly",
          implementationEvidence: ["src/core/prometheus.ts"],
        },
      ],
      {},
    );

    const entry = result.memory.topics[Object.keys(result.memory.topics)[0]];
    assert.equal(entry.status, "completed");
    assert.equal(result.completedThisRun.length, 1);
    assert.match(entry.completedSummary || "", /verified execution or resolved-state contract/i);
  });

  it("negative path: does not archive low-density quarantined topics without an explicit resolved-state contract", () => {
    const topic = "Low-density topic should remain active until resolved";
    const memory = buildTopicMemory(topic);

    const result = detectAndCompleteTopics(
      memory,
      [topic],
      [],
      {},
      [topic],
    );

    const entry = result.memory.topics[Object.keys(result.memory.topics)[0]];
    assert.equal(entry.status, "active");
    assert.deepEqual(result.archivedThisRun, []);
  });
});
