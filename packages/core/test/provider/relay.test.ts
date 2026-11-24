import { expect, test } from "bun:test"
import { ACCESS_TOKEN_FILE_ENV } from "../../src/auth/handed-in.ts"
import { text } from "../../src/content.ts"
import { parseConfigFile } from "../../src/config/schema.ts"
import type { FetchFunction } from "../../src/provider/http-stream.ts"
import { listModels, providerDescriptor } from "../../src/provider/registry.ts"
import { MODEL_ALLOWED_ORIGIN_ENV, MODEL_BASE_URL_ENV, modelRelayUrl, takeModelRelayEnv } from "../../src/provider/relay.ts"
import { wires } from "../../src/provider/wire/index.ts"

test("relay settings come only from the host and are removed from the environment children inherit", () => {
  const settings = { [MODEL_BASE_URL_ENV]: "http://localhost", [MODEL_ALLOWED_ORIGIN_ENV]: "http://localhost" }
  const env = { ...settings, LANG: "C" }
  expect(() => takeModelRelayEnv(env, false)).toThrow("--no-env-file")
  expect(takeModelRelayEnv(env, true)).toEqual(settings)
  expect(env).toEqual({ LANG: "C" })
  expect(takeModelRelayEnv({}, false)).toEqual({})
  for (const key of ["modelBaseUrl", MODEL_BASE_URL_ENV, MODEL_ALLOWED_ORIGIN_ENV])
    expect(() => parseConfigFile(JSON.stringify({ [key]: "http://localhost" }), "project.json", "project")).toThrow("unknown key")
})

test("the ChatGPT relay requires a handed-in token file and accepts loopback or one exact origin", () => {
  const auth = providerDescriptor("chatgpt").auth.kind
  const endpoint = (base: string, origin?: string) =>
    modelRelayUrl({ [MODEL_BASE_URL_ENV]: base, [MODEL_ALLOWED_ORIGIN_ENV]: origin }, auth, "/synthetic/token")
  expect(() => modelRelayUrl({ [MODEL_BASE_URL_ENV]: "http://localhost" }, auth, null)).toThrow(ACCESS_TOKEN_FILE_ENV)
  for (const base of ["http://127.0.0.1:4050/v1", "http://[::1]/v1", "https://localhost/v1"])
    expect(endpoint(base + "/")).toBe(base)
  expect(endpoint("https://relay.example:8443/v1", "https://relay.example:8443")).toBe("https://relay.example:8443/v1")
  for (const base of ["https://relay.example:8443", "http://relay.example", "https://relay.example.evil.test", "file:///tmp", "http://localhost.example", "http://localhost@other.test", "http://u:p@localhost", "http://localhost/?key=value", "http://localhost/#fragment", "invalid"])
    expect(() => endpoint(base, "https://relay.example")).toThrow(MODEL_BASE_URL_ENV)
})

test("API keys require HTTPS outside loopback and pinned private IP addresses", () => {
  const auth = providerDescriptor("anthropic").auth.kind
  const endpoint = (base: string, origin?: string) =>
    modelRelayUrl({ [MODEL_BASE_URL_ENV]: base, [MODEL_ALLOWED_ORIGIN_ENV]: origin }, auth, null)
  for (const host of ["10.0.0.1", "172.31.255.255", "192.168.1.1", "[fd00::1]"]) {
    const origin = "http://" + host
    expect(() => endpoint(origin)).toThrow(MODEL_ALLOWED_ORIGIN_ENV)
    expect(endpoint(origin + "/relay/", origin)).toBe(origin + "/relay")
  }
  for (const host of ["172.32.0.1", "192.168.example", "relay.example", "127.0.0.1.example", "[2001:db8::1]"]) {
    const origin = "http://" + host
    expect(() => endpoint(origin, origin)).toThrow("must use HTTPS")
  }
  expect(endpoint("http://[::1]/relay")).toBe("http://[::1]/relay")
  expect(endpoint("https://relay.example/api", "https://relay.example")).toBe("https://relay.example/api")
})

const routes = [
  { profile: "openai", origin: "https://api.openai.com", prefix: "/v1", list: "/models", post: "/responses", header: "authorization", fixture: "../fixtures/responses/text.sse" },
  { profile: "anthropic", origin: "https://api.anthropic.com", prefix: "", list: "/v1/models", post: "/v1/messages", header: "x-api-key", fixture: "../fixtures/anthropic/text.sse" },
  { profile: "google", origin: "https://generativelanguage.googleapis.com", prefix: "", list: "/v1beta/models", post: "/v1beta/models/gemini-test:streamGenerateContent?alt=sse", header: "x-goog-api-key", fixture: "./fixtures/gemini/answer.sse" },
  { profile: "openrouter", origin: "https://openrouter.ai", prefix: "/api/v1", list: "/models", post: "/chat/completions", header: "authorization", fixture: "../fixtures/chat/tool-continuation.sse" },
] as const

for (const { profile, origin, prefix, list, post, header, fixture } of routes) {
  for (const viaRelay of [false, true]) {
    test(`${profile} sends its catalog and generation requests to ${viaRelay ? "the host relay" : "the provider default"}`, async () => {
      const descriptor = providerDescriptor(profile)
      const relay = "http://localhost:4321/tenant" + prefix
      const base = viaRelay ? relay : origin + prefix
      const baseUrl = modelRelayUrl(viaRelay ? { [MODEL_BASE_URL_ENV]: relay + "///" } : {}, descriptor.auth.kind, null)
      const requests: unknown[] = []
      const fetch: FetchFunction = async (url, init) => {
        requests.push([init.method, url, new Headers(init.headers).get(header), init.redirect])
        if (init.method === "POST")
          return new Response(Bun.file(new URL(fixture, import.meta.url)), { headers: { "content-type": "text/event-stream" } })
        return Response.json(profile === "google" ? { models: [] } : { data: [] })
      }
      const key = "synthetic-placeholder"
      const connection = { profile, baseUrl, accessToken: async () => key, fetch }
      await listModels(connection)
      const provider = wires[descriptor.wire].createProvider({ ...connection, readBlob: () => new Uint8Array() })
      const events = await Array.fromAsync(provider.stream({
        params: { model: profile === "google" ? "gemini-test" : descriptor.defaults.model, reasoningEffort: null, textVerbosity: null, parallelToolCalls: true, cacheKey: "test" },
        tools: [], instructions: "Help.", input: [{ type: "message", role: "user", content: text("Hello") }], toolChoice: "auto",
      }, new AbortController().signal))
      expect(events.at(-1)?.type).toBe("finish")
      const credential = header === "authorization" ? `Bearer ${key}` : key
      const get = ["GET", base + list, credential, "error"]
      expect(requests).toEqual([get, ...(profile === "openrouter" ? [get] : []), ["POST", base + post, credential, "error"]])
    })
  }
}
