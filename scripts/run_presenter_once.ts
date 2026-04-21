import { loadConfig } from "../src/config.js";
import {
  evaluateTargetSuccessContract,
  performTargetDeliveryHandoff,
} from "../src/core/target_success_contract.js";
import { loadLastArchivedTargetSession } from "../src/core/target_session_state.js";

const config = await loadConfig();
const archivedSession = await loadLastArchivedTargetSession(config);

if (!archivedSession) {
  console.error("PRESENTER_ERROR no archived target session available");
  process.exit(1);
}

const report = await evaluateTargetSuccessContract(config, archivedSession);

if (!["fulfilled", "fulfilled_with_handoff"].includes(String(report?.status || ""))) {
  console.error(`PRESENTER_ERROR target not ready for handoff status=${String(report?.status || "unknown")}`);
  process.exit(1);
}

const handoff = await performTargetDeliveryHandoff(config, report);
const finalTarget = handoff?.autoOpen?.execution?.finalTarget
  || handoff?.delivery?.openTarget
  || handoff?.delivery?.primaryLocation
  || null;

console.log(JSON.stringify({
  ok: true,
  sessionId: archivedSession.sessionId,
  projectId: archivedSession.projectId,
  status: handoff?.delivery?.status || report?.status || null,
  autoOpen: handoff?.autoOpen || null,
  finalTarget,
  summary: handoff?.summary || report?.summary || null,
}, null, 2));