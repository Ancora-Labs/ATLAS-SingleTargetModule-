import fs from "node:fs/promises";

export async function writeFallbackPatchNote(taskId: number | string, taskTitle: string): Promise<void> {
  const text = [
    `Task ${taskId}: ${taskTitle}`,
    "Copilot CLI unavailable, fallback provider produced no code changes.",
    "Use manual review or wire an alternative LLM provider."
  ].join("\n");

  await fs.writeFile("BOX_FALLBACK_NOTE.md", `${text}\n`, "utf8");
  console.error(`fallback-provider: copilot CLI not available, task ${taskId} cannot produce real code changes`);
}
