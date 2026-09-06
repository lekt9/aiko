/** Bound bytes while reading, not after allocating an arbitrarily large request. */
export async function readBoundedJson(
  request: Request,
  limit: number,
): Promise<unknown> {
  if (!request.body) throw new Error("Invalid body");
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    text = "";
  try {
    if (Number(request.headers.get("content-length")) > limit)
      throw new Error("Body too large");
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("Body too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Invalid body");
  } finally {
    reader.releaseLock();
  }
}
