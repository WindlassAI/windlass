import { catalogToken, modelPage, type CatalogOptions, type ModelInfo, ModelListError } from "./catalog.ts"
import { makeProviderError } from "./error.ts"
import type { ProviderDescriptor } from "./descriptor.ts"
import { httpError } from "./wire/responses/error.ts"
import { isRecord, stringOr } from "./wire/fields.ts"

/** The public catalog lacks windows. Use the ChatGPT catalog windows for known families. */
export function apiContextWindow(model: string): number {
  if (/^gpt-6\.1(?:-|$)/.test(model)) return 500_000
  if (/^gpt-6(?:-|$)/.test(model)) return 272_000
  return 32_768
}

function publicModels(parsed: unknown, status: number): ModelInfo[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.data))
    throw new ModelListError(makeProviderError("provider_internal", "the model list is not {data: [...]}", { status }))
  return parsed.data.filter(isRecord).flatMap(({ id }): ModelInfo[] => {
    if (typeof id !== "string" || !/^(?:ft:)?(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(id)) return []
    if (/embedding|audio|realtime|search-preview|transcrib|tts|image|moderation|instruct/i.test(id)) return []
    return [{ slug: id, displayName: id, visibility: "list", supportedInApi: true, contextWindow: apiContextWindow(id), reasoningEfforts: [], defaultReasoningEffort: null }]
  })
}

function planModels(parsed: unknown, status: number, listedOnly?: boolean): ModelInfo[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.models))
    throw new ModelListError(makeProviderError("provider_internal", "the model list is not {models: [...]}", { status }))
  const models = parsed.models.filter(isRecord).flatMap((entry): ModelInfo[] => {
    const slug = stringOr(entry.slug)
    if (!slug) return []
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
    return [
      {
        slug,
        displayName: stringOr(entry.display_name) ?? slug,
        ...(typeof entry.description === "string" ? { description: entry.description } : {}),
        visibility: stringOr(entry.visibility) ?? "list",
        supportedInApi: entry.supported_in_api !== false,
        contextWindow: typeof entry.context_window === "number" ? entry.context_window : null,
        reasoningEfforts: levels.flatMap((level) => (isRecord(level) && typeof level.effort === "string" ? [level.effort] : [])),
        defaultReasoningEffort: stringOr(entry.default_reasoning_level),
      },
    ]
  })
  return listedOnly === false ? models : models.filter((model) => model.visibility === "list")
}

function openaiCatalog(parse: typeof planModels) {
  return async (descriptor: ProviderDescriptor, options: CatalogOptions): Promise<ModelInfo[]> => {
    const token = await catalogToken(options)
    const { parsed, status } = await modelPage(descriptor, options, "/models", token, httpError)
    return parse(parsed, status, options.listedOnly)
  }
}

export const listPublicModels = openaiCatalog(publicModels)
export const listPlanModels = openaiCatalog(planModels)
