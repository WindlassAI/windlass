import type { ModelRequest } from "../../request/request.ts"
import type { Store } from "../../store/store.ts"
import { canonicalResponsesRequest } from "../../trace/format.ts"
import type { ResponsesWireOptions, Wire } from "../descriptor.ts"
import { type OpenAIResponsesOptions, OpenAIResponsesProvider } from "../openai-responses.ts"
import { traceBlobs } from "./request.ts"
import { encodeRequest } from "./responses/encode.ts"

function traceResponses(store: Store, request: ModelRequest, options?: ResponsesWireOptions) {
  const blobs = traceBlobs(store, request)
  return canonicalResponsesRequest(JSON.parse(encodeRequest(request, blobs, options).body))
}

export const wires = {
  responses: {
    createProvider: (options: OpenAIResponsesOptions) => new OpenAIResponsesProvider(options),
    traceEncode: traceResponses,
    traceProvider: "openai",
  },
} satisfies Record<Wire, unknown>
