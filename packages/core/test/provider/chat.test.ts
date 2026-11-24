import { expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { text } from "../../src/content.ts"
import type { ModelRequest, InputItem } from "../../src/request/request.ts"
import { ChatStreamMapper } from "../../src/provider/wire/chat/decode.ts"
import { encodeRequest } from "../../src/provider/wire/chat/encode.ts"
import { type ChatWireOptions } from "../../src/provider/wire/chat/options.ts"
import { openrouter, openRouterOptions } from "../../src/provider/providers/openrouter.ts"
import { listModels, providerDescriptor, takeProviderKeys } from "../../src/provider/registry.ts"
import { wires } from "../../src/provider/wire/index.ts"
import type { FetchFunction } from "../../src/provider/http-stream.ts"
import type { Store } from "../../src/store/store.ts"
import { traceHash } from "../../src/trace/format.ts"

const options = openRouterOptions
const model = openrouter.defaults.model
const request: ModelRequest = {
  params: { model, reasoningEffort: null, textVerbosity: null, parallelToolCalls: true, cacheKey: "session" },
  tools: [{ name: "get_weather", description: "Weather", inputSchema: { type: "object" } }],
  instructions: "Help.",
  input: [{ type: "message", role: "user", content: text("Weather?") }],
  toolChoice: "auto",
}
const key = "fake-openrouter-test-credential"
const ref = { hash: "test-image", mediaType: "image/png" }
const bytes = Uint8Array.of(1, 2, 3)
const blobs = new Map([[ref.hash, bytes]])
const body = (req: ModelRequest, settings: ChatWireOptions = options) =>
  JSON.parse(encodeRequest(req, blobs, settings).body)
const connection = (fetch: FetchFunction) => ({
  profile: "openrouter" as const,
  readBlob: () => bytes,
  accessToken: async () => key,
  fetch,
})
const recordedModel = "anthropic/claude-sonnet-4.6"
const sampleCatalog = [model, recordedModel].map((id) => ({
  id,
  supported_parameters: ["tools"],
  top_provider: { max_completion_tokens: 128_000 },
}))
function provider(fetch: FetchFunction, data: object[] = sampleCatalog) {
  const wire = wires[providerDescriptor("openrouter").wire]
  return wire.createProvider(
    connection((url, init) => {
      if (init.method === "GET") {
        expect(url).toBe("https://openrouter.ai/api/v1/models")
        return Promise.resolve(Response.json({ data }))
      }
      return fetch(url, init)
    }),
  )
}
const events = (fetch: FetchFunction, req = request) =>
  Array.fromAsync(provider(fetch).stream(req, new AbortController().signal))
const frame = (mapper: ChatStreamMapper, value: unknown) =>
  mapper.frame({ event: "message", data: JSON.stringify(value) })
const done = (mapper: ChatStreamMapper) => mapper.frame({ event: "message", data: "[DONE]" })
const choice = (delta: object, finish_reason: string | null = null) => ({
  choices: [{ index: 0, delta, finish_reason }],
})

test("chat request shape, role mapping, tools, image parts and parallel result ordering", () => {
  const req: ModelRequest = {
    ...request,
    toolChoice: "none",
    input: [
      { type: "message", role: "developer", content: text("Workspace.") },
      { type: "message", role: "user", content: [...text("Look"), { type: "media", blob: ref }] },
      { type: "assistant_text", text: "Checking.", providerData: null },
      ...["a", "b"].map(
        (callId): InputItem => ({ type: "tool_call", callId, name: "get_weather", input: "{}", providerData: null }),
      ),
      { type: "tool_result", callId: "a", output: "Paris", attachments: [ref] },
      { type: "tool_result", callId: "b", output: "Tokyo", attachments: [] },
    ],
  }
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }
  expect(body(req)).toEqual({
    model,
    n: 1,
    stream: true,
    stream_options: { include_usage: true },
    tools: [
      { type: "function", function: { name: "get_weather", description: "Weather", parameters: { type: "object" } } },
    ],
    tool_choice: "none",
    parallel_tool_calls: true,
    messages: [
      { role: "system", content: "Help." },
      { role: "system", content: text("Workspace.") },
      { role: "user", content: [...text("Look"), img] },
      {
        role: "assistant",
        content: "Checking.",
        tool_calls: ["a", "b"].map((id) => ({
          id,
          type: "function",
          function: { name: "get_weather", arguments: "{}" },
        })),
      },
      { role: "tool", tool_call_id: "a", content: "Paris" },
      { role: "tool", tool_call_id: "b", content: "Tokyo" },
      { role: "user", content: [...text("Images from tool call a:"), img] },
    ],
  })
  const generic = body(
    { ...req, tools: [] },
    { provider: "other", developerRole: "developer", maxTokens: 100, tokenLimitField: "max_completion_tokens" },
  )
  expect(generic.messages[1].role).toBe("developer")
  expect(generic.max_completion_tokens).toBe(100)
  for (const omitted of ["max_tokens", "tools", "tool_choice", "parallel_tool_calls", "reasoning"])
    expect(generic).not.toHaveProperty(omitted)
  expect(() => body(req, { provider: "text-only", images: false })).toThrow("does not accept images")

  const trace = wires.chat.traceEncode({ getBlob: () => ({ bytes }) } as unknown as Store, req)
  expect(trace.params).not.toHaveProperty("messages")
  expect(trace.params).not.toHaveProperty("max_tokens")
  expect(trace.blocks.map((b) => b.kind)).toEqual([
    "tool",
    "system",
    "system",
    "message",
    "message",
    "message",
    "message",
    "message",
  ])
  expect(trace.blocks[1]?.hash).toBe(traceHash({ role: "system", content: text("Help.") }))
  expect(trace.blocks[3]?.elided).toBe(true)
})

test("neutral effort selects one OpenRouter control and caps the thinking budget below the output limit", () => {
  const reasoning = (model: string, reasoningEffort: string | null, maxTokens = 128_000) =>
    body({ ...request, params: { ...request.params, model, reasoningEffort } }, { ...options, maxTokens }).reasoning
  expect(reasoning(model, null)).toBeUndefined()
  expect(reasoning(model, "high")).toEqual({ effort: "high" })
  expect(reasoning(model, "none")).toEqual({ enabled: false })
  expect(reasoning(model, "on")).toEqual({ enabled: true })
  expect(reasoning("google/gemini-2.5-pro", "high", 1100)).toEqual({ max_tokens: 1024 })
  expect(reasoning("anthropic/claude-sonnet-4.5", "medium", 4096)).toEqual({ max_tokens: 2048 })
  expect(() => reasoning("anthropic/claude-sonnet-4.5", "high", 1024)).toThrow()
})

test("finish waits for late usage and [DONE], interleaved calls keep their choice, index and verbatim arguments", () => {
  const mapper = new ChatStreamMapper("req", model, options)
  const tools = (tool_calls: object[]) => frame(mapper, choice({ tool_calls }))
  const fragment = (index: number, args: string, id?: string, name?: string) => ({
    index,
    id,
    function: { name, arguments: args },
  })
  frame(mapper, {
    choices: [{ index: 1, delta: { content: "other", tool_calls: [fragment(0, "wrong")] }, finish_reason: "length" }],
  })
  tools([fragment(1, "{"), fragment(0, '{"a":', "one", "first")])
  expect(tools([fragment(1, '"b":', "two", "second")])).toEqual([
    { type: "tool_call.delta", callId: "two", name: "second", input: '{"b":' },
  ])
  tools([fragment(0, " 1}"), fragment(1, " 2}")])
  expect(frame(mapper, choice({}, "tool_calls"))).toEqual([])
  const usageChunk = frame(mapper, {
    choices: [],
    usage: {
      prompt_tokens: 73,
      completion_tokens: 21,
      prompt_tokens_details: { cached_tokens: 15 },
      completion_tokens_details: { reasoning_tokens: 5 },
    },
  })
  expect(mapper.done).toBe(false)
  expect([...usageChunk, ...done(mapper)]).toEqual([
    { type: "usage", usage: { inputTokens: 73, cachedInputTokens: 15, outputTokens: 21, reasoningTokens: 5 } },
    { type: "tool_call.end", callId: "one", name: "first", input: '{"a": 1}', providerData: null },
    { type: "tool_call.end", callId: "two", name: "second", input: '{"b": 2}', providerData: null },
    { type: "finish", reason: "tool_calls", response: { requestId: "req" } },
  ])
  expect(mapper.end()).toEqual([])
})

test("a conflicting tool identity fails before any call is committed", () => {
  const mapper = new ChatStreamMapper(null, model, options)
  const call = (id: string) => choice({ tool_calls: [{ index: 0, id, function: { name: "act", arguments: "{}" } }] })
  frame(mapper, call("a"))
  expect(frame(mapper, call("b"))).toMatchObject([{ type: "error", error: { kind: "provider_internal" } }])
  expect(done(mapper)).toEqual([])
})

test("truncation, filtering and premature EOF never complete a pending tool", () => {
  for (const reason of ["length", "content_filter", "stop", null]) {
    const mapper = new ChatStreamMapper(null, model, options)
    frame(mapper, choice({ tool_calls: [{ index: 0, id: "call", function: { name: "act", arguments: "{" } }] }, reason))
    const result = reason === "stop" ? mapper.end() : done(mapper)
    expect(result.filter((e) => e.type === "tool_call.end")).toBeEmpty()
    if (reason === "length") expect(result.at(-1)).toEqual({ type: "finish", reason })
    else
      expect(result.at(-1)).toMatchObject({
        type: "error",
        error: { kind: reason === "content_filter" ? "content_policy" : "incomplete_stream" },
      })
  }
})

// Response bodies from the OpenCode openrouter-reasoning-tool-loop recording (2026-07-18).
const fixture = (name: string) => Bun.file(join(import.meta.dir, "../fixtures/chat", name + ".sse")).text()
function splitStream(sse: string) {
  const bytes = new TextEncoder().encode(sse)
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream", "x-request-id": "recorded" } },
  )
}

test("a recorded compatible endpoint's parallel tool calls and duplicated usage survive split bytes", async () => {
  const sse = await fixture("parallel-tool-calls")
  const seen = await events(async () => splitStream(sse))
  expect(seen.filter((e) => e.type === "tool_call.end").map((e) => [e.callId, e.name, e.input])).toEqual([
    ["ymftvsqar", "lookup_weather", '{"city":"Paris"}'],
    ["968mxnfem", "lookup_weather", '{"city":"London"}'],
  ])
  expect(seen.filter((e) => e.type === "usage")).toHaveLength(1)
  expect(seen.at(-1)).toMatchObject({ type: "finish", reason: "tool_calls" })
})

test("two recorded turns replay the signed thinking block with the tool call", async () => {
  const first = await fixture("signed-tool-call")
  const second = await fixture("tool-continuation")
  const requests: ReturnType<typeof body>[] = []
  const client = provider(async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("error")
    const headers = new Headers(init.headers)
    expect(headers.get("authorization") === "Bearer " + key).toBe(true)
    expect(headers.get("http-referer")).toBe("https://github.com/WindlassAI/windlass")
    expect(headers.get("x-title")).toBe("Windlass")
    requests.push(JSON.parse(String(init.body)))
    return splitStream(requests.length === 1 ? first : second)
  })
  const run = (req: ModelRequest) => Array.fromAsync(client.stream(req, new AbortController().signal))
  const recordedRequest = { ...request, params: { ...request.params, model: recordedModel } }
  const one = await run(recordedRequest)
  const history: InputItem[] = [...recordedRequest.input]
  for (const e of one) {
    if (e.type === "reasoning.end") history.push({ ...e, type: "reasoning" })
    if (e.type === "text.end") history.push({ ...e, type: "assistant_text" })
    if (e.type === "tool_call.end")
      history.push(
        { ...e, type: "tool_call" },
        { type: "tool_result", callId: e.callId, output: "sunny", attachments: [] },
      )
  }
  expect(one.at(-1)).toMatchObject({
    type: "finish",
    reason: "tool_calls",
    response: { requestId: "recorded", model: recordedModel },
  })
  expect(one.find((e) => e.type === "usage")).toMatchObject({
    usage: { inputTokens: 623, outputTokens: 95, reasoningTokens: 19, cacheWriteTokens: 0 },
  })
  const two = await run({ ...recordedRequest, input: history })
  const assistant = requests[1].messages.at(-2)
  const summary = "The user wants to know the weather in Paris. I'll use the get_weather tool."
  const signature = JSON.parse(
    first
      .split("\n")
      .find((line) => line.includes('"signature":'))!
      .slice(6),
  ).choices[0].delta.reasoning_details[0].signature
  expect(assistant.reasoning_details).toEqual([
    { type: "reasoning.text", format: "anthropic-claude-v1", index: 0, text: summary, signature },
  ])
  expect(assistant.tool_calls[0].function).toEqual({ name: "get_weather", arguments: '{"city": "Paris"}' })
  expect(one.find((e) => e.type === "reasoning.end")).toMatchObject({ text: summary })
  expect(two.find((e) => e.type === "text.end")).toMatchObject({ text: "Paris is sunny." })
  expect(two.at(-1)).toMatchObject({ type: "finish", reason: "stop" })
})

test("opaque blocks replay intact, only for their originating provider and model family", () => {
  const details = [
    { type: "reasoning.encrypted", id: "x", data: "opaque/+= ", format: "unknown", extra: [null, 2] },
    { type: "future", signature: "signed", data: { tag: true } },
  ]
  const mapper = new ChatStreamMapper(null, model, options)
  expect(frame(mapper, choice({ reasoning_details: details }, "stop"))).toEqual([])
  const ended = done(mapper).find((e) => e.type === "reasoning.end")!
  expect(ended.text).toBe("")
  const req: ModelRequest = {
    ...request,
    input: [
      { ...ended, type: "reasoning" },
      { type: "assistant_text", text: "ok", providerData: null },
    ],
  }
  expect(body(req).messages.at(-1).reasoning_details).toEqual(details)
  expect(
    body({ ...req, params: { ...req.params, model: model + ":nitro" } }).messages.at(-1).reasoning_details,
  ).toEqual(details)
  expect(
    body({ ...req, params: { ...req.params, model: "google/gemini-2.5-pro" } }).messages.at(-1),
  ).not.toHaveProperty("reasoning_details")
  expect(body(req, { ...options, provider: "other" }).messages.at(-1)).not.toHaveProperty("reasoning_details")
})

test("generic reasoning_content is opt-in on both decode and replay", () => {
  for (const enabled of [false, true]) {
    const generic: ChatWireOptions = { provider: "local", ...(enabled && { reasoningField: "reasoning_content" }) }
    const mapper = new ChatStreamMapper(null, model, generic)
    const seen = [...frame(mapper, choice({ reasoning_content: "thinking", content: "hi" }, "stop")), ...done(mapper)]
    const end = seen.find((e) => e.type === "reasoning.end")
    expect(Boolean(end)).toBe(enabled)
    if (end) {
      const req: ModelRequest = {
        ...request,
        input: [
          { ...end, type: "reasoning" },
          { type: "assistant_text", text: "hi", providerData: null },
        ],
      }
      expect(body(req, generic).messages.at(-1).reasoning_content).toBe("thinking")
      expect(body(req, { provider: "local" }).messages.at(-1)).not.toHaveProperty("reasoning_content")
    }
  }
})

test("JSON and SSE error envelopes on HTTP 200 override finish and redact credential echoes", async () => {
  using logs = spyOn(console, "log").mockImplementation(() => {})
  using warnings = spyOn(console, "warn").mockImplementation(() => {})
  using errors = spyOn(console, "error").mockImplementation(() => {})
  const error = { error: { code: 429, message: "rate limited " + key } }
  for (const response of [
    Response.json(error, { headers: { "x-request-id": "id-" + key } }),
    new Response(
      "data: " + JSON.stringify(choice({}, "stop")) + "\n\ndata: " + JSON.stringify(error) + "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream", "x-request-id": "id-" + key } },
    ),
  ]) {
    const seen = await events(async () => response)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: "error", error: { kind: "rate_limit", requestId: "id-[REDACTED]" } })
    expect(JSON.stringify(seen)).not.toContain(key)
  }
  const failure = await events(async () => {
    throw new Error(key)
  })
  expect(failure[0]).toMatchObject({ type: "error", error: { kind: "transport" } })
  expect(JSON.stringify(failure)).not.toContain(key)
  const env: Record<string, string | undefined> = { OPENROUTER_API_KEY: key }
  expect(takeProviderKeys(env)).toEqual({ OPENROUTER_API_KEY: key })
  expect(env).toEqual({})
  expect(JSON.stringify([logs.mock.calls, warnings.mock.calls, errors.mock.calls])).not.toContain(key)
})

test("Responses and Anthropic still parse a 200 JSON body as a stream", async () => {
  const fetch = async () => Response.json({ error: { code: 429, message: "fixture rate limit" } })
  for (const profile of ["openai", "anthropic"] as const) {
    const descriptor = providerDescriptor(profile)
    const client = wires[descriptor.wire].createProvider({ ...connection(fetch), profile })
    const seen = await Array.fromAsync(client.stream(request, new AbortController().signal))
    expect(seen.at(-1)).toMatchObject({ type: "error", error: { kind: "incomplete_stream" } })
  }
})

test("catalog filters tools, retains model capabilities and pricing, and gates image requests", async () => {
  const data = [
    { id: "no-tools", supported_parameters: ["reasoning"] },
    {
      id: model,
      name: "Sonnet",
      context_length: 200000,
      supported_parameters: ["tools", "reasoning"],
      pricing: { prompt: "0.000003" },
      architecture: { input_modalities: ["text", "image"] },
      reasoning: { mandatory: true, supported_efforts: ["low", "high"], default_effort: "low" },
    },
    { id: "text-only", supported_parameters: ["tools"], architecture: { input_modalities: ["text"] } },
  ]
  const fetch: FetchFunction = async (url, init) => {
    expect(url).toBe("https://openrouter.ai/api/v1/models")
    expect(init.method).toBe("GET")
    return Response.json({ data })
  }
  const models = await listModels(connection(fetch))
  expect(models.map((m) => m.slug)).toEqual([model, "text-only"])
  expect(models[0]).toMatchObject({
    displayName: "Sonnet",
    contextWindow: 200000,
    pricing: { prompt: "0.000003" },
    reasoningEfforts: ["low", "high"],
    defaultReasoningEffort: "low",
  })
  expect(await openrouter.catalog.contextWindow(model, async () => models)).toBe(200000)

  const client = provider(
    async () => splitStream("data: " + JSON.stringify(choice({}, "stop")) + "\n\ndata: [DONE]\n\n"),
    data,
  )
  const req: ModelRequest = {
    ...request,
    input: [{ type: "message", role: "user", content: [{ type: "media", blob: ref }] }],
  }
  const run = (model: string) =>
    Array.fromAsync(client.stream({ ...req, params: { ...req.params, model } }, new AbortController().signal))
  expect((await run(model)).at(-1)).toMatchObject({ type: "finish" })
  expect((await run("text-only"))[0]).toMatchObject({ type: "error", error: { kind: "invalid_request" } })
  const failure = await listModels(connection(async () => Response.json({ error: { code: 402, message: key } }))).catch(
    (e: Error) => e,
  )
  expect(failure).toMatchObject({ error: { kind: "usage_limit" } })
  expect(JSON.stringify(failure)).not.toContain(key)
})

test("stream requests use each model's catalog output limit and bound missing limits by context", async () => {
  const data = [
    { id: model, context_length: 1_000_000, top_provider: { max_completion_tokens: 128_000 } },
    { id: openrouter.defaults.titleModel, context_length: 1_000_000, top_provider: { max_completion_tokens: 32_000 } },
    { id: "small-context", context_length: 4096 },
    { id: "large-context", context_length: 500_000, top_provider: { max_completion_tokens: null } },
    { id: "no-limits" },
    { id: "oversized-output", context_length: 12_000, top_provider: { max_completion_tokens: 16_000 } },
  ].map((entry) => ({ ...entry, supported_parameters: ["tools"] }))
  const limits: number[] = []
  let catalogReads = 0
  const client = wires.chat.createProvider(
    connection(async (_url, init) => {
      if (init.method === "GET") {
        catalogReads++
        return Response.json({ data })
      }
      const sent = JSON.parse(String(init.body))
      limits.push(sent.max_tokens)
      return splitStream("data: " + JSON.stringify(choice({}, "stop")) + "\n\ndata: [DONE]\n\n")
    }),
  )
  for (const { id } of data) {
    const req = { ...request, params: { ...request.params, model: id } }
    const seen = await Array.fromAsync(client.stream(req, new AbortController().signal))
    expect(seen.at(-1)).toMatchObject({ type: "finish" })
  }
  expect(catalogReads).toBe(1)
  expect(limits).toEqual([128_000, 32_000, 4096, 65_536, 65_536, 12_000])
  expect(openrouter.catalog.validateDefault).toBe(true)
})
