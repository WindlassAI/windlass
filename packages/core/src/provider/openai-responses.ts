/** Encode one stateless Responses call and translate its SSE frames to Windlass events. */
import type { ModelRequest } from "../request/request.ts"
import { streamRequest, type WireProviderOptions } from "./wire/stream.ts"
import type { Provider } from "./provider.ts"
import { providerDescriptor } from "./registry.ts"
import { ResponsesStreamMapper } from "./wire/responses/decode.ts"
import { encodeRequest } from "./wire/responses/encode.ts"
import { httpError } from "./wire/responses/error.ts"

export { RESPONSES_BASE_URL } from "./providers/openai.ts"
export { encodeRequest } from "./wire/responses/encode.ts"
export { blobRefs, MissingBlobError, type EncodedRequest, type BlobBytes } from "./wire/request.ts"
export { ResponsesStreamMapper } from "./wire/responses/decode.ts"
export { classify } from "./wire/responses/error.ts"
export { readErrorBody, retryAfterMs } from "./wire/fields.ts"

export type OpenAIResponsesOptions = WireProviderOptions

const wire = { path: () => "/responses", httpError, mapper: (id: string | null) => new ResponsesStreamMapper(id) }

export class OpenAIResponsesProvider implements Provider {
  readonly id: string
  private readonly descriptor

  constructor(private readonly options: OpenAIResponsesOptions) {
    this.descriptor = providerDescriptor(options.profile)
    this.id = this.descriptor.ledgerId
  }

  stream = (request: ModelRequest, signal: AbortSignal) =>
    streamRequest(this.descriptor, this.options, wire, (req, blobs) => encodeRequest(req, blobs, this.descriptor.wireOptions), request, signal)
}
