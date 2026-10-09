import { describe, expect, it } from 'vitest'
import { auditTurn, turnsOf } from './issues'

const NAMES = ['annotate_chart', 'get_chart_state', 'apply_design', 'match_options', 'analyze_sweep']
const kinds = (r: ReturnType<typeof auditTurn>) => r.map((x) => x.kind)

describe('faults in a turn (each from a real run this week)', () => {
  it('says it drew a circle, but no drawing succeeded', () => {
    const t = { texts: ["Let's break it down together. I've drawn a blue circle on your chart."], tools: [{ name: 'annotate_chart', ok: false, content: 'Nothing was drawn' }] }
    expect(kinds(auditTurn(t, NAMES))).toEqual(['claims-drawing', 'tool-error'])
    // The same words after a drawing that worked are fine.
    expect(kinds(auditTurn({ ...t, tools: [{ name: 'annotate_chart', ok: true, content: 'Drew a VSWR 1.67 circle' }] }, NAMES))).toEqual([])
  })

  it('says a design was applied when nothing changed (a 7B model, Design tab)', () => {
    const t = { texts: ["Great choice! I'll apply option 1. The design has been applied and shows good performance."], tools: [] }
    expect(kinds(auditTurn(t, NAMES))).toContain('claims-change')
    expect(kinds(auditTurn({ ...t, tools: [{ name: 'app_apply', ok: true, content: '' }] }, NAMES))).not.toContain('claims-change')
  })

  it('tool names and escaped line breaks in what the person reads', () => {
    const r = auditTurn({ texts: ["I'll use `get_chart_state` to see the load.", 'Spot on! z = 0.\\n\\nNow, what is |Γ|?'], tools: [] }, NAMES)
    expect(kinds(r)).toEqual(['tool-name', 'escaped-newline'])
    expect(r[0].detail).toBe('get_chart_state')
    expect(kinds(auditTurn({ texts: ['$\\nu$ and $\\nabla$'], tools: [] }, NAMES))).toEqual([])
  })

  it('the same tool over and over, and events from the guards', () => {
    const tools = Array.from({ length: 5 }, () => ({ name: 'propose_designs', ok: true, content: '' }))
    const r = auditTurn({ texts: [], tools, events: [{ kind: 'step-limit', detail: '10 steps' }] }, NAMES)
    expect(r.map((x) => `${x.kind}:${x.detail}`)).toEqual(['tool-repeat:propose_designs ×5', 'step-limit:10 steps'])
  })
})

describe('turns from a saved chat', () => {
  it('splits at what the person said, and pairs tool calls with their results', () => {
    const history = [
      { role: 'user', parts: [{ type: 'text', text: 'Match my load' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Looking.' }, { type: 'tool_call', id: 'a', name: 'match_options', args: {} }] },
      { role: 'user', parts: [{ type: 'tool_result', callId: 'a', name: 'match_options', content: '{…}' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Two options.' }] },
      { role: 'user', parts: [{ type: 'text', text: '[System] Please reply to the learner now, in plain text.' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Done.' }] },
      { role: 'user', parts: [{ type: 'text', text: 'apply 1' }] },
      { role: 'assistant', parts: [{ type: 'text', text: 'Applied.' }] }
    ]
    const t = turnsOf(history)
    expect(t.map((x) => x.opening)).toEqual(['Match my load', 'apply 1'])
    expect(t[0].texts).toEqual(['Looking.', 'Two options.', 'Done.'])
    expect(t[0].tools).toEqual([{ name: 'match_options', ok: true, content: '{…}' }])
  })
})
