import type { Json } from "../../../json.ts"
import { block, type CanonicalTraceRequest, field, isObject, list, toolName } from "../../../trace/format.ts"

export function canonicalGeminiRequest(model: string, body: Readonly<Record<string, Json>>): CanonicalTraceRequest {
  const { tools, systemInstruction, contents, ...params } = body
  const declarations = list(tools).flatMap((tool) => isObject(tool) ? list(tool.functionDeclarations) : [])
  const instructions = isObject(systemInstruction) ? list(systemInstruction.parts) : []
  return {
    model, params, blocks: [
      ...declarations.map((fn) => block("tool", fn, toolName(fn))),
      ...instructions.map((part) => block("system", part, undefined)),
      ...list(contents).map((turn) => block("message", turn, field(turn, "role"))),
    ],
  }
}
