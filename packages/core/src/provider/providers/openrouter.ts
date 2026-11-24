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
  max: 0.95,
}

// These generations use thinking budgets. Later adaptive models use effort.
const budgetModel = /^(?:anthropic\/claude-(?:3\.7|(?:opus|sonnet|haiku)-4(?:\.[015])?(?:$|[-:]))|google\/gemini-2\.5)/

function reasoning(model: string, effort: string, limit?: number): Json | undefined {
  if (effort === "none" || effort === "off") return { enabled: false }
  if (effort === "enabled" || effort === "on") return { enabled: true }
  if (!Object.hasOwn(effortFraction, effort)) throw new Error("unknown OpenRouter reasoning effort")
  if (!budgetModel.test(model)) return { effort }
  // Offline traces have no catalog snapshot from which to reconstruct this budget.
  if (limit === undefined) return undefined
  if (limit <= 1024) throw new Error("reasoning needs an output limit above 1024 tokens")
  const budget = Math.floor(limit * effortFraction[effort]!)
  return { max_tokens: Math.min(limit - 1, Math.max(1024, budget)) }
}

export const openRouterOptions = {
  provider: "openrouter",
  openRouterReasoning: reasoning,
} satisfies ChatWireOptions

export const fallbackOutputTokens = 65_536

interface RouterModel extends ModelInfo {
  readonly maxTokens: number
  readonly supportedParameters: string[]
  readonly inputModalities: string[]
  readonly pricing?: Readonly<Record<string, string>>
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
  if (Array.isArray(capabilities.supported_efforts)) efforts = strings(capabilities.supported_efforts)
  else if (capabilities.supported_efforts === null || capabilities.supports_max_tokens)
    efforts = Object.keys(effortFraction)
  else efforts = ["on"]
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
    const limit = tokenCount(top?.max_completion_tokens) ?? fallbackOutputTokens
    const pricing = isRecord(entry.pricing)
      ? Object.fromEntries(
          Object.entries(entry.pricing).filter((pair): pair is [string, string] => typeof pair[1] === "string"),
        )
      : undefined
    models.push({
      slug: entry.id,
      displayName: stringOr(entry.name) ?? entry.id,
      visibility: "list",
      supportedInApi: true,
      ...(typeof entry.description === "string" && { description: entry.description }),
      contextWindow,
      maxTokens: Math.min(limit, contextWindow ?? limit),
      reasoningEfforts: reasoningEfforts(supportedParameters, capabilities),
      defaultReasoningEffort: stringOr(capabilities?.default_effort),
      supportedParameters,
      inputModalities: isRecord(entry.architecture) ? strings(entry.architecture.input_modalities) : [],
      ...(pricing && { pricing }),
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
