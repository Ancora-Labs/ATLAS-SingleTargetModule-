import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentLayerPrompt,
  getAgentLayerContract,
} from "../../src/core/agent_layer_contract.js";

describe("agent_layer_contract", () => {
  it("returns a self_dev boundary contract for protected agent surfaces", () => {
    const contract = getAgentLayerContract("research-scout", {
      selfDev: {
        enabled: true,
      },
      env: {
        targetRepo: "Ancora-Labs/Box",
      },
    });

    assert.equal(contract.activeProfile, "self_dev");
    assert.ok(contract.sharedCore.some((entry) => entry.includes("official docs")));
    assert.ok(contract.selfDevSpecific.some((entry) => entry.includes("BOX orchestration")));
    assert.ok(contract.singleTargetSpecific.some((entry) => entry.includes("active target repo")));
    assert.equal(contract.futureModeFlags.singleTargetDelivery, false);
  });

  it("covers research synthesizer in the same extracted layer model", () => {
    const contract = getAgentLayerContract("research-synthesizer", {
      selfDev: {
        enabled: true,
      },
      env: {
        targetRepo: "Ancora-Labs/Box",
      },
    });

    const prompt = buildAgentLayerPrompt("research-synthesizer", {
      selfDev: {
        enabled: true,
      },
      env: {
        targetRepo: "Ancora-Labs/Box",
      },
    });

    assert.equal(contract.activeProfile, "self_dev");
    assert.ok(contract.sharedCore.some((entry) => entry.includes("structured, decision-ready knowledge")));
    assert.ok(contract.selfDevSpecific.some((entry) => entry.includes("planning quality")));
    assert.ok(contract.singleTargetSpecific.some((entry) => entry.includes("active target repo")));
    assert.ok(prompt.includes("Research Synthesizer"));
    assert.ok(prompt.includes("SINGLE-TARGET-SPECIFIC"));
    assert.ok(prompt.includes("Do NOT invent target-session logic"));
  });

  it("builds a prompt that keeps future single-target behavior disabled", () => {
    const prompt = buildAgentLayerPrompt("worker", {
      selfDev: {
        enabled: true,
      },
      env: {
        targetRepo: "Ancora-Labs/Box",
      },
    });

    assert.ok(prompt.includes("PART 2 RUNTIME LAYER CONTRACT"));
    assert.ok(prompt.includes("Protected runtime profile: self_dev"));
    assert.ok(prompt.includes("SELF_DEV-SPECIFIC"));
    assert.ok(prompt.includes("SINGLE-TARGET-SPECIFIC"));
    assert.ok(prompt.includes("Future single-target behavior remains disabled"));
    assert.ok(prompt.includes("Do NOT invent target-session logic"));
  });

  it("negative path: rejects unknown agent surfaces", () => {
    assert.throws(
      () => getAgentLayerContract("unknown-agent", { selfDev: { enabled: true } }),
      /Unknown agent layer contract/
    );
  });
});