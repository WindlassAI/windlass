import type { CatalogOptions, ModelInfo } from "./catalog.ts"
import type { chatgptAuth } from "./providers/chatgpt.ts"

export interface ResponsesWireOptions {
  readonly sessionIdHeader: string | null
  readonly forceReasoning: boolean
}

type WireSettings = { readonly wire: "responses"; readonly wireOptions: ResponsesWireOptions }
export type Wire = WireSettings["wire"]

export type ProviderDescriptor = WireSettings & {
  readonly id: string
  readonly ledgerId: string
  readonly auth: typeof chatgptAuth | { readonly kind: "env-key"; readonly variable: string }
  readonly endpoint: {
    readonly baseUrl: string
    readonly headers: (credential: string) => Record<string, string>
    readonly redirect: "error" | "follow"
    readonly requestIdHeader: string | null
  }
  readonly catalog: {
    readonly listModels: (descriptor: ProviderDescriptor, options: CatalogOptions) => Promise<ModelInfo[]>
    readonly contextWindow: (model: string, models: () => Promise<readonly ModelInfo[]>) => number | null | Promise<number | null>
    /** Validate even default settings and treat an empty listing as authoritative. */
    readonly validateDefault: boolean
  }
  readonly defaults: { readonly model: string; readonly titleModel: string | null; readonly titleEffort: string | null }
  readonly billing: "subscription" | "metered"
  readonly authMethod: {
    readonly name: string
    readonly description: string
    readonly failureText: (message: string) => string
    readonly requiredText: (message: string) => string
  }
}
