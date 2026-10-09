import { create } from 'zustand'
import type { Complex } from '@shared/rf/complex'
import { inv } from '@shared/rf/complex'
import {
  CONVERT_FROM, componentFor, componentForMove, convert, cplx, networkSteps, parseCalcComplex, summarize,
  type CalcResult, type Component, type Connection, type ConvertFrom, type NetworkStep
} from '@shared/rf/calc'
import { ELEMENT_LABEL } from '@shared/rf/network'
import { parseEng } from '@/lib/format'
import { useStudio, valuesCovered } from './studio'
import { computeDerived } from './derived'

export type CalcTab = 'convert' | 'component' | 'network'

/** What is typed into the calculator (the tutor can fill it in too). */
export interface CalcInputs {
  tab: CalcTab
  convertFrom: ConvertFrom
  convertText: string
  /** One value → part, or the part that moves the point from one spot to another */
  compMode: 'value' | 'move'
  conn: Connection
  amountText: string
  /** The amount is normalised (x or b), not Ω / S */
  normalised: boolean
  fromText: string
  toText: string
  /** The from/to points are typed as z or as y */
  pointsAs: 'z' | 'y'
}

export const DEFAULT_INPUTS: CalcInputs = {
  tab: 'convert', convertFrom: 'z', convertText: '', compMode: 'value', conn: 'series', amountText: '',
  normalised: true, fromText: '', toText: '', pointsAs: 'z'
}

export interface CalcOutcome {
  result?: CalcResult & { component?: Component }
  rows?: NetworkStep[]
  /** Why there is no result yet (empty or unreadable input) */
  error?: string
  /** One line for the chart log and the tutor */
  summary?: string
}

/**
 * Work out the calculator's result for these inputs on the current chart (design
 * frequency, Z0, load and network). Pure apart from reading the chart.
 */
export function runCalc(i: CalcInputs): CalcOutcome {
  const s = useStudio.getState()
  const f = s.designFreq, z0 = s.z0
  if (i.tab === 'network') {
    if (!s.network.length) return { error: 'Add elements to the matching network to see what each one does.' }
    const d = computeDerived(s.snapshot())
    const rows = networkSteps(d.design.ZL, s.network, f, z0)
    return { rows, summary: `network step by step: ${rows.map((r) => `${r.title} → z = ${cplx(r.zAfter)}`).join('; ')}` }
  }
  if (i.tab === 'convert') {
    if (!i.convertText.trim()) return { error: `Type a value (${CONVERT_FROM[i.convertFrom].hint}) or pick a point.` }
    const v = parseCalcComplex(i.convertText)
    if (!v) return { error: `Can't read "${i.convertText}". ${CONVERT_FROM[i.convertFrom].hint}.` }
    const result = convert(i.convertFrom, v, z0)
    return { result, summary: `converted ${i.convertFrom} = ${i.convertText.trim()}: ${summarize(result)}` }
  }
  if (i.compMode === 'value') {
    if (!i.amountText.trim()) return { error: i.conn === 'series' ? 'Type the reactance to add (x, or X in Ω).' : 'Type the susceptance to add (b, or B in S).' }
    // "0.8", "-j0.8", "+j 0.8"; in Ω / S engineering notation is fine ("40", "-20m")
    const t = i.amountText.replace(/[−–]/g, '-').replace(/\s+/g, '').replace(/j/i, '')
    const a = i.normalised ? (t.trim() === '' ? NaN : Number(t)) : parseEng(t)
    if (!Number.isFinite(a)) return { error: `Can't read "${i.amountText}" as a number.` }
    const result = componentFor(i.conn, a, i.normalised, f, z0)
    const what = i.conn === 'series' ? (i.normalised ? `x = ${a}` : `X = ${a} Ω`) : i.normalised ? `b = ${a}` : `B = ${a} S`
    return { result, summary: `${i.conn} part for ${what}: ${summarize(result)}` }
  }
  if (!i.fromText.trim() || !i.toText.trim()) return { error: 'Give both points (type them or pick them from the chart).' }
  const p1 = parseCalcComplex(i.fromText), p2 = parseCalcComplex(i.toText)
  if (!p1 || !p2) return { error: `Can't read ${!p1 ? `"${i.fromText}"` : `"${i.toText}"`} as a ${i.pointsAs} value (e.g. 0.6 + j0.4).` }
  const [z1, z2] = i.pointsAs === 'z' ? [p1, p2] : [inv(p1), inv(p2)]
  const result = componentForMove(i.conn, z1, z2, f, z0)
  return { result, summary: `${i.conn} part from ${i.pointsAs} = ${i.fromText.trim()} to ${i.toText.trim()}: ${summarize(result)}${result.warning ? ` (warning: ${result.warning})` : ''}` }
}

/** A point on the chart, written as the calculator's input expects. */
export function pointText(z: Complex, as: 'z' | 'y' | 'Z'): string {
  if (as === 'y') return cplx(inv(z), 4)
  if (as === 'Z') return cplx({ re: z.re * useStudio.getState().z0, im: z.im * useStudio.getState().z0 }, 4)
  return cplx(z, 4)
}

/**
 * The converter answers exactly what a graded "read this value" question asks, so it
 * pauses while one is open. The other tabs stay available.
 */
export function convertLocked(): boolean {
  const p = useStudio.getState().prediction
  // A value question with the values shown (the readout stage) leaves it open: the readout shows them anyway.
  return (!!p && !p.answered && p.key?.type === 'value' && p.values !== 'shown') || valuesCovered(useStudio.getState())
}

/** The network tab lists z after each part: paused while a reading question covers the values. */
export const networkLocked = (): boolean => valuesCovered(useStudio.getState())

/** A graded task or question is open: calculator use is noted as such for the tutor. */
function gradedOpen(): string {
  const s = useStudio.getState()
  if (s.prediction && !s.prediction.answered && s.prediction.key) return ' (while a graded question was open)'
  if (s.exercise && s.exercise.status === 'active') return ' (while working on the task)'
  return ''
}

interface CalcState extends CalcInputs {
  open: boolean
  showWorking: boolean
  /** Set when the tutor filled the calculator in: why, shown to the learner */
  tutorNote: string | null
  /** Network step the learner is pointing at (highlighted on the chart) */
  highlight: number | null
  set(patch: Partial<CalcInputs>, by: 'learner' | 'tutor', note?: string): void
  setOpen(open: boolean): void
  setShowWorking(on: boolean): void
  setHighlight(i: number | null): void
  /** Log what the learner worked out, for the tutor (only results, not every keystroke) */
  logUse(): void
  reset(): void
}

export const useCalc = create<CalcState>((set, get) => ({
  ...DEFAULT_INPUTS,
  open: false,
  showWorking: true,
  tutorNote: null,
  highlight: null,
  set(patch, by, note) {
    set({ ...patch, ...(by === 'tutor' ? { open: true, tutorNote: note ?? 'the tutor filled this in' } : { tutorNote: null }) })
  },
  setOpen(open) {
    set({ open })
  },
  setShowWorking(showWorking) {
    set({ showWorking })
  },
  setHighlight(highlight) {
    set({ highlight })
  },
  logUse() {
    if ((get().tab === 'convert' && convertLocked()) || (get().tab === 'network' && networkLocked())) return
    const r = runCalc(get())
    if (r.summary) useStudio.getState().logEvent('calc', `Used the calculator${gradedOpen()}: ${r.summary}`)
  },
  reset() {
    set({ ...DEFAULT_INPUTS, tutorNote: null, highlight: null })
  }
}))

/** "Add to network" from a component result: the learner's own number, put on the chart. */
export function addComponent(c: Component): void {
  useStudio.getState().addElement(c.kind, c.value)
  useStudio.getState().logEvent('calc_add', `Added ${ELEMENT_LABEL[c.kind]} from the calculator (${c.text})`)
}
