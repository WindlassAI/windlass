import { brand } from "../brand.ts"
import { BUILD_STAMP } from "../build-stamp.ts"

export const MODEL_BASE_URL_ENV = `${brand.envPrefix}MODEL_BASE_URL`
export const MODEL_ALLOWED_ORIGIN_ENV = `${brand.envPrefix}MODEL_ALLOWED_ORIGIN`

/** Resolve once, before any credential is read. The executable disables Bun's project dotenv loading at build time. */
export function modelEndpoint(env = process.env, hostEnvironment = BUILD_STAMP !== null || process.execArgv.includes("--no-env-file")): { baseUrl?: string } {
  const value = env[MODEL_BASE_URL_ENV]
  if (value === undefined) return {}
  if (!hostEnvironment) throw new Error(`Using ${MODEL_BASE_URL_ENV} from source requires bun --no-env-file so a project's .env cannot route model requests.`)
  const url = URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href))
    throw new Error(`${MODEL_BASE_URL_ENV} must be an HTTP or HTTPS base URL without credentials, query or fragment.`)
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (!loopback && url.origin !== env[MODEL_ALLOWED_ORIGIN_ENV])
    throw new Error(`${MODEL_BASE_URL_ENV} must use loopback or the exact scheme, host and port in ${MODEL_ALLOWED_ORIGIN_ENV}.`)
  return { baseUrl: url.href.replace(/\/+$/, "") }
}
