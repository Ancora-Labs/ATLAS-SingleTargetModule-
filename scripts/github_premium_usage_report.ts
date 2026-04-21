#!/usr/bin/env node

import dotenv from "dotenv";

dotenv.config();

const username = process.argv[2] || process.env.GITHUB_USERNAME || "CanerDoqdu";
const year = Number(process.argv[3] || new Date().getUTCFullYear());
const month = Number(process.argv[4] || (new Date().getUTCMonth() + 1));

const token = process.env.GITHUB_FINEGRADED || process.env.GITHUB_TOKEN || "";

if (!token) {
  console.error("ERROR: Set GITHUB_FINEGRADED or GITHUB_TOKEN");
  process.exit(1);
}

const params = new URLSearchParams({
  year: String(year),
  month: String(month)
});

const url = `https://api.github.com/users/${encodeURIComponent(username)}/settings/billing/premium_request/usage?${params.toString()}`;

const response = await fetch(url, {
  method: "GET",
  headers: {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0"
  }
});

const text = await response.text();
console.log(`HTTP_STATUS=${response.status}`);

let body;
try {
  body = JSON.parse(text);
} catch {
  console.log(text);
  process.exit(response.ok ? 0 : 1);
}

if (!response.ok) {
  console.log(JSON.stringify(body, null, 2));
  process.exit(1);
}

const usageItems = Array.isArray(body.usageItems) ? body.usageItems : [];
console.log(`USER=${body.user || username}`);
console.log(`PERIOD=${year}-${String(month).padStart(2, "0")}`);
console.log(`USAGE_ITEMS=${usageItems.length}`);

if (usageItems.length > 0) {
  for (const item of usageItems) {
    const model = item.model || "unknown";
    const product = item.product || "unknown";
    const netQty = Number(item.netQuantity || 0);
    const netAmount = Number(item.netAmount || 0);
    const unitType = item.unitType || "units";
    console.log(`${product} | ${model} | net=${netQty} ${unitType} | amount=${netAmount}`);
  }
}

console.log("RAW_JSON_BEGIN");
console.log(JSON.stringify(body, null, 2));
console.log("RAW_JSON_END");
