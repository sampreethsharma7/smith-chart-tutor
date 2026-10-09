import { abs, c, isFiniteC, sub, type Complex } from './complex'
import { gammaFromZ, type PointMetrics } from './metrics'
import { applyElement, type ElementKind, type NetworkElement } from './network'
import { describeMove } from './moves'

/**
 * Graded tasks and questions beyond "match this load": every answer here is
 * checked by code, never by the model. Points are normalized (z = Z/Z0).
 */

// ── Targets: where the learner has to get the point ─────────────────────────

export type CircleFamily = 'r' | 'g' | 'x' | 'b' | 'vswr'

export type Target =
  /** A spot on the chart, within `tol` of it in Γ (the chart's own distance) */
  | { type: 'point'; z: Complex; tol: number; as: 'z' | 'y' }
  /** Anywhere on one circle or arc, within `tol` of its value */
  | { type: 'circle'; family: CircleFamily; value: number; tol: number }

const r2 = (v: number) => (Math.abs(v) < 5e-4 ? '0' : (Math.round(v * 100) / 100).toString())
export const fmtNorm = (z: Complex) => `${r2(z.re)} ${z.im < 0 ? '−' : '+'} j${r2(Math.abs(z.im))}`

export function admittanceOf(z: Complex): Complex {
  const d = z.re * z.re + z.im * z.im
  return d === 0 ? c(Infinity, 0) : c(z.re / d, -z.im / d)
}

const vswrOf = (z: Complex) => {
  const g = abs(gammaFromZ(z, 1))
  return g >= 1 ? Infinity : (1 + g) / (1 - g)
}

/** Default tolerances: about what a careful learner can hit on the chart. */
export function defaultTolerance(t: { type: 'point' } | { type: 'circle'; family: CircleFamily; value: number }): number {
  if (t.type === 'point') return 0.05
  if (t.family === 'vswr') return Math.max(0.05, 0.03 * t.value)
  return Math.max(0.05, 0.05 * Math.abs(t.value))
}

/** How far a point is from the target, in the target's own units (pass when ≤ tol). */
export function targetError(z: Complex, t: Target): number {
  if (!isFiniteC(z)) return Infinity
  if (t.type === 'point') return abs(sub(gammaFromZ(z, 1), gammaFromZ(t.z, 1)))
  const y = admittanceOf(z)
  switch (t.family) {
    case 'r': return Math.abs(z.re - t.value)
    case 'x': return Math.abs(z.im - t.value)
    case 'g': return Math.abs(y.re - t.value)
    case 'b': return Math.abs(y.im - t.value)
    case 'vswr': return Math.abs(vswrOf(z) - t.value)
  }
}

export const meetsTarget = (z: Complex, t: Target) => targetError(z, t) <= t.tol

export function describeTarget(t: Target): string {
  if (t.type === 'point') return t.as === 'y' ? `the point y = ${fmtNorm(admittanceOf(t.z))}` : `the point z = ${fmtNorm(t.z)}`
  if (t.family === 'vswr') return `the VSWR = ${r2(t.value)} circle`
  if (t.family === 'x' && t.value === 0) return 'the real axis'
  return `the ${t.family} = ${r2(t.value)} ${t.family === 'x' || t.family === 'b' ? 'arc' : 'circle'}`
}

/** The point's own value in the target's terms, e.g. "g = 0.97". */
export function measureFor(z: Complex, t: Target): string {
  if (t.type === 'point') return `z = ${fmtNorm(z)} (y = ${fmtNorm(admittanceOf(z))}), ${r2(targetError(z, t))} from the target in Γ`
  const y = admittanceOf(z)
  const v = { r: z.re, x: z.im, g: y.re, b: y.im, vswr: vswrOf(z) }[t.family]
  return `${t.family} = ${r2(v)} (z = ${fmtNorm(z)})`
}

/** Build a target from tool arguments; throws a message the model can act on. */
export function parseTarget(a: Record<string, any> | undefined): Target {
  if (!a || typeof a !== 'object') throw new Error('Give "target": {point: {r, x}} or {point: {g, b}}, or {circle: {family: "r"|"g"|"x"|"b"|"vswr", value}}.')
  const tolIn = Number(a.tolerance)
  if (a.point && typeof a.point === 'object') {
    const p = a.point
    let z: Complex
    let as: 'z' | 'y' = 'z'
    if (typeof p.r === 'number') z = c(p.r, p.x ?? 0)
    else if (typeof p.g === 'number') { z = admittanceOf(c(p.g, p.b ?? 0)); as = 'y' }
    else throw new Error('target.point needs {r, x} (impedance) or {g, b} (admittance), normalized.')
    if (!isFiniteC(z) || z.re < 0) throw new Error('target.point must be inside the chart (r ≥ 0, g ≥ 0).')
    return { type: 'point', z, as, tol: tolIn > 0 ? tolIn : defaultTolerance({ type: 'point' }) }
  }
  const circ = a.circle ?? (a.family ? a : undefined)
  if (circ && typeof circ === 'object') {
    const family = String(circ.family ?? '').toLowerCase() as CircleFamily
    const value = Number(circ.value)
    if (!['r', 'g', 'x', 'b', 'vswr'].includes(family)) throw new Error('target.circle.family must be one of r, g, x, b, vswr.')
    if (!Number.isFinite(value)) throw new Error('target.circle.value must be a number.')
    if ((family === 'r' || family === 'g') && value < 0) throw new Error(`A ${family} circle needs ${family} ≥ 0.`)
    if (family === 'vswr' && value <= 1) throw new Error('A VSWR circle needs VSWR > 1 (VSWR = 1 is the centre: use point {r: 1, x: 0}).')
    const base = { type: 'circle' as const, family, value }
    return { ...base, tol: tolIn > 0 ? tolIn : defaultTolerance(base) }
  }
  throw new Error('Give "target": {point: {r, x}} or {point: {g, b}}, or {circle: {family, value}}.')
}

// ── Can the target be reached? (so the tutor never sets an impossible task) ──

/** Practical part ranges, the same as for matching exercises. */
const RANGE: Record<ElementKind, { min: number; max: number; log: boolean }> = {
  seriesL: { min: 0.05e-9, max: 500e-9, log: true },
  shuntL: { min: 0.05e-9, max: 500e-9, log: true },
  seriesC: { min: 0.01e-12, max: 500e-12, log: true },
  shuntC: { min: 0.01e-12, max: 500e-12, log: true },
  seriesR: { min: 0.1, max: 1e4, log: true },
  shuntR: { min: 0.1, max: 1e4, log: true },
  tline: { min: 0.5, max: 180, log: false },
  openStub: { min: 0.5, max: 179.5, log: false },
  shortStub: { min: 0.5, max: 179.5, log: false }
}

export const DEFAULT_TASK_KINDS: ElementKind[] = ['seriesL', 'seriesC', 'shuntL', 'shuntC']

const valueAt = (k: ElementKind, u: number) => {
  const r = RANGE[k]
  return r.log ? r.min * Math.pow(r.max / r.min, u) : r.min + (r.max - r.min) * u
}

/** Best value of one element for the target: a grid, then a local refinement. */
function bestOne(Z: Complex, kind: ElementKind, t: Target, f: number, z0: number, grid: number): { el: NetworkElement; err: number } {
  const make = (u: number): NetworkElement => ({ id: `t_${kind}`, kind, value: valueAt(kind, u), zc: z0, refHz: f })
  const err = (u: number) => targetError(scaleZ(applyElement(Z, make(u), f), z0), t)
  let bi = 0
  let be = Infinity
  for (let i = 0; i <= grid; i++) {
    const e = err(i / grid)
    if (e < be) { be = e; bi = i }
  }
  // Ternary search around the best grid point (the error is smooth there).
  let lo = Math.max(0, (bi - 1) / grid)
  let hi = Math.min(1, (bi + 1) / grid)
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3
    const m2 = hi - (hi - lo) / 3
    if (err(m1) < err(m2)) hi = m2
    else lo = m1
  }
  const u = (lo + hi) / 2
  const eu = err(u)
  return eu < be ? { el: make(u), err: eu } : { el: make(bi / grid), err: be }
}

const scaleZ = (Z: Complex, z0: number) => c(Z.re / z0, Z.im / z0)

/**
 * Search for a network of up to `maxAdd` elements (from `kinds`) that takes Zstart
 * (Ω) to the target. Returns the best found; `ok` says whether it meets the target.
 */
export function findReach(Zstart: Complex, t: Target, kinds: ElementKind[], maxAdd: number, f: number, z0: number): { ok: boolean; network: NetworkElement[]; err: number } {
  const startErr = targetError(scaleZ(Zstart, z0), t)
  let best = { ok: startErr <= t.tol, network: [] as NetworkElement[], err: startErr }
  if (maxAdd < 1) return best
  for (const k of kinds) {
    const one = bestOne(Zstart, k, t, f, z0, 300)
    if (one.err < best.err) best = { ok: one.err <= t.tol, network: [one.el], err: one.err }
  }
  if (best.ok || maxAdd < 2) return best
  for (const k1 of kinds) {
    for (let i = 0; i <= 120; i++) {
      const e1: NetworkElement = { id: `t1_${k1}`, kind: k1, value: valueAt(k1, i / 120), zc: z0, refHz: f }
      const Z1 = applyElement(Zstart, e1, f)
      for (const k2 of kinds) {
        const two = bestOne(Z1, k2, t, f, z0, 150)
        if (two.err < best.err) {
          best = { ok: two.err <= t.tol, network: [e1, two.el], err: two.err }
          if (two.err <= t.tol * 0.5) return best
        }
      }
    }
  }
  return best
}

// ── Questions with one right answer ─────────────────────────────────────────

export type Quantity = 'vswr' | 'return_loss_db' | 'gamma_mag' | 'gamma_angle_deg' | 'z' | 'y' | 'Z_ohm' | 'Y_mS' | 'q' | 'wtg_lambda'

export const QUANTITIES: Record<Quantity, { label: string; hint: string; complex?: boolean }> = {
  vswr: { label: 'VSWR', hint: 'e.g. 2.1' },
  return_loss_db: { label: 'return loss', hint: 'in dB, e.g. 9.5' },
  gamma_mag: { label: '|Γ|', hint: 'e.g. 0.35' },
  gamma_angle_deg: { label: 'the angle of Γ', hint: 'in degrees, e.g. 120' },
  z: { label: 'normalized impedance z', hint: 'e.g. 0.6 + j0.4', complex: true },
  y: { label: 'normalized admittance y', hint: 'e.g. 1.15 − j0.77', complex: true },
  Z_ohm: { label: 'impedance Z', hint: 'in Ω, e.g. 30 + j20', complex: true },
  Y_mS: { label: 'admittance Y', hint: 'in mS, e.g. 23 − j15', complex: true },
  q: { label: 'node Q (|X|/R)', hint: 'e.g. 0.67' },
  wtg_lambda: { label: 'wavelengths toward generator', hint: 'in λ, e.g. 0.082' }
}

export function expectedValue(m: PointMetrics, q: Quantity): number | Complex {
  switch (q) {
    case 'vswr': return m.vswr
    case 'return_loss_db': return m.returnLossDb
    case 'gamma_mag': return m.gammaMag
    case 'gamma_angle_deg': return m.gammaDeg
    case 'z': return m.z
    case 'y': return m.y
    case 'Z_ohm': return m.Z
    case 'Y_mS': return c(m.Y.re * 1e3, m.Y.im * 1e3)
    case 'q': return m.q
    case 'wtg_lambda': return m.wtg
  }
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`

// "0,35" is a decimal comma (as the placement test already accepts), not two numbers.
const clean = (s: string) => s.replace(/[−–—]/g, '-').replace(/(\d),(\d)/g, '$1.$2').replace(/\s+/g, ' ').trim().toLowerCase()

/** First number in an answer ("2.04:1", "9.3 dB", "about 0.35"); for angles, the one after ∠ if there is one. */
export function parseNumber(text: string, angle = false): number | null {
  const s = clean(text)
  if (angle) {
    const m = new RegExp(`∠\\s*(${NUM})`).exec(s)
    if (m) return Number(m[1])
  }
  const m = new RegExp(NUM).exec(s)
  return m ? Number(m[0]) : null
}

/** "0.6 + j0.4", "0.6-0.4j", "j1.2", "30 + j 20 Ω", "0.5" → complex; null if it isn't one. */
export function parseComplex(text: string): Complex | null {
  const s = clean(text).replace(/ω|ohms?|ms|siemens/g, '').replace(/\s/g, '').replace(/i/g, 'j')
  if (!s) return null
  // a ± jb  or  a ± bj
  let m = new RegExp(`^(${NUM})([-+])(?:j(${NUM.replace('[-+]?', '')})?|(${NUM.replace('[-+]?', '')})j)$`).exec(s)
  if (m) {
    const im = Number(m[3] ?? m[4] ?? 1)
    return c(Number(m[1]), m[2] === '-' ? -im : im)
  }
  // ± jb  or  ± bj alone
  m = new RegExp(`^([-+]?)(?:j(${NUM.replace('[-+]?', '')})?|(${NUM.replace('[-+]?', '')})j)$`).exec(s)
  if (m) {
    const im = Number(m[2] ?? m[3] ?? 1)
    return c(0, m[1] === '-' ? -im : im)
  }
  // a alone
  m = new RegExp(`^(${NUM})$`).exec(s)
  if (m) return c(Number(m[1]), 0)
  return null
}

/**
 * The point a question's own wording names, so it is filed and checked by what the learner reads:
 * "click z = 0.5 + j1" → z with its value; "where is y = 1 − j1?" → y; "click this impedance" → z, no
 * values (all it names: "from z = 1 + j1, click z = 1 − j1" names two). Normalised values only: one
 * followed by Ω or ohm is skipped, as is "Δz" or "1/z". Null when it names neither, or both kinds.
 */
export function pointNamedIn(question: string): { via: 'z' | 'y'; values: Complex[] } | null {
  const s = question.replace(/[−–—]/g, '-').replace(/\*\*|`|\$/g, '').replace(/(\d),(\d)/g, '$1.$2')
  const found: Array<{ via: 'z' | 'y'; value: Complex }> = []
  for (const m of s.matchAll(/(?<![\p{L}\p{N}_/Δ])([zy])\s*=\s*/gu)) {
    const rest = s.slice(m.index! + m[0].length)
    const value = leadingComplex(rest)
    // Ohms or siemens ("z = 50 Ω", "y = 20 mS") aren't normalised values.
    if (value && !/^\s*(Ω|ohm|m?S\b|siemens)/i.test(rest.slice(value.used))) found.push({ via: m[1] as 'z' | 'y', value: value.c })
  }
  const kinds = new Set(found.map((x) => x.via))
  if (kinds.size === 1) return { via: found[0].via, values: found.map((x) => x.value) }
  if (kinds.size > 1) return null
  const imp = /\bimpedance\b/i.test(s), adm = /\badmittance\b/i.test(s)
  return imp !== adm ? { via: imp ? 'z' : 'y', values: [] } : null
}

/**
 * The complex number a text starts with ("0.5 + j1 on the chart" → 0.5 + j1, using 9 characters):
 * the longest run of number-like words that parses, stopping where two numbers meet ("j1.0 2 times").
 */
function leadingComplex(text: string): { c: Complex; used: number } | null {
  const run = /^[0-9.jJ+\- ]*/.exec(text)![0]
  let best: { c: Complex; used: number } | null = null
  let prevEndsDigit = false
  for (const t of run.matchAll(/\S+/g)) {
    if (prevEndsDigit && /^\d/.test(t[0])) break
    prevEndsDigit = /\d$/.test(t[0])
    const used = t.index! + t[0].length
    // A "j" that starts a word isn't the imaginary unit ("z = 1 just above the axis").
    if (/^\p{L}/u.test(text.slice(used))) break
    const v = parseComplex(text.slice(0, used).replace(/\.$/, ''))
    if (v) best = { c: v, used }
  }
  return best
}

/**
 * The "why" half of a two-part question: the right reason and wrong ones, each wrong
 * one tied to the wrong idea it shows (recorded as a misconception when picked).
 */
export interface ReasonKey { choices: string[]; correct: number; ideas: string[]; /** Which reason each choice is (sx_up, pb_down, to_gen…), for classifying a wrong pick */ ids?: string[] }

export type QuestionKey =
  | { type: 'locate'; target: Complex; tol: number; targetText: string }
  | { type: 'move'; choices: string[]; correct: number; facts: string; reasons?: ReasonKey }
  | { type: 'value'; quantity: Quantity; expected: number | Complex; tolPct: number; z0: number }
  /** A component value: the part (L or C, from the unit they type) and its size */
  | { type: 'component'; part: 'L' | 'C'; value: number; tolPct: number; facts: string; z0: number }
  /** Pick one, e.g. which step of a worked solution has the mistake; ideas[i] = what picking choice i wrongly shows */
  | { type: 'pick'; choices: string[]; correct: number; facts: string; ideas?: string[]; /** The confusion a missed planted mistake shows (patterns.ts) */ missed?: string }

export interface QuestionAnswer { choice?: string; reason?: string; text?: string; gamma?: Complex }

export interface QuestionGrade {
  /** partial: the answer was right but the reason wasn't (a two-part question) */
  status: 'correct' | 'partial' | 'wrong' | 'unreadable'
  /** For the learner (no answer revealed) */
  shown: string
  /** For the tutor: the exact expected answer and how far off the learner was */
  detail: string
}

const fmtVal = (v: number | Complex, q?: Quantity) =>
  typeof v === 'number' ? (Math.round(v * 1000) / 1000).toString() + (q === 'return_loss_db' ? ' dB' : q === 'gamma_angle_deg' ? '°' : q === 'wtg_lambda' ? ' λ' : '')
    : `${r2(v.re)} ${v.im < 0 ? '−' : '+'} j${r2(Math.abs(v.im))}${q === 'Z_ohm' ? ' Ω' : q === 'Y_mS' ? ' mS' : ''}`

/** Absolute slack under the percentage, so small values aren't graded impossibly tight. */
function floorFor(q: Quantity, z0: number): number {
  switch (q) {
    case 'vswr': return 0.05
    case 'return_loss_db': return 0.3
    case 'gamma_mag': return 0.02
    case 'gamma_angle_deg': return 4
    case 'z': case 'y': return 0.04
    case 'Z_ohm': return 0.04 * z0
    case 'Y_mS': return (0.04 * 1000) / z0
    case 'q': return 0.05
    case 'wtg_lambda': return 0.005
  }
}

const PREFIX: Record<string, number> = { f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3, '': 1 }

/**
 * "1.1 pF", "2.7nH", "3.3e-9 H", "0,9 pF" → the value in H or F and which unit. The unit is
 * required: it is how they say which part it is. null if it isn't readable.
 */
export function parsePartValue(text: string): { value: number; unit: 'H' | 'F' } | null {
  const s = clean(text).replace(/\s/g, '').replace(/henr(y|ies)/, 'h').replace(/farads?/, 'f')
  const m = /^([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)([fpnuµμm]?)([hf])$/.exec(s)
  if (!m) return null
  return { value: Math.abs(Number(m[1])) * PREFIX[m[2]], unit: m[3] === 'h' ? 'H' : 'F' }
}

export function gradeQuestion(key: QuestionKey, ans: QuestionAnswer): QuestionGrade {
  if (key.type === 'component') {
    const g = parsePartValue(ans.text ?? '')
    if (!g) return { status: 'unreadable', shown: 'Write the value with its unit, e.g. 2.7 nH or 1.1 pF (the unit says which part).', detail: '' }
    const part = g.unit === 'H' ? 'L' : 'C'
    const close = Math.abs(g.value - key.value) <= (key.tolPct / 100) * key.value
    const ok = part === key.part && close
    const show = (v: number, u: string) => `${Number((v / (u === 'H' ? 1e-9 : 1e-12)).toPrecision(3))} ${u === 'H' ? 'nH' : 'pF'}`
    return {
      status: ok ? 'correct' : 'wrong',
      shown: ok ? 'correct' : 'not quite',
      detail: `${ok ? 'CORRECT' : 'NOT QUITE'}: they answered ${part === 'L' ? 'an inductor' : 'a capacitor'} of ${show(g.value, g.unit)}; the right part is ${key.part === 'L' ? 'an inductor' : 'a capacitor'} of ${show(key.value, key.part === 'L' ? 'H' : 'F')} (±${key.tolPct}%). ${key.facts}`
    }
  }
  if (key.type === 'pick') {
    const i = key.choices.indexOf(ans.choice ?? '')
    if (i < 0) return { status: 'unreadable', shown: 'Pick one of the choices.', detail: '' }
    const ok = i === key.correct
    return {
      status: ok ? 'correct' : 'wrong',
      shown: ok ? 'correct' : 'not quite',
      detail: `${ok ? 'CORRECT' : 'NOT QUITE'}: they chose "${key.choices[i]}"; the right answer is "${key.choices[key.correct]}". ${key.facts}`
    }
  }
  if (key.type === 'move') {
    const i = key.choices.indexOf(ans.choice ?? '')
    if (i < 0) return { status: 'unreadable', shown: 'Pick one of the choices.', detail: '' }
    const ok = i === key.correct
    const r = key.reasons
    const j = r ? r.choices.indexOf(ans.reason ?? '') : -1
    if (r && j < 0) return { status: 'unreadable', shown: 'Pick the reason too.', detail: '' }
    const why = r ? ` Reason: they chose "${r.choices[j]}"; the right reason is "${r.choices[r.correct]}".` : ''
    // Right way, wrong reason: a lucky or memorised answer, not understanding.
    const status = !ok ? 'wrong' : r && j !== r.correct ? 'partial' : 'correct'
    return {
      status,
      shown: status === 'correct' ? 'correct' : status === 'partial' ? 'right answer, but not the reason' : 'not quite',
      detail: `${status === 'correct' ? 'CORRECT' : status === 'partial' ? 'RIGHT ANSWER, WRONG REASON' : 'NOT QUITE'}: they chose "${key.choices[i]}"; the right answer is "${key.choices[key.correct]}".${why} Verified move: ${key.facts}`
    }
  }
  if (key.type === 'locate') {
    if (!ans.gamma) return { status: 'unreadable', shown: 'Click a point on the chart first.', detail: '' }
    const d = abs(sub(ans.gamma, key.target))
    const ok = d <= key.tol
    const zc = zOfGamma(ans.gamma)
    return {
      status: ok ? 'correct' : 'wrong',
      shown: ok ? 'correct' : 'not quite',
      detail: `${ok ? 'CORRECT' : 'NOT QUITE'}: they clicked z = ${fmtNorm(zc)} (y = ${fmtNorm(admittanceOf(zc))}); the target is ${key.targetText}, ${r2(d)} away in Γ (tolerance ${r2(key.tol)}).`
    }
  }
  const info = QUANTITIES[key.quantity]
  const text = ans.text ?? ''
  const exp = key.expected
  let given: number | Complex | null
  let err: number
  let scale: number
  if (typeof exp === 'number') {
    const n = parseNumber(text, key.quantity === 'gamma_angle_deg')
    if (n === null) return { status: 'unreadable', shown: `Write a number (${info.hint}).`, detail: '' }
    given = n
    err = Math.abs(n - exp)
    if (key.quantity === 'gamma_angle_deg') err = Math.abs(((((n - exp) % 360) + 540) % 360) - 180)
    if (key.quantity === 'wtg_lambda') err = Math.min(err, Math.abs(Math.abs(n - exp) - 0.5))
    // Positions on the chart (an angle, a distance in λ) get the same slack wherever they are.
    scale = key.quantity === 'gamma_angle_deg' ? 90 : key.quantity === 'wtg_lambda' ? 0.25 : Math.abs(exp)
  } else {
    const z = parseComplex(text)
    if (!z) return { status: 'unreadable', shown: `Write it as a complex number (${info.hint}).`, detail: '' }
    given = z
    err = abs(sub(z, exp))
    scale = abs(exp)
  }
  const allowed = Math.max((key.tolPct / 100) * scale, floorFor(key.quantity, key.z0))
  const ok = err <= allowed
  return {
    status: ok ? 'correct' : 'wrong',
    shown: ok ? 'correct' : 'not quite',
    detail: `${ok ? 'CORRECT' : 'NOT QUITE'}: they answered ${fmtVal(given, key.quantity)} for ${info.label}; exact value ${fmtVal(exp, key.quantity)} (allowed ±${fmtVal(Math.round(allowed * 1000) / 1000)}).`
  }
}

const zOfGamma = (g: Complex): Complex => {
  const d = (1 - g.re) ** 2 + g.im ** 2
  return d === 0 ? c(Infinity, 0) : c((1 - g.re * g.re - g.im * g.im) / d, (2 * g.im) / d)
}

/**
 * Why a point moves the way it does: what the element adds. Each is also the wrong idea
 * someone holds when they pick it for an element it doesn't fit.
 */
const REASONS = {
  sx_up: { text: 'In series it adds +jx: r stays the same and x goes up', idea: 'adds +jx in series (x up, r fixed)' },
  sx_down: { text: 'In series it adds −jx: r stays the same and x goes down', idea: 'adds −jx in series (x down, r fixed)' },
  pb_up: { text: 'In shunt it adds +jb: g stays the same and b goes up', idea: 'adds +jb in shunt (b up, g fixed)' },
  pb_down: { text: 'In shunt it adds −jb: g stays the same and b goes down', idea: 'adds −jb in shunt (b down, g fixed)' },
  to_gen: { text: 'Toward the generator: |Γ| stays the same and the angle of Γ decreases', idea: 'turns the point toward the generator (angle of Γ decreasing)' },
  to_load: { text: 'Toward the load: |Γ| stays the same and the angle of Γ increases', idea: 'turns the point toward the load (angle of Γ increasing)' }
} as const
type ReasonId = keyof typeof REASONS

/** Multiple-choice question about one element's move, with the right answer (and reason) computed exactly. */
export function moveQuestion(
  Zstart: Complex, el: NetworkElement, f: number, z0: number, ask: 'path' | 'end_half' = 'path'
): { choices: string[]; correct: number; facts: string; startHalf: string; reasons?: ReasonKey } {
  if (el.kind === 'tline' && Math.abs((el.zc ?? z0) - z0) > 1e-9) throw new Error('Ask about a line whose Zc equals Z0, so it turns around the chart centre.')
  const facts = describeMove(Zstart, el, f, z0)
  const startHalf = facts.start.chart_half
  if (ask === 'end_half') {
    // Too close to the axis to call by eye (but not on it): not a fair question.
    const end = applyElement(Zstart, el, f)
    const xEnd = end.im / z0
    if (isFiniteC(end) && Math.abs(xEnd) >= 1e-3 && Math.abs(xEnd) < 0.05) {
      throw new Error(`With that value the point ends just ${xEnd > 0 ? 'above' : 'below'} the real axis (x = ${xEnd.toFixed(3)}): too close to judge by eye. Pick a value that ends clearly in one half, or exactly on the axis.`)
    }
    const choices = ['It ends in the upper half', 'It ends in the lower half', 'It ends on the real axis']
    const correct = facts.end.chart_half === 'upper' ? 0 : facts.end.chart_half === 'lower' ? 1 : 2
    return { choices, correct, facts: facts.summary, startHalf }
  }
  if (facts.rotation === 'none') throw new Error(`A ${facts.element} doesn't turn the point around a circle (${facts.follows}); ask about an L, C, line or stub instead.`)
  const cw = facts.rotation === 'clockwise'
  // Clockwise means adding +jx in series or +jb in shunt (series L, shunt C), or moving toward the generator on a line.
  const reasonKey = (right: ReasonId, pool: ReasonId[]): ReasonKey => ({
    choices: pool.map((r) => REASONS[r].text),
    ids: pool,
    correct: pool.indexOf(right),
    ideas: pool.map((r) => `Thinks a ${facts.element.replace(/^\w+/, (w) => w.toLowerCase())} ${REASONS[r].idea}`)
  })
  if (el.kind === 'tline') {
    const choices = ['Clockwise around the chart centre', 'Counter-clockwise around the chart centre', 'Clockwise along its constant-r circle', 'Counter-clockwise along its constant-g circle']
    return { choices, correct: cw ? 0 : 1, facts: facts.summary, startHalf, reasons: reasonKey(cw ? 'to_gen' : 'to_load', ['to_gen', 'to_load', 'sx_up', 'pb_up']) }
  }
  const choices = ['Clockwise along its constant-r circle', 'Counter-clockwise along its constant-r circle', 'Clockwise along its constant-g circle', 'Counter-clockwise along its constant-g circle']
  const shunt = el.kind.startsWith('shunt') || el.kind.endsWith('Stub')
  const right: ReasonId = shunt ? (cw ? 'pb_up' : 'pb_down') : (cw ? 'sx_up' : 'sx_down')
  return { choices, correct: (shunt ? 2 : 0) + (cw ? 0 : 1), facts: facts.summary, startHalf, reasons: reasonKey(right, ['sx_up', 'sx_down', 'pb_up', 'pb_down']) }
}

/** Where a point is, roughly, as a "situation" for variety: which half, and inside or outside r = 1. */
export function regionOf(z: Complex): string {
  const half = z.im > 0.02 ? 'upper half' : z.im < -0.02 ? 'lower half' : 'real axis'
  return `${half}, r ${z.re < 1 ? '< 1' : '≥ 1'}`
}
