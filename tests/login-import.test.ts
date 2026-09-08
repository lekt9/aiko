import { describe, expect, it } from "vitest";
import { LOGIN_IMPORT_MAX_BYTES, LOGIN_IMPORT_MAX_ROWS, LOGIN_IMPORT_SIZE_MESSAGE, loginImportCapacityError } from "@unlock/protocol";
import { previewConnectorCsv, rowsFromPreviews } from "../apps/web/src/lib/login-import.js";

describe("hosted metadata import capacity contract", () => {
  it("measures the serialized envelope inclusively, including Unicode and JSON escaping", () => {
    const row = { website: "example.com", name: '用"\\' };
    const overhead = new TextEncoder().encode(JSON.stringify({ rows: [row] })).byteLength;
    const exact = [{ ...row, name: row.name + "a".repeat(LOGIN_IMPORT_MAX_BYTES - overhead) }];
    expect(new TextEncoder().encode(JSON.stringify({ rows: exact })).byteLength).toBe(LOGIN_IMPORT_MAX_BYTES);
    expect(loginImportCapacityError(exact)).toBeUndefined();
    expect(loginImportCapacityError([{ ...exact[0], name: exact[0].name + "a" }])).toBe(LOGIN_IMPORT_SIZE_MESSAGE);
    expect(loginImportCapacityError(Array.from({ length: LOGIN_IMPORT_MAX_ROWS }, () => row))).toBeUndefined();
    expect(loginImportCapacityError(Array.from({ length: LOGIN_IMPORT_MAX_ROWS + 1 }, () => row))).toContain("500");
  });

  it("only measures metadata sent by the preview, never exported passwords", () => {
    const previews = previewConnectorCsv({
      columns: ["name", "url", "username", "password"].map(label => ({ label, ignored: false })),
      rows: [{ row: 2, cells: ["Example", "example.com", "person", "SYNTHETIC-PASSWORD-".repeat(70_000)], malformed: false }],
    }, { name: 0, domain: 1, identity: 2 }, []);
    const rows = rowsFromPreviews(previews);
    expect(rows).toEqual([{ name: "Example", website: "example.com", username: "person" }]);
    expect(loginImportCapacityError(rows)).toBeUndefined();
  });
});
