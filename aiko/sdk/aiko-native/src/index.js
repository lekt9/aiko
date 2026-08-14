export const AIKO_NATIVE_SCHEMA = "aiko.native.v1";

export class AikoNativeError extends Error {
  constructor(status, message, code, body) {
    super(message);
    this.name = "AikoNativeError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class AikoNativeClient {
  constructor(discovery, fetchImplementation = globalThis.fetch) {
    if (discovery.schema !== AIKO_NATIVE_SCHEMA || discovery.apiVersion !== 1) {
      throw new Error(`Unsupported Aiko native API: ${discovery.schema}`);
    }
    this.discovery = discovery;
    this.fetch = fetchImplementation;
  }

  health() {
    return this.request("/v1/health");
  }

  auth() {
    return this.request("/v1/auth");
  }

  manifest() {
    return this.request("/v1/manifest");
  }

  openApi() {
    return this.request("/v1/openapi.json");
  }

  async contracts() {
    return (await this.request("/v1/contracts")).items;
  }

  async scheduledContracts() {
    return (await this.request("/v1/contracts/scheduled")).items;
  }

  contract(id) {
    return this.request(`/v1/contracts/${encodeURIComponent(id)}`);
  }

  async retryContract(id) {
    await this.request(`/v1/contracts/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
  }

  async cancelContract(id) {
    await this.request(`/v1/contracts/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    });
  }

  async emitSignal(signal) {
    await this.request("/v1/signals", {
      method: "POST",
      body: JSON.stringify(signal),
    });
  }

  async leaders() {
    return (await this.request("/v1/leaders")).items;
  }

  async agentMailInboxes() {
    return (await this.request("/v1/agentmail/inboxes")).inboxes;
  }

  async createAgentMailInbox({ name = "Aiko Build", confirmPurchase }) {
    if (confirmPurchase !== true) {
      throw new TypeError(
        "Creating an AgentMail inbox costs $2.00; pass confirmPurchase: true",
      );
    }
    return (
      await this.request("/v1/agentmail/inboxes", {
        method: "POST",
        body: JSON.stringify({ name, confirmPurchase }),
      })
    ).inbox;
  }

  async agentMailThreads() {
    return (await this.request("/v1/agentmail/threads")).threads;
  }

  async agentMailThread(id) {
    return (
      await this.request(`/v1/agentmail/threads/${encodeURIComponent(id)}`)
    ).thread;
  }

  waitForAgentMailCode(options = {}) {
    return this.request("/v1/agentmail/wait-for-code", {
      method: "POST",
      body: JSON.stringify(options),
    });
  }

  solveCaptcha(input) {
    if (input.confirmPurchase !== true) {
      throw new TypeError(
        "Submitting a CAPTCHA solve costs approximately $0.01; pass confirmPurchase: true",
      );
    }
    return this.request("/v1/captcha/solve", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  captchaResult(taskId) {
    return this.request(
      `/v1/captcha/results/${encodeURIComponent(taskId)}`,
    );
  }

  waitForCaptcha(input) {
    return this.request("/v1/captcha/wait", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * ACP agent/session transport. This is separate from disposable email.
   * Browser WebSocket clients cannot set an Authorization header.
   */
  browserAgentMailUrl() {
    const url = new URL(this.discovery.agentMailUrl);
    url.searchParams.set(
      this.discovery.authorization.websocketQueryParameter,
      this.discovery.authorization.token,
    );
    return url.toString();
  }

  async request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set(
      "authorization",
      `Bearer ${this.discovery.authorization.token}`,
    );
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await this.fetch(
      new URL(path, this.discovery.baseUrl),
      { ...init, headers },
    );
    const body = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new AikoNativeError(
        response.status,
        body?.error?.message ?? response.statusText,
        body?.error?.code,
        body,
      );
    }
    return body;
  }
}
