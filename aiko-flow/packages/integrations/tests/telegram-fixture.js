// Real HTTP fixture speaking the Telegram Bot API wire format (Bun.serve).
// getUpdates implements real long-poll semantics: `offset` acknowledges and
// discards earlier updates, and the request is held open until updates are
// available or the `timeout` (seconds) elapses. Not a mock of the code under
// test — the real fetch-based client talks to it over real HTTP.

export const FIXTURE_BOT_TOKEN = "424242:TEST-fixture-bot-token";

/**
 * @param {{ token?: string }} [options]
 */
export function startTelegramFixture(options = {}) {
  const token = options.token ?? FIXTURE_BOT_TOKEN;
  /** @type {Array<Record<string, any>>} pending updates (ascending update_id) */
  let updates = [];
  /** @type {Array<{ method: string; body: any; contentType: string }>} */
  const requests = [];
  /** @type {Map<string, Array<{ status?: number; body: any }>>} scripted responses per method */
  const scripted = new Map();
  let nextMessageId = 1000;
  let nextUpdateId = 1;
  /** @type {Map<string, { path: string; bytes: Uint8Array }>} file_id → stored file */
  const files = new Map();
  let nextFileId = 1;
  const server = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch: async (request) => {
      const url = new URL(request.url);
      // Media download endpoint: GET /file/bot<token>/<file_path>.
      const fileMatch = url.pathname.match(/^\/file\/bot([^/]+)\/(.+)$/);
      if (fileMatch) {
        if (fileMatch[1] !== token) {
          return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
        }
        requests.push({ method: "downloadFile", body: { file_path: fileMatch[2] }, contentType: "" });
        const stored = [...files.values()].find((entry) => entry.path === fileMatch[2]);
        if (!stored) {
          return Response.json({ ok: false, error_code: 404, description: "file not found" }, { status: 404 });
        }
        return new Response(stored.bytes, { headers: { "content-type": "application/octet-stream" } });
      }
      const match = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
      if (!match) {
        return Response.json({ ok: false, error_code: 404, description: "Not Found" }, { status: 404 });
      }
      if (match[1] !== token) {
        return Response.json({ ok: false, error_code: 401, description: "Unauthorized" }, { status: 401 });
      }
      const method = match[2];
      const contentType = request.headers.get("content-type") ?? "";
      /** @type {any} */
      let body = {};
      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        body = {};
        for (const [key, value] of form.entries()) {
          body[key] =
            typeof value === "string"
              ? value
              : { filename: value.name, size: value.size, type: value.type, text: await value.text() };
        }
      } else {
        try {
          body = await request.json();
        } catch {
          body = {};
        }
      }
      requests.push({ method, body, contentType });
      const queue = scripted.get(method);
      if (queue && queue.length > 0) {
        const next = /** @type {{ status?: number; body: any }} */ (queue.shift());
        return Response.json(next.body, { status: next.status ?? 200 });
      }
      switch (method) {
        case "getUpdates": {
          // Real semantics: offset acknowledges everything below it.
          if (typeof body.offset === "number") {
            updates = updates.filter((update) => update.update_id >= body.offset);
          }
          const timeoutMs = Math.max(0, Number(body.timeout ?? 0)) * 1000;
          const deadline = Date.now() + timeoutMs;
          while (updates.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return Response.json({ ok: true, result: [...updates] });
        }
        case "sendMessage": {
          nextMessageId += 1;
          return Response.json({
            ok: true,
            result: {
              message_id: nextMessageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: body.chat_id, type: "private" },
              text: body.text,
            },
          });
        }
        case "editMessageText": {
          return Response.json({
            ok: true,
            result: {
              message_id: body.message_id,
              chat: { id: body.chat_id, type: "private" },
              text: body.text,
              edit_date: Math.floor(Date.now() / 1000),
            },
          });
        }
        case "sendDocument": {
          nextMessageId += 1;
          return Response.json({
            ok: true,
            result: {
              message_id: nextMessageId,
              chat: { id: body.chat_id },
              document: { file_id: `file-${nextMessageId}` },
            },
          });
        }
        case "sendPhoto":
        case "sendVideo":
        case "sendAudio":
        case "sendVoice": {
          // The Bot API rejects an upload whose multipart FIELD does not
          // match the method, so the fixture does too: a router that picks
          // sendPhoto but attaches `video` must fail here, not pass.
          const field = method.slice(4).toLowerCase();
          if (body[field] === undefined) {
            return Response.json(
              { ok: false, error_code: 400, description: `Bad Request: field "${field}" is missing for ${method}` },
              { status: 400 },
            );
          }
          nextMessageId += 1;
          const fileId = `file-${method}-${nextFileId++}`;
          const attachment = body[field];
          const filename = typeof attachment === "object" && attachment ? attachment.filename : null;
          files.set(fileId, {
            path: `${field}s/${fileId}${filename ? filename.slice(filename.lastIndexOf(".")) : ""}`,
            bytes: new TextEncoder().encode(
              typeof attachment === "object" && attachment ? (attachment.text ?? "") : String(attachment),
            ),
          });
          return Response.json({
            ok: true,
            result: {
              message_id: nextMessageId,
              date: Math.floor(Date.now() / 1000),
              chat: { id: body.chat_id },
              caption: body.caption,
              [field]: { file_id: fileId, file_unique_id: `u-${fileId}` },
            },
          });
        }
        case "getFile": {
          const stored = files.get(body.file_id);
          if (!stored) {
            return Response.json(
              { ok: false, error_code: 400, description: "Bad Request: invalid file_id" },
              { status: 400 },
            );
          }
          return Response.json({
            ok: true,
            result: { file_id: body.file_id, file_unique_id: `u-${body.file_id}`, file_size: stored.bytes.length, file_path: stored.path },
          });
        }
        case "getMe": {
          return Response.json({
            ok: true,
            result: { id: 424242, is_bot: true, first_name: "Fixture Bot", username: "fixture_bot" },
          });
        }
        case "sendChatAction":
        case "answerCallbackQuery": {
          return Response.json({ ok: true, result: true });
        }
        case "answerWebAppQuery": {
          return Response.json({ ok: true, result: { inline_message_id: `iq-${body.web_app_query_id}` } });
        }
        default:
          return Response.json(
            { ok: false, error_code: 404, description: `Unknown method ${method}` },
            { status: 404 },
          );
      }
    },
  });
  return {
    token,
    apiBaseUrl: `http://localhost:${server.port}`,
    requests,
    /** Requests for one Bot API method, in arrival order. */
    calls: (/** @type {string} */ method) => requests.filter((entry) => entry.method === method),
    /** Queue a scripted response for the next call to `method`. */
    queueResponse: (/** @type {string} */ method, /** @type {{ status?: number; body: any }} */ response) => {
      const queue = scripted.get(method) ?? [];
      queue.push(response);
      scripted.set(method, queue);
    },
    /** Seed an incoming update (auto-assigns update_id, returns it). */
    pushUpdate: (/** @type {Record<string, any>} */ update) => {
      const withId = { update_id: update.update_id ?? nextUpdateId, ...update };
      nextUpdateId = withId.update_id + 1;
      updates.push(withId);
      updates.sort((a, b) => a.update_id - b.update_id);
      return withId.update_id;
    },
    pendingUpdateCount: () => updates.length,
    stop: () => server.stop(true),
  };
}
