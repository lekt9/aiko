import type { BrowserDriver } from "./browser-driver.ts";

/** A task owns a tab, not the account's cookies or browser process. The native
 * daemon's select + dispatch is one queued unit. Approval waits live outside it. */
export function withBrowserTabs<State>(driver: BrowserDriver, lifecycle: {
  initial(): State;
  select(state: State, create: boolean): Promise<void>;
  close(state: State): Promise<void>;
}) : BrowserDriver {
  const root = lifecycle.initial();
  const tabs = new Map<string, { state: State; driver: BrowserDriver; closed: boolean }>();
  let lastPage = root;
  let tail: Promise<unknown> = Promise.resolve();
  let closing: Promise<void> | undefined;
  let invalid = false;
  const serial = <T>(run: () => Promise<T>) => {
    const next = tail.then(run);
    tail = next.catch(() => {});
    return next;
  };
  const pageMethods = new Set(["execute", "executeScoped", "inspectCurrentPage", "authorizeInspection", "readConnectionPage", "screenshot", "requestRehydrate"]);
  const wrap = (state: State, task?: {closed: boolean}): BrowserDriver => {
    const result: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(driver)) {
      if (name === "close" || name === "forTab") continue;
      // Cookie custody and sign-in belong only to the account, never a task handle.
      if (task && ["nativeAuth", "installSession", "clearSession", "watchConfigure", "watchPause", "watchAcknowledgeGap"].includes(name)) continue;
      if (typeof value !== "function") { result[name] = value; continue; }
      result[name] = (...args: unknown[]) => serial(async () => {
        if (closing || task?.closed || invalid) throw Error("Browser tab session closed");
        const signal = args.find(arg => arg instanceof AbortSignal) as AbortSignal | undefined;
        signal?.throwIfAborted();
        if (name === "nativeAuth") {
          if (tabs.size) await lifecycle.select(root, false);
          lastPage = root;
          // Sign-in may close/recreate pages and must not leave stale task refs live.
          for (const tab of tabs.values()) {
            tab.closed = true;
            await lifecycle.close(tab.state);
          }
          tabs.clear();
        }
        if (task && (name === "execute" || name === "executeScoped") && String((args[0] as {action?:string})?.action).startsWith("tab_"))
          throw Error("Task tabs are selected by the host, not browser tools");
        if (pageMethods.has(name) && (task || tabs.size)) {
          // The owner's capture surface follows the last task; workers always
          // capture their own explicit tab, never a global active-page guess.
          const selected = !task && name === "screenshot" ? lastPage : state;
          await lifecycle.select(selected, selected !== root);
          lastPage = selected;
        }
        signal?.throwIfAborted();
        return value.apply(driver, args);
      });
    }
    if (driver.requestTransport) result.requestTransport = {
      send: (request: Parameters<NonNullable<BrowserDriver["requestTransport"]>["send"]>[0]) => serial(async () => {
        if (closing || task?.closed || invalid) throw Error("Browser tab session closed");
        if (task || tabs.size) await lifecycle.select(state, !!task);
        return driver.requestTransport!.send(request);
      }),
    };
    return result as unknown as BrowserDriver;
  };
  const result = wrap(root);
  result.forTab = async key => {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(key)) throw Error("Invalid task tab key");
    if (closing || invalid) throw Error("Browser session closed");
    const existing = tabs.get(key);
    if (existing) return existing.driver;
    if (tabs.size >= 16) throw Error("Account task tab capacity is busy");
    const tab = { state: lifecycle.initial(), driver: undefined as unknown as BrowserDriver, closed: false };
    tab.driver = wrap(tab.state, tab);
    let released: Promise<void> | undefined;
    tab.driver.close = () => released ??= serial(async () => {
      tab.closed = true;
      try { await lifecycle.close(tab.state); }
      catch (error) { invalid = true; throw error; }
      finally {
        if (tabs.get(key) === tab) tabs.delete(key);
        if (lastPage === tab.state) lastPage = [...tabs.values()].find(item => !item.closed)?.state ?? root;
      }
    });
    tabs.set(key, tab);
    return tab.driver;
  };
  result.close = () => closing ??= serial(async () => {
    for (const tab of tabs.values()) tab.closed = true;
    tabs.clear();
    await driver.close();
  });
  return result;
}

/** Runner admission: task lanes may coexist, but account-wide custody cannot. */
export class BrowserTaskGate {
  private lanes = new Set<string>();
  private exclusive = false;
  get busy() { return this.exclusive || this.lanes.size > 0; }
  acquire(tab?: unknown): () => void {
    if (tab !== undefined && (typeof tab !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(tab))) throw Error("Invalid task tab key");
    if (this.exclusive || (tab === undefined ? this.lanes.size > 0 : this.lanes.has(tab as string))) throw Error("Browser operation busy");
    if (tab === undefined) this.exclusive = true;
    else this.lanes.add(tab as string);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (tab === undefined) this.exclusive = false;
      else this.lanes.delete(tab as string);
    };
  }
}
