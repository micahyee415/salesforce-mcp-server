/**
 * Input validation helpers for MCP tool parameters.
 * Extends the base Gong validators with Salesforce-specific validation:
 * - SOQL/SOSL query sanitization (injection prevention)
 * - Salesforce record ID format validation
 * - SObject name validation
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ── Generic validators (from Gong pattern) ──

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})?)?$/;

export function normalizeDateTime(value: string): string {
  return value.includes("T") ? value : `${value}T00:00:00Z`;
}

export function validateDateParam(value: string | undefined, name: string): void {
  if (value === undefined || value === "") return;
  if (!ISO_DATE_RE.test(value)) {
    throw new ValidationError(
      `"${name}" must be a valid date in ISO 8601 format (e.g. "2026-03-16" or "2026-03-16T09:00:00Z"). Got: "${value}"`
    );
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    throw new ValidationError(
      `"${name}" is not a real date. Example: "2026-03-16T09:00:00Z". Got: "${value}"`
    );
  }
}

export function validatePositiveInt(
  value: number | undefined,
  name: string,
  defaultValue: number
): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(
      `"${name}" must be a positive whole number. Got: ${value}`
    );
  }
  return value;
}

// ── Salesforce-specific validators ──

// DML keywords that should never appear in a read-only SOQL context.
// Matched as whole words (word boundaries) to avoid false positives on field names.
const DML_KEYWORDS_RE = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|UNDELETE)\b/i;

// Salesforce 15 or 18-character record IDs (alphanumeric, starts with a letter)
const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

// SObject API names: alphanumeric + underscores, starts with a letter, may end with __c, __r, __e, etc.
const SOBJECT_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

const MAX_QUERY_LENGTH = 20_000;

/**
 * Sanitizes a SOQL query string. Defense-in-depth layer — the integration user's
 * read-only profile is the primary control, but this catches mistakes early.
 *
 * Rejects:
 * - Empty queries
 * - Queries > 20K chars
 * - Queries containing semicolons (multi-statement attempt)
 * - Queries not starting with SELECT
 * - Queries containing DML keywords as standalone tokens
 */
export function sanitizeSOQL(query: string): string {
  const trimmed = query.trim();

  if (!trimmed) {
    throw new ValidationError("SOQL query cannot be empty.");
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(
      `SOQL query is too long (${trimmed.length} chars). Maximum is ${MAX_QUERY_LENGTH}.`
    );
  }

  if (trimmed.includes(";")) {
    throw new ValidationError(
      "SOQL query cannot contain semicolons. Only single SELECT statements are allowed."
    );
  }

  // Block comment injection (/* ... */ sequences)
  if (/\/\*/.test(trimmed)) {
    throw new ValidationError(
      "SOQL query cannot contain block comments (/* ... */). Simplify your query."
    );
  }

  // Reject non-ASCII characters (Salesforce field/object names are ASCII-only)
  if (/[^\x00-\x7F]/.test(trimmed)) {
    throw new ValidationError(
      "SOQL query must contain only ASCII characters."
    );
  }

  if (!/^SELECT\b/i.test(trimmed)) {
    throw new ValidationError(
      "SOQL query must start with SELECT. Only read operations are allowed."
    );
  }

  if (DML_KEYWORDS_RE.test(trimmed)) {
    throw new ValidationError(
      "SOQL query contains a blocked keyword (INSERT, UPDATE, DELETE, MERGE, UPSERT, or UNDELETE). Only SELECT queries are allowed."
    );
  }

  return trimmed;
}

/**
 * Sanitizes a SOSL search string.
 * SOSL uses FIND syntax, not SELECT.
 */
export function sanitizeSOSL(query: string): string {
  const trimmed = query.trim();

  if (!trimmed) {
    throw new ValidationError("SOSL search query cannot be empty.");
  }

  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(
      `SOSL search query is too long (${trimmed.length} chars). Maximum is ${MAX_QUERY_LENGTH}.`
    );
  }

  if (trimmed.includes(";")) {
    throw new ValidationError(
      "SOSL search query cannot contain semicolons."
    );
  }

  // Block comment injection (/* ... */ sequences)
  if (/\/\*/.test(trimmed)) {
    throw new ValidationError(
      "SOSL search query cannot contain block comments (/* ... */)."
    );
  }

  // Reject non-ASCII characters
  if (/[^\x00-\x7F]/.test(trimmed)) {
    throw new ValidationError(
      "SOSL search query must contain only ASCII characters."
    );
  }

  if (!/^FIND\b/i.test(trimmed)) {
    throw new ValidationError(
      "SOSL search query must start with FIND. Example: FIND {searchTerm} IN ALL FIELDS RETURNING Account(Name, Id)"
    );
  }

  if (DML_KEYWORDS_RE.test(trimmed)) {
    throw new ValidationError(
      "SOSL search query contains a blocked keyword. Only FIND queries are allowed."
    );
  }

  return trimmed;
}

/**
 * Validates a Salesforce record ID (15 or 18 characters, alphanumeric).
 */
export function validateSalesforceId(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new ValidationError(
      `"${name}" is required. Salesforce IDs are 15 or 18 characters (e.g. "001xx000003DGbYAAW").`
    );
  }
  const trimmed = value.trim();
  if (!SF_ID_RE.test(trimmed)) {
    throw new ValidationError(
      `"${name}" doesn't look like a valid Salesforce ID. Expected 15 or 18 alphanumeric characters. Got: "${trimmed}"`
    );
  }
  return trimmed;
}

/**
 * Validates a Salesforce SObject API name (e.g. "Account", "Custom_Object__c").
 */
export function validateSObjectName(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new ValidationError(
      `"${name}" is required. Use list_objects to see available object types.`
    );
  }
  const trimmed = value.trim();
  if (!SOBJECT_NAME_RE.test(trimmed)) {
    throw new ValidationError(
      `"${name}" doesn't look like a valid Salesforce object name. Expected letters, numbers, and underscores. Got: "${trimmed}"`
    );
  }
  return trimmed;
}

/**
 * Returns a tool-level error response (shown to the user, not thrown as exception).
 * Use this for validation errors in tool handlers.
 */
export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// ── Cursor validation (queryMore) ──

// Salesforce nextRecordsUrl shape: /services/data/vXX.X/query/{queryLocator}
// queryLocator is alphanumeric with optional dashes.
const NEXT_RECORDS_URL_RE = /^\/services\/data\/v\d+\.\d+\/query\/[a-zA-Z0-9-]+$/;

export function validateCursor(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ValidationError(
      `"cursor" cannot be empty. Use the nextCursor value returned from a prior query_records call.`
    );
  }
  const trimmed = value.trim();
  if (!NEXT_RECORDS_URL_RE.test(trimmed)) {
    throw new ValidationError(
      `"cursor" doesn't match the expected nextRecordsUrl shape. Pass the nextCursor value from a prior query_records response, not a custom string.`
    );
  }
  return trimmed;
}

// ── Report filter override validation ──

// Read-safe operator allowlist. Excludes anything that could change report semantics
// in unexpected ways (e.g., "between", "in" require array values; not supported in v1.1).
const ALLOWED_FILTER_OPS = new Set([
  "equals", "notEqual",
  "lessThan", "greaterThan", "lessOrEqual", "greaterOrEqual",
  "contains", "notContain",
  "startsWith",
  "includes", "excludes",
]);

// Salesforce report column names: alphanumeric + underscore + dot (for relationship traversal)
const REPORT_COLUMN_RE = /^[a-zA-Z][a-zA-Z0-9_.]*$/;

export interface FilterOverride {
  column: string;
  operator: string;
  value: string;
}

export function validateFilterOverride(input: unknown): FilterOverride {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError(
      `Filter override must be an object with shape { column, operator, value }.`
    );
  }
  const f = input as Record<string, unknown>;
  if (typeof f.column !== "string" || f.column.trim() === "") {
    throw new ValidationError(`Filter override is missing a valid "column" string.`);
  }
  if (typeof f.operator !== "string" || f.operator.trim() === "") {
    throw new ValidationError(`Filter override is missing a valid "operator" string.`);
  }
  if (typeof f.value !== "string") {
    throw new ValidationError(`Filter override "value" must be a string.`);
  }
  const column = f.column.trim();
  if (!REPORT_COLUMN_RE.test(column)) {
    throw new ValidationError(
      `Filter override "column" contains invalid characters. Only letters, numbers, underscores, and dots are allowed. Got: "${column}"`
    );
  }
  const operator = f.operator.trim();
  if (!ALLOWED_FILTER_OPS.has(operator)) {
    throw new ValidationError(
      `Filter override "operator" must be one of: ${Array.from(ALLOWED_FILTER_OPS).join(", ")}. Got: "${operator}"`
    );
  }
  return { column, operator, value: f.value };
}
