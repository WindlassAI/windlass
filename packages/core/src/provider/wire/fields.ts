/** Extract a provider error from a JSON error, detail, or message field, with trimmed text as the fallback. */
export function readErrorBody(text: string): { code: string | null; message: string } {
  const parsed = parseJson(text)
  if (isRecord(parsed)) {
    if (isRecord(parsed.error)) {
      const error = parsed.error
      const code = stringOr(error.code) ?? stringOr(error.type)
      const param = stringOr(error.param)
      const message = stringOr(error.message) ?? code ?? "request failed"
      return { code, message: param ? `${message} [param: ${param}]` : message }
    }
    if (parsed.detail !== undefined) {
      const detail = typeof parsed.detail === "string" ? parsed.detail : JSON.stringify(parsed.detail)
      return { code: null, message: detail }
    }
    const message = stringOr(parsed.message)
    if (message) return { code: stringOr(parsed.code), message }
  }
  const trimmed = text.trim()
  return { code: null, message: trimmed.length > 0 ? clip(trimmed) : "empty error body" }
}

/** `retry-after-ms`, then `retry-after` as seconds or an HTTP date. Absent or unreadable gives null. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const ms = headers.get("retry-after-ms")
  if (ms !== null && /^\d+(\.\d+)?$/.test(ms.trim())) return Math.ceil(Number(ms))
  const value = headers.get("retry-after")
  if (value === null) return null
  if (/^\d+(\.\d+)?$/.test(value.trim())) return Math.ceil(Number(value) * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? null : Math.max(0, date - now)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringOr(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function clip(text: string) {
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}
