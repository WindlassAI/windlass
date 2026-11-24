/** Encode one stateless Responses call and translate its SSE frames to Windlass events. */
import type { BlobRef } from "../content.ts"
import type { ModelRequest } from "../request/request.ts"
import { makeProviderError } from "./error.ts"
import { type Connection, describe, httpStream } from "./http-stream.ts"
import type { Provider, StreamEvent } from "./provider.ts"
import { type ProviderProfile, providerDescriptor } from "./registry.ts"
import { ResponsesStreamMapper } from "./wire/responses/decode.ts"
import { blobRefs, encodeRequest } from "./wire/responses/encode.ts"
import { httpError } from "./wire/responses/error.ts"

export { RESPONSES_BASE_URL } from "./providers/openai.ts"
export { encodeRequest, blobRefs, MissingBlobError, type EncodedRequest, type BlobBytes } from "./wire/responses/encode.ts"
export { ResponsesStreamMapper } from "./wire/responses/decode.ts"
export { classify, readErrorBody, retryAfterMs } from "./wire/responses/error.ts"

export interface OpenAIResponsesOptions extends Connection {
  readonly profile?: ProviderProfile
  readonly readBlob: (ref: BlobRef) => Uint8Array | Promise<Uint8Array>
  readonly idleTimeoutMs?: number
}

const wire = { path: () => "/responses", httpError, mapper: (id: string | null) => new ResponsesStreamMapper(id) }

export class OpenAIResponsesProvider implements Provider {
  readonly id: string
  private readonly descriptor

  constructor(private readonly options: OpenAIResponsesOptions) {
    this.descriptor = providerDescriptor(options.profile)
    this.id = this.descriptor.ledgerId
  }

  stream = (request: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent> => this.run(request, signal)

  private async *run(request: ModelRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
    if (signal.aborted) return
    const blobs = new Map<string, Uint8Array>()
    try {
      for (const ref of blobRefs(request)) blobs.set(ref.hash, await this.options.readBlob(ref))
    } catch (cause) {
      if (!signal.aborted) yield { type: "error", error: makeProviderError("invalid_request", `could not read a media blob: ${describe(cause)}`) }
      return
    }
    let encoded
    try {
      encoded = encodeRequest(request, blobs, this.descriptor.wireOptions)
    } catch (cause) {
      if (!signal.aborted) yield { type: "error", error: makeProviderError("invalid_request", `could not encode the request: ${describe(cause)}`) }
      return
    }
    yield* httpStream(this.descriptor, this.options, wire, request, encoded, signal, this.options.idleTimeoutMs)
  }
}
