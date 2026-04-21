import fs from "node:fs/promises";
import path from "node:path";

// Only match backtick-quoted paths that start with known repo-local prefixes.
// This prevents false positives from absolute paths or environment-specific paths.
// Handles:
//   - Standard extension files: src/core/orchestrator.ts
//   - .Dockerfile extension:    docker/worker.Dockerfile
//   - Bare Dockerfile filename: docker/worker/Dockerfile
const REPO_LOCAL_PATH_RE =
  /`((?:src|tests|docker|scripts|\.github)\/(?:[^`\s,)/]*\/)*(?:[^`\s,)]+\.(?:ts|js|cjs|mjs|json|yml|yaml|md|ps1|sh|Dockerfile)|Dockerfile))`/g;

// Matches TypeScript/JS import alias references in backtick-quoted paths.
// Handles aliases like @core/foo.ts, @/bar.ts, ~/baz.ts
const ALIAS_PATH_RE =
  /`((?:@core|@tests|@scripts|@\/)\/(?:[^`\s,)/]*\/)*(?:[^`\s,)]+\.(?:ts|js|cjs|mjs|json|yml|yaml|md)))`/g;

// Known TS/JS alias mappings → repo-local prefix
const ALIAS_MAP: Record<string, string> = {
  "@core/":    "src/core/",
  "@tests/":   "tests/",
  "@scripts/": "scripts/",
  "@/":        "src/",
  "~/":        "src/",
};

const DOC_EXTENSIONS = new Set([".md"]);

/**
 * Deprecated terminology patterns.
 * Docs containing these tokens may reference removed or renamed APIs.
 * Each entry has a pattern and a human-readable replacement hint.
 */
export const DEPRECATED_TOKENS: Array<{ pattern: RegExp; hint: string }> = [
  // Governance terminology superseded by governance_contract / governance_freeze
  { pattern: /\bgovernance_verdict\b/g,            hint: "use governance_contract decision fields" },
  { pattern: /\bgovernance_review_started\b/g,     hint: "use GOVERNANCE_GATE_EVALUATED event" },
  { pattern: /\bgovernance_review_completed\b/g,   hint: "use GOVERNANCE_GATE_EVALUATED event" },
  { pattern: /\bgovernance_signal\b/g,             hint: "use GOVERNANCE_GATE_EVALUATED or governance_canary events" },
  // Event terminology: pre-v1 box event names
  { pattern: /\bbox\.v0\.[a-z]+\.[a-zA-Z]+/g,     hint: "use current box.v1.* event names" },
  { pattern: /\bPLAN_STARTED\b/g,                  hint: "use PLANNING_ANALYSIS_STARTED" },
  { pattern: /\bCYCLE_STARTED\b/g,                 hint: "use ORCHESTRATION_CYCLE_STARTED" },
  { pattern: /\bWORKER_STARTED\b/g,                hint: "use PLANNING_TASK_DISPATCHED" },
  { pattern: /\bWORKER_COMPLETED\b/g,              hint: "use VERIFICATION_WORKER_DONE" },
  // Resume/dispatch terminology superseded by runResumeDispatch / dispatch_checkpoint
  { pattern: /\bresume_workers\b/g,                hint: "use runResumeDispatch / dispatch_checkpoint" },
  { pattern: /\bresumeWorkers\b/g,                 hint: "use runResumeDispatch" },
  { pattern: /\bresume_dispatch\b/g,               hint: "use runResumeDispatch / tryResumeDispatchFromCheckpoint" },
  { pattern: /\bresumeDispatch\b/g,                hint: "use runResumeDispatch" },
];

export interface StaleRef {
  docPath: string;
  referencedPath: string;
  line: number;
}

export interface DeprecatedTokenRef {
  docPath: string;
  token: string;
  hint: string;
  line: number;
}

export interface ArchitectureDriftReport {
  scannedDocs: string[];
  presentCount: number;
  staleCount: number;
  staleReferences: StaleRef[];
  deprecatedTokenCount: number;
  deprecatedTokenRefs: DeprecatedTokenRef[];
}

/**
 * A ranked remediation packet candidate derived from architecture drift findings.
 * Used as planning input for Prometheus: each candidate represents one actionable
 * doc-cleanup or token-replacement task that can be directly serialized into a plan.
 */
export interface RemediationCandidate {
  /** Whether this finding is a missing file reference or a deprecated API token. */
  type: "stale_ref" | "deprecated_token";
  /** Document containing the finding. */
  docPath: string;
  /** Repo-local file path that no longer exists (stale_ref only). */
  referencedPath?: string;
  /** The deprecated token string found (deprecated_token only). */
  token?: string;
  /** Replacement guidance for the deprecated token (deprecated_token only). */
  hint?: string;
  /** 1-based line number in docPath. */
  line: number;
  /**
   * Remediation priority:
   *   high   — stale ref to a core infrastructure file (src/core/)
   *   medium — stale ref to any other src/ file, or any deprecated token
   *   low    — stale ref to docs, docker, scripts, or other non-src paths
   */
  priority: "high" | "medium" | "low";
  /** Numeric priority score (higher = more urgent) used for deterministic ranking. */
  priorityScore: number;
  /** Human-readable reason explaining the priority assignment. */
  reason: string;
  /** Ready-to-use task description string for the Prometheus planning prompt. */
  suggestedTask: string;
}

/**
 * Assign a remediation priority to a stale file reference based on the path prefix.
 *
 * Rationale:
 *   src/core/ files are active infrastructure — stale refs here block safe refactoring.
 *   Other src/ files are product code — medium blast radius.
 *   Everything else (docs, docker, scripts) has low blast radius.
 */
function prioritizeStaleRef(referencedPath: string): "high" | "medium" | "low" {
  if (referencedPath.startsWith("src/core/")) return "high";
  if (referencedPath.startsWith("src/")) return "medium";
  return "low";
}

function computePriorityScore(
  priority: "high" | "medium" | "low",
  docPath: string,
  referencedPath?: string
): number {
  const base = priority === "high" ? 300 : priority === "medium" ? 200 : 100;
  const doc = String(docPath || "").toLowerCase();
  const ref = String(referencedPath || "").toLowerCase();
  let boost = 0;
  if (doc.includes("autonomous-dev-playbook.md")) boost += 40;
  if (doc.includes("architecture")) boost += 20;
  if (ref.startsWith("src/core/")) boost += 25;
  return base + boost;
}

/**
 * Transform an ArchitectureDriftReport into a ranked list of RemediationCandidates
 * suitable for direct input to the Prometheus planning prompt.
 *
 * Ordering: high priority first, then medium, then low.
 * Within the same priority, candidates are sorted by docPath for determinism.
 * Stale references and deprecated token findings are interleaved by priority.
 *
 * Returns an empty array when the report has no findings.
 *
 * @param report - result of checkArchitectureDrift
 * @returns sorted RemediationCandidate array, highest priority first
 */
export function rankStaleRefsAsRemediationCandidates(
  report: ArchitectureDriftReport
): RemediationCandidate[] {
  const candidates: RemediationCandidate[] = [];

  for (const ref of report.staleReferences) {
    const basePriority = prioritizeStaleRef(ref.referencedPath);
    // Stale refs in the autonomous-dev-playbook.md carry the same urgency as
    // core infrastructure refs: they define the system's expected shape and broken
    // references mislead workers regardless of the referenced path category.
    const priority: "high" | "medium" | "low" = (
      basePriority !== "high" &&
      ref.docPath.toLowerCase().includes("autonomous-dev-playbook.md")
    ) ? "high" : basePriority;
    candidates.push({
      type: "stale_ref",
      docPath: ref.docPath,
      referencedPath: ref.referencedPath,
      line: ref.line,
      priority,
      priorityScore: computePriorityScore(priority, ref.docPath, ref.referencedPath),
      reason: `File \`${ref.referencedPath}\` referenced in \`${ref.docPath}\` does not exist`,
      suggestedTask: `Remove or update stale reference to \`${ref.referencedPath}\` in \`${ref.docPath}\` (line ${ref.line})`,
    });
  }

  for (const ref of report.deprecatedTokenRefs) {
    candidates.push({
      type: "deprecated_token",
      docPath: ref.docPath,
      token: ref.token,
      hint: ref.hint,
      line: ref.line,
      priority: "medium",
      priorityScore: computePriorityScore("medium", ref.docPath),
      reason: `Deprecated token \`${ref.token}\` in \`${ref.docPath}\` — ${ref.hint}`,
      suggestedTask: `Replace deprecated \`${ref.token}\` in \`${ref.docPath}\` (line ${ref.line}): ${ref.hint}`,
    });
  }

  candidates.sort((a, b) => {
    const scoreDiff = b.priorityScore - a.priorityScore;
    if (scoreDiff !== 0) return scoreDiff;
    return a.docPath.localeCompare(b.docPath);
  });

  return candidates;
}

/**
 * A deterministic planner debt task derived from an architecture drift finding.
 * These tasks are injected into the Prometheus planning queue so unresolved drift
 * is treated as first-class backlog, not silently ignored.
 *
 * Confidence effects:
 *   high   priority → confidence 0.50  (core infra staleness blocks safe refactoring)
 *   medium priority → confidence 0.75  (product code or deprecated API usage)
 *   low    priority → confidence 0.90  (docs/docker/scripts — low blast radius)
 */
export interface PlannerDebtTask {
  /** Deterministic task identifier derived from type + docPath + line. */
  taskId: string;
  /** Ready-to-execute task description for the Prometheus planning prompt. */
  task: string;
  /** Remediation priority bucket. */
  priority: "high" | "medium" | "low";
  /**
   * Planner confidence score (0–1).
   * Lower confidence means the planner should treat this as higher urgency and
   * reduce confidence in related architectural decisions until the debt is resolved.
   */
  confidence: number;
  /** Finding type: stale file reference or deprecated API token. */
  type: "stale_ref" | "deprecated_token";
  /** Document containing the finding. */
  source: string;
  /** Debt class label for downstream filtering and analytics. */
  debtClass: "architecture_drift";
  /** ISO-8601 creation timestamp (stable across identical input — set by caller if determinism required). */
  createdAt: string;
}

/**
 * Planner confidence by priority bucket.
 *
 * High-priority drift (stale src/core refs) reduces planner confidence the most:
 * these findings indicate the architecture doc is out of sync with active infra,
 * which raises the risk of planning work against a ghost file path.
 */
export const DEBT_CONFIDENCE_BY_PRIORITY: Record<"high" | "medium" | "low", number> = Object.freeze({
  high:   0.50,
  medium: 0.75,
  low:    0.90,
});

/**
 * Build a deterministic task ID for a drift finding.
 * Uses a simple hash of type + docPath + line to ensure:
 *   1. Same finding always produces the same ID.
 *   2. Different findings always produce different IDs.
 *
 * No external crypto dependency — uses pure string manipulation.
 */
function buildDebtTaskId(type: string, docPath: string, line: number, token?: string): string {
  const raw = `${type}::${docPath}::${line}::${token || ""}`;
  // Deterministic CRC-16-like fold
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    h ^= raw.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return `drift-${h.toString(16).padStart(8, "0")}`;
}

/**
 * Convert ranked remediation candidates from an architecture drift report into
 * deterministic planner debt tasks with confidence effects.
 *
 * Output is sorted by priority (high → medium → low), then by docPath for full
 * determinism given identical input.  The `createdAt` field is supplied by the
 * caller so callers that need reproducible output can pass a fixed timestamp.
 *
 * Confidence effects:
 *   - Each task carries a `confidence` score derived from its priority bucket.
 *   - Prometheus/Athena should reduce planning confidence for work that depends on
 *     files referenced in high-priority stale findings.
 *
 * @param candidates - sorted output of rankStaleRefsAsRemediationCandidates()
 * @param createdAt  - ISO-8601 timestamp; defaults to current time when omitted
 * @returns deterministic list of PlannerDebtTask objects, highest priority first
 */
export function convertRemediationCandidatesToDebtTasks(
  candidates: RemediationCandidate[],
  createdAt?: string
): PlannerDebtTask[] {
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const ts = createdAt || new Date().toISOString();

  const tasks: PlannerDebtTask[] = candidates.map((candidate) => ({
    taskId: buildDebtTaskId(
      candidate.type,
      candidate.docPath,
      candidate.line,
      candidate.token
    ),
    task: candidate.suggestedTask,
    priority: candidate.priority,
    confidence: DEBT_CONFIDENCE_BY_PRIORITY[candidate.priority],
    type: candidate.type,
    source: candidate.docPath,
    debtClass: "architecture_drift" as const,
    createdAt: ts,
  }));

  // Ensure deterministic ordering: high before medium before low; ties broken by docPath.
  const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => {
    const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (pDiff !== 0) return pDiff;
    return a.source.localeCompare(b.source);
  });

  return tasks;
}
async function collectDocFilesRecursive(rootDir: string, relDir: string, results: string[]): Promise<void> {
  const absDir = path.join(rootDir, relDir);
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const relPath = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectDocFilesRecursive(rootDir, relPath, results);
    } else if (entry.isFile() && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(relPath);
    }
  }
}

async function listDocFiles(rootDir: string, docDirs: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const docDir of docDirs) {
    await collectDocFilesRecursive(rootDir, docDir, results);
  }
  return results;
}

/**
 * Normalize a TypeScript/JS import alias reference to its repo-local path.
 * Returns null if the path does not match any known alias.
 *
 * Examples:
 *   @core/orchestrator.ts  → src/core/orchestrator.ts
 *   @/config.ts            → src/config.ts
 *   ~/utils.ts             → src/utils.ts
 */
export function normalizeAliasPath(aliasedPath: string): string | null {
  for (const [prefix, resolved] of Object.entries(ALIAS_MAP)) {
    if (aliasedPath.startsWith(prefix)) {
      return resolved + aliasedPath.slice(prefix.length);
    }
  }
  return null;
}

function extractRepoLocalPaths(content: string): Array<{ referencedPath: string; line: number }> {
  const refs: Array<{ referencedPath: string; line: number }> = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    // Match standard repo-local paths
    const re = new RegExp(REPO_LOCAL_PATH_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(lines[i])) !== null) {
      refs.push({ referencedPath: match[1], line: i + 1 });
    }
    // Match and normalize alias-prefixed paths
    const reAlias = new RegExp(ALIAS_PATH_RE.source, "g");
    let aliasMatch: RegExpExecArray | null;
    while ((aliasMatch = reAlias.exec(lines[i])) !== null) {
      const normalized = normalizeAliasPath(aliasMatch[1]);
      if (normalized) {
        refs.push({ referencedPath: normalized, line: i + 1 });
      }
    }
  }
  return refs;
}

/**
 * Scan document content for deprecated token usage.
 * Returns one entry per (token, line) pair detected.
 */
export function detectDeprecatedTokensInContent(
  docPath: string,
  content: string
): DeprecatedTokenRef[] {
  const found: DeprecatedTokenRef[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const { pattern, hint } of DEPRECATED_TOKENS) {
      const re = new RegExp(pattern.source, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(lines[i])) !== null) {
        found.push({ docPath, token: match[0], hint, line: i + 1 });
      }
    }
  }
  return found;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    const ext = path.extname(filePath).toLowerCase();
    const extensionFallbacks: Record<string, string[]> = {
      ".js": [".ts"],
      ".ts": [".js"],
      ".mjs": [".mts"],
      ".mts": [".mjs"],
      ".cjs": [".cts"],
      ".cts": [".cjs"],
    };

    const fallbacks = extensionFallbacks[ext];
    if (!fallbacks || fallbacks.length === 0) {
      return false;
    }

    const basePath = filePath.slice(0, -ext.length);
    for (const fallbackExt of fallbacks) {
      try {
        await fs.access(`${basePath}${fallbackExt}`);
        return true;
      } catch {
        // Try the next sibling extension.
      }
    }

    return false;
  }
}

/**
 * Metadata optionally passed to persistDriftBacklog to annotate the entry.
 */
export interface DriftBacklogMeta {
  /** Caller label for attribution (e.g. "orchestrator", "evolution_executor"). */
  source?: string;
  /** ISO-8601 override for the persisted timestamp (for deterministic tests). */
  persistedAt?: string;
}

/**
 * Persist an architecture drift report as a mandatory planner backlog entry.
 *
 * Converts the report to PlannerDebtTask records and appends one NDJSON line to
 * `<stateDir>/drift_backlog.json` so that unresolved drift is tracked as first-
 * class planning debt rather than silently discarded.
 *
 * Error handling: write failures are logged to stderr and do NOT throw, so drift
 * persistence never aborts the caller's control flow.
 *
 * @param stateDir  - absolute path to the state directory
 * @param report    - output of checkArchitectureDrift()
 * @param meta      - optional caller context (source label, deterministic timestamp)
 */
export async function persistDriftBacklog(
  stateDir: string,
  report: ArchitectureDriftReport,
  meta?: DriftBacklogMeta
): Promise<void> {
  try {
    const candidates = rankStaleRefsAsRemediationCandidates(report);
    const debtTasks = convertRemediationCandidatesToDebtTasks(
      candidates,
      meta?.persistedAt
    );

    const entry = {
      schemaVersion: 1,
      persistedAt: meta?.persistedAt ?? new Date().toISOString(),
      source: meta?.source ?? "unknown",
      staleCount: report.staleCount,
      deprecatedTokenCount: report.deprecatedTokenCount,
      debtTaskCount: debtTasks.length,
      debtTasks,
    };

    const line = JSON.stringify(entry) + "\n";
    const backlogPath = path.join(stateDir, "drift_backlog.json");
    await fs.appendFile(backlogPath, line, "utf8");
  } catch (err) {
    process.stderr.write(
      `[architecture_drift] persistDriftBacklog failed: ${(err as Error).message ?? String(err)}\n`
    );
  }
}

export async function checkArchitectureDrift(options: {
  rootDir: string;
  docDirs?: string[];
}): Promise<ArchitectureDriftReport> {
  const { rootDir, docDirs = ["docs"] } = options;

  const docFiles = await listDocFiles(rootDir, docDirs);
  const staleReferences: StaleRef[] = [];
  const deprecatedTokenRefs: DeprecatedTokenRef[] = [];
  let presentCount = 0;
  const seen = new Set<string>();

  for (const docRelPath of docFiles) {
    const absDocPath = path.join(rootDir, docRelPath);
    let content: string;
    try {
      content = await fs.readFile(absDocPath, "utf8");
    } catch {
      continue;
    }

    const refs = extractRepoLocalPaths(content);
    for (const { referencedPath, line } of refs) {
      // De-duplicate: only check each unique path once per doc
      const key = `${docRelPath}::${referencedPath}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const absRef = path.join(rootDir, referencedPath);
      if (await fileExists(absRef)) {
        presentCount++;
      } else {
        staleReferences.push({ docPath: docRelPath, referencedPath, line });
      }
    }

    // Scan for deprecated token usage in this doc
    const tokenRefs = detectDeprecatedTokensInContent(docRelPath, content);
    deprecatedTokenRefs.push(...tokenRefs);
  }

  return {
    scannedDocs: docFiles,
    presentCount,
    staleCount: staleReferences.length,
    staleReferences,
    deprecatedTokenCount: deprecatedTokenRefs.length,
    deprecatedTokenRefs
  };
}
