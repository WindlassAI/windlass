import type { BlobRef } from "../../../content.ts"
import type { Json } from "../../../json.ts"
import { canonicalJson } from "../../../request/canonical.ts"
import type { ModelRequest } from "../../../request/request.ts"
import { type BlobBytes, type EncodedRequest, MissingBlobError } from "../request.ts"
import { isRecord } from "../fields.ts"
import { type ChatWireOptions, modelFamily } from "./options.ts"

function image(ref: BlobRef, blobs: BlobBytes, options: ChatWireOptions): Json {
  if (!ref.mediaType.startsWith("image/")) throw new Error(`unsupported chat attachment: ${ref.mediaType}`)
  if (options.images === false) throw new Error("this chat model does not accept images")
  const bytes = blobs.get(ref.hash)
  if (!bytes) throw new MissingBlobError(ref)
  return {
    type: "image_url",
    image_url: { url: `data:${ref.mediaType};base64,${Buffer.from(bytes).toString("base64")}` },
  }
}

interface Assistant {
  role: "assistant"
  content: string | null
  tool_calls?: Json[]
  reasoning_details?: Json[]
  reasoning_content?: string
  reasoning_text?: string
}

export function encodeRequest(request: ModelRequest, blobs: BlobBytes, options: ChatWireOptions): EncodedRequest {
  const { model, reasoningEffort } = request.params
  const messages: (Json | Assistant)[] = []
  if (request.instructions) messages.push({ role: "system", content: request.instructions })
  let assistant: Assistant | undefined
  let toolImages: Json[] = []
  const flushImages = () => {
    if (toolImages.length) messages.push({ role: "user", content: toolImages })
    toolImages = []
  }
  const turn = (): Assistant => {
    if (!assistant) {
      assistant = { role: "assistant", content: null }
      messages.push(assistant)
    }
    return assistant
  }
  for (const item of request.input) {
    if (item.type !== "tool_result") flushImages()
    switch (item.type) {
      case "message": {
        assistant = undefined
        const role = item.role === "developer" ? (options.developerRole ?? "system") : item.role
        const content = item.content.map((part) =>
          part.type === "text" ? { type: "text", text: part.text } : image(part.blob, blobs, options),
        )
        messages.push({ role, content })
        break
      }
      case "assistant_text": {
        const message = turn()
        message.content = (message.content ?? "") + item.text
        break
      }
      case "reasoning": {
        const data = item.providerData
        if (!isRecord(data) || data.provider !== options.provider || data.family !== modelFamily(model)) break
        if (options.openRouterReasoning && Array.isArray(data.reasoning_details)) {
          const message = turn()
          message.reasoning_details ??= []
          message.reasoning_details.push(...data.reasoning_details)
        }
        const field = options.reasoningField
        if (field && typeof data[field] === "string") turn()[field] = data[field]
        break
      }
      case "tool_call": {
        const message = turn()
        message.tool_calls ??= []
        message.tool_calls.push({
          type: "function",
          id: item.callId,
          function: { name: item.name, arguments: item.input },
        })
        break
      }
      case "tool_result":
        assistant = undefined
        messages.push({ role: "tool", tool_call_id: item.callId, content: item.output })
        // Chat restricts tool messages to text. Keep all parallel results adjacent before adding images.
        if (item.attachments.length) {
          toolImages.push(
            { type: "text", text: `Images from tool call ${item.callId}:` },
            ...item.attachments.map((ref) => image(ref, blobs, options)),
          )
        }
        break
    }
  }
  flushImages()
  const tools = request.tools.map(({ name, description, inputSchema }) => ({
    type: "function",
    function: { name, description, parameters: inputSchema },
  }))
  return {
    body: canonicalJson({
      model,
      messages,
      n: 1,
      stream: true,
      stream_options: { include_usage: true },
      ...(tools.length > 0 && {
        tools,
        tool_choice: request.toolChoice,
        parallel_tool_calls: request.params.parallelToolCalls,
      }),
      [options.tokenLimitField ?? "max_tokens"]: options.maxTokens,
      reasoning:
        reasoningEffort === null ? undefined : options.openRouterReasoning?.(model, reasoningEffort, options.maxTokens),
    }),
    headers: { "content-type": "application/json", accept: "text/event-stream" },
  }
}
