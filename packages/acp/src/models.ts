/**
 * The account's models as the ACP server offers them: asked for once per
 * process and remembered, because every session's config options and every
 * usage update need them. A failure is logged and answered with an empty
 * list (and asked again next time), so a client can always open a session.
 */
import type { Harness, ModelEntry, ProviderProfile } from "@windlass/core"
import { type Logger, describeError } from "./log.ts"

const MODEL_LIST_TIMEOUT_MS = 5000

export class ModelCatalog {
  private pending: Promise<readonly ModelEntry[]> | null = null
  private known: readonly ModelEntry[] = []

  constructor(
    private readonly harness: Harness,
    private readonly log: Logger,
    private readonly profile: ProviderProfile,
  ) {}

  /** The models already listed, without waiting: empty until `list()` has answered once. */
  cached(): readonly ModelEntry[] {
    return this.known
  }

  list(): Promise<readonly ModelEntry[]> {
    this.pending ??= this.harness.listModels(AbortSignal.timeout(MODEL_LIST_TIMEOUT_MS), this.profile).then(
      (models) => {
        this.known = models
        return models
      },
      (error: unknown) => {
        this.log.warn(`could not list the models: ${describeError(error)}`)
        this.pending = null
        return []
      },
    )
    return this.pending
  }
}

const catalogs = new WeakMap<Harness, Map<ProviderProfile, ModelCatalog>>()

export function catalogOf(harness: Harness, log: Logger, profile = harness.profile): ModelCatalog {
  const byProfile = catalogs.get(harness) ?? new Map<ProviderProfile, ModelCatalog>()
  catalogs.set(harness, byProfile)
  let catalog = byProfile.get(profile)
  if (catalog === undefined) {
    catalog = new ModelCatalog(harness, log, profile)
    byProfile.set(profile, catalog)
  }
  return catalog
}
