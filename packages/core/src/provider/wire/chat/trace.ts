import type { Json } from "../../../json.ts"
import {
  block,
  type CanonicalTraceRequest,
  field,
  isObject,
  list,
  normalizeItem,
  toolName,
} from "../../../trace/format.ts"

export function canonicalChatRequest(body: Readonly<Record<string, Json>>): CanonicalTraceRequest {
  const { model, tools, messages, stream: _stream, stream_options: _streamOptions, ...params } = body
  const blocks = list(tools).map((tool) => block("tool", tool, toolName(tool)))
  let leading = true
  for (const message of list(messages)) {
    const role = field(message, "role")
    leading &&= role === "system" || role === "developer"
    const item =
      isObject(message) && typeof message.content === "string"
        ? { ...message, content: [{ type: "text", text: message.content }] }
        : message
    blocks.push(block(leading ? "system" : "message", normalizeItem(item), role))
  }
  return { model: typeof model === "string" ? model : "", params, blocks }
}
