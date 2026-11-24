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
  const param = stringOr(source.param)
  const description = stringOr(source.message) ?? code ?? "chat completion failed"
  const message = param ? `${description} [param: ${param}]` : description
  const detail = { status: embedded ?? status, code, requestId, retryAfterMs: retry ?? undefined }
  if (detail.status === 402) return makeProviderError("usage_limit", message, detail)
  return classify({ ...detail, message })
}

export function httpError(response: Response, text: string | undefined, id: string | null) {
  const status = response.ok ? undefined : response.status
  const retry = retryAfterMs(response.headers)
  const raw = text ?? response.statusText
  const body = parseJson(raw) ?? null
  const error = isRecord(body) && isRecord(body.error) ? body.error : readErrorBody(raw, body)
  return chatError(error, id, status, retry)
}
