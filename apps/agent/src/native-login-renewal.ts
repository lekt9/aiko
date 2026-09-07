import {
  nativeLogin,
  validateNativeInput,
  type NativeLoginInput,
  type NativeLoginView,
} from "./native-login.ts";
import type { NativeLoginVault } from "./native-login-vault.ts";

type Dependencies = Parameters<typeof nativeLogin>[1];
const pauseFor = (signal?: AbortSignal) => () =>
  new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(Error("Login cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, 500);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
async function driveLogin(
  input: NativeLoginInput,
  dependencies: Dependencies,
  vault: NativeLoginVault,
  credentials: { username: string; password: string },
  start: boolean,
  signal?: AbortSignal,
  pause = pauseFor(signal),
  previouslyVerified = false,
): Promise<NativeLoginView> {
  const run = (action: NativeLoginInput["action"], fields: object = {}) => {
    signal?.throwIfAborted();
    return nativeLogin(
      {
        connectionId: input.connectionId,
        domain: input.domain,
        action,
        ...(input.credentialReference ? { credentialReference: input.credentialReference } : {}),
        ...fields,
      },
      {...dependencies, reopenMissingTarget: false},
    );
  };
  let view = await run(start ? "begin" : "form");
  if (view.status !== "pending") return view;
  // Full candidates remain transient until this new browser login verifies.
  const stage = () =>
    vault.stage(dependencies.read()!, {
      ...input,
      action: "credentials",
      ...credentials,
    });
  if (previouslyVerified) stage();
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
      // Initial passwords become candidates only when the password step is
      // actually submitted. A pre-existing SSO session cannot verify new input.
      if (Object.hasOwn(fields, "password")) stage();
      try {
        view = await run("credentials", fields);
      } catch (error) {
        vault.discard(input.connectionId);
        throw error;
      }
    }
    await pause();
  }
  return view;
}
/** One owner submission can span username-first and password-first pages.
 * Only the trusted VM holds candidates; each field is submitted at most once. */
export async function submitNativeLogin(
  input: NativeLoginInput,
  dependencies: Dependencies,
  vault: NativeLoginVault,
  signal?: AbortSignal,
  pause = pauseFor(signal),
) {
  validateNativeInput({ ...input, action: "credentials" });
  if (!input.username || !input.password)
    throw Error("Username and password required");
  const state = dependencies.read();
  if (
    state &&
    (state.connectionId !== input.connectionId || state.domain !== input.domain)
  )
    throw Error("Private sign-in binding mismatch");
  if (state?.status === "connected" || state?.verifiedSession)
    return nativeLogin({ ...input, action: "finish" }, dependencies);
  return driveLogin(
    input,
    dependencies,
    vault,
    { username: input.username, password: input.password },
    !state,
    signal,
    pause,
  );
}
/** A pending state survives interruption and requires the owner to continue. */
export async function renewNativeLogin(
  input: NativeLoginInput,
  dependencies: Dependencies,
  vault: NativeLoginVault,
  signal?: AbortSignal,
  pause = pauseFor(signal),
): Promise<NativeLoginView> {
  const state = dependencies.read();
  if (
    !state ||
    state.connectionId !== input.connectionId ||
    state.domain !== input.domain
  )
    throw Error("Private sign-in binding mismatch");
  if (state.status !== "connected")
    return nativeLogin({ ...input, action: "status" }, dependencies);
  const renewed = await vault.renew(state, (credentials) =>
    driveLogin(
      input,
      dependencies,
      vault,
      credentials,
      true,
      signal,
      pause,
      true,
    ),
  );
  return renewed ?? nativeLogin({ ...input, action: "begin" }, dependencies);
}
