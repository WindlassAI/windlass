import { isIPv4 } from "node:net"
import { ACCESS_TOKEN_FILE_ENV } from "../auth/handed-in.ts"
import { brand } from "../brand.ts"
import { BUILD_STAMP } from "../build-stamp.ts"

export const MODEL_BASE_URL_ENV = `${brand.envPrefix}MODEL_BASE_URL`
export const MODEL_ALLOWED_ORIGIN_ENV = `${brand.envPrefix}MODEL_ALLOWED_ORIGIN`

export function takeModelRelayEnv(env: NodeJS.ProcessEnv, hostEnvironment = BUILD_STAMP !== null || process.execArgv.includes("--no-env-file")) {
  if (env[MODEL_BASE_URL_ENV] !== undefined && !hostEnvironment)
    throw new Error(`Using ${MODEL_BASE_URL_ENV} from source requires bun --no-env-file so a project's .env cannot route model requests.`)
  const relay: Record<string, string> = {}
  for (const name of [MODEL_BASE_URL_ENV, MODEL_ALLOWED_ORIGIN_ENV]) {
    const value = env[name]
    if (value !== undefined) relay[name] = value
    delete env[name]
  }
  return relay
}

// The CLI forwards these settings to its engine. Tools inherit the stripped process environment.
let launchRelay: Readonly<Record<string, string>> = Object.freeze({})
export function launchModelRelayEnv() {
  if (process.env[MODEL_BASE_URL_ENV] !== undefined || process.env[MODEL_ALLOWED_ORIGIN_ENV] !== undefined)
    launchRelay = Object.freeze(takeModelRelayEnv(process.env))
  return launchRelay
}

export function modelRelayUrl(env: Readonly<NodeJS.ProcessEnv>, auth: "chatgpt-oauth" | "env-key", tokenFile: string | null): string | undefined {
  const value = env[MODEL_BASE_URL_ENV]
  if (value === undefined) return undefined
  if (auth === "chatgpt-oauth" && tokenFile === null)
    throw new Error(`Using ${MODEL_BASE_URL_ENV} with ChatGPT requires ${ACCESS_TOKEN_FILE_ENV} to name the relay token file.`)
  const url = URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href))
    throw new Error(`${MODEL_BASE_URL_ENV} must be an HTTP or HTTPS base URL without credentials, query or fragment.`)
  const host = url.hostname
  const loopback = host === "localhost" || host === "[::1]" || (isIPv4(host) && host.startsWith("127."))
  if (!loopback && url.origin !== env[MODEL_ALLOWED_ORIGIN_ENV])
    throw new Error(`${MODEL_BASE_URL_ENV} must use loopback or the exact scheme, host and port in ${MODEL_ALLOWED_ORIGIN_ENV}.`)
  if (auth === "env-key" && url.protocol === "http:" && !loopback && !privateAddress(host))
    throw new Error(`${MODEL_BASE_URL_ENV} for an API key must use HTTPS outside loopback or a private IP address.`)
  return url.href.replace(/\/+$/, "")
}

// URL.hostname is canonical and brackets IPv6 literals. Trust only private address literals over HTTP.
function privateAddress(host: string): boolean {
  if (isIPv4(host)) return /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)
  return /^\[f[cd][0-9a-f]{2}:/.test(host)
}
