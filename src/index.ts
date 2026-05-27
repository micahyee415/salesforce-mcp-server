#!/usr/bin/env node

/**
 * Salesforce MCP Server — entry point.
 *
 * Supports two transport modes:
 * - Local (default): StdioServerTransport — for Claude Desktop local dev/testing
 * - HTTP (when PORT env var is set): Express + StreamableHTTPServerTransport
 *   — for Cloud Run remote connector deployment with Google OAuth
 *
 * All 8 MCP tools are read-only. The SalesforceClient exposes zero write methods.
 */

import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";
import { homedir } from "os";

// Suppress dotenv v17 stdout banner — it contaminates MCP stdio transport
process.env.DOTENV_CONFIG_QUIET = "true";

// Load .env — check user-space config first, then fall back to project root
const __dirname = dirname(fileURLToPath(import.meta.url));
const configDir = resolve(homedir(), ".config", "salesforce-mcp");
const userEnv = resolve(configDir, ".env");
const projectEnv = resolve(__dirname, "..", ".env");
config({ path: existsSync(userEnv) ? userEnv : projectEnv });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SalesforceClient, SalesforceConfig } from "./salesforce-client.js";
import { registerSystemTools } from "./tools/system.js";
import { registerRecordTools } from "./tools/records.js";
import { registerQueryTools } from "./tools/query.js";
import { registerReportTools } from "./tools/reports.js";
import { verifyGoogleToken, extractBearerToken, AuthError } from "./auth.js";
import { logger } from "./logger.js";
import { RateLimiter } from "./rate-limiter.js";

// ── Helpers ──

function getEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function startupTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new Error(`Startup timed out after ${ms / 1000}s — check SF_INSTANCE_URL and your network connection.`)),
      ms
    )
  );
}

// ── Shared initialization (both modes use this) ──

async function initServer(isHttpMode: boolean): Promise<{
  client: SalesforceClient;
}> {
  const sfConfig: SalesforceConfig = {
    clientId: getEnv("SF_CLIENT_ID"),
    clientSecret: getEnv("SF_CLIENT_SECRET"),
    instanceUrl: getEnv("SF_INSTANCE_URL"),
    loginUrl: getEnv("SF_LOGIN_URL", "https://login.salesforce.com"),
    apiVersion: getEnv("SF_API_VERSION", "62.0"),
  };

  const client = new SalesforceClient(sfConfig);

  // ── Startup Health Check (with 15s timeout) ──
  console.error("Running startup diagnostics...");

  let healthOk = false;
  try {
    const health = await Promise.race([client.healthCheck(), startupTimeout(15_000)]);
    for (const check of health.checks) {
      const icon = check.status === "pass" ? "\u2713" : "\u2717";
      console.error(`  ${icon} ${check.name}: ${check.detail}`);
    }
    healthOk = health.ok;
  } catch (err) {
    console.error(`  \u2717 ${err instanceof Error ? err.message : err}`);
  }

  if (!healthOk) {
    if (isHttpMode) {
      console.error("\n  \u26a0 Startup diagnostics FAILED \u2014 server will start but Salesforce API calls will fail.");
      console.error("  Check SF_CLIENT_ID, SF_USERNAME, SF_PRIVATE_KEY, SF_LOGIN_URL, and SF_INSTANCE_URL.");
    } else {
      console.error("\nStartup diagnostics FAILED. Fix the issues above and restart.");
      process.exit(1);
    }
  } else {
    console.error("  All checks passed.\n");
  }

  return { client };
}

// ── Tool registration helper ──

function registerAllTools(server: McpServer, client: SalesforceClient, callerEmail: string): void {
  registerSystemTools(server, client, callerEmail);
  registerRecordTools(server, client, callerEmail);
  registerQueryTools(server, client, callerEmail);
  registerReportTools(server, client, callerEmail);
}

// ── Mode 1: Local stdio transport (default) ──

async function startStdio() {
  const { client } = await initServer(false);

  const server = new McpServer({
    name: "salesforce",
    version: "1.1.0",
  });

  // In stdio mode, caller is the integration user (no per-user auth)
  const callerEmail = getEnv("SF_USERNAME");
  registerAllTools(server, client, callerEmail);

  console.error("Salesforce MCP server v1.1.0 ready (stdio transport).");

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ── Mode 2: HTTP transport for Cloud Run ──

async function startHttp() {
  const { default: express } = await import("express");

  const port = parseInt(process.env.PORT ?? "8080", 10);
  const allowedDomain = process.env.ALLOWED_DOMAIN ?? "example.com";

  const { client } = await initServer(true);

  const rateLimiter = new RateLimiter(60, 60_000);
  const registerRateLimiter = new RateLimiter(10, 60_000); // 10 registrations/minute global

  // Creates a fresh McpServer per request (SDK constraint: one transport per server)
  function createMcpServer(callerEmail: string): McpServer {
    const s = new McpServer({ name: "salesforce", version: "1.1.0" });
    registerAllTools(s, client, callerEmail);
    return s;
  }

  const ALLOWED_ORIGINS = [
    "https://claude.ai",
    "https://api.claude.ai",
  ];

  const app = express();
  app.use(express.json({ limit: "256kb" }));

  // Security headers (defense-in-depth)
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  // ── Health check ──
  // Returns live Salesforce readiness rather than a hardcoded "ok".
  // Proactively refreshes the token if stale so the check never falsely degrades
  // during idle periods (no real Salesforce tool calls for >55 min).
  // Cloud Run health checks and uptime monitors rely on this being accurate.
  app.get("/health", async (_req, res) => {
    try {
      await client.keepAlive();
    } catch {
      res.status(503).json({
        status: "degraded",
        version: "1.1.0",
        transport: "http",
        salesforce: "unavailable",
      });
      return;
    }
    const ready = client.isReady();
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "degraded",
      version: "1.1.0",
      transport: "http",
      salesforce: ready ? "connected" : "unavailable",
    });
  });

  // ── OAuth discovery (RFC 9728) ──
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`;
    res.json({
      issuer: serverUrl,
      authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      token_endpoint: "https://oauth2.googleapis.com/token",
      registration_endpoint: `${serverUrl}/register`,
      scopes_supported: ["openid", "email", "profile"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });
  });

  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`;
    res.json({
      resource: serverUrl,
      authorization_servers: ["https://accounts.google.com"],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
    });
  });

  app.get("/.well-known/oauth-protected-resource/mcp", (_req, res) => {
    const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`;
    res.json({
      resource: `${serverUrl}/mcp`,
      authorization_servers: ["https://accounts.google.com"],
      scopes_supported: ["openid", "email", "profile"],
      bearer_methods_supported: ["header"],
    });
  });

  // ── Dynamic Client Registration (RFC 7591) ──
  app.post("/register", (req, res) => {
    const origin = req.headers.origin;
    const ip = req.ip ?? "unknown";

    // 1. Origin check — reject requests from non-Claude origins
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      logger.warn("Registration rejected — disallowed origin", { event: "registration", origin, ip, allowed: false });
      res.status(403).json({ error: "Registration not allowed from this origin." });
      return;
    }

    // 2. Global rate limit — 10 registrations/minute
    if (!registerRateLimiter.check("__register__")) {
      const retryAfter = registerRateLimiter.retryAfter("__register__");
      logger.warn("Registration rate limit exceeded", { event: "rate_limited", ip, retryAfter });
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: `Registration rate limit exceeded. Try again in ${retryAfter}s.` });
      return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      res.status(500).json({ error: "OAuth client credentials not configured on server." });
      return;
    }
    // Validate redirect_uris — only allow HTTPS URIs
    const redirectUris: string[] = (req.body?.redirect_uris ?? [])
      .filter((uri: unknown) => typeof uri === "string" && uri.startsWith("https://"));

    logger.info("Dynamic client registration request", {
      event: "registration",
      origin: origin ?? "none",
      ip,
      allowed: true,
    });

    // client_secret is required for OAuth authorization_code flow — MCP clients need it
    // to exchange auth codes for access tokens at Google's token endpoint (RFC 7591)
    res.status(201).json({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    });
  });

  // ── MCP endpoint ──
  app.all("/mcp", async (req, res) => {
    if (req.method === "OPTIONS") {
      const origin = req.headers.origin;
      const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
      res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
      res.status(204).end();
      return;
    }

    const startMs = Date.now();

    // Auth
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      logger.warn("Request rejected: missing auth token", { statusCode: 401 });
      const serverUrl = process.env.SERVER_URL ?? `http://localhost:${port}`;
      res.setHeader(
        "WWW-Authenticate",
        `Bearer resource_metadata="${serverUrl}/.well-known/oauth-protected-resource"`
      );
      res.status(401).json({ error: "Missing Authorization header. Use Bearer <Google OAuth token>." });
      return;
    }

    let userEmail: string;
    try {
      const authResult = await verifyGoogleToken(token, allowedDomain);
      userEmail = authResult.email;
      logger.info("User authenticated", { event: "login", userEmail });
    } catch (err) {
      if (err instanceof AuthError) {
        logger.warn("Request rejected: auth failed", { event: "auth_failure", statusCode: err.statusCode, reason: err.message });
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      logger.error("Request rejected: unexpected auth error", { event: "auth_failure", reason: String(err) });
      res.status(500).json({ error: "Authentication failed." });
      return;
    }

    // Rate limiting
    if (!rateLimiter.check(userEmail)) {
      const retryAfter = rateLimiter.retryAfter(userEmail);
      logger.warn("Request rejected: rate limit exceeded", { event: "rate_limited", userEmail, retryAfter });
      res.setHeader("Retry-After", String(retryAfter));
      res.status(429).json({ error: `Rate limit exceeded. Try again in ${retryAfter}s.` });
      return;
    }

    // Tool name for audit logging
    const tool: string | undefined =
      req.body?.method === "tools/call" ? req.body?.params?.name : req.body?.method;

    // CORS — restrict to known Claude domains
    const origin = req.headers.origin;
    const allowedOrigin = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

    // Per-request MCP server
    const mcpServer = createMcpServer(userEmail);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);

    logger.info("Tool request completed", {
      event: "usage",
      userEmail,
      tool,
      durationMs: Date.now() - startMs,
      statusCode: res.statusCode,
    });
  });

  const httpServer = app.listen(port, () => {
    console.error(`Salesforce MCP server v1.1.0 ready (HTTP transport on port ${port}).`);
    console.error(`  Health: http://localhost:${port}/health`);
    console.error(`  MCP:    http://localhost:${port}/mcp`);
    console.error(`  Domain: @${allowedDomain} accounts only`);
  });

  // Graceful shutdown — Cloud Run sends SIGTERM before killing the container.
  // Without this, in-flight MCP requests are hard-killed on every new deployment.
  process.on("SIGTERM", () => {
    console.error("SIGTERM received — draining connections...");
    httpServer.close(() => {
      console.error("HTTP server closed. Exiting.");
      process.exit(0);
    });
  });
}

// ── Entry point ──

const isHttpMode = !!process.env.PORT;

if (isHttpMode) {
  startHttp().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
} else {
  startStdio().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
