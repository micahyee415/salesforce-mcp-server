/**
 * Salesforce API client — read-only wrapper over jsforce with Client Credentials auth.
 *
 * Security: This class intentionally exposes ZERO write methods.
 * The raw jsforce Connection is never exposed outside this module.
 * A test assertion verifies no create/update/delete/upsert methods exist.
 *
 * Key differences from the Gong client:
 * - Uses Client Credentials OAuth flow (client ID + secret, no certificate needed)
 * - Mutex around re-auth to prevent thundering herd in HTTP mode
 * - API version pinned explicitly (update annually)
 */

import jsforce, { Connection, DescribeSObjectResult, DescribeGlobalResult } from "jsforce";
import { TTLCache } from "./cache.js";
import { logger } from "./logger.js";

export interface SalesforceConfig {
  clientId: string;
  clientSecret: string;
  instanceUrl: string;
  loginUrl: string;
  apiVersion: string;
}

// ── Types for Salesforce API responses ──

export interface SObjectDescribeField {
  name: string;
  label: string;
  type: string;
  length: number;
  nillable: boolean;
  updateable: boolean;
  createable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  picklistValues?: { value: string; label: string; active: boolean }[];
}

export interface SObjectDescribe {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string | null;
  fields: SObjectDescribeField[];
  childRelationships: { childSObject: string; field: string; relationshipName: string | null }[];
  recordTypeInfos: { name: string; recordTypeId: string; active: boolean }[];
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  email: string;
  organizationId: string;
  profileId: string;
}

export interface LimitInfo {
  apiUsage?: { used: number; limit: number };
}

export interface ReportSummary {
  id: string;
  name: string;
  folder: string;
  format: string;
  lastRunDate: string | null;
}

export interface ReportDescribe {
  name: string;
  reportFormat: string;
  columns: { apiName: string; label: string; dataType: string }[];
  filters: { column: string; operator: string; value: string }[];
}

export interface BatchRecordResult {
  found: number;
  missing: number;
  records: Array<Record<string, unknown> | { id: string; error: string }>;
}

// ── Client configuration ──

// Retry: same pattern as Gong — exponential backoff on transient errors
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const REQUEST_TIMEOUT_MS = 30_000;

// Cache TTLs
const DESCRIBE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — object metadata changes rarely
const RECORD_CACHE_TTL = 2 * 60 * 1000;    // 2 minutes — record data changes frequently
const OBJECTS_LIST_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const REPORTS_LIST_CACHE_TTL = 30 * 60 * 1000; // 30 minutes — report metadata changes rarely
const REPORT_DESCRIBE_CACHE_TTL = 30 * 60 * 1000;

// No private key loader needed — Client Credentials Flow uses client ID + secret only.

/**
 * Sanitizes Salesforce error messages before returning to users.
 * Strips internal org IDs and user IDs that shouldn't be exposed.
 * Exported so tool handlers can use it in their error paths.
 */
export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/\b00D[a-zA-Z0-9]{12,15}\b/g, "[ORG_ID]")
    .replace(/\b005[a-zA-Z0-9]{12,15}\b/g, "[USER_ID]");
}

export class SalesforceClient {
  private conn: Connection;
  private config: SalesforceConfig;
  private tokenIssuedAt = 0;

  // Simple mutex: a promise that resolves when re-auth completes.
  // Prevents multiple concurrent requests from all trying to re-auth simultaneously.
  private authLock: Promise<void> | null = null;

  // Caches
  private describeCache = new TTLCache<SObjectDescribe>(DESCRIBE_CACHE_TTL, 200);
  private recordCache = new TTLCache<Record<string, unknown>>(RECORD_CACHE_TTL, 500);
  private objectsListCache = new TTLCache<{ name: string; label: string; keyPrefix: string | null }[]>(OBJECTS_LIST_CACHE_TTL, 1);
  private reportsListCache = new TTLCache<ReportSummary[]>(REPORTS_LIST_CACHE_TTL, 50);
  private reportDescribeCache = new TTLCache<ReportDescribe>(REPORT_DESCRIBE_CACHE_TTL, 100);

  constructor(sfConfig: SalesforceConfig) {
    this.config = sfConfig;
    // jsforce v1 supports a `timeout` option that caps all HTTP calls,
    // but it is not declared in the TypeScript types — cast to apply it.
    this.conn = new Connection({
      loginUrl: sfConfig.loginUrl,
      instanceUrl: sfConfig.instanceUrl,
      version: sfConfig.apiVersion,
      timeout: REQUEST_TIMEOUT_MS,
      oauth2: {
        clientId: sfConfig.clientId,
        clientSecret: sfConfig.clientSecret,
        loginUrl: sfConfig.loginUrl,
      },
    } as ConstructorParameters<typeof Connection>[0]);
  }

  /**
   * Authenticates using OAuth Client Credentials flow.
   * This is a server-to-server flow — no user interaction needed.
   * The Connected App must have "Enable Client Credentials Flow" checked
   * and the integration user's profile must be assigned to the app.
   */
  async authorize(): Promise<void> {
    // Client Credentials flow: POST to /services/oauth2/token with
    // grant_type=client_credentials, client_id, and client_secret.
    // jsforce doesn't natively support this, so we use a direct HTTP call.
    // For sandboxes, Client Credentials must use the instance URL, not the generic login URL.
    // Using instanceUrl works for both sandbox and production.
    const tokenUrl = `${this.config.instanceUrl}/services/oauth2/token`;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    // 10-second timeout prevents a slow/unresponsive Salesforce token endpoint from
    // hanging the caller indefinitely. Without this, ensureAuth() called from live
    // tool requests has no timeout protection — it blocks until Cloud Run's 5-minute
    // request ceiling kills the connection, and tokenIssuedAt never gets updated.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let resp: Response;
    try {
      resp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      });
    } catch (err) {
      const msg = err instanceof Error && err.name === "AbortError"
        ? "Salesforce token request timed out after 10s"
        : err instanceof Error ? err.message : String(err);
      logger.error("Client Credentials auth failed", { reason: msg });
      throw new Error(`Client Credentials auth failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!resp.ok) {
      const errBody = await resp.text();
      logger.error("Client Credentials auth failed", { statusCode: resp.status, reason: errBody });
      throw new Error(`Client Credentials auth failed (${resp.status}). Check SF_CLIENT_ID and SF_CLIENT_SECRET.`);
    }

    const data = await resp.json() as { access_token: string; instance_url: string };

    // Set the access token and instance URL on the jsforce Connection
    this.conn.accessToken = data.access_token;
    this.conn.instanceUrl = data.instance_url;
    this.tokenIssuedAt = Date.now();
  }

  /**
   * Ensures the connection is authenticated, refreshing if needed.
   * Uses a mutex to prevent thundering herd when multiple requests hit an expired token.
   */
  private async ensureAuth(): Promise<void> {
    // Proactively refresh if token is likely expired (assume 1-hour lifetime, refresh at 55 min)
    const tokenAgeMs = Date.now() - this.tokenIssuedAt;
    const needsRefresh = this.tokenIssuedAt === 0 || tokenAgeMs > 55 * 60 * 1000;

    if (!needsRefresh) return;

    // If another request is already refreshing, wait for it
    if (this.authLock) {
      await this.authLock;
      return;
    }

    // Take the lock and refresh
    this.authLock = this.authorize().finally(() => {
      this.authLock = null;
    });
    await this.authLock;
  }

  /**
   * Executes a Salesforce API call with retry and token refresh.
   * On 401, re-authenticates and retries once.
   */
  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    await this.ensureAuth();

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        return await operation();
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const isAuthError = errMsg.includes("INVALID_SESSION_ID") || errMsg.includes("Session expired");

        // On auth error, re-authenticate and retry once
        if (isAuthError && attempt === 0) {
          logger.warn("Salesforce session expired, re-authenticating...");
          await this.authorize();
          lastError = err instanceof Error ? err : new Error(errMsg);
          continue;
        }

        // Check if error contains a retryable HTTP status
        const isRetryable = RETRYABLE_STATUS_CODES.has(
          (err as { statusCode?: number }).statusCode ?? 0
        );
        if (isRetryable && attempt < MAX_RETRIES) {
          lastError = err instanceof Error ? err : new Error(errMsg);
          continue;
        }

        throw err;
      }
    }

    throw lastError ?? new Error("Salesforce API call failed after retries");
  }

  /** @internal Delegates to the exported sanitizeError() function */
  private sanitizeError(err: unknown): string {
    return sanitizeError(err);
  }

  // ── Liveness check ──

  /**
   * Proactively refreshes the Salesforce token if it is stale.
   * Safe to call from health checks — returns immediately if the token is fresh,
   * and refreshes (with a 10s timeout) if it has exceeded the 55-min window.
   */
  async keepAlive(): Promise<void> {
    await this.ensureAuth();
  }

  /**
   * Returns true if the client has a recently issued token (within the 55-min refresh window).
   * Used by the /health endpoint to report actual readiness without making an API call.
   */
  isReady(): boolean {
    const tokenAgeMs = Date.now() - this.tokenIssuedAt;
    return this.tokenIssuedAt > 0 && tokenAgeMs < 55 * 60 * 1000;
  }

  // ── Health Check ──

  async healthCheck(): Promise<{
    ok: boolean;
    checks: { name: string; status: "pass" | "fail"; detail: string }[];
  }> {
    const checks: { name: string; status: "pass" | "fail"; detail: string }[] = [];

    try {
      await this.authorize();
      checks.push({ name: "Client Credentials auth", status: "pass", detail: "Authenticated successfully" });
    } catch (err) {
      checks.push({
        name: "Client Credentials auth",
        status: "fail",
        detail: `Authentication failed: ${this.sanitizeError(err)}. Check SF_CLIENT_ID, SF_CLIENT_SECRET, and SF_LOGIN_URL.`,
      });
      return { ok: false, checks };
    }

    // Verify API access with a simple query
    try {
      await this.conn.query("SELECT Id FROM Account LIMIT 1");
      checks.push({ name: "API access", status: "pass", detail: "SOQL query executed successfully" });
    } catch (err) {
      checks.push({
        name: "API access",
        status: "fail",
        detail: `API call failed: ${this.sanitizeError(err)}. Check integration user permissions.`,
      });
    }

    return {
      ok: checks.every((c) => c.status === "pass"),
      checks,
    };
  }

  // ── Read-only API Methods ──
  // IMPORTANT: This class must NEVER expose create, update, delete, or upsert methods.

  /**
   * Execute a SOQL query. Query MUST be pre-sanitized by sanitizeSOQL().
   * Returns up to `maxRecords` results with automatic pagination.
   * When done === false, nextRecordsUrl can be passed to queryMore() for the next page.
   */
  async query(soql: string, maxRecords = 5000): Promise<{
    records: Record<string, unknown>[];
    totalSize: number;
    done: boolean;
    nextRecordsUrl?: string;
  }> {
    return this.withRetry(async () => {
      const result = await this.conn.query(soql, { maxFetch: maxRecords });
      return {
        records: result.records as Record<string, unknown>[],
        totalSize: result.totalSize,
        done: result.done,
        nextRecordsUrl: (result as { nextRecordsUrl?: string }).nextRecordsUrl,
      };
    });
  }

  /**
   * Continue a SOQL query using a cursor (nextRecordsUrl) returned from a prior call.
   * Cursor MUST be pre-validated by validateCursor().
   */
  async queryMore(cursor: string): Promise<{
    records: Record<string, unknown>[];
    totalSize: number;
    done: boolean;
    nextRecordsUrl?: string;
  }> {
    return this.withRetry(async () => {
      const result = await (this.conn as unknown as {
        queryMore: (c: string) => Promise<{ records: unknown[]; totalSize: number; done: boolean; nextRecordsUrl?: string }>;
      }).queryMore(cursor);
      return {
        records: result.records as Record<string, unknown>[],
        totalSize: result.totalSize,
        done: result.done,
        nextRecordsUrl: result.nextRecordsUrl,
      };
    });
  }

  /**
   * Execute a SOSL search. Query MUST be pre-sanitized by sanitizeSOSL().
   */
  async search(sosl: string): Promise<{ searchRecords: Record<string, unknown>[] }> {
    return this.withRetry(async () => {
      const result = await this.conn.search(sosl);
      return {
        searchRecords: result.searchRecords as Record<string, unknown>[],
      };
    });
  }

  /**
   * Get a single record by SObject type and ID.
   * Optionally specify which fields to return.
   */
  async getRecord(sobject: string, id: string, fields?: string[]): Promise<Record<string, unknown> | null> {
    // Cache key includes fields list to prevent stale partial records.
    // Sorted to make {Name,Id} and {Id,Name} hit the same cache entry.
    const fieldsKey = fields?.slice().sort().join(",") ?? "*";
    const cacheKey = `${sobject}:${id}:${fieldsKey}`;
    const cached = this.recordCache.get(cacheKey);
    if (cached) return cached;

    return this.withRetry(async () => {
      try {
        // jsforce supports fields on retrieve via the second argument shape.
        // Pass through when caller specified fields; otherwise fetch all readable fields.
        const record = (fields && fields.length > 0
          ? await this.conn.sobject(sobject).retrieve(id, { fields }) as Record<string, unknown>
          : await this.conn.sobject(sobject).retrieve(id) as Record<string, unknown>);
        this.recordCache.set(cacheKey, record);
        return record;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("NOT_FOUND") || msg.includes("MALFORMED_ID")) {
          return null;
        }
        throw err;
      }
    });
  }

  /**
   * List all available SObject types in the org.
   * Returns name, label, and keyPrefix for each queryable object.
   */
  async listObjects(): Promise<{ name: string; label: string; keyPrefix: string | null }[]> {
    const cached = this.objectsListCache.get("all");
    if (cached) return cached;

    return this.withRetry(async () => {
      const result = await this.conn.describeGlobal() as DescribeGlobalResult;
      const objects = result.sobjects
        .filter((obj: { queryable: boolean }) => obj.queryable)
        .map((obj: { name: string; label: string; keyPrefix?: string | null }) => ({
          name: obj.name,
          label: obj.label,
          keyPrefix: obj.keyPrefix ?? null,
        }));
      this.objectsListCache.set("all", objects);
      return objects;
    });
  }

  /**
   * Describe an SObject — returns fields, relationships, and record types.
   * By default, picklist values are excluded to keep response size manageable.
   */
  async describeObject(sobject: string, includePicklists = false): Promise<SObjectDescribe> {
    const cacheKey = `${sobject}:${includePicklists}`;
    const cached = this.describeCache.get(cacheKey);
    if (cached) return cached;

    return this.withRetry(async () => {
      const desc = await this.conn.sobject(sobject).describe() as DescribeSObjectResult;

      const fields: SObjectDescribeField[] = (desc.fields as Array<Record<string, unknown>>).map((f: Record<string, unknown>) => ({
        name: f.name as string,
        label: f.label as string,
        type: f.type as string,
        length: (f.length as number) ?? 0,
        nillable: (f.nillable as boolean) ?? false,
        updateable: (f.updateable as boolean) ?? false,
        createable: (f.createable as boolean) ?? false,
        referenceTo: ((f.referenceTo ?? []) as string[]),
        relationshipName: (f.relationshipName as string | null) ?? null,
        ...(includePicklists && Array.isArray(f.picklistValues) && f.picklistValues.length
          ? {
              picklistValues: (f.picklistValues as Array<Record<string, unknown>>).map((pv: Record<string, unknown>) => ({
                value: pv.value as string,
                label: pv.label as string,
                active: pv.active as boolean,
              })),
            }
          : {}),
      }));

      const result: SObjectDescribe = {
        name: desc.name,
        label: desc.label,
        labelPlural: desc.labelPlural,
        keyPrefix: (desc as Record<string, unknown>).keyPrefix as string | null ?? null,
        fields,
        childRelationships: ((desc.childRelationships ?? []) as Array<Record<string, unknown>>).map((cr: Record<string, unknown>) => ({
          childSObject: cr.childSObject as string,
          field: cr.field as string,
          relationshipName: (cr.relationshipName as string | null) ?? null,
        })),
        recordTypeInfos: ((desc.recordTypeInfos ?? []) as Array<Record<string, unknown>>).map((rt: Record<string, unknown>) => ({
          name: rt.name as string,
          recordTypeId: rt.recordTypeId as string,
          active: rt.active as boolean,
        })),
      };

      this.describeCache.set(cacheKey, result);
      return result;
    });
  }

  /**
   * Get the current authenticated user's info.
   */
  async getCurrentUser(): Promise<UserInfo> {
    return this.withRetry(async () => {
      const identity = await this.conn.identity();
      return {
        id: identity.user_id,
        username: identity.username,
        displayName: identity.display_name,
        email: identity.email,
        organizationId: identity.organization_id,
        profileId: (identity as Record<string, unknown>).profile_id as string ?? "",
      };
    });
  }

  /**
   * Get current API usage limits.
   * Uses conn.limitInfo which is populated after every API call — no extra call needed.
   */
  getApiLimits(): LimitInfo {
    return {
      apiUsage: this.conn.limitInfo?.apiUsage ?? undefined,
    };
  }

  /**
   * Execute a saved Salesforce report by report ID.
   * Detail rows capped at 2000 to prevent token explosion.
   * Optional filterOverrides inject into reportMetadata.reportFilters before execute().
   */
  async runReport(
    reportId: string,
    includeDetails = false,
    filterOverrides?: { column: string; operator: string; value: string }[]
  ): Promise<Record<string, unknown>> {
    return this.withRetry(async () => {
      const report = this.conn.analytics.report(reportId);

      const executeArgs: Record<string, unknown> = { details: includeDetails };
      if (filterOverrides && filterOverrides.length > 0) {
        executeArgs.metadata = {
          reportMetadata: {
            reportFilters: filterOverrides.map((f) => ({
              column: f.column,
              operator: f.operator,
              value: f.value,
            })),
          },
        };
      }

      const result = await (report as unknown as {
        execute: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      }).execute(executeArgs);

      // Truncate detail rows if they exceed 2000 (raised from 500 in v1.1)
      const factMap = result.factMap as Record<string, { rows?: unknown[] }> | undefined;
      if (factMap) {
        for (const key of Object.keys(factMap)) {
          const section = factMap[key];
          if (section?.rows && section.rows.length > 2000) {
            section.rows = section.rows.slice(0, 2000);
            (result as Record<string, unknown>)._truncated = true;
            (result as Record<string, unknown>)._truncatedMessage =
              "Detail rows truncated to 2000. Use Salesforce directly for the full report or refine filters.";
          }
        }
      }

      return result;
    });
  }

  /**
   * List reports the integration user can access.
   * Optional substring filters on name/folder.
   */
  async listReports(opts?: { search?: string; folder?: string; limit?: number }): Promise<ReportSummary[]> {
    // Use JSON.stringify to prevent cache key collision when search/folder values
    // contain the colon separator character (MEDIUM-1 security fix).
    const cacheKey = `reports:${JSON.stringify({ search: opts?.search ?? "", folder: opts?.folder ?? "" })}`;
    const cached = this.reportsListCache.get(cacheKey);
    if (cached) return cached;

    return this.withRetry(async () => {
      const raw = await (this.conn.analytics as unknown as {
        reports: () => Promise<Array<Record<string, unknown>>>;
      }).reports();

      let mapped: ReportSummary[] = raw.map((r) => ({
        id: (r.id as string) ?? "",
        name: (r.name as string) ?? "",
        folder: ((r.folderName as string) ?? (r.folder as string) ?? "") as string,
        format: (r.format as string) ?? "",
        lastRunDate: (r.lastRunDate as string | null) ?? null,
      }));

      if (opts?.folder) {
        const folderLower = opts.folder.toLowerCase();
        mapped = mapped.filter((r) => r.folder.toLowerCase() === folderLower);
      }
      if (opts?.search) {
        const q = opts.search.toLowerCase();
        mapped = mapped.filter((r) => r.name.toLowerCase().includes(q));
      }
      if (opts?.limit) {
        mapped = mapped.slice(0, opts.limit);
      }

      this.reportsListCache.set(cacheKey, mapped);
      return mapped;
    });
  }

  /**
   * Describe a saved report — returns columns and current filter criteria.
   * Use this before calling runReport with filterOverrides so callers know
   * which columns and operators are valid for this report.
   */
  async describeReport(reportId: string): Promise<ReportDescribe> {
    const cached = this.reportDescribeCache.get(reportId);
    if (cached) return cached;

    return this.withRetry(async () => {
      const meta = await (this.conn.analytics.report(reportId) as unknown as {
        describe: () => Promise<Record<string, unknown>>;
      }).describe();

      const reportMetadata = (meta.reportMetadata as Record<string, unknown>) ?? {};
      const reportTypeMetadata = (meta.reportTypeMetadata as Record<string, unknown>) ?? {};
      const detailColumns = (reportMetadata.detailColumns as string[]) ?? [];
      const detailColumnInfo = (reportTypeMetadata.detailColumnInfo as Record<string, { label?: string; dataType?: string }>) ?? {};

      const columns = detailColumns.map((apiName) => ({
        apiName,
        label: detailColumnInfo[apiName]?.label ?? apiName,
        dataType: detailColumnInfo[apiName]?.dataType ?? "unknown",
      }));

      const filters = ((reportMetadata.reportFilters as Array<Record<string, unknown>>) ?? []).map((f) => ({
        column: (f.column as string) ?? "",
        operator: (f.operator as string) ?? "",
        value: typeof f.value === "string" ? f.value : JSON.stringify(f.value ?? ""),
      }));

      const result: ReportDescribe = {
        name: (reportMetadata.name as string) ?? "",
        reportFormat: (reportMetadata.reportFormat as string) ?? "",
        columns,
        filters,
      };

      this.reportDescribeCache.set(reportId, result);
      return result;
    });
  }

  /**
   * Batched record retrieval (up to 200 IDs per call).
   * Returns one entry per requested ID — either the record or an {id, error} stub.
   * Missing/inaccessible IDs do NOT fail the entire call.
   */
  async getRecords(sobject: string, ids: string[], fields?: string[]): Promise<BatchRecordResult> {
    if (!ids || ids.length === 0) {
      throw new Error("getRecords requires at least one ID");
    }
    if (ids.length > 200) {
      throw new Error(`getRecords supports a maximum of 200 IDs per call (got ${ids.length}).`);
    }

    return this.withRetry(async () => {
      const retrieveOpts = fields && fields.length > 0 ? { fields } : undefined;
      const raw = await (this.conn.sobject(sobject) as unknown as {
        retrieve: (ids: string[], opts?: unknown) => Promise<Array<Record<string, unknown> | null>>;
      }).retrieve(ids, retrieveOpts);

      let found = 0;
      let missing = 0;
      const records: BatchRecordResult["records"] = ids.map((id, idx) => {
        const r = raw[idx];
        if (r === null || r === undefined) {
          missing++;
          return { id, error: "Record not found or not accessible" };
        }
        found++;
        return r;
      });

      return { found, missing, records };
    });
  }
}
