import { catalogToken, type CatalogOptions, type ModelInfo, ModelListError, modelPage } from "../../catalog.ts"
import type { ProviderDescriptor } from "../../descriptor.ts"
import { makeProviderError } from "../../error.ts"
import { isRecord, stringOr } from "../fields.ts"
import { httpError } from "./error.ts"
import { reasoningEfforts } from "./thinking.ts"

function readModel(entry: unknown): ModelInfo[] {
  if (!isRecord(entry) || typeof entry.name !== "string" || !/^models\/gemini-[^/]+$/.test(entry.name)) return []
  if (!Array.isArray(entry.supportedGenerationMethods) || !entry.supportedGenerationMethods.includes("generateContent")) return []
  const slug = entry.name.slice("models/".length)
  if (/-(tts|image|live|audio)(-|$)/.test(slug)) return []
  const limit = entry.inputTokenLimit
  return [{
    slug,
    displayName: stringOr(entry.displayName) ?? slug,
    ...(typeof entry.description === "string" && { description: entry.description }),
    visibility: "list",
    supportedInApi: true,
    contextWindow: typeof limit === "number" && Number.isSafeInteger(limit) && limit > 0 ? limit : null,
    reasoningEfforts: reasoningEfforts(slug, entry.thinking !== false),
    defaultReasoningEffort: null,
  }]
}

export async function listGoogleModels(descriptor: ProviderDescriptor, options: CatalogOptions): Promise<ModelInfo[]> {
  const token = await catalogToken(options)
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  let path = "/v1beta/models"
  while (true) {
    const { parsed, status } = await modelPage(descriptor, options, path, token, httpError)
    if (!isRecord(parsed) || !Array.isArray(parsed.models))
      throw new ModelListError(makeProviderError("provider_internal", "invalid Gemini model list", { status }))
    models.push(...parsed.models.flatMap(readModel))
    const page = stringOr(parsed.nextPageToken)
    if (!page) return models
    if (seen.has(page)) throw new ModelListError(makeProviderError("provider_internal", "repeated Gemini catalog page token", { status }))
    seen.add(page)
    path = "/v1beta/models?pageToken=" + encodeURIComponent(page)
  }
}
