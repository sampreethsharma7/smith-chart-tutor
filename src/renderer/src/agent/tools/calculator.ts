import { CONVERT_FROM, type ConvertFrom } from '@shared/rf/calc'
import { DEFAULT_INPUTS, runCalc, useCalc, type CalcInputs } from '@/state/calc'
import type { AgentTool } from '../types'

const MODES = ['convert', 'component', 'component_move', 'network'] as const

export default [
  {
    name: 'show_calculation',
    description:
      'Open the learner\'s calculator panel filled in, so they see a calculation done step by step with its working as formulas (numbers substituted). ' +
      'Use it to walk through the arithmetic that goes with the chart: converting a point (z ↔ y ↔ Γ ↔ VSWR/RL/Q), turning a reactance/susceptance into an L or C value at the design frequency, ' +
      'finding the part that moves the point from one spot to another, or what each element of their network does to z. ' +
      'Then ask them about one step, or to do the next one themselves. Not while a graded question is open, and never to solve a task they are working on (use other numbers for a worked example).',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...MODES], description: 'convert: one point in every form. component: the part that adds a given normalised x (series) or b (shunt). component_move: the part that takes the point from from_point to to_point. network: their network, step by step.' },
        from: { type: 'string', enum: Object.keys(CONVERT_FROM), description: 'convert: the form "value" is in (Z in Ω, z, Y in S, y, gamma)' },
        value: { type: 'string', description: 'convert: e.g. "0.6 + j0.4", "30 + j20", "0.34∠121"' },
        connection: { type: 'string', enum: ['series', 'shunt'], description: 'component / component_move' },
        amount: { type: 'number', description: 'component: normalised reactance x (series) or susceptance b (shunt), signed' },
        from_point: { type: 'string', description: 'component_move: start, as normalised z, e.g. "0.2 + j0.5"' },
        to_point: { type: 'string', description: 'component_move: end, as normalised z' },
        reason: { type: 'string', description: 'Shown to the learner above the calculator, e.g. "how 0.8 of reactance becomes nanohenries"' }
      },
      required: ['mode', 'reason']
    },
    activity: () => 'Opening the calculator',
    run(a, ctx) {
      const s = ctx.studio
      if (s.prediction && !s.prediction.answered && s.prediction.key) {
        throw new Error('A graded question is open: filling in the calculator now could give the answer away. Wait until they have answered.')
      }
      const mode = MODES.includes(a.mode) ? (a.mode as (typeof MODES)[number]) : null
      if (!mode) throw new Error(`mode must be one of ${MODES.join(', ')}.`)
      let patch: Partial<CalcInputs>
      switch (mode) {
        case 'convert': {
          const from = (Object.keys(CONVERT_FROM).includes(a.from) ? a.from : 'z') as ConvertFrom
          if (!a.value) throw new Error('Give "value" to convert, e.g. "0.6 + j0.4".')
          patch = { tab: 'convert', convertFrom: from, convertText: String(a.value) }
          break
        }
        case 'component':
          if (!Number.isFinite(a.amount)) throw new Error('Give "amount": the normalised x (series) or b (shunt) to add, e.g. 0.8 or -1.2.')
          patch = { tab: 'component', compMode: 'value', conn: a.connection === 'shunt' ? 'shunt' : 'series', amountText: String(a.amount), normalised: true }
          break
        case 'component_move':
          if (!a.from_point || !a.to_point) throw new Error('Give "from_point" and "to_point" as normalised z, e.g. "0.2 + j0.5".')
          patch = { tab: 'component', compMode: 'move', conn: a.connection === 'shunt' ? 'shunt' : 'series', fromText: String(a.from_point), toText: String(a.to_point), pointsAs: 'z' }
          break
        case 'network':
          if (!s.network.length) throw new Error('Their network is empty: there are no steps to show.')
          patch = { tab: 'network' }
          break
      }
      const inputs = { ...DEFAULT_INPUTS, ...useCalc.getState(), ...patch }
      const out = runCalc(inputs)
      if (out.error) throw new Error(`The calculator can't use that: ${out.error}`)
      useCalc.getState().set(patch, 'tutor', String(a.reason ?? 'a worked calculation').slice(0, 120))
      s.logEvent('calc_tutor', `Tutor filled in the calculator: ${out.summary}`)
      const busy = s.exercise?.status === 'active' && mode !== 'convert' && mode !== 'network'
      return `The learner now sees this in their calculator, with every step as a formula: ${out.summary}.` +
        `${out.result?.warning ? ` The calculator also warns them: ${out.result.warning}` : ''}` +
        ' Don\'t repeat the numbers; point them to one step of the working, or ask them to do the next step themselves.' +
        (busy ? ' A task is open: if this is their answer, you have given it away; keep calculator examples to other numbers until they solve it.' : '')
    }
  }
] satisfies AgentTool[]
