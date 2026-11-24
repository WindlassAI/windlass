/**
 * What the model picker offers: the models of every provider with a usable
 * credential, grouped by provider, the session's first; and the efforts of the
 * model chosen, as its catalog lists them. A session stays with the provider it
 * started with, so a model of another provider is a new session.
 */
import type { ModelChoice, ModelListing, ProviderChoice } from "./backend.ts"
import type { DialogItem } from "./views.ts"

/** Separates the provider from the model in a picker item's ID (neither has one). */
const SEPARATOR = "\u0000"

/** The listing's groups: every provider it lists, else the session's own. */
export function providerGroups(listing: ModelListing): readonly ProviderChoice[] {
  return listing.providers ?? [listing]
}

export function modelItems(groups: readonly ProviderChoice[], current: { readonly provider: string | null; readonly model: string | null }): DialogItem[] {
  const grouped = groups.length > 1
  return groups.flatMap((group) =>
    group.models.map((model) => ({
      id: `${group.provider}${SEPARATOR}${model.id}`,
      label: model.id,
      detail: [model.name === model.id ? null : model.name, model.contextWindow === null ? null : `${Math.round(model.contextWindow / 1000)}k context`, model.isDefault ? "default" : null].filter((part) => part !== null).join(" · "),
      current: model.id === current.model && (current.provider === null || group.provider === current.provider),
      ...(grouped && { group: group.provider }),
    })),
  )
}

/** The provider and the model a picker item names. */
export function chosenModel(groups: readonly ProviderChoice[], id: string): { readonly provider: string; readonly model: ModelChoice } | null {
  const [provider, slug] = id.split(SEPARATOR)
  const model = groups.find((group) => group.provider === provider)?.models.find((candidate) => candidate.id === slug)
  return model === undefined ? null : { provider: provider!, model }
}

/** The efforts the model's catalog lists, and its own default first; `null` when it has none (nothing to ask). */
export function effortItems(model: ModelChoice, current: { readonly effort: string | null; readonly sameModel: boolean }): DialogItem[] | null {
  if (model.efforts.length === 0) return null
  return [
    { id: "default", label: "default", detail: model.defaultEffort === null ? "the model's own" : `the model's own (${model.defaultEffort})`, current: current.effort === null },
    ...model.efforts.map((value) => ({ id: value, label: value, current: current.effort === value && current.sameModel })),
  ]
}
