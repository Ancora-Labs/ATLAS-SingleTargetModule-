/**
 * Verification Profiles — Role-based evidence requirements
 *
 * Each worker kind has different verification needs.
 * Frontend workers must prove responsive behavior.
 * Backend workers must prove API correctness and test coverage.
 * Security workers must prove vulnerability remediation.
 * Scan workers are read-only — no verification needed.
 *
 * The verification gate uses these profiles to decide whether
 * a worker's "done" claim is substantiated by evidence.
 */

// Evidence field states: "required" | "optional" | "exempt"
// required = must be "pass" for done to be accepted
// optional = parsed if present, not enforced
// exempt = not applicable for this role kind

const PROFILES = {
  frontend: {
    kind: "frontend",
    label: "Frontend (Esther)",
    lane: "implementation",
    evidence: {
      build:      "required",
      tests:      "optional",
      responsive: "required",
      api:        "exempt",
      edgeCases:  "required",
      security:   "optional",
      prUrl:      "required"   // must open a real PR — generic for all implementation roles
    },
    responsiveRequired: true,
    minViewports: 5,
    description: "Must verify build, responsive matrix (≥5 viewports), edge cases, and open a real PR."
  },
  backend: {
    kind: "backend",
    label: "Backend (King David)",
    lane: "implementation",
    evidence: {
      build:      "required",
      tests:      "required",
      responsive: "exempt",
      api:        "optional",
      edgeCases:  "required",
      security:   "optional",
      prUrl:      "required"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build, tests, edge cases, and open a real PR."
  },
  api: {
    kind: "api",
    label: "API (Aaron)",
    lane: "implementation",
    evidence: {
      build:      "required",
      tests:      "required",
      responsive: "exempt",
      api:        "required",
      edgeCases:  "required",
      security:   "optional",
      prUrl:      "required"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build, tests, API contract, edge cases, and open a real PR."
  },
  integration: {
    kind: "integration",
    label: "Integration (Joseph)",
    lane: "integration",
    evidence: {
      build:      "required",
      tests:      "required",
      responsive: "exempt",
      api:        "required",
      edgeCases:  "required",
      security:   "optional"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build, tests, API integration, and edge cases."
  },
  test: {
    kind: "test",
    label: "Test (Samuel)",
    lane: "quality",
    evidence: {
      build:      "optional",
      tests:      "required",
      responsive: "exempt",
      api:        "exempt",
      edgeCases:  "required",
      security:   "exempt"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify tests pass and edge cases covered."
  },
  qa: {
    kind: "qa",
    label: "QA (Isaiah)",
    lane: "quality",
    evidence: {
      build:      "required",
      tests:      "required",
      responsive: "optional",
      api:        "optional",
      edgeCases:  "required",
      security:   "optional",
      prUrl:      "required"   // must open a real PR
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build, tests, edge cases, and open a real PR."
  },
  security: {
    kind: "security",
    label: "Security (Elijah)",
    lane: "governance",
    evidence: {
      build:      "required",
      tests:      "required",
      responsive: "exempt",
      api:        "optional",
      edgeCases:  "required",
      security:   "required",
      prUrl:      "required"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build, tests, edge cases, security audit, and open a real PR."
  },
  devops: {
    kind: "devops",
    label: "DevOps (Noah)",
    lane: "infrastructure",
    evidence: {
      build:      "required",
      tests:      "optional",
      responsive: "exempt",
      api:        "exempt",
      edgeCases:  "optional",
      security:   "optional",
      prUrl:      "required"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Must verify build passes and open a real PR."
  },
  scanA: {
    kind: "scanA",
    label: "Scanner (Issachar)",
    lane: "observation",
    evidence: {
      build:      "exempt",
      tests:      "exempt",
      responsive: "exempt",
      api:        "exempt",
      edgeCases:  "exempt",
      security:   "exempt"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Read-only scan role. No verification required."
  },
  scanB: {
    kind: "scanB",
    label: "Documentation (Ezra)",
    lane: "observation",
    evidence: {
      build:      "optional",
      tests:      "exempt",
      responsive: "exempt",
      api:        "exempt",
      edgeCases:  "exempt",
      security:   "exempt"
    },
    responsiveRequired: false,
    minViewports: 0,
    description: "Documentation role. Build optional, no other verification."
  }
};

// Fallback for unknown kinds
const DEFAULT_PROFILE = {
  kind: "unknown",
  label: "Unknown",
  lane: "implementation",
  evidence: {
    build:      "required",
    tests:      "optional",
    responsive: "optional",
    api:        "optional",
    edgeCases:  "optional",
    security:   "optional"
  },
  responsiveRequired: false,
  minViewports: 0,
  description: "Unknown role. Build required, everything else optional."
};

const PROFILE_KIND_ALIASES = Object.freeze({
  quality: "qa",
  governance: "security",
  infrastructure: "devops",
  observation: "scanB",
  "quality-worker": "qa",
  "governance-worker": "security",
  "infrastructure-worker": "devops",
  "observation-worker": "scanB",
  "integration-worker": "integration",
  frontend: "frontend",
  backend: "backend",
  api: "api",
  integration: "integration",
  qa: "qa",
  security: "security",
  devops: "devops",
  scana: "scanA",
  scanb: "scanB",
});

export function resolveVerificationProfileKind(workerKind) {
  const normalizedKind = String(workerKind || "")
    .trim()
    .toLowerCase();
  if (!normalizedKind) return "unknown";
  if (PROFILES[normalizedKind]) return normalizedKind;
  return PROFILE_KIND_ALIASES[normalizedKind] || normalizedKind;
}

export const CANONICAL_VERIFICATION_REPORT_TEMPLATE = Object.freeze([
  "===VERIFICATION_REPORT===",
  "BUILD=<pass|fail|n/a>",
  "TESTS=<pass|fail|n/a>",
  "RESPONSIVE=<pass|fail|n/a>",
  "API=<pass|fail|n/a>",
  "EDGE_CASES=<pass|fail|n/a>",
  "SECURITY=<pass|fail|n/a>",
  "===END_VERIFICATION===",
].join("\n"));

export function getVerificationProfile(workerKind) {
  const resolvedKind = resolveVerificationProfileKind(workerKind);
  return PROFILES[resolvedKind] || DEFAULT_PROFILE;
}

export function getAllProfiles() {
  return { ...PROFILES };
}

// getWorkersByLane stub removed — real implementation using PROFILES is below

/**
 * Build a human-readable verification checklist for a given role.
 * Injected into worker context so the worker knows what evidence is required.
 */
export function buildVerificationChecklist(workerKind) {
  const profile = getVerificationProfile(workerKind);
  const lines = [`## VERIFICATION REQUIREMENTS FOR YOUR ROLE (${profile.label})`];
  lines.push(profile.description);
  lines.push("");

  const labelMap = {
    build: "BUILD (compile/transpile/bundle)",
    tests: "TESTS (unit/integration)",
    responsive: "RESPONSIVE (viewport matrix)",
    api: "API (request/response contract)",
    edgeCases: "EDGE_CASES (empty/error/boundary)",
    security: "SECURITY (vulnerability remediation)"
  };

  for (const [field, requirement] of Object.entries(profile.evidence)) {
    const label = labelMap[field] || field;
    if (requirement === "required") {
      lines.push(`  [REQUIRED] ${label} — you MUST verify this and report pass/fail`);
    } else if (requirement === "optional") {
      lines.push(`  [OPTIONAL] ${label} — verify if applicable`);
    }
    // exempt fields are not shown
  }

  if (profile.responsiveRequired) {
    lines.push("");
    lines.push(`  Responsive minimum: ${profile.minViewports} viewports must be checked.`);
    lines.push("  Recommended: 320x568, 360x640, 375x667, 390x844, 412x915, 768x1024, 1024x768, 1280x800, 1440x900");
  }

  lines.push("");
  lines.push("At the END of your response, you MUST include ALL of the following:");
  lines.push("Use this exact verification report block (replace placeholders with real values):");
  lines.push("```");
  lines.push(CANONICAL_VERIFICATION_REPORT_TEMPLATE);
  lines.push("```");

  const needsPrUrl = profile.evidence?.prUrl === "required";
  if (needsPrUrl) {
    lines.push("BOX_PR_URL=<https://github.com/...> (REQUIRED — you must push a branch and open a REAL PR. No PR URL = not done.)");
  }

  lines.push("If any REQUIRED field is 'fail', you MUST fix the issue before reporting done. Do not defer known defects.");
  lines.push("If any REQUIRED field is missing or 'n/a', your task will be returned for rework.");
  lines.push("");
  lines.push("⚠️ CRITICAL: Do NOT claim BOX_STATUS=done if you did not make real file changes and open a real PR.");
  lines.push("Saying 'I implemented X' or 'I fixed Y' in prose is NOT evidence. The gate checks BOX_PR_URL and VERIFICATION_REPORT fields.");
  lines.push("If the task was ALREADY DONE in a previous wave (merged PR exists), report BOX_STATUS=skipped with BOX_SKIP_REASON=already-merged.");
  lines.push("");
  lines.push("## POST-MERGE VERIFICATION ARTIFACT (MANDATORY)");
  lines.push("After merging your PR, you MUST include the following in your output (exact format required by the gate):");
  lines.push("1. BOX_MERGED_SHA=<7-40 char hex commit SHA>   — run: git rev-parse HEAD");
  lines.push("2. CLEAN_TREE_STATUS=clean                     — run: git status --porcelain when the whole repo is clean");
  lines.push("   OR, for shared dirty worktrees caused by unrelated tasks:");
  lines.push("   CLEAN_TREE_STATUS=dirty-other-tasks-only");
  lines.push("   TASK_SCOPED_CLEAN_STATUS=clean");
  lines.push("   TASK_SCOPED_CLEAN_TARGETS=<comma-separated task files>   — prove with: git status --porcelain -- <task files>");
  lines.push("3. A raw npm test block using these exact markers:");
  lines.push("");
  lines.push("===NPM TEST OUTPUT START===");
  lines.push("<paste full raw npm test stdout here>");
  lines.push("===NPM TEST OUTPUT END===");
  lines.push("");
  lines.push("⚠️ Do NOT use the old POST_MERGE_TEST_OUTPUT format — use the markers above or the gate will reject the artifact.");

  return lines.join("\n");
}

/**
 * Get all worker kinds that belong to a given lane.
 * @param {string} lane — "implementation"|"integration"|"quality"|"governance"|"infrastructure"|"observation"
 * @returns {string[]} — array of worker kind strings
 */
export function getWorkersByLane(lane) {
  return Object.entries(PROFILES)
    .filter(([, p]) => p.lane === lane)
    .map(([kind]) => kind);
}

/** All unique lane names. */
export const LANES = Object.freeze([
  "implementation",
  "integration",
  "quality",
  "governance",
  "infrastructure",
  "observation"
]);
