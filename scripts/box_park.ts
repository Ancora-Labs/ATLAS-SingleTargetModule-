import fs from "node:fs/promises";
import path from "node:path";
import { execSync, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const STATE_DAEMON_PATH = path.join(ROOT, "state", "daemon.pid.json");
const PARK_TIMEOUT_SEC = Math.max(30, Number(process.env.BOX_PARK_TIMEOUT_SEC || "900"));
const DASHBOARD_TIMEOUT_SEC = Math.max(5, Number(process.env.BOX_DASHBOARD_STOP_TIMEOUT_SEC || "30"));
const POLL_MS = Math.max(500, Number(process.env.BOX_PARK_POLL_MS || "2000"));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runSafe(command) {
  try {
    return execSync(command, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8"
    }).trim();
  } catch {
    return "";
  }
}

async function readDaemonPid() {
  try {
    const raw = await fs.readFile(STATE_DAEMON_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid || 0);
    return Number.isFinite(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function isDaemonProcessRunning(pid) {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    const output = runSafe(
      `powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if($p){$p.CommandLine}else{''}"`
    );
    return /src[\\/]cli\.js\s+start/i.test(String(output || ""));
  }

  const output = runSafe(`ps -p ${pid} -o command=`);
  return /src[\\/]cli\.js\s+start/i.test(String(output || ""));
}

function countWorkerContainers() {
  const output = runSafe('docker ps --filter "ancestor=box-worker:local" --format "{{.ID}}"');
  if (!output) {
    return 0;
  }
  return output.split(/\r?\n/).filter(Boolean).length;
}

function listDashboardPids() {
  if (process.platform === "win32") {
    const output = runSafe(
      "powershell -NoProfile -Command \"Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\\\/]dashboard[\\\\/]live_dashboard\\.ts' } | Select-Object -ExpandProperty ProcessId\""
    );
    return String(output || "")
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isFinite(pid) && pid > 0);
  }

  const output = runSafe("ps -eo pid=,command=");
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /node/.test(line) && /src[\\/]dashboard[\\/]live_dashboard\.ts/.test(line))
    .map((line) => Number(line.split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

function requestDaemonStop() {
  const result = spawnSync("node", ["--import", "tsx", "src/cli.ts", "stop"], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error(`failed to request daemon stop (exit=${result.status})`);
  }
}

async function waitForGracefulDrain() {
  const start = Date.now();
  while ((Date.now() - start) < (PARK_TIMEOUT_SEC * 1000)) {
    const pid = await readDaemonPid();
    const daemonRunning = pid > 0 && isDaemonProcessRunning(pid);
    const workers = countWorkerContainers();

    process.stdout.write(`[box:park] waiting drain | daemon=${daemonRunning ? "running" : "stopped"} workers=${workers}\n`);

    if (!daemonRunning && workers === 0) {
      return {
        drained: true,
        daemonRunning,
        workers
      };
    }

    if (!daemonRunning && workers > 0) {
      return {
        drained: false,
        daemonRunning,
        workers
      };
    }

    await sleep(POLL_MS);
  }

  const pid = await readDaemonPid();
  const daemonRunning = pid > 0 && isDaemonProcessRunning(pid);
  const workers = countWorkerContainers();
  return {
    drained: false,
    daemonRunning,
    workers
  };
}

function listWorkerContainerIds() {
  const output = runSafe('docker ps --filter "ancestor=box-worker:local" --format "{{.ID}}"');
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function gracefulStopWorkers() {
  const ids = listWorkerContainerIds();
  if (ids.length === 0) {
    return 0;
  }

  let stopped = 0;
  for (const id of ids) {
    const result = spawnSync("docker", ["stop", "--time", "20", id], {
      cwd: ROOT,
      stdio: "ignore"
    });
    if (result.status === 0) {
      stopped += 1;
      process.stdout.write(`[box:park] gracefully stopped orphan worker=${id}\n`);
    }
  }

  return stopped;
}

async function stopDashboardGracefully() {
  const pids = listDashboardPids();
  if (pids.length === 0) {
    process.stdout.write("[box:park] dashboard already stopped\n");
    return true;
  }

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      process.stdout.write(`[box:park] sent SIGTERM to dashboard pid=${pid}\n`);
    } catch {
      process.stdout.write(`[box:park] dashboard pid=${pid} not signalable\n`);
    }
  }

  const start = Date.now();
  while ((Date.now() - start) < (DASHBOARD_TIMEOUT_SEC * 1000)) {
    const remaining = listDashboardPids();
    if (remaining.length === 0) {
      process.stdout.write("[box:park] dashboard stopped gracefully\n");
      return true;
    }
    await sleep(500);
  }

  return false;
}

async function main() {
  process.stdout.write("[box:park] requesting graceful daemon stop\n");
  requestDaemonStop();

  process.stdout.write("[box:park] waiting for worker drain\n");
  const drainResult = await waitForGracefulDrain();

  // If daemon is already down but workers remain, stop those orphan workers with graceful Docker stop.
  if (!drainResult.drained && !drainResult.daemonRunning && drainResult.workers > 0) {
    process.stdout.write("[box:park] daemon is down but orphan workers remain, stopping them gracefully\n");
    gracefulStopWorkers();
  }

  const finalWorkers = countWorkerContainers();
  const drained = finalWorkers === 0;

  process.stdout.write("[box:park] stopping dashboard gracefully\n");
  const dashboardStopped = await stopDashboardGracefully();

  if (!drained) {
    process.stdout.write(`[box:park] timeout: daemon/workers still active after ${PARK_TIMEOUT_SEC}s (no force kill applied)\n`);
  }
  if (!dashboardStopped) {
    process.stdout.write(`[box:park] timeout: dashboard still active after ${DASHBOARD_TIMEOUT_SEC}s (no force kill applied)\n`);
  }

  if (drained && dashboardStopped) {
    process.stdout.write("[box:park] system parked safely\n");
    return;
  }

  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`[box:park] fatal: ${error?.message || error}`);
  process.exit(1);
});
