import { describe, expect, it } from "vitest";
import { createUnlockClient } from "../packages/sdk/src/index";
import { createDemoService, seedWorkspace } from "../apps/web/src/server/demo";
import {
  CsvImportCapacityError,
  importCsvLogins,
} from "../apps/web/src/server/csv-import";
import {
  parseLoginCsv,
  previewCsv,
  suggestCsvMapping,
} from "../apps/web/src/lib/csv-import";
import {
  MAX_CSV_BYTES,
  normalizeImportLogin,
} from "../apps/web/src/lib/import-policy";
import { readBoundedJson } from "../apps/web/src/server/read-json";
const header = "name,url,username,password,notes\r\n";
const row = (n: number) => ({
  row: n + 2,
  name: `Site ${n}`,
  domain: `site-${n}.example.test`,
  identity: `user${n}@demo.example`,
});
function setup() {
  const service = createDemoService();
  const transport: typeof fetch = (url, init) =>
    service(new Request(url, init));
  return {
    api: createUnlockClient({
      baseUrl: "http://127.0.0.1:4173/api",
      transport,
    }),
    transport,
  };
}
const preview = (text: string) => {
  const table = parseLoginCsv(text);
  return previewCsv(
    table,
    suggestCsvMapping(table),
    seedWorkspace().connections,
  );
};
describe("local CSV reader", () => {
  it("reads BOM, CRLF, escaped quotes, commas, multiline notes and blank lines without retaining secrets", () => {
    const table = parseLoginCsv(
      "\uFEFF" +
        header +
        '"Work, ""design""",https://new.example.test,user@demo.example,PASSWORD_CANARY,"PRIVATE_NOTE\nsecond line"\r\n\r\n',
    );
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].cells[0]).toBe('Work, "design"');
    expect(JSON.stringify(table)).not.toMatch(
      /PASSWORD_CANARY|PRIVATE_NOTE|second line/,
    );
    expect(previewCsv(table, suggestCsvMapping(table), [])[0].status).toBe(
      "ready",
    );
  });
  it.each([
    ["name,url,username,password", ","],
    ["Title,Url,Username,Password", ","],
    ["name,login_uri,login_username,login_password", ","],
    ["name;url;username;password", ";"],
    ["name\turl\tusername\tpassword", "\t"],
  ])("maps common export headers and delimiter %s", (head, sep) => {
    const table = parseLoginCsv(
      head +
        "\n" +
        [
          "Work",
          "https://work.example.test",
          "user@demo.example",
          "CANARY",
        ].join(sep),
    );
    expect(suggestCsvMapping(table)).toEqual({
      name: 0,
      domain: 1,
      identity: 2,
    });
    expect(JSON.stringify(table)).not.toContain("CANARY");
  });
  it("supports custom column mapping and optional login names", () => {
    const table = parseLoginCsv(
      "host,handle,caption\nhttps://custom.example.test,user@demo.example,Custom",
    );
    expect(
      previewCsv(table, { domain: 0, identity: 1, name: -1 }, [])[0].login
        ?.name,
    ).toBe("custom.example.test");
    expect(previewCsv(table, { domain: 0, identity: 0, name: 2 }, [])).toEqual(
      [],
    );
  });
  it("will not map a password, notes or token column as metadata", () => {
    const table = parseLoginCsv(
      header + "Work,https://work.example.test,user@demo.example,SECRET,NOTE",
    );
    expect(previewCsv(table, { name: 3, domain: 1, identity: 2 }, [])).toEqual(
      [],
    );
  });
  it("detects existing/within-file duplicates but keeps different accounts on one host", () => {
    const rows = preview(
      header +
        "GitHub,https://GITHUB.example.test/path,developer@studio.example,p,n\nOne,https://new.example.test,a@demo.example,p,n\nTwo,https://new.example.test,b@demo.example,p,n\nCopy,new.example.test,a@demo.example,p,n",
    );
    expect(rows.map((r) => r.status)).toEqual([
      "duplicate",
      "ready",
      "ready",
      "duplicate",
    ]);
  });
  it("marks row errors, unsupported item types and real domains without exposing rejected values", () => {
    const rows = preview(
      "type,name,url,username,password\nlogin,Real,https://google.com,person@gmail.com,CANARY\ncard,Card,,,CANARY\nlogin,Wrong width,https://new.example.test\nlogin,Good,https://new.example.test,user@demo.example,CANARY",
    );
    expect(rows.map((r) => r.status)).toEqual([
      "invalid",
      "unsupported",
      "invalid",
      "ready",
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/CANARY|person@gmail.com/);
  });
  it.each([
    'a,b\n"not closed,CANARY',
    'a,b\n"closed"oops,x',
    'a,b\nx"oops,y',
    "a,b\n",
  ])("rejects malformed or empty files with safe errors", (text) => {
    expect(() => parseLoginCsv(text)).toThrow();
    try {
      parseLoginCsv(text);
    } catch (error) {
      expect(String(error)).not.toContain("CANARY");
    }
  });
  it("reads every one of 1,000 rows, rejecting over-limit files rather than truncating", () => {
    const rows = Array.from(
      { length: 1000 },
      (_, n) => `Site ${n},https://s${n}.example.test,u${n}@demo.example,p,n`,
    ).join("\n");
    expect(preview(header + rows)).toHaveLength(1000);
    expect(() =>
      parseLoginCsv(header + rows + "\nExtra,extra.test,x@demo.test,p,n"),
    ).toThrow("1,000");
    expect(() => parseLoginCsv("a".repeat(MAX_CSV_BYTES + 1))).toThrow("1 MiB");
  });
  it("normalizes a website and strips URL paths/query tokens; rejects userinfo and non-demo domains", () => {
    expect(
      normalizeImportLogin({
        name: "",
        domain: "https://WORK.example.test/path?token=CANARY",
        identity: "user@demo.example",
      }).login?.domain,
    ).toBe("work.example.test");
    for (const domain of [
      "https://user:CANARY@work.example.test",
      "javascript:alert(1)",
      "https://example.test.evil.com",
      "http://127.0.0.1",
      "https://bad_label.test",
    ])
      expect(
        normalizeImportLogin({
          name: "Work",
          domain,
          identity: "user@demo.example",
        }).error,
      ).toBeTruthy();
  });
});
describe("CSV batch API", () => {
  it("imports 1,000 independent records in one SDK request without granting agent access or pretending to have passwords", async () => {
    const { api } = setup();
    const profiles = await api.profiles.list();
    const result = await api.connections.importCsv({
      rows: Array.from({ length: 1000 }, (_, n) => row(n)),
    });
    expect(result.imported).toBe(1000);
    expect(await api.connections.list()).toHaveLength(1004);
    expect(await api.profiles.list()).toEqual(profiles);
    const saved = (await api.connections.list())[4];
    expect(saved).toMatchObject({
      passwordUnavailable: true,
      sourceMode: "snapshot",
      status: "challenge",
      maintenance: false,
    });
    expect((await api.workspace()).activity[0].detail).toContain(
      "1000 imported",
    );
    const assigned = await api.profiles.update("builder", {
      connectionIds: result.rows.map((r) => r.connectionId!),
    });
    expect(assigned.connectionIds).toHaveLength(1000);
  });
  it("skips exact duplicates on repeated imports without overwrites", async () => {
    const { api } = setup();
    await api.connections.importCsv({ rows: [row(0)] });
    const result = await api.connections.importCsv({
      rows: [
        { ...row(0), name: "Overwritten?" },
        { ...row(1), domain: row(0).domain },
      ],
    });
    expect(result).toMatchObject({ imported: 1, duplicates: 1, invalid: 0 });
    expect(
      (await api.connections.list()).find((c) => c.domain === row(0).domain)
        ?.name,
    ).toBe("Site 0");
  });
  it("validates each row server-side and returns only safe diagnostics", async () => {
    const { api } = setup();
    const result = await api.connections.importCsv({
      rows: [
        row(0),
        { ...row(1), domain: "https://real.example.com?secret=CANARY" },
      ],
    });
    expect(result).toMatchObject({ imported: 1, invalid: 1 });
    expect(JSON.stringify(result)).not.toMatch(/CANARY|real.example.com/);
  });
  it("rejects secret fields, unknown fields and duplicate row identifiers before any writes", async () => {
    const { api, transport } = setup();
    for (const body of [
      { rows: [row(0), { ...row(1), password: "CANARY" }] },
      { rows: [row(0)], profileIds: ["builder"] },
      { rows: [row(0), row(0)] },
    ]) {
      const response = await transport(
        "http://127.0.0.1:4173/api/connections/import",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
      expect(await response.text()).not.toContain("CANARY");
    }
    expect(await api.connections.list()).toHaveLength(4);
  });
  it("rejects excessive row counts before writing and reports capacity atomically", async () => {
    const { api } = setup();
    await expect(
      api.connections.importCsv({
        rows: Array.from({ length: 1001 }, (_, n) => row(n)),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const state = seedWorkspace();
    state.connections = Array.from({ length: 1999 }, (_, n) => ({
      ...state.connections[0],
      id: String(n),
    }));
    expect(() => importCsvLogins(state, { rows: [row(0), row(1)] })).toThrow(
      CsvImportCapacityError,
    );
    expect(state.connections).toHaveLength(1999);
  });
  it("keeps snapshots independent and supports editing punctuation from CSV titles", async () => {
    const { api } = setup();
    const result = await api.connections.importCsv({
      rows: [{ ...row(0), name: 'Work, "design"' }],
    });
    const id = result.rows[0].connectionId!;
    await api.connections.update(id, {
      name: 'Work, "design"',
      favorite: true,
    });
    await api.sources.update("onepassword", false);
    expect(
      (await api.connections.list()).find((c) => c.id === id),
    ).toMatchObject({
      favorite: true,
      passwordUnavailable: true,
      status: "challenge",
    });
  });
  it("bounds streamed bytes, including chunked and multi-byte input", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('"ééé"'));
        controller.close();
      },
    });
    const request = new Request("http://localhost", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    await expect(readBoundedJson(request, 7)).rejects.toThrow("Invalid body");
    await expect(
      readBoundedJson(
        new Request("http://localhost", {
          method: "POST",
          body: '{"ok":true}',
        }),
        20,
      ),
    ).resolves.toEqual({ ok: true });
  });
});
