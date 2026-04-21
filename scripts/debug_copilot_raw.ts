import { spawnSync } from "node:child_process";

const prompt = "Respond with ONLY valid JSON, no other text: {\"status\":\"ok\",\"value\":42}";
const r = spawnSync("copilot", ["--allow-all-tools", "-p", prompt], {
  encoding: "utf8",
  env: process.env,
  windowsHide: true,
});

console.log("status:", r.status);
console.log("stdout length:", r.stdout?.length);
console.log("stderr length:", r.stderr?.length);
console.log("=== STDOUT FIRST 600 ===");
console.log(JSON.stringify(r.stdout?.slice(0, 600)));
console.log("=== STDERR FIRST 400 ===");
console.log(JSON.stringify(r.stderr?.slice(0, 400)));
