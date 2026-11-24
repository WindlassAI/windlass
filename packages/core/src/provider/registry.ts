import { ACCESS_TOKEN_FILE_ENV, HAND_IN_ADVICE, aboutHandedIn, handedInTokenFile } from "../auth/handed-in.ts"
import { brand } from "../brand.ts"
import { modelEndpoint } from "./relay.ts"
import { userAgent } from "../version.ts"
import type { CatalogOptions, ModelInfo } from "./catalog.ts"
import { apiContextWindow, listPlanModels, listPublicModels } from "./openai-catalog.ts"

export type ProviderProfile = string
export type Wire = "responses" | "anthropic" | "gemini" | "chat"

/** A handed-in token can select ChatGPT before consulting the user's default provider. */
export const chatgptAuth = { kind: "chatgpt-oauth" as const, handedInTokenFile, relayEndpoint: modelEndpoint }

export interface ProviderDescriptor {
  readonly id: ProviderProfile
  readonly wire: Wire
  readonly ledgerId: string
  readonly auth: typeof chatgptAuth | { readonly kind: "env-key"; readonly variable: string }
  readonly endpoint: {
    readonly baseUrl: string
    readonly headers: (credential: string) => Record<string, string>
    readonly redirect: "error" | "follow"
    readonly requestIdHeader: string
  }
  readonly sessionIdHeader: string | null
  readonly forceReasoning: boolean
  readonly catalog: {
    readonly listModels: (descriptor: ProviderDescriptor, options: CatalogOptions) => Promise<ModelInfo[]>
    readonly contextWindow: (model: string, models: () => Promise<readonly ModelInfo[]>) => number | null | Promise<number | null>
    /** Validate even default settings and treat an empty listing as authoritative. */
    readonly validateDefault: boolean
  }
  readonly defaults: { readonly model: string; readonly titleModel: string | null; readonly titleEffort: string | null }
  readonly mapEffort: (model: string, effort: string | null) => string | null
  readonly billing: "subscription" | "metered"
  readonly authMethod: {
    readonly name: string
    readonly description: string
    readonly failureText: (message: string) => string
    readonly requiredText: (message: string) => string
  }
  readonly familyPrompt: (model: string) => string
}

export const DEFAULT_PROFILE = "chatgpt"
export const PROVIDER_ENV = `${brand.envPrefix}PROVIDER`
export const RESPONSES_BASE_URL = "https://api.openai.com/v1"
export const SIGN_IN_HINT = `run \`${brand.binary} login\` and finish the ChatGPT sign-in, then try again`
export const signedOut = "Signed out: sign in again to continue."
export const handedInFailure = `Signed out: the access token handed in through ${ACCESS_TOKEN_FILE_ENV} was rejected or cannot be used. Hand in a new token to continue.`

const endpoint = {
  baseUrl: RESPONSES_BASE_URL,
  headers: (token: string) => ({ authorization: `Bearer ${token}`, "user-agent": userAgent() }),
}

// Family add-ons are shared across providers. Start with the base prompt for every model.
export function familyPrompt(_model: string): string {
  return ""
}

const responses = {
  wire: "responses" as const,
  defaults: { model: "gpt-6.1-sol", titleModel: "gpt-6-luna", titleEffort: "low" },
  mapEffort: (_model: string, effort: string | null) => effort,
  familyPrompt,
}

const openaiKey = "OPENAI_API_KEY"
export const providers: readonly ProviderDescriptor[] = [
  {
    ...responses,
    id: DEFAULT_PROFILE,
    ledgerId: "openai-responses",
    auth: chatgptAuth,
    endpoint: { ...endpoint, redirect: "follow", requestIdHeader: "x-oai-request-id" },
    sessionIdHeader: "session-id",
    forceReasoning: true,
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
  },
  {
    ...responses,
    id: "openai",
    ledgerId: "openai-api-key",
    auth: { kind: "env-key", variable: openaiKey },
    endpoint: { ...endpoint, redirect: "error", requestIdHeader: "x-request-id" },
    sessionIdHeader: null,
    forceReasoning: false,
    catalog: { listModels: listPublicModels, contextWindow: apiContextWindow, validateDefault: true },
    billing: "metered",
    authMethod: {
      name: "OpenAI API key",
      description: `Set ${openaiKey} to use the openai provider.`,
      failureText: (message) => message,
      requiredText: (message) => message,
    },
  },
]

export const PROVIDER_PROFILES = providers.map(({ id }) => id)

export function providerDescriptor(profile: ProviderProfile = DEFAULT_PROFILE): ProviderDescriptor {
  const descriptor = providers.find(({ id }) => id === profile)
  if (!descriptor) throw new Error(`unknown provider ${profile}`)
  return descriptor
}

export function ledgerProvider(id: string) {
  return providers.find((descriptor) => descriptor.ledgerId === id)
}

export const keyVariables = providers.flatMap(({ auth }) => auth.kind === "env-key" ? [auth.variable] : [])
export type ProviderKeys = Readonly<Record<string, string>>

/** Remove credentials before the environment can be passed to a subprocess. */
export function takeProviderKeys(env: Record<string, string | undefined>): ProviderKeys {
  const keys: Record<string, string> = {}
  for (const variable of keyVariables) {
    const key = env[variable]
    if (key !== undefined) keys[variable] = key
    delete env[variable]
  }
  return keys
}

export function listModels(options: CatalogOptions): Promise<ModelInfo[]> {
  const descriptor = providerDescriptor(options.profile)
  return descriptor.catalog.listModels(descriptor, options)
}
