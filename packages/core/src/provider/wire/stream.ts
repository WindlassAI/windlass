import type { BlobRef } from "../../content.ts"
import type { ModelRequest } from "../../request/request.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { makeProviderError } from "../error.ts"
import { type Connection, describe, httpStream, type StreamWire } from "../http-stream.ts"
import type { StreamEvent } from "../provider.ts"
import type { ProviderProfile } from "../registry.ts"
import { type BlobBytes, blobRefs, type EncodedRequest } from "./request.ts"

export interface WireProviderOptions extends Connection {
  readonly profile?: ProviderProfile
  readonly readBlob: (ref: BlobRef) => Uint8Array | Promise<Uint8Array>
  readonly idleTimeoutMs?: number
}

export async function* streamRequest(
  descriptor: ProviderDescriptor,
  options: WireProviderOptions,
  wire: StreamWire,
  encode: (request: ModelRequest, blobs: BlobBytes) => EncodedRequest,
  request: ModelRequest,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  if (signal.aborted) return
  const blobs = new Map<string, Uint8Array>()
  try {
    for (const ref of blobRefs(request)) blobs.set(ref.hash, await options.readBlob(ref))
  } catch (cause) {
    if (!signal.aborted) yield { type: "error", error: makeProviderError("invalid_request", `could not read a media blob: ${describe(cause)}`) }
    return
  }
  let encoded
  try {
    encoded = encode(request, blobs)
  } catch (cause) {
    if (!signal.aborted) yield { type: "error", error: makeProviderError("invalid_request", `could not encode the request: ${describe(cause)}`) }
    return
  }
  yield* httpStream(descriptor, options, wire, request, encoded, signal, options.idleTimeoutMs)
}
