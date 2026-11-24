import { type CatalogOptions, type ModelInfo, ModelListError, catalogToken, modelPage } from "../../catalog.ts"
import type { ProviderDescriptor } from "../../descriptor.ts"
import { makeProviderError } from "../../error.ts"
import { httpError } from "./error.ts"
import { isRecord, stringOr } from "../fields.ts"

interface ModelLimits {
  contextWindow: number
  maxTokens: number
  thinking: "adaptive" | "enabled"
  efforts: readonly string[] | null
  defaultEffort: string | null
  nativeSystem: boolean
  interleaved: boolean
}

const unknown: ModelLimits = {
  contextWindow: 200_000, maxTokens: 64_000, thinking: "adaptive", efforts: null, defaultEffort: null,
  nativeSystem: false, interleaved: false,
}
const basic = ["low", "medium", "high"]
const levels = [...basic, "xhigh", "max"]
const manual: ModelLimits = { ...unknown, thinking: "enabled", efforts: basic, interleaved: true }
const adaptive: ModelLimits = {
  ...unknown, contextWindow: 1_000_000, maxTokens: 128_000, thinking: "adaptive",
  efforts: levels, defaultEffort: "high", nativeSystem: true,
}
const adaptive46 = { ...adaptive, efforts: [...basic, "max"], defaultEffort: null, nativeSystem: false }

// Shared by live encoding and offline trace reconstruction. Dated snapshots use the same limits as their alias.
// https://platform.claude.com/docs/en/models/overview
const models: Readonly<Record<string, ModelLimits>> = {
  "claude-3-7-sonnet": { ...manual, interleaved: false },
  "claude-opus-4": { ...manual, maxTokens: 32_000 },
  "claude-opus-4-1": { ...manual, maxTokens: 32_000 },
  "claude-opus-4-5": manual, "claude-sonnet-4": manual, "claude-sonnet-4-5": manual,
  "claude-haiku-4-5": { ...manual, interleaved: false },
  "claude-opus-4-6": adaptive46, "claude-sonnet-4-6": adaptive46,
  "claude-opus-4-7": { ...adaptive, defaultEffort: null, nativeSystem: false },
  "claude-opus-4-8": { ...adaptive, defaultEffort: null },
  "claude-fable-5": adaptive, "claude-fable-5-1": adaptive, "claude-fable-5-2": adaptive,
  "claude-mythos-5": adaptive, "claude-mythos-5-1": adaptive, "claude-mythos-5-2": adaptive,
  "claude-opus-5": adaptive, "claude-sonnet-5": { ...adaptive, nativeSystem: false },
  "claude-sonnet-5-5": adaptive,
  "claude-opus-5-5": { ...adaptive, defaultEffort: "medium" },
  "claude-haiku-5-5": { ...adaptive, defaultEffort: "medium" },
}

export function anthropicModel(model: string): ModelLimits {
  const id = model.replace(/-\d{8}$/, "")
  return Object.hasOwn(models, id) ? models[id]! : unknown
}

function catalogEfforts(capabilities: unknown, model: ModelLimits): readonly string[] {
  const fallback = model.efforts ?? levels
  if (!isRecord(capabilities)) return fallback
  const effort = capabilities.effort
  if (isRecord(effort) && effort.supported === true) {
    return Object.keys(effort)
      .filter((level) => isRecord(effort[level]) && effort[level].supported === true)
      .sort((a, b) => levels.indexOf(a) - levels.indexOf(b))
  }
  const thinking = capabilities.thinking
  if (isRecord(thinking) && thinking.supported === false) return []
  // Manual models implement these settings as thinking budgets even without API effort support.
  if (isRecord(effort) && effort.supported === false) return model.thinking === "enabled" ? basic : []
  return fallback
}

export async function listAnthropicModels(descriptor: ProviderDescriptor, options: CatalogOptions): Promise<ModelInfo[]> {
  const token = await catalogToken(options)
  const models: ModelInfo[] = []
  const cursors = new Set<string>()
  let path = "/v1/models"
  while (true) {
    const { parsed, status } = await modelPage(descriptor, options, path, token, httpError)
    if (!isRecord(parsed) || !Array.isArray(parsed.data))
      throw new ModelListError(makeProviderError("provider_internal", "the model list is not {data: [...]}", { status }))
    for (const entry of parsed.data) {
      if (!isRecord(entry) || typeof entry.id !== "string") continue
      const model = anthropicModel(entry.id)
      const maxTokens = typeof entry.max_tokens === "number" ? entry.max_tokens : model.maxTokens
      const reasoningEfforts = catalogEfforts(entry.capabilities, model)
      models.push({
        slug: entry.id, displayName: stringOr(entry.display_name) ?? entry.id, visibility: "list", supportedInApi: true,
        contextWindow: typeof entry.max_input_tokens === "number" ? entry.max_input_tokens : model.contextWindow,
        description: `Maximum output: ${maxTokens} tokens`,
        reasoningEfforts,
        defaultReasoningEffort: model.defaultEffort && reasoningEfforts.includes(model.defaultEffort) ? model.defaultEffort : null,
      })
    }
    if (!parsed.has_more) return models
    const cursor = stringOr(parsed.last_id)
    if (!cursor || cursors.has(cursor))
      throw new ModelListError(makeProviderError("provider_internal", "the model list did not advance its cursor", { status }))
    cursors.add(cursor)
    path = "/v1/models?after_id=" + encodeURIComponent(cursor)
  }
}
