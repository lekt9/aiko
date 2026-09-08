import { expect, test } from "bun:test";
import { telegramHtml } from "../src/telegram-format.ts";
import { createTelegramOutbound } from "../src/telegram-outbound.ts";
import { secretaryTelegram } from "../src/secretary-telegram.ts";

test("Telegram bold, model bold, italic and code render without interpreting literal HTML", () => {
  expect(telegramHtml("*bold* **also bold** _italic_ <tag> & 2 > 1"))
    .toBe("<b>bold</b> <b>also bold</b> <i>italic</i> &lt;tag&gt; &amp; 2 &gt; 1");
  expect(telegramHtml("`*literal* <b> &`\n```ts\nconst x = '<tag>'; // _literal_\n```"))
    .toBe("<code>*literal* &lt;b&gt; &amp;</code>\n<pre>const x = '&lt;tag&gt;'; // _literal_\n</pre>");
  expect(telegramHtml("file_name_here 2 * 3 * 4\n* list item\nunfinished **bold"))
    .toBe("file_name_here 2 * 3 * 4\n* list item\nunfinished **bold");
  expect(telegramHtml("\\*literal\\* \\_literal\\_" )).toBe("*literal* _literal_");
});

test("responses, edits, drafts, media and albums carry HTML mode after redaction", async () => {
  const calls: { method: string; body: any }[] = [];
  const tg = createTelegramOutbound({
    token: "123:fixture",
    allowedUsers: new Set(["123"]),
    redact: text => text.replaceAll("secret", "[hidden]"),
    fetch: async (url, init) => {
      const method = String(url).split("/").at(-1)!;
      const body = init?.body instanceof FormData
        ? Object.fromEntries(init.body.entries())
        : JSON.parse(String(init?.body));
      calls.push({ method, body });
      return Response.json({ ok: true, result: method === "sendMessageDraft" ? true
        : method === "sendMediaGroup" ? [{ message_id: 1 }, { message_id: 2 }] : { message_id: 1 } });
    },
  });
  const signal = new AbortController().signal;
  const text = "**secret** _done_ < & 123:fixture";
  const expected = "<b>[hidden]</b> <i>done</i> &lt; &amp; [redacted]";
  expect((await tg.sendRich("123", { kind: "text", text }, signal)).status).toBe("delivered");
  expect((await tg.editProgress("123", 1, text, signal)).status).toBe("delivered");
  expect((await tg.draft("123", 1, text, signal)).status).toBe("delivered");
  expect((await tg.sendRich("123", { kind: "photo", caption: text, file: { owner: "123", fileId: "photo" } }, signal)).status).toBe("delivered");
  expect((await tg.sendRich("123", { kind: "document", caption: text, file: {
    owner: "123", bytes: new Uint8Array([1]), mimeType: "text/plain", fileName: "test.txt",
  } }, signal)).status).toBe("delivered");
  expect((await tg.sendRich("123", { kind: "album", items: ["one", "two"].map(fileId => ({
    kind: "photo", caption: text, file: { owner: "123", fileId },
  })) }, signal)).status).toBe("delivered");
  expect(calls.map(call => call.method)).toEqual([
    "sendMessage", "editMessageText", "sendMessageDraft", "sendPhoto", "sendDocument", "sendMediaGroup",
  ]);
  for (const { body } of calls.slice(0, 3)) expect(body).toMatchObject({ text: expected, parse_mode: "HTML" });
  for (const { body } of calls.slice(3, 5)) expect(body).toMatchObject({ caption: expected, parse_mode: "HTML" });
  for (const item of calls[5]!.body.media) expect(item).toMatchObject({ caption: expected, parse_mode: "HTML" });
  expect((await tg.sendRich("123", { kind: "text", text: "**bold** & ".repeat(500) }, signal)).status).toBe("delivered");
  expect(calls.at(-1)).toMatchObject({ method: "sendRichMessage", body: {
    rich_message: { html: "<b>bold</b> &amp; ".repeat(500) },
  } });
});

test("secretary responses use the same formatting", async () => {
  const calls: any[] = [];
  const api = secretaryTelegram("123:fixture", async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ ok: true, result: { message_id: 1 } });
  });
  await api.send(
    { id: "connection", owner: "123", ownerChat: "123", enabled: true, canReply: true, canRead: true },
    { connectionId: "connection", chat: "456", chatType: "private", name: "Contact", messageId: 1,
      sender: "456", text: "hello", date: 1, viaBot: false, unsupported: false },
    "*bold* _italic_ & <literal>", new AbortController().signal,
  );
  expect(calls[0]).toMatchObject({ business_connection_id: "connection", chat_id: "456",
    text: "<b>bold</b> <i>italic</i> &amp; &lt;literal&gt;", parse_mode: "HTML" });
});
