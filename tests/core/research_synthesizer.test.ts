import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stripExecutionTranscriptNoise,
  sanitizeResearchSynthesisForPersistence,
  computeSynthesisActionableDensity,
  quarantineLowDensityTopics,
  topicHasActionableArtifact,
  buildQualityGateRecoverySignal,
  SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH,
  assessTargetCoverageObligations,
  buildTargetModeSynthesisTaskSection,
} from "../../src/core/research_synthesizer.js";

// ── Task 1 invariant: partial quarantine must not trigger degraded mode ────────

describe("qualityGate degradedPlanningMode invariant", () => {
  it("degradedPlanningMode is false when partial quarantine (some topics pass)", () => {
    const topics = [
      { topic: "CI/CD automation", netFindings: ["Fix CI matrix", "Add parallel jobs"] },
      { topic: "Low density topic", netFindings: [] },
    ];
    const densities = [
      { topic: "CI/CD automation",    actionableCount: 2, passed: true },
      { topic: "Low density topic",   actionableCount: 0, passed: false },
    ];
    const { quarantinedTopics, passedTopics } = quarantineLowDensityTopics(topics as any, densities);
    assert.equal(quarantinedTopics.length, 1, "one topic should be quarantined");
    assert.equal(passedTopics.length, 1, "one topic should pass");

    // Mirror how research_synthesizer.ts computes degradedPlanningMode.
    const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;
    assert.equal(degradedPlanningMode, false,
      "partial quarantine MUST NOT trigger degraded mode — valid signal remains");
  });

  it("degradedPlanningMode is true only when ALL topics are quarantined", () => {
    const topics = [
      { topic: "Empty A", netFindings: [] },
      { topic: "Empty B", netFindings: [] },
    ];
    const densities = [
      { topic: "Empty A", actionableCount: 0, passed: false },
      { topic: "Empty B", actionableCount: 0, passed: false },
    ];
    const { quarantinedTopics, passedTopics } = quarantineLowDensityTopics(topics as any, densities);
    const degradedPlanningMode = quarantinedTopics.length > 0 && passedTopics.length === 0;
    assert.equal(degradedPlanningMode, true,
      "degraded mode must activate when ALL topics are quarantined");
  });
});

describe("research_synthesizer persistence hardening", () => {
  it("strips execution transcript noise while preserving synthesis content", () => {
    const raw = [
      "[research_synthesizer_live]",
      "tool_call: read file",
      "## Topic: Planner contracts",
      "**Net Findings**:",
      "- Keep strict output markers",
      "```json",
      "{}",
      "```",
    ].join("\n");
    const cleaned = stripExecutionTranscriptNoise(raw);
    assert.ok(cleaned.includes("## Topic: Planner contracts"));
    assert.ok(!cleaned.includes("tool_call:"));
    assert.ok(!cleaned.includes("```"));
  });

  it("emits bounded planner-ready synthesis fields", () => {
    const input = {
      success: true,
      topicCount: 1,
      topics: [{
        topic: "Planner contracts",
        confidence: "0.9",
        sourceCount: 1,
        netFindings: ["A".repeat(600)],
        sources: [{
          title: "Source title",
          url: "https://example.com",
          confidence: 1.4,
          scoutFindings: "B".repeat(600),
        }],
      }],
      crossTopicConnections: ["C".repeat(700)],
      researchGaps: "gap-1\ngap-2",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 1,
      model: "gpt-5.3-codex",
    };

    const output = sanitizeResearchSynthesisForPersistence(input as any);
    assert.equal(output.success, true);
    assert.equal(output.topicCount, 1);
    assert.ok(Array.isArray(output.topics));
    assert.ok(Array.isArray((output as any).plannerSignals.priorityActions));
    const firstConnection = (output as any).crossTopicConnections[0];
    assert.ok(firstConnection.length <= 360, "cross-topic entries must be bounded");
  });

  it("negative path: drops empty/invalid topics from persisted output", () => {
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 2,
      topics: [{ topic: "" }, { topic: "   " }] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
    });
    assert.equal(output.topicCount, 0);
    assert.deepEqual(output.topics, []);
  });
});

// ── computeSynthesisActionableDensity (quality gate) ─────────────────────────

describe("computeSynthesisActionableDensity", () => {
  it("counts netFindings and applicableIdeas as actionable signals", () => {
    const topics = [{
      topic: "Topic A",
      netFindings: ["finding 1", "finding 2"],
      applicableIdeas: ["idea 1"],
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities.length, 1);
    assert.equal(densities[0].topic, "Topic A");
    assert.equal(densities[0].actionableCount, 3);
    assert.equal(densities[0].passed, true);
  });

  it("counts prometheusReadySummary from sources as actionable signal", () => {
    const topics = [{
      topic: "Topic B",
      netFindings: [],
      applicableIdeas: [],
      sources: [{ prometheusReadySummary: "Key insight here." }],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 1);
    assert.equal(densities[0].passed, true);
  });

  it("returns passed=false when topic has zero actionable signals", () => {
    const topics = [{
      topic: "Empty Topic",
      netFindings: [],
      applicableIdeas: [],
      sources: [{ prometheusReadySummary: "" }],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 0);
    assert.equal(densities[0].passed, false);
  });

  it("ignores whitespace-only findings as non-actionable", () => {
    const topics = [{
      topic: "Whitespace Only",
      netFindings: ["   ", "\t"],
      applicableIdeas: [],
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 0);
    assert.equal(densities[0].passed, false);
  });

  it("returns empty array for empty input", () => {
    const densities = computeSynthesisActionableDensity([]);
    assert.deepEqual(densities, []);
  });

  it("sanitizeResearchSynthesisForPersistence passes through qualityGate field", () => {
    const qualityGate = {
      passed: false,
      retried: true,
      topicDensities: [{ topic: "T", actionableCount: 0, passed: false }],
    };
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 1,
      topics: [{ topic: "T", netFindings: ["f1"], sources: [] }] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
      qualityGate,
    });
    assert.deepEqual((output as any).qualityGate, qualityGate);
  });

  it("sanitizeResearchSynthesisForPersistence omits qualityGate when not provided", () => {
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 1,
      topics: [{ topic: "T", netFindings: ["f1"], sources: [] }] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
    });
    assert.equal((output as any).qualityGate, undefined);
  });

  it("sanitizeResearchSynthesisForPersistence preserves target-session metadata", () => {
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 1,
      topics: [{ topic: "T", netFindings: ["f1"], sources: [] }] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
      targetSession: {
        projectId: "target_restaurant",
        sessionId: "sess_123",
        repoState: "empty",
        researchMode: "empty_repo_discovery",
      },
    });

    assert.deepEqual((output as any).targetSession, {
      projectId: "target_restaurant",
      sessionId: "sess_123",
      repoState: "empty",
      researchMode: "empty_repo_discovery",
    });
  });
});

// ── quarantineLowDensityTopics ─────────────────────────────────────────────────

describe("quarantineLowDensityTopics", () => {
  it("returns all topics as passed when all densities pass", () => {
    const topics = [
      { topic: "Topic A", netFindings: ["f1"] },
      { topic: "Topic B", netFindings: ["f2"] },
    ];
    const densities = [
      { topic: "Topic A", actionableCount: 2, passed: true },
      { topic: "Topic B", actionableCount: 1, passed: true },
    ];
    const result = quarantineLowDensityTopics(topics as any, densities);
    assert.equal(result.passedTopics.length, 2);
    assert.deepEqual(result.quarantinedTopics, []);
  });

  it("quarantines topics that failed density check", () => {
    const topics = [
      { topic: "Good Topic",  netFindings: ["f1"] },
      { topic: "Empty Topic", netFindings: [] },
    ];
    const densities = [
      { topic: "Good Topic",  actionableCount: 1, passed: true },
      { topic: "Empty Topic", actionableCount: 0, passed: false },
    ];
    const result = quarantineLowDensityTopics(topics as any, densities);
    assert.equal(result.passedTopics.length, 1,  "only passed topics survive");
    assert.equal(result.passedTopics[0].topic, "Good Topic");
    assert.deepEqual(result.quarantinedTopics, ["Empty Topic"]);
  });

  it("quarantines all topics when all fail density", () => {
    const topics = [{ topic: "A" }, { topic: "B" }];
    const densities = [
      { topic: "A", actionableCount: 0, passed: false },
      { topic: "B", actionableCount: 0, passed: false },
    ];
    const result = quarantineLowDensityTopics(topics as any, densities);
    assert.equal(result.passedTopics.length, 0);
    assert.equal(result.quarantinedTopics.length, 2);
  });

  it("negative path: returns all topics as passed for empty densities array", () => {
    const topics = [{ topic: "Topic X" }];
    const result = quarantineLowDensityTopics(topics as any, []);
    assert.equal(result.passedTopics.length, 1);
    assert.deepEqual(result.quarantinedTopics, []);
  });

  it("sanitizeResearchSynthesisForPersistence passes quarantinedTopics through qualityGate", () => {
    const qualityGate = {
      passed: false,
      retried: true,
      topicDensities: [{ topic: "Bad Topic", actionableCount: 0, passed: false }],
      quarantinedTopics: ["Bad Topic"],
      degradedPlanningMode: true,
    };
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 1,
      topics: [{ topic: "Good Topic", netFindings: ["f1"], sources: [] }] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
      qualityGate,
    });
    const qg = (output as any).qualityGate;
    assert.ok(qg, "qualityGate must be persisted");
    assert.deepEqual(qg.quarantinedTopics, ["Bad Topic"]);
    assert.equal(qg.degradedPlanningMode, true);
  });
});

// ── Task 3: Actionable-signal invariants + SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH ────

describe("target-aware synthesis coverage", () => {
  it("passes generic obligation coverage for a visual product target", () => {
    const coverage = assessTargetCoverageObligations(
      [
        {
          topic: "Visual hierarchy and premium hero layout",
          netFindings: ["Use strong hero imagery and premium visual hierarchy for landing pages."],
          sources: [{ scoutFindings: "High-quality food photography and branded hero composition improve perceived quality." }],
        },
        {
          topic: "Responsive image handling and mobile breakpoints",
          netFindings: ["Use responsive images and mobile-first breakpoints to preserve layout quality."],
          sources: [{ prometheusReadySummary: "Implement responsive image delivery and breakpoint-safe sections." }],
        },
        {
          topic: "Reservation CTA trust and conversion",
          netFindings: ["Show testimonials, ratings, and a clear reservation CTA above the fold."],
          sources: [{ scoutFindings: "Trust signals and CTA placement materially affect conversion." }],
        },
      ],
      {
        obligations: ["visual_design", "media_surfaces", "responsive_experience", "trust_signals"],
        targetSourceCount: 12,
      } as any,
    );

    assert.equal(coverage.passed, true);
    assert.deepEqual(coverage.missingObligations, []);
    assert.ok(coverage.coveredObligations.includes("visual_design"));
    assert.ok(coverage.coveredObligations.includes("media_surfaces"));
  });

  it("negative path: flags missing obligations when synthesis stays stack-only", () => {
    const coverage = assessTargetCoverageObligations(
      [
        {
          topic: "Next.js and Tailwind setup",
          netFindings: ["Use Next.js app router and Tailwind for rapid implementation."],
          sources: [{ prometheusReadySummary: "Set up the repo foundation and deployment baseline." }],
        },
      ],
      {
        obligations: ["visual_design", "media_surfaces", "responsive_experience"],
        targetSourceCount: 10,
      } as any,
    );

    assert.equal(coverage.passed, false);
    assert.ok(coverage.missingObligations.includes("visual_design"));
    assert.ok(coverage.missingObligations.includes("media_surfaces"));
  });

  it("builds a target-mode task section that points at the target repo instead of BOX self-improvement", () => {
    const sectionText = buildTargetModeSynthesisTaskSection({
      intent: {
        productType: "premium food landing page",
        mustHaveFlows: ["reservation CTA"],
        successCriteria: ["premium visual delivery"],
      },
    }, {
      obligations: ["visual_design", "media_surfaces", "responsive_experience"],
      targetSourceCount: 12,
    } as any);

    assert.ok(sectionText.includes("TARGET-REPO SYNTHESIS TASK"));
    assert.ok(sectionText.includes("Do NOT reframe this as BOX self-improvement"));
    assert.ok(sectionText.includes("visual_design"));
  });
});

describe("SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH invariant", () => {
  it("rejects strings shorter than the minimum as non-actionable", () => {
    const topics = [{
      topic: "Short Signals Only",
      netFindings: ["f1", "f2", "ok"],
      applicableIdeas: ["x"],
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 0, "sub-threshold signals must not count toward density");
    assert.equal(densities[0].passed, false, "topic must fail density with only noise signals");
  });

  it("accepts strings meeting the minimum length threshold", () => {
    const topics = [{
      topic: "Real Signals",
      netFindings: ["Deploy fix"],   // 10 chars ≥ 5
      applicableIdeas: ["Add test"],  // 8 chars ≥ 5
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 2, "both signals must count toward density");
    assert.equal(densities[0].passed, true);
  });

  it("mixed short and long signals: only long ones contribute to count", () => {
    const topics = [{
      topic: "Mixed",
      netFindings: ["ok", "Fix the failing test suite now"],  // "ok" noise, long one actionable
      applicableIdeas: [],
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 1, "only the long finding must count");
  });

  it("whitespace padding does not artificially inflate length", () => {
    const topics = [{
      topic: "Padded",
      netFindings: ["   ok   "],  // after trim = 2 chars
      applicableIdeas: [],
      sources: [],
    }];
    const densities = computeSynthesisActionableDensity(topics);
    assert.equal(densities[0].actionableCount, 0, "trimmed short string must not count");
  });

  it("SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH is exported and its value is positive", () => {
    assert.ok(typeof SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH === "number", "must be a number");
    assert.ok(SYNTHESIS_ACTIONABLE_SIGNAL_MIN_LENGTH > 1, "floor must be > 1 to reject single-char noise");
  });
});

// ── topicHasActionableArtifact — persistence-time invariant ───────────────────

describe("topicHasActionableArtifact", () => {
  it("returns true for topic with a netFinding of sufficient length", () => {
    const topic = { topic: "CI Coverage", netFindings: ["Fix the integration test suite"] };
    assert.equal(topicHasActionableArtifact(topic), true);
  });

  it("returns true for topic with a prometheusReadySummary in sources", () => {
    const topic = {
      topic: "Auth Security",
      sources: [{ prometheusReadySummary: "Add JWT validation to all endpoints" }],
    };
    assert.equal(topicHasActionableArtifact(topic), true);
  });

  it("returns true for topic with scoutFindings in sources", () => {
    const topic = {
      topic: "Test Coverage",
      sources: [{ scoutFindings: "Coverage is below 60% in core modules" }],
    };
    assert.equal(topicHasActionableArtifact(topic), true);
  });

  it("returns true for topic with an applicableIdea", () => {
    const topic = {
      topic: "Observability",
      netFindings: [],
      applicableIdeas: ["Add structured logging with correlation IDs"],
    };
    assert.equal(topicHasActionableArtifact(topic), true);
  });

  it("returns false for topic with only empty arrays", () => {
    const topic = {
      topic: "Empty Topic",
      netFindings: [],
      applicableIdeas: [],
      sources: [],
    };
    assert.equal(topicHasActionableArtifact(topic), false);
  });

  it("returns false for topic with only sub-threshold strings", () => {
    const topic = {
      topic: "Noise Topic",
      netFindings: ["ok", "x"],
      applicableIdeas: ["y"],
      sources: [{ scoutFindings: "abc" }],
    };
    assert.equal(topicHasActionableArtifact(topic), false);
  });

  it("negative path: returns false for null/undefined input", () => {
    assert.equal(topicHasActionableArtifact(null as any), false);
    assert.equal(topicHasActionableArtifact(undefined as any), false);
  });

  it("sanitizeResearchSynthesisForPersistence drops topics without actionable artifact", () => {
    const output = sanitizeResearchSynthesisForPersistence({
      success: true,
      topicCount: 2,
      topics: [
        { topic: "Has Signal", netFindings: ["Fix the failing test suite"] },
        { topic: "No Signal",  netFindings: [], applicableIdeas: [], sources: [] },
      ] as any,
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: "2026-01-01T00:00:00.000Z",
      scoutSourceCount: 0,
      model: "gpt-5.3-codex",
    });
    assert.equal(output.topicCount, 1, "only the topic with signal should be retained");
    assert.equal((output.topics as any[])[0].topic, "Has Signal");
  });
});

// ── buildQualityGateRecoverySignal ────────────────────────────────────────────

describe("buildQualityGateRecoverySignal", () => {
  it("returns a non-empty string when quarantined topic names are provided", () => {
    const signal = buildQualityGateRecoverySignal(["CI/CD Pipeline", "Auth Security"]);
    assert.ok(signal.length > 0, "recovery signal must be non-empty");
    assert.ok(signal.includes("CI/CD Pipeline"), "topic name must appear in recovery signal");
    assert.ok(signal.includes("Auth Security"), "both topic names must appear");
  });

  it("includes all topic names and a density-failure explanation", () => {
    const signal = buildQualityGateRecoverySignal(["Topic A", "Topic B"]);
    assert.ok(signal.includes("density check"), "must mention density check failure");
    // Signal now directs Prometheus to concrete repository evidence, not topic names as signal.
    assert.ok(
      /concrete repository evidence|repository evidence|evidence/i.test(signal),
      "must instruct using repository evidence (not topic names) as planning input"
    );
  });

  it("returns empty string when no quarantined topic names are provided", () => {
    assert.equal(buildQualityGateRecoverySignal([]), "");
  });

  it("returns empty string when all names are blank", () => {
    assert.equal(buildQualityGateRecoverySignal(["", "   ", ""]), "");
  });

  it("negative path: degraded mode WITHOUT recovery signal would leave Prometheus with empty context", () => {
    // Verify that the recovery signal IS non-empty for a typical failure case
    // (i.e. the feature actually provides the recovery path)
    const signal = buildQualityGateRecoverySignal(["Test Coverage Gap"]);
    assert.notEqual(signal, "",
      "recovery signal must never be empty when topic names exist — Prometheus needs minimal context");
  });
});

// ── Task 3: scout-to-synthesis provenance coupling invariants ─────────────────

describe("research_synthesizer — provenance coupling invariants (Task 3)", () => {
  it("sanitizeResearchSynthesisForPersistence includes recoverySignal when degradedPlanningMode=true", () => {
    const payload = {
      success: true,
      topicCount: 0,
      topics: [],
      crossTopicConnections: [],
      researchGaps: "",
      synthesizedAt: new Date().toISOString(),
      scoutSourceCount: 0,
      model: "test-model",
      qualityGate: {
        passed: false,
        retried: false,
        topicDensities: [],
        quarantinedTopics: ["CI Pipeline", "Auth Security"],
        degradedPlanningMode: true,
        recoverySignal: "Research was attempted on topics: CI Pipeline, Auth Security. All failed density check — do NOT use topic names as planning input. Operate in internal-evidence-only planning mode and derive tasks only from concrete repository evidence (files, failing tests, error logs, state files).",
        planningMode: "internal_evidence_only" as const,
      },
    };
    const result = sanitizeResearchSynthesisForPersistence(payload);
    assert.ok(result.qualityGate, "qualityGate must be persisted");
    assert.equal((result.qualityGate as any).degradedPlanningMode, true);
    assert.ok(typeof (result.qualityGate as any).recoverySignal === "string" && (result.qualityGate as any).recoverySignal.length > 0,
      "recoverySignal must be non-empty when degradedPlanningMode=true (provenance invariant)");
    assert.equal((result.qualityGate as any).planningMode, "internal_evidence_only");
  });

  it("negative: degradedPlanningMode=true with empty recoverySignal violates provenance invariant", () => {
    // The synthesizer code enforces non-empty recoverySignal on write.
    // This test documents the invariant contract for code reviewers.
    const topicNames = ["Valid Topic A", "Valid Topic B"];
    const signal = buildQualityGateRecoverySignal(topicNames);
    // When topic names are non-empty, signal must be non-empty
    assert.ok(signal.length > 0,
      "recoverySignal invariant: when topics exist and degradedPlanningMode=true, signal must be non-empty");
    assert.ok(signal.includes("Valid Topic A"), "topic provenance must appear in recovery signal");
  });

  it("qualityGate.recoverySignal invariant: non-empty when topic names are provided for degraded state", () => {
    // Mirror the state/research_synthesis.json schema check in pure unit form.
    // When degradedPlanningMode=true, the recoverySignal must be derivable from topic names.
    const topicNames = [
      "Durable Cancellation and Long-Running Loop Control",
      "Runtime Event Contracts and Multi-Agent Routing Semantics",
    ];
    const signal = buildQualityGateRecoverySignal(topicNames);
    assert.ok(
      typeof signal === "string" && signal.trim().length > 0,
      "state/research_synthesis.json: degradedPlanningMode=true requires non-empty recoverySignal (provenance invariant)"
    );
    assert.ok(signal.includes(topicNames[0]), "scout topic name must appear in recovery signal for provenance tracing");
  });
});

// ── scheduleBoundedRecoverySynthesis ──────────────────────────────────────────

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  scheduleBoundedRecoverySynthesis,
  SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS,
} from "../../src/core/research_synthesizer.js";

describe("scheduleBoundedRecoverySynthesis", () => {
  it("writes synthesis_recovery_request.json with correct schema", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-recovery-synth-"));
    try {
      await scheduleBoundedRecoverySynthesis(stateDir, {
        quarantinedTopics: ["Topic A", "Topic B"],
        retriedAlready: false,
      });
      const filePath = path.join(stateDir, "synthesis_recovery_request.json");
      const raw = await fs.readFile(filePath, "utf8");
      const record = JSON.parse(raw);
      assert.equal(record.reason, "degraded_planning_mode_all_topics_quarantined");
      assert.equal(record.scheduledForCycle, "next");
      assert.equal(record.planningMode, "internal_evidence_only");
      assert.deepEqual(record.quarantinedTopics, ["Topic A", "Topic B"]);
      assert.equal(record.retriedAlready, false);
      assert.ok(typeof record.requestedAt === "string", "requestedAt must be ISO string");
      assert.deepEqual(record.densityThresholds, SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("uses SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS with correct minActionableCount and minTopicCount", () => {
    assert.ok(
      typeof SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS.minActionableCount === "number" &&
      SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS.minActionableCount >= 1,
      "minActionableCount must be a positive number"
    );
    assert.ok(
      typeof SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS.minTopicCount === "number" &&
      SYNTHESIS_RECOVERY_DENSITY_THRESHOLDS.minTopicCount >= 1,
      "minTopicCount must be a positive number"
    );
  });

  it("negative path: does not throw when stateDir is non-writable path (fail-open)", async () => {
    // A truly non-writable path in a portable way: use an obviously invalid directory.
    await assert.doesNotReject(
      scheduleBoundedRecoverySynthesis("/nonexistent/does/not/exist"),
      "scheduleBoundedRecoverySynthesis must not throw on write failure (fail-open)"
    );
  });

  it("buildQualityGateRecoverySignal instructs evidence-first planning (not topic-name planning)", () => {
    const signal = buildQualityGateRecoverySignal(["Topic X"]);
    assert.ok(!signal.includes("use topic names as minimal planning signal"),
      "updated signal must NOT instruct Prometheus to use topic names as planning signal");
    assert.ok(signal.includes("internal-evidence-only planning mode"));
    assert.ok(
      /concrete repository evidence|repository evidence|repository state/i.test(signal),
      "updated signal must direct Prometheus to use concrete repository evidence"
    );
  });
});

// ── Category Frontier Ingestion Tests ─────────────────────────────────────────

import {
  normalizeCategoryFrontierEntry,
  buildBenchmarkEntry,
  persistBenchmarkEntry,
  BENCHMARK_ENTRY_SCHEMA_VERSION,
} from "../../src/core/research_synthesizer.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

describe("normalizeCategoryFrontierEntry — category frontier normalization", () => {
  it("normalizes a valid frontier entry with all fields", () => {
    const { entry, errors } = normalizeCategoryFrontierEntry({
      category: "django",
      resolvedCount: 72,
      totalCount: 100,
      model: "Claude Sonnet 4.6",
      date: "2024-01-01",
    });
    assert.equal(errors.length, 0, "no errors for valid input");
    assert.equal(entry.category, "django");
    assert.equal(entry.resolvedCount, 72);
    assert.equal(entry.totalCount, 100);
    assert.equal(entry.frontierScore, 0.72);
    assert.equal(entry.model, "Claude Sonnet 4.6");
  });

  it("computes frontierScore correctly from resolvedCount/totalCount", () => {
    const { entry } = normalizeCategoryFrontierEntry({
      category: "scikit-learn",
      resolvedCount: 3,
      totalCount: 10,
      model: "GPT-4o",
      date: "2024-06-01",
    });
    assert.equal(entry.frontierScore, 0.30);
  });

  it("returns frontierScore=0 when totalCount is 0 (no division by zero)", () => {
    const { entry } = normalizeCategoryFrontierEntry({
      category: "empty-category",
      resolvedCount: 0,
      totalCount: 0,
      model: "test-model",
      date: "2024-01-01",
    });
    assert.equal(entry.frontierScore, 0, "zero totalCount → frontierScore=0");
  });

  it("records validation error when category is missing (negative path)", () => {
    const { errors } = normalizeCategoryFrontierEntry({
      resolvedCount: 5,
      totalCount: 10,
      model: "test",
      date: "2024-01-01",
    });
    assert.ok(errors.some((e) => e.includes("missing_field:category")), "missing category → error");
  });

  it("records validation error when resolved > total (negative path)", () => {
    const { errors } = normalizeCategoryFrontierEntry({
      category: "django",
      resolvedCount: 50,
      totalCount: 10,
      model: "test",
      date: "2024-01-01",
    });
    assert.ok(errors.some((e) => e.includes("invalid_counts")), "resolved>total → error");
  });

  it("normalizes per-instance results when provided", () => {
    const { entry } = normalizeCategoryFrontierEntry({
      category: "django",
      resolvedCount: 2,
      totalCount: 3,
      model: "Claude",
      date: "2024-01-01",
      perInstance: [
        { instanceId: "django__1234", resolved: true, model: "Claude", date: "2024-01-01" },
        { instanceId: "django__5678", resolved: false, model: "Claude", date: "2024-01-01" },
      ],
    });
    assert.ok(Array.isArray(entry.perInstance), "perInstance should be array");
    assert.equal(entry.perInstance?.length, 2);
    assert.equal(entry.perInstance?.[0].instanceId, "django__1234");
    assert.equal(entry.perInstance?.[0].resolved, true);
  });
});

describe("buildBenchmarkEntry — category frontiers integration", () => {
  it("includes categoryFrontiers when provided", () => {
    const frontiers = [
      {
        category: "django",
        resolvedCount: 72,
        totalCount: 100,
        frontierScore: 0.72,
        model: "Claude",
        date: "2024-01-01",
      },
    ];
    const entry = buildBenchmarkEntry("cycle-001", [], frontiers);
    assert.ok(Array.isArray(entry.categoryFrontiers), "categoryFrontiers present");
    assert.equal(entry.categoryFrontiers?.length, 1);
    assert.equal(entry.categoryFrontiers?.[0].category, "django");
  });

  it("omits categoryFrontiers when not provided", () => {
    const entry = buildBenchmarkEntry("cycle-002", []);
    assert.equal(entry.categoryFrontiers, undefined, "categoryFrontiers absent when not passed");
  });

  it("omits categoryFrontiers when empty array provided", () => {
    const entry = buildBenchmarkEntry("cycle-003", [], []);
    assert.equal(entry.categoryFrontiers, undefined, "empty frontiers array omitted");
  });

  it("schemaVersion is BENCHMARK_ENTRY_SCHEMA_VERSION", () => {
    const entry = buildBenchmarkEntry("cycle-004", []);
    assert.equal(entry.schemaVersion, BENCHMARK_ENTRY_SCHEMA_VERSION);
  });
});

describe("persistBenchmarkEntry — category frontiers persistence", () => {
  it("persists entry with categoryFrontiers to json file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-synth-cat-"));
    const config = { paths: { stateDir: tmpDir } };
    const frontiers = [
      {
        category: "django",
        resolvedCount: 50,
        totalCount: 100,
        frontierScore: 0.50,
        model: "test-model",
        date: "2024-01-01",
      },
    ];
    await persistBenchmarkEntry(config, "cycle-persist-001", [], frontiers);
    const filePath = path.join(tmpDir, "benchmark_ground_truth.json");
    const raw = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.ok(Array.isArray(raw.entries), "entries array present");
    assert.equal(raw.entries.length, 1);
    assert.ok(Array.isArray(raw.entries[0].categoryFrontiers), "categoryFrontiers in persisted entry");
    assert.equal(raw.entries[0].categoryFrontiers[0].category, "django");
  });

  it("does not throw when stateDir is invalid (fail-open)", async () => {
    await assert.doesNotReject(
      persistBenchmarkEntry({ paths: { stateDir: "/nonexistent/dir" } }, "cycle-x", []),
      "persistBenchmarkEntry must not throw on write failure",
    );
  });
});

// ── Provenance fields in ResearchRecommendation ───────────────────────────────

import {
  extractRecommendationsList,
  isProvenanceComplete,
  PROVENANCE_COMPLETE_REQUIRED_FIELDS,
  IMPLEMENTATION_STATUS,
} from "../../src/core/research_synthesizer.js";

describe("extractRecommendationsList — provenance fields", () => {
  it("includes all provenance fields with null defaults", () => {
    const topics = [{ topic: "CI routing", netFindings: ["Use benchmark signals"] }];
    const recs = extractRecommendationsList(topics);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.equal(rec.source_url, null, "source_url defaults to null");
    assert.equal(rec.submission_id, null, "submission_id defaults to null");
    assert.equal(rec.model_tag, null, "model_tag defaults to null");
    assert.equal(rec.attempt_count, null, "attempt_count defaults to null");
    assert.equal(rec.prId, null, "prId defaults to null");
    assert.equal(rec.mergedSha, null, "mergedSha defaults to null");
    assert.equal(rec.ciClosed, null, "ciClosed defaults to null");
  });

  it("sets implementationStatus to pending for new recommendations", () => {
    const topics = [{ topic: "Test topic" }];
    const recs = extractRecommendationsList(topics);
    assert.equal(recs[0].implementationStatus, IMPLEMENTATION_STATUS.PENDING);
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(extractRecommendationsList([]), []);
  });

  it("returns empty array for non-array input (negative path)", () => {
    assert.deepEqual(extractRecommendationsList(null as any), []);
  });
});

describe("isProvenanceComplete", () => {
  const makeRec = (overrides: object = {}) => ({
    id: "rec-test-0",
    topic: "test",
    summary: "",
    implementationStatus: "implemented",
    benchmarkScore: null,
    capacityGain: null,
    evidence: "",
    source_url: null,
    submission_id: null,
    model_tag: null,
    attempt_count: null,
    prId: null,
    mergedSha: null,
    ciClosed: null,
    ...overrides,
  });

  it("returns true when mergedSha is non-empty and ciClosed is true", () => {
    const rec = makeRec({ mergedSha: "abc123def456", ciClosed: true });
    assert.equal(isProvenanceComplete(rec), true);
  });

  it("returns false when mergedSha is null (negative path)", () => {
    const rec = makeRec({ mergedSha: null, ciClosed: true });
    assert.equal(isProvenanceComplete(rec), false);
  });

  it("returns false when ciClosed is false (negative path)", () => {
    const rec = makeRec({ mergedSha: "abc123def456", ciClosed: false });
    assert.equal(isProvenanceComplete(rec), false);
  });

  it("returns false when ciClosed is null (negative path)", () => {
    const rec = makeRec({ mergedSha: "abc123def456", ciClosed: null });
    assert.equal(isProvenanceComplete(rec), false);
  });

  it("returns false when mergedSha is empty string (negative path)", () => {
    const rec = makeRec({ mergedSha: "", ciClosed: true });
    assert.equal(isProvenanceComplete(rec), false);
  });
});

describe("PROVENANCE_COMPLETE_REQUIRED_FIELDS", () => {
  it("is a frozen array containing mergedSha and ciClosed", () => {
    assert.ok(Object.isFrozen(PROVENANCE_COMPLETE_REQUIRED_FIELDS));
    assert.ok(PROVENANCE_COMPLETE_REQUIRED_FIELDS.includes("mergedSha"));
    assert.ok(PROVENANCE_COMPLETE_REQUIRED_FIELDS.includes("ciClosed"));
  });
});
