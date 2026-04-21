import fs from "node:fs/promises";
import path from "node:path";
import { readJson, spawnAsync, writeJson } from "./fs_utils.js";
import { agentFileExists, appendAgentLiveLog, appendAgentLiveLogDetail, buildAgentArgs, parseAgentOutput, writeAgentDebugFile } from "./agent_loader.js";
import { appendProgress } from "./state_tracker.js";
import {
  getTargetBaselinePath,
  getTargetClarificationPacketPath,
  getTargetClarificationTranscriptPath,
  getTargetIntentContractPath,
  getTargetOnboardingReportPath,
  getTargetPrerequisiteStatusPath,
  getTargetRepoAnalysisPath,
  getTargetWorkspacePath,
  prepareTargetWorkspaceForSession,
  saveActiveTargetSession,
  TARGET_SESSION_STAGE,
} from "./target_session_state.js";

export const TARGET_ONBOARDING_SCHEMA_VERSION = 2;
export const TARGET_ONBOARDING_AGENT_SLUG = "onboarding";
export const TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG = "onboarding-empty-repo";
export const TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG = "onboarding-existing-repo";

const EMPTY_REPO_IGNORABLE_NAMES = new Set([
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".nvmrc",
  ".npmrc",
  "readme",
  "readme.md",
  "license",
  "license.md",
  "changelog.md",
]);

const IMPLEMENTATION_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".php", ".rb", ".cs", ".swift", ".scala", ".sh", ".sql", ".html", ".css", ".scss", ".vue", ".svelte",
]);

function normalizeNullableString(value: unknown): string | null {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((entry) => String(entry || "").trim()).filter(Boolean))];
}

function normalizeQuestionAnswerMode(value: unknown, fallback = "hybrid") {
  const normalized = String(value || "").trim().toLowerCase();
  if (["single_select", "multi_select", "hybrid"].includes(normalized)) {
    return normalized;
  }
  if (["single", "single choice", "single-choice"].includes(normalized)) {
    return "single_select";
  }
  if (["multi", "multi choice", "multi-choice", "checkboxes"].includes(normalized)) {
    return "multi_select";
  }
  if (["free_text", "free-text", "freeform", "text"].includes(normalized)) {
    return "hybrid";
  }
  return fallback;
}

function normalizeClarificationPacket(rawPacket: any, fallbackPacket: any) {
  const fallbackQuestions = Array.isArray(fallbackPacket?.questions) ? fallbackPacket.questions : [];
  const rawQuestions = Array.isArray(rawPacket?.questions) ? rawPacket.questions : [];
  const selectedQuestions = rawQuestions.length > 0 ? rawQuestions : fallbackQuestions;
  const seenIds = new Set<string>();

  const questions = selectedQuestions.map((question: any, index: number) => {
    const fallbackQuestion = fallbackQuestions[index] || fallbackQuestions[Math.max(0, fallbackQuestions.length - 1)] || null;
    const semanticSlot = normalizeNullableString(question?.semanticSlot)
      || normalizeNullableString(fallbackQuestion?.id)
      || normalizeNullableString(question?.id)
      || `question_${index + 1}`;
    const rawId = normalizeNullableString(question?.id) || semanticSlot;
    let id = rawId;
    let duplicateSuffix = 2;
    while (seenIds.has(id)) {
      id = `${rawId}_${duplicateSuffix++}`;
    }
    seenIds.add(id);
    const title = normalizeNullableString(question?.title)
      || normalizeNullableString(fallbackQuestion?.title)
      || `Question ${index + 1}`;
    const prompt = normalizeNullableString(question?.prompt)
      || normalizeNullableString(fallbackQuestion?.prompt)
      || title;
    const answerMode = normalizeQuestionAnswerMode(
      question?.answerMode,
      normalizeQuestionAnswerMode(fallbackQuestion?.answerMode, "hybrid"),
    );
    const options = normalizeStringArray(Array.isArray(question?.options) ? question.options : fallbackQuestion?.options);
    return {
      id,
      semanticSlot,
      title,
      prompt,
      answerMode,
      options,
    };
  }).filter((question) => question.id && question.title && question.prompt);

  if (questions.length === 0) {
    return fallbackPacket;
  }

  return {
    ...fallbackPacket,
    ...((rawPacket && typeof rawPacket === "object") ? rawPacket : {}),
    selectedAgentSlug: fallbackPacket.selectedAgentSlug,
    repoState: fallbackPacket.repoState,
    repoStateReason: fallbackPacket.repoStateReason,
    meaningfulEntryPoints: fallbackPacket.meaningfulEntryPoints,
    dominantSignals: fallbackPacket.dominantSignals,
    workspaceFacts: fallbackPacket.workspaceFacts,
    openingPrompt: normalizeNullableString(rawPacket?.openingPrompt) || fallbackPacket.openingPrompt,
    closingCriteria: normalizeStringArray(rawPacket?.closingCriteria).length > 0
      ? normalizeStringArray(rawPacket?.closingCriteria)
      : fallbackPacket.closingCriteria,
    questions,
  };
}

async function pathExists(targetPath: string | null | undefined) {
  if (!targetPath) return false;
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function collectWorkspaceEntries(rootPath: string, maxDepth = 2, maxEntries = 80): Promise<string[]> {
  const discovered: string[] = [];
  async function walk(currentPath: string, depth: number, prefix = "") {
    if (depth > maxDepth || discovered.length >= maxEntries) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (discovered.length >= maxEntries) break;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      discovered.push(relativePath);
      if (entry.isDirectory() && entry.name !== ".git") {
        await walk(path.join(currentPath, entry.name), depth + 1, relativePath);
      }
    }
  }
  await walk(rootPath, 0);
  return discovered;
}

function isIgnorableRepoEntry(relativePath: string): boolean {
  const normalizedPath = String(relativePath || "").trim().toLowerCase();
  if (!normalizedPath) return true;
  if (normalizedPath === ".git" || normalizedPath.startsWith(".git/")) return true;
  if (normalizedPath.startsWith(".github/")) return true;
  const baseName = normalizedPath.split("/").pop() || normalizedPath;
  if (EMPTY_REPO_IGNORABLE_NAMES.has(baseName)) return true;
  return false;
}

function classifyRepoState(workspaceFacts: any, workspaceEntries: string[]) {
  const meaningfulEntries = workspaceEntries.filter((entry) => !isIgnorableRepoEntry(entry));
  const sourceLikeEntries = meaningfulEntries.filter((entry) => {
    const lower = entry.toLowerCase();
    return ["src", "app", "pages", "components", "server", "api", "lib", "packages", "services", "features"].some((segment) => lower === segment || lower.startsWith(`${segment}/`));
  });
  const codeLikeEntries = meaningfulEntries.filter((entry) => {
    const lower = entry.toLowerCase();
    const ext = path.extname(lower);
    if (IMPLEMENTATION_EXTENSIONS.has(ext)) return true;
    return ["prisma/schema.prisma", "supabase/config.toml"].some((segment) => lower === segment);
  });

  const dominantSignals = [
    workspaceFacts.framework !== "unknown" ? workspaceFacts.framework : null,
    workspaceFacts.packageManager !== "unknown" ? workspaceFacts.packageManager : null,
    workspaceFacts.repoShape !== "single_repo" ? workspaceFacts.repoShape : null,
    workspaceFacts.buildDetected ? "build_detected" : null,
    workspaceFacts.testDetected ? "test_detected" : null,
    workspaceFacts.lintDetected ? "lint_detected" : null,
    workspaceFacts.typecheckDetected ? "typecheck_detected" : null,
  ].filter(Boolean);

  if (codeLikeEntries.length === 0 && meaningfulEntries.length === 0) {
    return {
      repoState: "empty",
      repoStateReason: "Repository contains no meaningful product files beyond bootstrap or housekeeping artifacts.",
      meaningfulEntryPoints: [],
      dominantSignals,
    };
  }

  if (codeLikeEntries.length === 0 && sourceLikeEntries.length === 0) {
    return {
      repoState: "empty",
      repoStateReason: "Repository contains only lightweight scaffolding and still needs product intent discovery before planning can begin.",
      meaningfulEntryPoints: meaningfulEntries.slice(0, 8),
      dominantSignals,
    };
  }

  return {
    repoState: "existing",
    repoStateReason: `Repository already contains meaningful implementation or delivery artifacts (${Math.max(codeLikeEntries.length, meaningfulEntries.length)} signals detected).`,
    meaningfulEntryPoints: (codeLikeEntries.length > 0 ? codeLikeEntries : meaningfulEntries).slice(0, 8),
    dominantSignals,
  };
}

async function detectWorkspaceFacts(workspacePath: string) {
  const gitDir = path.join(workspacePath, ".git");
  const packageJsonPath = path.join(workspacePath, "package.json");
  const packageLockPath = path.join(workspacePath, "package-lock.json");
  const pnpmLockPath = path.join(workspacePath, "pnpm-lock.yaml");
  const yarnLockPath = path.join(workspacePath, "yarn.lock");
  const bunLockPath = path.join(workspacePath, "bun.lockb");
  const tsconfigPath = path.join(workspacePath, "tsconfig.json");
  const turboPath = path.join(workspacePath, "turbo.json");
  const pnpmWorkspacePath = path.join(workspacePath, "pnpm-workspace.yaml");
  const npmrcPath = path.join(workspacePath, ".npmrc");
  const envExamplePath = path.join(workspacePath, ".env.example");
  const envSamplePath = path.join(workspacePath, ".env.sample");
  const vercelPath = path.join(workspacePath, "vercel.json");
  const wranglerPath = path.join(workspacePath, "wrangler.toml");
  const railwayPath = path.join(workspacePath, "railway.json");
  const prismaPath = path.join(workspacePath, "prisma", "schema.prisma");
  const supabasePath = path.join(workspacePath, "supabase", "config.toml");
  const sentryPath = path.join(workspacePath, "sentry.client.config.ts");

  const [gitExists, packageJsonExists, packageLockExists, pnpmLockExists, yarnLockExists, bunLockExists, tsconfigExists, turboExists, pnpmWorkspaceExists, npmrcExists, envExampleExists, envSampleExists, vercelExists, wranglerExists, railwayExists, prismaExists, supabaseExists, sentryExists, workspaceEntries] = await Promise.all([
    pathExists(gitDir),
    pathExists(packageJsonPath),
    pathExists(packageLockPath),
    pathExists(pnpmLockPath),
    pathExists(yarnLockPath),
    pathExists(bunLockPath),
    pathExists(tsconfigPath),
    pathExists(turboPath),
    pathExists(pnpmWorkspacePath),
    pathExists(npmrcPath),
    pathExists(envExamplePath),
    pathExists(envSamplePath),
    pathExists(vercelPath),
    pathExists(wranglerPath),
    pathExists(railwayPath),
    pathExists(prismaPath),
    pathExists(supabasePath),
    pathExists(sentryPath),
    collectWorkspaceEntries(workspacePath),
  ]);

  let packageJson: any = null;
  if (packageJsonExists) {
    packageJson = await readJson(packageJsonPath, null);
  }

  const scripts = packageJson?.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const deps = {
    ...(packageJson?.dependencies || {}),
    ...(packageJson?.devDependencies || {}),
  };
  const [npmrcContents, envExampleContents, envSampleContents] = await Promise.all([
    npmrcExists ? fs.readFile(npmrcPath, "utf8").catch(() => "") : "",
    envExampleExists ? fs.readFile(envExamplePath, "utf8").catch(() => "") : "",
    envSampleExists ? fs.readFile(envSamplePath, "utf8").catch(() => "") : "",
  ]);

  let framework = "unknown";
  if (deps.next) framework = "nextjs";
  else if (deps.nuxt) framework = "nuxt";
  else if (deps.react) framework = "react";
  else if (deps.vue) framework = "vue";
  else if (deps.svelte) framework = "svelte";
  else if (deps.express) framework = "express";

  let packageManager = "unknown";
  if (pnpmLockExists || packageJson?.packageManager?.startsWith("pnpm")) packageManager = "pnpm";
  else if (yarnLockExists || packageJson?.packageManager?.startsWith("yarn")) packageManager = "yarn";
  else if (bunLockExists || packageJson?.packageManager?.startsWith("bun")) packageManager = "bun";
  else if (packageLockExists || packageJsonExists) packageManager = "npm";

  const repoShape = turboExists || pnpmWorkspaceExists || Array.isArray(packageJson?.workspaces) ? "monorepo" : "single_repo";
  const buildDetected = typeof scripts.build === "string" && scripts.build.trim().length > 0;
  const testDetected = typeof scripts.test === "string" && scripts.test.trim().length > 0;
  const lintDetected = typeof scripts.lint === "string" && scripts.lint.trim().length > 0;
  const typecheckDetected = typeof scripts.typecheck === "string" && scripts.typecheck.trim().length > 0 || tsconfigExists;

  return {
    gitExists,
    packageJsonExists,
    packageManager,
    stack: packageJsonExists ? "node" : "unknown",
    framework,
    repoShape,
    buildDetected,
    testDetected,
    lintDetected,
    typecheckDetected,
    deployDetected: typeof scripts.deploy === "string" && scripts.deploy.trim().length > 0,
    privateRegistryRequired: /(_authToken|npmAuthToken|registry=)/i.test(npmrcContents)
      || Boolean(packageJson?.publishConfig?.registry),
    deployPlatforms: [
      ...(vercelExists ? ["vercel"] : []),
      ...(wranglerExists ? ["cloudflare"] : []),
      ...(railwayExists ? ["railway"] : []),
    ],
    databaseAccessDetected: prismaExists || supabaseExists,
    optionalIntegrations: [
      ...(sentryExists ? ["sentry"] : []),
    ],
    envExampleVariables: [...new Set([
      ...[envExampleContents, envSampleContents]
        .flatMap((content) => content.split(/\r?\n/))
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#") && line.includes("="))
        .map((line) => line.split("=", 1)[0].trim())
        .filter(Boolean),
    ])],
    buildCommand: buildDetected ? String(scripts.build) : null,
    testCommand: testDetected ? String(scripts.test) : null,
    lintCommand: lintDetected ? String(scripts.lint) : null,
    typecheckCommand: typecheckDetected && typeof scripts.typecheck === "string" ? String(scripts.typecheck) : null,
    workspaceEntries,
  };
}

function detectProvider(repoUrl: string | null) {
  const source = String(repoUrl || "").toLowerCase();
  if (source.includes("github.com")) return "github";
  if (source.includes("gitlab")) return "gitlab";
  if (source.includes("bitbucket")) return "bitbucket";
  return "unknown";
}

function hasConfiguredSecret(config: any, names: string[]) {
  return names.some((name) => {
    const configValue = config?.env?.[name];
    const processValue = process.env[name];
    return Boolean(String(configValue || processValue || "").trim());
  });
}

function detectRequiredCredentials(provider: string, config: any, workspaceFacts: any, activeTargetSession: any) {
  const requiredNow: string[] = [];
  const requiredLater: string[] = [];
  const optional: string[] = [];
  const bootstrapStatus = String(activeTargetSession?.workspace?.bootstrap?.status || "").trim().toLowerCase();

  if (
    provider === "github"
    && bootstrapStatus === "awaiting_credentials"
    && !hasConfiguredSecret(config, ["githubToken", "copilotGithubToken", "GITHUB_TOKEN"])
  ) {
    requiredNow.push("github_repo_access_token");
  }
  if (workspaceFacts.privateRegistryRequired && !hasConfiguredSecret(config, ["NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN"])) {
    requiredNow.push("package_registry_access_token");
  }

  if (workspaceFacts.deployPlatforms.includes("vercel") && !hasConfiguredSecret(config, ["VERCEL_TOKEN"])) {
    requiredLater.push("vercel_access_token");
  }
  if (workspaceFacts.deployPlatforms.includes("cloudflare") && !hasConfiguredSecret(config, ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_TOKEN"])) {
    requiredLater.push("cloudflare_access_token");
  }
  if (workspaceFacts.deployPlatforms.includes("railway") && !hasConfiguredSecret(config, ["RAILWAY_TOKEN"])) {
    requiredLater.push("railway_access_token");
  }
  if (workspaceFacts.databaseAccessDetected && !hasConfiguredSecret(config, ["DATABASE_URL", "DIRECT_URL", "SUPABASE_ACCESS_TOKEN"])) {
    requiredLater.push("database_access_credentials");
  }

  if (workspaceFacts.optionalIntegrations.includes("sentry") && !hasConfiguredSecret(config, ["SENTRY_AUTH_TOKEN"])) {
    optional.push("sentry_access_token");
  }

  for (const envVar of Array.isArray(workspaceFacts.envExampleVariables) ? workspaceFacts.envExampleVariables : []) {
    if (!/(token|secret|key|url)$/i.test(envVar)) continue;
    if (hasConfiguredSecret(config, [envVar])) continue;
    if (/sentry/i.test(envVar)) {
      optional.push(envVar);
      continue;
    }
    if (/database|db|prisma|supabase/i.test(envVar)) {
      requiredLater.push(envVar);
      continue;
    }
    if (/deploy|vercel|railway|cloudflare/i.test(envVar)) {
      requiredLater.push(envVar);
      continue;
    }
  }

  return {
    requiredNow: [...new Set(requiredNow)],
    requiredLater: [...new Set(requiredLater.filter((entry) => !requiredNow.includes(entry)))],
    optional: [...new Set(optional.filter((entry) => !requiredNow.includes(entry) && !requiredLater.includes(entry)))],
  };
}

function buildReadinessDecision(input: {
  requiredNow: string[];
  workspacePrepared: boolean;
  repoMaterialPresent: boolean;
  manualStepRequired: boolean;
  riskLevel: string;
}) {
  if (input.requiredNow.length > 0) {
    return {
      readinessStatus: "blocked",
      recommendedNextStage: TARGET_SESSION_STAGE.AWAITING_CREDENTIALS,
      allowPlanning: false,
      allowShadowExecution: false,
      allowActiveExecution: false,
      quarantine: false,
      quarantineReason: null,
    };
  }

  if (!input.workspacePrepared || !input.repoMaterialPresent || input.manualStepRequired) {
    return {
      readinessStatus: "partial",
      recommendedNextStage: TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP,
      allowPlanning: false,
      allowShadowExecution: false,
      allowActiveExecution: false,
      quarantine: false,
      quarantineReason: null,
    };
  }

  if (input.riskLevel === "high") {
    return {
      readinessStatus: "quarantined",
      recommendedNextStage: TARGET_SESSION_STAGE.QUARANTINED,
      allowPlanning: false,
      allowShadowExecution: false,
      allowActiveExecution: false,
      quarantine: true,
      quarantineReason: "target risk remains too high for safe automated delivery",
    };
  }

  return {
    readinessStatus: "clarification_required",
    recommendedNextStage: TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION,
    allowPlanning: false,
    allowShadowExecution: false,
    allowActiveExecution: false,
    quarantine: false,
    quarantineReason: null,
  };
}

function buildDeterministicClarificationPacket(preparedSession: any, repoProfile: any, workspaceFacts: any) {
  const isEmptyRepo = repoProfile.repoState === "empty";
  const selectedAgentSlug = isEmptyRepo
    ? TARGET_EMPTY_REPO_ONBOARDING_AGENT_SLUG
    : TARGET_EXISTING_REPO_ONBOARDING_AGENT_SLUG;
  const questions = isEmptyRepo
    ? [
        {
          id: "product_goal",
          title: "What should BOX build?",
          prompt: "Describe the product or website you want from this empty repository.",
          answerMode: "hybrid",
          options: ["Landing page", "Business website", "Dashboard/Admin panel", "Reservation/booking system", "E-commerce", "Other"],
        },
        {
          id: "target_users",
          title: "Who is it for?",
          prompt: "Who will use this product and what do they need most?",
          answerMode: "hybrid",
          options: ["Customers", "Internal team", "Restaurant guests", "Store admins", "Mixed audience", "Other"],
        },
        {
          id: "must_have_flows",
          title: "What must exist in v1?",
          prompt: "Which flows or pages are non-negotiable for the first version?",
          answerMode: "multi_select",
          options: ["Homepage", "Contact form", "Booking flow", "Auth/Login", "Admin dashboard", "Payment", "Content management", "Other"],
        },
        {
          id: "quality_bar",
          title: "What matters most?",
          prompt: "Choose the main priority so BOX can optimize the first build correctly.",
          answerMode: "single_select",
          options: ["Fast MVP", "Strong design polish", "Operational reliability", "Business conversion", "Internal workflow speed"],
        },
      ]
    : [
        {
          id: "repo_purpose_confirmation",
          title: "What does this repo currently do?",
          prompt: "Confirm the current product purpose in your own words so BOX does not optimize the wrong thing.",
          answerMode: "hybrid",
          options: ["Marketing site", "SaaS app", "Internal admin tool", "API/backend service", "Storefront", "Other"],
        },
        {
          id: "target_users",
          title: "Who is this for?",
          prompt: "Who are the primary users of the current product, and which users matter most for this requested change?",
          answerMode: "hybrid",
          options: ["Customers", "Internal team", "Admins/staff", "Mixed audience", "Other"],
        },
        {
          id: "requested_change",
          title: "What change do you want?",
          prompt: "What should BOX improve or build in this existing repository?",
          answerMode: "hybrid",
          options: ["New feature", "Redesign", "Bug fixes", "Stability/performance", "Cleanup/refactor", "Launch-ready polish", "Other"],
        },
        {
          id: "protected_areas",
          title: "What must stay safe?",
          prompt: "Which areas, flows, or business rules should BOX avoid breaking?",
          answerMode: "hybrid",
          options: ["Payments", "Auth", "Admin workflows", "Production infra", "Content/data", "Brand/UI", "Other"],
        },
        {
          id: "success_signal",
          title: "How will you judge success?",
          prompt: "What outcome would make you say the target work is correct?",
          answerMode: "hybrid",
          options: ["Feature works end-to-end", "Design looks production-ready", "Tests are green", "Deployment is safe", "Operations become easier", "Other"],
        },
      ];

  return {
    schemaVersion: 1,
    mode: isEmptyRepo ? "empty_repo" : "existing_repo",
    selectedAgentSlug,
    repoState: repoProfile.repoState,
    repoStateReason: repoProfile.repoStateReason,
    meaningfulEntryPoints: repoProfile.meaningfulEntryPoints,
    dominantSignals: repoProfile.dominantSignals,
    workspaceFacts: {
      stack: workspaceFacts.stack,
      framework: workspaceFacts.framework,
      packageManager: workspaceFacts.packageManager,
      repoShape: workspaceFacts.repoShape,
      buildDetected: workspaceFacts.buildDetected,
      testDetected: workspaceFacts.testDetected,
      lintDetected: workspaceFacts.lintDetected,
      typecheckDetected: workspaceFacts.typecheckDetected,
      deployDetected: workspaceFacts.deployDetected,
    },
    openingPrompt: isEmptyRepo
      ? "The repository is effectively empty. Clarify what should be built before planning starts."
      : "The repository already contains product material. Clarify the current product and the exact change request before planning starts.",
    closingCriteria: [
      "User goal is concrete enough for planning.",
      "Scope boundaries are explicit enough to avoid accidental overbuild.",
      "Success criteria are concrete enough for Prometheus and Athena.",
    ],
    questions: questions.map((question: any) => ({
      ...question,
      semanticSlot: normalizeNullableString(question?.semanticSlot) || String(question.id || "question").trim(),
    })),
  };
}

async function requestClarificationPacketFromAgent(config: any, preparedSession: any, repoProfile: any, workspaceFacts: any) {
  const fallbackPacket = buildDeterministicClarificationPacket(preparedSession, repoProfile, workspaceFacts);
  const selectedAgentSlug = fallbackPacket.selectedAgentSlug;
  const mockPacketText = normalizeNullableString(config?.env?.mockTargetOnboardingClarificationPacket);

  if (mockPacketText) {
    try {
      const parsedMock = JSON.parse(mockPacketText);
      return normalizeClarificationPacket(parsedMock?.packet || parsedMock, fallbackPacket);
    } catch {
      return fallbackPacket;
    }
  }

  const command = normalizeNullableString(config?.env?.copilotCliCommand);
  if (!command) {
    return fallbackPacket;
  }

  const semanticSlots = fallbackPacket.questions.map((question: any) => String(question.semanticSlot || question.id || "").trim()).filter(Boolean);
  const prompt = [
    `You are ${selectedAgentSlug}, BOX's onboarding clarification agent for a target software-delivery session.`,
    "Your job is to decide what questions BOX should ask right now so the user's real intent becomes clear before planning.",
    "Do not assume the target is a website. It may be a CLI, backend, library, automation tool, dashboard, data system, game, or something else.",
    "Ask only 3-5 high-signal questions.",
    "Use concise, natural English.",
    "If you provide selectable options, always include \"Other\".",
    "Preserve machine-readable intent by setting semanticSlot to the closest canonical slot when possible.",
    `Preferred semantic slots for this repo state: ${semanticSlots.join(", ") || "product_goal, target_users, requested_change, protected_areas, success_signal"}.`,
    "Allowed answer modes: hybrid, single_select, multi_select.",
    "Return strict JSON only inside the final decision block.",
    "",
    "Required JSON shape:",
    "===DECISION===",
    JSON.stringify({
      packet: {
        openingPrompt: "string",
        closingCriteria: ["string"],
        questions: [
          {
            id: "machine_readable_id",
            semanticSlot: "canonical_slot_name",
            title: "short question title",
            prompt: "direct user-facing question",
            answerMode: "hybrid",
            options: ["Option A", "Option B", "Other"],
          },
        ],
      },
    }, null, 2),
    "===END===",
    "",
    "Context:",
    JSON.stringify({
      repoState: repoProfile.repoState,
      repoStateReason: repoProfile.repoStateReason,
      meaningfulEntryPoints: repoProfile.meaningfulEntryPoints,
      dominantSignals: repoProfile.dominantSignals,
      objectiveSummary: preparedSession.objective?.summary || null,
      desiredOutcome: preparedSession.objective?.desiredOutcome || null,
      acceptanceCriteria: preparedSession.objective?.acceptanceCriteria || [],
      stack: workspaceFacts.stack,
      framework: workspaceFacts.framework,
      repoShape: workspaceFacts.repoShape,
      buildDetected: workspaceFacts.buildDetected,
      testDetected: workspaceFacts.testDetected,
      lintDetected: workspaceFacts.lintDetected,
      typecheckDetected: workspaceFacts.typecheckDetected,
    }, null, 2),
  ].join("\n");

  const args = buildAgentArgs({
    agentSlug: agentFileExists(selectedAgentSlug) ? selectedAgentSlug : undefined,
    prompt,
    model: config?.roleRegistry?.targetOnboarding?.model || "Claude Sonnet 4.6",
    allowAll: false,
    noAskUser: true,
    autopilot: false,
    silent: true,
  });

  try {
    await appendProgress(
      config,
      `[ONBOARDING][AI] requesting clarification packet from ${selectedAgentSlug}`,
      {
        mode: preparedSession.currentMode,
        projectId: preparedSession.projectId,
        sessionId: preparedSession.sessionId,
      },
    );
    appendAgentLiveLog(config, {
      agentSlug: selectedAgentSlug,
      session: preparedSession,
      contextLabel: "onboarding_clarification_packet",
      status: "starting",
      message: `requesting dynamic clarification packet repoState=${String(repoProfile.repoState || "unknown")}`,
    });
    const result: any = await spawnAsync(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...(config?.env || {}) },
      timeoutMs: 120000,
    });
    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    const status = Number(result?.status ?? 1);
    const rawOutput = [stdout, stderr].filter(Boolean).join("\n");
    writeAgentDebugFile(config, {
      agentSlug: selectedAgentSlug,
      session: preparedSession,
      contextLabel: "onboarding_clarification_packet",
      prompt,
      result,
      metadata: {
        repoState: repoProfile.repoState || null,
      },
    });
    appendAgentLiveLogDetail(config, {
      agentSlug: selectedAgentSlug,
      session: preparedSession,
      contextLabel: "onboarding_clarification_packet",
      stage: "result",
      title: `onboarding clarification packet [exit=${status}]`,
      content: rawOutput || "(no output)",
    });
    const parsed = parseAgentOutput(rawOutput);
    const normalizedPacket = normalizeClarificationPacket(parsed?.parsed?.packet || parsed?.parsed, fallbackPacket);
    if (status === 0 && parsed?.ok && normalizedPacket) {
      return normalizedPacket;
    }
    await appendProgress(
      config,
      `[ONBOARDING][WARN] clarification packet agent fallback agent=${selectedAgentSlug} status=${status} parseOk=${parsed?.ok === true}`,
      {
        mode: preparedSession.currentMode,
        projectId: preparedSession.projectId,
        sessionId: preparedSession.sessionId,
      },
    );
  } catch (error: any) {
    await appendProgress(
      config,
      `[ONBOARDING][WARN] clarification packet agent error agent=${selectedAgentSlug} error=${String(error?.message || error || "unknown").slice(0, 160)}`,
      {
        mode: preparedSession.currentMode,
        projectId: preparedSession.projectId,
        sessionId: preparedSession.sessionId,
      },
    );
  }

  return fallbackPacket;
}

function buildIntentContractSkeleton(preparedSession: any, clarificationPacket: any) {
  return {
    schemaVersion: 1,
    projectId: preparedSession.projectId,
    sessionId: preparedSession.sessionId,
    status: "pending_clarification",
    repoState: clarificationPacket.repoState,
    selectedAgentSlug: clarificationPacket.selectedAgentSlug,
    objectiveSummary: preparedSession.objective?.summary || null,
    desiredOutcome: preparedSession.objective?.desiredOutcome || null,
    deliveryModeDecision: null,
    clarifiedIntent: {
      productType: null,
      targetUsers: [],
      mustHaveFlows: [],
      scopeIn: [],
      scopeOut: [],
      protectedAreas: [],
      preferredQualityBar: null,
      designDirection: null,
      deploymentExpectations: [],
      successCriteria: [],
    },
    assumptions: [],
    openQuestions: clarificationPacket.questions.map((question: any) => ({
      id: question.id,
      semanticSlot: normalizeNullableString(question.semanticSlot) || normalizeNullableString(question.id) || "question",
      title: question.title,
      prompt: question.prompt,
      answerMode: question.answerMode,
      options: Array.isArray(question.options) ? question.options : [],
    })),
    readyForPlanning: false,
    planningMode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

async function evaluateTargetReadiness(config: any, activeTargetSession: any, actor: string) {
  if (!activeTargetSession) {
    throw new Error("Target readiness evaluation requires an active target session");
  }

  const stateDir = config?.paths?.stateDir || path.join(process.cwd(), "state");
  const workspaceDir = config?.paths?.workspaceDir || path.join(process.cwd(), ".box-work");
  const preparedSession = await prepareTargetWorkspaceForSession(activeTargetSession, config);
  const fallbackWorkspace = getTargetWorkspacePath(workspaceDir, activeTargetSession.projectId, activeTargetSession.sessionId);
  const candidateWorkspacePath = normalizeNullableString(preparedSession.workspace?.path)
    || normalizeNullableString(preparedSession.repo?.localPath)
    || fallbackWorkspace;
  const workspacePath = candidateWorkspacePath || fallbackWorkspace;
  const workspacePrepared = await pathExists(workspacePath);
  const workspaceFacts = workspacePrepared
    ? await detectWorkspaceFacts(workspacePath)
    : {
        gitExists: false,
        packageJsonExists: false,
        packageManager: "unknown",
        stack: "unknown",
        framework: "unknown",
        repoShape: "single_repo",
        buildDetected: false,
        testDetected: false,
        lintDetected: false,
        typecheckDetected: false,
        deployDetected: false,
        privateRegistryRequired: false,
        deployPlatforms: [],
        databaseAccessDetected: false,
        optionalIntegrations: [],
        envExampleVariables: [],
        buildCommand: null,
        testCommand: null,
        lintCommand: null,
        typecheckCommand: null,
        workspaceEntries: [],
      };

  const provider = detectProvider(preparedSession.repo?.repoUrl || null);
  const credentialState = detectRequiredCredentials(provider, config, workspaceFacts, preparedSession);
  const requiredNow = credentialState.requiredNow;
  const requiredLater = credentialState.requiredLater;
  const optional = credentialState.optional;
  const bootstrapStatus = String(preparedSession.workspace?.bootstrap?.status || "").trim().toLowerCase();
  const bootstrapError = normalizeNullableString(preparedSession.workspace?.bootstrap?.lastError);
  const manualStepRequired = bootstrapStatus !== "awaiting_credentials" && (!workspacePrepared || !workspaceFacts.gitExists);
  const repoMaterialPresent = workspaceFacts.gitExists || workspaceFacts.packageJsonExists;
  const repoProfile = classifyRepoState(workspaceFacts, Array.isArray(workspaceFacts.workspaceEntries) ? workspaceFacts.workspaceEntries : []);
  const riskLevel = preparedSession.constraints?.protectedPaths?.length > 0 ? "medium" : "low";
  const confidenceScore = Math.max(0, Math.min(100,
    (workspacePrepared ? 30 : 0)
    + (repoMaterialPresent ? 20 : 0)
    + (workspaceFacts.buildDetected ? 10 : 0)
    + (workspaceFacts.testDetected ? 10 : 0)
    + (workspaceFacts.lintDetected ? 10 : 0)
    + (workspaceFacts.typecheckDetected ? 10 : 0)
    + (repoProfile.repoState === "existing" ? 10 : 0)
    - (requiredNow.length * 20)
    - (manualStepRequired ? 20 : 0)
  ));
  const decision = buildReadinessDecision({
    requiredNow,
    workspacePrepared,
    repoMaterialPresent,
    manualStepRequired,
    riskLevel,
  });

  const clarificationPacket = decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION
    ? await requestClarificationPacketFromAgent(config, preparedSession, repoProfile, workspaceFacts)
    : null;

  const blockers = [];
  if (requiredNow.length > 0) {
    blockers.push({
      code: "missing_credentials",
      message: bootstrapError || `Missing required credentials: ${requiredNow.join(", ")}`,
      severity: "high",
      userActionRequired: true,
    });
  }
  if (manualStepRequired) {
    blockers.push({
      code: "workspace_not_ready",
      message: "Target repository workspace is not checked out and ready yet.",
      severity: "medium",
      userActionRequired: true,
    });
  }
  if (decision.quarantine) {
    blockers.push({
      code: "quarantine_required",
      message: decision.quarantineReason,
      severity: "critical",
      userActionRequired: true,
    });
  }

  const requiredHumanInputs = blockers.filter((entry) => entry.userActionRequired).map((entry) => entry.message);
  if (clarificationPacket) {
    requiredHumanInputs.push(`Respond to ${clarificationPacket.selectedAgentSlug} so BOX can clarify the target intent before planning starts.`);
  }

  const onboardingReport = {
    schemaVersion: TARGET_ONBOARDING_SCHEMA_VERSION,
    agent: {
      slug: TARGET_ONBOARDING_AGENT_SLUG,
      executionMode: "ai_led_clarification_router_with_deterministic_fallback",
    },
    projectId: activeTargetSession.projectId,
    sessionId: activeTargetSession.sessionId,
    mode: activeTargetSession.currentMode,
    stage: TARGET_SESSION_STAGE.ONBOARDING,
    repo: {
      repoUrl: activeTargetSession.repo?.repoUrl || null,
      localPath: activeTargetSession.repo?.localPath || null,
      defaultBranch: activeTargetSession.repo?.defaultBranch || "main",
      vcsProvider: provider,
      repoState: repoProfile.repoState,
      repoStateReason: repoProfile.repoStateReason,
      meaningfulEntryPoints: repoProfile.meaningfulEntryPoints,
      dominantSignals: repoProfile.dominantSignals,
    },
    classification: {
      stack: workspaceFacts.stack,
      framework: workspaceFacts.framework,
      packageManager: workspaceFacts.packageManager,
      repoShape: workspaceFacts.repoShape,
      riskLevel,
    },
    readiness: {
      status: decision.readinessStatus,
      recommendedNextStage: decision.recommendedNextStage,
      readinessScore: confidenceScore,
    },
    prerequisites: {
      requiredNow,
      requiredLater,
      optional,
    },
    capabilities: {
      buildDetected: workspaceFacts.buildDetected,
      testDetected: workspaceFacts.testDetected,
      lintDetected: workspaceFacts.lintDetected,
      typecheckDetected: workspaceFacts.typecheckDetected,
      deployDetected: workspaceFacts.deployDetected,
    },
    baseline: {
      buildStatus: workspaceFacts.buildDetected ? "detected" : "not_detected",
      testStatus: workspaceFacts.testDetected ? "detected" : "not_detected",
      lintStatus: workspaceFacts.lintDetected ? "detected" : "not_detected",
      notes: [
        `workspacePrepared=${workspacePrepared}`,
        `repoMaterialPresent=${repoMaterialPresent}`,
        `repoState=${repoProfile.repoState}`,
      ],
    },
    blockers,
    clarification: clarificationPacket,
    nextAction: {
      owner: decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION ? "user" : "system",
      action: decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION
        ? `launch_${clarificationPacket?.selectedAgentSlug || "target_onboarding"}`
        : decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_CREDENTIALS
          ? "provide_required_credentials"
          : decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP
            ? "prepare_target_workspace"
            : decision.recommendedNextStage === TARGET_SESSION_STAGE.QUARANTINED
              ? "request_human_review"
              : "preserve_session_truth",
      reason: blockers[0]?.message || clarificationPacket?.openingPrompt || "Onboarding completed",
    },
    handoff: {
      allowPlanning: decision.allowPlanning,
      allowShadowExecution: decision.allowShadowExecution,
      allowActiveExecution: decision.allowActiveExecution,
      requiredHumanInputs,
      carriedContextSummary: `Repo precheck complete. repoState=${repoProfile.repoState}; stack=${workspaceFacts.stack}; framework=${workspaceFacts.framework}; packageManager=${workspaceFacts.packageManager}; nextStage=${decision.recommendedNextStage}; clarificationAgent=${clarificationPacket?.selectedAgentSlug || "none"}.`,
    },
  };

  const prerequisiteStatus = {
    projectId: activeTargetSession.projectId,
    sessionId: activeTargetSession.sessionId,
    requiredNow,
    requiredLater,
    optional,
    blockingNow: requiredNow.length > 0 || manualStepRequired,
    awaitingHumanInput: decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_CREDENTIALS
      || decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_MANUAL_STEP
      || decision.recommendedNextStage === TARGET_SESSION_STAGE.AWAITING_INTENT_CLARIFICATION,
    blockedReason: blockers[0]?.message || clarificationPacket?.openingPrompt || null,
  };

  const baseline = {
    projectId: activeTargetSession.projectId,
    sessionId: activeTargetSession.sessionId,
    buildStatus: onboardingReport.baseline.buildStatus,
    testStatus: onboardingReport.baseline.testStatus,
    lintStatus: onboardingReport.baseline.lintStatus,
    typecheckStatus: workspaceFacts.typecheckDetected ? "detected" : "not_detected",
    notes: onboardingReport.baseline.notes,
  };

  const nextSession = {
    ...preparedSession,
    currentStage: decision.recommendedNextStage,
    workspace: {
      ...preparedSession.workspace,
      path: workspacePath,
      prepared: workspacePrepared,
      preparedAt: workspacePrepared
        ? normalizeNullableString(preparedSession.workspace?.preparedAt) || new Date().toISOString()
        : null,
    },
    onboarding: {
      completed: true,
      reportPath: getTargetOnboardingReportPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId),
      recommendedNextStage: decision.recommendedNextStage,
      readiness: decision.readinessStatus,
      readinessScore: confidenceScore,
      baselineCaptured: true,
    },
    repoProfile: {
      repoState: repoProfile.repoState,
      repoStateReason: repoProfile.repoStateReason,
      analysisPath: getTargetRepoAnalysisPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId),
      analyzedAt: new Date().toISOString(),
      selectedOnboardingAgent: clarificationPacket?.selectedAgentSlug || null,
      meaningfulEntryPoints: repoProfile.meaningfulEntryPoints,
      dominantSignals: repoProfile.dominantSignals,
    },
    clarification: {
      ...preparedSession.clarification,
      status: clarificationPacket ? "pending" : preparedSession.clarification?.status || "pending",
      mode: clarificationPacket?.mode || preparedSession.clarification?.mode || "unknown",
      selectedAgentSlug: clarificationPacket?.selectedAgentSlug || null,
      packetPath: getTargetClarificationPacketPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId),
      transcriptPath: getTargetClarificationTranscriptPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId),
      intentContractPath: getTargetIntentContractPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId),
      questionCount: Array.isArray(clarificationPacket?.questions) ? clarificationPacket.questions.length : 0,
      pendingQuestions: Array.isArray(clarificationPacket?.questions) ? clarificationPacket.questions.map((question: any) => String(question.title || question.id || "question").trim()).filter(Boolean) : [],
      loopCount: preparedSession.clarification?.loopCount || 0,
      readyForPlanning: false,
      lastAskedAt: clarificationPacket ? new Date().toISOString() : preparedSession.clarification?.lastAskedAt || null,
      lastAnsweredAt: preparedSession.clarification?.lastAnsweredAt || null,
      completedAt: null,
    },
    prerequisites: prerequisiteStatus,
    gates: {
      allowPlanning: decision.allowPlanning,
      allowShadowExecution: decision.allowShadowExecution,
      allowActiveExecution: decision.allowActiveExecution,
      quarantine: decision.quarantine,
      quarantineReason: decision.quarantineReason,
    },
    lifecycle: {
      ...preparedSession.lifecycle,
      updatedAt: new Date().toISOString(),
    },
    handoff: {
      carriedContextSummary: onboardingReport.handoff.carriedContextSummary,
      requiredHumanInputs,
      lastAction: actor,
      nextAction: onboardingReport.nextAction.action,
    },
  };

  const intentContract = clarificationPacket ? buildIntentContractSkeleton(preparedSession, clarificationPacket) : null;
  const clarificationTranscript = clarificationPacket
    ? {
        schemaVersion: 1,
        projectId: preparedSession.projectId,
        sessionId: preparedSession.sessionId,
        status: "awaiting_user_response",
        turns: [],
        selectedAgentSlug: clarificationPacket.selectedAgentSlug,
        updatedAt: new Date().toISOString(),
      }
    : null;

    await appendProgress(
      config,
      `[ONBOARDING] repoState=${repoProfile.repoState} readiness=${decision.readinessStatus} nextStage=${decision.recommendedNextStage} clarificationAgent=${clarificationPacket?.selectedAgentSlug || "none"}`,
      {
        mode: preparedSession.currentMode,
        projectId: preparedSession.projectId,
        sessionId: preparedSession.sessionId,
      },
    );
    if (clarificationPacket) {
      await appendProgress(
        config,
        `[ONBOARDING][CLARIFICATION] agent=${clarificationPacket.selectedAgentSlug} mode=${clarificationPacket.mode} questions=${clarificationPacket.questions.length} repoState=${repoProfile.repoState}`,
        {
          mode: preparedSession.currentMode,
          projectId: preparedSession.projectId,
          sessionId: preparedSession.sessionId,
        },
      );
    }
    if (requiredNow.length > 0 || manualStepRequired || decision.quarantine) {
      await appendProgress(
        config,
        `[ONBOARDING][BLOCKERS] requiredNow=${requiredNow.length} manualStepRequired=${manualStepRequired} quarantined=${decision.quarantine}`,
        {
          mode: preparedSession.currentMode,
          projectId: preparedSession.projectId,
          sessionId: preparedSession.sessionId,
        },
      );
    }

  await Promise.all([
    writeJson(getTargetOnboardingReportPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), onboardingReport),
    writeJson(getTargetPrerequisiteStatusPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), prerequisiteStatus),
    writeJson(getTargetBaselinePath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), baseline),
    writeJson(getTargetRepoAnalysisPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), {
      schemaVersion: 1,
      projectId: preparedSession.projectId,
      sessionId: preparedSession.sessionId,
      repoState: repoProfile.repoState,
      repoStateReason: repoProfile.repoStateReason,
      meaningfulEntryPoints: repoProfile.meaningfulEntryPoints,
      dominantSignals: repoProfile.dominantSignals,
      workspaceFacts: onboardingReport.classification,
      analyzedAt: new Date().toISOString(),
    }),
    ...(clarificationPacket ? [writeJson(getTargetClarificationPacketPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), clarificationPacket)] : []),
    ...(clarificationTranscript ? [writeJson(getTargetClarificationTranscriptPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), clarificationTranscript)] : []),
    ...(intentContract ? [writeJson(getTargetIntentContractPath(stateDir, activeTargetSession.projectId, activeTargetSession.sessionId), intentContract)] : []),
  ]);

  const persistedSession = await saveActiveTargetSession(config, nextSession);
  return {
    session: persistedSession,
    report: onboardingReport,
    prerequisiteStatus,
    baseline,
  };
}

export async function runTargetOnboarding(config: any, activeTargetSession: any) {
  if (!activeTargetSession || activeTargetSession.currentStage !== TARGET_SESSION_STAGE.ONBOARDING) {
    throw new Error("Target onboarding requires an active session in onboarding stage");
  }
  return evaluateTargetReadiness(config, activeTargetSession, "onboarding_completed");
}

export async function refreshTargetSessionReadiness(config: any, activeTargetSession: any) {
  if (!activeTargetSession) {
    throw new Error("Target readiness refresh requires an active session");
  }
  return evaluateTargetReadiness(config, activeTargetSession, "readiness_refreshed");
}