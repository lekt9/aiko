import { getAgentMailUrl } from "./native";

type EventListener = (method: string, params: unknown) => void;

/** Server → client reverse request (has id + method). */
export type ServerRequestHandler = (
  id: number | string,
  method: string,
  params: unknown,
) => void | Promise<void>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string; code?: number };
}

export interface PromptResult {
  response: unknown;
  text: string;
}

export class AcpClient {
  private socket?: WebSocket;
  private requestId = 0;
  private pending = new Map<number | string, PendingRequest>();
  private promptTail: Promise<unknown> = Promise.resolve();
  private activePrompt?: { sessionId: string; chunks: string[] };
  private serverRequestHandler?: ServerRequestHandler;

  constructor(private listener: EventListener) {}

  /** Handle reverse-requests from the agent (ask_user_question, permissions, …). */
  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    const url = await getAgentMailUrl();
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url, "aiko.acp.v1");
      socket.addEventListener("open", () => {
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("message", (event) => this.onMessage(event.data));
      socket.addEventListener("close", () => {
        this.socket = undefined;
        this.rejectPending(new Error("Aiko’s session connection closed."));
      });
      socket.addEventListener("error", () => {
        reject(new Error("Could not connect to Aiko’s session runtime."));
      });
    });
    try {
      await this.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        _meta: {
          clientType: "aiko-desktop",
          clientVersion: "0.1.0",
          // Advertise that we can handle interactive questions
          askUserQuestion: true,
        },
      });
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async newSession(cwd: string): Promise<string> {
    const result = (await this.request("session/new", {
      cwd,
      mcpServers: [],
    })) as { sessionId?: string };
    if (!result?.sessionId) {
      throw new Error("Aiko did not return a session identifier.");
    }
    return result.sessionId;
  }

  prompt(sessionId: string, text: string): Promise<PromptResult> {
    const run = async () => {
      const capture = { sessionId, chunks: [] as string[] };
      this.activePrompt = capture;
      try {
        const response = await this.request("session/prompt", {
          sessionId,
          prompt: [{ type: "text", text }],
        });
        return { response, text: capture.chunks.join("") };
      } finally {
        if (this.activePrompt === capture) this.activePrompt = undefined;
      }
    };
    const result = this.promptTail.then(run, run);
    this.promptTail = result.catch(() => undefined);
    return result;
  }

  cancel(sessionId: string): Promise<unknown> {
    return this.request("session/cancel", { sessionId });
  }

  /** Reply to a server reverse-request (e.g. ask_user_question). */
  respond(id: number | string, result: unknown): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }

  respondError(id: number | string, message: string, code = -32000): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code, message },
      }),
    );
  }

  close(): void {
    this.socket?.close(1000, "desktop session reset");
    this.socket = undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Aiko’s session runtime is not connected."));
    }
    const id = ++this.requestId;
    this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  private onMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: RpcMessage;
    try {
      message = JSON.parse(raw) as RpcMessage;
    } catch {
      return;
    }
    this.captureAgentChunk(message);

    const hasId = message.id !== undefined && message.id !== null;
    const hasMethod = typeof message.method === "string";

    // Server → client reverse-request (must answer with same id).
    if (hasId && hasMethod) {
      void this.handleServerRequest(message.id!, message.method!, message.params);
      return;
    }

    // Client request response
    if (hasId) {
      const pending = this.pending.get(message.id!);
      if (!pending) return;
      this.pending.delete(message.id!);
      if (message.error) {
        pending.reject(
          new Error(message.error.message ?? `ACP error ${message.error.code ?? ""}`),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Notification
    if (hasMethod) this.listener(message.method!, message.params);
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: unknown,
  ): Promise<void> {
    // Normalize wrapped forms: `_x.ai/ask_user_question` with nested params
    let effectiveMethod = method;
    let effectiveParams = params;
    if (
      (method === "_x.ai/ask_user_question" || method === "ext_method") &&
      params &&
      typeof params === "object"
    ) {
      const rec = params as Record<string, unknown>;
      if (typeof rec.method === "string") {
        effectiveMethod = rec.method;
        effectiveParams = rec.params ?? rec;
      }
    }

    if (this.serverRequestHandler) {
      try {
        await this.serverRequestHandler(id, effectiveMethod, effectiveParams);
      } catch (error) {
        this.respondError(
          id,
          error instanceof Error ? error.message : "Request handler failed",
        );
      }
      return;
    }

    // Default: cancel interactive questions if no UI handler wired
    if (
      effectiveMethod === "x.ai/ask_user_question" ||
      effectiveMethod.endsWith("ask_user_question")
    ) {
      this.respond(id, { outcome: "cancelled" });
      return;
    }

    // Permissions: auto-allow for desktop default (tools already gated by agent)
    if (
      effectiveMethod === "session/request_permission" ||
      effectiveMethod.endsWith("request_permission")
    ) {
      this.respond(id, {
        outcome: {
          outcome: "selected",
          optionId: "allow-once",
        },
      });
      return;
    }

    this.respondError(id, `Unhandled reverse-request: ${effectiveMethod}`, -32601);
  }

  private captureAgentChunk(message: RpcMessage): void {
    if (message.method !== "session/update" || !this.activePrompt) return;
    if (!message.params || typeof message.params !== "object") return;
    const params = message.params as Record<string, unknown>;
    if (params.sessionId !== this.activePrompt.sessionId) return;
    if (!params.update || typeof params.update !== "object") return;
    const update = params.update as Record<string, unknown>;
    if (update.sessionUpdate !== "agent_message_chunk") return;
    if (!update.content || typeof update.content !== "object") return;
    const text = (update.content as Record<string, unknown>).text;
    if (typeof text === "string") this.activePrompt.chunks.push(text);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
