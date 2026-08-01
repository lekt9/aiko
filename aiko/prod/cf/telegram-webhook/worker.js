// Aiko Telegram Webhook Worker
// Receives Telegram updates, routes through ThinkFeel, sends replies.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    // Only accept POST to /webhook
    if (url.pathname !== "/webhook" || request.method !== "POST") {
      return new Response("Not found", { status: 404 });
    }

    try {
      const update = await request.json();

      // Extract message
      const message = update.message || update.edited_message;
      if (!message || !message.text) {
        return new Response("ok", { status: 200 });
      }

      const chatId = message.chat.id;
      const userId = message.from.id;
      const text = message.text;
      const messageId = message.message_id;

      // Only respond to the allowed chat
      const allowedChatId = parseInt(env.ALLOWED_CHAT_ID || "0", 10);
      if (allowedChatId && chatId !== allowedChatId) {
        console.log(`Ignoring message from unauthorized chat ${chatId}`);
        return new Response("ok", { status: 200 });
      }

      console.log(`Message from ${message.from.first_name} (${userId}): "${text}"`);

      // Call ThinkFeel API
      const thinkFeelResponse = await fetch(env.THINKFEEL_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.THINKFEEL_API_KEY,
        },
        body: JSON.stringify({
          personaId: env.THINKFEEL_PERSONA_ID,
          messages: [{ role: "user", content: text }],
        }),
      });

      if (!thinkFeelResponse.ok) {
        console.error(`ThinkFeel API error: ${thinkFeelResponse.status}`);
        // Fallback: send a generic reply
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "Hey! I'm here but had a hiccup thinking. Try again? 💭",
          messageId
        );
        return new Response("ok", { status: 200 });
      }

      const tfData = await thinkFeelResponse.json();
      const reply =
        tfData?.result?.finalReply ||
        "Hey! I'm listening but need a moment. What's on your mind?";

      // Send reply via Telegram
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply, messageId);

      return new Response("ok", { status: 200 });
    } catch (err) {
      console.error("Webhook error:", err.message);
      return new Response("ok", { status: 200 });
    }
  },
};

async function sendTelegramMessage(botToken, chatId, text, replyToMessageId) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: "HTML",
  };

  // Only include reply_to_message_id for non-command messages in groups
  if (replyToMessageId) {
    body.reply_to_message_id = replyToMessageId;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    console.error(`Telegram sendMessage failed: ${err}`);
  }

  return response;
}
