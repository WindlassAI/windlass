import type { BlobRef } from "../../../content.ts"
import type { Json } from "../../../json.ts"
import { canonicalJson } from "../../../request/canonical.ts"
import type { InputItem, ModelRequest } from "../../../request/request.ts"
import { isRecord, stringOr } from "../fields.ts"
import { type BlobBytes, type EncodedRequest, MissingBlobError } from "../request.ts"
import { thinkingConfig } from "./thinking.ts"

type Part = Record<string, Json>
type Turn = { role: "user" | "model"; parts: Part[] }
type Result = Extract<InputItem, { type: "tool_result" }>

function media(blob: BlobRef, blobs: BlobBytes): Part {
  const bytes = blobs.get(blob.hash)
  if (bytes === undefined) throw new MissingBlobError(blob)
  return { inlineData: { mimeType: blob.mediaType, data: Buffer.from(bytes).toString("base64") } }
}

function replay(data: Json, model: string) {
  return isRecord(data) && data.provider === "google" && data.model === model ? data : {}
}

function encodeTurns(request: ModelRequest, blobs: BlobBytes): Turn[] {
  const model = request.params.model
  const gemini3OrLater = Number(/^gemini-(\d+)(?:[.-]|$)/.exec(model)?.[1]) >= 3
  const contents: Turn[] = []
  const calls = new Map<string, { name: string; id?: string; order: number }>()
  let results: Result[] = []
  function flushResults() {
    if (results.length === 0) return
    const parts: Part[] = []
    const legacyMedia: Part[] = []
    results.sort((a, b) => calls.get(a.callId)!.order - calls.get(b.callId)!.order)
    for (const result of results) {
      const { name, id } = calls.get(result.callId)!
      const attachments = result.attachments.map((ref) => media(ref, blobs))
      parts.push({
        functionResponse: {
          name,
          ...(id && { id }),
          response: { output: result.output },
          ...(gemini3OrLater && attachments.length > 0 && { parts: attachments }),
        },
      })
      if (!gemini3OrLater) legacyMedia.push(...attachments)
    }
    contents.push({ role: "user", parts })
    if (legacyMedia.length > 0) contents.push({ role: "user", parts: legacyMedia })
    results = []
  }

  for (const item of request.input) {
    if (item.type === "tool_result") {
      if (!calls.has(item.callId)) throw new Error("Gemini function response has no matching function call")
      results.push(item)
      continue
    }
    flushResults()
    if (item.type === "message") {
      const parts = item.content.map((part): Part => part.type === "text" ? { text: part.text } : media(part.blob, blobs))
      if (parts.length) contents.push({ role: "user", parts })
      continue
    }
    const data = replay(item.providerData, model)
    if (item.type === "reasoning" && data.provider !== "google") continue
    const previous = contents.at(-1)
    const turn: Turn = previous?.role === "model" ? previous : { role: "model", parts: [] }
    if (turn !== previous) contents.push(turn)
    const signature = stringOr(data.thoughtSignature)
    if (item.type === "tool_call") {
      const args: unknown = JSON.parse(item.input)
      if (!isRecord(args)) throw new Error("Gemini function call arguments must be an object")
      const id = typeof data.functionId === "string" ? data.functionId : undefined
      calls.set(item.callId, { name: item.name, id, order: calls.size })
      // Gemini validates the first call in each turn, including calls imported from another model.
      const firstCall = gemini3OrLater && !turn.parts.some((part) => part.functionCall)
      const thoughtSignature = signature ?? (firstCall ? "skip_thought_signature_validator" : undefined)
      turn.parts.push({
        functionCall: { name: item.name, args: args as Json, ...(id && { id }) },
        ...(thoughtSignature && { thoughtSignature }),
      })
    } else {
      const thought: Part = item.type === "reasoning" ? { thought: true } : {}
      // A signature may arrive on a final, even empty, text fragment. Keep that boundary.
      const offset = typeof data.signedOffset === "number" ? data.signedOffset : 0
      if (offset > 0) turn.parts.push({ text: item.text.slice(0, offset), ...thought })
      turn.parts.push({ text: item.text.slice(offset), ...thought, ...(signature && { thoughtSignature: signature }) })
    }
  }
  flushResults()
  return contents
}

export function encodeRequest(request: ModelRequest, blobs: BlobBytes): EncodedRequest {
  const thinking = thinkingConfig(request.params.model, request.params.reasoningEffort)
  const declarations = request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema }))
  const body = {
    ...(request.instructions && { systemInstruction: { parts: [{ text: request.instructions }] } }),
    contents: encodeTurns(request, blobs),
    ...(thinking && { generationConfig: { thinkingConfig: thinking } }),
    ...(declarations.length > 0 && {
      tools: [{ functionDeclarations: declarations }],
      toolConfig: { functionCallingConfig: { mode: request.toolChoice === "none" ? "NONE" : "AUTO" } },
    }),
  }
  return { body: canonicalJson(body), headers: { accept: "text/event-stream", "content-type": "application/json" } }
}
