import { ZohoVault } from "../src/zoho-vault.ts";
import {
  parseManagerProviders,
  type ManagerGrant,
} from "../src/password-manager-mcp.ts";
import vector from "./fixtures/zoho-vault-vectors.json";
const provider = parseManagerProviders(
  JSON.stringify([
    {
      id: "zoho",
      name: "Zoho",
      kind: "zoho-vault",
      region: "us",
      clientId: "fixture",
      clientSecret: "fixture",
      redirectUrl: "https://unlock.example/password-manager-callback.html",
    },
  ]),
)[0]!;
export default {
  async fetch() {
    const results: Record<string, boolean | string> = {};
    for (const version of ["personal", "1024", "4096"] as const) {
      const shared =
        version === "personal" ? undefined : vector.sharing[version];
      const grant: ManagerGrant = {
        tokens: { access_token: "fixture", token_type: "Bearer" },
        zoho: { tokenExpiresAt: Date.now() + 60000 },
      };
      const network = async (input: unknown) => {
        const path = new URL(String(input)).pathname;
        const details = path.endsWith("/login")
          ? {
              LOGIN: "PBKDF2_AES",
              SALT: vector.salt,
              ITERATION: vector.iterations,
              PASSPHRASE: vector.encrypted.challenge,
            }
          : path.endsWith("/orgkey")
            ? shared
              ? {
                  rsaKeyType: `RSA_${version}`,
                  privateKey: shared.privateKey,
                  sharedKey: shared.sharedKey,
                }
              : {}
            : [
                {
                  secretid: "12345",
                  secretname: "Fixture",
                  secreturl: "https://github.com",
                  isshared: shared ? "YES" : "NO",
                  secretData: JSON.stringify({
                    username: shared
                      ? shared.username
                      : vector.encrypted.username,
                    password: shared
                      ? shared.password
                      : vector.encrypted.password,
                  }),
                },
              ];
        return Response.json({
          operation: { result: { status: "Success" }, Details: details },
        });
      };
      try {
        const vault = new ZohoVault(provider, grant, network);
        await vault.unlock(vector.key);
        const credentials = await vault.resolve(
          "zohovault://12345/password",
          "github.com",
        );
        results[version] =
          credentials.password ===
            vector.values.password.replace(/\r\n/g, "\n") &&
          credentials.username === vector.values.username;
      } catch (e) {
        results[version] = e instanceof Error ? e.message : "failed";
      }
    }
    return Response.json(results, { status: Object.values(results).every(value => value === true) ? 200 : 500 });
  },
};
