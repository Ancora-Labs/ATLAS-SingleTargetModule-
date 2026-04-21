/**
 * contract_health.ts — Worker startup contract health types and utilities.
 *
 * Exported separately from run_task.ts so that orchestrator, runtime gates,
 * and tests can import these helpers without triggering the main() entry point.
 *
 * Format: WORKER_CONTRACT_HEALTH=env_vars:<pass|fail|n/a>;payload:<pass|fail|n/a>;role:<pass|fail|n/a>
 */

export type ContractSlot = "pass" | "fail" | "n/a";

export interface ContractHealth {
  env_vars: ContractSlot;
  payload: ContractSlot;
  role: ContractSlot;
}

/**
 * Format a ContractHealth object as the canonical WORKER_CONTRACT_HEALTH= line.
 * The line is deterministic and machine-parseable.
 */
export function formatContractHealth(health: ContractHealth): string {
  return `WORKER_CONTRACT_HEALTH=env_vars:${health.env_vars};payload:${health.payload};role:${health.role}`;
}

/**
 * Parse a WORKER_CONTRACT_HEALTH= line back into a ContractHealth object.
 * Returns null if the line does not contain a valid health marker.
 *
 * Accepts both stdout (success) and stderr (failure) output lines.
 */
export function parseContractHealth(line: string): ContractHealth | null {
  const match = String(line || "").match(/WORKER_CONTRACT_HEALTH=([^\s\r\n]+)/);
  if (!match) return null;

  const parts = match[1].split(";");
  const slots: Partial<ContractHealth> = {};
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx) as keyof ContractHealth;
    const val = part.slice(idx + 1) as ContractSlot;
    if (key && (val === "pass" || val === "fail" || val === "n/a")) {
      slots[key] = val;
    }
  }

  if (!slots.env_vars || !slots.payload || !slots.role) return null;
  return slots as ContractHealth;
}

/**
 * Returns true when every contract slot is "pass" — the startup contract is healthy.
 * Returns false for any "fail" or "n/a" slot.
 */
export function isContractHealthy(health: ContractHealth): boolean {
  return health.env_vars === "pass" && health.payload === "pass" && health.role === "pass";
}

/**
 * Named startup-contract verification anchor.
 *
 * Emitted once per successful startup, after all contract slots pass.
 * Downstream gates use this marker to distinguish a freshly-verified
 * contract from a carry-forward WORKER_CONTRACT_HEALTH line present in
 * logs from a previous run — closing the recurring carry-forward
 * ambiguity.
 *
 * Format: WORKER_STARTUP_CONTRACT_ANCHOR=verified
 */
export const STARTUP_CONTRACT_ANCHOR_KEY = "WORKER_STARTUP_CONTRACT_ANCHOR";

/** Emit the named startup-contract verification anchor line. */
export function formatStartupContractAnchor(): string {
  return `${STARTUP_CONTRACT_ANCHOR_KEY}=verified`;
}

/**
 * Returns true when the given line contains the startup-contract
 * verification anchor — confirming this startup cycle completed all
 * contract checks.
 */
export function parseStartupContractAnchor(line: string): boolean {
  return String(line || "").includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`);
}
