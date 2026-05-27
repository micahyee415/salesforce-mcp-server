/**
 * Structured JSON logger for Cloud Run.
 *
 * Writes to stderr — Cloud Logging picks this up automatically and indexes
 * the fields, making them searchable/filterable in the GCP console.
 *
 * In stdio mode, stderr is separate from stdout (the MCP protocol stream),
 * so these logs never contaminate the MCP transport.
 *
 * Log fields surfaced in Cloud Logging:
 *   severity  — DEBUG / INFO / WARNING / ERROR (filterable)
 *   message   — human-readable description
 *   timestamp — ISO 8601
 *   userEmail — who triggered the request (SOC 2 audit trail)
 *   tool      — which MCP tool was called
 *   durationMs — how long the request took
 */

type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface LogFields {
  userEmail?: string;
  tool?: string;
  durationMs?: number;
  statusCode?: number;
  reason?: string;
  event?: "login" | "auth_failure" | "usage" | "rate_limited" | "registration";
  [key: string]: unknown;
}

function write(severity: Severity, message: string, fields?: LogFields): void {
  console.error(
    JSON.stringify({
      severity,
      message,
      timestamp: new Date().toISOString(),
      ...fields,
    })
  );
}

export const logger = {
  info:  (message: string, fields?: LogFields) => write("INFO",    message, fields),
  warn:  (message: string, fields?: LogFields) => write("WARNING", message, fields),
  error: (message: string, fields?: LogFields) => write("ERROR",   message, fields),
};
