import { loadConfig } from "../src/config.js";
import { recomputeAutonomyBandStatus } from "../src/core/autonomy_band_monitor.js";

async function main() {
  const config = await loadConfig();
  const status = await recomputeAutonomyBandStatus(config, {
    preserveStateTimestamps: true,
    write: true,
  });

  const payload = {
    state: status.state,
    exploitationReady: status.executionGate.exploitationReady,
    premiumEfficiencyMet: status.thresholdChecks.premiumEfficiencyMet,
    allMet: status.thresholdChecks.allMet,
    updatedAt: status.updatedAt,
    cycleCount: status.cycleCount,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((error) => {
  console.error(String(error?.stack || error?.message || error));
  process.exitCode = 1;
});