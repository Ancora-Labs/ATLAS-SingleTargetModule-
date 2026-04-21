import dotenv from "dotenv";
import { spawnSync } from "node:child_process";

dotenv.config();

const tok = process.env.COPILOT_GITHUB_TOKEN || process.env.GITHUB_FINEGRADED || "";
console.log("Host copilot token:", tok ? tok.slice(0, 15) + "..." : "EMPTY");

const r = spawnSync("docker", [
  "run", "--rm",
  "-e", "COPILOT_GITHUB_TOKEN",
  "-e", "GH_TOKEN",
  "-e", "GITHUB_TOKEN",
  "box-worker:local",
  "node", "-e",
  `console.log("COPILOT_GITHUB_TOKEN=" + (process.env.COPILOT_GITHUB_TOKEN || "EMPTY").slice(0, 10));
   console.log("GH_TOKEN=" + (process.env.GH_TOKEN || "EMPTY").slice(0, 10));
   console.log("GITHUB_TOKEN=" + (process.env.GITHUB_TOKEN || "EMPTY").slice(0, 10));`
], {
  encoding: "utf8",
  timeout: 30000,
  env: {
    ...process.env,
    COPILOT_GITHUB_TOKEN: tok,
    GH_TOKEN: tok,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN || ""
  }
});

console.log("--- Container output ---");
console.log(r.stdout || "(empty)");
if (r.stderr) console.log("STDERR:", r.stderr);
console.log("Exit:", r.status);
