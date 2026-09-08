/** Deterministic OpenAI SSE wire fixture for the real Tardigrade model adapter. */
export const browserCompletionStream = (completion: string | Record<string, unknown>): Response => {
  const root = typeof completion === "string" ? JSON.parse(completion) : completion
  const chunks = root.choices.map((choice: any) => ({
    id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture",
    choices: [{ index: choice.index, delta: {
      ...choice.message,
      tool_calls: choice.message.tool_calls?.map((call: unknown, index: number) => ({ ...(call as object), index }))
    }, finish_reason: choice.finish_reason }]
  }))
  chunks.push({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [], usage: root.usage })
  return new Response(chunks.map((chunk: unknown) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" }
  })
}
