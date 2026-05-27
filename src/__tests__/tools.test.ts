import { describe, it, expect, vi, afterEach } from "vitest";

/**
 * Basic structural tests for tool modules.
 * Verifies that tool registration functions are exported and callable.
 * Functional tool testing requires a live Salesforce connection.
 */

describe("tool modules export registration functions", () => {
  it("system tools exports registerSystemTools", async () => {
    const mod = await import("../tools/system.js");
    expect(typeof mod.registerSystemTools).toBe("function");
  });

  it("record tools exports registerRecordTools", async () => {
    const mod = await import("../tools/records.js");
    expect(typeof mod.registerRecordTools).toBe("function");
  });

  it("query tools exports registerQueryTools", async () => {
    const mod = await import("../tools/query.js");
    expect(typeof mod.registerQueryTools).toBe("function");
  });

  it("report tools exports registerReportTools", async () => {
    const mod = await import("../tools/reports.js");
    expect(typeof mod.registerReportTools).toBe("function");
  });
});

describe("query_records cursor and truncation", () => {
  it("returns nextCursor and a _warning when truncated at cap", async () => {
    const { registerQueryTools } = await import("../tools/query.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      query: async (_soql: string, _max: number) => ({
        records: new Array(5000).fill({ Id: "001xxx" }),
        totalSize: 12000,
        done: false,
        nextRecordsUrl: "/services/data/v62.0/query/abc-5000",
      }),
      queryMore: async (_cursor: string) => ({
        records: new Array(5000).fill({ Id: "001yyy" }),
        totalSize: 12000,
        done: false,
        nextRecordsUrl: "/services/data/v62.0/query/abc-10000",
      }),
    };
    registerQueryTools(server, fakeClient as never, "user@example.com");

    // Invoke through the registered handler. McpServer exposes registered tools internally;
    // call the underlying handler directly via the public `_registeredTools` shape.
    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["query_records"];
    expect(tool).toBeTruthy();

    const res = await tool.handler({ query: "SELECT Id FROM Account" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed._warning).toMatch(/truncated/i);
    expect(parsed.nextCursor).toBe("/services/data/v62.0/query/abc-5000");
    expect(parsed.recordCount).toBe(5000);
    expect(parsed.totalSize).toBe(12000);
  });

  it("uses queryMore when cursor is provided", async () => {
    const { registerQueryTools } = await import("../tools/query.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    let queryCalled = false;
    let queryMoreCalled = false;
    const fakeClient = {
      query: async () => { queryCalled = true; return { records: [], totalSize: 0, done: true }; },
      queryMore: async (_c: string) => {
        queryMoreCalled = true;
        return { records: [{ Id: "001zzz" }], totalSize: 1, done: true };
      },
    };
    registerQueryTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["query_records"];
    await tool.handler({ cursor: "/services/data/v62.0/query/abc-5000" });
    expect(queryMoreCalled).toBe(true);
    expect(queryCalled).toBe(false);
  });

  it("rejects passing both query and cursor", async () => {
    const { registerQueryTools } = await import("../tools/query.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });
    registerQueryTools(server, { query: async () => ({ records: [], totalSize: 0, done: true }), queryMore: async () => ({ records: [], totalSize: 0, done: true }) } as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> }> })._registeredTools["query_records"];
    const res = await tool.handler({ query: "SELECT Id FROM Account", cursor: "/services/data/v62.0/query/abc-1" });
    expect(res.isError).toBe(true);
  });
});

describe("list_reports tool", () => {
  it("returns the report list with summary fields", async () => {
    const { registerReportTools } = await import("../tools/reports.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      listReports: async (_opts: unknown) => [
        { id: "00OXX1", name: "Pipeline by Stage", folder: "Sales", format: "Summary", lastRunDate: "2026-04-25T00:00:00Z" },
      ],
    };
    registerReportTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["list_reports"];
    expect(tool).toBeTruthy();
    const res = await tool.handler({ search: "pipe" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.reports).toHaveLength(1);
    expect(parsed.reports[0]).toMatchObject({ id: "00OXX1", folder: "Sales" });
  });

  it("requires search or folder when total reports exceed 100", async () => {
    const { registerReportTools } = await import("../tools/reports.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      listReports: async () => new Array(150).fill({ id: "00O", name: "X", folder: "F", format: "T", lastRunDate: null }),
    };
    registerReportTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["list_reports"];
    const res = await tool.handler({});
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed._note).toMatch(/search.*folder/i);
    expect(parsed.reports.length).toBeLessThanOrEqual(50);
  });
});

describe("describe_report tool", () => {
  it("returns the report description JSON-serialized", async () => {
    const { registerReportTools } = await import("../tools/reports.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      describeReport: async (_id: string) => ({
        name: "Pipeline by Stage",
        reportFormat: "Summary",
        columns: [{ apiName: "OPP.NAME", label: "Name", dataType: "string" }],
        filters: [{ column: "STAGE_NAME", operator: "equals", value: "Closed Won" }],
      }),
    };
    registerReportTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["describe_report"];
    const res = await tool.handler({ reportId: "00OXX0000001AbcDEF" });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.name).toBe("Pipeline by Stage");
    expect(parsed.columns).toHaveLength(1);
    expect(parsed.filters).toHaveLength(1);
  });
});

describe("get_records tool", () => {
  it("forwards sobject, ids, and fields to client.getRecords", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    let received: { sobject: string; ids: string[]; fields?: string[] } | null = null;
    const fakeClient = {
      getRecords: async (sobject: string, ids: string[], fields?: string[]) => {
        received = { sobject, ids, fields };
        return { found: ids.length, missing: 0, records: ids.map((id) => ({ Id: id })) };
      },
    };
    registerRecordTools(server, fakeClient as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["get_records"];
    expect(tool).toBeTruthy();

    const res = await tool.handler({
      sobject: "Account",
      ids: ["001xxxxxxxxxxxxxxx", "001yyyyyyyyyyyyyyy"],
      fields: ["Name", "Industry"],
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(received).toEqual({ sobject: "Account", ids: ["001xxxxxxxxxxxxxxx", "001yyyyyyyyyyyyyyy"], fields: ["Name", "Industry"] });
    expect(parsed.found).toBe(2);
  });

  it("returns partial-failure stubs alongside valid records", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      getRecords: async (_sobject: string, ids: string[]) => ({
        found: 2,
        missing: 1,
        records: [
          { Id: ids[0], Name: "Acme" },
          { Id: ids[1], Name: "Bravo" },
          { id: ids[2], error: "Record not found or not accessible" },
        ],
      }),
    };
    registerRecordTools(server, fakeClient as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["get_records"];
    const res = await tool.handler({
      sobject: "Account",
      ids: ["001xxxxxxxxxxxxxxx", "001yyyyyyyyyyyyyyy", "001zzzzzzzzzzzzzzz"],
    });
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.found).toBe(2);
    expect(parsed.missing).toBe(1);
    expect(parsed.records).toHaveLength(3);
    const stub = parsed.records[2];
    expect(stub.error).toBe("Record not found or not accessible");
  });

  it("rejects invalid Salesforce IDs in the list", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    registerRecordTools(server, { getRecords: async () => ({ found: 0, missing: 0, records: [] }) } as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools["get_records"];
    const res = await tool.handler({ sobject: "Account", ids: ["not-an-id"] });
    expect(res.isError).toBe(true);
  });

  it("rejects an invalid sobject name", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    registerRecordTools(server, { getRecords: async () => ({ found: 0, missing: 0, records: [] }) } as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools["get_records"];
    const res = await tool.handler({ sobject: "'; DROP TABLE--", ids: ["001xxxxxxxxxxxxxxx"] });
    expect(res.isError).toBe(true);
  });

  it("rejects more than 200 IDs", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    registerRecordTools(server, { getRecords: async () => ({ found: 0, missing: 0, records: [] }) } as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools["get_records"];
    // Build 201 valid-format IDs
    const ids = Array.from({ length: 201 }, (_, i) => `001${String(i).padStart(15, "x")}`);
    const res = await tool.handler({ sobject: "Account", ids });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/200/);
  });

  it("rejects an empty ids array", async () => {
    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    registerRecordTools(server, { getRecords: async () => ({ found: 0, missing: 0, records: [] }) } as never);

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools["get_records"];
    const res = await tool.handler({ sobject: "Account", ids: [] });
    expect(res.isError).toBe(true);
  });
});

describe("get_records audit logging (MEDIUM-3)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a logger.info entry with userEmail, tool, sobject, and count when get_records succeeds", async () => {
    const loggerMod = await import("../logger.js");
    const infoSpy = vi.spyOn(loggerMod.logger, "info");

    const { registerRecordTools } = await import("../tools/records.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = {
      getRecords: async (sobject: string, ids: string[], _fields?: string[]) => ({
        found: ids.length,
        missing: 0,
        records: ids.map((id) => ({ Id: id })),
      }),
    };

    // registerRecordTools must accept callerEmail as third argument (the fix)
    registerRecordTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (p: unknown) => Promise<unknown> }>;
    })._registeredTools["get_records"];

    await tool.handler({
      sobject: "Account",
      ids: ["001xxxxxxxxxxxxxxx", "001yyyyyyyyyyyyyyy"],
    });

    // Assert that logger.info was called with audit fields
    const auditCall = infoSpy.mock.calls.find(
      ([_msg, fields]) =>
        fields !== undefined &&
        (fields as Record<string, unknown>).tool === "get_records"
    );
    expect(auditCall).toBeTruthy();
    const [_msg, fields] = auditCall!;
    expect((fields as Record<string, unknown>).userEmail).toBe("user@example.com");
    expect((fields as Record<string, unknown>).sobject).toBe("Account");
    expect((fields as Record<string, unknown>).count).toBe(2);
  });
});

describe("run_report with filterOverrides", () => {
  it("forwards filter overrides to the client", async () => {
    const { registerReportTools } = await import("../tools/reports.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    let receivedFilters: unknown = null;
    const fakeClient = {
      runReport: async (_id: string, _includeDetails: boolean, filters?: unknown) => {
        receivedFilters = filters;
        return { reportMetadata: { name: "X" }, factMap: {} };
      },
    };
    registerReportTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ content: { text: string }[] }> }> })._registeredTools["run_report"];
    await tool.handler({
      reportId: "00OXX0000001AbcDEF",
      filterOverrides: [{ column: "STAGE_NAME", operator: "equals", value: "Closed Won" }],
    });
    expect(receivedFilters).toEqual([{ column: "STAGE_NAME", operator: "equals", value: "Closed Won" }]);
  });

  it("rejects disallowed filter operators", async () => {
    const { registerReportTools } = await import("../tools/reports.js");
    const McpModule = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const server = new McpModule.McpServer({ name: "test", version: "0.0.0" });

    const fakeClient = { runReport: async () => ({ ok: true }) };
    registerReportTools(server, fakeClient as never, "user@example.com");

    const tool = (server as unknown as { _registeredTools: Record<string, { handler: (p: unknown) => Promise<{ isError?: boolean; content: { text: string }[] }> }> })._registeredTools["run_report"];
    const res = await tool.handler({
      reportId: "00OXX0000001AbcDEF",
      filterOverrides: [{ column: "STAGE_NAME", operator: "delete", value: "x" }],
    });
    expect(res.isError).toBe(true);
  });
});
