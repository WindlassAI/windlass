import type { Json } from "../../../json.ts"
import {
  block, type CanonicalTraceRequest, field, isObject, list, normalizeItem, toolName, type TraceBlockKind,
} from "../../../trace/format.ts"

/** Messages uses explicit cache markers. Keep their positions separate from the canonical content hash. */
export function canonicalAnthropicRequest(body: Readonly<Record<string, Json>>): CanonicalTraceRequest {
  const { model, tools, system, messages, stream: _stream, ...params } = body
  const marked = (value: Json) => isObject(value) && value.cache_control !== undefined
  const entry = (kind: TraceBlockKind, item: Json, key?: string) => {
    const parts = isObject(item) ? list(item.content) : []
    const breakpoint = marked(item) || parts.some(marked)
    return { ...block(kind, normalizeItem(item), key), ...(breakpoint && { breakpoint: true }) }
  }
  return {
    model: String(model), params, blocks: [
      ...list(tools).map((tool) => entry("tool", tool, toolName(tool))),
      ...list(system).map((part) => entry("system", part)),
      ...list(messages).map((message) => entry("message", message, field(message, "role"))),
    ],
  }
}
