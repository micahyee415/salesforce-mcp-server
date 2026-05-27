/**
 * Query tools: query_records, search_records
 * The two most powerful tools — SOQL queries and SOSL full-text search.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SalesforceClient, sanitizeError } from "../salesforce-client.js";
import {
  ValidationError,
  sanitizeSOQL,
  sanitizeSOSL,
  validatePositiveInt,
  validateCursor,
  toolError,
} from "../validation.js";
import { logger } from "../logger.js";

/** Redact string literals from SOQL/SOSL queries before logging to prevent PII in logs.
 *  Handles escaped single quotes (e.g. 'O\'Brien') correctly. */
function redactQueryLiterals(query: string): string {
  return query.replace(/'(?:[^'\\]|\\.)*'/g, "'[REDACTED]'");
}

export function registerQueryTools(server: McpServer, client: SalesforceClient, callerEmail: string) {
  server.tool(
    "query_records",
    "Execute a SOQL query against Salesforce. Returns up to 5000 records by default. Only SELECT queries are allowed (read-only). Pass `nextCursor` from a prior response back as `cursor` to page through more than 5000 records. Example: SELECT Id, Name, Amount FROM Opportunity WHERE StageName = 'Closed Won' AND CloseDate = THIS_QUARTER",
    {
      query: z.string().optional().describe("SOQL query starting with SELECT. Required unless `cursor` is provided."),
      limit: z.number().optional().describe("Maximum records to return (1-5000, default 5000). Ignored when `cursor` is set."),
      cursor: z.string().optional().describe("nextCursor value from a prior query_records response. Mutually exclusive with `query`."),
    },
    async (params) => {
      try {
        // Mutual exclusion check.
        if (params.cursor && params.query) {
          return toolError("Pass either `query` (start a new query) OR `cursor` (continue a prior query), not both.");
        }
        if (!params.cursor && !params.query) {
          return toolError("Either `query` or `cursor` is required.");
        }

        const userEmail = callerEmail;

        // Cursor branch — continue a prior query.
        if (params.cursor) {
          const cursor = validateCursor(params.cursor);
          logger.info("SOQL queryMore executed", { userEmail, tool: "query_records", cursor });
          const result = await client.queryMore(cursor);

          const response: Record<string, unknown> = {
            totalSize: result.totalSize,
            recordCount: result.records.length,
            done: result.done,
            records: result.records,
          };
          if (!result.done && result.nextRecordsUrl) {
            response.nextCursor = result.nextRecordsUrl;
          }
          if (!result.done) {
            response._warning = `Response truncated. ${result.totalSize} total records exist. Pass nextCursor back as cursor to continue, or narrow your WHERE clause to reduce result size.`;
            logger.info("Query truncated at cap", { userEmail, tool: "query_records", truncated_at_cap: true, recordCount: result.records.length, totalSize: result.totalSize });
          }
          return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
        }

        // Fresh query branch.
        const sanitized = sanitizeSOQL(params.query as string);
        const limit = validatePositiveInt(params.limit, "limit", 5000);
        const cappedLimit = Math.min(limit, 5000);

        // Log the query for audit trail (SOC 2) — redact string literals to prevent PII in logs
        logger.info("SOQL query executed", { userEmail, tool: "query_records", query: redactQueryLiterals(sanitized) });

        const result = await client.query(sanitized, cappedLimit);

        const response: Record<string, unknown> = {
          totalSize: result.totalSize,
          recordCount: result.records.length,
          done: result.done,
          records: result.records,
        };
        if (!result.done && result.nextRecordsUrl) {
          response.nextCursor = result.nextRecordsUrl;
        }
        if (result.records.length >= cappedLimit && !result.done) {
          response._warning = `Response truncated at ${cappedLimit} records. ${result.totalSize} total records exist. Pass nextCursor back as cursor to continue, or narrow your WHERE clause.`;
          logger.info("Query truncated at cap", { userEmail, tool: "query_records", truncated_at_cap: true, cap: cappedLimit, totalSize: result.totalSize });
        }

        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);

        // Sanitize Salesforce error messages
        const msg = err instanceof Error ? err.message : String(err);
        logger.error("SOQL query failed", { userEmail: callerEmail, tool: "query_records", reason: msg });

        // Provide helpful error messages for common SOQL mistakes
        if (msg.includes("INVALID_FIELD")) {
          return toolError("SOQL Error: One or more fields in your query don't exist on this object. Use describe_object to see available fields.");
        }
        if (msg.includes("INVALID_TYPE")) {
          return toolError("SOQL Error: The object type in your query doesn't exist. Use list_objects to see available object types.");
        }
        if (msg.includes("MALFORMED_QUERY")) {
          return toolError("SOQL Error: The query syntax is invalid. Check your SELECT, FROM, and WHERE clauses.");
        }
        if (msg.includes("INVALID_QUERY_LOCATOR")) {
          return toolError("Cursor expired or invalid. Salesforce query cursors expire after ~15 minutes — restart with a fresh `query`.");
        }

        return toolError(`SOQL query failed: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "search_records",
    "Execute a SOSL full-text search across Salesforce objects. Searches across all text fields by default. Example: FIND {Acme} IN ALL FIELDS RETURNING Account(Name, Id), Contact(Name, Email)",
    {
      searchQuery: z.string().describe("SOSL search query starting with FIND"),
      limit: z.number().optional().describe("Maximum records per object (default 50)"),
    },
    async (params) => {
      try {
        const sanitized = sanitizeSOSL(params.searchQuery);
        const limit = validatePositiveInt(params.limit, "limit", 50);

        // Always enforce the capped LIMIT — replace any existing in-query LIMIT to prevent bypass
        const cappedLimit = Math.min(limit, 200);
        let finalQuery = sanitized.replace(/\bLIMIT\s+\d+/i, `LIMIT ${cappedLimit}`);
        if (!/\bLIMIT\b/i.test(finalQuery)) {
          finalQuery = `${finalQuery} LIMIT ${cappedLimit}`;
        }

        logger.info("SOSL search executed", { userEmail: callerEmail, tool: "search_records", query: redactQueryLiterals(finalQuery) });

        const result = await client.search(finalQuery);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              resultCount: result.searchRecords.length,
              records: result.searchRecords,
            }, null, 2),
          }],
        };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);

        const msg = err instanceof Error ? err.message : String(err);
        logger.error("SOSL search failed", { userEmail: callerEmail, tool: "search_records", reason: msg });

        if (msg.includes("No such column") || msg.includes("INVALID_FIELD")) {
          return toolError(
            "SOSL Error: One or more fields in your search don't exist on the specified object. " +
            "Use describe_object to check available fields before searching."
          );
        }
        if (msg.includes("INVALID_TYPE")) {
          return toolError(
            "SOSL Error: The object type in your RETURNING clause doesn't exist. " +
            "Use list_objects to see available object types."
          );
        }

        return toolError(`SOSL search failed: ${sanitizeError(err)}`);
      }
    }
  );
}
