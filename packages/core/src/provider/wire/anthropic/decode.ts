import type { Json } from "../../../json.ts"
import { makeProviderError, type ProviderError } from "../../error.ts"
import type { FinishReason, StreamEvent } from "../../provider.ts"
import type { SseEvent } from "../../sse.ts"
import { isRecord, parseJson, stringOr } from "../fields.ts"
import { classify } from "./error.ts"

type Fields = Record<string, unknown>
type OpenBlock = { block: Record<string, Json>; input: string }

export class MessagesStreamMapper {
  done = false
  private readonly blocks = new Map<number, OpenBlock>()
  private pendingCall?: Extract<StreamEvent, { type: "tool_call.end" }>
  private started = false
  private model: string | null = null
  private stop: string | null = null
  private usage: Fields | null = null

  constructor(private readonly requestId: string | null, private readonly requestedModel: string) {}

  frame(frame: SseEvent): StreamEvent[] {
    if (this.done) return []
    const event = parseJson(frame.data)
    if (!isRecord(event) || typeof event.type !== "string") return this.invalid("invalid Messages stream frame")
    switch (event.type) {
      case "error": {
        const error = isRecord(event.error) ? event.error : {}
        return this.fail(classify(stringOr(error.type), stringOr(error.message) ?? "Messages stream failed"))
      }
      case "message_start":
        if (this.started || !isRecord(event.message)) return this.invalid("invalid message_start")
        this.started = true
        this.model = stringOr(event.message.model)
        if (isRecord(event.message.usage)) this.usage = event.message.usage
        return []
      case "content_block_start":
      case "content_block_delta":
      case "content_block_stop": {
        const previous = this.pendingCall
        this.pendingCall = undefined
        const events = this.content(event)
        return previous ? [previous, ...events] : events
      }
      case "message_delta":
        if (isRecord(event.usage)) this.usage = { ...this.usage, ...event.usage }
        if (isRecord(event.delta)) this.stop = stringOr(event.delta.stop_reason) ?? this.stop
        return []
      case "message_stop":
        return this.finish()
      default:
        return []
    }
  }

  private content(event: Fields): StreamEvent[] {
    const index = event.index
    if (!this.started || typeof index !== "number" || !Number.isInteger(index) || index < 0) return this.invalid("invalid content block index")
    const open = this.blocks.get(index)
    if (event.type === "content_block_start") {
      if (open || !isRecord(event.content_block)) return this.invalid("invalid content_block_start")
      const block = event.content_block as Record<string, Json>
      if (block.type === "tool_use" && (!stringOr(block.id) || !stringOr(block.name)))
        return this.invalid("tool_use is missing its id or name")
      this.blocks.set(index, { block, input: "" })
      const events: StreamEvent[] = []
      if (block.type === "text" && typeof block.text === "string" && block.text) events.push({ type: "text.delta", text: block.text })
      if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) events.push({ type: "reasoning.delta", text: block.thinking })
      return events
    }
    if (!open) return this.invalid("content block is missing its start")
    if (event.type === "content_block_delta") return isRecord(event.delta) ? this.delta(open, event.delta) : this.invalid("missing content delta")
    this.blocks.delete(index)
    const { block } = open
    switch (block.type) {
      case "text":
        return [{ type: "text.end", text: String(block.text ?? ""), providerData: null }]
      case "thinking":
      case "redacted_thinking": {
        if (block.type === "thinking" && (typeof block.thinking !== "string" || !stringOr(block.signature)))
          return this.invalid("thinking block is missing its text or signature")
        if (block.type === "redacted_thinking" && !stringOr(block.data)) return this.invalid("redacted_thinking is missing its data")
        const text = block.type === "thinking" ? String(block.thinking) : ""
        return [{ type: "reasoning.end", text, providerData: { provider: "anthropic", model: this.requestedModel, block } }]
      }
      case "tool_use":
        // Anthropic closes even a truncated tool block. The following block or stop reason tells us it is safe to execute.
        this.pendingCall = { type: "tool_call.end", callId: String(block.id), name: String(block.name),
          input: open.input || JSON.stringify(block.input ?? {}), providerData: null }
        return []
      default:
        return []
    }
  }

  private delta(open: OpenBlock, delta: Fields): StreamEvent[] {
    const { block } = open
    if (delta.type === "text_delta" && block.type === "text" && typeof delta.text === "string") {
      block.text = String(block.text ?? "") + delta.text
      return [{ type: "text.delta", text: delta.text }]
    }
    if (delta.type === "thinking_delta" && block.type === "thinking" && typeof delta.thinking === "string") {
      block.thinking = String(block.thinking ?? "") + delta.thinking
      return [{ type: "reasoning.delta", text: delta.thinking }]
    }
    if (delta.type === "signature_delta" && block.type === "thinking" && typeof delta.signature === "string")
      block.signature = String(block.signature ?? "") + delta.signature
    if (delta.type === "input_json_delta" && block.type === "tool_use" && typeof delta.partial_json === "string") {
      open.input += delta.partial_json
      return [{ type: "tool_call.delta", callId: String(block.id), name: String(block.name), input: delta.partial_json }]
    }
    return []
  }

  private finish(): StreamEvent[] {
    if (!this.started || this.blocks.size || !this.stop) return this.end()
    const events: StreamEvent[] = []
    let reason: FinishReason
    switch (this.stop) {
      case "end_turn":
      case "stop_sequence":
      case "pause_turn":
        reason = "stop"
        break
      case "tool_use":
        reason = "tool_calls"
        if (this.pendingCall) events.push(this.pendingCall)
        break
      case "max_tokens":
      case "model_context_window_exceeded":
        reason = "length"
        break
      case "refusal":
        return [...this.usageEvent(), ...this.fail(classify("refusal", "the model refused the request"))]
      default:
        return this.invalid("unknown Messages stop reason")
    }
    this.done = true
    const response = { ...(this.model && { model: this.model }), ...(this.requestId && { requestId: this.requestId }) }
    return [...events, ...this.usageEvent(), { type: "finish", reason, response }]
  }

  private usageEvent(): StreamEvent[] {
    if (!this.usage) return []
    const raw = this.usage
    const cached = count(raw.cache_read_input_tokens)
    const written = count(raw.cache_creation_input_tokens)
    return [{ type: "usage", usage: {
      inputTokens: count(raw.input_tokens) + cached + written, cachedInputTokens: cached,
      ...(typeof raw.cache_creation_input_tokens === "number" && { cacheWriteTokens: written }),
      outputTokens: count(raw.output_tokens),
      // https://platform.claude.com/docs/en/api/typescript/messages#output_tokens_details
      reasoningTokens: isRecord(raw.output_tokens_details) ? count(raw.output_tokens_details.thinking_tokens) : 0,
    } }]
  }

  private invalid(message: string) {
    return this.fail(makeProviderError("provider_internal", message))
  }

  end(): StreamEvent[] {
    return this.fail(makeProviderError("incomplete_stream", "the stream ended before a complete message_stop"))
  }

  fail(error: ProviderError): StreamEvent[] {
    if (this.done) return []
    this.done = true
    return [{ type: "error", error: { ...error, requestId: this.requestId } }]
  }
}

function count(n: unknown): number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0
}
