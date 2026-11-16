/**
 * The `sandbox` configuration section, in the style of `config/schema.ts`
 * (every key optional, unknown keys rejected).
 *
 *   "sandbox": { "home": "session" }
 *
 * - `home` (default `"user"`): what a sandboxed command finds at the home
 *   directory's path. `"user"`: the user's home, read-only. `"session"`: on
 *   Linux a home of the session's own, with the user's entries read-only in
 *   it (`bwrap.ts`, `homeArgs`).
 *
 * Who may say what: with a session's home, a write under the home that would
 * fail succeeds and is kept for the session only, and every command starts
 * slower by a time that grows with the home. That is the user's to choose, as
 * the approval mode is, so only the user's own file, or the client that
 * opens the session for the user, turns it on; a project's file can only
 * turn it off (`"home": "user"`).
 */
import { ConfigError } from "../config/schema.ts"
import { SANDBOX_HOME_KEY } from "./command.ts"

export const sandboxHomeChoices = ["user", "session"] as const
export type SandboxHomeChoice = (typeof sandboxHomeChoices)[number]

export interface SandboxConfigSection {
  readonly home?: SandboxHomeChoice
}

const KEYS = ["home"]

/** Validates the value of the `sandbox` key of one file. Throws `ConfigError` naming the file and path. */
export function parseSandboxSection(value: unknown, file: string): SandboxConfigSection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError(file, "sandbox", "expected an object")
  const record = value as Record<string, unknown>
  const unknown = Object.keys(record).find((key) => !KEYS.includes(key))
  if (unknown !== undefined) throw new ConfigError(file, `sandbox.${unknown}`, `unknown key "${unknown}"; known keys: ${KEYS.join(", ")}`)
  if (record.home === undefined) return {}
  if (!(sandboxHomeChoices as readonly unknown[]).includes(record.home)) throw new ConfigError(file, SANDBOX_HOME_KEY, `expected one of: ${sandboxHomeChoices.join(", ")}`)
  return { home: record.home as SandboxHomeChoice }
}

/**
 * Whether a session's sandboxed commands get a home of the session's own.
 * `user` is the user file's section, `session` what the client that opened
 * the session chose for it (it counts as the user's and goes on top), and
 * `project` the project file's, which can only turn the home off. `ignored`
 * is set when the project's file asked for a session's home that the user
 * did not: one line for the user.
 */
export function resolveSandboxHome(sections: {
  readonly user: SandboxConfigSection | undefined
  readonly session: SandboxHomeChoice | null
  readonly project: SandboxConfigSection | undefined
}): { readonly home: SandboxHomeChoice; readonly ignored: string | null } {
  const chosen = sections.session ?? sections.user?.home ?? "user"
  if (chosen === "user")
    return { home: "user", ignored: sections.project?.home === "session" ? `${SANDBOX_HOME_KEY} "session" (yours is "user")` : null }
  return { home: sections.project?.home === "user" ? "user" : "session", ignored: null }
}
