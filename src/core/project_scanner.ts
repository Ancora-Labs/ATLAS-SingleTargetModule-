import fs from "node:fs/promises";
import path from "node:path";

export interface GapCandidate {
  /** Stable, deterministic identifier for this gap instance. */
  id: string;
  type: "missing-test" | "low-test-ratio" | "missing-ci" | "missing-tsconfig" | "no-test-runner";
  /** Source file path that exhibits the gap, when applicable. */
  file?: string;
  /** Concrete, file-based evidence strings that justify this gap. */
  evidence: string[];
  severity: "high" | "medium" | "low";
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".box-work",
  "state/backups"
]);

const MAX_SCAN_FILES = 1200;
const MAX_PREVIEW_FILES = 12;
const PREVIEW_BYTES = 2000;

function srcFileToTestBasename(srcPath: string): string {
  const normalized = srcPath.replace(/\\/g, "/");
  const withoutSrc = normalized.replace(/^src\//, "");
  return withoutSrc.replace(/\.[^./]+$/, "");
}

/**
 * Analyse collected file lists and repository signals to produce a sorted,
 * deterministic list of implementation gap candidates.  Each candidate
 * carries concrete, file-based evidence so consumers can act on it directly.
 *
 * Gap types:
 *   "missing-test"    — a source file in src/ has no identifiable test counterpart
 *   "low-test-ratio"  — test/src file ratio is below 0.25 for non-trivial codebases
 *   "missing-ci"      — a test runner is configured but no CI workflow exists
 *   "missing-tsconfig"— TypeScript files are present but no tsconfig.json was found
 *   "no-test-runner"  — source files exist but no test runner is configured at all
 *
 * Output is always sorted by `id` for determinism.
 */
export function detectImplementationGaps(
  srcFiles: string[],
  testFiles: string[],
  signals: {
    hasGithubActions: boolean;
    workflowFileCount: number;
    tsFileCount: number;
    hasTsConfig: boolean;
  },
  hasTestRunner: boolean,
): GapCandidate[] {
  const candidates: GapCandidate[] = [];

  const coreSrcFiles = (Array.isArray(srcFiles) ? srcFiles : []).filter((f) => {
    const norm = String(f).replace(/\\/g, "/");
    return norm.startsWith("src/") && !isTestLike(norm);
  });

  const normalizedTestFiles = (Array.isArray(testFiles) ? testFiles : []).map((f) =>
    String(f).replace(/\\/g, "/"),
  );

  // 1. missing-test: each source file that lacks a matching test file
  for (const srcFile of coreSrcFiles) {
    const base = srcFileToTestBasename(srcFile);
    const hasTest = normalizedTestFiles.some(
      (tf) => tf.includes(base) && isTestLike(tf),
    );
    if (!hasTest) {
      candidates.push({
        id: `gap:missing-test:${srcFile}`,
        type: "missing-test",
        file: srcFile,
        evidence: [
          `No test file found matching pattern *${base}*.test.*`,
          `Source file '${srcFile}' has no corresponding test`,
        ],
        severity: "high",
      });
    }
  }

  // 2. low-test-ratio: test coverage well below 25 % for non-trivial repos
  if (coreSrcFiles.length > 5) {
    const ratio = normalizedTestFiles.length / coreSrcFiles.length;
    if (ratio < 0.25) {
      candidates.push({
        id: "gap:low-test-ratio",
        type: "low-test-ratio",
        evidence: [
          `Only ${normalizedTestFiles.length} test file(s) found for ${coreSrcFiles.length} source file(s)`,
          `Test ratio: ${ratio.toFixed(2)} (threshold: 0.25)`,
        ],
        severity: "medium",
      });
    }
  }

  // 3. missing-ci: test runner configured but no CI workflows present
  if (hasTestRunner && !signals.hasGithubActions) {
    candidates.push({
      id: "gap:missing-ci",
      type: "missing-ci",
      evidence: [
        "Project has a test runner configured but no GitHub Actions workflows detected",
        "Missing .github/workflows directory or YAML files",
      ],
      severity: "high",
    });
  }

  // 4. missing-tsconfig: TypeScript files present but no tsconfig.json
  if (signals.tsFileCount > 0 && !signals.hasTsConfig) {
    candidates.push({
      id: "gap:missing-tsconfig",
      type: "missing-tsconfig",
      evidence: [
        `Found ${signals.tsFileCount} TypeScript file(s) but no tsconfig.json in project root`,
        "TypeScript projects require a tsconfig.json for type checking",
      ],
      severity: "medium",
    });
  }

  // 5. no-test-runner: source code exists but testing is not set up at all
  if (coreSrcFiles.length > 0 && !hasTestRunner) {
    candidates.push({
      id: "gap:no-test-runner",
      type: "no-test-runner",
      evidence: [
        `${coreSrcFiles.length} source file(s) found but no test runner is configured`,
        "Add a test script to package.json (e.g. jest, vitest, or node --test)",
      ],
      severity: "high",
    });
  }

  // Always sort by id so output is stable regardless of insertion order
  candidates.sort((a, b) => a.id.localeCompare(b.id));
  return candidates;
}

function inferCommands(packageJson) {
  const scripts = packageJson?.scripts ?? {};
  return {
    install: scripts.ci ? "npm run ci" : "npm ci",
    build: scripts.build ? "npm run build" : null,
    test: scripts.test ? "npm test -- --ci" : null,
    lint: scripts.lint ? "npm run lint" : null
  };
}

function toSetKeys(obj) {
  return new Set(Object.keys(obj || {}).map((k) => String(k).toLowerCase()));
}

function detectFrameworks(pkg) {
  const deps = toSetKeys(pkg?.dependencies);
  const devDeps = toSetKeys(pkg?.devDependencies);
  const all = new Set([...deps, ...devDeps]);

  const frameworks = [];
  if (all.has("next")) frameworks.push("nextjs");
  if (all.has("react") || all.has("react-dom")) frameworks.push("react");
  if (all.has("vue")) frameworks.push("vue");
  if (all.has("svelte")) frameworks.push("svelte");
  if (all.has("express") || all.has("fastify") || all.has("koa")) frameworks.push("node-api");
  if (all.has("jest") || all.has("vitest") || all.has("mocha")) frameworks.push("test-runner");
  if (all.has("playwright") || all.has("cypress")) frameworks.push("e2e");
  if (all.has("typescript")) frameworks.push("typescript");

  return frameworks;
}

function detectDomains(scripts, frameworks) {
  const domains = new Set();
  const s = scripts || {};
  if (s.build || frameworks.includes("nextjs") || frameworks.includes("react")) {
    domains.add("frontend");
  }
  if (frameworks.includes("node-api") || s.start || s.dev) {
    domains.add("backend");
  }
  if (s.test || frameworks.includes("test-runner") || frameworks.includes("e2e")) {
    domains.add("quality");
  }
  if (s.lint) {
    domains.add("code-quality");
  }
  return [...domains];
}

function isTestLike(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return lower.endsWith(".test.ts")
    || lower.endsWith(".spec.js")
    || lower.includes("/__tests__/")
    || lower.endsWith(".test.ts")
    || lower.endsWith(".spec.ts");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pickPreviewTargets(files) {
  const preferred = [
    "readme.md",
    "package.json",
    "box.config.json",
    "docker-compose.yml",
    "src/cli.ts",
    "src/core/orchestrator.ts",
    "src/core/project_scanner.ts",
    "src/core/task_planner.ts",
    "src/core/roadmap_engine.ts"
  ];

  const normalizedFiles = files.map((f) => String(f).replace(/\\/g, "/"));
  const selected = [];
  for (const target of preferred) {
    const hit = normalizedFiles.find((item) => item.toLowerCase() === target);
    if (hit) {
      selected.push(hit);
    }
  }

  for (const file of normalizedFiles) {
    if (selected.length >= MAX_PREVIEW_FILES) {
      break;
    }
    if (selected.includes(file)) {
      continue;
    }
    if (file.startsWith("src/") || isTestLike(file)) {
      selected.push(file);
    }
  }

  return selected.slice(0, MAX_PREVIEW_FILES);
}

async function buildRepositorySignals(rootDir) {
  const queue = [""];
  const files = [];

  while (queue.length > 0 && files.length < MAX_SCAN_FILES) {
    const relDir = queue.shift();
    const absDir = path.join(rootDir, relDir);
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const normalized = relPath.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        const lower = normalized.toLowerCase();
        if (IGNORED_DIRS.has(lower) || lower.startsWith("state/backups")) {
          continue;
        }
        queue.push(normalized);
        continue;
      }
      if (entry.isFile()) {
        files.push(normalized);
        if (files.length >= MAX_SCAN_FILES) {
          break;
        }
      }
    }
  }

  const extensionHistogram: Record<string, any> = {};
  let srcFileCount = 0;
  let testFileCount = 0;
  let jsFileCount = 0;
  let tsFileCount = 0;
  const allSrcFiles: string[] = [];
  const allTestFiles: string[] = [];
  for (const relFile of files) {
    const ext = path.extname(relFile).toLowerCase() || "[noext]";
    extensionHistogram[ext] = (extensionHistogram[ext] || 0) + 1;
    if (relFile.startsWith("src/")) {
      srcFileCount += 1;
      allSrcFiles.push(relFile);
    }
    if (isTestLike(relFile)) {
      testFileCount += 1;
      allTestFiles.push(relFile);
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      jsFileCount += 1;
    }
    if (ext === ".ts" || ext === ".tsx") {
      tsFileCount += 1;
    }
  }

  const topLevelDirs = [...new Set(files.map((f) => String(f).split("/")[0]))]
    .filter((dir) => dir && !dir.includes("."))
    .slice(0, 20);

  const previewTargets = pickPreviewTargets(files);
  const keyFilePreviews = [];
  for (const relFile of previewTargets) {
    const abs = path.join(rootDir, relFile);
    try {
      const content = await fs.readFile(abs, "utf8");
      keyFilePreviews.push({
        path: relFile,
        preview: String(content).slice(0, PREVIEW_BYTES)
      });
    } catch {
      // Ignore unreadable files; keep scan deterministic.
    }
  }

  let workflowFileCount = 0;
  try {
    const workflowsDir = path.join(rootDir, ".github", "workflows");
    const workflowEntries = await fs.readdir(workflowsDir, { withFileTypes: true });
    workflowFileCount = workflowEntries.filter((entry) => {
      if (!entry.isFile()) {
        return false;
      }
      const lower = String(entry.name || "").toLowerCase();
      return lower.endsWith(".yml") || lower.endsWith(".yaml");
    }).length;
  } catch { /* already 0 */ }

  return {
    scannedFileCount: files.length,
    topLevelDirs,
    extensionHistogram,
    srcFileCount,
    testFileCount,
    jsFileCount,
    tsFileCount,
    hasDockerCompose: await pathExists(path.join(rootDir, "docker-compose.yml")),
    hasReadme: await pathExists(path.join(rootDir, "README.md")),
    hasGithubActions: await pathExists(path.join(rootDir, ".github", "workflows")),
    hasDockerDir: await pathExists(path.join(rootDir, "docker")),
    hasPackageLock: await pathExists(path.join(rootDir, "package-lock.json")),
    hasYarnLock: await pathExists(path.join(rootDir, "yarn.lock")),
    hasPnpmLock: await pathExists(path.join(rootDir, "pnpm-lock.yaml")),
    hasTsConfig: await pathExists(path.join(rootDir, "tsconfig.json")),
    workflowFileCount,
    keyFilePreviews,
    allSrcFiles,
    allTestFiles,
  };
}

export async function scanProject(config) {
  const packagePath = path.join(config.rootDir, "package.json");
  const result = {
    timestamp: new Date().toISOString(),
    rootDir: config.rootDir,
    hasPackageJson: false,
    packageName: null,
    scripts: {},
    commands: {},
    frameworks: [],
    domains: [],
    dependencyCount: 0,
    repositorySignals: {
      scannedFileCount: 0,
      topLevelDirs: [],
      extensionHistogram: {},
      srcFileCount: 0,
      testFileCount: 0,
      jsFileCount: 0,
      tsFileCount: 0,
      hasDockerCompose: false,
      hasReadme: false,
      hasGithubActions: false,
      hasDockerDir: false,
      hasPackageLock: false,
      hasYarnLock: false,
      hasPnpmLock: false,
      hasTsConfig: false,
      workflowFileCount: 0,
      keyFilePreviews: [],
      allSrcFiles: [],
      allTestFiles: [],
    },
    implementationGaps: [] as GapCandidate[],
  };

  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw);
    result.hasPackageJson = true;
    result.packageName = pkg.name ?? null;
    result.scripts = pkg.scripts ?? {};
    result.commands = inferCommands(pkg);
    result.frameworks = detectFrameworks(pkg);
    result.domains = detectDomains(result.scripts, result.frameworks);
    result.dependencyCount =
      Object.keys(pkg?.dependencies || {}).length +
      Object.keys(pkg?.devDependencies || {}).length;
  } catch {
    result.commands = {
      install: "npm ci",
      build: null,
      test: null,
      lint: null
    };
    result.frameworks = [];
    result.domains = [];
    result.dependencyCount = 0;
  }

  result.repositorySignals = await buildRepositorySignals(config.rootDir);

  if (result.repositorySignals.testFileCount > 0 && !result.domains.includes("quality")) {
    result.domains.push("quality");
  }
  if (result.repositorySignals.srcFileCount > 0 && !result.domains.includes("backend")) {
    result.domains.push("backend");
  }
  if (result.repositorySignals.hasDockerDir && !result.domains.includes("devops")) {
    result.domains.push("devops");
  }

  const hasTestRunner = result.frameworks.includes("test-runner") || !!(result.scripts as Record<string, string>)?.["test"];
  result.implementationGaps = detectImplementationGaps(
    result.repositorySignals.allSrcFiles,
    result.repositorySignals.allTestFiles,
    {
      hasGithubActions: result.repositorySignals.hasGithubActions,
      workflowFileCount: result.repositorySignals.workflowFileCount,
      tsFileCount: result.repositorySignals.tsFileCount,
      hasTsConfig: result.repositorySignals.hasTsConfig,
    },
    hasTestRunner,
  );

  return result;
}

/**
 * Compute a discovery novelty signal by comparing the current scan's detected
 * domains against a known baseline set from a prior scan.
 *
 * A "new" domain is one present in currentDomains but absent from baselineDomains.
 * The noveltySignal categorises the discovery gap:
 *   "high"   — more than half of detected domains are new (unexplored territory)
 *   "medium" — at least one new domain detected
 *   "low"    — all domains were already known (no new discovery)
 *
 * Returns { newDomains: [], noveltySignal: "low" } for empty or equal inputs.
 *
 * @param currentDomains  — domains detected in the current project scan
 * @param baselineDomains — domains from a prior scan (or known baseline)
 */
export function computeScanNoveltySignal(
  currentDomains: string[],
  baselineDomains: string[],
): { newDomains: string[]; noveltySignal: "high" | "medium" | "low" } {
  const current = Array.isArray(currentDomains) ? currentDomains : [];
  const baseline = new Set(Array.isArray(baselineDomains) ? baselineDomains : []);

  const newDomains = current.filter(d => !baseline.has(d));

  const noveltySignal: "high" | "medium" | "low" =
    current.length > 0 && newDomains.length > current.length / 2
      ? "high"
      : newDomains.length > 0
        ? "medium"
        : "low";

  return { newDomains, noveltySignal };
}

export interface SemanticFileCandidate {
  path: string;
  preview: string;
}

export interface SemanticRetrievalEntry {
  path: string;
  score: number;
  preview: string;
}

const semanticRetrievalCache = new Map<string, SemanticRetrievalEntry[]>();

function normalizeSemanticText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenizeSemanticText(text: string): string[] {
  const normalized = normalizeSemanticText(text)
    .replace(/[./_-]+/g, " ");
  if (!normalized) return [];
  return [...new Set(normalized.split(" ").filter((token) => token.length >= 2))];
}

export function buildSemanticFileCandidatesFromScan(scanResult: any): SemanticFileCandidate[] {
  const repositorySignals = scanResult?.repositorySignals || {};
  const listedFiles = [
    ...(Array.isArray(repositorySignals?.allSrcFiles) ? repositorySignals.allSrcFiles : []),
    ...(Array.isArray(repositorySignals?.allTestFiles) ? repositorySignals.allTestFiles : []),
  ]
    .map((value) => String(value || "").replace(/\\/g, "/"))
    .filter(Boolean);
  const previewByPath = new Map<string, string>(
    (Array.isArray(repositorySignals?.keyFilePreviews) ? repositorySignals.keyFilePreviews : [])
      .map((entry: any) => [String(entry?.path || "").replace(/\\/g, "/"), String(entry?.preview || "")]),
  );

  const uniquePaths = [...new Set(listedFiles)].sort((a, b) => a.localeCompare(b));
  return uniquePaths.map((filePath) => ({
    path: filePath,
    preview: previewByPath.get(filePath) || "",
  }));
}

export function rankSemanticFileCandidates(
  query: string,
  candidates: SemanticFileCandidate[],
  opts: { tokenBudget?: number; maxEntries?: number; cacheKey?: string } = {},
): SemanticRetrievalEntry[] {
  const safeCandidates = Array.isArray(candidates) ? candidates : [];
  const tokenBudget = Math.max(80, Number(opts.tokenBudget || 600));
  const maxEntries = Math.max(1, Math.floor(Number(opts.maxEntries || 12)));
  const cacheKey = String(opts.cacheKey || "").trim();

  if (cacheKey && semanticRetrievalCache.has(cacheKey)) {
    return semanticRetrievalCache.get(cacheKey)!;
  }

  const queryTokens = tokenizeSemanticText(query);
  const scored = safeCandidates.map((candidate) => {
    const joined = `${candidate.path}\n${candidate.preview}`;
    const haystack = normalizeSemanticText(joined);
    const overlap = queryTokens.reduce((score, token) => score + (haystack.includes(token) ? 1 : 0), 0);
    const pathBoost = candidate.path.startsWith("src/core/")
      ? 0.35
      : candidate.path.startsWith("src/")
        ? 0.2
        : candidate.path.startsWith("tests/")
          ? 0.1
          : 0;
    const score = Math.round(((overlap * 1.2) + pathBoost) * 1000) / 1000;
    return {
      path: candidate.path,
      score,
      preview: String(candidate.preview || "").slice(0, 220),
    };
  })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const ranked: SemanticRetrievalEntry[] = [];
  let remainingBudget = tokenBudget;
  for (const entry of scored) {
    if (ranked.length >= maxEntries) break;
    const lineTokens = Math.max(1, Math.ceil(`${entry.path}\n${entry.preview}`.length / 4));
    if (remainingBudget - lineTokens < 0) break;
    ranked.push(entry);
    remainingBudget -= lineTokens;
  }

  if (cacheKey) semanticRetrievalCache.set(cacheKey, ranked);
  return ranked;
}
