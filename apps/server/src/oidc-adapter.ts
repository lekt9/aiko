import {
  errors,
  type AdapterConstructor,
  type AdapterPayload,
} from "oidc-provider";
import { digest, type Envelope } from "./crypto.js";
import { Vault } from "./vault.js";
export function oidcAdapter(vault: Vault): AdapterConstructor {
  return class {
    constructor(private model: string) {}
    private aad(hash: string) {
      return `unlock:v1:oidc:${this.model}:${hash}`;
    }
    async upsert(id: string, payload: AdapterPayload, expiresIn = 86400 * 30) {
      const hash = digest(id),
        secret = await vault.cipher.seal(this.aad(hash), payload);
      await vault.db.query(
        "INSERT INTO oidc_objects(model,id,secret,expires_at,grant_id,user_code,uid) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(model,id) DO UPDATE SET secret=EXCLUDED.secret,expires_at=EXCLUDED.expires_at,grant_id=EXCLUDED.grant_id,user_code=EXCLUDED.user_code,uid=EXCLUDED.uid",
        [
          this.model,
          hash,
          JSON.stringify(secret),
          vault.now() + expiresIn * 1000,
          payload.grantId ? digest(payload.grantId) : null,
          payload.userCode ? digest(payload.userCode) : null,
          payload.uid ? digest(payload.uid) : null,
        ],
      );
    }
    async find(id: string): Promise<AdapterPayload | undefined> {
      if (this.model === "Client") {
        const c = (
          await vault.db.query<{
            id: string;
            redirects: string[];
            name: string;
          }>("SELECT id,redirects,name FROM clients WHERE id=$1 AND enabled", [
            id,
          ])
        ).rows[0];
        if (!c) return undefined;
        return {
          client_id: c.id,
          client_name: c.name,
          redirect_uris: c.redirects,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          application_type: c.redirects.every((u) => u.startsWith("https:"))
            ? "web"
            : "native",
          require_auth_time: false,
        };
      }
      return this.lookup("id", digest(id));
    }
    private async lookup(column: "id" | "user_code" | "uid", value: string) {
      const row = (
        await vault.db.query<{
          id: string;
          secret: Envelope;
          consumed: string | null;
        }>(
          `SELECT id,secret,consumed FROM oidc_objects WHERE model=$1 AND ${column}=$2 AND expires_at>$3`,
          [this.model, value, vault.now()],
        )
      ).rows[0];
      if (!row) return undefined;
      const payload = await vault.cipher.open<AdapterPayload>(
        this.aad(row.id),
        row.secret,
      );
      return {
        ...payload,
        ...(row.consumed ? { consumed: Number(row.consumed) } : {}),
      };
    }
    async findByUserCode(value: string) {
      return this.lookup("user_code", digest(value));
    }
    async findByUid(value: string) {
      return this.lookup("uid", digest(value));
    }
    async consume(id: string) {
      const consumed = await vault.db.query(
        "UPDATE oidc_objects SET consumed=$3 WHERE model=$1 AND id=$2 AND consumed IS NULL RETURNING id",
        [this.model, digest(id), Math.floor(vault.now() / 1000)],
      );
      if (!consumed.rows.length) throw new errors.InvalidGrant();
    }
    async destroy(id: string) {
      await vault.db.query(
        "DELETE FROM oidc_objects WHERE model=$1 AND id=$2",
        [this.model, digest(id)],
      );
    }
    async revokeByGrantId(grantId: string) {
      await vault.db.query(
        "DELETE FROM oidc_objects WHERE grant_id=$1 OR (model='Grant' AND id=$1)",
        [digest(grantId)],
      );
    }
  };
}
