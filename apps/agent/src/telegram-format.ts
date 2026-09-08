const escapeHtml = (text: string) => text
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

/** Render **bold**, Telegram *bold*, _italic_, and code as Telegram HTML.
 * Raw HTML and unmatched markers (including partial drafts) stay literal.
 * Code is consumed first so its contents are never interpreted as formatting.
 */
export function telegramHtml(text: string): string {
  const tokens = /\\([\\`*_])|```(?:[\w+-]+)?\n([\s\S]*?)```|`([^`\n]+)`|(?<![\w*])\*\*(?!\s)([^*\n]*\S)\*\*(?!\*)|(?<![\w*])\*(?!\s)([^*\n]*\S)\*(?!\*)|(?<![\w_])_(?!\s)([^_\n]*\S)_(?!\w)/g;
  let html = "", end = 0;
  for (const match of text.matchAll(tokens)) {
    html += escapeHtml(text.slice(end, match.index));
    const [, escaped, pre, code, bold, starBold, italic] = match;
    if (escaped !== undefined) html += escapeHtml(escaped);
    else if (pre !== undefined) html += `<pre>${escapeHtml(pre)}</pre>`;
    else if (code !== undefined) html += `<code>${escapeHtml(code)}</code>`;
    else if (bold !== undefined || starBold !== undefined) html += `<b>${escapeHtml(bold ?? starBold!)}</b>`;
    else html += `<i>${escapeHtml(italic!)}</i>`;
    end = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(end));
}

export function telegramText(text: string) {
  return { text: telegramHtml(text), parse_mode: "HTML" as const };
}
