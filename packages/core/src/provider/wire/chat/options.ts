import type { Json } from "../../../json.ts"

export interface ChatWireOptions {
  /** Identifies the owner of opaque assistant history, including during offline trace export. */
  readonly provider: string
  readonly maxTokens?: number
  readonly images?: boolean
  readonly openRouterReasoning?: (effort: string) => Json
}

/** A dated snapshot or routing variant belongs to its base model; keep the upstream namespace. */
export function modelFamily(model: string): string {
  return model.replace(/:(?:nitro|floor|free|exacto|online)$/, "").replace(/-\d{4}-?\d{2}-?\d{2}$/, "")
}
