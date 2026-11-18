/**
 * What one run of checks showed, as a record the step loop can attach to a
 * durable event (for example the turn's completion) so that "done" can be shown
 * to rest on something. Declared with the project's strict validators, like
 * every stored type: no optional keys, absent values are `null`.
 */
import type { CheckConfig } from "../config/schema.ts"
import { type OutputLimits, cutTail } from "../tool/cap.ts"
import { type Infer, array, boolean, integer, nonEmptyString, nullable, object, optional, string } from "../validate.ts"
import { type CheckStanding, checkOrigin } from "./required.ts"
import { filesFor } from "./select.ts"
import type { CheckOutput, CheckResult } from "./run.ts"
import { checkStatus, isFailure } from "./status.ts"

/**
 * How much of a check's output the evidence itself carries: its last lines,
 * where a test runner prints which tests failed and the totals. The evidence
 * is in the log three times for a turn's last run (`checks.finished`, the
 * execution's ending, the turn's) and goes to a client with every turn
 * ending, so the tail is a few dozen lines, not the report's 50 KiB: enough
 * to say what failed without reaching into the machine for the file that
 * `outputPath` names, which still holds all of it.
 */
export const OUTPUT_TAIL_LIMITS: OutputLimits = { maxBytes: 4096, maxLines: 60 }

const decoder = new TextDecoder()

/**
 * The end of a check's output within `limits`, from a line start (or, inside
 * one line longer than the limit, from a character boundary that splits no
 * redaction placeholder). `truncated`: the output has more before it.
 */
export function outputTailOf(output: CheckOutput, limits: OutputLimits = OUTPUT_TAIL_LIMITS): OutputTail {
  const { tail, tailAtLineStart, totalBytes } = output.source
  const start = cutTail(tail, tailAtLineStart, limits.maxBytes, limits.maxLines)
  return { text: decoder.decode(tail.subarray(start)), truncated: tail.length - start < totalBytes }
}

/**
 * The end of a check's output, as the evidence of a run carries it. `text` is
 * the last lines of the output (at most 4096 bytes and 60 lines), redacted
 * like the output itself. `truncated` says that the output has more before
 * it: all of it is in the file the check's `outputPath` names.
 */
export const outputTail = object({ text: string, truncated: boolean })
export type OutputTail = Infer<typeof outputTail>

/**
 * One check of a run. `origin` is who named the check: the user's own
 * configuration file (`user`), the client that opened the session
 * (`session`), or the project's file (`project`). `required` is whether it
 * is a required check, which a project's file can neither replace nor switch
 * off. `outputTail` is the end of the output when the check ran in this run
 * and did not pass, or passed and its configuration asks for it
 * (`outputTail: "always"`), and `null` otherwise. `startError` is why the
 * command could not be started at all. A record written before these four
 * existed has none of them; `origin` is also absent where the engine was
 * handed a configuration without the files it came from.
 */
export const checkEvidence = object({
  name: nonEmptyString,
  command: string,
  status: checkStatus,
  exitCode: nullable(integer()),
  signal: nullable(string),
  durationMs: integer(0),
  /** The changed files that selected this check, sorted. */
  files: array(string),
  /** `fingerprintCheck` at the time the check ran. */
  fingerprint: nonEmptyString,
  /**
   * `null` when the check ran in this run. Otherwise it did not: it passed
   * in an earlier run, recorded by the `checks.finished` at this `seq`, and
   * what it depends on is byte for byte what it was then (the same
   * `fingerprint`), so that result was carried over. Only a pass is ever carried.
   */
  reusedFromSeq: nullable(integer(1)),
  /** The full output, named by its content. */
  outputPath: nullable(string),
  outputBytes: integer(0),
  outputLines: integer(0),
  /**
   * Who named the check (`required.ts`): the user's own configuration file, the client that opened the session, or
   * the project's file. Absent in a record written before origins were recorded, and where the engine was handed
   * a configuration without the files it came from.
   */
  origin: optional(checkOrigin),
  /** Whether the check is a required one, which a project's file can neither replace nor switch off. Absent in a record written before there were any. */
  required: optional(boolean),
  /**
   * The end of the output, when the check ran in this run and did not pass, or passed and asks for it
   * (`outputTail: "always"` in its configuration); `null` otherwise. Absent in a record written before tails were kept.
   */
  outputTail: optional(nullable(outputTail)),
  /** Why the command could not be started at all, when that is how the check ended (`could_not_start` with no exit code). */
  startError: optional(nonEmptyString),
})
export type CheckEvidence = Infer<typeof checkEvidence>

export const verificationEvidence = object({
  /** 1 for the first run of checks in the turn, then 2, ... */
  run: integer(1),
  /** The `seq` of the latest durable event of the session when the checks started. */
  afterSeq: integer(0),
  /** Every file changed since the last fully passing verification, sorted. */
  changedFiles: array(string),
  checks: array(checkEvidence),
})
export type VerificationEvidence = Infer<typeof verificationEvidence>

export function buildEvidence(input: {
  readonly run: number
  readonly afterSeq: number
  readonly changedFiles: readonly string[]
  readonly checks: readonly (CheckConfig & CheckStanding)[]
  readonly results: readonly CheckResult[]
  /** By check name, computed when the run started. */
  readonly fingerprints: Readonly<Record<string, string>>
  /** Checks that were not run because their last pass still stands, with the `seq` that pass was recorded at. */
  readonly reused?: readonly { readonly check: CheckConfig & CheckStanding; readonly fromSeq: number }[]
  /**
   * The harness's redaction of tool output, for what the evidence carries of a check's output. The output is
   * redacted as it arrives where the runner was handed the redaction; this covers a value known only since.
   */
  readonly redact?: (text: string) => string
}): VerificationEvidence {
  const redact = input.redact ?? ((text: string) => text)
  const standing = (check: (CheckConfig & CheckStanding) | undefined) => ({
    ...(check?.origin == null ? {} : { origin: check.origin }),
    required: check?.required === true,
  })
  const carried = (input.reused ?? []).map(({ check, fromSeq }): CheckEvidence => ({
    name: check.name,
    command: check.command,
    status: "passed" as const,
    exitCode: 0,
    signal: null,
    durationMs: 0,
    files: filesFor(check, input.changedFiles),
    fingerprint: input.fingerprints[check.name] ?? "",
    reusedFromSeq: fromSeq,
    outputPath: null,
    outputBytes: 0,
    outputLines: 0,
    ...standing(check),
    outputTail: null,
  }))
  const order = new Map(input.checks.map((check, index) => [check.name, index]))
  return verificationEvidence(
    {
      run: input.run,
      afterSeq: input.afterSeq,
      changedFiles: [...new Set(input.changedFiles)].sort(),
      checks: input.results.map((result): CheckEvidence => {
        const config = input.checks.find((check) => check.name === result.name)
        const shown = isFailure(result.status) || (result.status === "passed" && config?.outputTail === "always")
        const tail = shown ? outputTailOf(result.output) : null
        return {
          name: result.name,
          command: result.command,
          status: result.status,
          exitCode: result.exitCode,
          signal: result.signal,
          durationMs: result.durationMs,
          files: config === undefined ? [] : filesFor(config, input.changedFiles),
          fingerprint: input.fingerprints[result.name] ?? "",
          reusedFromSeq: null,
          outputPath: result.output.path,
          outputBytes: result.output.totalBytes,
          outputLines: result.output.totalLines,
          ...standing(config),
          outputTail: tail === null ? null : { ...tail, text: redact(tail.text) },
          ...(result.startError === null || result.startError === "" ? {} : { startError: redact(result.startError) }),
        }
      })
        .concat(carried)
        // The configuration's order, whether a check ran or was carried over.
        .sort((a, b) => (order.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.name) ?? Number.MAX_SAFE_INTEGER)),
    },
    "evidence",
  )
}
