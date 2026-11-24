import type { Connection } from "./http-stream.ts"
import type { ProviderProfile } from "./registry.ts"
import type { ProviderError } from "./error.ts"

export interface ModelInfo {
  /** Sent as `params.model`. */
  readonly slug: string
  /** Shown to the user. */
  readonly displayName: string
  readonly description?: string
  /** `list` entries are offered to the user; `hide` entries are not. */
  readonly visibility: string
  readonly supportedInApi: boolean
  readonly contextWindow: number | null
  readonly reasoningEfforts: readonly string[]
  readonly defaultReasoningEffort: string | null
}

export class ModelListError extends Error {
  constructor(readonly error: ProviderError) {
    super(error.message)
  }
}

export interface CatalogOptions extends Connection {
  readonly profile?: ProviderProfile
  readonly listedOnly?: boolean
  readonly signal?: AbortSignal
}
