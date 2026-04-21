import "dotenv/config";

const adminKey = process.env.CLAUDE_ADMIN_API_KEY || process.env.ANTHROPIC_ADMIN_API_KEY;

if (!adminKey) {
  console.log("ERROR: CLAUDE_ADMIN_API_KEY/ANTHROPIC_ADMIN_API_KEY not set");
  process.exit(1);
}

const now = new Date();
const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
url.searchParams.set("starting_at", start.toISOString().replace(".000", ""));
url.searchParams.set("ending_at", end.toISOString().replace(".000", ""));
url.searchParams.append("group_by[]", "workspace_id");
url.searchParams.append("group_by[]", "description");
url.searchParams.set("limit", "31");

const res = await fetch(url.toString(), {
  method: "GET",
  headers: {
    "anthropic-version": "2023-06-01",
    "x-api-key": adminKey,
    "user-agent": "BOX/1.0"
  }
});

const body = await res.text();
console.log(`HTTP_STATUS=${res.status}`);
console.log("RAW_RESPONSE_BEGIN");
console.log(body);
console.log("RAW_RESPONSE_END");
