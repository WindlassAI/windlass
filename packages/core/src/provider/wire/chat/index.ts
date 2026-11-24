import type { ModelRequest } from "../../../request/request.ts"
import type { Store } from "../../../store/store.ts"
import type { Provider } from "../../provider.ts"
import { openrouter, openRouterOptions } from "../../providers/openrouter.ts"
import { traceBlobs } from "../request.ts"
import { streamRequest, type WireProviderOptions } from "../stream.ts"
import { ChatStreamMapper } from "./decode.ts"
import { encodeRequest } from "./encode.ts"
import { httpError } from "./error.ts"
import { canonicalChatRequest } from "./trace.ts"

function createProvider(connection: WireProviderOptions): Provider {
  let catalog: Awaited<ReturnType<typeof openrouter.catalog.listModels>> | undefined
  return {
    id: openrouter.ledgerId,
    async *stream(request, signal) {
      if (signal.aborted) return
      catalog ??= await openrouter.catalog.listModels(openrouter, { ...connection, signal }).catch(() => undefined)
      if (signal.aborted) return
      const options = openRouterOptions(catalog?.find((entry) => entry.slug === request.params.model))
      const wire = {
        path: () => "/chat/completions",
        httpError,
        jsonErrorOnSuccess: true,
        mapper: (id: string | null) => new ChatStreamMapper(id, request.params.model, options),
      }
      yield* streamRequest(
        openrouter,
        connection,
        wire,
        (req, blobs) => encodeRequest(req, blobs, options),
        request,
        signal,
      )
    },
  }
}

export const chatWire = {
  createProvider,
  traceEncode(store: Store, request: ModelRequest) {
    const encoded = encodeRequest(request, traceBlobs(store, request), openRouterOptions())
    return canonicalChatRequest(JSON.parse(encoded.body))
  },
  traceProvider: "openrouter",
}
