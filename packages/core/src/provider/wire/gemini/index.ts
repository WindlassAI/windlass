import type { ModelRequest } from "../../../request/request.ts"
import type { Store } from "../../../store/store.ts"
import type { Provider } from "../../provider.ts"
import { google } from "../../providers/google.ts"
import { traceBlobs } from "../request.ts"
import { streamRequest, type WireProviderOptions } from "../stream.ts"
import { GeminiStreamMapper } from "./decode.ts"
import { encodeRequest } from "./encode.ts"
import { httpError } from "./error.ts"
import { canonicalGeminiRequest } from "./trace.ts"

export const geminiWire = {
  createProvider: (options: WireProviderOptions): Provider => ({
    id: google.ledgerId,
    stream(request, signal) {
      const model = request.params.model
      const wire = {
        path: () => `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        httpError,
        mapper: () => new GeminiStreamMapper(model),
      }
      return streamRequest(google, options, wire, encodeRequest, request, signal)
    },
  }),
  traceEncode(store: Store, request: ModelRequest) {
    const encoded = encodeRequest(request, traceBlobs(store, request))
    return canonicalGeminiRequest(request.params.model, JSON.parse(encoded.body))
  },
  traceProvider: "gemini",
}
