import type { JsonSchema, ToolSpec } from '@shared/llm'
import type { AgentTool, ToolContext } from './types'

// Every file in ./tools is loaded automatically (default export: AgentTool[]); tests next to them are not.
const modules = import.meta.glob<{ default: AgentTool[] }>(['./tools/*.ts', '!./tools/*.test.ts'], { eager: true })

export const TOOLS: AgentTool[] = Object.values(modules).flatMap((m) => m.default ?? [])

const byName = new Map(TOOLS.map((t) => [t.name, t]))

export const specsOf = (tools: AgentTool[]): ToolSpec[] => tools.map(({ name, description, parameters }) => ({ name, description, parameters }))

export function toolSpecs(): ToolSpec[] {
  return specsOf(TOOLS)
}

/** One of the tutor's tools, to share with another assistant. */
export const tutorTool = (name: string) => byName.get(name)

export function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError: boolean }> {
  // Addressed to the tutor only: weaker models otherwise repeat it to the learner.
  return runToolIn(byName, name, args, ctx, "(Note for you, not the learner: don't mention this; just carry on teaching.)")
}

export async function runToolIn(tools: Map<string, AgentTool>, name: string, args: Record<string, unknown>, ctx: ToolContext, errorNote: string): Promise<{ content: string; isError: boolean }> {
  const tool = tools.get(name)
  if (!tool) return { content: `Unknown tool "${name}". Available: ${[...tools.keys()].join(', ')}`, isError: true }
  try {
    const out = await tool.run(coerce(tool.parameters, args ?? {}) as Record<string, unknown>, ctx)
    return { content: typeof out === 'string' ? out : JSON.stringify(out, roundNumbers), isError: false }
  } catch (e) {
    return { content: `Error in ${name}: ${(e as Error).message} ${errorNote}`, isError: true }
  }
}

/** Tools that hand the floor to the learner (e.g. an exercise or prediction card). */
export const endsTurn = (name: string) => byName.get(name)?.endsTurn === true

export function toolActivity(name: string, args: Record<string, unknown>, tools: Map<string, AgentTool> = byName): string {
  const t = tools.get(name)
  return t?.activity?.(args) ?? name.replace(/_/g, ' ')
}

/**
 * Weaker models often send "1.5" for a number or "true" for a boolean, or a JSON
 * string for an object. Coerce arguments to the types the schema declares.
 */
export function coerce(schema: JsonSchema | undefined, v: unknown): unknown {
  if (!schema) return v
  const t = Array.isArray(schema.type) ? schema.type.find((x) => x !== 'null') : schema.type
  if ((t === 'object' || t === 'array') && typeof v === 'string') {
    try { v = JSON.parse(v) } catch { return v }
  }
  if (t === 'number' || t === 'integer') {
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
    return v
  }
  if (t === 'boolean' && typeof v === 'string') return v === 'true' ? true : v === 'false' ? false : v
  if (t === 'array' && Array.isArray(v)) return v.map((x) => coerce(schema.items, x))
  if (t === 'object' && v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) out[k] = coerce(schema.properties?.[k], x)
    return out
  }
  return v
}

/** Keep tool results compact: 5 significant digits is plenty for the model. */
function roundNumbers(_k: string, v: unknown) {
  if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) return Number(v.toPrecision(5))
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v)
  return v
}
