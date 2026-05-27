import { describe, it, expect } from "vitest";
import {
  sanitizeSOQL,
  sanitizeSOSL,
  validateSalesforceId,
  validateSObjectName,
  validatePositiveInt,
  validateDateParam,
  ValidationError,
} from "../validation.js";

// ── SOQL Sanitizer ──

describe("sanitizeSOQL", () => {
  it("accepts valid SELECT queries", () => {
    expect(sanitizeSOQL("SELECT Id, Name FROM Account")).toBe("SELECT Id, Name FROM Account");
    expect(sanitizeSOQL("SELECT Id FROM Account WHERE Name = 'Acme'")).toContain("SELECT");
    expect(sanitizeSOQL("select id from account")).toBe("select id from account"); // case-insensitive
  });

  it("accepts queries with subqueries", () => {
    expect(sanitizeSOQL("SELECT Name, (SELECT Id FROM Contacts) FROM Account")).toContain("SELECT");
  });

  it("accepts queries with WHERE, ORDER BY, GROUP BY", () => {
    expect(sanitizeSOQL("SELECT Id FROM Opportunity WHERE StageName = 'Closed Won' ORDER BY CloseDate DESC")).toContain("SELECT");
    expect(sanitizeSOQL("SELECT StageName, COUNT(Id) FROM Opportunity GROUP BY StageName")).toContain("SELECT");
  });

  it("rejects empty queries", () => {
    expect(() => sanitizeSOQL("")).toThrow(ValidationError);
    expect(() => sanitizeSOQL("   ")).toThrow(ValidationError);
  });

  it("rejects queries over 20K chars", () => {
    const longQuery = "SELECT Id FROM Account WHERE Name = '" + "x".repeat(20001) + "'";
    expect(() => sanitizeSOQL(longQuery)).toThrow("too long");
  });

  it("rejects queries with semicolons", () => {
    expect(() => sanitizeSOQL("SELECT Id FROM Account; DELETE FROM Account")).toThrow("semicolons");
  });

  it("rejects queries not starting with SELECT", () => {
    expect(() => sanitizeSOQL("DELETE FROM Account")).toThrow("must start with SELECT");
    expect(() => sanitizeSOQL("UPDATE Account SET Name = 'foo'")).toThrow("must start with SELECT");
    expect(() => sanitizeSOQL("INSERT INTO Account")).toThrow("must start with SELECT");
  });

  it("rejects DML keywords as standalone tokens", () => {
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE INSERT = true")).toThrow("blocked keyword");
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE UPDATE = true")).toThrow("blocked keyword");
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE DELETE = true")).toThrow("blocked keyword");
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE MERGE = true")).toThrow("blocked keyword");
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE UPSERT = true")).toThrow("blocked keyword");
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE UNDELETE = true")).toThrow("blocked keyword");
  });

  it("rejects DML keywords case-insensitively", () => {
    expect(() => sanitizeSOQL("SELECT Id FROM Account WHERE dElEtE = true")).toThrow("blocked keyword");
  });

  it("does NOT reject field names containing DML substrings", () => {
    // "Updated_At__c" contains "Update" but is not the standalone keyword "UPDATE"
    expect(sanitizeSOQL("SELECT Updated_At__c FROM Account")).toContain("SELECT");
    expect(sanitizeSOQL("SELECT Deleted__c FROM Account")).toContain("SELECT");
  });
});

// ── SOSL Sanitizer ──

describe("sanitizeSOSL", () => {
  it("accepts valid FIND queries", () => {
    expect(sanitizeSOSL("FIND {Acme} IN ALL FIELDS RETURNING Account(Name, Id)")).toContain("FIND");
  });

  it("rejects empty queries", () => {
    expect(() => sanitizeSOSL("")).toThrow(ValidationError);
  });

  it("rejects queries not starting with FIND", () => {
    expect(() => sanitizeSOSL("SELECT Id FROM Account")).toThrow("must start with FIND");
  });

  it("rejects DML keywords", () => {
    expect(() => sanitizeSOSL("FIND {test} DELETE")).toThrow("blocked keyword");
  });

  it("rejects semicolons", () => {
    expect(() => sanitizeSOSL("FIND {test}; DROP TABLE")).toThrow("semicolons");
  });
});

// ── Salesforce ID Validator ──

describe("validateSalesforceId", () => {
  it("accepts 15-char IDs", () => {
    expect(validateSalesforceId("001xx000003DGbY", "id")).toBe("001xx000003DGbY");
  });

  it("accepts 18-char IDs", () => {
    expect(validateSalesforceId("001xx000003DGbYAAW", "id")).toBe("001xx000003DGbYAAW");
  });

  it("rejects empty IDs", () => {
    expect(() => validateSalesforceId("", "id")).toThrow(ValidationError);
    expect(() => validateSalesforceId(undefined, "id")).toThrow(ValidationError);
  });

  it("rejects invalid format", () => {
    expect(() => validateSalesforceId("too-short", "id")).toThrow("valid Salesforce ID");
    expect(() => validateSalesforceId("001xx000003DGbY!!", "id")).toThrow("valid Salesforce ID");
  });
});

// ── SObject Name Validator ──

describe("validateSObjectName", () => {
  it("accepts standard objects", () => {
    expect(validateSObjectName("Account", "sobject")).toBe("Account");
    expect(validateSObjectName("Contact", "sobject")).toBe("Contact");
  });

  it("accepts custom objects", () => {
    expect(validateSObjectName("Custom_Object__c", "sobject")).toBe("Custom_Object__c");
  });

  it("rejects empty names", () => {
    expect(() => validateSObjectName("", "sobject")).toThrow(ValidationError);
  });

  it("rejects names with special characters", () => {
    expect(() => validateSObjectName("Account; DROP", "sobject")).toThrow("valid Salesforce object name");
  });
});

// ── Positive Int Validator ──

describe("validatePositiveInt", () => {
  it("returns default when undefined", () => {
    expect(validatePositiveInt(undefined, "limit", 200)).toBe(200);
  });

  it("accepts valid integers", () => {
    expect(validatePositiveInt(50, "limit", 200)).toBe(50);
  });

  it("rejects zero and negative", () => {
    expect(() => validatePositiveInt(0, "limit", 200)).toThrow(ValidationError);
    expect(() => validatePositiveInt(-1, "limit", 200)).toThrow(ValidationError);
  });
});

// ── Date Validator ──

describe("validateDateParam", () => {
  it("accepts valid ISO dates", () => {
    expect(() => validateDateParam("2026-03-16", "date")).not.toThrow();
    expect(() => validateDateParam("2026-03-16T09:00:00Z", "date")).not.toThrow();
  });

  it("skips undefined", () => {
    expect(() => validateDateParam(undefined, "date")).not.toThrow();
  });

  it("rejects invalid dates", () => {
    expect(() => validateDateParam("not-a-date", "date")).toThrow(ValidationError);
  });
});

import { validateCursor, validateFilterOverride } from "../validation.js";

describe("validateCursor", () => {
  it("accepts a valid Salesforce nextRecordsUrl", () => {
    const cursor = "/services/data/v62.0/query/01g4x00001ZxYzAAA-2000";
    expect(validateCursor(cursor)).toBe(cursor);
  });

  it("trims surrounding whitespace", () => {
    const cursor = "  /services/data/v62.0/query/01g4x00001ZxYzAAA-2000  ";
    expect(validateCursor(cursor)).toBe("/services/data/v62.0/query/01g4x00001ZxYzAAA-2000");
  });

  it("rejects empty cursors", () => {
    expect(() => validateCursor("")).toThrow(ValidationError);
    expect(() => validateCursor("   ")).toThrow(ValidationError);
  });

  it("rejects cursors not matching nextRecordsUrl shape", () => {
    expect(() => validateCursor("/foo/bar")).toThrow(ValidationError);
    expect(() => validateCursor("https://example.com/services/data/v62.0/query/abc")).toThrow(ValidationError);
    expect(() => validateCursor("/services/data/v62.0/query/abc; DROP TABLE")).toThrow(ValidationError);
  });
});

describe("validateFilterOverride", () => {
  it("accepts a valid filter with allowed operator", () => {
    const result = validateFilterOverride({ column: "StageName", operator: "equals", value: "Closed Won" });
    expect(result).toEqual({ column: "StageName", operator: "equals", value: "Closed Won" });
  });

  it("rejects unknown operators", () => {
    expect(() => validateFilterOverride({ column: "StageName", operator: "delete", value: "x" })).toThrow(ValidationError);
    expect(() => validateFilterOverride({ column: "StageName", operator: "drop", value: "x" })).toThrow(ValidationError);
  });

  it("rejects malformed shapes", () => {
    expect(() => validateFilterOverride({})).toThrow(ValidationError);
    expect(() => validateFilterOverride({ column: "X", operator: "equals" })).toThrow(ValidationError);
    expect(() => validateFilterOverride(null)).toThrow(ValidationError);
    expect(() => validateFilterOverride("string")).toThrow(ValidationError);
  });

  it("rejects column names with non-alphanumeric/underscore characters", () => {
    expect(() => validateFilterOverride({ column: "Name; DROP", operator: "equals", value: "x" })).toThrow(ValidationError);
    expect(() => validateFilterOverride({ column: "Name'", operator: "equals", value: "x" })).toThrow(ValidationError);
  });
});
