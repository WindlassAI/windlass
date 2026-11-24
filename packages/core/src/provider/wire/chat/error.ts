import { makeProviderError } from "../../error.ts"
import { isRecord, parseJson, readErrorBody, retryAfterMs, stringOr } from "../fields.ts"
import { classify } from "../responses/error.ts"

export function chatError(
  source: Record<string, unknown>,
  requestId: string | null,
  status?: number,
  retry?: number | null,
) {
  // OpenRouter may send the upstream status as a numeric error.code inside an already-open stream.
  const embedded =
    typeof source.code === "number" && Number.isInteger(source.code) && source.code >= 400 && source.code < 600
      ? source.code
      : undefined
  const code = stringOr(source.code) ?? stringOr(source.type) ?? embedded?.toString()
  const message = stringOr(source.message) ?? "chat completion failed"
  const detail = { status: embedded ?? status, code, requestId, retryAfterMs: retry ?? undefined }
  if (detail.status === 402) return makeProviderError("usage_limit", message, detail)
  return classify({ ...detail, message })
}

export function httpError(response: Response, text: string | undefined, id: string | null) {
  const status = response.ok ? undefined : response.status
  const retry = retryAfterMs(response.headers)
  const body = parseJson(text ?? "")
  if (isRecord(body) && isRecord(body.error)) return chatError(body.error, id, status, retry)
  if (response.ok) return makeProviderError("provider_internal", "expected a chat completion stream", { requestId: id })
  return chatError(readErrorBody(text ?? response.statusText), id, status, retry)
}
