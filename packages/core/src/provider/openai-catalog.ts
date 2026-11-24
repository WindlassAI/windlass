import { catalogToken, modelPage, type CatalogOptions, type ModelInfo, ModelListError } from "./catalog.ts"
import { makeProviderError } from "./error.ts"
import type { ProviderDescriptor } from "./descriptor.ts"
import { httpError } from "./wire/responses/error.ts"
import { isRecord, stringOr } from "./wire/fields.ts"

interface Family {
  readonly contextWindow: number
  readonly efforts: readonly string[]
  readonly defaultEffort: string | null
}

const sixth = ["none", "low", "medium", "high", "xhigh", "max"]
const fifth = ["none", "low", "medium", "high", "xhigh"]
const pro = ["medium", "high", "xhigh"]
const large = (efforts: readonly string[], defaultEffort: string | null, contextWindow = 922_000): Family => ({ contextWindow, efforts, defaultEffort })

// The public catalog lacks windows and efforts. The windows are the maximum input where the model page gives one.
// https://developers.openai.com/api/docs/models
const families: Readonly<Record<string, Family>> = {
  "gpt-6.2-astra": large(sixth.slice(1), null), "gpt-6.2-sol": large(sixth.slice(1), null),
  "gpt-6.1-sol": large(sixth.slice(1), "medium"), "gpt-6.1-terra": large(sixth, "medium"),
  "gpt-6-sol": large(sixth, "medium"), "gpt-6-luna": large(sixth, "medium"),
  "gpt-5.6-sol": large(sixth, "medium"), "gpt-5.6-luna": large(sixth, "medium"),
  "gpt-5.5": large(fifth, "medium", 1_050_000), "gpt-5.5-pro": large(pro, "high", 1_050_000),
  "gpt-5.4": large(fifth, "none", 1_050_000), "gpt-5.4-pro": large(pro, "medium", 1_050_000),
  "gpt-5.4-mini": large(fifth, "none", 272_000), "gpt-5.4-nano": large(fifth, "none", 272_000),
  "gpt-5.2": large(fifth, "none", 400_000), "gpt-5.2-pro": large(pro, null, 400_000),
  "gpt-5.1": large(fifth.slice(0, 4), "none", 400_000),
  "gpt-5": large(["minimal", "low", "medium", "high"], null, 272_000),
  "gpt-5-mini": large(["minimal", "low", "medium", "high"], null, 272_000),
  "gpt-5-nano": large(["minimal", "low", "medium", "high"], null, 272_000),
  "gpt-5-pro": large(["high"], "high", 400_000),
  "o3": large(["low", "medium", "high"], null, 200_000),
  "gpt-4.1": large([], null, 1_047_576), "gpt-4.1-mini": large([], null, 1_047_576),
  "gpt-4o": large([], null, 128_000), "gpt-4o-mini": large([], null, 128_000),
}

const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/

function family(model: string): Family | null {
  const id = model.replace(SNAPSHOT, "")
  return Object.hasOwn(families, id) ? families[id]! : null
}

/** `null` for a model not in the table: then nothing is compacted ahead of time. */
export function apiContextWindow(model: string): number | null {
  return family(model)?.contextWindow ?? null
}

/** Newest first: `gpt-6.2` before `gpt-6` before `gpt-5.5`; the o-series after the GPT families. */
function generation(model: string): number {
  const version = /^gpt-(\d+(?:\.\d+)?)/.exec(model)
  return version === null ? 0 : Number(version[1])
}

function publicModels(parsed: unknown, status: number, listedOnly?: boolean): ModelInfo[] {
  if (!isRecord(parsed) || !Array.isArray(parsed.data))
    throw new ModelListError(makeProviderError("provider_internal", "the model list is not {data: [...]}", { status }))
  const ids = parsed.data.flatMap((entry) => (isRecord(entry) && typeof entry.id === "string" ? [entry.id] : []))
    .filter((id) => /^(?:ft:)?(?:gpt-|chatgpt-|codex-|o\d+(?:-|$))/.test(id))
    .filter((id) => !/embedding|audio|realtime|search|transcrib|tts|image|moderation|instruct|^gpt-live/i.test(id))
  const offered = new Set(ids)
  const models = ids.map((id): ModelInfo => {
    const known = family(id)
    // A dated snapshot is the same model as its alias; a vertical variant (`-healthcare`) is not a general model.
    const hidden = (SNAPSHOT.test(id) && offered.has(id.replace(SNAPSHOT, ""))) || /-healthcare(?:-|$)/.test(id)
    return {
      slug: id, displayName: id, visibility: hidden ? "hide" : "list", supportedInApi: true,
      contextWindow: known?.contextWindow ?? null, reasoningEfforts: known?.efforts ?? [], defaultReasoningEffort: known?.defaultEffort ?? null,
    }
  }).sort((a, b) => generation(b.slug) - generation(a.slug) || a.slug.localeCompare(b.slug))
  return listedOnly === false ? models : models.filter((model) => model.visibility === "list")
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

function openaiCatalog(parse: typeof planModels | typeof publicModels) {
  return async (descriptor: ProviderDescriptor, options: CatalogOptions): Promise<ModelInfo[]> => {
    const token = await catalogToken(options)
    const { parsed, status } = await modelPage(descriptor, options, "/models", token, httpError)
    return parse(parsed, status, options.listedOnly)
  }
}

export const listPublicModels = openaiCatalog(publicModels)
export const listPlanModels = openaiCatalog(planModels)
