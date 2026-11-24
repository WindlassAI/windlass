import type { Json } from "../../../json.ts"
import { makeProviderError, type ProviderError } from "../../error.ts"
import type { StreamEvent } from "../../provider.ts"
import type { SseEvent } from "../../sse.ts"
import type { Usage } from "../../usage.ts"
import { isRecord, parseJson, stringOr } from "../fields.ts"
import { chatError } from "./error.ts"
import { type ChatWireOptions, modelFamily } from "./options.ts"

function count(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function usage(raw: Record<string, unknown>): Usage {
  const input = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {}
  const output = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : {}
  return {
    inputTokens: count(raw.prompt_tokens),
    cachedInputTokens: count(input.cached_tokens),
    outputTokens: count(raw.completion_tokens),
    reasoningTokens: count(output.reasoning_tokens),
    ...(typeof input.cache_write_tokens === "number" && { cacheWriteTokens: count(input.cache_write_tokens) }),
  }
}

const identityFields = ["id", "format", "signature"] as const

// Reassemble indexed text/summary deltas across frames, including the final signature-only delta.
// Unknown and encrypted blocks, and the ordering of complete entries within an array, are opaque.
function appendDetails(details: Json[], delta: Json[]) {
  const previousLength = details.length
  for (const part of delta) {
    if (
      isRecord(part) &&
      typeof part.index === "number" &&
      (part.type === "reasoning.text" || part.type === "reasoning.summary")
    ) {
      const index = details.findLastIndex((prev, i) => {
        if (i >= previousLength || !isRecord(prev) || prev.type !== part.type || prev.index !== part.index) return false
        return identityFields.every((key) => prev[key] == null || part[key] == null || prev[key] === part[key])
      })
      const prev = details[index]
      if (isRecord(prev)) {
        const field = part.type === "reasoning.text" ? "text" : "summary"
        const merged = { ...prev, ...part }
        for (const key of identityFields) {
          if (prev[key] != null && part[key] == null) merged[key] = prev[key]
        }
        if (typeof prev[field] === "string")
          merged[field] = prev[field] + (typeof part[field] === "string" ? part[field] : "")
        details[index] = merged as Json
        continue
      }
    }
    details.push(part)
  }
}

function detailText(part: Json): string {
  if (!isRecord(part)) return ""
  if (part.type === "reasoning.text") return stringOr(part.text) ?? ""
  if (part.type === "reasoning.summary" || part.type === "summary") return stringOr(part.summary) ?? ""
  return ""
}

interface Call {
  id: string
  name: string
  input: string
  emitted: number
}

export class ChatStreamMapper {
  done = false
  private readonly calls = new Map<number, Call>()
  private text = ""
  private summary = ""
  private details?: Json[]
  private reason: string | null = null
  private model: string | null = null
  private usage?: Usage
  private refused = false

  constructor(
    private readonly id: string | null,
    private readonly requestedModel: string,
    private readonly options: ChatWireOptions,
  ) {}

  fail(error: ProviderError): StreamEvent[] {
    if (this.done) return []
    this.done = true
    return [...this.takeUsage(), { type: "error", error: { ...error, requestId: this.id } }]
  }

  private takeUsage(): StreamEvent[] {
    const usage = this.usage
    this.usage = undefined
    return usage ? [{ type: "usage", usage }] : []
  }

  end(): StreamEvent[] {
    return this.fail(makeProviderError("incomplete_stream", "the chat stream ended before [DONE]"))
  }

  frame(frame: SseEvent): StreamEvent[] {
    if (this.done) return []
    if (frame.data.trim() === "[DONE]") return this.finish()
    const chunk = parseJson(frame.data)
    if (!isRecord(chunk)) return this.fail(makeProviderError("provider_internal", "invalid chat stream frame"))
    if (typeof chunk.model === "string") this.model = chunk.model
    if (isRecord(chunk.usage)) this.usage = usage(chunk.usage)
    if (isRecord(chunk.error)) return this.fail(chatError(chunk.error, this.id))
    if (!Array.isArray(chunk.choices)) return this.fail(makeProviderError("provider_internal", "missing chat choices"))
    const events: StreamEvent[] = []
    for (const choice of chunk.choices) {
      // We request one choice. Each choice has its own independent tool indices.
      if (!isRecord(choice) || (choice.index ?? 0) !== 0) continue
      this.reason = stringOr(choice.finish_reason) ?? this.reason
      if (!isRecord(choice.delta)) continue
      const delta = choice.delta
      let summary: string | null | undefined
      if (this.options.openRouterReasoning) {
        summary = stringOr(delta.reasoning)
        if (Array.isArray(delta.reasoning_details)) {
          appendDetails((this.details ??= []), delta.reasoning_details)
          summary ??= delta.reasoning_details.map(detailText).join("")
        }
      } else if (this.options.reasoningField) {
        summary = stringOr(delta[this.options.reasoningField])
      }
      if (summary) {
        this.summary += summary
        events.push({ type: "reasoning.delta", text: summary })
      }
      if (typeof delta.content === "string" && delta.content) {
        this.text += delta.content
        events.push({ type: "text.delta", text: delta.content })
      }
      if (stringOr(delta.refusal)) this.refused = true
      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls) {
          const update = this.toolDelta(tool)
          if (this.done) return update
          events.push(...update)
        }
      }
    }
    return events
  }

  private toolDelta(tool: unknown): StreamEvent[] {
    if (!isRecord(tool) || typeof tool.index !== "number" || !Number.isSafeInteger(tool.index) || tool.index < 0)
      return this.fail(makeProviderError("provider_internal", "invalid chat tool index"))
    const call = this.calls.get(tool.index) ?? { id: "", name: "", input: "", emitted: 0 }
    const fn = isRecord(tool.function) ? tool.function : {}
    const id = stringOr(tool.id)
    const name = stringOr(fn.name)
    if ((id && call.id && id !== call.id) || (name && call.name && name !== call.name))
      return this.fail(makeProviderError("provider_internal", "chat tool call identity changed mid-stream"))
    call.id = id ?? call.id
    call.name = name ?? call.name
    if (typeof fn.arguments === "string") call.input += fn.arguments
    this.calls.set(tool.index, call)
    if (!call.id || !call.name || call.emitted === call.input.length) return []
    const input = call.input.slice(call.emitted)
    call.emitted = call.input.length
    return [{ type: "tool_call.delta", callId: call.id, name: call.name, input }]
  }

  private finish(): StreamEvent[] {
    if (this.refused || this.reason === "content_filter")
      return this.fail(
        makeProviderError("content_policy", "the chat completion was refused", { code: this.reason ?? "refusal" }),
      )
    if (!this.reason) return this.fail(makeProviderError("incomplete_stream", "missing chat finish_reason"))
    if (this.reason !== "tool_calls" && this.reason !== "length" && this.reason !== "stop")
      return this.fail(makeProviderError("provider_internal", "unexpected chat finish_reason", { code: this.reason }))
    if (
      this.reason === "tool_calls" &&
      (!this.calls.size || [...this.calls.values()].some((call) => !call.id || !call.name))
    )
      return this.fail(makeProviderError("provider_internal", "missing chat tool call identity"))
    const events = this.takeUsage()
    if (this.summary || this.details) {
      const data: Record<string, Json> = {
        provider: this.options.provider,
        family: modelFamily(this.model ?? this.requestedModel),
      }
      if (this.details) data.reasoning_details = this.details
      if (this.options.reasoningField) data[this.options.reasoningField] = this.summary
      events.push({ type: "reasoning.end", text: this.summary, providerData: data })
    }
    if (this.text) events.push({ type: "text.end", text: this.text, providerData: null })
    if (this.reason === "tool_calls") {
      for (const [, call] of [...this.calls].sort(([a], [b]) => a - b)) {
        events.push({ type: "tool_call.end", callId: call.id, name: call.name, input: call.input, providerData: null })
      }
    }
    this.done = true
    const response = { ...(this.model && { model: this.model }), ...(this.id && { requestId: this.id }) }
    return [...events, { type: "finish", reason: this.reason, ...(Object.keys(response).length > 0 && { response }) }]
  }
}
