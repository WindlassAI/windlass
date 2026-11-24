import { expect, spyOn, test } from "bun:test"
import { readFileSync } from "node:fs"
import { text } from "../../src/content.ts"
import { ModelListError } from "../../src/provider/catalog.ts"
import { isProviderProfile, listModels, providerDescriptor, takeProviderKeys } from "../../src/provider/registry.ts"
import { wires } from "../../src/provider/wire/index.ts"
import { encodeRequest } from "../../src/provider/wire/anthropic/encode.ts"
import { encodeRequest as encodeResponses } from "../../src/provider/wire/responses/encode.ts"
import type { FetchFunction } from "../../src/provider/http-stream.ts"
import type { InputItem, ModelRequest } from "../../src/request/request.ts"
import { traceHash } from "../../src/trace/format.ts"
import type { Store } from "../../src/store/store.ts"

const key = "fixture-only-credential"
const baseUrl = "https://relay.invalid"
const accessToken = async () => key
const signal = new AbortController().signal
const descriptor = providerDescriptor("anthropic")
const wire = wires[descriptor.wire]
const model = "claude-sonnet-4-5"
const message = (role: "developer" | "user", value: string): InputItem => ({ type: "message", role, content: text(value) })
const request: ModelRequest = {
  params: { model, reasoningEffort: "high", textVerbosity: null, parallelToolCalls: true, cacheKey: "local" },
  tools: ["list", "read"].map((name) => ({ name, description: name, inputSchema: { type: "object" } })),
  instructions: "Help with code.",
  input: [message("user", "Read a.ts.")],
  toolChoice: "auto",
}
const cached = { cache_control: { type: "ephemeral" } }
const signed = { type: "thinking", thinking: "Check the file.", signature: "test-signature" }
const redacted = { type: "redacted_thinking", data: "test-opaque" }
const fixture = (name: string) => readFileSync(new URL(`../fixtures/anthropic/${name}.sse`, import.meta.url), "utf8")
const toolStream = fixture("thinking-tool")
const textStream = fixture("text")

function streamResponse(sse: string, chunkSize = 8192) {
  const bytes = new TextEncoder().encode(sse)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize))
      controller.close()
    },
  })
  return new Response(stream, { headers: { "request-id": "req_test", "content-type": "text/event-stream" } })
}

function provider(fetch: FetchFunction) {
  return wire.createProvider({ profile: "anthropic", baseUrl, accessToken, fetch, readBlob: () => Uint8Array.of(1, 2, 3) })
}

async function events(fetch: FetchFunction) {
  return Array.fromAsync(provider(fetch).stream(request, signal))
}

function body(req: ModelRequest) {
  return JSON.parse(encodeRequest(req, new Map()).body)
}

test("two Messages requests round-trip the signed and redacted blocks with their tool call", async () => {
  const bodies: string[] = []
  const p = provider(async (url, init) => {
    expect(url).toBe(baseUrl + "/v1/messages")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    const headers = new Headers(init.headers)
    expect(headers.get("x-api-key") === key).toBe(true)
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.get("anthropic-beta")).toBe("interleaved-thinking-2025-05-14")
    bodies.push(String(init.body))
    return streamResponse(bodies.length === 1 ? toolStream : textStream, 1)
  })
  const first = await Array.fromAsync(p.stream(request, signal))
  expect(first.filter((e) => e.type === "reasoning.delta").map((e) => e.text)).toEqual(["Check the ", "file."])
  expect(first.filter((e) => e.type === "tool_call.delta").map((e) => e.input)).toEqual(['{"path":', '"a.ts"}'])
  expect(first.slice(-2)).toEqual([
    { type: "usage", usage: { inputTokens: 60, cachedInputTokens: 30, cacheWriteTokens: 20, outputTokens: 42, reasoningTokens: 12 } },
    { type: "finish", reason: "tool_calls", response: { requestId: "req_test", model: "claude-sonnet-4-5-20250929" } },
  ])
  expect(first.filter((e) => e.type === "reasoning.end").map((e) => e.providerData)).toEqual([
    { provider: "anthropic", model, block: signed },
    { provider: "anthropic", model, block: redacted },
  ])
  const replay = first.flatMap((e): InputItem[] => {
    if (e.type === "reasoning.end") return [{ ...e, type: "reasoning" }]
    if (e.type === "tool_call.end") return [{ ...e, type: "tool_call" }]
    return []
  })
  const turn: ModelRequest = { ...request, input: [
    ...request.input, ...replay, { type: "tool_result", callId: "toolu_test", output: "ok", attachments: [{ mediaType: "image/png", hash: "image" }] },
    message("developer", "Give a short answer."),
  ] }
  const second = await Array.fromAsync(p.stream(turn, signal))
  expect(second).toEqual([
    { type: "text.delta", text: "Caf" }, { type: "text.delta", text: "é." },
    { type: "text.end", text: "Café.", providerData: null },
    { type: "usage", usage: { inputTokens: 1005, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 13, reasoningTokens: 0 } },
    { type: "finish", reason: "stop", response: { requestId: "req_test", model: "claude-opus-4-7" } },
  ])
  const sent = JSON.parse(bodies[1]!)
  expect(sent).toEqual({
    model, stream: true, max_tokens: 64000, thinking: { type: "enabled", budget_tokens: 32000 },
    tools: [{ name: "list", description: "list", input_schema: { type: "object" } }, { name: "read", description: "read", input_schema: { type: "object" }, ...cached }],
    tool_choice: { type: "auto" }, system: [{ type: "text", text: request.instructions, ...cached }],
    messages: [
      { role: "user", content: text("Read a.ts.") },
      { role: "assistant", content: [signed, redacted, { type: "tool_use", id: "toolu_test", name: "read", input: { path: "a.ts" } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_test", content: [{ type: "text", text: "ok" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } }] },
        { type: "text", text: "<system-reminder>\nGive a short answer.\n</system-reminder>", ...cached },
      ] },
    ],
  })
  expect(bodies[1]!.match(/"cache_control"/g)).toHaveLength(3)
  // Export uses the same encoder, hashes the marks separately and elides binary.
  const store = { getBlob: () => ({ bytes: Uint8Array.of(1, 2, 3) }) } as unknown as Store
  const trace = wire.traceEncode(store, turn, descriptor.wireOptions)
  expect(trace.blocks.map((b) => [b.kind, !!b.breakpoint])).toEqual([["tool", false], ["tool", true], ["system", true], ["message", false], ["message", false], ["message", true]])
  expect(trace.blocks.at(-2)?.hash).toBe(traceHash(sent.messages[1]))
  expect(trace.blocks.at(-1)?.elided).toBe(true)
  expect(JSON.stringify(trace)).not.toContain("AQID")
  expect(JSON.stringify(trace)).not.toContain(key)

  const foreignRequest = { ...request, input: [...request.input, ...replay] }
  const switched = body({ ...foreignRequest, params: { ...request.params, model: "claude-sonnet-5-5" } })
  expect(switched.messages.at(-1).content).toEqual([signed, redacted, { ...sent.messages[1].content[2], ...cached }])
  expect(encodeResponses(foreignRequest, new Map()).body).not.toContain("test-signature")
  expect(encodeResponses(foreignRequest, new Map()).body).not.toContain("test-opaque")
  const untrusted = body({ ...request, input: [...request.input, { type: "reasoning", text: "", providerData: { provider: "elsewhere", model, block: signed } }] })
  expect(untrusted.messages).toHaveLength(1)
})

test("native system placement preserves order and keeps all matching results first", () => {
  const params = { ...request.params, model: "claude-opus-4-8", parallelToolCalls: false }
  const req: ModelRequest = { ...request, params, input: [
    message("user", "one"), message("developer", "two"), message("user", "three"), message("developer", "four"),
    { type: "tool_call", callId: "a", name: "read", input: "{}", providerData: null },
    { type: "tool_call", callId: "b", name: "list", input: "{}", providerData: null },
    { type: "tool_result", callId: "a", output: "A", attachments: [] }, message("user", "five"),
    { type: "tool_result", callId: "b", output: "B", attachments: [] },
  ] }
  const before = JSON.stringify(req)
  const actual = body(req)
  expect(actual.messages.map((m: { role: string }) => m.role)).toEqual(["user", "system", "assistant", "user"])
  expect(actual.messages[0].content.map((b: { text: string }) => b.text)).toEqual(["one", "<system-reminder>\ntwo\n</system-reminder>", "three"])
  expect(actual.messages[1].content).toEqual(text("four"))
  expect(actual.messages[3].content).toEqual([
    { type: "tool_result", tool_use_id: "a", content: "A" }, { type: "tool_result", tool_use_id: "b", content: "B" },
    { type: "text", text: "five", ...cached },
  ])
  expect(actual.tool_choice).toEqual({ type: "auto", disable_parallel_tool_use: true })
  expect(actual.thinking).toEqual({ type: "adaptive", display: "summarized" })
  expect(actual.output_config).toEqual({ effort: "high" })
  expect(encodeRequest(req, new Map()).headers["anthropic-beta"]).toBeUndefined()
  expect(JSON.stringify(req)).toBe(before)
})

test("manual effort fits the output limit and the interleaving beta follows tool use", () => {
  for (const [effort, budget] of [["low", 1024], ["medium", 8192], ["high", 16000]] as const) {
    const req = { ...request, params: { ...request.params, model: "claude-opus-4-1-20250805", reasoningEffort: effort } }
    const encoded = body(req)
    expect(encoded.thinking).toEqual({ type: "enabled", budget_tokens: budget })
    expect(budget).toBeLessThanOrEqual(encoded.max_tokens / 2)
    expect(encoded.temperature).toBeUndefined()
    expect(encodeRequest({ ...req, toolChoice: "none" }, new Map()).headers["anthropic-beta"]).toBeUndefined()
    expect(body({ ...req, toolChoice: "none" }).tool_choice).toEqual({ type: "none" })
  }
  const req = { ...request, params: { ...request.params, reasoningEffort: null }, tools: [] }
  expect(body(req).thinking).toBeUndefined()
  expect(body(req).tools).toBeUndefined()
  expect(body(req).tool_choice).toBeUndefined()
  expect(encodeRequest(req, new Map()).headers["anthropic-beta"]).toBeUndefined()
})

test("an unlisted Claude model passes effort through with adaptive thinking", () => {
  const params = { ...request.params, model: "claude-future", reasoningEffort: "new-effort" }
  expect(body({ ...request, params })).toMatchObject({
    max_tokens: 64000,
    thinking: { type: "adaptive", display: "summarized" },
    output_config: { effort: "new-effort" },
  })
})

test("leading instructions keep system priority, and user files use their supported content blocks", () => {
  const blocks = [
    { hash: "txt", mediaType: "text/plain" }, { hash: "pdf", mediaType: "application/pdf" }, { hash: "img", mediaType: "image/webp" },
  ]
  const files: InputItem = { type: "message", role: "user", content: blocks.map((blob) => ({ type: "media", blob })) }
  const req = { ...request, input: [message("developer", "Use the attached files."), files] }
  const blobs = new Map(blocks.map((b) => [b.hash, Uint8Array.of(65)]))
  const encoded = JSON.parse(encodeRequest(req, blobs).body)
  expect(encoded.system).toEqual([{ type: "text", text: request.instructions }, { type: "text", text: "Use the attached files.", ...cached }])
  expect(encoded.messages).toEqual([{ role: "user", content: [
    { type: "document", source: { type: "text", media_type: "text/plain", data: "A" } },
    { type: "document", source: { type: "base64", media_type: "application/pdf", data: "QQ==" } },
    { type: "image", source: { type: "base64", media_type: "image/webp", data: "QQ==" }, ...cached },
  ] }])
  expect(() => encodeRequest(req, new Map())).toThrow("not available")
  expect(encodeRequest({ ...request, params: { ...request.params, model: "claude-haiku-4-5" } }, new Map()).headers["anthropic-beta"]).toBeUndefined()
})

test("stop reasons, incomplete streams and refusal never complete a truncated tool", async () => {
  for (const reason of ["max_tokens", "model_context_window_exceeded", "refusal"]) {
    const out = await events(async () => streamResponse(toolStream.replace('"stop_reason":"tool_use"', `"stop_reason":"${reason}"`)))
    expect(out.some((e) => e.type === "tool_call.end")).toBe(false)
    expect(out.at(-2)?.type).toBe("usage")
    expect(out.at(-1)).toMatchObject(reason === "refusal" ? { type: "error", error: { kind: "content_policy" } } : { type: "finish", reason: "length" })
  }
  const cut = await events(async () => streamResponse(toolStream.split("event: message_stop")[0]!))
  expect(cut.at(-1)).toMatchObject({ type: "error", error: { kind: "incomplete_stream", retryable: true } })
})

test("classifies HTTP and SSE errors and scrubs echoed credentials before reporting them", async () => {
  const log = spyOn(console, "error").mockImplementation(() => {})
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true)
  try {
    for (const [status, type, message, kind, retryable] of [
      [529, "overloaded_error", "Busy", "provider_internal", true], [401, "authentication_error", "Bad key", "auth", false],
      [429, "rate_limit_error", "Slow down", "rate_limit", true], [400, "invalid_request_error", "Your credit balance is too low", "usage_limit", false],
      [429, "insufficient_quota", "Limit", "usage_limit", false], [400, "invalid_request_error", "prompt is too long", "context_overflow", false],
    ] as const) {
      const response = () => Response.json({ error: { type, message: message + " " + key } }, { status, headers: { "retry-after": "2", "request-id": "req_" + key } })
      const out = await events(async () => response())
      expect(out).toMatchObject([{ type: "error", error: { kind, retryable, retryAfterMs: 2000, requestId: "req_[REDACTED]" } }])
      expect(JSON.stringify(out)).not.toContain(key)
    }
    const out = await events(async () => streamResponse(`event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"${key}"}}\n\n`))
    expect(out[0]).toMatchObject({ type: "error", error: { kind: "provider_internal", retryable: true, message: "[REDACTED]", requestId: "req_test" } })
    const failed = await events(async () => { throw new Error(key) })
    expect(JSON.stringify(failed)).not.toContain(key)
    expect(JSON.stringify([...log.mock.calls, ...stderr.mock.calls])).not.toContain(key)
  } finally {
    stderr.mockRestore()
    log.mockRestore()
  }
})

test("registry captures the key, pages the model catalog and exposes model-specific limits and efforts", async () => {
  const env: Record<string, string | undefined> = { ANTHROPIC_API_KEY: key }
  expect(takeProviderKeys(env)).toEqual({ ANTHROPIC_API_KEY: key })
  expect(env).toEqual({})
  expect(isProviderProfile("anthropic")).toBe(true)
  expect(descriptor).toMatchObject({ billing: "metered", auth: { variable: "ANTHROPIC_API_KEY" }, defaults: { model: "claude-sonnet-5-5", titleModel: "claude-haiku-5-5" } })
  const urls: string[] = []
  const models = await listModels({ profile: "anthropic", accessToken, baseUrl, fetch: async (url, init) => {
    urls.push(url)
    expect(init.method).toBe("GET")
    const headers = new Headers(init.headers)
    expect(headers.get("x-api-key") === key).toBe(true)
    expect(headers.get("anthropic-version")).toBe("2023-06-01")
    expect(headers.has("anthropic-beta")).toBe(false)
    return Response.json(urls.length === 1
      ? { data: [{
          id: model, display_name: "Sonnet", max_input_tokens: 180000, max_tokens: 50000,
          capabilities: { effort: { supported: false }, thinking: { supported: true } },
        }], has_more: true, last_id: "page/1" }
      : { data: [
          { id: "claude-opus-4-8" },
          { id: "claude-future", max_tokens: 96000, capabilities: {
            effort: { supported: true, high: { supported: true }, medium: { supported: false }, low: { supported: true } },
          } },
          { id: "claude-opus-5-5", capabilities: { effort: { supported: false }, thinking: { supported: false } } },
        ], has_more: false })
  } })
  expect(urls).toEqual([baseUrl + "/v1/models", baseUrl + "/v1/models?after_id=page%2F1"])
  expect(models[0]).toMatchObject({ slug: model, displayName: "Sonnet", contextWindow: 180000, description: "Maximum output: 50000 tokens", reasoningEfforts: ["low", "medium", "high"] })
  expect(models[1]).toMatchObject({ slug: "claude-opus-4-8", contextWindow: 1000000, description: "Maximum output: 128000 tokens" })
  expect(models[2]).toMatchObject({ slug: "claude-future", description: "Maximum output: 96000 tokens", reasoningEfforts: ["low", "high"] })
  expect(models[3]).toMatchObject({ reasoningEfforts: [], defaultReasoningEffort: null })
  expect(await descriptor.catalog.contextWindow(model, async () => models)).toBe(180000)
  const classified = await listModels({ profile: "anthropic", accessToken, fetch: async () => Response.json({ error: { type: "billing_error", message: key } }, { status: 402 }) }).catch((e: unknown) => e)
  expect(classified).toBeInstanceOf(ModelListError)
  expect(classified).toMatchObject({ error: { kind: "usage_limit", message: "[REDACTED]" } })
})
