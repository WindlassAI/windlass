import { AUTH_UNREACHABLE, AuthError } from "../auth/error.ts"
import { type ProviderError, makeProviderError } from "./error.ts"
import type { ModelRequest } from "../request/request.ts"
import type { StreamEvent } from "./provider.ts"
import type { ProviderDescriptor } from "./descriptor.ts"
import { type SseEvent, SseParser } from "./sse.ts"

export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>

export interface Connection {
  readonly accessToken: () => Promise<string>
  readonly baseUrl?: string
  readonly fetch?: FetchFunction
}

export async function send(descriptor: ProviderDescriptor, connection: Connection, path: string, token: string, init: RequestInit & { headers: Readonly<Record<string, string>> }) {
  const endpoint = descriptor.endpoint
  const base = (connection.baseUrl ?? endpoint.baseUrl).replace(/\/+$/, "")
  return (connection.fetch ?? fetch)(base + path, {
    ...init,
    redirect: connection.baseUrl === undefined ? endpoint.redirect : "error",
    headers: { ...init.headers, ...endpoint.headers(token) },
  })
}

export function responseRequestId(response: Response, descriptor: ProviderDescriptor, token: string): string | null {
  const header = descriptor.endpoint.requestIdHeader
  if (header === null) return null
  const id = response.headers.get(header)
  return descriptor.auth.kind === "env-key" ? id?.replaceAll(token, "[REDACTED]") ?? null : id
}

export interface StreamWire {
  readonly jsonErrorOnSuccess?: boolean
  readonly path: (request: ModelRequest) => string
  readonly httpError: (response: Response, text: string | undefined, requestId: string | null) => ProviderError
  readonly mapper: (requestId: string | null) => {
    readonly done: boolean
    frame(frame: SseEvent): StreamEvent[]
    fail(error: ProviderError): StreamEvent[]
    end(): StreamEvent[]
  }
}

/** One controller covers caller abort, idle timeout, and a consumer that stops reading early. */
export async function* httpStream(
  descriptor: ProviderDescriptor,
  connection: Connection,
  wire: StreamWire,
  request: ModelRequest,
  encoded: { body: string; headers: Readonly<Record<string, string>> },
  signal: AbortSignal,
  idleTimeoutMs = 300_000,
): AsyncGenerator<StreamEvent> {
  if (signal.aborted) return
  let token: string
  try {
    token = await connection.accessToken()
  } catch (cause) {
    if (!signal.aborted) yield { type: "error", error: tokenFailure(cause) }
    return
  }
  if (signal.aborted) return
  const scrub = (error: ProviderError) => safeError(error, descriptor.auth, token)
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal.addEventListener("abort", onAbort, { once: true })
  let reader: { cancel(): Promise<void> } | undefined
  try {
    const sent = send(descriptor, connection, wire.path(request), token, { method: "POST", ...encoded, signal: controller.signal })
    const opened = await withTimeout(sent, controller, idleTimeoutMs)
    if (signal.aborted) return
    if (opened instanceof Timeout || opened instanceof Failure) {
      const error = opened instanceof Timeout
        ? makeProviderError("transport", `no response within ${idleTimeoutMs} ms`, { reason: "stalled" })
        : makeProviderError("transport", `the request failed: ${describe(opened.cause)}`)
      yield { type: "error", error: scrub(error) }
      return
    }
    const response = opened
    const requestId = responseRequestId(response, descriptor, token)
    const jsonError = wire.jsonErrorOnSuccess && response.status === 200
      && response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json"
    if (!response.ok || jsonError) {
      const text = await withTimeout(response.text(), controller, idleTimeoutMs)
      if (signal.aborted) return
      yield { type: "error", error: scrub(wire.httpError(response, typeof text === "string" ? text : undefined, requestId)) }
      return
    }
    if (!response.body) {
      yield {
        type: "error",
        error: makeProviderError("incomplete_stream", "the response had no body", { status: response.status, requestId }),
      }
      return
    }

    const mapper = wire.mapper(requestId)
    const parser = new SseParser()
    const body = response.body.getReader()
    reader = body
    while (!mapper.done) {
      const chunk = await withTimeout(body.read(), controller, idleTimeoutMs)
      if (signal.aborted) return
      if (chunk instanceof Timeout) {
        yield* mapper.fail(
          makeProviderError("transport", `no data from the stream for ${idleTimeoutMs} ms`, { reason: "stalled" }),
        )
        break
      }
      if (chunk instanceof Failure) {
        yield* mapper.fail(scrub(makeProviderError("transport", `the connection failed mid-stream: ${describe(chunk.cause)}`)))
        break
      }
      const frames = chunk.done ? parser.end() : parser.push(chunk.value)
      for (const frame of frames) {
        if (signal.aborted) return
        for (const event of mapper.frame(frame)) yield event.type === "error" ? { ...event, error: scrub(event.error) } : event
        if (mapper.done) break
      }
      if (chunk.done) {
        yield* mapper.end()
        break
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort)
    // Stops the body after a terminal event, on abort, and when the consumer stops reading early.
    controller.abort()
    reader?.cancel().catch(() => {})
  }
}

/**
 * Waits for `promise`, at most `idleTimeoutMs`. On timeout the request is
 * cancelled. A rejection is returned as a `Failure`, never thrown, and the
 * wait ends as soon as the request is cancelled.
 */
async function withTimeout<T>(promise: Promise<T>, controller: AbortController, idleTimeoutMs: number): Promise<T | Timeout | Failure> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const timeout = new Promise<Timeout>((resolve) => {
    timer = setTimeout(() => {
      resolve(new Timeout())
      controller.abort()
    }, idleTimeoutMs)
  })
  const aborted = new Promise<Failure>((resolve) => {
    onAbort = () => resolve(new Failure(controller.signal.reason))
    if (controller.signal.aborted) onAbort()
    else controller.signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([promise.catch((cause: unknown) => new Failure(cause)), timeout, aborted])
  } finally {
    clearTimeout(timer)
    if (onAbort) controller.signal.removeEventListener("abort", onAbort)
  }
}

class Timeout {}
class Failure {
  constructor(readonly cause: unknown) {}
}

export function safeError(error: ProviderError, auth: ProviderDescriptor["auth"], key: string): ProviderError {
  if (auth.kind !== "env-key") return error
  const scrub = (value: string) => value.replaceAll(key, "[REDACTED]")
  return {
    ...error,
    message: error.kind === "auth" ? `Check ${auth.variable} and try again.` : scrub(error.message),
    code: error.code === null ? null : scrub(error.code),
    requestId: error.requestId === null ? null : scrub(error.requestId),
  }
}

/**
 * The token getter failed, so nothing was sent. It is the sign-in's failure (`auth`) unless the sign-in service
 * could not be reached to refresh the token (`AUTH_UNREACHABLE`): that says nothing about the sign-in, and is the
 * connection problem it would be had the request itself not got through, tried again like one. The error's `code`
 * is the sign-in's own (`AuthError.code`: `signed_out`, `invalid_grant`, `handed_in_expired`, ...), so that what
 * reads the error can tell the reasons apart without reading the message.
 */
export function tokenFailure(cause: unknown): ProviderError {
  const message = `no usable access token: ${describe(cause)}`
  const code = cause instanceof AuthError ? cause.code : undefined
  return makeProviderError(code === AUTH_UNREACHABLE ? "transport" : "auth", message, { code })
}

export function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message || cause.name
  return String(cause)
}
