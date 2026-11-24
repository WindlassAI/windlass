import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { type FetchFunction } from "../../src/provider/http-stream.ts"
import { listModels, providerDescriptor, takeProviderKeys } from "../../src/provider/registry.ts"
import type { StreamEvent } from "../../src/provider/provider.ts"
import { wires } from "../../src/provider/wire/index.ts"
import { GeminiStreamMapper } from "../../src/provider/wire/gemini/decode.ts"
import { encodeRequest } from "../../src/provider/wire/gemini/encode.ts"
import { geminiError } from "../../src/provider/wire/gemini/error.ts"
import { thinkingConfig } from "../../src/provider/wire/gemini/thinking.ts"
import { encodeRequest as encodeResponses } from "../../src/provider/wire/responses/encode.ts"
import type { ModelRequest } from "../../src/request/request.ts"
import type { Store } from "../../src/store/store.ts"

const model = "gemini-3.5-flash"
const key = "fixture-google-key"
const baseUrl = "https://relay.invalid/google/"
const accessToken = async () => key
const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false }
const pdf = { hash: "test-document", mediaType: "application/pdf" }
const request: ModelRequest = {
  params: { model, reasoningEffort: "low", textVerbosity: null, parallelToolCalls: true, cacheKey: "unused" },
  instructions: "Read the document.", toolChoice: "auto",
  tools: [{ name: "read_pdf", description: "Read a PDF.", inputSchema: schema }],
  input: [{ type: "message", role: "user", content: [{ type: "text", text: "Find the code." }] }],
}
const entry = { name: "models/" + model, displayName: "Flash", supportedGenerationMethods: ["generateContent"], inputTokenLimit: 10000, outputTokenLimit: 2048, thinking: true }
const signal = new AbortController().signal
const readBlob = () => Uint8Array.of(1, 2, 3)
const bodyOf = (req: ModelRequest, blobs = new Map<string, Uint8Array>()) => JSON.parse(encodeRequest(req, blobs).body)
const provider = (fetch: FetchFunction) => wires.gemini.createProvider({ fetch, accessToken, baseUrl, readBlob })

// Response bodies from OpenCode's recorded pdf/gemini-tool-result exchange, 2026-09-24.
const fixture = (name: string) => readFileSync(new URL(`./fixtures/gemini/${name}.sse`, import.meta.url), "utf8")
function splitSse(body: string) {
  const bytes = new TextEncoder().encode(body)
  return new Response(new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
    controller.close()
  } }), { headers: { "content-type": "text/event-stream", "x-request-id": "unusable" } })
}
async function collect(iter: AsyncIterable<StreamEvent>) {
  const result: StreamEvent[] = []
  for await (const event of iter) result.push(event)
  return result
}

test("two recorded turns replay the signed function call, group its result and account for thinking", async () => {
  const bodies: string[] = []
  const adapter = provider(async (url, init) => {
    expect(init.redirect).toBe("error")
    expect(url).not.toContain(key)
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe(key)
    expect(init.method).toBe("POST")
    expect(url).toBe(baseUrl + `v1beta/models/${model}:streamGenerateContent?alt=sse`)
    bodies.push(String(init.body))
    return splitSse(fixture(bodies.length === 1 ? "call" : "answer"))
  })
  expect(adapter.id).toBe(providerDescriptor("google").ledgerId)
  const first = await collect(adapter.stream(request, signal))
  const call = first[0]
  if (call?.type !== "tool_call.end") throw new Error("missing tool call")
  expect(first.slice(1)).toEqual([
    { type: "usage", usage: { inputTokens: 81, cachedInputTokens: 0, outputTokens: 71, reasoningTokens: 53 } },
    { type: "finish", reason: "tool_calls", response: { model } },
  ])
  const turn2: ModelRequest = { ...request, input: [...request.input,
    { ...call, type: "tool_call" },
    { type: "tool_result", callId: call.callId, output: "PDF attached", attachments: [pdf] },
  ] }
  const second = await collect(adapter.stream(turn2, signal))
  const text = second.find((event) => event.type === "text.end")
  expect(text?.text).toBe("ORCHID-7391")
  expect(second.slice(-2)).toEqual([
    { type: "usage", usage: { inputTokens: 696, cachedInputTokens: 0, outputTokens: 61, reasoningTokens: 53 } },
    { type: "finish", reason: "stop", response: { model } },
  ])
  const part = JSON.parse(fixture("call").split("\n")[0]!.slice(6)).candidates[0].content.parts[0]
  expect(part.thoughtSignature.length).toBeGreaterThan(0)
  const expected = {
    systemInstruction: { parts: [{ text: "Read the document." }] },
    contents: [{ role: "user", parts: [{ text: "Find the code." }] }],
    tools: [{ functionDeclarations: [{ name: "read_pdf", description: "Read a PDF.", parametersJsonSchema: schema }] }],
    toolConfig: { functionCallingConfig: { mode: "AUTO" } },
    generationConfig: { thinkingConfig: { includeThoughts: true, thinkingLevel: "LOW" } },
  }
  expect(JSON.parse(bodies[0]!)).toEqual(expected)
  expect(JSON.parse(bodies[1]!)).toEqual({ ...expected, contents: [...expected.contents,
    { role: "model", parts: [part] },
    { role: "user", parts: [{ functionResponse: { name: part.functionCall.name, id: part.functionCall.id,
      response: { output: "PDF attached" }, parts: [{ inlineData: { mimeType: pdf.mediaType, data: "AQID" } }] } }] },
  ] })
  expect(encodeResponses({ ...turn2, input: turn2.input.slice(0, -1) }, new Map()).body).not.toContain(part.thoughtSignature)
  const switched = { ...turn2, params: { ...turn2.params, model: "gemini-3.1-pro-preview" } }
  expect(JSON.stringify(bodyOf(switched, new Map([[pdf.hash, readBlob()]])))).not.toContain(part.thoughtSignature)
  const trace = wires.gemini.traceEncode({ getBlob: () => ({ bytes: readBlob() }) } as unknown as Store, turn2)
  expect(trace.params).toEqual({ generationConfig: expected.generationConfig, toolConfig: expected.toolConfig })
  expect(trace.blocks.map((block) => block.kind)).toEqual(["tool", "system", "message", "message", "message"])
  expect(trace.blocks.at(-1)?.elided).toBe(true)
  expect(JSON.stringify(trace)).not.toContain(key)
  expect(JSON.stringify(trace)).not.toContain("AQID")
  const replay = bodyOf({ ...request, input: [{ type: "assistant_text", text: text!.text, providerData: text!.providerData }] })
  expect(replay.contents[0]?.parts).toEqual([{ text: "ORCHID-7391" }, { text: "", thoughtSignature: expect.any(String) }])
})

test("signed thought summaries stay separate from visible text and foreign provider data", () => {
  const mapper = new GeminiStreamMapper(model)
  const frame = (chunk: unknown) => mapper.frame({ event: "message", data: JSON.stringify(chunk) })
  expect(frame({ candidates: [{ content: { parts: [{ thought: true, text: "Checking " }] } }] })).toEqual([{ type: "reasoning.delta", text: "Checking " }])
  const events = frame({ candidates: [{ content: { parts: [
    { thought: true, text: "records", thoughtSignature: "signed" }, { text: "Answer." },
  ] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 14, cachedContentTokenCount: 9, candidatesTokenCount: 2, thoughtsTokenCount: 3 } })
  expect(events.map((event) => event.type)).toEqual(["reasoning.delta", "reasoning.end", "text.delta", "text.end", "usage", "finish"])
  expect(events.slice(-2)).toEqual([{ type: "usage", usage: { inputTokens: 14, cachedInputTokens: 9, outputTokens: 5, reasoningTokens: 3 } }, { type: "finish", reason: "length" }])
  const thought = events[1]
  if (thought?.type !== "reasoning.end") throw new Error("missing summary")
  expect(thought.text).toBe("Checking records")
  expect(bodyOf({ ...request, input: [
    { ...thought, type: "reasoning" },
    { type: "reasoning", text: "foreign", providerData: { provider: "another", model, thoughtSignature: "foreign" } },
  ] }).contents).toEqual([{ role: "model", parts: [{ text: "Checking ", thought: true }, { text: "records", thought: true, thoughtSignature: "signed" }] }])
  expect(mapper.end()).toEqual([])
})

test("parallel calls without wire IDs keep distinct local IDs and answer in call order", () => {
  const mapper = new GeminiStreamMapper(model)
  const frame = { candidates: [{ content: { parts: [{ functionCall: { name: "search", args: { n: 1 } }, thoughtSignature: "first" },
    { functionCall: { name: "search", args: { n: 2 } } }] }, finishReason: "STOP" }] } as const
  const calls = mapper.frame({ event: "message", data: JSON.stringify(frame) }).filter((event) => event.type === "tool_call.end")
  expect(new Set(calls.map((call) => call.callId)).size).toBe(2)
  const encoded = bodyOf({ ...request, toolChoice: "none", input: [
    ...calls.map((call) => ({ ...call, type: "tool_call" as const })),
    ...calls.map((call, index) => ({ type: "tool_result" as const, callId: call.callId, output: String(index + 1), attachments: [] })).reverse(),
  ] })
  expect(encoded.contents[0]?.parts).toEqual([...frame.candidates[0].content.parts])
  expect(encoded.contents[1]?.parts).toEqual(["1", "2"].map((output) => ({ functionResponse: { name: "search", response: { output } } })))
  expect(encoded.toolConfig?.functionCallingConfig.mode).toBe("NONE")
})

test("budget models use fixed thinking budgets and level models use their supported levels", () => {
  expect(thinkingConfig("gemini-2.5-flash", "off")).toEqual({ includeThoughts: true, thinkingBudget: 0 })
  expect(thinkingConfig("gemini-2.5-flash", "dynamic")).toEqual({ includeThoughts: true, thinkingBudget: -1 })
  expect(thinkingConfig("gemini-2.5-pro", "high")).toEqual({ includeThoughts: true, thinkingBudget: 16384 })
  expect(() => thinkingConfig("gemini-2.5-pro", "off")).toThrow()
  expect(thinkingConfig("gemini-2.0-flash", null)).toBeUndefined()
  expect(thinkingConfig("gemini-3.1-pro-preview", "medium")).toEqual({ includeThoughts: true, thinkingLevel: "MEDIUM" })
  expect(thinkingConfig("gemini-3-pro-preview", null)).toEqual({ includeThoughts: true })
})

test("catalog pages follow opaque tokens, filter by method and expose limits", async () => {
  const paths: string[] = []
  const models = await listModels({ profile: "google", baseUrl, accessToken, fetch: async (url, init) => {
    paths.push(url)
    expect(new Headers(init.headers).get("x-goog-api-key")).toBe(key)
    expect(init.method).toBe("GET")
    const nonChat = ["gemma-3-27b-it", "gemini-2.5-pro-preview-tts", "gemini-3-pro-image-preview", "gemini-live-2.5-flash"]
    return Response.json(paths.length === 1 ? {
      models: [
        { ...entry, supportedGenerationMethods: ["embedContent"] },
        ...nonChat.map((slug) => ({ ...entry, name: "models/" + slug })),
      ],
      nextPageToken: "a+/=",
    } : { models: [entry] })
  } })
  expect(paths).toEqual([baseUrl + "v1beta/models", baseUrl + "v1beta/models?pageToken=a%2B%2F%3D"])
  expect(models).toEqual([{
    slug: model, displayName: "Flash", contextWindow: 10000, supportedInApi: true, visibility: "list",
    reasoningEfforts: ["minimal", "low", "medium", "high"], defaultReasoningEffort: null,
  }])
  const descriptor = providerDescriptor("google")
  expect(descriptor.billing).toBe("metered")
  expect(await descriptor.catalog.contextWindow(model, async () => models)).toBe(10000)
  const env: Record<string, string> = { GEMINI_API_KEY: key }
  expect(takeProviderKeys(env)).toEqual({ GEMINI_API_KEY: key })
  expect(env).toEqual({})
})

test("classifies HTTP and RPC errors including minute and daily quota limits", () => {
  for (const [status, code, message, kind] of [
    [400, "INVALID_ARGUMENT", "invalid request", "invalid_request"],
    [401, "UNAUTHENTICATED", "bad key", "auth"], [403, "PERMISSION_DENIED", "no access", "auth"],
    [429, "RESOURCE_EXHAUSTED", "quota exceeded for requests per minute", "rate_limit"],
    [429, "RESOURCE_EXHAUSTED", "daily quota exceeded", "rate_limit"], [503, "UNAVAILABLE", "busy", "provider_internal"],
  ] as const) {
    expect(geminiError({ code: status, status: code, message })).toMatchObject({ kind, requestId: null, retryable: ["rate_limit", "provider_internal"].includes(kind) })
  }
  const quota = (violation: object) => ({ "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [violation] })
  for (const detail of [quota({ quotaId: "RequestsPerDayPerProject" }), quota({ quotaValue: "0" }), quota({ quotaValue: 0 }), { reason: "BILLING_DISABLED" }]) {
    expect(geminiError({ code: 429, details: [detail] })).toMatchObject({ kind: "usage_limit", retryable: false })
  }
  expect(geminiError({ code: 429, details: [quota({ quotaId: "RequestsPerMinute", quotaValue: "1" })] })).toMatchObject({ kind: "rate_limit" })
  expect(geminiError({ code: 429, details: [{ retryDelay: "0.25s" }] })).toMatchObject({ kind: "rate_limit", retryAfterMs: 250 })
})

test("policy finishes, blocked prompts, and truncated streams are terminal errors", async () => {
  for (const [chunk, kind] of [
    [{ candidates: [{ finishReason: "SAFETY" }] }, "content_policy"], [{ candidates: [{ finishReason: "RECITATION" }] }, "content_policy"],
    [{ promptFeedback: { blockReason: "SAFETY" } }, "content_policy"], [{ candidates: [] }, "incomplete_stream"],
  ] as const) {
    const adapter = provider(async () => splitSse("data: " + JSON.stringify(chunk) + "\n\n"))
    expect(await collect(adapter.stream(request, signal))).toMatchObject([{ type: "error", error: { kind, requestId: null } }])
  }
})

test("scrubs echoed keys in HTTP, SSE, transport and catalog errors", async () => {
  const error = { code: 400, status: "INVALID_ARGUMENT", message: `echo ${key}` }
  for (const response of [
    () => Response.json({ error }, { status: 400 }),
    () => splitSse("data: " + JSON.stringify({ error }) + "\n\n"),
    () => { throw new Error(key) },
  ]) {
    const adapter = provider(async (url, init) => {
      expect(url).not.toContain(key)
      expect(init.body ?? "").not.toContain(key)
      return response()
    })
    const events = await collect(adapter.stream(request, signal))
    expect(events).toMatchObject([{ type: "error", error: { requestId: null } }])
    expect(JSON.stringify(events)).not.toContain(key)
  }
  await expect(listModels({
    profile: "google", baseUrl, accessToken, fetch: async () => Response.json({ error }, { status: 403 }),
  })).rejects.toThrow("Check GEMINI_API_KEY and try again.")
})

test("separate terminal usage frame replaces intermediate counts", async () => {
  const chunks = [
    { candidates: [{ content: { parts: [{ text: "OK" }] } }], usageMetadata: { promptTokenCount: 7 } },
    { candidates: [{ finishReason: "STOP" }] },
    { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 1, thoughtsTokenCount: 4 } },
  ]
  const adapter = provider(async () => splitSse(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\n\n").join("")))
  expect((await collect(adapter.stream(request, signal))).slice(-2)).toEqual([
    { type: "usage", usage: { inputTokens: 7, cachedInputTokens: 0, outputTokens: 5, reasoningTokens: 4 } }, { type: "finish", reason: "stop" },
  ])
})

test("model and provider switches supply a signature on just the first function call of each model turn", () => {
  const call = { type: "tool_call", callId: "one", name: "run", input: "{}", providerData: null } as const
  const functionCall = { name: "run", args: {} }
  const placeholder = { functionCall, thoughtSignature: "skip_thought_signature_validator" }
  const body = bodyOf({ ...request, input: [
    { type: "assistant_text", text: "First", providerData: null },
    { ...call, providerData: { provider: "google", model: "gemini-2.5-flash", thoughtSignature: "old" } },
    { ...call, callId: "two" },
    { type: "tool_result", callId: "one", output: "OK", attachments: [] },
    { type: "tool_result", callId: "two", output: "OK", attachments: [] },
    { ...call, callId: "three", providerData: { provider: "anthropic", model, thoughtSignature: "foreign" } },
  ] })
  expect(body.contents[0].parts).toEqual([{ text: "First" }, placeholder, { functionCall }])
  expect(body.contents[2].parts).toEqual([placeholder])
})

test("a safety finish delivers its final text and usage before the policy error", () => {
  const mapper = new GeminiStreamMapper(model)
  const chunk = {
    candidates: [{ content: { parts: [{ text: "Partial" }] }, finishReason: "SAFETY" }],
    usageMetadata: { candidatesTokenCount: 1 },
  }
  expect(mapper.frame({ event: "message", data: JSON.stringify(chunk) })).toMatchObject([
    { type: "text.delta", text: "Partial" }, { type: "text.end", text: "Partial" },
    { type: "usage", usage: { outputTokens: 1 } }, { type: "error", error: { kind: "content_policy", code: "SAFETY" } },
  ])
  expect(mapper.end()).toEqual([])
})

test("user media is inline and older models get tool media after the function responses", () => {
  const input: ModelRequest["input"] = [
    { type: "message", role: "developer", content: [{ type: "text", text: "Workspace update" }] },
    { type: "message", role: "user", content: [{ type: "media", blob: pdf }] },
    { type: "tool_call", callId: "local", name: "read_pdf", input: "{}", providerData: null },
    { type: "tool_result", callId: "local", output: "Attached", attachments: [pdf] },
  ]
  const body = bodyOf({ ...request, input, params: { ...request.params, model: "gemini-2.5-flash" } }, new Map([[pdf.hash, readBlob()]]))
  const inline = { inlineData: { mimeType: pdf.mediaType, data: "AQID" } }
  expect(body.contents).toEqual([
    { role: "user", parts: [{ text: "Workspace update" }] },
    { role: "user", parts: [inline] },
    { role: "model", parts: [{ functionCall: { name: "read_pdf", args: {} } }] },
    { role: "user", parts: [{ functionResponse: { name: "read_pdf", response: { output: "Attached" } } }] },
    { role: "user", parts: [inline] },
  ])
})
