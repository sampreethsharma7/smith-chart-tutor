import { c, type Complex } from '@shared/rf/complex'
import { metricsFromZ } from '@shared/rf/metrics'
import { applyElement, ELEMENT_LABEL, inputImpedance, loadImpedance, sweepFreqs, type NetworkElement } from '@shared/rf/network'
import { describeMove } from '@shared/rf/moves'
import { describeTarget, measureFor, targetError, type Target } from '@shared/rf/tasks'
import { fmtHz, fmtNum } from '@/lib/format'
import { elementValueText, useStudio, type Exercise } from './studio'

export interface ExerciseGrade {
  passed: boolean
  vswrAtF: number
  worstVswrInBand?: { vswr: number; at: number }
  violations: string[]
  summary: string
  /** For the tutor only (the learner sees the summary): which way a near miss was, from the app */
  tutorNote?: string
}

/**
 * For an L or C, whether a larger value takes the point further along its path (the part's effect
 * grows from nothing): more L in series, more C in shunt; but a series C or a shunt L does more with
 * LESS (its reactance or susceptance is 1/ωC, 1/ωL). Lines, stubs and resistors aren't covered:
 * a line's path is periodic and a resistor's isn't an arc, so "further" has no single meaning there.
 */
const FURTHER_WITH_MORE: Partial<Record<NetworkElement['kind'], boolean>> = { seriesL: true, shuntC: true, seriesC: false, shuntL: false }

/**
 * Which way a reach task was missed, so the tutor doesn't have to guess ("went past" when it fell
 * short). The last part's value is slid over ×1/50 … ×50 in fine steps (0.4% apart); of the values
 * that land on the target, the one nearest the learner's own is the fix (a path can meet the target
 * twice). Lumped L and C only (FURTHER_WITH_MORE); null otherwise, or when nothing is missed.
 */
export function reachMiss(Zbefore: Complex, last: NetworkElement, f: number, z0: number, target: Target): string | null {
  const more = FURTHER_WITH_MORE[last.kind]
  if (more === undefined || !(last.value > 0)) return null
  const zOf = (v: number) => { const Z = applyElement(Zbefore, { ...last, value: v }, f); return c(Z.re / z0, Z.im / z0) }
  if (targetError(zOf(last.value), target) <= target.tol) return null
  const N = 2000, SPAN = Math.log(50)
  const lkOf = (i: number) => -SPAN + (2 * SPAN * i) / N
  let fixI = -1 // the landing value nearest theirs (index into the scan)
  let best = { err: Infinity, i: -1 }
  const errs: number[] = []
  for (let i = 0; i <= N; i++) {
    const err = targetError(zOf(last.value * Math.exp(lkOf(i))), target)
    errs.push(err)
    if (!Number.isFinite(err)) continue
    if (err < best.err) best = { err, i }
    if (err <= target.tol && (fixI < 0 || Math.abs(lkOf(i)) < Math.abs(lkOf(fixI)))) fixI = i
  }
  const name = `${ELEMENT_LABEL[last.kind]} ${elementValueText(last)}`
  if (fixI < 0) {
    // Still getting closer at the end of the range: the right part, but its size is far off (often a unit slip).
    const falling = (best.i === N && errs[N] < errs[N - 50] - 1e-3) || (best.i === 0 && errs[0] < errs[50] - 1e-3)
    if (falling) return `their last part (${name}) would need a far ${best.i === N ? 'LARGER' : 'SMALLER'} value (over 50× ${best.i === N ? 'more' : 'less'}) to land: the size is far off, so check the units (pH vs nH, fF vs pF). Use these words; don't give a value.`
    return `their last part (${name}) can't land on the target by changing its value alone: the plan, not the size, is off. Use these words.`
  }
  // The middle of that landing band, not its near edge: how much to change it to land squarely.
  const step = lkOf(fixI) > 0 ? 1 : -1
  let mid = fixI
  for (let i = fixI; i >= 0 && i <= N && errs[i] <= target.tol; i += step) if (errs[i] < errs[mid]) mid = i
  const fix = lkOf(mid)
  const larger = fix > 0
  const short = larger === more
  const way = short ? 'fell SHORT of the target along its path (it needs to travel further the same way)' : 'went PAST the target along its path (it needs to travel less far)'
  const pct = Math.round(Math.abs(Math.exp(fix) - 1) * 100)
  return `their last part (${name}) ${way}; that takes a ${larger ? 'LARGER' : 'SMALLER'} value (about ${pct}% ${larger ? 'more' : 'less'}). Use these words; don't give the value.`
}

/**
 * Whether the chart still has the project's load and Z0, for its final task. Compared by meaning, not
 * by bytes: data by its name (importing the same file again gives it a new id), a model by its impedance
 * at the task's frequencies within 1% (a value typed back from the rounded display still counts).
 */
export function onProjectLoad(ex: Exercise): boolean {
  const p = ex.capstone
  if (!p) return true
  const s = useStudio.getState()
  if (Math.abs(s.z0 - p.z0) > 1e-9) return false
  if (p.datasetName !== undefined) {
    return s.load.kind === 'data' && s.datasets.find((d) => d.id === (s.load as { datasetId: string }).datasetId)?.name === p.datasetName
  }
  if (s.load.kind === 'data') return false
  const fs = [ex.freqHz, ...(ex.band ? [ex.band.fLow, ex.band.fHigh] : [])]
  return fs.every((f) => {
    const a = loadImpedance(s.load, f, s.datasets), b = loadImpedance(p.load, f, s.datasets)
    return Math.hypot(a.re - b.re, a.im - b.im) <= 0.01 * Math.max(1e-9, Math.hypot(b.re, b.im))
  })
}

/** Put the project's load and Z0 back on the chart (its data by name, if it was imported again). */
export function restoreProjectLoad(): string | null {
  const s = useStudio.getState()
  const p = s.exercise?.capstone
  if (!p) return null
  let load = p.load
  if (p.datasetName !== undefined) {
    const ds = s.datasets.find((d) => d.name === p.datasetName)
    if (!ds) return `Import "${p.datasetName}" again first (Load panel).`
    load = { kind: 'data', datasetId: ds.id }
  }
  if (s.z0 !== p.z0) s.set('z0', p.z0)
  useStudio.getState().setLoad(load, "put the project's load back")
  return null
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
  // The project's final task is about the project's load: passing it on another load or Z0 isn't the project.
  if (ex.capstone && !onProjectLoad(ex)) {
    violations.push(`the load or Z0 isn't the project's any more (use "Put the project's load back" on the card)`)
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
    const last = s.network.at(-1)
    const miss = !onTarget && last ? reachMiss(inputImpedance(loadImpedance(s.load, ex.freqHz, s.datasets), s.network.slice(0, -1), ex.freqHz), last, ex.freqHz, s.z0, ex.target) : null
    return { passed, vswrAtF, violations, summary: `${passed ? 'PASS' : 'NOT YET'} — ${parts.join(', ')}`, ...(miss ? { tutorNote: miss } : {}) }
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
