#!/usr/bin/env npx tsx

/**
 * Standalone script to verify Salesforce JWT Bearer auth works.
 * Run this after completing Phase 0 (Connected App + integration user + certificate).
 *
 * Usage:
 *   cd salesforce-mcp
 *   npx tsx scripts/verify-auth.ts
 *
 * What it checks:
 * 1. Environment variables are set
 * 2. Private key loads correctly
 * 3. JWT auth succeeds (token obtained)
 * 4. A simple SOQL query works (reads 1 Account record)
 * 5. Write operations are blocked (attempts to create an Account — should fail)
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import jsforce from "jsforce";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "..", ".env") });

async function main() {
  console.log("=== Salesforce JWT Auth Verification ===\n");

  // Step 1: Check env vars
  const requiredVars = ["SF_CLIENT_ID", "SF_USERNAME", "SF_INSTANCE_URL"];
  const missing = requiredVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error(`FAIL: Missing env vars: ${missing.join(", ")}`);
    console.error("Copy .env.example to .env and fill in the values.");
    process.exit(1);
  }
  console.log("1. Environment variables: OK");

  // Step 2: Load private key
  let privateKey: string;
  if (process.env.SF_PRIVATE_KEY) {
    privateKey = process.env.SF_PRIVATE_KEY.replace(/\\n/g, "\n");
    console.log("2. Private key loaded from SF_PRIVATE_KEY env var: OK");
  } else if (process.env.SF_PRIVATE_KEY_FILE) {
    const { readFileSync } = await import("fs");
    try {
      privateKey = readFileSync(process.env.SF_PRIVATE_KEY_FILE, "utf-8");
      console.log(`2. Private key loaded from file (${process.env.SF_PRIVATE_KEY_FILE}): OK`);
    } catch (err) {
      console.error(`FAIL: Cannot read key file: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  } else {
    console.error("FAIL: Set SF_PRIVATE_KEY or SF_PRIVATE_KEY_FILE in .env");
    process.exit(1);
  }

  // Step 3: JWT auth
  const loginUrl = process.env.SF_LOGIN_URL ?? "https://login.salesforce.com";
  const apiVersion = process.env.SF_API_VERSION ?? "62.0";

  const conn = new jsforce.Connection({
    loginUrl,
    instanceUrl: process.env.SF_INSTANCE_URL!,
    version: apiVersion,
  });

  try {
    await conn.authorize({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      client_id: process.env.SF_CLIENT_ID!,
      username: process.env.SF_USERNAME!,
      privateKey,
    } as jsforce.OAuth2Config);
    console.log(`3. JWT authentication: OK (token obtained)`);
    console.log(`   Instance URL: ${conn.instanceUrl}`);
  } catch (err) {
    console.error(`FAIL: JWT auth failed: ${err instanceof Error ? err.message : err}`);
    console.error("\nTroubleshooting:");
    console.error("  - Is the Connected App configured for JWT Bearer flow?");
    console.error("  - Was the certificate uploaded to the Connected App?");
    console.error("  - Is the integration user pre-authorized in the Connected App?");
    console.error(`  - Is the login URL correct? (current: ${loginUrl})`);
    process.exit(1);
  }

  // Step 4: Read test
  try {
    const result = await conn.query("SELECT Id, Name FROM Account LIMIT 1");
    if (result.totalSize > 0) {
      const record = result.records[0] as { Id: string; Name: string };
      console.log(`4. SOQL read test: OK (found Account: ${record.Name})`);
    } else {
      console.log("4. SOQL read test: OK (query ran but no Account records found — normal for new orgs)");
    }
  } catch (err) {
    console.error(`FAIL: SOQL query failed: ${err instanceof Error ? err.message : err}`);
    console.error("  The integration user may not have read access to Accounts.");
    process.exit(1);
  }

  // Step 5: Write test (should FAIL — verifies read-only profile)
  try {
    await conn.sobject("Account").create({ Name: "__MCP_AUTH_TEST_DELETE_ME__" });
    // If we get here, the write SUCCEEDED — that's bad
    console.error("WARNING: Write test SUCCEEDED — the integration user can create records!");
    console.error("  This means the 'API Read Only' profile has write permissions.");
    console.error("  Fix: Remove Create permission on Account from the profile.");
    // Clean up the test record
    try {
      const cleanup = await conn.query("SELECT Id FROM Account WHERE Name = '__MCP_AUTH_TEST_DELETE_ME__' LIMIT 1");
      if (cleanup.totalSize > 0) {
        await conn.sobject("Account").destroy((cleanup.records[0] as { Id: string }).Id);
        console.error("  (Test record cleaned up)");
      }
    } catch {
      // Best effort cleanup
    }
    process.exit(1);
  } catch {
    console.log("5. Write test: OK (blocked as expected — integration user is read-only)");
  }

  // Step 6: API limits
  const limitInfo = conn.limitInfo;
  if (limitInfo?.apiUsage) {
    console.log(`6. API usage: ${limitInfo.apiUsage.used} / ${limitInfo.apiUsage.limit} calls used today`);
  } else {
    console.log("6. API usage: (not available yet — will populate after more calls)");
  }

  console.log("\n=== All checks passed! Ready to build the MCP server. ===");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
