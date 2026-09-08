import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { CONSOLE_HTML } from "../src/console";

// Execute the shipped script with a deferred transport; no browser or server.
function consoleFixture() {
  const elements = new Map<string, any>();
  const element = (id: string): any => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", style: {}, listeners: {},
      addEventListener(name: string, handler: Function) { this.listeners[name] = handler; },
      focus() {}, replaceChildren() {}, after() {}, append() {},
    });
    return elements.get(id);
  };
  const calls: { id: string; text: string }[] = [];
  let complete: (ok: boolean) => void = () => { throw Error("No pending send"); };
  let loseResponse: () => void = () => { throw Error("No pending send"); };
  let deadline: AbortController;
  let timeoutMs: number | undefined;
  runInNewContext(CONSOLE_HTML.match(/<script>([\s\S]*?)<\/script>/)![1], {
    crypto, setTimeout: () => 1, clearTimeout() {},
    AbortSignal: { timeout(ms: number) { timeoutMs = ms; deadline = new AbortController(); return deadline.signal; } },
    document: { getElementById: element, querySelectorAll: () => [], querySelector: () => element("header"), createElement: () => element("created") },
    window: { addEventListener() {} },
    fetch: async (_url: string, options: RequestInit) => {
      calls.push(JSON.parse(options.body as string));
      return new Promise((resolve, reject) => {
        complete = ok => resolve({ ok, json: async () => ok ? { status: "accepted" } : { error: "Synthetic rejection" } });
        loseResponse = () => reject(new TypeError("Synthetic response loss after dispatch"));
        options.signal?.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
      });
    },
  });
  return { element, calls, complete: (ok: boolean) => complete(ok),
    send: () => element("composer").listeners.submit({ preventDefault() {} }),
    retry: () => element("retry-message").listeners.click(),
    lock: () => element("logout").listeners.click(),
    loseResponse: () => loseResponse(),
    expire: () => deadline.abort(new DOMException("Request timed out", "TimeoutError")),
    timeoutMs: () => timeoutMs,
  };
}

test("console keeps a newer draft when an earlier message is accepted", async () => {
  const f = consoleFixture(); f.element("message").value = "First message";
  const sending = f.send(); f.element("message").value = "Unsent second draft";
  f.complete(true); await sending;
  expect(f.calls[0].text).toBe("First message");
  expect(f.element("message").value).toBe("Unsent second draft");
  expect(f.element("send").disabled).toBe(false);
});

test("uncertain sends retry the original ID and payload, then send the new draft with a fresh ID", async () => {
  const f = consoleFixture(); f.element("message").value = "Original";
  const first = f.send(); f.element("message").value = "Next draft";
  f.loseResponse(); await first;
  expect(f.element("retry-message").hidden).toBe(false);
  expect(f.element("send").disabled).toBe(true);
  await f.send(); expect(f.calls).toHaveLength(1);
  const retry = f.retry(); const duplicate = f.retry(); await duplicate;
  expect(f.calls).toHaveLength(2); expect(f.calls[1]).toEqual(f.calls[0]);
  f.complete(true); await retry;
  expect(f.element("message").value).toBe("Next draft");
  expect(f.element("retry-message").hidden).toBe(true);
  const next = f.send();
  expect(f.calls[2].id).not.toBe(f.calls[0].id);
  expect(f.calls[2].text).toBe("Next draft");
  f.complete(true); await next; expect(f.element("message").value).toBe("");
});

test("a stalled send releases retry controls at its deadline without replaying", async () => {
  const f = consoleFixture(); f.element("message").value = "Stalled message";
  const sending = f.send(); f.element("message").value = "Keep this draft";
  expect(f.timeoutMs()).toBe(20_000);
  f.expire(); await sending;
  expect(f.calls).toHaveLength(1);
  expect(f.element("message").value).toBe("Keep this draft");
  expect(f.element("send").disabled).toBe(true);
  expect(f.element("retry-message").disabled).toBe(false);
  expect(f.element("retry-message").hidden).toBe(false);
  const retry = f.retry();
  expect(f.calls[1]).toEqual(f.calls[0]);
  f.complete(true); await retry;
  expect(f.element("send").disabled).toBe(false);
});

test("locking forgets a pending message and ignores its late completion", async () => {
  const f = consoleFixture(); f.element("message").value = "Pending";
  const sending = f.send(); f.lock();
  f.element("message").value = "Draft in a later session";
  f.complete(false); await sending;
  expect(f.element("message").value).toBe("Draft in a later session");
  expect(f.element("retry-message").hidden).toBe(true);
  expect(f.element("send").disabled).toBe(false);
  expect(f.element("feedback").textContent).toBe("Console locked.");
});
