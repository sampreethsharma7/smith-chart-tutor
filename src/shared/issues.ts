/**
 * Mechanical faults an assistant's turn can show, checked the same way live (the app logs them as
 * they happen) and afterwards (scripts/audit.mjs replays saved chats). No imports on purpose: the
 * audit script loads this file straight into Node.
 */

export type IssueKind =
  | 'claims-drawing' // says it drew or marked something, but nothing was drawn this turn
  | 'claims-change' // says it applied, added or set something up, but no tool did
  | 'tool-name' // mentions a tool by name
  | 'escaped-newline' // a literal "\n" in its text
  | 'tool-error' // a tool call failed or was refused
  | 'tool-repeat' // the same tool many times in one turn
  | 'step-limit' // ran out of steps
  | 'empty-reply' // said nothing and had to be asked to reply
  | 'guard' // a guard caught and rewrote a reply (unchecked move, unknown coordinates, meta text…)

export interface Issue {
  at: string
  agent: 'tutor' | 'design'
  model?: string
  kind: IssueKind
  detail: string
  /** A short piece of the reply or result it's about */
  excerpt?: string
}

/** Everything one turn did: what it said, which tools it called and how they went, guard events. */
export interface TurnRecord {
  texts: string[]
  tools: Array<{ name: string; ok: boolean; content: string }>
  events?: Array<{ kind: IssueKind; detail: string }>
}

export const ISSUE_LABEL: Record<IssueKind, string> = {
  'claims-drawing': 'Says it drew something that was not drawn',
  'claims-change': 'Says it changed the chart, but nothing changed',
  'tool-name': 'Mentions a tool name to the user',
  'escaped-newline': 'Literal "\\n" in its text',
  'tool-error': 'A tool call failed or was refused',
  'tool-repeat': 'Same tool called many times in one turn',
  'step-limit': 'Hit the step limit',
  'empty-reply': 'Said nothing; had to be asked to reply',
  guard: 'A guard caught and rewrote a reply'
}

const DRAW_CLAIM = /\b(?:I(?:'ve| have)? (?:just )?(?:drawn|drew|marked|circled|highlighted|sketched|shaded|plotted)|(?:the|this|that) (?:blue|red|green|orange|purple|yellow|dashed|dotted) (?:circle|line|arrow|point|dot|curve|arc))\b/i
const DRAW_TOOLS = ['annotate_chart']
const CHANGE_CLAIM = /\b(?:I(?:'ve| have)? (?:just )?(?:applied|added|put|placed|set up|loaded|changed|switched)\b|(?:is|are) now on your chart|has been applied|now on (?:your|the) chart)/i
const CHANGE_TOOLS = ['apply_design', 'edit_network', 'set_scenario', 'create_exercise', 'create_target_task', 'ask_prediction', 'ask_move', 'ask_locate', 'ask_value', 'ask_component', 'ask_spot_error', 'propose_designs', 'show_calculation', 'focus_chart', 'set_lesson_coordinates', 'annotate_chart', 'app_apply']
/** "\n" written as two characters, but not LaTeX like \nu or \nabla */
const ESCAPED_NL = /\\n(?=\\n|[A-Z0-9\s]|$)/

const excerptAround = (text: string, re: RegExp, span = 140) => {
  const m = re.exec(text)
  if (!m) return text.slice(0, span * 2)
  const from = Math.max(0, m.index - span)
  return `${from ? '…' : ''}${text.slice(from, m.index + m[0].length + span).replace(/\s+/g, ' ').trim()}…`
}

/** The faults in one turn. `toolNames`: every tool the assistant has (to spot names in its text). */
export function auditTurn(t: TurnRecord, toolNames: string[]): Array<Omit<Issue, 'at' | 'agent' | 'model'>> {
  const out: Array<Omit<Issue, 'at' | 'agent' | 'model'>> = []
  const text = t.texts.join('\n\n')
  const okTools = new Set(t.tools.filter((x) => x.ok).map((x) => x.name))
  if (DRAW_CLAIM.test(text) && !DRAW_TOOLS.some((n) => okTools.has(n))) {
    out.push({ kind: 'claims-drawing', detail: 'no drawing this turn', excerpt: excerptAround(text, DRAW_CLAIM) })
  }
  if (CHANGE_CLAIM.test(text) && !CHANGE_TOOLS.some((n) => okTools.has(n))) {
    out.push({ kind: 'claims-change', detail: 'no chart change this turn', excerpt: excerptAround(text, CHANGE_CLAIM) })
  }
  const names = toolNames.filter((n) => n.includes('_') && new RegExp(`\\b${n}\\b`).test(text))
  if (names.length) out.push({ kind: 'tool-name', detail: names.join(', '), excerpt: excerptAround(text, new RegExp(`\\b${names[0]}\\b`)) })
  if (ESCAPED_NL.test(text)) out.push({ kind: 'escaped-newline', detail: 'in a reply', excerpt: excerptAround(text, ESCAPED_NL) })
  for (const x of t.tools) {
    if (!x.ok) out.push({ kind: 'tool-error', detail: x.name, excerpt: x.content.replace(/\s+/g, ' ').slice(0, 220) })
  }
  const counts = new Map<string, number>()
  for (const x of t.tools) counts.set(x.name, (counts.get(x.name) ?? 0) + 1)
  for (const [name, n] of counts) if (n >= 4) out.push({ kind: 'tool-repeat', detail: `${name} ×${n}` })
  for (const e of t.events ?? []) out.push({ kind: e.kind, detail: e.detail })
  return out
}

/**
 * Split a saved chat history into turns: each starts at something the person said and holds the
 * assistant's replies and tool calls (with their results) until the next one.
 */
export function turnsOf(history: Array<{ role: string; parts: Array<Record<string, any>> }>): Array<TurnRecord & { opening: string }> {
  const turns: Array<TurnRecord & { opening: string }> = []
  let cur: (TurnRecord & { opening: string }) | null = null
  const pending = new Map<string, string>()
  for (const m of history) {
    if (m.role === 'user') {
      const said = m.parts.filter((p) => p.type === 'text').map((p) => String(p.text)).join(' ')
      for (const p of m.parts) {
        if (p.type !== 'tool_result' || !cur) continue
        cur.tools.push({ name: String(p.name ?? pending.get(p.callId) ?? '?'), ok: !p.isError, content: String(p.content ?? '') })
      }
      // A plain message from the person (not only tool results, not an app nudge) starts a new turn.
      if (said && !/^\[System\]/.test(said.trim())) {
        cur = { opening: said.slice(0, 160), texts: [], tools: [] }
        turns.push(cur)
      }
    } else if (cur) {
      for (const p of m.parts) {
        if (p.type === 'text' && p.text) cur.texts.push(String(p.text))
        if (p.type === 'tool_call') pending.set(String(p.id), String(p.name))
      }
    }
  }
  return turns
}
