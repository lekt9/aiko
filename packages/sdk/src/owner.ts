/** SECRET-BEARING. Trusted owner UI/runtime only; never register these methods as LLM tools. */
import {
  browserLoginCommit,
  browserLoginReceipt,
  connectionMetadata,
  credential,
  importPreview,
  importResult,
  okResult,
  revisionResult,
  type VaultConnectionInput,
  type VaultCookie,
  type BrowserLoginCommit,
} from "@unlock/protocol";
import {
  idResult,
  pathId,
  vaultTransport,
  type VaultOptions,
} from "./vault-transport.js";
import type { RequestOptions } from "./types.js";
import type { PrivateBrowserAdapter, VaultBinding } from "./agent.js";
import { UnlockError } from "./transport.js";
export type {
  VaultConnectionInput,
  VaultImportPreview,
} from "@unlock/protocol";
export interface SourceAuthorization {
  name: string;
  kind: "onepassword";
  token: string;
  references: string[];
}
export interface SsoContextInput {
  identity: string;
  runtimeId: string;
  domains: string[];
  cookies: VaultCookie[];
}
export function createVaultOwner(options: VaultOptions) {
  const request = vaultTransport(options);
  return {
    add: (input: VaultConnectionInput, opts?: RequestOptions) =>
      request(connectionMetadata, "owner/connections", "POST", input, opts),
    revealPassword: (id: string, opts?: RequestOptions) =>
      request(
        credential,
        `owner/connections/${pathId(id)}/credential`,
        "POST",
        {},
        opts,
      ),
    setPassword: (
      id: string,
      input: { password: string; version: number },
      opts?: RequestOptions,
    ) =>
      request(
        okResult,
        `owner/connections/${pathId(id)}/credential`,
        "PUT",
        input,
        opts,
      ),
    importSession: (
      id: string,
      input: { profileId: string; runtimeId: string; cookies: VaultCookie[] },
      opts?: RequestOptions,
    ) =>
      request(
        revisionResult,
        `owner/connections/${pathId(id)}/session`,
        "POST",
        input,
        opts,
      ),
    /** Verify the browser session before atomically replacing its password and session. */
    completeBrowserLogin: (
      id: string,
      input: BrowserLoginCommit,
      opts?: RequestOptions,
    ) =>
      request(
        browserLoginReceipt,
        `owner/connections/${pathId(id)}/browser-login`,
        "POST",
        browserLoginCommit.parse(input),
        opts,
      ),
    addSource: (input: SourceAuthorization, opts?: RequestOptions) =>
      request(idResult, "owner/sources", "POST", input, opts),
    reconnectSource: (
      id: string,
      input: SourceAuthorization,
      opts?: RequestOptions,
    ) => request(okResult, `owner/sources/${pathId(id)}`, "PUT", input, opts),
    importCsv: {
      preview: (
        input: {
          csv: string;
          columns?: {
            name: string;
            url: string;
            username: string;
            password: string;
          };
        },
        opts?: RequestOptions,
      ) => request(importPreview, "owner/imports/preview", "POST", input, opts),
      commit: (id: string, rows: number[], opts?: RequestOptions) =>
        request(
          importResult,
          `owner/imports/${pathId(id)}/commit`,
          "POST",
          { rows },
          opts,
        ),
      cancel: (id: string, opts?: RequestOptions) =>
        request(okResult, `owner/imports/${pathId(id)}`, "DELETE", {}, opts),
    },
    addSsoContext: (input: SsoContextInput, opts?: RequestOptions) =>
      request(idResult, "owner/sso", "POST", input, opts),
    reconnectSsoContext: (
      id: string,
      input: SsoContextInput & { version: number },
      opts?: RequestOptions,
    ) => request(idResult, `owner/sso/${pathId(id)}`, "PUT", input, opts),
  };
}
export type VaultOwner = ReturnType<typeof createVaultOwner>;

/**
 * Private owner-login handoff, not an actor tool. Bind this to the same exclusively
 * owned CDP context used for login. The server independently verifies identity and
 * cookies; the browser must have actually submitted these credentials before calling.
 * No automatic retry: an uncertain response requires checking native vault status.
 */
export function createBrowserLoginCommit(
  owner: Pick<VaultOwner, "completeBrowserLogin">,
  browser: PrivateBrowserAdapter,
  inputBinding: VaultBinding & { identity: string; version: number },
) {
  const binding = structuredClone(inputBinding);
  pathId(binding.connectionId);
  const fault = () =>
    new UnlockError(
      "BINDING_MISMATCH",
      0,
      "The private browser login needs recovery.",
    );
  // Validate host configuration before accepting credentials or exporting a cookie jar.
  browserLoginCommit
    .omit({ credential: true, cookies: true })
    .parse(bindingInput());
  function bindingInput() {
    return {
      profileId: binding.profileId,
      runtimeId: binding.runtimeId,
      identity: binding.identity,
      version: binding.version,
    };
  }
  let pending = false;
  let finished = false;
  return async (
    credentials: { username: string; password: string },
    opts?: RequestOptions,
  ) => {
    if (pending || finished || credentials.username !== binding.identity)
      throw fault();
    pending = true;
    try {
      const cookies = await browser.exportCookies([...binding.domains]);
      if (
        !cookies.length ||
        cookies.some(
          (c) =>
            !c.secure ||
            c.hostOnly !== !c.domain.startsWith(".") ||
            !binding.domains.includes(c.domain.replace(/^\./, "")),
        )
      )
        throw fault();
      const input = browserLoginCommit.parse({
        ...bindingInput(),
        credential: { password: credentials.password },
        cookies,
      });
      // After dispatch, never send a password again from this handoff, even if its reply is lost.
      finished = true;
      const receipt = await owner.completeBrowserLogin(
        binding.connectionId,
        input,
        opts,
      );
      const checked = browserLoginReceipt.parse(receipt);
      if (
        checked.version !== binding.version + 1 ||
        checked.expiresAt <= Date.now() ||
        checked.expiresAt > Date.now() + 30 * 86400_000
      )
        throw fault();
      return checked;
    } catch (error) {
      if (error instanceof UnlockError) throw error;
      throw new UnlockError(
        "UNAVAILABLE",
        0,
        "The private browser login needs recovery.",
      );
    } finally {
      pending = false;
    }
  };
}
