const levels = ["minimal", "low", "medium", "high"] as const
const budgets: Readonly<Record<string, number>> = { low: 1024, medium: 4096, high: 16384 }

export function reasoningEfforts(model: string, thinking = true): readonly string[] {
  if (!thinking) return []
  if (/^gemini-2\.5-(pro|flash)(?:-|$)/.test(model))
    return [...(model.startsWith("gemini-2.5-pro") ? [] : ["off"]), "dynamic", ...Object.keys(budgets)]
  if (/^gemini-3(?:[.-]|$)/.test(model)) {
    if (/^gemini-3-pro(?:-|$)/.test(model)) return ["low", "high"]
    if (model.includes("-pro") || /^gemini-3\.[78]-flash/.test(model)) return ["low", "medium", "high"]
    return levels
  }
  return []
}

export function thinkingConfig(model: string, effort: string | null) {
  const efforts = reasoningEfforts(model)
  if (effort !== null && !efforts.includes(effort)) throw new Error(`unsupported thinking effort ${effort} for ${model}`)
  if (efforts.length === 0) return undefined
  if (!efforts.includes("dynamic"))
    return { includeThoughts: true, ...(effort !== null && { thinkingLevel: effort.toUpperCase() }) }

  const requested = effort ?? (model.startsWith("gemini-2.5-flash-lite") ? "off" : "dynamic")
  const thinkingBudget = requested === "off" ? 0 : requested === "dynamic" ? -1 : budgets[requested]!
  return { includeThoughts: true, thinkingBudget }
}
