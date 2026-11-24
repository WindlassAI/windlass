/**
 * Which providers a model can be picked from: the selected one, and every
 * other one with a usable credential. A new session can name its provider and
 * stays with it.
 */
import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHarness } from "../../src/assembly.ts"
import { PROVIDER_ENV, keyVariables } from "../../src/provider/registry.ts"

const root = realpathSync(mkdtempSync(join(tmpdir(), "wl-providers-")))
const saved = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, [PROVIDER_ENV]: process.env[PROVIDER_ENV] }
// No ChatGPT sign-in, configuration or provider choice of the machine the tests run on.
process.env.XDG_DATA_HOME = join(root, "share")
process.env.XDG_CONFIG_HOME = join(root, "config")
delete process.env[PROVIDER_ENV]
afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(root, { recursive: true, force: true })
})

let count = 0
const harnessWith = (profile: string | undefined, keys: Record<string, string>) =>
  createHarness({
    dataDir: join(root, `data-${(count += 1)}`),
    ...(profile === undefined ? {} : { profile }),
    // Every key of the registry empty unless given: none of the launching process's keys.
    apiKeys: { ...Object.fromEntries(keyVariables.map((variable) => [variable, ""])), ...keys },
    models: async () => [{ id: "gpt-test", name: "gpt-test", efforts: [], defaultEffort: null, contextWindow: null, supportedInApi: true }],
    log: () => {},
    engine: { discover: () => [], loadConfig: null, approval: null },
  })

test("the selected provider first, then those with a usable credential: a key that is set, not an empty one", async () => {
  const keyed = harnessWith("chatgpt", { OPENAI_API_KEY: "sk-test" })
  const keyless = harnessWith("chatgpt", {})
  // Not signed in to ChatGPT: an OpenAI key alone.
  const openai = harnessWith("openai", { OPENAI_API_KEY: "sk-test" })
  try {
    expect(await keyed.availableProviders()).toEqual(["chatgpt", "openai"])
    expect(await keyless.availableProviders()).toEqual(["chatgpt"])
    expect(await openai.availableProviders()).toEqual(["openai"])
  } finally {
    await Promise.all([keyed.close(), keyless.close(), openai.close()])
  }
})

test("a new session names its provider and is pinned to it", async () => {
  // Not chosen explicitly: an explicit choice refuses to open a session of another provider.
  const harness = harnessWith(undefined, { OPENAI_API_KEY: "sk-test" })
  try {
    const cwd = join(root, "work")
    const own = harness.engine.createSession({ cwd, settings: { model: "gpt-test", reasoningEffort: null } })
    const other = harness.engine.createSession({ cwd, settings: { model: "gpt-test", reasoningEffort: null }, provider: "openai" })
    expect(harness.engine.sessionProfile(own.id)).toBe("chatgpt")
    expect(harness.engine.sessionProfile(other.id)).toBe("openai")
    expect(other.projection().session.provider).toBe("openai")
  } finally {
    await harness.close()
  }
})
