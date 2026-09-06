import Papa from "papaparse";
import { randomUUID } from "node:crypto";
import {
  connectionCreate,
  z,
  type VaultConnectionInput,
  type VaultImportPreview,
} from "@unlock/protocol";
import { context, Vault } from "./vault.js";
import { digest, type Envelope } from "./crypto.js";
import { requireValue, VaultError } from "./errors.js";
interface Staged {
  rows: { row: number; input: VaultConnectionInput }[];
  preview: VaultImportPreview;
  result?: { imported: number; duplicates: number; connectionIds: string[] };
  selectionHash?: string;
}
export class Imports {
  constructor(private vault: Vault) {}
  async preview(tenant: string, body: unknown) {
    const input = z
      .object({
        csv: z.string().max(1_048_576),
        columns: z
          .object({
            name: z.string(),
            url: z.string(),
            username: z.string(),
            password: z.string(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(body);
    if (Buffer.byteLength(input.csv) > 1_048_576)
      throw new VaultError("CAPACITY", 413);
    const parsed = Papa.parse<string[]>(input.csv.replace(/^\uFEFF/, ""), {
      skipEmptyLines: "greedy",
    });
    if (
      parsed.errors.length ||
      parsed.data.length < 2 ||
      parsed.data.length > 1001 ||
      parsed.data[0].length > 100
    )
      throw new VaultError("INVALID_INPUT");
    const columns = parsed.data[0],
      normalize = (s: string) =>
        s
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "");
    const aliases = {
      name: ["name", "title"],
      url: ["url", "website", "loginuri"],
      username: ["username", "loginusername", "email"],
      password: ["password", "loginpassword"],
    };
    const indices = Object.fromEntries(
      Object.entries(aliases).map(([key, names]) => [
        key,
        input.columns
          ? columns.indexOf(input.columns[key as keyof typeof aliases])
          : columns.findIndex((c) => names.includes(normalize(c))),
      ]),
    ) as Record<keyof typeof aliases, number>;
    if (
      indices.url < 0 ||
      indices.username < 0 ||
      new Set(Object.values(indices).filter((i) => i >= 0)).size !==
        Object.values(indices).filter((i) => i >= 0).length
    )
      throw new VaultError("INVALID_INPUT");
    const typeIndex = columns.findIndex((c) => normalize(c) === "type"),
      importId = randomUUID(),
      expiresAt = this.vault.now() + 600_000;
    const staged: Staged = {
        rows: [],
        preview: { id: importId, expiresAt, rows: [] },
      },
      existing = await this.vault.list(tenant);
    const seen = new Set(
      existing.map((c) =>
        JSON.stringify([new URL(c.website).hostname, c.identity]),
      ),
    );
    for (let index = 1; index < parsed.data.length; index++) {
      const cells = parsed.data[index],
        row = index + 1,
        base = { row, name: "", identity: "", website: "" };
      if (cells.length !== columns.length) {
        staged.preview.rows.push({
          ...base,
          status: "invalid",
          reason: "Column count differs from header.",
        });
        continue;
      }
      const type = cells[typeIndex]?.toLowerCase();
      if (type && !["login", "password", "1"].includes(type)) {
        staged.preview.rows.push({
          ...base,
          status: "unsupported",
          reason: "Only login records are supported.",
        });
        continue;
      }
      let value: VaultConnectionInput;
      try {
        const url = new URL(cells[indices.url]);
        if (url.protocol !== "https:" || url.username || url.password)
          throw new Error();
        value = connectionCreate.parse({
          name: cells[indices.name]?.trim() || url.hostname,
          identity: cells[indices.username]?.trim(),
          website: url.origin,
          domains: [url.hostname],
          ...(indices.password >= 0 && cells[indices.password]
            ? { credential: { password: cells[indices.password] } }
            : {}),
        });
      } catch {
        staged.preview.rows.push({
          ...base,
          status: "invalid",
          reason: "Check login name, HTTPS website and username.",
        });
        continue;
      }
      const key = JSON.stringify([
          new URL(value.website).hostname,
          value.identity,
        ]),
        duplicate = seen.has(key);
      staged.preview.rows.push({
        row,
        name: value.name,
        identity: value.identity,
        website: value.website,
        status: duplicate ? "duplicate" : "ready",
        reason: duplicate
          ? "Same website and username already present."
          : "Ready; password excluded from preview.",
      });
      if (!duplicate) {
        seen.add(key);
        staged.rows.push({ row, input: value });
      }
    }
    const secret = await this.vault.cipher.seal(
      context(tenant, "import", importId),
      staged,
    );
    await this.vault.db.transaction(async (sql) => {
      await sql.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [tenant]);
      await sql.query(
        "DELETE FROM imports WHERE tenant=$1 AND expires_at<=$2",
        [tenant, this.vault.now()],
      );
      if (
        (await sql.query("SELECT id FROM imports WHERE tenant=$1", [tenant]))
          .rows.length >= 5
      )
        throw new VaultError("CAPACITY", 429);
      await sql.query(
        "INSERT INTO imports(tenant,id,secret,expires_at) VALUES($1,$2,$3,$4)",
        [tenant, importId, JSON.stringify(secret), expiresAt],
      );
      await this.vault.audit(sql, tenant, "owner", "import.preview", importId, {
        rows: staged.preview.rows.length,
      });
    });
    return staged.preview;
  }
  async commit(tenant: string, importId: string, body: unknown) {
    const { rows } = z
        .object({
          rows: z.array(z.number().int().min(2).max(1001)).min(1).max(1000),
        })
        .strict()
        .parse(body),
      selected = [...new Set(rows)].sort((a, b) => a - b),
      selectionHash = digest(JSON.stringify(selected));
    return this.vault.db.transaction(async (sql) => {
      await this.vault.lock(sql, tenant);
      const stored = requireValue(
        (
          await sql.query<{
            secret: Envelope;
            expires_at: string;
            committed: boolean;
          }>("SELECT * FROM imports WHERE tenant=$1 AND id=$2 FOR UPDATE", [
            tenant,
            importId,
          ])
        ).rows[0],
      );
      if (Number(stored.expires_at) <= this.vault.now())
        throw new VaultError("NOT_FOUND", 404);
      const staged = await this.vault.cipher.open<Staged>(
        context(tenant, "import", importId),
        stored.secret,
      );
      if (stored.committed) {
        if (staged.selectionHash !== selectionHash)
          throw new VaultError("CONFLICT", 409);
        return requireValue(staged.result);
      }
      if (selected.some((row) => !staged.rows.some((r) => r.row === row)))
        throw new VaultError("INVALID_INPUT");
      await sql.query("SELECT id FROM vaults WHERE id=$1 FOR UPDATE", [tenant]);
      const result = {
        imported: 0,
        duplicates: 0,
        connectionIds: [] as string[],
      };
      for (const row of staged.rows.filter((r) => selected.includes(r.row))) {
        const duplicate = await sql.query(
          "SELECT id FROM connections WHERE tenant=$1 AND identity=$2 AND domains ? $3 AND NOT deleted",
          [tenant, row.input.identity, new URL(row.input.website).hostname],
        );
        if (duplicate.rows.length) {
          result.duplicates++;
          continue;
        }
        const c = await this.vault.add(tenant, row.input, sql);
        result.imported++;
        result.connectionIds.push(c.id);
      }
      const secret = await this.vault.cipher.seal(
        context(tenant, "import", importId),
        { result, selectionHash },
      );
      await sql.query(
        "UPDATE imports SET committed=true,secret=$3 WHERE tenant=$1 AND id=$2",
        [tenant, importId, JSON.stringify(secret)],
      );
      await this.vault.audit(
        sql,
        tenant,
        "owner",
        "import.committed",
        importId,
        { imported: result.imported, duplicates: result.duplicates },
      );
      return result;
    });
  }
  async cancel(tenant: string, importId: string) {
    await this.vault.db.query("DELETE FROM imports WHERE tenant=$1 AND id=$2", [
      tenant,
      importId,
    ]);
    return { ok: true as const };
  }
}
