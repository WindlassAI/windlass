import { ACCESS_TOKEN_FILE_ENV, HAND_IN_ADVICE, aboutHandedIn, handedInTokenFile } from "../../auth/handed-in.ts"
import { brand } from "../../brand.ts"
import type { ProviderDescriptor } from "../descriptor.ts"
import { launchModelRelayEnv, modelRelayUrl, takeModelRelayEnv } from "../relay.ts"
import { listPlanModels } from "../openai-catalog.ts"
import { openaiDefaults, openaiEndpoint } from "./openai.ts"

export const SIGN_IN_HINT = `run \`${brand.binary} login\` and finish the ChatGPT sign-in, then try again`
export const signedOut = "Signed out: sign in again to continue."
export const handedInFailure = `Signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used. Hand in a new token to continue.`

export { MODEL_ALLOWED_ORIGIN_ENV, MODEL_BASE_URL_ENV } from "../relay.ts"

export function modelEndpoint(env?: NodeJS.ProcessEnv, hostEnvironment?: boolean): { baseUrl?: string } {
  const relay = env === undefined ? launchModelRelayEnv() : takeModelRelayEnv({ ...env }, hostEnvironment)
  const baseUrl = modelRelayUrl(relay, "chatgpt-oauth", handedInTokenFile(env))
  return baseUrl === undefined ? {} : { baseUrl }
}

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
