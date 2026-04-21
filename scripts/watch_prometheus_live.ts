import fs from "node:fs";
import path from "node:path";

const stateDir = process.argv[2] || "state";
const liveLogPath = path.join(stateDir, "live_worker_prometheus.log");

function tailFile(filePath, label) {
  let lastSize = 0;

  const printNew = () => {
    fs.stat(filePath, (err, stats) => {
      if (err || !stats || !stats.isFile()) return;
      const size = stats.size;
      if (size < lastSize) lastSize = 0;
      if (size === lastSize) return;

      const stream = fs.createReadStream(filePath, {
        start: lastSize,
        end: size - 1,
        encoding: "utf8"
      });

      let chunk = "";
      stream.on("data", (d) => {
        chunk += d;
      });
      stream.on("end", () => {
        if (chunk.trim().length > 0) {
          process.stdout.write(`\n[${label}]\n${chunk}`);
        }
        lastSize = size;
      });
    });
  };

  // Initial read
  printNew();

  fs.watch(path.dirname(filePath), { persistent: true }, (_eventType, filename) => {
    if (!filename) return;
    if (path.basename(filePath) === filename.toString()) {
      printNew();
    }
  });
}

console.log(`[watch] stateDir=${stateDir}`);
console.log(`[watch] watching: ${liveLogPath}`);
console.log("[watch] press Ctrl+C to stop\n");

tailFile(liveLogPath, "live_worker_prometheus");
