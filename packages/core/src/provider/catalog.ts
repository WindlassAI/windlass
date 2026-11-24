import { type Connection, describe, responseRequestId, safeError, send, tokenFailure } from "./http-stream.ts"
import type { ProviderDescriptor } from "./descriptor.ts"
import { makeProviderError, type ProviderError } from "./error.ts"
import type { ProviderProfile } from "./registry.ts"
import { parseJson } from "./wire/fields.ts"

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

export async function catalogToken(options: CatalogOptions) {
  try {
    return await options.accessToken()
  } catch (cause) {
    throw new ModelListError(tokenFailure(cause))
  }
}

export async function modelPage(
  descriptor: ProviderDescriptor, options: CatalogOptions, path: string, token: string,
  onError: (response: Response, text: string, requestId: string | null) => ProviderError,
) {
  let response: Response
  let text: string
  try {
    response = await send(descriptor, options, path, token, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: options.signal,
    })
    text = await response.text()
  } catch (cause) {
    const error = makeProviderError("transport", `the model list request failed: ${describe(cause)}`)
    throw new ModelListError(safeError(error, descriptor.auth, token))
  }
  if (!response.ok) {
    const error = onError(response, text, responseRequestId(response, descriptor, token))
    throw new ModelListError(safeError(error, descriptor.auth, token))
  }
  return { parsed: parseJson(text), status: response.status }
}
