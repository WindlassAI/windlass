import { userAgent } from "../../version.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { apiContextWindow, listPublicModels } from "../openai-catalog.ts"

export const RESPONSES_BASE_URL = "https://api.openai.com/v1"
export const openaiEndpoint = {
  baseUrl: RESPONSES_BASE_URL,
  headers: (token: string) => ({ authorization: `Bearer ${token}`, "user-agent": userAgent() }),
}
export const openaiDefaults = { model: "gpt-6.1-sol", titleModel: "gpt-6-luna", titleEffort: "low" }

const openaiKey = "OPENAI_API_KEY"
export const openai = {
  id: "openai",
  ledgerId: "openai-api-key",
  auth: { kind: "env-key", variable: openaiKey },
  endpoint: { ...openaiEndpoint, redirect: "error", requestIdHeader: "x-request-id" },
  wire: "responses",
  wireOptions: { sessionIdHeader: null, forceReasoning: false },
  defaults: openaiDefaults,
  catalog: { listModels: listPublicModels, contextWindow: apiContextWindow, validateDefault: true },
  billing: "metered",
  authMethod: {
    name: "OpenAI API key",
    description: `Set ${openaiKey} to use the openai provider.`,
    failureText: (message) => message,
    requiredText: (message) => message,
  },
} as const satisfies ProviderDescriptor
