import type { ModelRequest } from "../../../request/request.ts"
import type { Store } from "../../../store/store.ts"
import type { Provider } from "../../provider.ts"
import { anthropic } from "../../providers/anthropic.ts"
import { traceBlobs } from "../request.ts"
import { streamRequest, type WireProviderOptions } from "../stream.ts"
import { MessagesStreamMapper } from "./decode.ts"
import { encodeRequest } from "./encode.ts"
import { httpError } from "./error.ts"
import { canonicalAnthropicRequest } from "./trace.ts"

export const anthropicWire = {
  createProvider: (options: WireProviderOptions): Provider => ({
    id: anthropic.ledgerId,
    stream(request, signal) {
      const wire = {
        path: () => "/v1/messages",
        httpError,
        mapper: (id: string | null) => new MessagesStreamMapper(id, request.params.model),
      }
      return streamRequest(anthropic, options, wire, encodeRequest, request, signal)
    },
  }),
  traceEncode(store: Store, request: ModelRequest) {
    const encoded = encodeRequest(request, traceBlobs(store, request))
    return canonicalAnthropicRequest(JSON.parse(encoded.body))
  },
  traceProvider: "anthropic",
}
