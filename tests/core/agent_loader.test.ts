import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentArgs, resolveAgentExecutionProfile, validateAgentContract } from "../../src/core/agent_loader.js";

describe("buildAgentArgs", () => {
  it("keeps existing leadership behavior by default", () => {
    // Leadership calls: no autopilot, no allow-all by default ÔÇö single-prompt mode
    const args = buildAgentArgs({
      agentSlug: "prometheus",
      prompt: "scan the repo",
      model: "GPT-5.3-Codex"
    });

    assert.ok(!args.includes("--autopilot"), "autopilot must be off by default");
    assert.ok(!args.includes("--max-autopilot-continues"), "max-autopilot-continues must be absent by default");
    assert.ok(args.includes("--agent"));
    assert.ok(args.includes("prometheus"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-5.3-codex"));
  });

  it("supports a single-request agent call without autopilot", () => {
    const args = buildAgentArgs({
      agentSlug: "evolution-worker",
      prompt: "read the repo and produce one plan",
      model: "GPT-5.3-Codex",
      allowAll: true,
      autopilot: false,
      noAskUser: true,
      silent: true,
      maxContinues: 40
    });

    assert.ok(args.includes("--allow-all"));
    assert.ok(args.includes("--no-ask-user"));
    assert.ok(args.includes("--silent"));
    assert.ok(!args.includes("--autopilot"));
    assert.ok(!args.includes("--max-autopilot-continues"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-5.3-codex"));
  });

  it("leaves model selection to Copilot when configured as auto", () => {
    const args = buildAgentArgs({
      agentSlug: "research-scout",
      prompt: "find strong sources",
      model: "auto",
      allowAll: true,
    });

    assert.ok(!args.includes("auto"));
    assert.ok(!args.includes("--model"));
    assert.ok(args.includes("--agent"));
    assert.ok(args.includes("research-scout"));
  });

  it("skips --agent when the execution workspace does not contain the agent file", () => {
    const args = buildAgentArgs({
      agentSlug: "quality-worker",
      prompt: "continue the task",
      model: "gpt-5.4",
      runContract: {
        executionCwd: "C:\\__box_missing_agent_workspace__",
      },
    });

    assert.ok(!args.includes("--agent"));
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("gpt-5.4"));
  });

  it("blocks broad allow-all when the agent profile is no_tools", () => {
    const args = buildAgentArgs({
      agentSlug: "prometheus",
      prompt: "read the repo and produce one plan",
      allowAll: true,
      noAskUser: true,
    });

    assert.ok(!args.includes("--allow-all"));
    assert.ok(args.includes("--no-ask-user"));
  });

  it("prepends a stable prompt-lineage preamble when runContract carries lineage", () => {
    const args = buildAgentArgs({
      agentSlug: "prometheus",
      prompt: "TARGET REPO: box",
      runContract: {
        promptLineage: {
          lineageId: "planner:abc",
          promptFamilyKey: "family-123",
          agent: "prometheus",
          stage: "planner",
          totalSegments: 4,
          cacheableSegments: 2,
          estimatedSavedTokens: 80,
        },
      },
    });
    const promptIndex = args.indexOf("-p");
    const promptText = String(args[promptIndex + 1] || "");
    assert.ok(promptText.startsWith("## PROMPT LINEAGE"));
    assert.ok(promptText.includes("promptFamilyKey=family-123"));
    assert.ok(promptText.includes("TARGET REPO: box"));
  });

  it("extracts prompt-lineage metadata from serialized prompt text", () => {
    const args = buildAgentArgs({
      agentSlug: "athena",
      prompt: 'Execution Strategy: {"promptLineage":{"lineageId":"planner:def","promptFamilyKey":"family-456","agent":"prometheus","stage":"planner","totalSegments":3,"cacheableSegments":1,"estimatedSavedTokens":40}}',
    });
    const promptIndex = args.indexOf("-p");
    const promptText = String(args[promptIndex + 1] || "");
    assert.ok(promptText.startsWith("## PROMPT LINEAGE"));
    assert.ok(promptText.includes("lineageId=planner:def"));
  });
});

describe("agent execution profiles", () => {
  it("validates explicit critical-agent session controls", () => {
    const result = validateAgentContract("prometheus");
    assert.equal(result.valid, true, `prometheus violations: ${result.violations.join(", ")}`);
    assert.equal(result.fields.boxSessionInputPolicy, "no_tools");
    assert.equal(result.fields.boxHookCoverage, "not_required");
  });

  it("resolves a read-only profile for Athena", () => {
    const profile = resolveAgentExecutionProfile("athena");
    assert.equal(profile.valid, true, `athena violations: ${profile.violations.join(", ")}`);
    assert.equal(profile.sessionInputPolicy, "no_tools");
    assert.equal(profile.hookCoverage, "not_required");
    assert.equal(profile.allowsExecute, false);
  });

  it("resolves an execute-enabled onboarding profile with required hook coverage", () => {
    const profile = resolveAgentExecutionProfile("onboarding");
    assert.equal(profile.valid, true, `onboarding violations: ${profile.violations.join(", ")}`);
    assert.equal(profile.sessionInputPolicy, "auto");
    assert.equal(profile.hookCoverage, "required");
    assert.equal(profile.allowsExecute, true);
  });

  it("resolves execute-enabled clarification onboarding profiles for empty and existing repos", () => {
    for (const slug of ["onboarding-empty-repo", "onboarding-existing-repo"]) {
      const profile = resolveAgentExecutionProfile(slug);
      assert.equal(profile.valid, true, `${slug} violations: ${profile.violations.join(", ")}`);
      assert.equal(profile.sessionInputPolicy, "auto");
      assert.equal(profile.hookCoverage, "required");
      assert.equal(profile.allowsExecute, true);
    }
  });
});
