import { randomUUID } from "node:crypto"
import type { Json } from "../../../json.ts"
import { makeProviderError, type ProviderError } from "../../error.ts"
import type { FinishReason, StreamEvent } from "../../provider.ts"
import type { SseEvent } from "../../sse.ts"
import type { Usage } from "../../usage.ts"
import { isRecord, parseJson, stringOr } from "../fields.ts"
import { geminiError } from "./error.ts"

const policy = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION"])

function count(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

export class GeminiStreamMapper {
  done = false
  private finishReason?: FinishReason
  private hasCalls = false
  private usage?: Usage
  private modelVersion?: string
  private text?: { kind: "text" | "reasoning"; value: string }
  constructor(private readonly model: string) {}

  frame(frame: SseEvent): StreamEvent[] {
    if (this.done) return []
    const chunk = parseJson(frame.data)
    if (!isRecord(chunk)) return this.fail(makeProviderError("provider_internal", "invalid Gemini SSE frame"))
    if (chunk.error) return this.fail(geminiError(chunk.error))
    if (typeof chunk.modelVersion === "string") this.modelVersion = chunk.modelVersion
    const usage = chunk.usageMetadata
    if (isRecord(usage)) this.usage = {
      inputTokens: count(usage.promptTokenCount),
      cachedInputTokens: count(usage.cachedContentTokenCount),
      reasoningTokens: count(usage.thoughtsTokenCount),
      outputTokens: count(usage.candidatesTokenCount) + count(usage.thoughtsTokenCount),
    }
    // Some streams report usage in a separate frame after the finish reason.
    if (this.finishReason) return isRecord(usage) ? this.finish() : []
    const blocked = isRecord(chunk.promptFeedback) ? stringOr(chunk.promptFeedback.blockReason) : null
    if (blocked && blocked !== "BLOCK_REASON_UNSPECIFIED")
      return this.fail(makeProviderError("content_policy", "Gemini blocked the prompt", { code: blocked }))

    const candidate = Array.isArray(chunk.candidates) ? chunk.candidates[0] : undefined
    if (!isRecord(candidate)) return []
    const events: StreamEvent[] = []
    const parts = isRecord(candidate.content) ? candidate.content.parts : undefined
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const error = this.readPart(part, events)
        if (error) return [...events, ...this.fail(error)]
      }
    }

    const reason = candidate.finishReason
    if (!reason || reason === "FINISH_REASON_UNSPECIFIED") return events
    if (typeof reason === "string" && policy.has(reason))
      return [...events, ...this.fail(makeProviderError("content_policy", `Gemini stopped for ${reason}`, { code: reason }))]
    if (reason !== "STOP" && reason !== "MAX_TOKENS")
      return [...events, ...this.fail(makeProviderError("provider_internal", "unexpected Gemini finish reason", { code: String(reason) }))]
    this.flush(events)
    this.finishReason = reason === "MAX_TOKENS" ? "length" : this.hasCalls ? "tool_calls" : "stop"
    if (isRecord(usage)) events.push(...this.finish())
    return events
  }

  private readPart(part: unknown, events: StreamEvent[]): ProviderError | undefined {
    if (!isRecord(part)) return makeProviderError("provider_internal", "invalid Gemini part")
    const thoughtSignature = stringOr(part.thoughtSignature)
    if (isRecord(part.functionCall)) {
      this.flush(events)
      const { name, args } = part.functionCall
      if (typeof name !== "string" || !name || (args !== undefined && !isRecord(args)))
        return makeProviderError("provider_internal", "invalid Gemini function call")
      const id = stringOr(part.functionCall.id)
      this.hasCalls = true
      events.push({
        type: "tool_call.end",
        callId: id ?? randomUUID(),
        name,
        input: JSON.stringify(args ?? {}),
        providerData: this.data({
          ...(id && { functionId: id }),
          ...(thoughtSignature && { thoughtSignature }),
        }),
      })
    } else if (typeof part.text === "string" || thoughtSignature) {
      const kind = part.thought === true ? "reasoning" : "text"
      if (this.text?.kind !== kind) this.flush(events)
      const fragment = typeof part.text === "string" ? part.text : ""
      if (!fragment && !thoughtSignature) return
      this.text ??= { kind, value: "" }
      const signedOffset = this.text.value.length
      this.text.value += fragment
      if (fragment) events.push({ type: kind === "text" ? "text.delta" : "reasoning.delta", text: fragment })
      if (thoughtSignature) this.flush(events, this.data({ thoughtSignature, signedOffset }))
    }
  }

  private data(fields: Record<string, Json> = {}) {
    return { provider: "google", model: this.model, ...fields }
  }

  private flush(events: StreamEvent[], providerData?: Json) {
    if (!this.text) return
    const { kind, value } = this.text
    events.push({
      type: kind === "text" ? "text.end" : "reasoning.end",
      text: value,
      providerData: providerData ?? (kind === "reasoning" ? this.data() : null),
    })
    this.text = undefined
  }

  private terminal(event: StreamEvent): StreamEvent[] {
    this.done = true
    return this.usage ? [{ type: "usage", usage: this.usage }, event] : [event]
  }

  fail(error: ProviderError): StreamEvent[] {
    if (this.done) return []
    const events: StreamEvent[] = []
    this.flush(events)
    return [...events, ...this.terminal({ type: "error", error })]
  }

  private finish(): StreamEvent[] {
    return this.terminal({
      type: "finish", reason: this.finishReason!,
      ...(this.modelVersion && { response: { model: this.modelVersion } }),
    })
  }

  end(): StreamEvent[] {
    if (!this.done && this.finishReason) return this.finish()
    return this.fail(makeProviderError("incomplete_stream", "Gemini stream ended before a finish reason"))
  }
}
