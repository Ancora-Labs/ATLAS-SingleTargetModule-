/**
 * contract_health.test.ts — Deterministic unit tests for src/workers/contract_health.ts
 *
 * These tests pin the exact contract-marker format, parse/format round-trips,
 * and all edge-case behaviours of every exported function.  They are intentionally
 * isolated: no child processes, no file I/O, no shared mutable state.
 *
 * Authoritative format:
 *   WORKER_CONTRACT_HEALTH=env_vars:<pass|fail|n/a>;payload:<pass|fail|n/a>;role:<pass|fail|n/a>
 *   WORKER_STARTUP_CONTRACT_ANCHOR=verified
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  STARTUP_CONTRACT_ANCHOR_KEY,
  formatContractHealth,
  parseContractHealth,
  isContractHealthy,
  formatStartupContractAnchor,
  parseStartupContractAnchor,
} from "../../src/workers/contract_health.js";
import type { ContractSlot } from "../../src/workers/contract_health.js";

// ── STARTUP_CONTRACT_ANCHOR_KEY ───────────────────────────────────────────────

describe("contract_health — STARTUP_CONTRACT_ANCHOR_KEY", () => {
  it("is exactly 'WORKER_STARTUP_CONTRACT_ANCHOR'", () => {
    assert.equal(STARTUP_CONTRACT_ANCHOR_KEY, "WORKER_STARTUP_CONTRACT_ANCHOR",
      "key must match the machine-parseable marker consumed by downstream runtime gates"
    );
  });

  it("contains only uppercase ASCII letters and underscores (no spaces or special chars)", () => {
    assert.ok(
      /^[A-Z_]+$/.test(STARTUP_CONTRACT_ANCHOR_KEY),
      `'${STARTUP_CONTRACT_ANCHOR_KEY}' must be uppercase ASCII with underscores only — log parsers depend on this`
    );
  });
});

// ── formatContractHealth ──────────────────────────────────────────────────────

describe("contract_health — formatContractHealth", () => {
  it("produces canonical WORKER_CONTRACT_HEALTH= prefix", () => {
    const line = formatContractHealth({ env_vars: "pass", payload: "pass", role: "pass" });
    assert.ok(line.startsWith("WORKER_CONTRACT_HEALTH="),
      "output must begin with 'WORKER_CONTRACT_HEALTH=' for machine-parseable gate consumption"
    );
  });

  it("formats all-pass as 'WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass'", () => {
    assert.equal(
      formatContractHealth({ env_vars: "pass", payload: "pass", role: "pass" }),
      "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass"
    );
  });

  it("formats env_vars:fail correctly (partial failure — env check stopped early)", () => {
    assert.equal(
      formatContractHealth({ env_vars: "fail", payload: "n/a", role: "n/a" }),
      "WORKER_CONTRACT_HEALTH=env_vars:fail;payload:n/a;role:n/a"
    );
  });

  it("formats payload:fail correctly (env passed, payload JSON invalid)", () => {
    assert.equal(
      formatContractHealth({ env_vars: "pass", payload: "fail", role: "n/a" }),
      "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:fail;role:n/a"
    );
  });

  it("is deterministic: identical input always produces identical output", () => {
    const health = { env_vars: "pass" as ContractSlot, payload: "fail" as ContractSlot, role: "n/a" as ContractSlot };
    const first = formatContractHealth(health);
    const second = formatContractHealth(health);
    assert.equal(first, second, "formatContractHealth must be a pure function with no randomness");
  });

  it("uses semicolons as field separators", () => {
    const line = formatContractHealth({ env_vars: "pass", payload: "pass", role: "pass" });
    const payload = line.slice("WORKER_CONTRACT_HEALTH=".length);
    const parts = payload.split(";");
    assert.equal(parts.length, 3, "exactly 3 fields must be separated by semicolons");
  });

  it("uses colons as key-value separators within each field", () => {
    const line = formatContractHealth({ env_vars: "pass", payload: "fail", role: "n/a" });
    const payload = line.slice("WORKER_CONTRACT_HEALTH=".length);
    for (const part of payload.split(";")) {
      assert.ok(part.includes(":"), `field '${part}' must use ':' as key-value separator`);
    }
  });

  it("field order is env_vars, payload, role", () => {
    const line = formatContractHealth({ env_vars: "pass", payload: "fail", role: "n/a" });
    const payload = line.slice("WORKER_CONTRACT_HEALTH=".length);
    const [f1, f2, f3] = payload.split(";");
    assert.ok(f1.startsWith("env_vars:"), "first field must be env_vars");
    assert.ok(f2.startsWith("payload:"), "second field must be payload");
    assert.ok(f3.startsWith("role:"), "third field must be role");
  });

  it("negative: does not produce extra whitespace or newlines in the output line", () => {
    const line = formatContractHealth({ env_vars: "pass", payload: "pass", role: "pass" });
    assert.ok(!line.includes(" "), "line must contain no spaces");
    assert.ok(!line.includes("\n"), "line must contain no newlines");
    assert.ok(!line.includes("\r"), "line must contain no carriage returns");
  });
});

// ── parseContractHealth ───────────────────────────────────────────────────────

describe("contract_health — parseContractHealth", () => {
  it("returns null for empty string", () => {
    assert.equal(parseContractHealth(""), null);
  });

  it("returns null for unrelated log lines", () => {
    assert.equal(parseContractHealth("[run_task] Worker container started"), null);
    assert.equal(parseContractHealth("BOX_STATUS=done"), null);
    assert.equal(parseContractHealth("WORKER_STARTUP_CONTRACT_ANCHOR=verified"), null);
    assert.equal(parseContractHealth("[run_task] Worker ready. Awaiting task dispatch."), null);
  });

  it("round-trips with formatContractHealth for all-pass", () => {
    const health = { env_vars: "pass" as ContractSlot, payload: "pass" as ContractSlot, role: "pass" as ContractSlot };
    assert.deepEqual(parseContractHealth(formatContractHealth(health)), health,
      "parse(format(x)) must equal x for the all-pass case"
    );
  });

  it("round-trips with formatContractHealth for env_vars:fail", () => {
    const health = { env_vars: "fail" as ContractSlot, payload: "n/a" as ContractSlot, role: "n/a" as ContractSlot };
    assert.deepEqual(parseContractHealth(formatContractHealth(health)), health);
  });

  it("round-trips with formatContractHealth for payload:fail", () => {
    const health = { env_vars: "pass" as ContractSlot, payload: "fail" as ContractSlot, role: "n/a" as ContractSlot };
    assert.deepEqual(parseContractHealth(formatContractHealth(health)), health);
  });

  it("parses a health line embedded in surrounding text (log-line extraction)", () => {
    const embedded = "2026-03-29T22:00:00Z [stdout] WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass OK";
    const result = parseContractHealth(embedded);
    assert.ok(result !== null, "must extract the health marker when embedded in surrounding log text");
    assert.equal(result!.env_vars, "pass");
    assert.equal(result!.payload, "pass");
    assert.equal(result!.role, "pass");
  });

  it("correctly parses n/a slot values", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:fail;payload:n/a;role:n/a";
    const result = parseContractHealth(line);
    assert.ok(result !== null);
    assert.equal(result!.env_vars, "fail");
    assert.equal(result!.payload, "n/a");
    assert.equal(result!.role, "n/a");
  });

  it("negative: returns null when role slot is missing (only 2 slots present)", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass";
    assert.equal(parseContractHealth(line), null,
      "must return null when any required slot (role) is absent from the health line"
    );
  });

  it("negative: returns null when env_vars slot is missing (only role and payload present)", () => {
    const line = "WORKER_CONTRACT_HEALTH=payload:pass;role:pass";
    assert.equal(parseContractHealth(line), null,
      "must return null when env_vars slot is absent from the health line"
    );
  });

  it("negative: returns null when a slot has an unrecognized value", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:ok;payload:pass;role:pass";
    assert.equal(parseContractHealth(line), null,
      "'ok' is not a valid ContractSlot value — only pass/fail/n/a are accepted"
    );
  });

  it("negative: returns null when health marker key is misspelled", () => {
    assert.equal(parseContractHealth("WORKER_HEALTH=env_vars:pass;payload:pass;role:pass"), null);
    assert.equal(parseContractHealth("CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass"), null);
  });
});

// ── isContractHealthy ─────────────────────────────────────────────────────────

describe("contract_health — isContractHealthy", () => {
  it("returns true only when all three slots are 'pass'", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "pass" }), true);
  });

  it("returns false when env_vars is 'fail'", () => {
    assert.equal(isContractHealthy({ env_vars: "fail", payload: "pass", role: "pass" }), false);
  });

  it("returns false when env_vars is 'n/a'", () => {
    assert.equal(isContractHealthy({ env_vars: "n/a", payload: "pass", role: "pass" }), false);
  });

  it("returns false when payload is 'fail'", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "fail", role: "pass" }), false);
  });

  it("returns false when payload is 'n/a'", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "n/a", role: "pass" }), false);
  });

  it("returns false when role is 'fail'", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "fail" }), false);
  });

  it("returns false when role is 'n/a'", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "n/a" }), false);
  });

  it("returns false when all slots are 'fail'", () => {
    assert.equal(isContractHealthy({ env_vars: "fail", payload: "fail", role: "fail" }), false);
  });

  it("returns false when all slots are 'n/a'", () => {
    assert.equal(isContractHealthy({ env_vars: "n/a", payload: "n/a", role: "n/a" }), false);
  });
});

// ── formatStartupContractAnchor ───────────────────────────────────────────────

describe("contract_health — formatStartupContractAnchor", () => {
  it("returns exactly 'WORKER_STARTUP_CONTRACT_ANCHOR=verified'", () => {
    assert.equal(formatStartupContractAnchor(), "WORKER_STARTUP_CONTRACT_ANCHOR=verified");
  });

  it("is deterministic across repeated calls", () => {
    assert.equal(formatStartupContractAnchor(), formatStartupContractAnchor());
  });

  it("output starts with STARTUP_CONTRACT_ANCHOR_KEY", () => {
    assert.ok(
      formatStartupContractAnchor().startsWith(STARTUP_CONTRACT_ANCHOR_KEY),
      "anchor line must begin with the exported STARTUP_CONTRACT_ANCHOR_KEY constant"
    );
  });

  it("output ends with '=verified' suffix", () => {
    assert.ok(
      formatStartupContractAnchor().endsWith("=verified"),
      "anchor line must end with '=verified' — this is the machine-parseable completion signal"
    );
  });

  it("negative: does not contain spaces or newlines", () => {
    const line = formatStartupContractAnchor();
    assert.ok(!line.includes(" "), "anchor line must not contain spaces");
    assert.ok(!line.includes("\n"), "anchor line must not contain newlines");
  });
});

// ── parseStartupContractAnchor ────────────────────────────────────────────────

describe("contract_health — parseStartupContractAnchor", () => {
  it("returns true for the exact anchor line", () => {
    assert.equal(parseStartupContractAnchor("WORKER_STARTUP_CONTRACT_ANCHOR=verified"), true);
  });

  it("returns true for the output of formatStartupContractAnchor()", () => {
    assert.equal(parseStartupContractAnchor(formatStartupContractAnchor()), true);
  });

  it("returns true when the anchor is embedded in surrounding log text", () => {
    assert.equal(
      parseStartupContractAnchor("[container] WORKER_STARTUP_CONTRACT_ANCHOR=verified OK"),
      true,
      "must detect anchor when it appears mid-line (log-line extraction case)"
    );
  });

  it("negative: returns false for empty string", () => {
    assert.equal(parseStartupContractAnchor(""), false);
  });

  it("negative: returns false for WORKER_CONTRACT_HEALTH= line (not the anchor)", () => {
    assert.equal(
      parseStartupContractAnchor("WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass"),
      false
    );
  });

  it("negative: returns false for BOX_STATUS=done", () => {
    assert.equal(parseStartupContractAnchor("BOX_STATUS=done"), false);
  });

  it("negative: returns false when key matches but value is not 'verified'", () => {
    assert.equal(
      parseStartupContractAnchor("WORKER_STARTUP_CONTRACT_ANCHOR=pending"),
      false,
      "only '=verified' is the accepted completion signal"
    );
  });

  it("negative: returns false for partial key matches (prefix-only mismatch)", () => {
    assert.equal(parseStartupContractAnchor("STARTUP_CONTRACT_ANCHOR=verified"), false);
    assert.equal(parseStartupContractAnchor("WORKER_CONTRACT_ANCHOR=verified"), false);
  });
});
