# salesforce-mcp

> A read-only Model Context Protocol (MCP) server for Salesforce — SOQL queries, SOSL full-text search, saved report execution, schema discovery, and bulk record fetch — deployable on Google Cloud Run with Google OAuth.

![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?logo=typescript&logoColor=white)
![MCP SDK](https://img.shields.io/badge/MCP_SDK-1.x-blueviolet)
![Node](https://img.shields.io/badge/Node.js-22-339933?logo=node.js&logoColor=white)
![Cloud Run](https://img.shields.io/badge/Deploy-Cloud_Run-4285f4?logo=google-cloud&logoColor=white)

---

## Overview

`salesforce-mcp` exposes your Salesforce org as a set of structured read-only tools that any MCP-compatible client (Claude Desktop, Claude.ai remote connectors, etc.) can call conversationally.

**Design principles:**

- **Strictly read-only.** `SalesforceClient` exposes zero write methods. `sanitizeSOQL` blocks `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `UPSERT`, and `UNDELETE` at the validation layer, and the integration user's Salesforce profile enforces read-only permissions as the primary control. No amount of prompt engineering can trigger a write.
- **Dedicated integration user.** The server authenticates via Salesforce's OAuth Client Credentials flow using a named integration user with a read-only profile — not a shared admin account. This limits blast radius, enables per-user audit trails in Salesforce, and makes it easy to revoke access.
- **SOC 2-style audit logging.** Every tool call logs the caller's email, the tool name, relevant query details (with string literals redacted to prevent PII in logs), and duration. Bulk record access (`get_records`) emits dedicated audit entries.
- **Dual transport.** Runs as a local stdio server for Claude Desktop or as an authenticated HTTP server on Cloud Run for shared/remote deployments.

---

## MCP Tools

| Tool | Description |
|---|---|
| `query_records` | Execute a SOQL `SELECT` query. Supports pagination via `cursor` (up to 5,000 records per page). |
| `search_records` | SOSL full-text search across Salesforce objects. Returns up to 200 records per object. |
| `get_record` | Fetch a single record by SObject type and ID, with optional field selection. |
| `get_records` | Batch-fetch up to 200 records by ID in one call. Missing IDs return stub errors rather than failing the call. |
| `list_objects` | List all queryable SObject types in the org (e.g. Account, Contact, Opportunity). |
| `describe_object` | Inspect an SObject's fields, types, relationships, and picklist values. |
| `list_reports` | Discover saved reports the integration user can access, with name/folder filters. |
| `describe_report` | Inspect a report's columns and current filter criteria before running it. |
| `run_report` | Execute a saved report by ID. Supports `filterOverrides` to run with different filter values without editing the saved report. Detail rows capped at 2,000. |
| `get_current_user` | Show the authenticated Salesforce integration user's info and org ID. |
| `get_api_limits` | Show current Salesforce API usage and daily limits. |

---

## Architecture

```
MCP Client (Claude Desktop / Claude.ai)
        │
        │  stdio (local)  ─── or ───  HTTPS Bearer (remote)
        │
┌───────▼───────────────────────────────────────────────────┐
│                    salesforce-mcp                         │
│                                                           │
│  Transport layer                                          │
│  ├── StdioServerTransport  (local dev / Claude Desktop)   │
│  └── StreamableHTTPServerTransport  (Cloud Run)           │
│       ├── Google OAuth token verification                 │
│       │   ├── Domain check  (@yourdomain.com only)        │
│       │   └── Audience check  (aud === GOOGLE_CLIENT_ID)  │
│       ├── Per-user rate limiting  (60 req/min)            │
│       └── CORS  (claude.ai origins only)                  │
│                                                           │
│  MCP Server (per-request in HTTP mode)                    │
│  └── 11 read-only tools                                   │
│                                                           │
│  SalesforceClient  (jsforce wrapper)                      │
│  ├── Client Credentials OAuth  (server-to-server)         │
│  ├── Token refresh with mutex (no thundering herd)        │
│  ├── Exponential backoff retry (429/5xx)                  │
│  ├── 30s request timeout                                  │
│  └── TTL caches (schema: 30 min, records: 2 min)         │
└───────────────────────────────────────────────────────────┘
        │
        │  REST API  (SOQL / SOSL / Reports / Metadata)
        │
┌───────▼───────┐
│  Salesforce   │
│  (read-only   │
│  integration  │
│  user)        │
└───────────────┘
```

### Google OAuth (HTTP mode)

In Cloud Run mode every request must carry a Google OAuth Bearer token. `verifyGoogleToken` in `src/auth.ts` validates it via Google's `tokeninfo` endpoint, enforcing three checks:

1. **Email domain** — only `@yourdomain.com` accounts (configured via `ALLOWED_DOMAIN`).
2. **Audience (`aud`)** — the token must have been issued for this specific OAuth client (`GOOGLE_CLIENT_ID`), not reused from another Google-integrated app.
3. **Email verified** — Google must confirm the email is verified.

Tokens are cached by SHA-256 hash (not the raw token) for up to 60 seconds, so rapid MCP sub-calls within a single tool invocation don't hammer Google, while revoked tokens (e.g. offboarded employees) expire quickly.

### Salesforce Authentication

Uses **OAuth 2.0 Client Credentials flow** — a server-to-server flow requiring no user interaction or certificate rotation. The Connected App in Salesforce must have "Enable Client Credentials Flow" enabled and the integration user's profile assigned.

### Dynamic Client Registration (RFC 7591)

The `/register` endpoint implements RFC 7591 so MCP clients (like Claude.ai) can self-register. Registrations are origin-checked (`claude.ai` only) and rate-limited (10/minute globally).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5.x, Node.js 22 |
| MCP SDK | `@modelcontextprotocol/sdk` 1.x |
| HTTP server | Express 5 |
| Salesforce client | jsforce 3.x |
| Validation | Zod 4, custom SOQL/SOSL sanitizers |
| Testing | Vitest |
| Container | Docker (multi-stage, non-root runtime) |
| Deploy | Google Cloud Build + Cloud Run |
| Auth | Google OAuth (HTTP mode), SF Client Credentials |

---

## Getting Started

### Prerequisites

- Node.js 22+
- A Salesforce org (sandbox or production)
- A Salesforce Connected App configured for Client Credentials flow with a read-only integration user
- (HTTP mode) A Google Cloud project with a configured OAuth 2.0 client

### Installation

```bash
git clone https://github.com/micahyee415/salesforce-mcp-server
cd salesforce-mcp-server
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable | Required | Description |
|---|---|---|
| `SF_CLIENT_ID` | Yes | Consumer Key from the Salesforce Connected App |
| `SF_CLIENT_SECRET` | Yes | Consumer Secret from the Salesforce Connected App |
| `SF_INSTANCE_URL` | Yes | Your Salesforce instance URL (e.g. `https://your-org.my.salesforce.com`) |
| `SF_LOGIN_URL` | Yes | `https://login.salesforce.com` (prod) or `https://test.salesforce.com` (sandbox) |
| `SF_API_VERSION` | No | Salesforce API version, defaults to `62.0` |
| `PORT` | HTTP mode | Set to `8080` to enable HTTP mode (Cloud Run sets this automatically) |
| `ALLOWED_DOMAIN` | HTTP mode | Email domain to restrict access, e.g. `example.com` |
| `SERVER_URL` | HTTP mode | Public URL of this service, e.g. `https://your-service.example.com` |
| `GOOGLE_CLIENT_ID` | HTTP mode | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | HTTP mode | Google OAuth 2.0 client secret |

The server also looks for a user-space config at `~/.config/salesforce-mcp/.env` — useful for local development without modifying the project root.

### Salesforce Connected App Setup

1. In Salesforce Setup, go to **App Manager** → **New Connected App**.
2. Enable OAuth settings, add the `api` scope.
3. Enable **Client Credentials Flow** and assign the integration user.
4. Create or reuse a Salesforce user with a **read-only profile** (System Administrator is not required and not recommended). Assign it to the Connected App as the "Run As" user.

### Running Locally (stdio mode)

```bash
npm run build
npm start
```

In stdio mode, `SF_USERNAME` is used as the audit log caller identity. No `PORT` variable should be set.

Connect via Claude Desktop by adding to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "salesforce": {
      "command": "node",
      "args": ["/absolute/path/to/salesforce-mcp/dist/index.js"]
    }
  }
}
```

### Running Locally (HTTP mode)

```bash
PORT=8080 npm start
```

Verify the server is up:

```bash
curl http://localhost:8080/health
```

### Deploy to Cloud Run

```bash
npm run deploy
```

This runs `cloudbuild.yaml` via `gcloud builds submit`, which:
1. Runs `npm audit --audit-level=high` (fails the build on critical/high CVEs)
2. Builds the Docker image
3. Pushes to Container Registry
4. Deploys to Cloud Run (`us-central1`)
5. Restores the `allUsers` invoker binding (Cloud Run resets IAM on every deploy)

Set your GCP project in `deploy.sh`:

```bash
PROJECT="your-gcp-project"
```

---

## Connecting an MCP Client

Once deployed, connect any MCP-compatible client to:

```
https://your-service.example.com/mcp
```

For Claude.ai remote connectors, use the MCP URL above. The server implements RFC 9728 OAuth discovery at `/.well-known/oauth-protected-resource` and RFC 7591 dynamic client registration at `/register` — Claude.ai handles the OAuth flow automatically.

---

## Security

- **Read-only by design.** The `SalesforceClient` class exposes no create/update/delete methods. SOQL input is validated to reject DML keywords and semicolons before any API call. A test asserts no write methods exist on the client.
- **Integration user with minimal permissions.** The Connected App runs as a named user with a read-only Salesforce profile — not a shared admin credential.
- **OAuth domain + audience enforcement.** In HTTP mode, tokens must come from a verified `@yourdomain.com` Google account _and_ must have been issued specifically for this OAuth client (audience check). Tokens issued for other apps are rejected even if the email domain matches.
- **Token cache uses SHA-256 hashes.** Raw OAuth tokens are never stored in memory; only their hash is used as the cache key.
- **Audit logging.** Every tool invocation logs the caller's email, tool name, and relevant metadata. SOQL/SOSL string literals are redacted before logging to prevent PII leakage. Bulk record access (`get_records`) emits dedicated audit log entries.
- **Per-user rate limiting.** 60 requests/minute per authenticated user in HTTP mode.
- **Security headers.** `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, and `Cache-Control: no-store` on all responses.
- **Non-root container.** The Docker image runs as a non-root user to limit blast radius if the container is compromised.
- **Dependency scanning.** `npm audit --audit-level=high` runs in Cloud Build and fails the pipeline on critical or high CVEs.

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

---

## License

No license file is present in this repository. All rights reserved unless otherwise stated.
