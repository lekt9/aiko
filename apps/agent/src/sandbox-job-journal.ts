import { Database } from "bun:sqlite";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { SandboxJobJournal } from "./sandbox-job-runner.ts";
import type { SandboxJobReceipt } from "./sandbox-job.ts";
/** Receipt cache/fence only. Native Tardigrade effects remain the execution coordinator. */
export async function sandboxJobJournal(db: Database, keyPath: string): Promise<SandboxJobJournal> {
  try { await writeFile(keyPath,randomBytes(32),{flag:"wx",mode:0o600}); }
  catch(error:any) { if(error.code !== "EEXIST") throw error; }
  const key = await readFile(keyPath);
  if(key.length !== 32) throw Error("Sandbox receipt key unavailable");
  db.exec("CREATE TABLE IF NOT EXISTS sandbox_jobs(owner TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,receipt TEXT,PRIMARY KEY(owner,id))");
  const aad = (owner:string,id:string) => Buffer.from(JSON.stringify([owner,id]));
  return {
    async claim(owner,id,digest) { return db.query("INSERT OR IGNORE INTO sandbox_jobs(owner,id,digest) VALUES(?,?,?)").run(owner,id,digest).changes === 1; },
    async read(owner,id) {
      const row = db.query("SELECT digest,receipt FROM sandbox_jobs WHERE owner=? AND id=?").get(owner,id) as {digest:string;receipt:string|null}|null;
      if(!row) return undefined;
      if(!row.receipt) return {digest:row.digest};
      const bytes = Buffer.from(row.receipt,"base64"), decipher = createDecipheriv("aes-256-gcm",key,bytes.subarray(0,12));
      decipher.setAAD(aad(owner,id)); decipher.setAuthTag(bytes.subarray(12,28));
      return {digest:row.digest,receipt:JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString())};
    },
    async settle(owner,id,receipt:SandboxJobReceipt) {
      const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,iv); cipher.setAAD(aad(owner,id));
      const bytes=Buffer.concat([cipher.update(JSON.stringify(receipt)),cipher.final()]);
      const result=db.query("UPDATE sandbox_jobs SET receipt=? WHERE owner=? AND id=? AND digest=? AND receipt IS NULL").run(Buffer.concat([iv,cipher.getAuthTag(),bytes]).toString("base64"),owner,id,receipt.jobDigest);
      if(result.changes !== 1) throw Error("Sandbox receipt settlement conflict");
    },
  };
}
