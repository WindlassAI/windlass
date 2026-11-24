import { brand } from "../brand.ts"
import type { CatalogOptions, ModelInfo } from "./catalog.ts"
import type { ProviderDescriptor } from "./descriptor.ts"
import { anthropic } from "./providers/anthropic.ts"
import { chatgpt } from "./providers/chatgpt.ts"
import { google } from "./providers/google.ts"
import { openai } from "./providers/openai.ts"
import { openrouter } from "./providers/openrouter.ts"

const providers = [chatgpt, openai, anthropic, google, openrouter] as const satisfies readonly ProviderDescriptor[]
export type ProviderProfile = (typeof providers)[number]["id"]
export const DEFAULT_PROFILE = chatgpt.id
export const PROVIDER_ENV = `${brand.envPrefix}PROVIDER`
export const PROVIDER_PROFILES = providers.map(({ id }) => id)

export function isProviderProfile(value: unknown): value is ProviderProfile {
  return PROVIDER_PROFILES.some((id) => id === value)
}

export function providerDescriptor(profile: ProviderProfile = DEFAULT_PROFILE): ProviderDescriptor {
  const descriptor = providers.find(({ id }) => id === profile)
  if (!descriptor) throw new Error(`unknown provider ${profile}`)
  return descriptor
}

export function ledgerProvider(id: string) {
  return providers.find((descriptor) => descriptor.ledgerId === id)
}

export const keyVariables: readonly string[] = providers.flatMap(({ auth }) => auth.kind === "env-key" ? [auth.variable] : [])
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
