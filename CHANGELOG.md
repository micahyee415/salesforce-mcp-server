# Changelog

## [Unreleased]

### Changed
- This repository is a single read-only service. Write-tool functionality was evaluated and removed; the codebase has no write paths, deferred write branches, or write-service configuration.

---

## [1.1.1] — 2026-05-12

### Security
- **OAuth audience check enforced (HIGH)** — `verifyGoogleToken` now validates the token's `aud` claim against `GOOGLE_CLIENT_ID`, rejecting tokens issued for other OAuth clients even if they carry a verified email from the allowed domain. Fixes a confused-deputy vulnerability where any Google-OAuth-integrated app authorized by a user on the allowed domain could produce a token that would pass the domain check but should not grant access to this service.
- All 66 tests pass, build clean.

---

## [1.1.0] — 2026-04-27

### Added
- **`list_reports` tool** — discover saved reports the integration user can access, with optional `search` (substring) and `folder` (exact) filters.
- **`describe_report` tool** — inspect a report's columns and current filter criteria before running it.
- **`get_records` tool** — batched retrieval of up to 200 records by ID in a single call. Missing or inaccessible IDs return `{id, error}` stubs without failing the whole call.
- **`cursor` parameter on `query_records`** — pass `nextCursor` from a prior response to page through result sets larger than the cap.
- **`filterOverrides` parameter on `run_report`** — override report filters for a single run without modifying the saved report. Restricted to a read-safe operator allowlist.
- **`_warning` field on `query_records` response** — fires when results are truncated at the cap, informing the caller how to continue.
- Truncation telemetry — `event: "truncated_at_cap"` log entries to inform future Bulk API work.

### Changed
- `query_records` default record cap raised from 2,000 to 5,000.
- `run_report` detail row cap raised from 500 to 2,000.

### Security
- **Cache-key collision fix in `listReports`** (MEDIUM) — replaced a colon-separated key string with `JSON.stringify({search, folder})`, eliminating a collision where different `search`/`folder` value combinations could resolve to the same cache entry and return the wrong report list.
- **`get_records` audit log** (MEDIUM) — bulk record retrieval now emits a structured audit log entry with caller email, object type, and record count. IDs and field values are not logged.

### Fixed
- **Cache key bug in `getRecord`** — the record cache key now includes the requested `fields` list, preventing stale partial-field results when the same record ID is fetched with different field sets.

### Notes
- Tool count: 8 → 11.
- All v1.0 tool signatures remain compatible; `query_records` and `run_report` gain new optional parameters only.

---

## [1.0.11] — 2026-04-15

### Fixed
- **Health check false degradation during idle periods** — `/health` previously used a local token-age check that would return `503` after 55 minutes with no real Salesforce tool calls (e.g. only MCP handshake traffic). Fixed by adding a `keepAlive()` method that proactively refreshes the token on health polls, eliminating false degraded alerts.

---

## [1.0.10] — 2026-04-15

### Fixed
- **jsforce connection timeout** — Wired the `REQUEST_TIMEOUT_MS` constant (30 seconds) into the jsforce `Connection` constructor. Previously the constant was defined but never applied, so SOQL queries, describe calls, and report executions had no timeout and would hang until the container's request ceiling terminated them.

---

## [1.0.9] — 2026-04-15

### Fixed
- **`authorize()` fetch timeout** — Added a 10-second `AbortController` timeout to the Salesforce Client Credentials token request. A slow or unresponsive token endpoint previously caused all tool calls to hang indefinitely.
- **Cloud Build IAM restore** — Added a final Cloud Build step to restore the `allUsers` invoker binding after every deploy. `gcloud run deploy` resets IAM on each run; without this step, the service returns 403 to all callers until the binding is manually re-added.

---

## [1.0.x] — 2026-04-09

### Security
- Updated dependencies to resolve moderate and high severity CVEs, including:
  - Multiple middleware bypass, cookie validation, and path traversal issues in `hono`/`@hono/node-server` (migrated away from in favor of Express)
  - Prototype pollution and code injection vulnerabilities in `lodash` (removed as a dependency)
