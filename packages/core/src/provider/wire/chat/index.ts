import type { ModelRequest } from "../../../request/request.ts"
import type { Store } from "../../../store/store.ts"
import { ModelListError } from "../../catalog.ts"
import { makeProviderError } from "../../error.ts"
import { describe } from "../../http-stream.ts"
import type { Provider } from "../../provider.ts"
import { fallbackOutputTokens, openrouter, openRouterOptions } from "../../providers/openrouter.ts"
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
      try {
        catalog ??= await openrouter.catalog.listModels(openrouter, { ...connection, signal })
      } catch (cause) {
        if (!signal.aborted) {
          const error = cause instanceof ModelListError ? cause.error : makeProviderError("transport", describe(cause))
          yield { type: "error", error }
        }
        return
      }
      const model = catalog.find((entry) => entry.slug === request.params.model)
      const options = {
        ...openRouterOptions,
        maxTokens: model?.maxTokens ?? fallbackOutputTokens,
        images: model?.inputModalities.includes("image") ?? false,
      }
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
    const encoded = encodeRequest(request, traceBlobs(store, request), openRouterOptions)
    return canonicalChatRequest(JSON.parse(encoded.body))
  },
  traceProvider: "openrouter",
}
