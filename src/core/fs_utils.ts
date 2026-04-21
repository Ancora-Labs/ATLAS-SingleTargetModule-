import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Exhaustive reason enum for writeJsonAtomic / writeJsonAtomicSafe outcomes.
 * - NULL_VALUE:        value is null or undefined (missing input)
 * - NOT_SERIALIZABLE:  JSON.stringify threw — value cannot be serialized (invalid input)
 * - TEMP_WRITE_FAILED: writing the temporary file failed (filesystem error)
 * - RENAME_FAILED:     atomic rename from tmp → final path failed (filesystem error)
 */
export const WRITE_JSON_REASON = Object.freeze({
  NULL_VALUE: "null_value",
  NOT_SERIALIZABLE: "not_serializable",
  TEMP_WRITE_FAILED: "temp_write_failed",
  RENAME_FAILED: "rename_failed"
});

/**
 * writeJsonAtomicSafe — atomic write with structured outcome contract.
 *
 * Algorithm:
 *   1. Validate value (not null/undefined, JSON-serializable).
 *   2. Write serialized content to <filePath>.tmp.
 *   3. Rename <filePath>.tmp → <filePath> (atomic on POSIX; best-effort on Windows).
 *   4. On any failure: clean up the .tmp file, return structured error.
 *
 * Returns: { ok: boolean, reason: WRITE_JSON_REASON|null, error: Error|null }
 *   ok=true  → file written atomically, reason and error are null
 *   ok=false → reason is one of WRITE_JSON_REASON.*, error is the raw Error
 *
 * Never throws. Distinguishes missing input (NULL_VALUE) from invalid input
 * (NOT_SERIALIZABLE) from filesystem errors (TEMP_WRITE_FAILED / RENAME_FAILED).
 */
export async function writeJsonAtomicSafe(filePath, value) {
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason: WRITE_JSON_REASON.NULL_VALUE,
      error: new TypeError(`writeJsonAtomic: value must not be null or undefined (path=${filePath})`)
    };
  }

  let content;
  try {
    content = `${JSON.stringify(value, null, 2)}\n`;
  } catch (serErr) {
    return { ok: false, reason: WRITE_JSON_REASON.NOT_SERIALIZABLE, error: serErr };
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    await ensureParent(filePath);
    await fs.writeFile(tmpPath, content, "utf8");
  } catch (writeErr) {
    try { await fs.rm(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: WRITE_JSON_REASON.TEMP_WRITE_FAILED, error: writeErr };
  }

  try {
    await fs.rename(tmpPath, filePath);
  } catch (renameErr) {
    try { await fs.rm(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: WRITE_JSON_REASON.RENAME_FAILED, error: renameErr };
  }

  return { ok: true, reason: null, error: null };
}

/**
 * writeJsonAtomic — atomic write that throws on failure.
 *
 * Uses temp-file + rename to prevent truncated JSON on crash or kill.
 * Thrown errors carry a `reason` property from WRITE_JSON_REASON for
 * machine-readable diagnostics.
 *
 * Callers that need structured outcomes without throwing: use writeJsonAtomicSafe.
 */
export async function writeJsonAtomic(filePath, value) {
  const result = await writeJsonAtomicSafe(filePath, value);
  if (!result.ok) {
    const err = result.error || new Error(`writeJsonAtomic failed: reason=${result.reason} path=${filePath}`);
    err.reason = result.reason;
    throw err;
  }
}

/**
 * cleanupStaleTempFiles — remove leftover .tmp files from a crashed atomic write.
 *
 * Called at daemon/orchestrator startup to ensure no partial-write artifacts
 * remain from a previous crash or kill. Removal is best-effort: individual
 * file failures are silently skipped, but the overall scan continues.
 *
 * Returns: { ok: boolean, removed: string[], error: Error|null }
 *   ok=true  → scan completed (even if some files could not be removed)
 *   ok=false → directory could not be read (error is the raw Error)
 */
export async function cleanupStaleTempFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    const removed = [];
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) {
        try {
          await fs.rm(path.join(dir, entry), { force: true });
          removed.push(entry);
        } catch { /* already gone — skip */ }
      }
    }
    return { ok: true, removed, error: null };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, removed: [], error: null };
    return { ok: false, removed: [], error: err };
  }
}

/**
 * Exhaustive reason enum for readJson/readJsonSafe outcomes.
 * - MISSING: file does not exist (ENOENT)
 * - INVALID: file exists but JSON.parse failed, or an unexpected read error occurred
 */
export const READ_JSON_REASON = Object.freeze({
  MISSING: "missing",
  INVALID: "invalid"
});

/**
 * readTextSafe — structured outcome contract for UTF-8 text file reads.
 *
 * Returns: { ok: boolean, data: string|null, reason: 'missing'|'invalid'|null, error: Error|null }
 *   ok=true  → data contains file content, reason and error are null
 *   ok=false → data is null, reason is READ_JSON_REASON.MISSING or .INVALID, error is the raw Error
 *
 * Never throws.
 */
export async function readTextSafe(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return { ok: true, data, reason: null, error: null };
  } catch (readErr) {
    const reason = readErr.code === "ENOENT" ? READ_JSON_REASON.MISSING : READ_JSON_REASON.INVALID;
    return { ok: false, data: null, reason, error: readErr };
  }
}

/**
 * readJsonSafe — structured outcome contract for JSON file reads.
 *
 * Returns: { ok: boolean, data: any|null, reason: 'missing'|'invalid'|null, error: Error|null }
 *   ok=true  → data contains parsed object, reason and error are null
 *   ok=false → data is null, reason is READ_JSON_REASON.MISSING or .INVALID, error is the raw Error
 *
 * Never throws. Never silently swallows errors — callers receive full diagnostic information.
 */
export async function readJsonSafe(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (readErr) {
    const reason = readErr.code === "ENOENT" ? READ_JSON_REASON.MISSING : READ_JSON_REASON.INVALID;
    return { ok: false, data: null, reason, error: readErr };
  }
  try {
    const data = JSON.parse(raw);
    return { ok: true, data, reason: null, error: null };
  } catch (parseErr) {
    return { ok: false, data: null, reason: READ_JSON_REASON.INVALID, error: parseErr };
  }
}

/**
 * readJson — backward-compatible convenience wrapper around readJsonSafe.
 *
 * Emits a `box:readError` event on process for every read failure, ensuring
 * no error is silently swallowed.  The event payload is:
 *   { filePath: string, reason: 'missing'|'invalid', error: Error, timestamp: string }
 *
 * For critical state files that must NOT fall back silently, use readJsonSafe
 * directly and inspect the structured outcome.
 *
 * Classification:
 *   Non-critical callers: pass a fallback value here — they get the fallback on
 *     any failure, but the event is still emitted for telemetry.
 *   Critical callers: call readJsonSafe and handle { ok, reason } explicitly.
 */
export async function readJson(filePath, fallback) {
  const result = await readJsonSafe(filePath);
  if (!result.ok) {
    process.emit("box:readError", {
      filePath,
      reason: result.reason,
      error: result.error,
      timestamp: new Date().toISOString()
    });
    return fallback;
  }
  return result.data;
}

/**
 * readText — backward-compatible convenience wrapper around readTextSafe.
 *
 * Emits a `box:readError` event on process for every read failure, ensuring
 * no error is silently swallowed.
 */
export async function readText(filePath, fallback = "") {
  const result = await readTextSafe(filePath);
  if (!result.ok) {
    process.emit("box:readError", {
      filePath,
      reason: result.reason,
      error: result.error,
      timestamp: new Date().toISOString()
    });
    return fallback;
  }
  return result.data;
}

/**
 * writeJson — backward-compatible convenience wrapper around writeJsonAtomic.
 *
 * All writes go through temp-file + atomic rename.
 * Throws on failure (same contract as before this change).
 */
export async function writeJson(filePath, value) {
  await writeJsonAtomic(filePath, value);
}

export function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdinInput = options.input || null;
    // Always keep stdin as pipe so we can write '\n' to answer CLI prompts
    // (e.g. "Do you want to continue?") without restarting the process.
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (stdinInput) {
      child.stdin.write(stdinInput);
      child.stdin.end();
    }
    // earlyExitMarker: if set, kill the child process as soon as the marker
    // appears in stdout — avoids waiting for CLI process exit when the model
    // has already emitted a terminal output boundary (e.g. ===END===).
    const earlyExitMarker: string | undefined = options.earlyExitMarker;
    let earlyExitBuffer = "";

    // autoConfirmPatterns: when stdout matches any of these patterns the process
    // is asking for user confirmation. We write '\n' (Enter / default Yes) to
    // stdin so the CLI continues unattended rather than blocking indefinitely.
    // Patterns cover Copilot CLI's "Do you want to continue?" and similar prompts.
    const autoConfirmPatterns: RegExp[] = options.autoConfirmPatterns ?? [
      /do you want to continue/i,
      /continue\?/i,
      /press enter to continue/i,
      /\(y\/n\)/i,
      /\[y\/N\]/i,
      /\[Y\/n\]/i,
    ];
    const autoConfirm: boolean = options.autoConfirm !== false; // default true
    let autoConfirmBuffer = "";

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      if (options.onStdout) options.onStdout(chunk);

      const text = chunk.toString("utf8");

      // Auto-answer continuation prompts by sending Enter to stdin.
      if (autoConfirm && !settled && child.stdin && !child.stdin.destroyed) {
        autoConfirmBuffer += text;
        // Keep buffer bounded to last 512 chars — we only need recent output
        if (autoConfirmBuffer.length > 512) {
          autoConfirmBuffer = autoConfirmBuffer.slice(-512);
        }
        for (const pattern of autoConfirmPatterns) {
          if (pattern.test(autoConfirmBuffer)) {
            autoConfirmBuffer = ""; // reset so we don't double-fire
            try { child.stdin.write("\n"); } catch { /* stdin may have closed */ }
            break;
          }
        }
      }

      if (earlyExitMarker && !settled) {
        earlyExitBuffer += text;
        if (earlyExitBuffer.includes(earlyExitMarker)) {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          resolve({
            status: 0,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            earlyExit: true
          });
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (options.onStderr) options.onStderr(chunk);
    });

    let settled = false;
    const timeoutMs = options.timeoutMs === null
      ? 0
      : (options.timeoutMs ?? 45 * 60 * 1000); // 45-minute default
    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
          resolve({
            status: -1,
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
            stderr: `[ATLAS] Process killed after ${timeoutMs / 1000}s timeout`,
            timedOut: true
          });
        }, timeoutMs)
      : null;

    // AbortSignal support — lets the caller kill the child early
    if (options.signal) {
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        resolve({
          status: -1,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: String(options.signal.reason || "[ATLAS] Process aborted via signal"),
          aborted: true
        });
      };
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout: "", stderr: String(err.message) });
    });
  });
}

// ── Incremental source signature index ───────────────────────────────────────
// Module-level in-memory cache: filePath → { hash, found: Set<string> }.
// Persists for the lifetime of the process so repeated calls within the same
// cycle only re-scan files whose content hash has changed.
const _sourceSignatureCache = new Map<string, { hash: string; found: Set<string> }>();

/**
 * Collect all .ts/.js files recursively from a directory (async, no sync I/O).
 */
async function collectSignatureSrcFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, String(entry.name));
      if (entry.isDirectory()) {
        const sub = await collectSignatureSrcFiles(fullPath);
        files.push(...sub);
      } else if (entry.isFile() && (String(entry.name).endsWith(".ts") || String(entry.name).endsWith(".js"))) {
        files.push(fullPath);
      }
    }
  } catch {
    // Non-fatal: return whatever we collected before the error
  }
  return files;
}

/**
 * Build an incremental per-file signature presence index.
 *
 * Algorithm:
 *   1. Collect all .ts/.js files under srcDir recursively.
 *   2. For each file, read content and compute SHA-256 hash.
 *   3. Cache hit (same path + hash): reuse stored Set<string> of found signatures.
 *   4. Cache miss: scan lowercased content for each allSignatures entry and cache.
 *   5. Return the union Set<string> of all found signatures across all files.
 *
 * This reduces audit latency from O(N×fileSize) full concatenation on every call
 * to O(changedFiles×fileSize) after the first warm call in a process lifetime.
 *
 * @param srcDir        — directory to scan (e.g. path.join(repoRoot, "src"))
 * @param allSignatures — lowercase signature strings to detect presence of
 * @returns             — Set<string> of all signatures found across any source file
 */
export async function buildIncrementalSignatureIndex(
  srcDir: string,
  allSignatures: readonly string[],
): Promise<Set<string>> {
  const result = new Set<string>();
  if (!Array.isArray(allSignatures) || allSignatures.length === 0) return result;

  let files: string[];
  try {
    files = await collectSignatureSrcFiles(srcDir);
  } catch {
    return result;
  }

  for (const filePath of files) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const hash = createHash("sha256").update(content).digest("hex");

      const cached = _sourceSignatureCache.get(filePath);
      if (cached && cached.hash === hash) {
        for (const sig of cached.found) result.add(sig);
        continue;
      }

      // Cache miss: scan file for all target signatures
      const lower = content.toLowerCase();
      const found = new Set<string>();
      for (const sig of allSignatures) {
        if (lower.includes(sig)) found.add(sig);
      }
      _sourceSignatureCache.set(filePath, { hash, found });
      for (const sig of found) result.add(sig);
    } catch {
      // Skip unreadable files — non-fatal
    }
  }

  return result;
}
