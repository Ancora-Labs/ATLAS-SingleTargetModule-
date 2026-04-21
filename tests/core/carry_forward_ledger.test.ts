import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  addDebtEntries,
  tickCycle,
  closeDebt,
  getOpenDebts,
  shouldBlockOnDebt,
  computeFingerprint,
  loadLedgerMeta,
  saveLedgerFull,
  autoCloseVerifiedDebt,
  reconcileReplayClosedDebtLineage,
  reconcileReplayClosureBacklog,
  MANDATORY_REPLAY_LINEAGE_IDS,
  prioritizeStaleDebts,
  clusterDuplicateDebts,
  compressLedger,
  classifyCarryForwardByRecurrence,
} from "../../src/core/carry_forward_ledger.js";
import { filterResolvedCarryForwardItems } from "../../src/core/prometheus.js";
import { buildRankedLessonShortlists } from "../../src/core/lesson_halflife.js";
import { buildCiUrgencyContext } from "../../src/core/self_improvement.js";

describe("carry_forward_ledger", () => {
  describe("addDebtEntries", () => {
    it("adds valid debt entries to empty ledger", () => {
      const result = addDebtEntries([], [
        { followUpTask: "Fix flaky test in worker runner module", workerName: "evolution-worker", severity: "critical" },
      ], 5);
      assert.equal(result.length, 1);
      assert.equal(result[0].lesson, "Fix flaky test in worker runner module");
      assert.equal(result[0].owner, "evolution-worker");
      assert.equal(result[0].openedCycle, 5);
      assert.equal(result[0].dueCycle, 8); // default SLA = 3
      assert.equal(result[0].severity, "critical");
      assert.equal(result[0].closedAt, null);
      // fingerprint is stamped and deterministic
      assert.ok(typeof result[0].fingerprint === "string" && result[0].fingerprint.length === 16);
      assert.equal(result[0].fingerprint, computeFingerprint("Fix flaky test in worker runner module"));
    });

    it("deduplicates by deterministic fingerprint", () => {
      const existing = [{
        id: "debt-1-0",
        lesson: "Fix flaky test",
        fingerprint: computeFingerprint("Fix flaky test"),
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const result = addDebtEntries(existing, [
        { followUpTask: "Fix flaky test" }, // identical canonical form → same fingerprint
      ], 2);
      assert.equal(result.length, 1); // no duplicate added
    });

    it("deduplicates legacy entries without fingerprint field by computing on-the-fly", () => {
      const existing = [{
        id: "debt-1-0",
        lesson: "Fix flaky test",
        // no fingerprint field — simulates a pre-upgrade ledger entry
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const result = addDebtEntries(existing, [
        { followUpTask: "Fix flaky test" },
      ], 2);
      assert.equal(result.length, 1);
    });

    it("ignores items with short lesson text", () => {
      const result = addDebtEntries([], [
        { followUpTask: "short" },
      ], 1);
      assert.equal(result.length, 0);
    });

    it("respects custom SLA", () => {
      const result = addDebtEntries([], [
        { followUpTask: "A sufficiently long lesson text for testing", severity: "warning" },
      ], 10, { slaMaxCycles: 5 });
      assert.equal(result[0].dueCycle, 15);
    });
  });

  describe("tickCycle", () => {
    it("increments cyclesOpen and detects overdue", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Old unresolved lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 3,
        severity: "critical",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const { overdue } = tickCycle(ledger, 5);
      assert.equal(ledger[0].cyclesOpen, 4);
      assert.equal(overdue.length, 1);
    });

    it("skips closed entries", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Closed lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 3,
        severity: "critical",
        closedAt: "2025-01-01T00:00:00Z",
        closureEvidence: "fixed",
        cyclesOpen: 0,
      }];
      const { overdue } = tickCycle(ledger, 5);
      assert.equal(overdue.length, 0);
      assert.equal(ledger[0].cyclesOpen, 0); // unchanged
    });
  });

  describe("closeDebt", () => {
    it("closes an open entry", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 2,
      }];
      const result = closeDebt(ledger, "debt-1-0", "PR #123 merged");
      assert.equal(result, true);
      assert.ok(ledger[0].closedAt);
      assert.equal(ledger[0].closureEvidence, "PR #123 merged");
    });

    it("returns false for unknown id", () => {
      assert.equal(closeDebt([], "nonexistent", "evidence"), false);
    });

    it("returns false for already-closed entry", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: "2025-01-01",
        closureEvidence: "fixed",
        cyclesOpen: 0,
      }];
      assert.equal(closeDebt(ledger, "debt-1-0", "new evidence"), false);
    });
  });

  describe("getOpenDebts", () => {
    it("returns only unclosed entries", () => {
      const ledger = [
        { id: "d1", closedAt: null },
        { id: "d2", closedAt: "2025-01-01" },
        { id: "d3", closedAt: null },
      ];
      const open = getOpenDebts(ledger);
      assert.equal(open.length, 2);
      assert.deepEqual(open.map(e => e.id), ["d1", "d3"]);
    });
  });

  describe("shouldBlockOnDebt", () => {
    it("blocks when critical overdue count exceeds threshold", () => {
      const ledger = [
        { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d3", lesson: "C", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      ];
      const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
      assert.equal(result.shouldBlock, true);
      assert.equal(result.overdueCount, 3);
    });

    it("does not block when under threshold", () => {
      const ledger = [
        { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "warning", closedAt: null, cyclesOpen: 0 },
      ];
      const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
      assert.equal(result.shouldBlock, false);
    });

    it("does not block with empty ledger", () => {
      const result = shouldBlockOnDebt([], 10);
      assert.equal(result.shouldBlock, false);
      assert.equal(result.overdueCount, 0);
    });
  });

  describe("computeFingerprint", () => {
    it("returns a 16-character hex string", () => {
      const fp = computeFingerprint("Fix the validation harness in worker runner");
      assert.ok(typeof fp === "string");
      assert.equal(fp.length, 16);
      assert.match(fp, /^[0-9a-f]{16}$/);
    });

    it("is deterministic — same input always produces same fingerprint", () => {
      const text = "Upgrade evaluation stack to reduce flakiness";
      assert.equal(computeFingerprint(text), computeFingerprint(text));
    });

    it("strips boilerplate before hashing — noise-equivalent texts share a fingerprint", () => {
      const withNoise = "Create and complete a task to fix the verification harness";
      const canonical = "fix the verification harness";
      assert.equal(computeFingerprint(withNoise), computeFingerprint(canonical));
    });

    it("distinguishes semantically different texts", () => {
      assert.notEqual(
        computeFingerprint("Fix flaky test in worker runner"),
        computeFingerprint("Add circuit breaker for model calls")
      );
    });

    it("returns null for text that is too short after canonicalization", () => {
      assert.equal(computeFingerprint(""), null);
      assert.equal(computeFingerprint("  "), null);
    });
  });
});

function makeCiReplayContractEvidence(overrides: Record<string, unknown> = {}) {
  return {
    workerContract: {
      passed: true,
      prUrl: "https://github.com/owner/repo/pull/42",
      associatedMainCiConclusion: "success",
      associatedMainCiBranch: "main",
      associatedMainCiRunUrl: "https://github.com/owner/repo/actions/runs/4242",
      associatedMainCiHeadSha: "abc1234",
      artifactDetail: {
        hasSha: true,
        hasTestOutput: true,
        hasCleanTreeEvidence: true,
        hasUnfilledPlaceholder: false,
      },
    },
    replayClosure: {
      contractSatisfied: true,
      executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
      rawArtifactEvidenceLinks: [
        "inline://post-merge-sha/abc1234",
        "inline://clean-tree-status",
        "inline://npm-test-output-block",
        "https://github.com/owner/repo/actions/runs/4242",
      ],
    },
    ...overrides,
  };
}

// ── loadLedgerMeta / saveLedgerFull — persistence layer ──────────────────────

describe("loadLedgerMeta / saveLedgerFull", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cfl-meta-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function cfg() {
    return { paths: { stateDir: tmpDir } };
  }

  it("defaults cycleCounter to 1 when ledger file does not exist", async () => {
    const { entries, cycleCounter } = await loadLedgerMeta(cfg());
    assert.deepEqual(entries, []);
    assert.equal(cycleCounter, 1);
  });

  it("saveLedgerFull persists entries and cycleCounter; loadLedgerMeta reads them back", async () => {
    const entry = {
      id: "debt-1-0",
      lesson: "Fix the validation harness",
      fingerprint: computeFingerprint("Fix the validation harness"),
      owner: "evolution-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
    await saveLedgerFull(cfg(), [entry], 7);

    const { entries, cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "debt-1-0");
    assert.equal(cycleCounter, 7);
  });

  it("loadLedgerMeta falls back to cycleCounter=1 when field is missing from file", async () => {
    const filePath = path.join(tmpDir, "carry_forward_ledger.json");
    await fs.writeFile(filePath, JSON.stringify({ entries: [] }), "utf8");

    const { cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(cycleCounter, 1);
  });

  it("loadLedgerMeta falls back to cycleCounter=1 when field is zero or negative", async () => {
    const filePath = path.join(tmpDir, "carry_forward_ledger.json");
    await fs.writeFile(filePath, JSON.stringify({ entries: [], cycleCounter: 0 }), "utf8");

    const { cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(cycleCounter, 1);
  });
});

// ── autoCloseVerifiedDebt ─────────────────────────────────────────────────────

describe("autoCloseVerifiedDebt", () => {
  function makeEntry(lesson: string, id = "debt-1-0"): any {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  function makeReplayContractEvidence(overrides: Record<string, unknown> = {}) {
    return {
      workerContract: {
        passed: true,
        artifactDetail: {
          hasSha: true,
          hasTestOutput: true,
          hasCleanTreeEvidence: true,
          hasUnfilledPlaceholder: false,
        },
      },
      replayClosure: {
        contractSatisfied: true,
        executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
        rawArtifactEvidenceLinks: [
          "inline://post-merge-sha/abc1234",
          "inline://clean-tree-status",
          "inline://npm-test-output-block",
        ],
      },
      ...overrides,
    };
  }

  it("closes a matching open entry when replay closure contract is satisfied", () => {
    const lesson = "Fix flaky worker runner test suite reliability issue";
    const ledger = [makeEntry(lesson)];
    const count = autoCloseVerifiedDebt(ledger, [
      { taskText: lesson, verificationEvidence: makeReplayContractEvidence() },
    ]);
    assert.equal(count, 1, "One entry must be closed");
    assert.ok(ledger[0].closedAt, "closedAt must be set");
    assert.match(String(ledger[0].closureEvidence || ""), /replay-closure:v1/);
  });

  it("does NOT close an entry when replay closure evidence links are missing", () => {
    const lesson = "Fix broken governance canary breach detection path";
    const ledger = [makeEntry(lesson)];
    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: makeReplayContractEvidence({
        replayClosure: {
          contractSatisfied: false,
          executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
          rawArtifactEvidenceLinks: [],
        },
      }),
    }]);
    assert.equal(count, 0, "Must not close without replay artifact links");

    assert.equal(ledger[0].closedAt, null, "Entry must remain open");
  });

  it("does NOT close an entry when canonical replay commands are incomplete", () => {
    const lesson = "Fix replay artifact workflow command coverage";
    const ledger = [makeEntry(lesson)];
    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: makeReplayContractEvidence({
        replayClosure: {
          contractSatisfied: true,
          executedCommands: ["git rev-parse HEAD", "npm test"],
          rawArtifactEvidenceLinks: ["inline://post-merge-sha/abc1234"],
        },
      }),
    }]);
    assert.equal(count, 0, "Must not close when canonical replay command evidence is incomplete");
    assert.equal(ledger[0].closedAt, null);
  });

  it("does NOT close an entry when task text does not fingerprint-match the lesson", () => {
    const ledger = [makeEntry("Fix the orchestrator dispatch retry logic")];
    const count = autoCloseVerifiedDebt(ledger, [
      { taskText: "Completely unrelated task about documentation", verificationEvidence: "Done — PR #77 merged" },
    ]);
    assert.equal(count, 0, "Non-matching task must not close any entry");
    assert.equal(ledger[0].closedAt, null);
  });

  it("does NOT re-close an already-closed entry", () => {
    const lesson = "Fix the carry-forward SLA accounting cycle counter bug";
    const ledger = [makeEntry(lesson)];
    // Close first time
    autoCloseVerifiedDebt(ledger, [{ taskText: lesson, verificationEvidence: makeReplayContractEvidence() }]);
    assert.ok(ledger[0].closedAt);
    // Try again with different evidence
    const count2 = autoCloseVerifiedDebt(ledger, [
      { taskText: lesson, verificationEvidence: makeReplayContractEvidence() },
    ]);
    assert.equal(count2, 0, "Already-closed entry must not be re-closed");
  });

  it("closes only matching entries in a mixed ledger", () => {
    const resolvedLesson = "Fix the worker batch planner wave ordering contract";
    const unresolvedLesson = "Resolve the governance freeze gate risk-level evaluation gap";
    const ledger = [
      makeEntry(resolvedLesson, "debt-1-0"),
      makeEntry(unresolvedLesson, "debt-1-1"),
    ];

    const count = autoCloseVerifiedDebt(ledger, [
      { taskText: resolvedLesson, verificationEvidence: makeReplayContractEvidence() },
    ]);

    assert.equal(count, 1, "Exactly one entry must be closed");
    assert.ok(ledger[0].closedAt, "First entry must be closed");
    assert.equal(ledger[1].closedAt, null, "Second entry must remain open");
  });

  it("returns 0 for empty resolvedItems", () => {
    const ledger = [makeEntry("Fix something critical in the pipeline")];
    assert.equal(autoCloseVerifiedDebt(ledger, []), 0);
    assert.equal(ledger[0].closedAt, null);
  });

  it("returns 0 for empty ledger", () => {
    const count = autoCloseVerifiedDebt([], [
      { taskText: "Fix something", verificationEvidence: makeReplayContractEvidence() },
    ]);
    assert.equal(count, 0);
  });

  it("negative path: unresolved critical debt item remains blocking after partial close", () => {
    const resolvedLesson = "Fix the worker runner retry loop transient error handling";
    const blockingLesson = "Fix governance canary breach detection false negative path";
    const ledger = [
      makeEntry(resolvedLesson, "debt-r"),
      { ...makeEntry(blockingLesson, "debt-b"), severity: "critical" },
      { ...makeEntry("Another critical issue", "debt-c"), severity: "critical", fingerprint: computeFingerprint("Another critical issue") },
    ];

    autoCloseVerifiedDebt(ledger, [
      { taskText: resolvedLesson, verificationEvidence: makeReplayContractEvidence() },
    ]);

    // Resolved entry is now closed; the critical ones are still open
    const shouldBlock = ledger
      .filter(e => !e.closedAt && e.severity === "critical")
      .length >= 2;
    assert.equal(shouldBlock, true, "Unresolved critical debt must still block after partial close");
  });
});

describe("reconcileReplayClosureBacklog", () => {
  it("reopens mandatory replay lineage items when ledger has no closure evidence", () => {
    const backlog = {
      schemaVersion: 1,
      items: [
        { id: "CF-001", status: "closed_via_replay_contract", title: "Workers not including BOX_MERGED_SHA in done output" },
        { id: "CF-005", status: "closed_via_replay_contract", title: "Workers using unfilled template placeholders" },
      ],
    };
    const ledger = [
      {
        id: "debt-1-0",
        lesson: "Workers not including BOX_MERGED_SHA in done output",
        closedAt: null,
        closureEvidence: null,
      },
    ];

    const reconciled = reconcileReplayClosureBacklog(backlog, ledger);
    assert.equal(reconciled.items[0].status, "open");
    assert.equal(reconciled.items[1].status, "open");
  });

  it("keeps mandatory replay lineage closed only with replay-closure evidence", () => {
    const backlog = {
      schemaVersion: 1,
      items: [
        { id: "CF-003", status: "open", title: "Workers using node --test tests/** glob patterns instead of npm test" },
      ],
    };
    const ledger = [
      {
        id: "debt-1-3",
        lesson: "Workers using node --test tests/** glob patterns instead of npm test",
        closedAt: "2026-01-01T00:00:00.000Z",
        closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://npm-test-output-block]",
      },
    ];

    const reconciled = reconcileReplayClosureBacklog(backlog, ledger);
    assert.equal(reconciled.items[0].status, "closed_via_replay_contract");
    assert.equal(reconciled.items[0].debtId, "debt-1-3");
  });

  it("only reconciles mandatory #1-#5 lineage items", () => {
    const backlog = {
      schemaVersion: 1,
      items: [
        { id: "CF-001", status: "open", title: "A" },
        { id: "CF-999", status: "closed_via_replay_contract", title: "non-mandatory" },
      ],
    };
    const reconciled = reconcileReplayClosureBacklog(backlog, []);
    assert.deepEqual(MANDATORY_REPLAY_LINEAGE_IDS, ["CF-001", "CF-002", "CF-003", "CF-004", "CF-005"]);
    assert.equal(reconciled.items[1].status, "closed_via_replay_contract");
  });
});

describe("reconcileReplayClosedDebtLineage", () => {
  function makeReplayClosedEntry(lesson: string, id: string) {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "warning",
      closedAt: "2026-01-01T00:00:00.000Z",
      closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block]",
      cyclesOpen: 0,
    };
  }

  function makeOpenEntry(lesson: string, id: string) {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle: 25,
      dueCycle: 28,
      severity: "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  it("closes later duplicate entries when an earlier replay-closed lineage exists", () => {
    const lesson = "Implement a code-level gate in the worker runtime that blocks emission of BOX_STATUS=done unless the output buffer contains a verbatim block with both raw npm test stdout and a git SHA.";
    const ledger = [
      makeReplayClosedEntry(lesson, "debt-1-8"),
      makeOpenEntry(lesson, "debt-25-30"),
    ];

    const count = reconcileReplayClosedDebtLineage(ledger);

    assert.equal(count, 1);
    assert.ok(ledger[1].closedAt, "duplicate open entry must be closed");
    assert.match(String(ledger[1].closureEvidence || ""), /replay-closure:v1/);
  });

  it("does not close unrelated open entries without replay-closed fingerprint matches", () => {
    const ledger = [
      makeReplayClosedEntry("Workers using node --test tests/** glob patterns instead of npm test", "debt-1-3"),
      makeOpenEntry("Completely different unresolved planner issue", "debt-25-99"),
    ];

    const count = reconcileReplayClosedDebtLineage(ledger);

    assert.equal(count, 0);
    assert.equal(ledger[1].closedAt, null);
  });

  it("does not inherit replay-only lineage for CI-class lessons without merged PR and main-CI evidence", () => {
    const lesson = "Fix CI workflow dispatch flake on main branch";
    const ledger = [
      {
        ...makeReplayClosedEntry(lesson, "debt-1-9"),
        closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block]",
      },
      makeOpenEntry(lesson, "debt-25-31"),
    ];

    const count = reconcileReplayClosedDebtLineage(ledger);

    assert.equal(count, 0);
    assert.equal(ledger[1].closedAt, null);
  });
});

// ── tickCycle early warning tier ─────────────────────────────────────────────

describe("tickCycle — early warning", () => {
  it("includes entries one cycle before their due date in earlyWarning", () => {
    const ledger = [{
      id: "debt-1-0",
      lesson: "Approaching deadline",
      owner: "w",
      openedCycle: 1,
      dueCycle: 6,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    }];
    // currentCycle=5, dueCycle=6 → within one cycle of deadline → earlyWarning
    const { overdue, earlyWarning } = tickCycle(ledger, 5);
    assert.equal(overdue.length, 0, "not yet overdue");
    assert.equal(earlyWarning.length, 1, "must surface as early warning");
  });

  it("does not include entries with more than one cycle remaining in earlyWarning", () => {
    const ledger = [{
      id: "debt-1-0",
      lesson: "Not yet close to deadline",
      owner: "w",
      openedCycle: 1,
      dueCycle: 10,
      severity: "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    }];
    const { earlyWarning } = tickCycle(ledger, 5);
    assert.equal(earlyWarning.length, 0);
  });

  it("already-overdue entries appear in overdue, not earlyWarning", () => {
    const ledger = [{
      id: "debt-1-0",
      lesson: "Already overdue lesson",
      owner: "w",
      openedCycle: 1,
      dueCycle: 3,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    }];
    const { overdue, earlyWarning } = tickCycle(ledger, 7);
    assert.equal(overdue.length, 1);
    assert.equal(earlyWarning.length, 0);
  });

  it("closed entries do not appear in earlyWarning", () => {
    const ledger = [{
      id: "debt-1-0",
      lesson: "Closed lesson",
      owner: "w",
      openedCycle: 1,
      dueCycle: 6,
      severity: "critical",
      closedAt: "2025-01-01T00:00:00Z",
      closureEvidence: "fixed",
      cyclesOpen: 0,
    }];
    const { earlyWarning } = tickCycle(ledger, 5);
    assert.equal(earlyWarning.length, 0);
  });
});

// ── shouldBlockOnDebt — reason codes + early warning ─────────────────────────

describe("shouldBlockOnDebt — reason codes and early warning", () => {
  it("returns reasonCode=DEBT_SLA_EXCEEDED when blocking", () => {
    const ledger = [
      { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      { id: "d3", lesson: "C", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
    ];
    const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, true);
    assert.equal(result.reasonCode, "DEBT_SLA_EXCEEDED");
  });

  it("returns reasonCode=DEBT_APPROACHING_SLA when a critical entry is one cycle from due", () => {
    const ledger = [{
      id: "d1",
      lesson: "Critical item about to breach SLA",
      openedCycle: 1,
      dueCycle: 6,
      severity: "critical",
      closedAt: null,
      cyclesOpen: 0,
    }];
    // currentCycle=5, dueCycle=6 → earlyWarning fires
    const result = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, false, "early warning must not hard-block");
    assert.equal(result.reasonCode, "DEBT_APPROACHING_SLA");
    assert.equal(result.earlyWarningCount, 1);
  });

  it("returns reasonCode=null and earlyWarningCount=0 when no issues", () => {
    const result = shouldBlockOnDebt([], 10);
    assert.equal(result.shouldBlock, false);
    assert.equal(result.reasonCode, null);
    assert.equal(result.earlyWarningCount, 0);
  });

  it("earlyWarningCount is exposed alongside overdueCount when blocking", () => {
    const ledger = [
      { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      { id: "d3", lesson: "C", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
    ];
    const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
    assert.ok(typeof result.earlyWarningCount === "number", "earlyWarningCount must always be present");
    assert.ok(typeof result.overdueCount === "number", "overdueCount must always be present");
  });

  it("negative: warning-severity early warning items do not set DEBT_APPROACHING_SLA", () => {
    const ledger = [{
      id: "d1",
      lesson: "Warning item approaching SLA",
      openedCycle: 1,
      dueCycle: 6,
      severity: "warning",
      closedAt: null,
      cyclesOpen: 0,
    }];
    const result = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, false);
    assert.equal(result.reasonCode, null, "warning-severity items must not set reasonCode");
    assert.equal(result.earlyWarningCount, 0, "earlyWarningCount counts only critical items");
  });
});

// ── prioritizeStaleDebts ──────────────────────────────────────────────────────

describe("prioritizeStaleDebts", () => {
  function makeDebt(opts: Partial<{
    id: string; lesson: string; severity: string;
    openedCycle: number; dueCycle: number; closedAt: string | null;
  }> = {}) {
    return {
      id:          opts.id          ?? "debt-1",
      lesson:      opts.lesson      ?? "Fix something important in the pipeline",
      severity:    opts.severity    ?? "warning",
      owner:       "evolution-worker",
      openedCycle: opts.openedCycle ?? 1,
      dueCycle:    opts.dueCycle    ?? 10,
      closedAt:    opts.closedAt    ?? null,
      closureEvidence: null,
      cyclesOpen:  0,
    };
  }

  it("returns empty array for empty ledger", () => {
    assert.deepEqual(prioritizeStaleDebts([], 5), []);
  });

  it("excludes closed entries", () => {
    const ledger = [
      makeDebt({ id: "d1", closedAt: "2025-01-01T00:00:00Z" }),
      makeDebt({ id: "d2" }),
    ];
    const result = prioritizeStaleDebts(ledger, 5);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "d2");
  });

  it("places critical+overdue first (highest priority)", () => {
    const ledger = [
      makeDebt({ id: "low",  severity: "warning",  openedCycle: 1, dueCycle: 10 }),
      makeDebt({ id: "high", severity: "critical", openedCycle: 1, dueCycle: 2  }), // overdue at cycle 5
    ];
    const result = prioritizeStaleDebts(ledger, 5);
    assert.equal(result[0].id, "high", "critical+overdue must be first");
    assert.equal(result[1].id, "low");
  });

  it("places warning+overdue above critical+pending", () => {
    const ledger = [
      makeDebt({ id: "crit-pending",  severity: "critical", openedCycle: 1, dueCycle: 10 }),
      makeDebt({ id: "warn-overdue",  severity: "warning",  openedCycle: 1, dueCycle: 2  }), // overdue
    ];
    const result = prioritizeStaleDebts(ledger, 5);
    assert.equal(result[0].id, "warn-overdue", "warning+overdue outranks critical+pending");
    assert.equal(result[1].id, "crit-pending");
  });

  it("sorts by cyclesOpen descending within same priority tier", () => {
    const ledger = [
      makeDebt({ id: "newer", severity: "critical", openedCycle: 4, dueCycle: 2 }), // overdue, cyclesOpen=1
      makeDebt({ id: "older", severity: "critical", openedCycle: 1, dueCycle: 2 }), // overdue, cyclesOpen=4
    ];
    const result = prioritizeStaleDebts(ledger, 5);
    assert.equal(result[0].id, "older", "stalest (most cycles open) must come first in same tier");
    assert.equal(result[1].id, "newer");
  });

  it("updates cyclesOpen on returned entries", () => {
    const ledger = [makeDebt({ openedCycle: 1 })];
    const result = prioritizeStaleDebts(ledger, 7);
    assert.equal(result[0].cyclesOpen, 6);
  });

  it("does not update cyclesOpen on closed entries (they are excluded)", () => {
    const closed = makeDebt({ closedAt: "2025-01-01T00:00:00Z", openedCycle: 1 });
    prioritizeStaleDebts([closed], 7);
    assert.equal(closed.cyclesOpen, 0, "cyclesOpen on closed entry must not be modified");
  });

  it("full priority ordering: critical+overdue > warning+overdue > critical+pending > warning+pending", () => {
    const ledger = [
      makeDebt({ id: "wp",  severity: "warning",  openedCycle: 1, dueCycle: 10 }),
      makeDebt({ id: "wo",  severity: "warning",  openedCycle: 1, dueCycle: 2  }), // overdue
      makeDebt({ id: "cp",  severity: "critical", openedCycle: 1, dueCycle: 10 }),
      makeDebt({ id: "co",  severity: "critical", openedCycle: 1, dueCycle: 2  }), // overdue
    ];
    const result = prioritizeStaleDebts(ledger, 5);
    assert.equal(result[0].id, "co", "1st: critical+overdue");
    assert.equal(result[1].id, "wo", "2nd: warning+overdue");
    assert.equal(result[2].id, "cp", "3rd: critical+pending");
    assert.equal(result[3].id, "wp", "4th: warning+pending");
  });

  it("negative path: all-closed ledger returns empty array", () => {
    const ledger = [
      makeDebt({ id: "d1", closedAt: "2025-01-01T00:00:00Z", severity: "critical" }),
      makeDebt({ id: "d2", closedAt: "2025-01-02T00:00:00Z", severity: "critical" }),
    ];
    const result = prioritizeStaleDebts(ledger, 10);
    assert.deepEqual(result, [], "closed entries must not appear in prioritized output");
  });
});

// ── clusterDuplicateDebts ─────────────────────────────────────────────────────

describe("clusterDuplicateDebts (Task 2)", () => {
  function makeOpen(id: string, lesson: string, openedCycle = 1): any {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle,
      dueCycle: openedCycle + 3,
      severity: "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  it("groups open entries with identical fingerprints into clusters", () => {
    const lesson = "Fix the worker runner retry loop transient error handling";
    const ledger = [
      makeOpen("debt-1", lesson, 1),
      makeOpen("debt-2", lesson, 2),
      makeOpen("debt-3", lesson, 3),
    ];
    const clusters = clusterDuplicateDebts(ledger);
    assert.equal(clusters.length, 1, "must produce exactly one cluster for three duplicates");
    assert.equal(clusters[0].length, 3);
  });

  it("returns empty array when all entries are singletons (no duplicates)", () => {
    const ledger = [
      makeOpen("d1", "Fix the orchestrator dispatch retry logic issue"),
      makeOpen("d2", "Add circuit breaker for model calls in provider layer"),
    ];
    const clusters = clusterDuplicateDebts(ledger);
    assert.deepEqual(clusters, [], "no duplicates → empty clusters");
  });

  it("ignores closed entries when clustering", () => {
    const lesson = "Fix the governance canary breach detection false negative path";
    const ledger = [
      makeOpen("d1", lesson, 1),
      { ...makeOpen("d2", lesson, 2), closedAt: "2025-01-01T00:00:00Z" }, // already closed
    ];
    // Only 1 open copy → not a duplicate cluster
    const clusters = clusterDuplicateDebts(ledger);
    assert.deepEqual(clusters, [], "closed entries must not be counted as duplicates");
  });

  it("handles empty ledger gracefully", () => {
    assert.deepEqual(clusterDuplicateDebts([]), []);
  });

  it("returns multiple clusters when there are multiple duplicate groups", () => {
    const lesson1 = "Fix the worker batch planner wave ordering contract breach";
    const lesson2 = "Resolve the carry-forward SLA accounting cycle counter bug";
    const ledger = [
      makeOpen("a1", lesson1, 1),
      makeOpen("a2", lesson1, 2),
      makeOpen("b1", lesson2, 1),
      makeOpen("b2", lesson2, 2),
    ];
    const clusters = clusterDuplicateDebts(ledger);
    assert.equal(clusters.length, 2, "must produce two separate clusters");
  });
});

// ── compressLedger ────────────────────────────────────────────────────────────

describe("compressLedger (Task 2)", () => {
  function makeOpen(id: string, lesson: string, openedCycle = 1): any {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle,
      dueCycle: openedCycle + 3,
      severity: "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  it("retires duplicate entries keeping the oldest canonical, returns correct counts", () => {
    const lesson = "Fix the worker runner retry loop transient error handling gap";
    const ledger = [
      makeOpen("debt-1", lesson, 1), // oldest → canonical
      makeOpen("debt-2", lesson, 2),
      makeOpen("debt-3", lesson, 3),
    ];
    const result = compressLedger(ledger);
    assert.equal(result.compressedCount, 2, "two duplicates must be retired");
    assert.equal(result.clustersProcessed, 1);
    assert.equal(result.retirementIds.length, 2);
    assert.ok(!result.retirementIds.includes("debt-1"), "canonical entry must not be retired");

    // Canonical remains open
    const canonical = ledger.find(e => e.id === "debt-1");
    assert.equal(canonical!.closedAt, null, "canonical must remain open");

    // Duplicates are closed with retirement evidence
    const retired = ledger.filter(e => e.id !== "debt-1");
    for (const r of retired) {
      assert.ok(r.closedAt, "retired entries must be closed");
      assert.ok(r.closureEvidence?.includes("retired-by-compression"),
        "closureEvidence must contain retirement marker");
      assert.ok(r.closureEvidence?.includes("debt-1"),
        "closureEvidence must reference canonical id");
    }
  });

  it("returns compressedCount=0 when there are no duplicates", () => {
    const ledger = [
      makeOpen("d1", "Fix the orchestrator dispatch retry logic"),
      makeOpen("d2", "Add circuit breaker for model calls in provider"),
    ];
    const result = compressLedger(ledger);
    assert.equal(result.compressedCount, 0);
    assert.equal(result.clustersProcessed, 0);
    assert.deepEqual(result.retirementIds, []);
  });

  it("returns zeros for empty ledger", () => {
    const result = compressLedger([]);
    assert.equal(result.compressedCount, 0);
    assert.equal(result.clustersProcessed, 0);
    assert.deepEqual(result.retirementIds, []);
  });

  it("is idempotent — running twice produces same result", () => {
    const lesson = "Fix the governance canary breach detection false negative evaluation path";
    const ledger = [
      makeOpen("d1", lesson, 1),
      makeOpen("d2", lesson, 2),
      makeOpen("d3", lesson, 3),
    ];
    const first = compressLedger(ledger);
    assert.equal(first.compressedCount, 2);

    // Second run — duplicates already closed → no new retirements
    const second = compressLedger(ledger);
    assert.equal(second.compressedCount, 0, "second compression run must retire nothing new");
  });

  it("negative path: only one open entry per fingerprint is not compressed", () => {
    const lesson = "Fix something important in the carry forward pipeline accounting";
    const ledger = [
      makeOpen("d1", lesson, 1),
      { ...makeOpen("d2", lesson, 2), closedAt: "2025-01-01T00:00:00Z" }, // already closed
    ];
    const result = compressLedger(ledger);
    assert.equal(result.compressedCount, 0, "single open entry must not be compressed");
    assert.equal(ledger[0].closedAt, null, "only open entry must remain open");
  });
});

// ── compressLedger — recurrence metadata ─────────────────────────────────────

describe("compressLedger — recurrence metadata", () => {
  function makeOpen(id: string, lesson: string, openedCycle = 1): any {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle,
      dueCycle: openedCycle + 3,
      severity: "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  it("stamps recurrenceCount equal to cluster size on canonical entry", () => {
    const lesson = "Fix the worker runner retry loop transient error handling gap";
    const ledger = [
      makeOpen("d1", lesson, 1),
      makeOpen("d2", lesson, 3),
      makeOpen("d3", lesson, 5),
    ];
    compressLedger(ledger);
    const canonical = ledger.find(e => e.id === "d1")!;
    assert.equal(canonical.recurrenceCount, 3, "recurrenceCount must equal cluster size");
  });

  it("stamps firstSeenCycle as minimum openedCycle across the cluster", () => {
    const lesson = "Fix the governance canary breach detection false negative eval path";
    const ledger = [
      makeOpen("d1", lesson, 4),
      makeOpen("d2", lesson, 2), // earliest — but not first in array
      makeOpen("d3", lesson, 6),
    ];
    compressLedger(ledger);
    // Canonical is the one with lowest openedCycle (d2, cycle=2)
    const canonical = ledger.find(e => e.closedAt === null)!;
    assert.equal(canonical.firstSeenCycle, 2, "firstSeenCycle must be the minimum openedCycle");
  });

  it("stamps lastRecurredCycle as maximum openedCycle across the cluster", () => {
    const lesson = "Resolve the carry-forward SLA accounting ledger cycle counter gap";
    const ledger = [
      makeOpen("d1", lesson, 1),
      makeOpen("d2", lesson, 7),
      makeOpen("d3", lesson, 4),
    ];
    compressLedger(ledger);
    const canonical = ledger.find(e => e.closedAt === null)!;
    assert.equal(canonical.lastRecurredCycle, 7, "lastRecurredCycle must be the maximum openedCycle");
  });

  it("retirement evidence includes canonical lesson text (strict linkage)", () => {
    const lesson = "Fix the worker batch planner wave ordering strict contract breach gap";
    const ledger = [
      makeOpen("d1", lesson, 1),
      makeOpen("d2", lesson, 2),
    ];
    compressLedger(ledger);
    const retired = ledger.find(e => e.id === "d2")!;
    assert.ok(retired.closureEvidence, "retired entry must have closureEvidence");
    assert.ok(
      retired.closureEvidence.includes("canonical-lesson="),
      "closureEvidence must contain canonical-lesson field"
    );
    assert.ok(
      retired.closureEvidence.includes(lesson.slice(0, 50)),
      "closureEvidence must embed canonical lesson text for traceable linkage"
    );
  });

  it("retirement evidence includes recurrence-count, first-seen-cycle, last-recurred-cycle", () => {
    const lesson = "Resolve the orchestrator dispatch retry logic gap in carry-forward";
    const ledger = [
      makeOpen("d1", lesson, 2),
      makeOpen("d2", lesson, 5),
      makeOpen("d3", lesson, 8),
    ];
    compressLedger(ledger);
    for (const retired of ledger.filter(e => e.closedAt)) {
      assert.ok(retired.closureEvidence.includes("recurrence-count=3"), "must include recurrence-count");
      assert.ok(retired.closureEvidence.includes("first-seen-cycle=2"), "must include first-seen-cycle");
      assert.ok(retired.closureEvidence.includes("last-recurred-cycle=8"), "must include last-recurred-cycle");
    }
  });

  it("preserves higher recurrenceCount already set by addDebtEntries on the canonical entry", () => {
    const lesson = "Fix the pipeline progress gate evaluation timing reliability gap";
    const ledger = [
      { ...makeOpen("d1", lesson, 1), recurrenceCount: 5 }, // pre-bumped via addDebtEntries
      makeOpen("d2", lesson, 2),
    ];
    compressLedger(ledger);
    const canonical = ledger.find(e => e.closedAt === null)!;
    // cluster size = 2, but recurrenceCount was already 5 — must keep the higher value
    assert.ok(
      canonical.recurrenceCount >= 5,
      "compressLedger must not downgrade recurrenceCount already accumulated"
    );
  });

  it("negative path: singleton cluster does not receive recurrence metadata", () => {
    const lesson = "Fix the pipeline progress gate evaluation timing reliability path";
    const ledger = [makeOpen("d1", lesson, 1)];
    compressLedger(ledger);
    const entry = ledger[0];
    assert.equal(entry.recurrenceCount, undefined, "singleton must not receive recurrenceCount");
    assert.equal(entry.firstSeenCycle, undefined, "singleton must not receive firstSeenCycle");
  });
});

// ── addDebtEntries — recurrence count increment ───────────────────────────────

describe("addDebtEntries — recurrenceCount tracking", () => {
  it("new entry is created with recurrenceCount=1", () => {
    const result = addDebtEntries([], [
      { followUpTask: "Fix flaky test in worker runner module reliability", workerName: "evolution-worker" },
    ], 5);
    assert.equal(result.length, 1);
    assert.equal(result[0].recurrenceCount, 1);
  });

  it("duplicate recurrence increments recurrenceCount on the canonical open entry", () => {
    const lesson = "Fix the orchestrator dispatch retry loop transient error gap";
    const existing = addDebtEntries([], [{ followUpTask: lesson }], 1);
    assert.equal(existing[0].recurrenceCount, 1);

    // Same lesson re-submitted in cycle 3
    const updated = addDebtEntries(existing, [{ followUpTask: lesson }], 3);
    assert.equal(updated.length, 1, "no new entry should be added");
    assert.equal(updated[0].recurrenceCount, 2, "recurrenceCount must be incremented");
    assert.equal(updated[0].lastRecurredCycle, 3, "lastRecurredCycle must track latest occurrence");
  });

  it("multiple duplicate recurrences accumulate correctly", () => {
    const lesson = "Fix the governance freeze gate risk level evaluation gap";
    let ledger = addDebtEntries([], [{ followUpTask: lesson }], 1);
    ledger = addDebtEntries(ledger, [{ followUpTask: lesson }], 2);
    ledger = addDebtEntries(ledger, [{ followUpTask: lesson }], 3);
    assert.equal(ledger.length, 1, "still only one entry after three occurrences");
    assert.equal(ledger[0].recurrenceCount, 3);
    assert.equal(ledger[0].lastRecurredCycle, 3);
  });

  it("negative path: closed entry is not treated as a canonical for deduplication", () => {
    const lesson = "Fix the carry-forward SLA accounting cycle counter bug in ledger";
    const closedEntry = {
      id: "debt-1-0",
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "w",
      openedCycle: 1,
      dueCycle: 4,
      severity: "warning",
      closedAt: "2025-01-01T00:00:00Z",
      closureEvidence: "fixed",
      cyclesOpen: 3,
      recurrenceCount: 1,
    };
    // Since the only matching entry is closed, a new open entry must be created.
    const result = addDebtEntries([closedEntry], [{ followUpTask: lesson }], 5);
    assert.equal(result.length, 2, "new open entry must be created when canonical is closed");
    const newEntry = result.find(e => !e.closedAt)!;
    assert.equal(newEntry.recurrenceCount, 1, "new entry starts at recurrenceCount=1");
  });
});


// ── classifyCarryForwardByRecurrence — prompt bulk reduction ─────────────────

describe("classifyCarryForwardByRecurrence — recurrence classification", () => {
  function makePending(task: string) {
    return { followUpNeeded: true, followUpTask: task, workerName: "worker", reviewedAt: "2025-01-01" };
  }

  it("returns empty buckets for empty input", () => {
    const { highRecurrence, lowRecurrence } = classifyCarryForwardByRecurrence([], [], {});
    assert.deepEqual(highRecurrence, []);
    assert.deepEqual(lowRecurrence, []);
  });

  it("classifies items with >= threshold occurrences as high-recurrence", () => {
    const task = "Fix flaky test in worker runner";
    const pending = [makePending(task)];
    // Simulate 3 postmortem entries mentioning the same task
    const all = [
      { followUpTask: task }, { followUpTask: task }, { followUpTask: task },
    ];
    const { highRecurrence, lowRecurrence } = classifyCarryForwardByRecurrence(pending, all, { recurrenceThreshold: 3 });
    assert.equal(highRecurrence.length, 1, "item appearing 3 times must be high-recurrence");
    assert.equal(lowRecurrence.length, 0);
    assert.equal(highRecurrence[0]._recurrenceCount, 3);
  });

  it("classifies items with fewer than threshold occurrences as low-recurrence", () => {
    const task = "Add circuit breaker for model calls";
    const pending = [makePending(task)];
    const all = [{ followUpTask: task }, { followUpTask: task }];
    const { highRecurrence, lowRecurrence } = classifyCarryForwardByRecurrence(pending, all, { recurrenceThreshold: 3 });
    assert.equal(lowRecurrence.length, 1, "item appearing 2 times must be low-recurrence (below threshold 3)");
    assert.equal(highRecurrence.length, 0);
  });

  it("mixes high and low recurrence items correctly", () => {
    const highTask = "Recurring critical issue";
    const lowTask = "One-off follow-up";
    const pending = [makePending(highTask), makePending(lowTask)];
    const all = [
      { followUpTask: highTask }, { followUpTask: highTask }, { followUpTask: highTask },
      { followUpTask: lowTask },
    ];
    const result = classifyCarryForwardByRecurrence(pending, all, { recurrenceThreshold: 3 });
    assert.equal(result.highRecurrence.length, 1);
    assert.equal(result.lowRecurrence.length, 1);
    assert.equal(result.highRecurrence[0].followUpTask, highTask);
    assert.equal(result.lowRecurrence[0].followUpTask, lowTask);
  });

  it("defaults to recurrenceThreshold=3 when opts not provided", () => {
    const task = "Recurring item";
    const pending = [makePending(task)];
    const all = [{ followUpTask: task }, { followUpTask: task }, { followUpTask: task }];
    const { highRecurrence } = classifyCarryForwardByRecurrence(pending, all);
    assert.equal(highRecurrence.length, 1, "default threshold of 3 must work");
  });

  it("handles null/undefined inputs gracefully without throwing", () => {
    const result = classifyCarryForwardByRecurrence(null as any, null as any, {});
    assert.deepEqual(result.highRecurrence, []);
    assert.deepEqual(result.lowRecurrence, []);
  });

  it("negative path: item with no history is classified as low-recurrence", () => {
    const pending = [makePending("Brand new task with no history")];
    const { highRecurrence, lowRecurrence } = classifyCarryForwardByRecurrence(pending, [], { recurrenceThreshold: 3 });
    assert.equal(lowRecurrence.length, 1, "item with no history is low-recurrence");
    assert.equal(highRecurrence.length, 0);
  });

  it("negative path: duplicate-suppressed history entries do not inflate recurrence", () => {
    const task = "Fix duplicate suppression drift";
    const pending = [{ followUpTask: task }];
    const all = [
      { followUpTask: task, interventionDuplicateSuppressed: true },
      { followUpTask: task, interventionDuplicateSuppressed: false },
    ];
    const result = classifyCarryForwardByRecurrence(pending, all, { recurrenceThreshold: 2 });
    assert.equal(result.highRecurrence.length, 0);
    assert.equal(result.lowRecurrence.length, 1);
    assert.equal((result.lowRecurrence[0] as any)._recurrenceCount, 1);
  });
});

describe("CI-class retirement contract", () => {
  function makeCiDebt(lesson: string, id = "ci-debt-1"): any {
    return {
      id,
      lesson,
      fingerprint: computeFingerprint(lesson),
      owner: "evolution-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
  }

  it("does not auto-close CI-class debt on replay-only evidence", () => {
    const lesson = "Fix CI workflow dispatch flake on main branch";
    const ledger = [makeCiDebt(lesson)];

    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: {
        workerContract: {
          passed: true,
          prUrl: "https://github.com/owner/repo/pull/42",
          artifactDetail: {
            hasSha: true,
            hasTestOutput: true,
            hasCleanTreeEvidence: true,
            hasUnfilledPlaceholder: false,
          },
        },
        replayClosure: {
          contractSatisfied: true,
          executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
          rawArtifactEvidenceLinks: [
            "inline://post-merge-sha/abc1234",
            "inline://clean-tree-status",
            "inline://npm-test-output-block",
          ],
        },
      },
    }]);

    assert.equal(count, 0);
    assert.equal(ledger[0].closedAt, null);
  });

  it("auto-closes CI-class debt only when merged PR and associated main CI success on main are present", () => {
    const lesson = "Fix CI workflow dispatch flake on main branch";
    const ledger = [makeCiDebt(lesson)];

    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: makeCiReplayContractEvidence(),
    }]);

    assert.equal(count, 1);
    assert.ok(ledger[0].closedAt);
    assert.match(String(ledger[0].closureEvidence || ""), /merged-pr-url=https:\/\/github\.com\/owner\/repo\/pull\/42/);
    assert.match(String(ledger[0].closureEvidence || ""), /main-ci-conclusion=success/);
    assert.equal(ledger[0].mergedPrUrl, "https://github.com/owner/repo/pull/42");
    assert.equal(ledger[0].associatedMainCiConclusion, "success");
    assert.equal(ledger[0].associatedMainCiBranch, "main");
    assert.equal(ledger[0].associatedMainCiRunUrl, "https://github.com/owner/repo/actions/runs/4242");
  });

  it("does not auto-close CI-class debt when the associated CI success lacks a main-run URL", () => {
    const lesson = "Fix CI workflow dispatch flake on main branch";
    const ledger = [makeCiDebt(lesson)];

    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: makeCiReplayContractEvidence({
        workerContract: {
          passed: true,
          prUrl: "https://github.com/owner/repo/pull/42",
          associatedMainCiConclusion: "success",
          associatedMainCiBranch: "main",
          associatedMainCiHeadSha: "abc1234",
          artifactDetail: {
            hasSha: true,
            hasTestOutput: true,
            hasCleanTreeEvidence: true,
            hasUnfilledPlaceholder: false,
          },
        },
        replayClosure: {
          contractSatisfied: true,
          executedCommands: ["git rev-parse HEAD", "git status --porcelain", "npm test"],
          rawArtifactEvidenceLinks: [
            "inline://post-merge-sha/abc1234",
            "inline://clean-tree-status",
            "inline://npm-test-output-block",
          ],
        },
      }),
    }]);

    assert.equal(count, 0);
    assert.equal(ledger[0].closedAt, null);
  });

  it("does not auto-close CI-class debt when the associated CI run is not on main", () => {
    const lesson = "Fix CI workflow dispatch flake on main branch";
    const ledger = [makeCiDebt(lesson)];

    const count = autoCloseVerifiedDebt(ledger, [{
      taskText: lesson,
      verificationEvidence: makeCiReplayContractEvidence({
        workerContract: {
          passed: true,
          prUrl: "https://github.com/owner/repo/pull/42",
          associatedMainCiConclusion: "success",
          associatedMainCiBranch: "feature/retry-fix",
          associatedMainCiRunUrl: "https://github.com/owner/repo/actions/runs/4242",
          associatedMainCiHeadSha: "abc1234",
          artifactDetail: {
            hasSha: true,
            hasTestOutput: true,
            hasCleanTreeEvidence: true,
            hasUnfilledPlaceholder: false,
          },
        },
      }),
    }]);

    assert.equal(count, 0);
    assert.equal(ledger[0].closedAt, null);
  });

  it("keeps CI-class carry-forward items on the hot shortlist until ledger retirement is CI-backed", () => {
    const pending = [{ followUpNeeded: true, followUpTask: "Fix CI workflow dispatch flake on main branch" }];
    const replayOnlyLedger = [{
      id: "d1",
      lesson: "Fix CI workflow dispatch flake on main branch",
      closedAt: "2026-04-01T00:00:00Z",
      closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block]",
    }];
    const qualifiedLedger = [{
      ...replayOnlyLedger[0],
      mergedPrUrl: "https://github.com/owner/repo/pull/42",
      associatedMainCiConclusion: "success",
      associatedMainCiBranch: "main",
      associatedMainCiRunUrl: "https://github.com/owner/repo/actions/runs/4242",
      closureEvidence: `${replayOnlyLedger[0].closureEvidence} merged-pr-url=https://github.com/owner/repo/pull/42 main-ci-conclusion=success main-ci-branch=main main-ci-run-url=https://github.com/owner/repo/actions/runs/4242`,
    }];

    const replayOnlyResult = filterResolvedCarryForwardItems(pending, replayOnlyLedger, ["Fix CI workflow dispatch flake on main branch"]);
    const qualifiedResult = filterResolvedCarryForwardItems(pending, qualifiedLedger, ["Fix CI workflow dispatch flake on main branch"]);

    assert.equal(replayOnlyResult.length, 1, "replay-only CI evidence must not retire shortlist entries");
    assert.equal(qualifiedResult.length, 0, "CI-backed retirement evidence must retire shortlist entries");
  });

  it("keeps replay-only CI closures ranked as unresolved until CI-backed retirement exists", () => {
    const replayOnly = buildRankedLessonShortlists([{
      followUpTask: "Fix CI workflow dispatch flake on main branch",
      reviewedAt: "2026-04-01T00:00:00Z",
      followUpNeeded: false,
      closedAt: "2026-04-02T00:00:00Z",
      closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block]",
      severity: "critical",
    }], { limit: 10 });
    const qualified = buildRankedLessonShortlists([{
      followUpTask: "Fix CI workflow dispatch flake on main branch",
      reviewedAt: "2026-04-01T00:00:00Z",
      followUpNeeded: false,
      closedAt: "2026-04-02T00:00:00Z",
      mergedPrUrl: "https://github.com/owner/repo/pull/42",
      associatedMainCiConclusion: "success",
      associatedMainCiBranch: "main",
      associatedMainCiRunUrl: "https://github.com/owner/repo/actions/runs/4242",
      closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block] merged-pr-url=https://github.com/owner/repo/pull/42 main-ci-conclusion=success main-ci-branch=main main-ci-run-url=https://github.com/owner/repo/actions/runs/4242",
      severity: "critical",
    }], { limit: 10 });

    assert.equal(replayOnly.unresolvedTop10.length, 1);
    assert.equal(qualified.unresolvedTop10.length, 0);
  });

  it("keeps CI urgency elevated when a replay-only CI closure is still missing associated main-CI evidence", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "ci-urgency-retirement-"));

    try {
      await fs.writeFile(
        path.join(stateDir, "carry_forward_ledger.json"),
        JSON.stringify({
          cycleCounter: 1,
          entries: [{
            id: "ci-debt-1",
            lesson: "Fix CI workflow dispatch flake on main branch",
            closedAt: "2026-04-02T00:00:00Z",
            closureEvidence: "replay-closure:v1 commands=[git rev-parse HEAD, git status --porcelain, npm test] links=[inline://post-merge-sha/abc1234, inline://clean-tree-status, inline://npm-test-output-block]",
          }],
        }),
        "utf8",
      );

      const result = await buildCiUrgencyContext({ paths: { stateDir } }, stateDir);

      assert.equal(result.allowHistoricalPressure, true);
      assert.match(String(result.note || ""), /still unresolved/i);
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });
});
