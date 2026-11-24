import { makeProviderError, type ProviderErrorKind } from "../../error.ts"
import { isRecord, parseJson, retryAfterMs, stringOr } from "../fields.ts"

function hardQuota(detail: Record<string, unknown>) {
  if (detail.reason === "BILLING_DISABLED") return true
  if (detail["@type"] !== "type.googleapis.com/google.rpc.QuotaFailure" || !Array.isArray(detail.violations)) return false
  return detail.violations.some((violation) => isRecord(violation) && (
    stringOr(violation.quotaId)?.includes("PerDay") || violation.quotaValue === "0" || violation.quotaValue === 0
  ))
}

export function geminiError(value: unknown, httpStatus?: number, retryAfter?: number | null) {
  const error = isRecord(value) ? value : {}
  const status = httpStatus ?? (Number.isInteger(error.code) && Number(error.code) >= 100 ? Number(error.code) : undefined)
  const code = stringOr(error.status) ?? undefined
  const message = stringOr(error.message) ?? code ?? `Gemini request failed (HTTP ${status ?? "unknown"})`
  const details = Array.isArray(error.details) ? error.details.filter(isRecord) : []
  const delay = details.find((detail) => typeof detail.retryDelay === "string")?.retryDelay
  const seconds = typeof delay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1] : undefined
  const retryMs = retryAfter ?? (seconds === undefined ? undefined : Math.ceil(Number(seconds) * 1000))

  let kind: ProviderErrorKind
  if (status === 429 || code === "RESOURCE_EXHAUSTED") {
    kind = details.some(hardQuota) ? "usage_limit" : "rate_limit"
  } else if (status === 401 || status === 403 || code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED"
      || details.some((detail) => detail.reason === "API_KEY_INVALID")) {
    kind = "auth"
  } else if (status === 408 || (status !== undefined && status >= 500) || code === "INTERNAL" || code === "UNAVAILABLE") {
    kind = "provider_internal"
  } else if (/input token count.*exceeds|input.*exceeds.*token limit|context length exceeded/i.test(message)) {
    kind = "context_overflow"
  } else {
    kind = status !== undefined || code === "INVALID_ARGUMENT" ? "invalid_request" : "provider_internal"
  }
  return makeProviderError(kind, message, { status, code, retryAfterMs: retryMs })
}

export function httpError(response: Response, text: string | undefined) {
  const parsed = parseJson(text ?? "")
  const error = isRecord(parsed) ? parsed.error : { message: text || response.statusText }
  return geminiError(error, response.status, retryAfterMs(response.headers))
}
