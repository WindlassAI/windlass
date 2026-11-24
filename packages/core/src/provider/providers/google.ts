import { userAgent } from "../../version.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { listGoogleModels } from "../wire/gemini/catalog.ts"

export const google = {
  id: "google",
  ledgerId: "google-api-key",
  auth: { kind: "env-key", variable: "GEMINI_API_KEY" },
  endpoint: {
    baseUrl: "https://generativelanguage.googleapis.com",
    headers: (key: string) => ({ "x-goog-api-key": key, "user-agent": userAgent() }),
    redirect: "error",
    requestIdHeader: null,
  },
  wire: "gemini",
  defaults: { model: "gemini-3.5-flash", titleModel: "gemini-3.1-flash-lite", titleEffort: "low" },
  billing: "metered",
  catalog: {
    listModels: listGoogleModels,
    contextWindow: async (model, models) => (await models()).find((entry) => entry.slug === model)?.contextWindow ?? null,
    validateDefault: true,
  },
  authMethod: {
    name: "Google Gemini API key",
    description: "Set GEMINI_API_KEY to use the google provider.",
    failureText: (message) => message,
    requiredText: (message) => message,
  },
} as const satisfies ProviderDescriptor
