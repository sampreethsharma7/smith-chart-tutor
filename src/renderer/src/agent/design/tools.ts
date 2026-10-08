import { loadImpedance, ELEMENT_LABEL, type ElementKind, type NetworkElement } from '@shared/rf/network'
import { evaluateDesign, matchCandidates, type DesignGoal, type DesignResult } from '@shared/rf/design'
import { fmtC, fmtHz } from '@/lib/format'
import { describeLoad, elementValueText, uid } from '@/state/studio'
import { tutorTool } from '../registry'
import { defineTools, type AgentTool, type ToolContext } from '../types'
import { ELEMENT_KINDS } from '../tools/chart'

/** One design the assistant put in front of the user, with the app's own numbers for it. */
export interface DesignOption {
  title: string
  note?: string
  /** Load → source */
  elements: NetworkElement[]
  result: DesignResult
  recommended?: boolean
}

export interface Proposal {
  id: string
  at: string
  goal: DesignGoal
  options: DesignOption[]
  /** Index of the option the user applied */
  applied?: number
}

export interface DesignContext extends ToolContext {
  proposal(): Proposal | null
  propose(p: Proposal): void
  apply(option: number): string
}

/** The tutor's tools the design assistant shares, reworded for a colleague instead of a learner. */
const SHARED: Record<string, string | null> = {
  get_chart_state: null,
  set_scenario: ' Do not replace the user\'s load (often their imported measured data) unless they ask you to; usually you only set the design frequency, band, markers or overlays.',
  rf_calculate: null,
  what_if: null,
  analyze_sweep: null,
  annotate_chart: null,
  focus_chart: null,
  clear_annotations: null
}

const reword = (s: string) => s
  .replace(/learner's/g, "user's").replace(/learner/g, 'user').replace(/Learner/g, 'User')
  .replace(/a lesson/g, 'a design').replace(/the lesson/g, 'the design').replace(/lessons/g, 'designs').replace(/lesson/g, 'design')

function shared(): AgentTool[] {
  return Object.entries(SHARED).flatMap(([name, extra]) => {
    const t = tutorTool(name)
    return t ? [{ ...t, description: reword(t.description) + (extra ?? '') }] : []
  })
}

const ELEMENTS_SCHEMA = {
  type: 'array',
  description: 'Load → source. Values in H, F, Ω, or electrical degrees at the design frequency for tline/openStub/shortStub (zc defaults to Z0).',
  items: {
    type: 'object',
    properties: { kind: { type: 'string', enum: ELEMENT_KINDS }, value: { type: 'number' }, zc: { type: 'number' } },
    required: ['kind', 'value']
  }
}

const GOAL_PROPS = {
  freq_hz: { type: 'number', description: 'Design frequency (default: the chart\'s)' },
  band: { type: 'object', description: 'The band that has to work', properties: { low_hz: { type: 'number' }, high_hz: { type: 'number' } }, required: ['low_hz', 'high_hz'] },
  vswr_max: { type: 'number', description: 'VSWR target (default 2; return loss 10 dB ≈ VSWR 1.92)' }
}

function goalOf(a: Record<string, any>, ctx: ToolContext): DesignGoal {
  const s = ctx.studio
  const f0 = Number(a.freq_hz) > 0 ? Number(a.freq_hz) : s.designFreq
  const band = a.band && Number(a.band.high_hz) > Number(a.band.low_hz) ? { low: Number(a.band.low_hz), high: Number(a.band.high_hz) } : undefined
  return { z0: s.z0, f0, ...(band ? { band } : {}), vswrMax: Number(a.vswr_max) > 1 ? Number(a.vswr_max) : 2 }
}

function elementsOf(list: unknown, goal: DesignGoal): NetworkElement[] {
  if (!Array.isArray(list) || !list.length) throw new Error('Give "elements": a list like [{"kind": "shuntC", "value": 1.2e-12}, {"kind": "seriesL", "value": 3.3e-9}] (load → source).')
  return list.map((e: any) => {
    if (!ELEMENT_KINDS.includes(e?.kind)) throw new Error(`Unknown element kind "${e?.kind}". Kinds: ${ELEMENT_KINDS.join(', ')}`)
    const v = Number(e.value)
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${ELEMENT_LABEL[e.kind as ElementKind]} needs a positive value`)
    const line = e.kind === 'tline' || e.kind.endsWith('Stub')
    return { id: uid('el'), kind: e.kind, value: v, ...(line ? { zc: Number(e.zc) > 0 ? Number(e.zc) : goal.z0, refHz: goal.f0 } : {}) }
  })
}

export const partsText = (els: NetworkElement[]) => els.map((e) => `${ELEMENT_LABEL[e.kind]} ${elementValueText(e)}`).join(' → ')

/** The numbers for the model: compact, and the same ones the user sees on the card. */
export function resultBrief(r: DesignResult, goal: DesignGoal) {
  return {
    at_f0: { freq: fmtHz(goal.f0), zin_ohm: fmtC(r.zin), vswr: r.vswr, return_loss_db: r.returnLossDb },
    ...(r.band ? { band: { range: `${fmtHz(r.band.low)}–${fmtHz(r.band.high)}`, worst_vswr: r.band.worstVswr, worst_at: fmtHz(r.band.worstAt), meets_target: r.band.meets } } : {}),
    matched_bandwidth: r.bandwidth
      ? `${fmtHz(r.bandwidth.low)}–${fmtHz(r.bandwidth.high)} (${(r.bandwidth.fractional * 100).toFixed(1)}%)${r.bandwidth.clipped ? ', wider than the range searched or the data' : ''}`
      : `none: VSWR at ${fmtHz(goal.f0)} is above ${goal.vswrMax}`
  }
}

const OWN: AgentTool[] = defineTools([
  {
    name: 'match_options',
    description: 'Compute every standard match for the user\'s load: the lumped L-networks (series-first and shunt-first, each with both signs) and single shunt-stub matches (line then open or shorted stub), each with the app\'s exact numbers at the design frequency and across the band. Use this to find candidates; then put the 2–3 worth showing in front of the user with propose_designs.',
    parameters: { type: 'object', properties: GOAL_PROPS },
    activity: () => 'Working out the matches',
    run(a, ctx) {
      const goal = goalOf(a, ctx)
      const s = ctx.studio
      const ZL = loadImpedance(s.load, goal.f0, s.datasets)
      const none = evaluateDesign(s.load, s.datasets, [], goal)
      const cands = matchCandidates(ZL, goal.z0, goal.f0)
      return {
        load: `${describeLoad(s.load, s.datasets)}: ${fmtC(ZL, 'Ω')} at ${fmtHz(goal.f0)}`,
        unmatched: resultBrief(none, goal),
        target: `VSWR ≤ ${goal.vswrMax}${goal.band ? ` over ${fmtHz(goal.band.low)}–${fmtHz(goal.band.high)}` : ' at the design frequency'}`,
        options: cands.map((c) => ({ id: c.id, family: c.family, parts: partsText(c.elements), elements: c.elements.map(({ kind, value }) => ({ kind, value })), detail: c.detail, ...resultBrief(evaluateDesign(s.load, s.datasets, c.elements, goal), goal) })),
        note: 'Ideal parts. Pass the ones worth showing (with their elements) to propose_designs.'
      }
    }
  },
  {
    name: 'check_network',
    description: 'Exact performance of any network on the user\'s load: at the design frequency, across a band, and the matched bandwidth. Without elements, checks the network on their chart now. Use it for any variant you or they come up with (another topology, rounded part values, a two-section match).',
    parameters: { type: 'object', properties: { elements: ELEMENTS_SCHEMA, ...GOAL_PROPS } },
    activity: () => 'Checking a network',
    run(a, ctx) {
      const goal = goalOf(a, ctx)
      const s = ctx.studio
      const els = a.elements ? elementsOf(a.elements, goal) : s.network
      return { parts: els.length ? partsText(els) : 'none (the bare load)', ...resultBrief(evaluateDesign(s.load, s.datasets, els, goal), goal) }
    }
  },
  {
    name: 'propose_designs',
    description: 'Show the user 1–4 designs as cards, each with the app\'s own numbers and an Apply button (they apply one with a click; nothing on their chart changes until they do). Give each a short title and a one-line trade-off note, and mark the one you recommend. This replaces the previous cards.',
    parameters: {
      type: 'object',
      properties: {
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'e.g. "Shunt C, series L (low-pass)"' },
              elements: ELEMENTS_SCHEMA,
              note: { type: 'string', description: 'One line: why choose it (bandwidth, part values, DC path, harmonics…)' }
            },
            required: ['title', 'elements']
          }
        },
        recommended: { type: 'number', description: '1-based index of the option you recommend' },
        ...GOAL_PROPS
      },
      required: ['options']
    },
    activity: () => 'Showing design options',
    run(a, ctx) {
      const d = ctx as DesignContext
      const goal = goalOf(a, ctx)
      const list = Array.isArray(a.options) ? a.options.slice(0, 4) : []
      if (!list.length) throw new Error('Give 1–4 options, each with a title and elements.')
      const s = ctx.studio
      const options: DesignOption[] = list.map((o: any, i: number) => {
        const elements = elementsOf(o.elements, goal)
        return { title: String(o.title ?? `Option ${i + 1}`).slice(0, 80), ...(o.note ? { note: String(o.note).slice(0, 240) } : {}), elements, result: evaluateDesign(s.load, s.datasets, elements, goal), ...(Number(a.recommended) === i + 1 ? { recommended: true } : {}) }
      })
      d.propose({ id: uid('prop'), at: new Date().toISOString(), goal, options })
      return {
        shown: options.map((o, i) => ({ option: i + 1, title: o.title, parts: partsText(o.elements), ...resultBrief(o.result, goal) })),
        note: 'The user sees these as cards with Apply buttons. Refer to them by number and title; don\'t repeat every number in your reply.'
      }
    }
  },
  {
    name: 'apply_design',
    description: 'Put one of the proposed designs on the user\'s chart (replacing their current network; they can undo). ONLY when their last message asks you to apply or use it; otherwise leave it to their Apply button.',
    parameters: { type: 'object', properties: { option: { type: 'number', description: '1-based option number from the cards' } }, required: ['option'] },
    activity: () => 'Applying the design',
    run(a, ctx) {
      return (ctx as DesignContext).apply(Number(a.option))
    }
  }
])

/** Everything the design assistant can use. */
export function designTools(): AgentTool[] {
  return [...shared(), ...OWN]
}
