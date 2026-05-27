/**
 * Record tools: get_record, list_objects, describe_object, get_records
 * Core record access and metadata discovery tools.
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SalesforceClient, sanitizeError } from "../salesforce-client.js";
import {
  ValidationError,
  validateSalesforceId,
  validateSObjectName,
  toolError,
} from "../validation.js";
import { logger } from "../logger.js";

export function registerRecordTools(server: McpServer, client: SalesforceClient, callerEmail = "unknown") {
  server.tool(
    "get_record",
    "Get a single Salesforce record by its object type and ID. Optionally specify which fields to return.",
    {
      sobject: z.string().describe("Salesforce object type (e.g. 'Account', 'Contact', 'Opportunity')"),
      id: z.string().describe("Salesforce record ID (15 or 18 characters)"),
      fields: z.array(z.string()).optional().describe("Specific fields to return. If omitted, returns all readable fields."),
    },
    async (params) => {
      try {
        const sobject = validateSObjectName(params.sobject, "sobject");
        const id = validateSalesforceId(params.id, "id");

        const record = await client.getRecord(sobject, id, params.fields);
        if (!record) {
          return toolError(`No ${sobject} record found with ID "${id}". Check the ID and object type.`);
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(record, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        return toolError(`Failed to get record: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "list_objects",
    "List all queryable Salesforce object types in the org (e.g. Account, Contact, Opportunity, Case). Use this to discover what data is available before querying.",
    {},
    async () => {
      try {
        const objects = await client.listObjects();
        // Return a compact summary — full list can be 500+ objects
        const summary = objects.map((o) => `${o.name} (${o.label})`).join("\n");
        return {
          content: [{
            type: "text" as const,
            text: `Found ${objects.length} queryable objects:\n\n${summary}`,
          }],
        };
      } catch (err) {
        return toolError(`Failed to list objects: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "describe_object",
    "Get metadata for a Salesforce object: field names, types, labels, and relationships. Essential for knowing what fields to use in queries. By default excludes picklist values to keep the response size manageable — set includePicklists=true if you need them.",
    {
      sobject: z.string().describe("Salesforce object type (e.g. 'Account', 'Contact')"),
      includePicklists: z.boolean().optional().describe("Include picklist option values (can be very large). Default: false"),
    },
    async (params) => {
      try {
        const sobject = validateSObjectName(params.sobject, "sobject");
        const desc = await client.describeObject(sobject, params.includePicklists ?? false);

        // Build a concise summary focused on field names and types
        const fieldSummary = desc.fields.map((f) => {
          let line = `${f.name} (${f.type}) — ${f.label}`;
          if (f.referenceTo.length > 0) {
            line += ` → ${f.referenceTo.join(", ")}`;
          }
          if (f.picklistValues?.length) {
            const values = f.picklistValues
              .filter((pv) => pv.active)
              .map((pv) => pv.value)
              .join(", ");
            line += ` [${values}]`;
          }
          return line;
        });

        const result = {
          name: desc.name,
          label: desc.label,
          labelPlural: desc.labelPlural,
          fieldCount: desc.fields.length,
          fields: fieldSummary,
          childRelationships: desc.childRelationships
            .filter((cr) => cr.relationshipName)
            .map((cr) => `${cr.relationshipName} → ${cr.childSObject}.${cr.field}`),
          recordTypes: desc.recordTypeInfos
            .filter((rt) => rt.active)
            .map((rt) => rt.name),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        return toolError(`Failed to describe object: ${sanitizeError(err)}`);
      }
    }
  );

  server.tool(
    "get_records",
    "Get up to 200 Salesforce records by ID in a single call. All IDs must belong to the same SObject type. Optionally specify which fields to return. Missing or inaccessible IDs are returned as {id, error} stubs — the call does not fail if some IDs are bad.",
    {
      sobject: z.string().describe("Salesforce object type (e.g. 'Account', 'Contact')"),
      ids: z.array(z.string()).describe("Salesforce record IDs (1-200 per call, all must be 15 or 18 characters)"),
      fields: z.array(z.string()).optional().describe("Specific fields to return. If omitted, returns all readable fields."),
    },
    async (params) => {
      try {
        const sobject = validateSObjectName(params.sobject, "sobject");

        if (!Array.isArray(params.ids) || params.ids.length === 0) {
          return toolError("`ids` must be a non-empty array of Salesforce IDs.");
        }
        if (params.ids.length > 200) {
          return toolError(`get_records supports a maximum of 200 IDs per call (got ${params.ids.length}). Split into multiple calls.`);
        }

        // Validate each ID — fail-fast at the boundary, before hitting Salesforce.
        const validatedIds = params.ids.map((id) => validateSalesforceId(id, "ids[i]"));

        const result = await client.getRecords(sobject, validatedIds, params.fields);

        // SOC 2 audit log — bulk record access is higher risk than single-record.
        // Log sobject and count; do NOT log IDs or field values (may contain PII).
        logger.info("Records batch retrieved", {
          userEmail: callerEmail,
          tool: "get_records",
          sobject,
          count: validatedIds.length,
          found: result.found,
          missing: result.missing,
        });

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ValidationError) return toolError(err.message);
        return toolError(`Failed to get records: ${sanitizeError(err)}`);
      }
    }
  );
}
