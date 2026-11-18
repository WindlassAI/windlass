/**
 * Required checks as pure functions: which checks a session has and whose
 * each is (`planChecks`), what a client may send (`sessionChecks`), how a
 * required check's patterns are matched and fingerprinted, what the evidence
 * carries of a check (its origin, whether it is required, the end of its
 * output), and the report's line about a failing required check.
 */
import { describe, expect, test } from "bun:test"
import { type CheckConfig, type ConfigFile, mergeConfigFiles, resolveConfig } from "../../src/config/schema.ts"
import { DecodeError } from "../../src/validate.ts"
import {
  OUTPUT_TAIL_LIMITS,
  buildEvidence,
  checkEvidence,
  couldNotStart,
  filesFor,
  fingerprintCheck,
  outputTailOf,
  planChecks,
  renderReport,
  selectChecks,
  sessionChecks,
  verificationEvidence,
} from "../../src/verify/index.ts"
import type { CheckOutput, CheckResult, CheckStatus } from "../../src/verify/run.ts"

const check = (name: string, command = "true", extra: Partial<CheckConfig> = {}): CheckConfig => ({ name, command, timeoutSeconds: 120, when: null, ...extra })
const plan = (user: ConfigFile | null, project: ConfigFile | null, session: readonly CheckConfig[] | null = null) =>
  planChecks({ config: resolveConfig(mergeConfigFiles(user, project)), files: { user, project }, session })
const names = (checks: readonly { readonly name: string }[]) => checks.map((item) => item.name)

function output(text: string): CheckOutput {
  const bytes = new TextEncoder().encode(text)
  const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
  return { totalBytes: bytes.length, totalLines: lines, path: "/spill/check.log", savedBytes: bytes.length, source: { head: bytes, tail: bytes, tailAtLineStart: true, totalBytes: bytes.length, totalLines: lines } }
}

function result(config: CheckConfig, status: CheckStatus, text = ""): CheckResult {
  return { name: config.name, command: config.command, timeoutSeconds: config.timeoutSeconds, status, exitCode: status === "passed" ? 0 : 1, signal: null, interruptedBy: null, startError: null, durationMs: 3, output: output(text) }
}

describe("planChecks", () => {
  const USER: ConfigFile = { requiredChecks: [{ name: "test", command: "bun test" }], checks: [{ name: "lint", command: "bun lint" }] }

  test("without a required check the plan is the configuration's checks under the merged verify, and says whose they are", () => {
    expect(plan({ checks: [{ name: "lint", command: "bun lint" }] }, null)).toEqual({
      checks: [{ ...check("lint", "bun lint"), origin: "user", required: false }],
      mode: "gate",
      maxRounds: 3,
      required: null,
      ignored: null,
      shadowed: [],
    })
    // A project's list replaces the user's whole: every check of the list is then the project's.
    const replaced = plan({ checks: [{ name: "lint", command: "bun lint" }] }, { checks: [{ name: "unit", command: "make unit" }], verify: { mode: "report", maxRounds: 1 } })
    expect(replaced.checks).toEqual([{ ...check("unit", "make unit"), origin: "project", required: false }])
    expect(replaced).toMatchObject({ mode: "report", maxRounds: 1, required: null })
    // The origin is not known where only the merged configuration is.
    expect(planChecks({ config: resolveConfig({ checks: [{ name: "lint", command: "bun lint" }] }), files: null, session: null }).checks).toEqual([{ ...check("lint", "bun lint"), origin: null, required: false }])
  })

  test("the user's required checks come first, and a project's list replaces only the user's plain one", () => {
    const made = plan(USER, { checks: [{ name: "unit", command: "make unit" }] })
    expect(made.checks).toEqual([
      { ...check("test", "bun test"), origin: "user", required: true },
      { ...check("unit", "make unit"), origin: "project", required: false },
    ])
    expect(made.required).toEqual({ names: ["test"], maxRounds: 3 })
    // With no project file the user's own list follows the required ones.
    expect(names(plan(USER, null).checks)).toEqual(["test", "lint"])
  })

  test("a project's empty list and verify off leave the required checks, and its maxRounds is not theirs", () => {
    const made = plan({ ...USER, verify: { maxRounds: 5 } }, { checks: [], verify: { mode: "off", maxRounds: 1 } })
    expect(made.checks).toEqual([{ ...check("test", "bun test"), origin: "user", required: true }])
    expect(made).toMatchObject({ mode: "off", maxRounds: 1, required: { names: ["test"], maxRounds: 5 } })
    // Off takes the configuration's own checks out, whoever wrote it: a required check is taken out of its list to stop it.
    expect(names(plan({ ...USER, verify: { mode: "off" } }, null).checks)).toEqual(["test"])
  })

  test("the client's checks are required too and follow the user's; a name in both is the client's", () => {
    const made = plan({ requiredChecks: [{ name: "test", command: "bun test" }, { name: "types", command: "tsc" }] }, null, [check("test", "make test", { timeoutSeconds: 60 }), check("build", "make")])
    expect(made.checks).toEqual([
      { ...check("types", "tsc"), origin: "user", required: true },
      { ...check("test", "make test", { timeoutSeconds: 60 }), origin: "session", required: true },
      { ...check("build", "make"), origin: "session", required: true },
    ])
    expect(made.required?.names).toEqual(["types", "test", "build"])
    // With no file anywhere, the client's are all there is.
    expect(planChecks({ config: resolveConfig({}), files: { user: null, project: null }, session: [check("build", "make")] }).checks).toEqual([{ ...check("build", "make"), origin: "session", required: true }])
  })

  test("a project's check with a required check's name is left out, and its requiredChecks are not followed", () => {
    const made = plan(USER, { checks: [{ name: "test", command: "true" }, { name: "unit", command: "make unit" }], requiredChecks: [{ name: "unit", command: "true" }, { name: "extra", command: "true" }] })
    expect(made.checks).toEqual([
      { ...check("test", "bun test"), origin: "user", required: true },
      { ...check("unit", "make unit"), origin: "project", required: false },
    ])
    expect(made.shadowed).toEqual(["test"])
    expect(made.ignored).toBe("requiredChecks (unit, extra)")
    // A project that names required checks and nothing else has none.
    expect(plan(null, { requiredChecks: [{ name: "extra", command: "true" }] })).toMatchObject({ checks: [], required: null, ignored: "requiredChecks (extra)" })
  })
})

describe("sessionChecks", () => {
  test("a client's list is read as a file's is, with the defaults", () => {
    expect(sessionChecks([{ name: "test", command: "bun test" }, { name: "types", command: "tsc", timeoutSeconds: 30, when: ["src/**"], outputTail: "always" }], "requiredChecks")).toEqual([
      check("test", "bun test"),
      check("types", "tsc", { timeoutSeconds: 30, when: ["src/**"], outputTail: "always" }),
    ])
    expect(sessionChecks([], "requiredChecks")).toEqual([])
  })

  test("what a file refuses is refused, with the path of the bad value", () => {
    const bad: [unknown, string][] = [
      ["bun test", "requiredChecks: expected array"],
      [[{ name: "test" }], "requiredChecks[0].command: expected a value"],
      [[{ name: "a b", command: "true" }], "requiredChecks[0].name: expected a name of letters"],
      [[{ name: "test", command: "true", timeoutSeconds: 0 }], "requiredChecks[0].timeoutSeconds: expected integer"],
      [[{ name: "test", command: "true", when: [] }], "requiredChecks[0].when: expected at least one glob pattern"],
      [[{ name: "test", command: "true", outputTail: "never" }], 'requiredChecks[0].outputTail: expected "failure" | "always", got "never"'],
      [[{ name: "test", command: "true", sandbox: false }], "requiredChecks[0].sandbox: "],
      [[{ name: "test", command: "true" }, { name: "test", command: "false" }], 'requiredChecks[1].name: expected a name not already used (requiredChecks[0] is "test")'],
    ]
    for (const [value, message] of bad) {
      let thrown: unknown
      try {
        sessionChecks(value, "requiredChecks")
      } catch (error) {
        thrown = error
      }
      expect(thrown, message).toBeInstanceOf(DecodeError)
      expect((thrown as DecodeError).message, message).toStartWith(message)
    }
  })
})

describe("a required check's patterns", () => {
  const changed = ["README.md", "packages/a/src/x.ts", "packages/b/src/y.ts", "src/z.ts"]

  test("are matched in the session's working directory, as its prefix among the project's paths says", () => {
    const here = { ...check("test", "bun test", { when: ["src/**"] }), required: true, under: "packages/a/" }
    expect(filesFor(here, changed)).toEqual(["packages/a/src/x.ts"])
    // The same patterns without a prefix are the project directory's, as any check's are.
    expect(filesFor(check("test", "bun test", { when: ["src/**"] }), changed)).toEqual(["src/z.ts"])
    expect(selectChecks([here, { ...here, name: "docs", when: ["docs/**"] }], changed).map((item) => item.name)).toEqual(["test"])
    // Without patterns any change selects it.
    expect(filesFor({ ...here, when: null }, changed)).toEqual(changed)
  })

  test("are part of its fingerprint, with its being required: another check's pass never stands for it", async () => {
    const plain = check("test", "bun test", { when: ["src/**"] })
    const own = await fingerprintCheck(plain, [], "/nowhere")
    expect(await fingerprintCheck({ ...plain, origin: "project", required: false }, [], "/nowhere")).toBe(own)
    const required = await fingerprintCheck({ ...plain, required: true, under: "" }, [], "/nowhere")
    expect(required).not.toBe(own)
    expect(await fingerprintCheck({ ...plain, required: true, under: "packages/a/" }, [], "/nowhere")).not.toBe(required)
  })
})

describe("the end of a check's output", () => {
  test("is the whole output when it is short", () => {
    expect(outputTailOf(output("1 fail\n"))).toEqual({ text: "1 fail\n", truncated: false })
    expect(outputTailOf(output(""))).toEqual({ text: "", truncated: false })
  })

  test("is the last lines within the limits, from a line start, and says that there was more", () => {
    const lines = Array.from({ length: 500 }, (_, index) => `line ${index + 1} of the output`)
    const tail = outputTailOf(output(`${lines.join("\n")}\n`))
    expect(tail.truncated).toBe(true)
    expect(tail.text.endsWith("line 500 of the output\n")).toBe(true)
    expect(tail.text.startsWith("line ")).toBe(true)
    expect(tail.text.split("\n").length - 1).toBeLessThanOrEqual(OUTPUT_TAIL_LIMITS.maxLines)
    expect(new TextEncoder().encode(tail.text).length).toBeLessThanOrEqual(OUTPUT_TAIL_LIMITS.maxBytes)
    // Many short lines: the line limit decides. A few long ones: the byte limit does.
    expect(outputTailOf(output("x\n".repeat(1000))).text).toBe("x\n".repeat(OUTPUT_TAIL_LIMITS.maxLines))
    const long = outputTailOf(output(`${"y".repeat(3000)}\n`.repeat(4)))
    expect(long).toEqual({ text: `${"y".repeat(3000)}\n`, truncated: true })
  })

  test("inside one line longer than the limit, starts on a character and splits no redaction placeholder", () => {
    const tail = outputTailOf(output(`${"é".repeat(5000)}`))
    expect(tail.truncated).toBe(true)
    expect(tail.text).toBe("é".repeat(OUTPUT_TAIL_LIMITS.maxBytes / 2))
    // A placeholder across the cut is left out whole: the tail never begins with half of one.
    const split = outputTailOf(output(`${"a".repeat(1000)}[REDACTED:env]${"b".repeat(OUTPUT_TAIL_LIMITS.maxBytes - 5)}`))
    expect(split.text).toBe("b".repeat(OUTPUT_TAIL_LIMITS.maxBytes - 5))
  })
})

describe("the evidence of a run", () => {
  const checks = [
    { ...check("test", "bun test"), origin: "session" as const, required: true },
    { ...check("lint", "bun lint", { outputTail: "always" }), origin: "project" as const, required: false },
    { ...check("types", "tsc"), origin: "project" as const, required: false },
    { ...check("docs", "make docs", { when: ["docs/**"] }), origin: "user" as const, required: true },
  ]
  const fingerprints = { test: "f1", lint: "f2", types: "f3", docs: "f4" }

  test("says of each check whose it is and whether it is required, and carries the end of a failing output", () => {
    const evidence = buildEvidence({
      run: 1,
      afterSeq: 7,
      changedFiles: ["a.ts"],
      checks,
      results: [result(checks[0]!, "failed", "2 pass\n1 fail\n"), result(checks[1]!, "passed", "no problems\n"), result(checks[2]!, "passed", "checked 4 files\n")],
      fingerprints,
      reused: [{ check: checks[3]!, fromSeq: 4 }],
    })
    expect(evidence.checks.map(({ name, origin, required, outputTail, reusedFromSeq }) => ({ name, origin, required, outputTail, reusedFromSeq }))).toEqual([
      { name: "test", origin: "session", required: true, outputTail: { text: "2 pass\n1 fail\n", truncated: false }, reusedFromSeq: null },
      // A passing check's output is carried only when its configuration asks for it.
      { name: "lint", origin: "project", required: false, outputTail: { text: "no problems\n", truncated: false }, reusedFromSeq: null },
      { name: "types", origin: "project", required: false, outputTail: null, reusedFromSeq: null },
      // A pass carried over from an earlier run printed nothing in this one.
      { name: "docs", origin: "user", required: true, outputTail: null, reusedFromSeq: 4 },
    ])
    // The file that keeps all of the output is named as before.
    expect(evidence.checks[0]).toMatchObject({ outputPath: "/spill/check.log", outputBytes: 14, outputLines: 2 })
    expect(verificationEvidence(JSON.parse(JSON.stringify(evidence)), "")).toEqual(evidence)
  })

  test("what it carries of an output is redacted, and so is why a check could not start", () => {
    const redact = (text: string) => text.replaceAll("hunter2-made-up", "[REDACTED:env]")
    const evidence = buildEvidence({
      run: 1,
      afterSeq: 0,
      changedFiles: [],
      checks: checks.slice(0, 2),
      results: [result(checks[0]!, "failed", "login with hunter2-made-up failed\n"), couldNotStart(checks[1]!, "no directory /home/hunter2-made-up")],
      fingerprints,
      redact,
    })
    expect(evidence.checks[0]!.outputTail).toEqual({ text: "login with [REDACTED:env] failed\n", truncated: false })
    expect(evidence.checks[1]).toMatchObject({ status: "could_not_start", exitCode: null, startError: "no directory /home/[REDACTED:env]", outputTail: { text: "", truncated: false } })
    expect(JSON.stringify(evidence)).not.toContain("hunter2")
  })

  test("an interrupted check carries nothing, and a check of an engine without the files has no origin", () => {
    const plain = check("test", "bun test")
    const evidence = buildEvidence({ run: 1, afterSeq: 0, changedFiles: [], checks: [plain], results: [result(plain, "interrupted", "half\n")], fingerprints })
    expect(evidence.checks[0]).toMatchObject({ required: false, outputTail: null })
    expect(evidence.checks[0]).not.toHaveProperty("origin")
    expect(evidence.checks[0]).not.toHaveProperty("startError")
  })

  test("a record written before any of this still decodes, as it is", () => {
    const old = { name: "test", command: "bun test", status: "failed", exitCode: 1, signal: null, durationMs: 12, files: ["a.ts"], fingerprint: "f", reusedFromSeq: null, outputPath: "/spill/x.log", outputBytes: 7, outputLines: 1 }
    expect(checkEvidence(old, "")).toEqual(old as never)
    expect(() => checkEvidence({ ...old, origin: "repository" }, "")).toThrow(DecodeError)
    expect(() => checkEvidence({ ...old, outputTail: { text: "x" } }, "")).toThrow(DecodeError)
  })
})

describe("the report", () => {
  const failing = result(check("test", "bun test"), "failed", "1 fail\n")
  const other = result(check("lint", "bun lint"), "failed", "2 problems\n")

  test("says which failing checks the session requires, and is the text it was without one", () => {
    const plain = renderReport([failing, other])
    expect(renderReport([{ ...failing, required: false }, other])).toBe(plain)
    expect(plain).not.toContain("requires")
    const told = renderReport([{ ...failing, required: true }, other])
    expect(told).toBe(`${plain}This session requires test: no file of the project replaces a required check or switches it off.\n`)
    // A required check that passes is not mentioned.
    expect(renderReport([{ ...result(check("test", "bun test"), "passed"), required: true }, other])).not.toContain("requires")
  })
})
