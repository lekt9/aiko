import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { once } from "node:events";
import { AikoPlaneError, createAikoClient } from "../packages/sdk/src/aiko.js";

afterEach(() => vi.useRealTimers());
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

describe("Aiko request cancellation", () => {
  it.each(["timeout", "caller"])("bounds pending token resolution on %s and never dispatches a late write", async kind => {
    vi.useFakeTimers();
    const token = deferred<string>();
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    const client = createAikoClient({ baseUrl: "https://aiko.example", token: () => token.promise, fetch: fetcher, timeoutMs: 50 });
    const result = client.messages.send({ id: "one", text: "Do this once" }, { signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ name: kind === "timeout" ? "TimeoutError" : "AbortError" });
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(50);
    else controller.abort();
    await check;
    token.resolve("synthetic-token");
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve credentials or dispatch for an already cancelled request", async () => {
    const token = vi.fn(() => "synthetic-token");
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    const client = createAikoClient({ baseUrl: "https://aiko.example", token, fetch: fetcher });
    await expect(client.status({ signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("settles when a custom fetch ignores abort and cancels its late response", async () => {
    vi.useFakeTimers();
    const response = deferred<Response>();
    const cancelled = vi.fn();
    const client = createAikoClient({ baseUrl: "https://aiko.example", token: "synthetic-token", timeoutMs: 50, fetch: vi.fn(() => response.promise) });
    const result = client.status();
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50);
    await check;
    response.resolve(new Response(new ReadableStream({ cancel: cancelled })));
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "caller"])("cancels and releases a stalled response stream on %s", async kind => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('{"messages":')); },
      cancel: cancelled,
    });
    const controller = new AbortController();
    const client = createAikoClient({ baseUrl: "https://aiko.example", token: "synthetic-token", timeoutMs: 50, fetch: vi.fn(async () => new Response(body)) });
    const result = client.messages.list({ signal: controller.signal });
    const check = expect(result).rejects.toMatchObject({ name: kind === "timeout" ? "TimeoutError" : "AbortError" });
    await vi.advanceTimersByTimeAsync(1);
    expect(body.locked).toBe(true);
    if (kind === "timeout") await vi.advanceTimersByTimeAsync(50);
    else controller.abort();
    await check;
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["headers", "body"])("bounds a real loopback fetch stalled at %s", async stage => {
    let entered!: () => void;
    const received = new Promise<void>(resolve => { entered = resolve; });
    const server = createServer((_req, res) => {
      if (stage === "body") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"messages":');
      }
      entered();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      const client = createAikoClient({ baseUrl: `http://127.0.0.1:${port}`, token: "synthetic-token", timeoutMs: 200 });
      const result = client.status();
      const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
      // Prove this reached the requested transport phase, not just credential timeout.
      await Promise.race([received, result]);
      await check;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("uses one deadline across token lookup and body consumption", async () => {
    vi.useFakeTimers();
    const token = deferred<string>();
    const cancelled = vi.fn();
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled })));
    const client = createAikoClient({ baseUrl: "https://aiko.example", token: () => token.promise, fetch: fetcher, timeoutMs: 50 });
    const result = client.status();
    const check = expect(result).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(40);
    token.resolve("synthetic-token");
    await vi.advanceTimersByTimeAsync(9);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await check;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["token", "fetch", "body", "json"])("cleans up its deadline and caller listener after a %s failure", async stage => {
    vi.useFakeTimers();
    const failure = new Error("synthetic failure");
    const body = new ReadableStream<Uint8Array>({ start(c) { c.error(failure); } });
    const fetcher = vi.fn(async () => {
      if (stage === "fetch") throw failure;
      return stage === "body" ? new Response(body) : new Response("{");
    });
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const client = createAikoClient({
      baseUrl: "https://aiko.example", timeoutMs: 50, fetch: fetcher,
      token: async () => { if (stage === "token") throw failure; return "synthetic-token"; },
    });
    const result = client.status({ signal: controller.signal });
    if (stage === "json") await expect(result).rejects.toBeInstanceOf(SyntaxError);
    else await expect(result).rejects.toBe(failure);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetcher).toHaveBeenCalledTimes(stage === "token" ? 0 : 1);
  });

  it("preserves successful Unicode replies, error contracts and one dispatch", async () => {
    vi.useFakeTimers();
    const bytes = new TextEncoder().encode('{"status":"accepted","id":"你好"}');
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(new ReadableStream({ start(c) {
        for (const byte of bytes) c.enqueue(new Uint8Array([byte]));
        c.close();
      } })))
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }));
    const controller = new AbortController();
    const client = createAikoClient({ baseUrl: "https://aiko.example", token: "synthetic-token", fetch: fetcher, timeoutMs: 50 });
    expect(await client.messages.send({ id: "你好", text: "hello" }, { signal: controller.signal })).toEqual({ status: "accepted", id: "你好" });
    const signal = fetcher.mock.calls[0][1]!.signal!;
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(false);
    await expect(client.status()).rejects.toEqual(new AikoPlaneError(403, "forbidden"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
