import { expect, test } from "bun:test";
import {
  AgentBrowserClient,
  type AgentBrowserClientOptions,
  type AgentBrowserWebSocket,
  type AgentBrowserWebSocketEvent,
} from "../src/agent-browser-client";
import type { BrowserTraceEvent } from "../src/browser-trace";

class Socket implements AgentBrowserWebSocket {
  listeners = new Map<
    string,
    Array<(event: AgentBrowserWebSocketEvent) => void>
  >();
  closed = false;
  addEventListener(
    type: string,
    listener: (event: AgentBrowserWebSocketEvent) => void,
  ) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, data?: unknown) {
    for (const f of this.listeners.get(type) ?? []) f({ data });
  }
  record(value: object) {
    this.emit("message", JSON.stringify(value));
  }
  close() {
    this.closed = true;
    this.emit("close");
  }
}
const stream = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
async function fixture(exchange: (socket: Socket, n: number) => void) {
  const socket = new Socket(),
    events: BrowserTraceEvent[] = [];
  let calls = 0,
    sequence = 0,
    id = 0;
  const options: AgentBrowserClientOptions = {
    rollingTrace: true,
    telemetryLimitBytes: 1024,
    isolation: {
      configPath: "/tmp/rolling/config",
      actionPolicyPath: "/tmp/rolling/policy",
      socketDirectory: "/tmp/rolling/sockets",
      temporaryDirectory: "/tmp/rolling/temp",
      session: "rolling",
      namespace: "rolling",
      allowedDomains: ["example.com"],
    },
    trace: {
      threadId: "rolling",
      nextSequence: () => sequence++,
      nextCallId: () => `call-${++id}`,
      publish: (e) => events.push(e),
    },
    spawn: () => {
      const n = ++calls;
      queueMicrotask(() => exchange(socket, n));
      return {
        stdout: stream(
          JSON.stringify({
            success: true,
            data: { title: "TRANSIENT_PRIVATE_PAGE" },
          }),
        ),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    },
    webSocketFactory: () => {
      queueMicrotask(() => {
        socket.emit("open");
        socket.record({ type: "status" });
      });
      return socket;
    },
  };
  const client = new AgentBrowserClient(options);
  await client.connectTelemetry(43210);
  return { client, socket, events, calls: () => calls };
}
function command(socket: Socket, id: string) {
  socket.record({ type: "command", id, action: "title", params: {} });
}
function result(socket: Socket, id: string) {
  socket.record({
    type: "result",
    id,
    action: "title",
    success: false,
    data: { title: "UNTRUSTED_LATE_PAGE" },
    duration_ms: 1,
  });
}

test("rolling trace exceeds former lifetime call/event/byte caps while retaining bounded correlation", async () => {
  const f = await fixture((s, n) => {
    command(s, String(n));
    result(s, String(n));
  });
  try {
    for (let n = 0; n < 2300; n++)
      await f.client.executeAgentAction({ action: "title" });
    expect(f.calls()).toBe(2300);
    expect(f.events).toHaveLength(4600);
    expect(f.events.every((e, i) => e.sequence === i)).toBe(true);
    expect(f.client.callWindows).toHaveLength(1);
    expect(f.client.telemetryComplete).toBe(true);
    expect(JSON.stringify(f.events)).not.toContain("PRIVATE_PAGE");
    expect(JSON.stringify(f.events)).not.toContain("LATE_PAGE");
  } finally {
    f.client.disconnectTelemetry();
  }
}, 30_000);

test("rolling trace retains late-result correlation without duplicating or changing settled outcomes", async () => {
  const f = await fixture((s, n) => {
    if (n === 2) result(s, "1");
    command(s, String(n));
    if (n !== 1) result(s, String(n));
  });
  try {
    for (let n = 0; n < 3; n++)
      await f.client.executeAgentAction({ action: "title" });
    expect(f.events).toHaveLength(6);
    expect(
      f.events
        .filter((e) => e.type === "BrowserToolResultObserved")
        .every((e) => e.success === true),
    ).toBe(true);
    expect(f.client.callWindows).toHaveLength(1);
    expect(f.client.telemetryComplete).toBe(true);
  } finally {
    f.client.disconnectTelemetry();
  }
});

test("rolling trace never clears a protocol failure to keep running", async () => {
  const f = await fixture((s, n) => {
    command(s, String(n));
    result(s, String(n));
  });
  try {
    await f.client.executeAgentAction({ action: "title" });
    f.socket.emit("message", "x".repeat(1025));
    expect(f.socket.closed).toBe(true);
    await expect(
      f.client.executeAgentAction({ action: "title" }),
    ).rejects.toMatchObject({ code: "telemetry_incomplete" });
    expect(f.calls()).toBe(1);
  } finally {
    f.client.disconnectTelemetry();
  }
});
