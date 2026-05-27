/**
 * Report tool: run_report
 * Executes saved Salesforce reports by report ID.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SalesforceClient, sanitizeError } from "../salesforce-client.js";
import {
  ValidationError,
  validateSalesforceId,
  validateFilterOverride,
  toolError,
} from "../validation.js";
import { logger } from "../logger.js";

export function registerReportTools(server: McpServer, client: SalesforceClient, callerEmail: string) {
  server.tool(
    "run_report",
    "Execute a saved Salesforce report by report ID. Returns summary data and optionally detail rows (capped at 2000). Use describe_report first to see what filter columns are available, then optionally pass filterOverrides to run with different filter values without changing the report definition.",
    {
      reportId: z.string().describe("Salesforce report ID (15 or 18 characters)"),
      includeDetails: z.boolean().optional().describe("Include detail rows (default false — returns only summary/aggregates). Detail rows are capped at 2000."),
      filterOverrides: z.array(z.object({
        column: z.string(),
        operator: z.string(),
        value: z.string(),
      })).optional().describe("Override report filters for this run. Allowed operators: equals, notEqual, lessThan, greaterThan, lessOrEqual, greaterOrEqual, contains, notContain, startsWith, includes, excludes."),
    },
    async (params) => {
      try {
        const reportId = validateSalesforceId(params.reportId, "reportId");
        const includeDetails = params.includeDetails ?? false;

        const overrides = params.filterOverrides
          ? params.filterOverrides.map((f) => validateFilterOverride(f))
          : undefined;

        // Log without filter values — values may contain PII.
        logger.info("Report executed", {
          userEmail: callerEmail,
          tool: "run_report",
          reportId,
          overrideCount: overrides?.length ?? 0,
        });

        const result = await client.runReport(reportId, includeDetails, overrides);

        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);

        const msg = err instanceof Error ? err.message : String(err);
        logger.error("Report execution failed", { userEmail: callerEmail, tool: "run_report", reason: msg });

        if (msg.includes("INVALID_REPORT")) {
          return toolError("Report not found. Check the report ID — find it in the Salesforce URL when viewing the report.");
        }
        return toolError(`Report execution failed: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "list_reports",
    "List Salesforce reports the integration user can access. Use `search` or `folder` to narrow results — when more than 100 reports are available, narrowing is required. Returns id, name, folder, format, and lastRunDate.",
    {
      search: z.string().optional().describe("Substring match on report name (case-insensitive)"),
      folder: z.string().optional().describe("Exact match on folder name"),
      limit: z.number().optional().describe("Max reports to return (1-200, default 50)"),
    },
    async (params) => {
      try {
        const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
        const all = await client.listReports({ search: params.search, folder: params.folder });

        let reports = all;
        let note: string | undefined;
        if (!params.search && !params.folder && all.length > 100) {
          reports = all.slice(0, 50);
          note = `${all.length} reports available — showing first 50. Pass \`search\` (substring) or \`folder\` (exact) to narrow.`;
        } else {
          reports = all.slice(0, limit);
        }

        logger.info("Reports listed", { userEmail: callerEmail, tool: "list_reports", returned: reports.length, total: all.length });

        const response: Record<string, unknown> = { count: reports.length, reports };
        if (note) response._note = note;

        return { content: [{ type: "text" as const, text: JSON.stringify(response, null, 2) }] };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        return toolError(`Failed to list reports: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "describe_report",
    "Inspect a Salesforce report's columns and current filter criteria. Use this before calling run_report with filterOverrides to know which columns and operators apply.",
    {
      reportId: z.string().describe("Salesforce report ID (15 or 18 characters)"),
    },
    async (params) => {
      try {
        const reportId = validateSalesforceId(params.reportId, "reportId");
        const desc = await client.describeReport(reportId);
        logger.info("Report described", { userEmail: callerEmail, tool: "describe_report", reportId });
        return { content: [{ type: "text" as const, text: JSON.stringify(desc, null, 2) }] };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);

        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("INVALID_REPORT")) {
          return toolError("Report not found. Check the report ID — find it in the Salesforce URL when viewing the report.");
        }
        return toolError(`Failed to describe report: ${sanitizeError(err)}`);
      }
    }
  );
}
