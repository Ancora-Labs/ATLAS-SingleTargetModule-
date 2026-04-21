import { readFileSync } from "node:fs";

const s = readFileSync("state/debug_janus_raw_stdout.txt", "utf8");

const fenceMatch = s.match(/```json\s*([\s\S]*?)```/);
if (fenceMatch) {
  try {
    const parsed = JSON.parse(fenceMatch[1].trim());
    console.log("FENCE PARSE OK — mode:", parsed.mode, "| health:", parsed.systemHealth);
  } catch (e) {
    console.log("FENCE PARSE FAILED:", e.message);
  }
} else {
  console.log("NO FENCE FOUND");
}

