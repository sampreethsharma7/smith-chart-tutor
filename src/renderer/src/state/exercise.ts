import { c } from '@shared/rf/complex'
import { metricsFromZ } from '@shared/rf/metrics'
import { applyElement, ELEMENT_LABEL, inputImpedance, loadImpedance, sweepFreqs } from '@shared/rf/network'
import { describeMove } from '@shared/rf/moves'
import { describeTarget, measureFor, targetError } from '@shared/rf/tasks'
import { fmtHz, fmtNum } from '@/lib/format'
import { elementValueText, useStudio, type Exercise } from './studio'

export interface ExerciseGrade {
  passed: boolean
  vswrAtF: number
  worstVswrInBand?: { vswr: number; at: number }
  violations: string[]
  summary: string
}

/** What the card says the task is, e.g. "VSWR ≤ 1.2 at 2.4 GHz" or "input on the g = 1 circle (±0.05) at 2.4 GHz". */
export function exerciseGoal(ex: Exercise): string {
  if (ex.kind === 'reach' && ex.target) {
    return `Get the point onto ${describeTarget(ex.target)} (±${fmtNum(ex.target.tol)}) at ${fmtHz(ex.freqHz)}`
  }
  return `VSWR ≤ ${ex.maxVswr ?? 1.5} at ${fmtHz(ex.freqHz)}${ex.band ? ` across ${fmtHz(ex.band.fLow)}–${fmtHz(ex.band.fHigh)}` : ''}`
}

/** Deterministic grading of the learner's current network against the active exercise. */
export function gradeExercise(ex: Exercise): ExerciseGrade {
  const s = useStudio.getState()
  const zin = (f: number) => inputImpedance(loadImpedance(s.load, f, s.datasets), s.network, f)
  const vAt = (f: number) => metricsFromZ(zin(f), s.z0).vswr
  const vswrAtF = vAt(ex.freqHz)
  const violations: string[] = []
  if (ex.maxElements !== undefined && s.network.length > ex.maxElements) {
    violations.push(`uses ${s.network.length} elements (max ${ex.maxElements})`)
  }
  if (ex.allowedKinds?.length) {
    const bad = s.network.filter((e) => !ex.allowedKinds!.includes(e.kind))
    if (bad.length) violations.push(`not allowed: ${[...new Set(bad.map((e) => ELEMENT_LABEL[e.kind]))].join(', ')}`)
  }

  if (ex.kind === 'reach' && ex.target) {
    const Z = zin(ex.freqHz)
    const z = c(Z.re / s.z0, Z.im / s.z0)
    const onTarget = targetError(z, ex.target) <= ex.target.tol
    const passed = onTarget && violations.length === 0
    const parts = [`point at ${fmtHz(ex.freqHz)}: ${measureFor(z, ex.target)}; target ${describeTarget(ex.target)} ±${fmtNum(ex.target.tol)}`]
    if (violations.length) parts.push(`constraint issues: ${violations.join('; ')}`)
    return { passed, vswrAtF, violations, summary: `${passed ? 'PASS' : 'NOT YET'} — ${parts.join(', ')}` }
  }

  const maxVswr = ex.maxVswr ?? 1.5
  let worst: ExerciseGrade['worstVswrInBand']
  if (ex.band) {
    for (const f of sweepFreqs({ start: ex.band.fLow, stop: ex.band.fHigh, points: 61 })) {
      const v = vAt(f)
      if (!worst || v > worst.vswr) worst = { vswr: v, at: f }
    }
  }
  const okF = vswrAtF <= maxVswr
  const okBand = !worst || worst.vswr <= maxVswr
  const passed = okF && okBand && violations.length === 0
  const parts = [`VSWR at ${fmtHz(ex.freqHz)} = ${fmtNum(vswrAtF)} (target ≤ ${maxVswr})`]
  if (worst) parts.push(`worst in band = ${fmtNum(worst.vswr)} at ${fmtHz(worst.at)}`)
  if (violations.length) parts.push(`constraint issues: ${violations.join('; ')}`)
  return { passed, vswrAtF, worstVswrInBand: worst, violations, summary: `${passed ? 'PASS' : 'NOT YET'} — ${parts.join(', ')}` }
}

/**
 * The learner's own solution, element by element with each move verified, for
 * the tutor's follow-up question ("why this element first?", "what if…?").
 */
export function solutionFacts(ex: Exercise): string {
  const s = useStudio.getState()
  let Z = loadImpedance(s.load, ex.freqHz, s.datasets)
  return s.network.map((el, i) => {
    const facts = describeMove(Z, el, ex.freqHz, s.z0)
    Z = applyElement(Z, el, ex.freqHz)
    return `${i + 1}. ${ELEMENT_LABEL[el.kind]} ${elementValueText(el)}: ${facts.summary}`
  }).join('\n')
}

/** Sent to the tutor with a passing Check: what they built, and the follow-up it owes them. */
export const FOLLOW_UP = 'They solved it. Before you close the task or the lesson: one line of specific praise, then ONE follow-up question about their own solution so they explain or extend it (why this element first, what a bigger or smaller value would do, where the point would be without the last element, how the other solution would differ, what happens at another frequency). Prefer a graded question (ask_move, ask_locate or ask_value) built on their network above. If they skip it, move on.'
