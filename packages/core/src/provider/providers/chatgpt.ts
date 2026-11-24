import { ACCESS_TOKEN_FILE_ENV, HAND_IN_ADVICE, aboutHandedIn, handedInTokenFile } from "../../auth/handed-in.ts"
import { brand } from "../../brand.ts"
import { BUILD_STAMP } from "../../build-stamp.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { listPlanModels } from "../openai-catalog.ts"
import { openaiDefaults, openaiEndpoint } from "./openai.ts"

export const MODEL_BASE_URL_ENV = `${brand.envPrefix}MODEL_BASE_URL`
export const MODEL_ALLOWED_ORIGIN_ENV = `${brand.envPrefix}MODEL_ALLOWED_ORIGIN`

/** Resolve once, before any credential is read. The executable disables Bun's project dotenv loading at build time. */
export function modelEndpoint(env = process.env, hostEnvironment = BUILD_STAMP !== null || process.execArgv.includes("--no-env-file")): { baseUrl?: string } {
  const value = env[MODEL_BASE_URL_ENV]
  if (value === undefined) return {}
  if (!hostEnvironment) throw new Error(`Using ${MODEL_BASE_URL_ENV} from source requires bun --no-env-file so a project's .env cannot route model requests.`)
  if (handedInTokenFile(env) === null) throw new Error(`Using ${MODEL_BASE_URL_ENV} requires ${ACCESS_TOKEN_FILE_ENV} to name the relay token file.`)
  const url = URL.parse(value)
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || /[?#]/.test(url.href))
    throw new Error(`${MODEL_BASE_URL_ENV} must be an HTTP or HTTPS base URL without credentials, query or fragment.`)
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(url.hostname)
  if (!loopback && url.origin !== env[MODEL_ALLOWED_ORIGIN_ENV])
    throw new Error(`${MODEL_BASE_URL_ENV} must use loopback or the exact scheme, host and port in ${MODEL_ALLOWED_ORIGIN_ENV}.`)
  return { baseUrl: url.href.replace(/\/+$/, "") }
}

export const SIGN_IN_HINT = `run \`${brand.binary} login\` and finish the ChatGPT sign-in, then try again`
export const signedOut = "Signed out: sign in again to continue."
export const handedInFailure = `Signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used. Hand in a new token to continue.`

export const chatgptAuth = { kind: "chatgpt-oauth", handedInTokenFile, relayEndpoint: modelEndpoint } as const

export const chatgpt = {
  id: "chatgpt",
  ledgerId: "openai-responses",
  auth: chatgptAuth,
  endpoint: { ...openaiEndpoint, redirect: "follow", requestIdHeader: "x-oai-request-id" },
  wire: "responses",
  wireOptions: { sessionIdHeader: "session-id", forceReasoning: true },
  defaults: openaiDefaults,
  catalog: {
    listModels: listPlanModels,
    contextWindow: async (model, models) => (await models()).find((entry) => entry.slug === model)?.contextWindow ?? null,
    validateDefault: false,
  },
  billing: "subscription",
  authMethod: {
    name: "Sign in with ChatGPT",
    get description() {
      return handedInTokenFile() === null
        ? `Uses the ChatGPT plan sign-in saved on this machine. To sign in, ${SIGN_IN_HINT}.`
        : `Uses the access token of a ChatGPT plan sign-in held elsewhere, handed in through ${ACCESS_TOKEN_FILE_ENV}. ${HAND_IN_ADVICE}`
    },
    failureText: () => handedInTokenFile() === null ? signedOut : handedInFailure,
    requiredText: (message) => aboutHandedIn(message) ? message : `${message} To sign in, ${SIGN_IN_HINT}.`,
  },
} as const satisfies ProviderDescriptor
