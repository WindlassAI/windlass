import { brand } from "../../brand.ts"
import type { Json } from "../../json.ts"
import { userAgent } from "../../version.ts"
import { catalogToken, modelPage, ModelListError, type CatalogOptions, type ModelInfo } from "../catalog.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { makeProviderError } from "../error.ts"
import { safeError } from "../http-stream.ts"
import { chatError, httpError } from "../wire/chat/error.ts"
import type { ChatWireOptions } from "../wire/chat/options.ts"
import { isRecord, stringOr } from "../wire/fields.ts"

const effortFraction: Readonly<Record<string, number>> = {
  minimal: 0.1,
  low: 0.2,
  medium: 0.5,
  high: 0.8,
  xhigh: 0.95,
}

function normalizeEffort(effort: string): string {
  return effort === "max" ? "xhigh" : effort
}

function reasoning(effort: string, supportsBudget: boolean, limit?: number): Json {
  if (effort === "none" || effort === "off") return { enabled: false }
  if (effort === "enabled" || effort === "on") return { enabled: true }
  effort = normalizeEffort(effort)
  if (!supportsBudget) return { effort }
  if (limit === undefined) return { enabled: true }
  if (!Object.hasOwn(effortFraction, effort)) throw new Error("unknown OpenRouter reasoning effort")
  if (limit <= 1024) throw new Error("reasoning needs an output limit above 1024 tokens")
  const budget = Math.floor(limit * effortFraction[effort]!)
  return { max_tokens: Math.min(limit - 1, Math.max(1024, budget)) }
}

interface RouterModel extends ModelInfo {
  readonly maxTokens?: number
  readonly supportsBudget: boolean
  readonly inputModalities: string[]
}

export function openRouterOptions(model?: RouterModel): ChatWireOptions {
  return {
    provider: "openrouter",
    maxTokens: model?.maxTokens,
    images: model?.inputModalities.includes("image"),
    openRouterReasoning: (effort) => reasoning(effort, model?.supportsBudget ?? false, model?.maxTokens),
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function reasoningEfforts(parameters: string[], capabilities: Record<string, unknown> | null): string[] {
  if (!capabilities) return parameters.includes("reasoning") ? Object.keys(effortFraction) : []
  let efforts: string[]
  if (Array.isArray(capabilities.supported_efforts)) {
    efforts = [...new Set(strings(capabilities.supported_efforts).map(normalizeEffort))]
  } else if (capabilities.supported_efforts === null || capabilities.supports_max_tokens) {
    efforts = Object.keys(effortFraction)
  } else efforts = ["on"]
  if (!capabilities.mandatory && !efforts.includes("none")) efforts.push("none")
  return efforts
}

async function listModels(descriptor: ProviderDescriptor, options: CatalogOptions): Promise<RouterModel[]> {
  const token = await catalogToken(options)
  const { parsed, status } = await modelPage(descriptor, options, "/models", token, httpError)
  if (isRecord(parsed) && isRecord(parsed.error)) {
    throw new ModelListError(safeError(chatError(parsed.error, null), descriptor.auth, token))
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new ModelListError(
      makeProviderError("provider_internal", "expected a model list with a data array", { status }),
    )
  }
  const models: RouterModel[] = []
  for (const entry of parsed.data) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue
    const supportedParameters = strings(entry.supported_parameters)
    if (!supportedParameters.includes("tools")) continue
    const capabilities = isRecord(entry.reasoning) ? entry.reasoning : null
    const top = isRecord(entry.top_provider) ? entry.top_provider : null
    const contextWindow = tokenCount(entry.context_length) ?? tokenCount(top?.context_length)
    const defaultEffort = stringOr(capabilities?.default_effort)
    models.push({
      slug: entry.id,
      displayName: stringOr(entry.name) ?? entry.id,
      visibility: "list",
      supportedInApi: true,
      ...(typeof entry.description === "string" && { description: entry.description }),
      contextWindow,
      maxTokens: tokenCount(top?.max_completion_tokens) ?? undefined,
      reasoningEfforts: reasoningEfforts(supportedParameters, capabilities),
      defaultReasoningEffort: defaultEffort && normalizeEffort(defaultEffort),
      supportsBudget: capabilities?.supports_max_tokens === true,
      inputModalities: isRecord(entry.architecture) ? strings(entry.architecture.input_modalities) : [],
    })
  }
  return models
}

export const openrouter = {
  id: "openrouter",
  ledgerId: "openrouter",
  wire: "chat",
  auth: { kind: "env-key", variable: "OPENROUTER_API_KEY" },
  endpoint: {
    baseUrl: "https://openrouter.ai/api/v1",
    redirect: "error",
    requestIdHeader: "x-request-id",
    headers: (token: string) => ({
      authorization: `Bearer ${token}`,
      "user-agent": userAgent(),
      "HTTP-Referer": `https://github.com/${brand.repository}`,
      "X-Title": brand.name,
    }),
  },
  defaults: {
    model: "anthropic/claude-sonnet-5.5",
    titleModel: "anthropic/claude-haiku-5.5",
    titleEffort: null,
  },
  catalog: {
    listModels,
    validateDefault: true,
    contextWindow: async (model, models) =>
      (await models()).find((entry) => entry.slug === model)?.contextWindow ?? null,
  },
  billing: "metered",
  authMethod: {
    name: "OpenRouter API key",
    description: "Set OPENROUTER_API_KEY to use the openrouter provider.",
    failureText: (message) => message,
    requiredText: (message) => message,
  },
} as const satisfies ProviderDescriptor
