/** Public routing only. Never put a bot token or account identifiers in frontend configuration. */
export function telegramBotUrl(username = "aikospillstea_bot") {
  if (!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username))
    throw new Error("Invalid public Telegram bot username");
  return `https://t.me/${username}?start=web`;
}
export const AIKO_TELEGRAM_URL = telegramBotUrl(
  import.meta.env.VITE_TELEGRAM_BOT_USERNAME || undefined,
);
