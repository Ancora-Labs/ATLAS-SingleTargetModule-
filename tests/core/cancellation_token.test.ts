/**
 * tests/core/cancellation_token.test.ts
 *
 * Unit tests for the CancellationToken contract (createCancellationToken,
 * CancelledError) added to daemon_control.ts and the
 * checkCancellationAtCheckpoint helper in checkpoint_engine.ts.
 *
 * Coverage:
 *   - createCancellationToken: initial state
 *   - cancel(reason): sets cancelled + reason; idempotent
 *   - throwIfCancelled(): throws CancelledError when cancelled; no-op otherwise
 *   - CancelledError: instance fields, instanceof check
 *   - checkCancellationAtCheckpoint: no-op for null/undefined, throws for cancelled token
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createCancellationToken,
  CancelledError,
} from "../../src/core/daemon_control.js";

import {
  checkCancellationAtCheckpoint,
} from "../../src/core/checkpoint_engine.js";

// ── createCancellationToken — initial state ───────────────────────────────────

describe("createCancellationToken — initial state", () => {
  it("starts as not cancelled", () => {
    const token = createCancellationToken();
    assert.strictEqual(token.cancelled, false);
  });

  it("starts with reason === null", () => {
    const token = createCancellationToken();
    assert.strictEqual(token.reason, null);
  });

  it("throwIfCancelled does not throw when not cancelled", () => {
    const token = createCancellationToken();
    assert.doesNotThrow(() => token.throwIfCancelled());
  });
});

// ── cancel(reason) ────────────────────────────────────────────────────────────

describe("CancellationToken.cancel", () => {
  it("sets cancelled to true", () => {
    const token = createCancellationToken();
    token.cancel("test-reason");
    assert.strictEqual(token.cancelled, true);
  });

  it("sets reason to provided string", () => {
    const token = createCancellationToken();
    token.cancel("stop-requested:user");
    assert.strictEqual(token.reason, "stop-requested:user");
  });

  it("is idempotent — repeated cancel does not overwrite reason", () => {
    const token = createCancellationToken();
    token.cancel("first-reason");
    token.cancel("second-reason");
    assert.strictEqual(token.reason, "first-reason");
  });

  it("cancelled remains true after multiple cancel calls", () => {
    const token = createCancellationToken();
    token.cancel("r1");
    token.cancel("r2");
    assert.strictEqual(token.cancelled, true);
  });
});

// ── throwIfCancelled ──────────────────────────────────────────────────────────

describe("CancellationToken.throwIfCancelled", () => {
  it("throws CancelledError when cancelled", () => {
    const token = createCancellationToken();
    token.cancel("dispatch-halted");
    assert.throws(() => token.throwIfCancelled(), CancelledError);
  });

  it("thrown error carries the cancellation reason", () => {
    const token = createCancellationToken();
    token.cancel("stop-file-detected");
    try {
      token.throwIfCancelled();
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof CancelledError);
      assert.strictEqual(err.reason, "stop-file-detected");
    }
  });

  it("does not throw when token is not cancelled", () => {
    const token = createCancellationToken();
    assert.doesNotThrow(() => token.throwIfCancelled());
  });
});

// ── CancelledError ────────────────────────────────────────────────────────────

describe("CancelledError", () => {
  it("is an instance of Error", () => {
    const err = new CancelledError("test");
    assert.ok(err instanceof Error);
  });

  it("has name === CancelledError", () => {
    const err = new CancelledError("test");
    assert.strictEqual(err.name, "CancelledError");
  });

  it("carries reason field", () => {
    const err = new CancelledError("evolution-loop-cancelled");
    assert.strictEqual(err.reason, "evolution-loop-cancelled");
  });

  it("message includes reason", () => {
    const err = new CancelledError("my-reason");
    assert.ok(err.message.includes("my-reason"));
  });

  it("negative path — does not match generic Error for instanceof", () => {
    const plain = new Error("plain");
    assert.strictEqual(plain instanceof CancelledError, false);
  });
});

// ── checkCancellationAtCheckpoint ─────────────────────────────────────────────

describe("checkCancellationAtCheckpoint", () => {
  it("is a no-op when token is undefined", () => {
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(undefined));
  });

  it("is a no-op when token is null", () => {
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(null));
  });

  it("is a no-op when token is not cancelled", () => {
    const token = createCancellationToken();
    assert.doesNotThrow(() => checkCancellationAtCheckpoint(token));
  });

  it("throws CancelledError when token is cancelled", () => {
    const token = createCancellationToken();
    token.cancel("batch-loop-halt");
    assert.throws(() => checkCancellationAtCheckpoint(token), CancelledError);
  });

  it("negative path — cancelled token throws regardless of reason text", () => {
    const token = createCancellationToken();
    token.cancel("");
    assert.throws(() => checkCancellationAtCheckpoint(token), (err) => {
      return err instanceof CancelledError;
    });
  });
});
