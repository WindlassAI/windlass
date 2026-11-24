import { makeProviderError, type ProviderErrorKind } from "../../error.ts"
import { readErrorBody, retryAfterMs } from "../fields.ts"

function kind(code: string | null, message: string, status?: number): ProviderErrorKind {
  if (status === 401 || status === 403 || code === "authentication_error" || code === "permission_error") return "auth"
  if (status === 402 || /credit[_ ]balance|insufficient[_ ]credit|quota|spend[_ ]limit|usage[_ ]limit|billing_error/i.test(`${code} ${message}`)) return "usage_limit"
  if (status === 429 || code === "rate_limit_error" || code === "rate_limit_exceeded") return "rate_limit"
  if (code === "refusal" || code === "content_policy_violation") return "content_policy"
  if (/prompt is too long|exceeds? (?:the )?context (?:window|limit)|too many input tokens/i.test(message)) return "context_overflow"
  if (code === "overloaded_error" || code === "api_error") return "provider_internal"
  if (status === undefined) return code === "invalid_request_error" ? "invalid_request" : "provider_internal"
  if (status === 408 || status >= 500) return "provider_internal"
  return "invalid_request"
}

export function classify(code: string | null, message: string, status?: number, requestId?: string | null, retry?: number | null) {
  return makeProviderError(kind(code, message, status), message, { code: code ?? undefined, status, requestId, retryAfterMs: retry ?? undefined })
}

export function httpError(response: Response, text: string | undefined, requestId: string | null) {
  const { code, message } = readErrorBody(text ?? `HTTP ${response.status}`)
  return classify(code, message, response.status, requestId, retryAfterMs(response.headers))
}
