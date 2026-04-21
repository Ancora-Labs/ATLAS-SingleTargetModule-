import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const TEST_ROOT = path.join(ROOT, "tests");

async function collectTestFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".test.ts")) {
      out.push(fullPath);
    }
  }
}

async function main(): Promise<void> {
  // Accept explicit test file paths via CLI args (e.g. `npm test -- tests/core/foo.test.ts`)
  const cliFiles = process.argv.slice(2).filter((arg) => arg.endsWith(".test.ts"));

  let relativeFiles: string[];

  if (cliFiles.length > 0) {
    // Targeted mode: only run the specified test files
    relativeFiles = cliFiles.map((f) => path.relative(ROOT, path.resolve(ROOT, f)));
  } else {
    // Full suite: collect all test files
    const testFiles: string[] = [];
    await collectTestFiles(TEST_ROOT, testFiles);
    testFiles.sort();

    if (testFiles.length === 0) {
      console.log("No .test.ts files found under tests/.");
      process.exit(1);
    }

    relativeFiles = testFiles.map((filePath) => path.relative(ROOT, filePath));
  }

  const args = ["--import", "tsx", "--test", "--test-force-exit", "--test-concurrency=1", ...relativeFiles];

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(`[run_tests] fatal: ${String(error?.message || error)}`);
  process.exit(1);
});
