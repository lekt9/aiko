import {
  nativeLogin,
  type NativeLoginInput,
  type NativeLoginView,
} from "./native-login.ts";
import type { NativeLoginVault } from "./native-login-vault.ts";

/** Trusted VM only. Never return credentials or retry a submitted password.
 * A pending state survives interruption and requires the owner to continue. */
export async function renewNativeLogin(
  input: NativeLoginInput,
  dependencies: Parameters<typeof nativeLogin>[1],
  vault: NativeLoginVault,
  signal?: AbortSignal,
  pause: () => Promise<void> = () =>
    new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        reject(Error("Renewal cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, 500);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    }),
): Promise<NativeLoginView> {
  const run = (action: NativeLoginInput["action"], fields: object = {}) => {
    signal?.throwIfAborted();
    return nativeLogin({ ...input, action, ...fields }, dependencies);
  };
  const state = dependencies.read();
  if (
    !state ||
    state.connectionId !== input.connectionId ||
    state.domain !== input.domain
  )
    throw Error("Private sign-in binding mismatch");
  if (state.status !== "connected") return run("status");
  const renewed = await vault.renew(state, async (credentials) => {
    let view = await run("begin");
    // Full candidates remain transient until this new browser login verifies.
    vault.stage(dependencies.read()!, {
      ...input,
      action: "credentials",
      ...credentials,
    });
    const submitted = new Set<string>();
    for (let step = 0; step < 30; step++) {
      signal?.throwIfAborted();
      if (view.status === "connected") return view;
      if (view.requiresOrigin || view.fields?.includes("code")) return view;
      // Completion can precede a form response after a redirect.
      try {
        view = await run("finish");
        if (view.status === "connected") return view;
      } catch {
        signal?.throwIfAborted();
      }
      view = await run("form");
      if (view.requiresOrigin || view.fields?.includes("code")) return view;
      const fields = Object.fromEntries(
        Object.entries(credentials).filter(
          ([name]) => view.fields?.includes(name) && !submitted.has(name),
        ),
      );
      if (Object.keys(fields).length) {
        // Fence before sending: a lost acknowledgement cannot cause resubmission.
        for (const name of Object.keys(fields)) submitted.add(name);
        view = await run("credentials", fields);
      }
      await pause();
    }
    return view;
  });
  // A session captured through SSO/manual typing can be restored but has no
  // reusable password. Start the owner's private challenge without inventing one.
  return renewed ?? run("begin");
}
