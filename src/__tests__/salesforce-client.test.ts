import { describe, it, expect } from "vitest";
import { SalesforceClient } from "../salesforce-client.js";

describe("SalesforceClient", () => {
  /**
   * CRITICAL SECURITY TEST: Ensures the client class never exposes write methods.
   * If someone adds create/update/delete/upsert to the class, this test fails.
   */
  it("exposes zero write methods on the prototype", () => {
    const writeMethodPatterns = [
      "create",
      "insert",
      "update",
      "upsert",
      "delete",
      "destroy",
      "merge",
      "undelete",
    ];

    const proto = SalesforceClient.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) => typeof (proto as unknown as Record<string, unknown>)[name] === "function" && name !== "constructor"
    );

    for (const method of methods) {
      for (const pattern of writeMethodPatterns) {
        expect(method.toLowerCase()).not.toContain(pattern);
      }
    }
  });

  it("has the expected read-only public methods", () => {
    const proto = SalesforceClient.prototype;
    const methods = Object.getOwnPropertyNames(proto).filter(
      (name) => typeof (proto as unknown as Record<string, unknown>)[name] === "function" && name !== "constructor"
    );

    // These are the methods we expect — all read-only
    const expectedMethods = [
      "authorize",
      "healthCheck",
      "query",
      "search",
      "getRecord",
      "listObjects",
      "describeObject",
      "getCurrentUser",
      "getApiLimits",
      "runReport",
    ];

    for (const expected of expectedMethods) {
      expect(methods).toContain(expected);
    }
  });
});

describe("getRecord cache key bug fix", () => {
  it("does not return stale partial records when fields differ", async () => {
    // Build a client with a stubbed jsforce Connection
    const fakeConn = {
      sobject: (_name: string) => ({
        retrieve: async (_id: string) => ({ Id: "001xx", Name: "Acme" }),
      }),
    };
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    // Inject the fake connection — required because the constructor instantiates a real one.
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    // First call: only Name field.
    const first = await client.getRecord("Account", "001xxxxxxxxxxxxxxx", ["Name"]);
    expect(first).toBeTruthy();

    // Second call with different fields — must NOT return the cached object,
    // because the cached entry was for a different field set.
    let secondCallReached = false;
    (client as unknown as { conn: { sobject: unknown } }).conn = {
      sobject: (_name: string) => ({
        retrieve: async (_id: string) => {
          secondCallReached = true;
          return { Id: "001xx", Name: "Acme", Industry: "Tech" };
        },
      }),
    };
    const second = await client.getRecord("Account", "001xxxxxxxxxxxxxxx", ["Name", "Industry"]);
    expect(secondCallReached).toBe(true); // proves the cache miss
    expect(second).toMatchObject({ Industry: "Tech" });
  });
});

describe("queryMore", () => {
  it("calls conn.queryMore with the cursor and returns paged results", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    let receivedCursor = "";
    const fakeConn = {
      queryMore: async (cursor: string) => {
        receivedCursor = cursor;
        return {
          records: [{ Id: "001xx", Name: "Page2" }],
          totalSize: 5000,
          done: false,
          nextRecordsUrl: "/services/data/v62.0/query/01g-4000",
        };
      },
    };
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    const result = await client.queryMore("/services/data/v62.0/query/01g-2000");
    expect(receivedCursor).toBe("/services/data/v62.0/query/01g-2000");
    expect(result.records).toHaveLength(1);
    expect(result.done).toBe(false);
    expect(result.nextRecordsUrl).toBe("/services/data/v62.0/query/01g-4000");
  });
});

describe("listReports cache key collision (MEDIUM-1)", () => {
  it("does not serve a cached result when search/folder values overlap across the colon separator", async () => {
    // Regression test for the colon-separator cache key collision:
    //   search="a", folder="b:c"  → old key "reports:a:b:c"
    //   search="a:b", folder="c"  → old key "reports:a:b:c"  ← same!
    // With JSON.stringify the keys are distinct and the second call must hit the API.
    const { SalesforceClient } = await import("../salesforce-client.js");
    const client = new SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });

    let apiCallCount = 0;
    const fakeConn = {
      analytics: {
        reports: async () => {
          apiCallCount++;
          return [
            { id: "00OXX1", name: "Alpha", folderName: "b:c", format: "Summary", lastRunDate: null },
          ];
        },
      },
    };
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    // First call: search="a", folder="b:c"
    await client.listReports({ search: "a", folder: "b:c" });
    expect(apiCallCount).toBe(1);

    // Second call: search="a:b", folder="c"
    // With the buggy colon key, this hits the cache (apiCallCount stays 1).
    // With the JSON.stringify fix, the key is different → a second API call is made.
    await client.listReports({ search: "a:b", folder: "c" });
    expect(apiCallCount).toBe(2);
  });
});

describe("listReports", () => {
  it("returns reports with id, name, folder, format, lastRunDate", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    const fakeConn = {
      analytics: {
        reports: async () => [
          { id: "00OXX1", name: "Pipeline by Stage", folderName: "Sales", format: "Summary", lastRunDate: "2026-04-25T00:00:00Z" },
          { id: "00OXX2", name: "Closed Won by Rep", folderName: "Sales", format: "Tabular", lastRunDate: "2026-04-20T00:00:00Z" },
          { id: "00OXX3", name: "ARR by Quarter", folderName: "Finance", format: "Matrix", lastRunDate: "2026-04-26T00:00:00Z" },
        ],
      },
    };
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    const all = await client.listReports();
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ id: "00OXX1", name: "Pipeline by Stage", folder: "Sales", format: "Summary" });

    const sales = await client.listReports({ folder: "Sales" });
    expect(sales).toHaveLength(2);

    const pipeline = await client.listReports({ search: "pipeline" });
    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].name).toBe("Pipeline by Stage");
  });
});

describe("describeReport", () => {
  it("returns columns and current filters for a report", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    const fakeConn = {
      analytics: {
        report: (_id: string) => ({
          describe: async () => ({
            reportMetadata: {
              name: "Pipeline by Stage",
              reportFormat: "Summary",
              detailColumns: ["OPPORTUNITY.NAME", "OPPORTUNITY.AMOUNT"],
              reportFilters: [{ column: "STAGE_NAME", operator: "equals", value: "Closed Won" }],
            },
            reportTypeMetadata: {
              detailColumnInfo: {
                "OPPORTUNITY.NAME": { label: "Opportunity Name", dataType: "string" },
                "OPPORTUNITY.AMOUNT": { label: "Amount", dataType: "currency" },
              },
            },
          }),
        }),
      },
    };
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    const desc = await client.describeReport("00OXX1");
    expect(desc.name).toBe("Pipeline by Stage");
    expect(desc.reportFormat).toBe("Summary");
    expect(desc.columns).toEqual([
      { apiName: "OPPORTUNITY.NAME", label: "Opportunity Name", dataType: "string" },
      { apiName: "OPPORTUNITY.AMOUNT", label: "Amount", dataType: "currency" },
    ]);
    expect(desc.filters).toEqual([{ column: "STAGE_NAME", operator: "equals", value: "Closed Won" }]);
  });
});

describe("getRecords (batched)", () => {
  it("retrieves multiple records in one call and returns missing IDs as error stubs", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    const fakeConn = {
      sobject: (_name: string) => ({
        retrieve: async (ids: string[], _opts?: unknown) => {
          // Simulate jsforce SObject Collections behavior — null entries for missing.
          return ids.map((id) => id === "001AAA" ? null : { Id: id, Name: `Acct-${id}` });
        },
      }),
    };
    (client as unknown as { conn: unknown }).conn = fakeConn;
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();

    const result = await client.getRecords("Account", ["001BBB", "001AAA", "001CCC"], ["Name"]);
    expect(result.found).toBe(2);
    expect(result.missing).toBe(1);
    expect(result.records).toHaveLength(3);
    expect(result.records[0]).toMatchObject({ Id: "001BBB" });
    expect(result.records[1]).toMatchObject({ id: "001AAA", error: expect.stringContaining("not found") });
  });

  it("rejects more than 200 IDs", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();
    const ids = new Array(201).fill("001xxxxxxxxxxxxxxx");
    await expect(client.getRecords("Account", ids)).rejects.toThrow(/200/);
  });

  it("rejects empty ID list", async () => {
    const client = new (await import("../salesforce-client.js")).SalesforceClient({
      clientId: "x", clientSecret: "x", instanceUrl: "https://example", loginUrl: "https://example", apiVersion: "62.0",
    });
    (client as unknown as { tokenIssuedAt: number }).tokenIssuedAt = Date.now();
    await expect(client.getRecords("Account", [])).rejects.toThrow(/empty|at least/i);
  });
});
