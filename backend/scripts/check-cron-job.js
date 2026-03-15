#!/usr/bin/env node

const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineVal] = value.split("=", 2);
    const key = rawKey.replace(/^--/, "");
    if (inlineVal !== undefined) {
      args[key] = inlineVal;
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      i += 1;
      continue;
    }
    args[key] = true;
  }
  return args;
}

function getBaseUrl(args) {
  const explicit = String(args.url || "").trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const envUrl = String(
    process.env.CRON_CHECK_BASE_URL ||
      process.env.BACKEND_BASE_URL ||
      process.env.BACKEND_URL ||
      process.env.API_BASE_URL ||
      ""
  ).trim();

  if (envUrl) return envUrl.replace(/\/+$/, "");
  return `http://localhost:${process.env.PORT || 4000}`;
}

function logResult(label, pass, details) {
  const icon = pass ? "[PASS]" : "[FAIL]";
  console.log(`${icon} ${label}`);
  if (details) console.log(`       ${details}`);
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function run() {
  const args = parseArgs(process.argv);
  const secret = String(args.secret || process.env.CRON_SECRET || "").trim();
  const baseUrl = getBaseUrl(args);
  const endpoint = `${baseUrl}/api/internal/cron/rental-reminders`;

  let hasFailure = false;
  console.log("Cron Job Health Check");
  console.log(`Target: ${endpoint}`);

  if (!secret) {
    logResult("CRON_SECRET configured", false, "Missing CRON_SECRET in env or --secret.");
    process.exit(1);
  } else {
    logResult("CRON_SECRET configured", true);
  }

  // 1) Unauthorized request should be blocked.
  try {
    const unauthorizedResponse = await fetch(endpoint);
    const blocked = unauthorizedResponse.status === 401;
    const body = await safeText(unauthorizedResponse);
    logResult(
      "Unauthorized request blocked",
      blocked,
      `Status=${unauthorizedResponse.status}${body ? ` Body=${body}` : ""}`
    );
    if (!blocked) hasFailure = true;
  } catch (error) {
    hasFailure = true;
    logResult(
      "Unauthorized request blocked",
      false,
      `Request error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 2) Authorized via Bearer token should succeed.
  try {
    const authorizedResponse = await fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${secret}`,
      },
    });
    const body = await safeText(authorizedResponse);
    const ok = authorizedResponse.status === 200;
    logResult(
      "Authorized request succeeds",
      ok,
      `Status=${authorizedResponse.status}${body ? ` Body=${body}` : ""}`
    );
    if (!ok) hasFailure = true;
  } catch (error) {
    hasFailure = true;
    logResult(
      "Authorized request succeeds",
      false,
      `Request error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 3) Authorized via query param should also succeed (matches cron-job.org setup).
  try {
    const queryUrl = `${endpoint}?secret=${encodeURIComponent(secret)}`;
    const authorizedQueryResponse = await fetch(queryUrl);
    const body = await safeText(authorizedQueryResponse);
    const ok = authorizedQueryResponse.status === 200;
    logResult(
      "Query secret request succeeds",
      ok,
      `Status=${authorizedQueryResponse.status}${body ? ` Body=${body}` : ""}`
    );
    if (!ok) hasFailure = true;
  } catch (error) {
    hasFailure = true;
    logResult(
      "Query secret request succeeds",
      false,
      `Request error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (hasFailure) {
    console.log("Result: FAILED");
    process.exit(1);
  }

  console.log("Result: OK");
}

run().catch((error) => {
  console.error("Unexpected script error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

