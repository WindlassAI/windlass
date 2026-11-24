import type { Json } from "../../../json.ts"

export interface ChatWireOptions {
  /** Identifies the owner of opaque assistant history, including during offline trace export. */
  readonly provider: string
  readonly maxTokens?: number
  readonly tokenLimitField?: "max_tokens" | "max_completion_tokens"
  readonly developerRole?: "system" | "developer"
  readonly images?: boolean
  readonly reasoningField?: "reasoning_content" | "reasoning_text"
  readonly openRouterReasoning?: (model: string, effort: string, maxTokens?: number) => Json | undefined
}

/** A dated snapshot or routing variant belongs to its base model; keep the upstream namespace. */
export function modelFamily(model: string): string {
  return model.replace(/:(?:nitro|floor|free|exacto|online)$/, "").replace(/-\d{4}-?\d{2}-?\d{2}$/, "")
}
