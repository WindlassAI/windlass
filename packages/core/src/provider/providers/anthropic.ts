import { userAgent } from "../../version.ts"
import { anthropicModel, listAnthropicModels } from "../wire/anthropic/catalog.ts"
import type { ProviderDescriptor } from "../descriptor.ts"

const variable = "ANTHROPIC_API_KEY"
export const anthropic = {
  id: "anthropic",
  ledgerId: "anthropic-api-key",
  wire: "anthropic",
  auth: { kind: "env-key", variable },
  endpoint: {
    baseUrl: "https://api.anthropic.com",
    headers: (key: string) => ({ "x-api-key": key, "anthropic-version": "2023-06-01", "user-agent": userAgent() }),
    redirect: "error",
    requestIdHeader: "request-id",
  },
  catalog: {
    listModels: listAnthropicModels,
    contextWindow: async (id, models) => {
      const entry = (await models()).find((model) => model.slug === id)
      return entry?.contextWindow ?? anthropicModel(id).contextWindow
    },
    validateDefault: true,
  },
  defaults: { model: "claude-sonnet-5-5", titleModel: "claude-haiku-5-5", titleEffort: "low" },
  billing: "metered",
  authMethod: {
    name: "Anthropic API key",
    description: `Set ${variable} to use the anthropic provider.`,
    failureText: (message) => message,
    requiredText: (message) => message,
  },
} as const satisfies ProviderDescriptor
