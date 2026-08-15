/**
 * User bubble prefix written by Remote IM host when journaling turns into App.
 * Format: `[Remote IM · {channel}]\n{body}`
 */

export const REMOTE_IM_USER_HEADER_RE =
  /^\[Remote IM\s*[·•.\-]\s*([^\]]+)\](?:\r?\n)+(.*)$/s;

/** Alternate halfwidth/fullwidth dots and optional spaces. */
export const REMOTE_IM_USER_HEADER_RE_LOOSE =
  /^\[Remote IM\s*[·•.\-－]\s*([^\]]+)\]\s*\r?\n+([\s\S]*)$/;

export type RemoteImUserContent = {
  /** Raw channel id, e.g. feishu / weixin */
  channel: string;
  body: string;
};

/** Parse `[Remote IM · channel]\\n body` from Remote IM journaled turns. */
export function parseRemoteImUserContent(
  content: string,
): RemoteImUserContent | null {
  const raw = content || "";
  const m =
    REMOTE_IM_USER_HEADER_RE.exec(raw) ||
    REMOTE_IM_USER_HEADER_RE_LOOSE.exec(raw);
  if (!m) return null;
  const channel = (m[1] || "").trim();
  if (!channel) return null;
  return {
    channel,
    body: (m[2] || "").replace(/^\r?\n/, ""),
  };
}

/** Human-readable channel label for the pill title. */
export function remoteImChannelLabel(channel: string, locale?: string): string {
  const c = channel.trim().toLowerCase();
  const zh = !locale || locale.startsWith("zh");
  const map: Record<string, [string, string]> = {
    feishu: ["飞书", "Feishu"],
    lark: ["Lark", "Lark"],
    weixin: ["微信", "WeChat"],
    wecom: ["企业微信", "WeCom"],
    dingtalk: ["钉钉", "DingTalk"],
    telegram: ["Telegram", "Telegram"],
    discord: ["Discord", "Discord"],
    slack: ["Slack", "Slack"],
    qq: ["QQ", "QQ"],
    qqbot: ["QQ 机器人", "QQ Bot"],
  };
  const pair = map[c];
  if (pair) return zh ? pair[0] : pair[1];
  return channel;
}
