import type { BlobRef, Content } from "../../../content.ts"
import type { Json } from "../../../json.ts"
import { canonicalJson } from "../../../request/canonical.ts"
import type { InputItem, ModelRequest } from "../../../request/request.ts"
import { anthropicModel } from "./catalog.ts"
import { isRecord } from "../fields.ts"
import { type BlobBytes, type EncodedRequest, MissingBlobError } from "../request.ts"

type Block = Record<string, Json>
type Message = { role: "assistant" | "user" | "system"; content: Block[] }
const cache = { type: "ephemeral" }

function media(ref: BlobRef, blobs: BlobBytes): Block {
  const bytes = blobs.get(ref.hash)
  if (!bytes) throw new MissingBlobError(ref)
  const mediaType = ref.mediaType
  if (mediaType === "text/plain")
    return { type: "document", source: { type: "text", media_type: mediaType, data: new TextDecoder().decode(bytes) } }
  const image = ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mediaType)
  if (!image && mediaType !== "application/pdf") throw new Error(`unsupported Messages attachment: ${mediaType}`)
  return { type: image ? "image" : "document", source: { type: "base64", media_type: mediaType, data: Buffer.from(bytes).toString("base64") } }
}

function content(parts: Content, blobs: BlobBytes): Block[] {
  return parts.flatMap((part): Block[] => {
    if (part.type === "media") return [media(part.blob, blobs)]
    return part.text.trim() ? [{ type: "text", text: part.text }] : []
  })
}

// A native system update must follow a user turn and precede the next assistant turn.
// Within that user turn the API requires every tool result before ordinary content.
function messages(input: readonly InputItem[], blobs: BlobBytes, nativeSystem: boolean): Message[] {
  const result: Message[] = []
  let results: Block[] = []
  let user: Block[] = []
  let updates: Block[] = []
  function flushUser() {
    if (results.length || user.length) {
      result.push({ role: "user", content: [...results, ...user] })
      if (updates.length) result.push({ role: "system", content: updates })
    } else if (updates.length) {
      result.push({ role: "user", content: updates.map(wrapInstruction) })
    }
    results = []
    user = []
    updates = []
  }
  for (const item of input) {
    if (item.type === "message") {
      const blocks = content(item.content, blobs)
      if (item.role === "user") {
        // A native system message cannot precede user content. Fold this update at its original position.
        user.push(...updates.map(wrapInstruction), ...blocks)
        updates = []
      } else if (nativeSystem && blocks.every((b) => b.type === "text")) updates.push(...blocks)
      else user.push(...blocks.map(wrapInstruction))
      continue
    }
    if (item.type === "tool_result") {
      const output = item.attachments.length
        ? [
            ...(item.output ? [{ type: "text", text: item.output }] : []),
            ...item.attachments.map((ref) => media(ref, blobs)),
          ]
        : item.output
      results.push({ type: "tool_result", tool_use_id: item.callId, content: output })
      continue
    }
    let block: Block
    if (item.type === "reasoning") {
      const data = item.providerData
      if (!isRecord(data) || data.provider !== "anthropic" || !isRecord(data.block)) continue
      if (data.block.type !== "thinking" && data.block.type !== "redacted_thinking") continue
      block = data.block as Block
    } else if (item.type === "assistant_text") {
      if (!item.text.trim()) continue
      block = { type: "text", text: item.text }
    } else {
      block = { type: "tool_use", id: item.callId, name: item.name, input: JSON.parse(item.input) }
    }
    flushUser()
    const last = result.at(-1)
    if (last?.role === "assistant") last.content.push(block)
    else result.push({ role: "assistant", content: [block] })
  }
  flushUser()
  return result
}

function wrapInstruction(block: Block): Block {
  return block.type === "text" ? { type: "text", text: `<system-reminder>\n${block.text}\n</system-reminder>` } : block
}

const budgets: Record<string, number> = { low: 1024, medium: 8192, high: 32768 }

function thinkingConfig(model: ReturnType<typeof anthropicModel>, effort: string | null) {
  if (model.thinking === "adaptive" && (effort !== null || model.defaultEffort !== null))
    return { type: "adaptive", display: "summarized" }
  if (model.thinking === "enabled" && effort !== null)
    return { type: "enabled", budget_tokens: Math.min(budgets[effort]!, Math.floor(model.maxTokens / 2)) }
  return undefined
}

export function encodeRequest(request: ModelRequest, blobs: BlobBytes): EncodedRequest {
  const model = anthropicModel(request.params.model)
  const effort = request.params.reasoningEffort
  if (effort !== null && model.efforts !== null && !model.efforts.includes(effort))
    throw new Error(`unsupported effort for ${request.params.model}: ${effort}`)
  const thinking = thinkingConfig(model, effort)
  const tools = request.tools.map((tool, index) => ({
    name: tool.name, description: tool.description, input_schema: tool.inputSchema,
    ...(index === request.tools.length - 1 && { cache_control: cache }),
  }))
  // Leading text instructions already precede all dialogue and can keep their privileged role on every model.
  const system: Block[] = request.instructions.trim() ? [{ type: "text", text: request.instructions }] : []
  const firstTurn = request.input.findIndex((item) =>
    item.type !== "message" || item.role !== "developer" || item.content.some((part) => part.type !== "text"))
  const leading = Math.max(firstTurn, 0)
  for (const item of request.input.slice(0, leading)) {
    if (item.type === "message") system.push(...content(item.content, blobs))
  }
  if (system.length) system[system.length - 1]!.cache_control = cache
  const turns = messages(request.input.slice(leading), blobs, model.nativeSystem)
  const tail = turns.at(-1)?.content.findLast((block) => block.type !== "thinking" && block.type !== "redacted_thinking")
  if (tail) tail.cache_control = cache
  const toolChoice = {
    type: request.toolChoice,
    ...(request.toolChoice === "auto" && !request.params.parallelToolCalls && { disable_parallel_tool_use: true }),
  }
  const body = {
    model: request.params.model,
    stream: true,
    max_tokens: model.maxTokens,
    thinking,
    output_config: model.thinking === "adaptive" && effort !== null ? { effort } : undefined,
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? toolChoice : undefined,
    system: system.length ? system : undefined,
    messages: turns,
  }
  const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" }
  if (thinking?.type === "enabled" && model.interleaved && tools.length && request.toolChoice === "auto")
    headers["anthropic-beta"] = "interleaved-thinking-2025-05-14"
  return { body: canonicalJson(body), headers }
}
