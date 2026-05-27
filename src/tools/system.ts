/**
 * System tools: get_current_user, get_api_limits
 * Diagnostic tools for checking connection health and API usage.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SalesforceClient, sanitizeError } from "../salesforce-client.js";
import { toolError } from "../validation.js";
import { logger } from "../logger.js";

export function registerSystemTools(server: McpServer, client: SalesforceClient, callerEmail: string) {
  server.tool(
    "get_current_user",
    "Show the authenticated Salesforce integration user's info (username, email, org ID). Useful for verifying the connection is working.",
    {},
    async () => {
      try {
        logger.info("System tool called", { userEmail: callerEmail, tool: "get_current_user" });
        const user = await client.getCurrentUser();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(user, null, 2) }],
        };
      } catch (err) {
        return toolError(`Failed to get current user: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "get_api_limits",
    "Show current Salesforce API usage and daily limits. Use this to check how much API quota has been consumed today.",
    {},
    async () => {
      try {
        logger.info("System tool called", { userEmail: callerEmail, tool: "get_api_limits" });
        // Make a lightweight call first to ensure limitInfo is populated
        await client.getCurrentUser();
        const limits = client.getApiLimits();
        return {
          content: [{ type: "text" as const, text: JSON.stringify(limits, null, 2) }],
        };
      } catch (err) {
        return toolError(`Failed to get API limits: ${sanitizeError(err)}`);
      }
    }
  );
}
