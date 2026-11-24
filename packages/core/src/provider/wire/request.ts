import type { BlobRef } from "../../content.ts"
import type { Store } from "../../store/store.ts"
import type { ModelRequest } from "../../request/request.ts"

/** Bytes of the blobs a request refers to, by hash. */
export type BlobBytes = ReadonlyMap<string, Uint8Array>

export interface EncodedRequest {
  /** The JSON body, in canonical key order. */
  readonly body: string
  /** Request headers other than `Authorization`, in a fixed order. */
  readonly headers: Readonly<Record<string, string>>
}

/** Every blob a request refers to, in first-use order, without duplicates. */
export function blobRefs(request: ModelRequest): BlobRef[] {
  const refs = request.input.flatMap((item): readonly BlobRef[] => {
    if (item.type === "message") return item.content.flatMap((part) => (part.type === "media" ? [part.blob] : []))
    if (item.type === "tool_result") return item.attachments
    return []
  })
  const seen = new Set<string>()
  return refs.filter((ref) => !seen.has(ref.hash) && seen.add(ref.hash))
}

export function traceBlobs(store: Store, request: ModelRequest) {
  return new Map(
    blobRefs(request).flatMap((ref) => {
      const blob = store.getBlob(ref.hash)
      return blob === null ? [] : [[ref.hash, blob.bytes] as const]
    }),
  )
}

export class MissingBlobError extends Error {
  constructor(readonly blob: BlobRef) {
    super(`blob ${blob.hash} (${blob.mediaType}) is not available`)
  }
}
