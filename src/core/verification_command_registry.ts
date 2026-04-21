/**
 * verification_command_registry.js — Single source of truth for verification commands.
 *
 * All verification commands used across the system (CI, worker dispatch, tests)
 * are defined here. No other file should hardcode verification command strings.
 *
 * Usage:
 *   import { getVerificationCommands } from "./verification_command_registry.js";
 *   const cmds = getVerificationCommands(config);
 */

/**
 * Default verification commands.
 * These are used when box.config.json does not override them.
 */
const DEFAULTS = Object.freeze({
  /** Primary test command — must match package.json "test" script. */
  test: "npm test",
  /** Lint command. */
  lint: "npm run lint",
  /** Build command (optional — some projects don't have a build step). */
  build: "npm run build",
});

/**
 * Get the canonical verification commands for the current project.
 * Reads overrides from config.verificationCommands if provided.
 *
 * @param {object} [config]
 * @returns {{ test: string, lint: string, build: string }}
 */
export function getVerificationCommands(config) {
  const overrides = config?.verificationCommands || {};
  return {
    test: overrides.test || DEFAULTS.test,
    lint: overrides.lint || DEFAULTS.lint,
    build: overrides.build || DEFAULTS.build,
  };
}

/**
 * Get the test command specifically — most commonly needed.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function getTestCommand(config) {
  return getVerificationCommands(config).test;
}

/**
 * All default commands exported for tests.
 */
export { DEFAULTS as VERIFICATION_DEFAULTS };

/**
 * Generic verification commands that do not prove an exact test target.
 *
 * These commands may be executable and portable, but they are too broad to
 * serve as deterministic completion evidence for merge-oriented work. A worker
 * asked to satisfy an exact verification proof must reference a concrete test
 * file (and optionally a named test description), not just a bare runner.
 */
export const NON_SPECIFIC_VERIFICATION_PATTERNS = Object.freeze([
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|$)/i,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|$)/i,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|$)/i,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check(?:\s|$)/i,
  /^node\s+--test(?:\s|$)/i,
  /^(?:npx\s+)?(?:vitest|jest|mocha|ava)(?:\s+(?:run|test))?(?:\s|$)/i,
  /^run\s+(?:test|check)(?:\s|$)/i,
]);

const EXACT_TEST_FILE_PATTERN =
  /(?:^|[\s"'`])(?:tests?[/\\][^\s"'`*?]+\.(?:test|spec)\.[cm]?[jt]sx?|[^\s"'`*?]+\.(?:test|spec)\.[cm]?[jt]sx?)(?:$|[\s"'`])/i;

const NAMED_TEST_PROOF_TARGET_PATTERN =
  /^(tests\/[^\s—–-]+(?:\.test\.[cm]?[jt]sx?|\.spec\.[cm]?[jt]sx?))\s*(?:[—–-]+\s*(?:test:|it:|describe:|should\s)?(.+))?$/i;

/**
 * Returns true when a verification command is too broad to prove an exact
 * verification target for merge-oriented work.
 *
 * Specific test file references (for example `tests/core/foo.test.ts`) are
 * treated as exact proof targets and therefore return false.
 *
 * @param {string} command — verification command or proof text
 * @returns {boolean} true when the command is executable but non-specific
 */
export function isNonSpecificVerificationCommand(command: string): boolean {
  const text = String(command || "").trim();
  if (!text) return false;
  if (EXACT_TEST_FILE_PATTERN.test(text)) return false;
  if (NAMED_TEST_PROOF_TARGET_PATTERN.test(text)) return false;
  if (/--testNamePattern\s*=\s*['"][^'"]{4,}['"]/i.test(text)) return false;
  return NON_SPECIFIC_VERIFICATION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Forbidden verification command patterns (Packet 4).
 * These patterns are known to fail on Windows (glob non-expansion) or
 * waste premium requests. Plans containing these must be rejected.
 *
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
export const FORBIDDEN_VERIFICATION_PATTERNS = Object.freeze([
  {
    pattern: /node\s+--test\s+tests\/?\*\*/i,
    reason: "Glob patterns are not expanded on Windows — use 'npm test' instead"
  },
  {
    pattern: /node\s+--test\s+[^\s]*\*/i,
    reason: "Wildcard glob in node --test fails on Windows — use 'npm test' instead"
  },
  {
    pattern: /^bash\s+/i,
    reason: "bash is not available on Windows — use 'npm test' instead"
  },
  {
    pattern: /^sh\s+/i,
    reason: "sh is not available on Windows — use 'npm test' instead"
  },
  {
    pattern: /^npx\s+tsx\s+[^\s]*\*/i,
    reason: "Glob patterns via npx tsx are not expanded on Windows — use 'npm test' instead"
  },
  {
    pattern: /^ts-node\s+[^\s]*\*/i,
    reason: "Glob patterns via ts-node are not expanded on Windows — use 'npm test' instead"
  },
]);

/**
 * Rewrite rules for non-portable or unsafe verification commands.
 * Applied before worker dispatch — converts problematic patterns to
 * their canonical, portable equivalents.
 *
 * Covers:
 *   - Shell-glob node --test invocations (fail on Windows)
 *   - Bash/sh script invocations (not available on Windows)
 *   - BOX daemon/start commands (would wake the full agent stack)
 *
 * @type {ReadonlyArray<{ match: RegExp; replacement: string }>}
 */
export const VERIFICATION_CMD_REWRITE_RULES: ReadonlyArray<{ match: RegExp; replacement: string }> = Object.freeze([
  // Shell-glob patterns: not expanded on Windows — rewrite to portable test runner
  { match: /node\s+--test\s+[^\s]*\*/i, replacement: DEFAULTS.test },
  // Bash/sh scripts are not available on Windows
  { match: /^bash\s+/i, replacement: DEFAULTS.test },
  { match: /^sh\s+/i, replacement: DEFAULTS.test },
  // npx tsx / ts-node with glob patterns — not expanded on Windows
  { match: /^npx\s+tsx\s+[^\s]*\*/i, replacement: DEFAULTS.test },
  { match: /^ts-node\s+[^\s]*\*/i, replacement: DEFAULTS.test },
  // BOX daemon/start commands that would launch the full agent stack
  { match: /^node\s+src\/cli\.js\s+once$/i, replacement: DEFAULTS.test },
  { match: /^npm\s+run\s+box:once$/i, replacement: DEFAULTS.test },
  { match: /^node\s+src\/cli\.js\s+start$/i, replacement: DEFAULTS.test },
  { match: /^node\s+src\/cli\.js\s+doctor$/i, replacement: DEFAULTS.test },
  // Dashboard is a daemon — rewrite to canonical test runner
  { match: /^node\s+src\/dashboard\/live_dashboard\.js$/i, replacement: DEFAULTS.test },
]);

/**
 * Rewrite a single verification command to its canonical, portable equivalent.
 * Returns the command unchanged when no rewrite rule matches.
 *
 * @param {string} cmd — raw verification command
 * @returns {string} canonical command safe to run on all platforms
 */
export function rewriteVerificationCommand(cmd: string): string {
  let text = String(cmd || "").trim();
  // Strip non-portable shell pipe tails (e.g. `2>&1 | grep -E '...'`).
  // These are bash-only constructs and are silently dropped on Windows workers.
  // The leading test command is preserved as-is for dispatch.
  text = text.replace(/\s+2>&1\s*\|.*$/i, "").replace(/\s+\|\s*grep\b.*$/i, "").trim();
  const rule = VERIFICATION_CMD_REWRITE_RULES.find(r => r.match.test(text));
  return rule ? rule.replacement : text;
}

/**
 * Normalize an array of verification commands by applying all rewrite rules to each.
 * This is the canonical batch entry point — all callers that need to sanitize a
 * plan's verification_commands before dispatch should use this.
 *
 * Deduplicates and filters empty strings so the result is a minimal, portable
 * command list ready for worker dispatch.
 *
 * @param {string[]} commands — raw verification command strings
 * @returns {string[]} canonical, portable, deduped command list
 */
export function normalizeCommandBatch(commands: string[]): string[] {
  if (!Array.isArray(commands)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cmd of commands) {
    const rewritten = rewriteVerificationCommand(String(cmd || "").trim());
    if (rewritten && !seen.has(rewritten)) {
      seen.add(rewritten);
      result.push(rewritten);
    }
  }
  return result;
}

/**
 * Check if a verification command string contains forbidden patterns.
 *
 * @param {string} command — verification command string
 * @returns {{ forbidden: boolean, violations: Array<{ matched: string, reason: string }> }}
 */
export function checkForbiddenCommands(command) {
  const text = String(command || "").trim();
  const violations = [];
  for (const { pattern, reason } of FORBIDDEN_VERIFICATION_PATTERNS) {
    if (pattern.test(text)) {
      violations.push({ matched: pattern.source, reason });
    }
  }
  return { forbidden: violations.length > 0, violations };
}

export const WINDOWS_NODE_TEST_GLOB_ARTIFACT_CODE = "WINDOWS_NODE_TEST_GLOB_ARTIFACT";

export function classifyNodeTestGlobWindowsArtifact(output: string): {
  isArtifact: boolean;
  hasNpmTestPassEvidence: boolean;
  code: string | null;
} {
  const text = String(output || "");
  const hasNodeGlobInvocation = /node\s+--test\s+[^\r\n]*\*/i.test(text) || /tests\/\*\*/i.test(text);
  const hasWindowsGlobFailure =
    /glob patterns? (?:are )?not expanded on windows/i.test(text)
    || /could not find ['"]?tests\/\*\*/i.test(text)
    || /cannot find module .*tests\/\*\*/i.test(text)
    || /no files match(?:ed)?(?: the)? pattern/i.test(text);
  const hasNpmTestPassEvidence =
    /npm\s+test/i.test(text)
    && (
      /all tests? passed/i.test(text)
      || /\b\d+\s+passing\b/i.test(text)
      || /#\s*pass\s+\d+/i.test(text)
      || /\bok\s+\d+\b/i.test(text)
    );
  const isArtifact = hasNodeGlobInvocation && hasWindowsGlobFailure;
  return {
    isArtifact,
    hasNpmTestPassEvidence,
    code: isArtifact ? WINDOWS_NODE_TEST_GLOB_ARTIFACT_CODE : null,
  };
}

// ── Dispatch command validation gate (Task 3) ─────────────────────────────────

/**
 * A single rewrite applied during dispatch command validation.
 *
 * @property original  — the raw command before rewriting
 * @property rewritten — the canonical command after rewriting
 * @property reason    — human-readable description of why the rewrite was applied
 */
export interface DispatchCommandRewrite {
  original: string;
  rewritten: string;
  reason: string;
}

/**
 * Result of validateDispatchCommands().
 *
 * @property safe             — true when all commands were already canonical (no rewrites applied)
 * @property sanitizedCommands — commands after applying all rewrite rules (deduplicated, non-empty)
 * @property rewrites          — list of rewrites applied; empty when safe=true
 */
export interface DispatchCommandValidationResult {
  safe: boolean;
  sanitizedCommands: string[];
  rewrites: DispatchCommandRewrite[];
}

/**
 * Validate and rewrite a list of verification commands before worker dispatch.
 *
 * This is the canonical dispatch-time gate. It applies all rewrite rules,
 * collects an audit trail of every substitution made, deduplicates, and
 * signals whether any command needed rewriting.
 *
 * Callers that assemble a task brief for worker dispatch should call this
 * function and use sanitizedCommands in the outgoing task payload. If
 * rewrites is non-empty, the caller should log the changes for observability.
 *
 * @param {string[]} commands — raw verification command strings from the task plan
 * @returns {DispatchCommandValidationResult}
 */
export function validateDispatchCommands(commands: string[]): DispatchCommandValidationResult {
  if (!Array.isArray(commands)) {
    return { safe: true, sanitizedCommands: [], rewrites: [] };
  }

  const rewrites: DispatchCommandRewrite[] = [];
  const seen = new Set<string>();
  const sanitizedCommands: string[] = [];

  for (const rawCmd of commands) {
    const original = String(rawCmd || "").trim();
    if (!original) continue;

    const rewritten = rewriteVerificationCommand(original);

    if (rewritten !== original) {
      // Determine human-readable reason from the matching rewrite rule
      const matchedRule = VERIFICATION_CMD_REWRITE_RULES.find(r => r.match.test(original));
      const reason = matchedRule
        ? `Rewritten to portable equivalent: "${matchedRule.replacement}" (matched pattern: ${matchedRule.match.source})`
        : `Non-portable command rewritten to "${rewritten}"`;
      rewrites.push({ original, rewritten, reason });
    }

    if (rewritten && !seen.has(rewritten)) {
      seen.add(rewritten);
      sanitizedCommands.push(rewritten);
    }
  }

  return {
    safe: rewrites.length === 0,
    sanitizedCommands,
    rewrites,
  };
}
