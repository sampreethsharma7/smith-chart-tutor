import { abs, arg, c, deg, inv, isFiniteC, rad, scale, type Complex } from './complex'
import { gammaFromZ, metricsFromZ, zFromGamma } from './metrics'
import { applyElement, ELEMENT_LABEL, isShunt, type ElementKind, type NetworkElement } from './network'
import { parseComplex } from './tasks'

/**
 * The Smith chart calculator: the arithmetic that goes with reading the chart
 * (conversions, reactance → component, a network step by step). Every result
 * comes with its working as formulas with the numbers put in, so it teaches
 * the calculation instead of hiding it. Values come from the same engine as
 * the chart, so the two always agree.
 */

/** One line of working: what it is, and the formula with numbers (LaTeX). */
export interface Step { label: string; tex: string }
/** One result, as plain text (for the learner's log and the tutor). */
export interface Output { label: string; text: string }
export interface CalcResult { outputs: Output[]; steps: Step[]; warning?: string }

// ── Number formatting, for text and for TeX ──

const sig = (v: number, d = 3) => Number(v.toPrecision(d))

/** 0.6, −1.15, 1.2e-4 (as text) */
export function num(v: number, d = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '∞' : v < 0 ? '−∞' : '—'
  const a = Math.abs(v)
  const s = a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(d - 1) : String(sig(v, d))
  return s.replace('-', '−')
}

/** 0.6 + j0.4 (as text) */
export function cplx(z: Complex, d = 3): string {
  if (!isFiniteC(z)) return '∞'
  return `${num(z.re, d)} ${z.im < 0 ? '−' : '+'} j${num(Math.abs(z.im), d)}`
}

/** A number in TeX: 0.6, -1.15, 1.2\times10^{-4} */
export function tn(v: number, d = 3): string {
  if (!Number.isFinite(v)) return v > 0 ? '\\infty' : '-\\infty'
  const a = Math.abs(v)
  if (a !== 0 && (a < 1e-3 || a >= 1e5)) {
    const [m, e] = v.toExponential(d - 1).split('e')
    return `${m}\\times10^{${Number(e)}}`
  }
  return String(sig(v, d))
}

/** A complex number in TeX: 0.6 + j0.4 */
export function tc(z: Complex, d = 3): string {
  if (!isFiniteC(z)) return '\\infty'
  const im = `j${tn(Math.abs(z.im), d)}`
  if (sig(z.im, d) === 0) return tn(z.re, d)
  if (sig(z.re, d) === 0) return z.im < 0 ? `-${im}` : im
  return `${tn(z.re, d)} ${z.im < 0 ? '-' : '+'} ${im}`
}

/** A real number, bracketed when negative: (-0.4) */
const tneg = (v: number, d = 3) => (v < 0 ? `(${tn(v, d)})` : tn(v, d))

/** Bracketed if it has two terms: (0.6 + j0.4) */
const tp = (z: Complex, d = 3) => (isFiniteC(z) && ((sig(z.im, d) !== 0 && sig(z.re, d) !== 0) || tc(z, d).startsWith('-')) ? `(${tc(z, d)})` : tc(z, d))

const PREFIX: Array<[number, string]> = [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, '\\mu '], [1e-9, 'n'], [1e-12, 'p']] // no femto: RF people write 0.5 pF
/** 2.65e-9, 'H' → 2.65\,\text{nH} (TeX) */
export function teng(v: number, unit: string, d = 3): string {
  if (!Number.isFinite(v)) return '\\infty'
  const [m, p] = PREFIX.find(([k]) => Math.abs(v) >= k * 0.9995) ?? PREFIX[PREFIX.length - 1]
  // µ and Ω are symbols; letters are upright text
  const pre = p === '\\mu ' ? '\\mu' : p ? `\\text{${p}}` : ''
  const u = unit.startsWith('\\') ? unit : `\\text{${unit}}`
  return `${tn(v / m, d)}\\,${pre}${u}`
}
/** 2.65e-9, 'H' → "2.65 nH" (text) */
export function eng(v: number, unit: string, d = 3): string {
  if (!Number.isFinite(v)) return '∞'
  const [m, p] = PREFIX.find(([k]) => Math.abs(v) >= k * 0.9995) ?? PREFIX[PREFIX.length - 1]
  return `${num(v / m, d)} ${p.replace('\\mu ', 'µ')}${unit}`
}

const polarT = (g: Complex) => `${tn(abs(g))}\\angle ${tn(deg(arg(g)), 4)}^\\circ`
const polarText = (g: Complex) => `${num(abs(g))}∠${num(deg(arg(g)), 4)}°`

// ── Input ──

/** "0.3∠125°", "0.3<125", or anything parseComplex reads ("0.6+j0.4") */
export function parseCalcComplex(text: string): Complex | null {
  const m = /^\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(?:∠|<|@)\s*([-+−]?\d*\.?\d+(?:e[-+]?\d+)?)\s*°?\s*$/i.exec(text)
  if (m) {
    const r = rad(Number(m[2].replace('−', '-')))
    return c(Number(m[1]) * Math.cos(r), Number(m[1]) * Math.sin(r))
  }
  return parseComplex(text)
}

// ── 1. Converter ──

export type ConvertFrom = 'Z' | 'z' | 'Y' | 'y' | 'gamma'

export const CONVERT_FROM: Record<ConvertFrom, { label: string; hint: string }> = {
  Z: { label: 'Z (Ω)', hint: 'e.g. 30 + j20' },
  z: { label: 'z (normalised)', hint: 'e.g. 0.6 + j0.4' },
  Y: { label: 'Y (S)', hint: 'e.g. 0.02 − j0.01' },
  y: { label: 'y (normalised)', hint: 'e.g. 1.2 − j0.8' },
  gamma: { label: 'Γ', hint: 'e.g. 0.34∠121° or −0.2 + j0.3' }
}

/** Every form of one point, from whichever form was given, with the working. */
export function convert(from: ConvertFrom, value: Complex, z0: number): CalcResult {
  const steps: Step[] = []
  let z: Complex
  switch (from) {
    case 'Z':
      z = scale(value, 1 / z0)
      steps.push({ label: 'Normalise', tex: `z = \\frac{Z}{Z_0} = \\frac{${tc(value)}}{${tn(z0)}} = ${tc(z)}` })
      break
    case 'z':
      z = value
      break
    case 'Y': {
      const y = scale(value, z0)
      steps.push({ label: 'Normalise', tex: `y = Y Z_0 = ${tp(value)}\\cdot ${tn(z0)} = ${tc(y)}` })
      z = inv(y)
      steps.push({ label: 'Impedance', tex: `z = \\frac{1}{y} = \\frac{1}{${tc(y)}} = ${tc(z)}` })
      break
    }
    case 'y':
      z = inv(value)
      steps.push({ label: 'Impedance', tex: `z = \\frac{1}{y} = \\frac{1}{${tc(value)}} = ${tc(z)}` })
      break
    case 'gamma':
      z = zFromGamma(value, 1)
      steps.push({ label: 'Impedance', tex: `z = \\frac{1 + \\Gamma}{1 - \\Gamma} = \\frac{1 + ${tp(value)}}{1 - ${tp(value)}} = ${tc(z)}` })
      break
  }
  if (!isFiniteC(z)) return { outputs: [{ label: 'z', text: '∞ (open circuit)' }], steps, warning: 'That is an open circuit (z = ∞): Γ = 1, the right-hand end of the chart.' }

  const m = metricsFromZ(scale(z, z0), z0)
  const r = z.re, x = z.im
  if (from !== 'Z') steps.push({ label: 'In ohms', tex: `Z = z Z_0 = ${tp(z)}\\cdot ${tn(z0)} = ${tc(m.Z)}\\,\\Omega` })
  if (from !== 'y' && from !== 'Y') {
    const d = r * r + x * x
    steps.push({ label: 'Admittance', tex: `y = \\frac{1}{z} = \\frac{r - jx}{r^2 + x^2} = \\frac{${tc(c(r, -x))}}{${tneg(r)}^2 + ${tn(Math.abs(x))}^2} = ${d === 0 ? '\\infty' : tc(m.y)}` })
  }
  if (from !== 'Y') steps.push({ label: 'In siemens', tex: `Y = \\frac{y}{Z_0} = ${tc(m.Y)}\\,\\text{S}` })
  if (from !== 'gamma') steps.push({ label: 'Reflection', tex: `\\Gamma = \\frac{z - 1}{z + 1} = \\frac{${tc(c(r - 1, x))}}{${tc(c(r + 1, x))}} = ${polarT(m.gamma)}` })
  steps.push({ label: 'VSWR', tex: `\\text{VSWR} = \\frac{1 + |\\Gamma|}{1 - |\\Gamma|} = \\frac{1 + ${tn(m.gammaMag)}}{1 - ${tn(m.gammaMag)}} = ${tn(m.vswr)}` })
  steps.push({ label: 'Return loss', tex: `\\text{RL} = -20\\log_{10}|\\Gamma| = -20\\log_{10}(${tn(m.gammaMag)}) = ${tn(m.returnLossDb)}\\,\\text{dB}` })
  steps.push({ label: 'Node Q', tex: `Q = \\frac{|x|}{r} = \\frac{${tn(Math.abs(x))}}{${tn(r)}} = ${tn(m.q)}` })

  const outputs: Output[] = [
    { label: 'Z', text: `${cplx(m.Z)} Ω` },
    { label: 'z', text: cplx(z) },
    { label: 'y', text: cplx(m.y) },
    { label: 'Y', text: `${cplx(scale(m.Y, 1000))} mS` },
    { label: 'Γ', text: `${polarText(m.gamma)}  (${cplx(m.gamma)})` },
    { label: 'VSWR', text: num(m.vswr) },
    { label: 'Return loss', text: `${num(m.returnLossDb)} dB` },
    { label: 'Q', text: num(m.q) }
  ]
  const warning = r < 0 ? 'r is negative: the point is outside the chart (an active device, not a passive load).' : m.gammaMag > 1 + 1e-9 ? '|Γ| > 1: outside the chart.' : undefined
  return { outputs, steps, warning }
}

// ── 2. Reactance → component ──

export type Connection = 'series' | 'shunt'

/** The component a series reactance or shunt susceptance needs at f. */
export interface Component { kind: ElementKind; value: number; text: string }

/**
 * The part that adds normalised reactance x (series) or susceptance b (shunt) at f.
 * `amount` is normalised, or in Ω (series) / S (shunt) when `normalised` is false.
 */
export function componentFor(conn: Connection, amount: number, normalised: boolean, f: number, z0: number): CalcResult & { component?: Component } {
  const steps: Step[] = []
  const w = 2 * Math.PI * f
  steps.push({ label: 'Angular frequency', tex: `\\omega = 2\\pi f = 2\\pi\\cdot ${teng(f, 'Hz', 4)} = ${tn(w, 4)}\\,\\text{rad/s}` })
  if (amount === 0 || !Number.isFinite(amount)) return { outputs: [], steps, warning: 'Zero needs no component.' }
  let component: Component
  if (conn === 'series') {
    const X = normalised ? amount * z0 : amount
    if (normalised) steps.push({ label: 'Reactance in ohms', tex: `X = x Z_0 = ${tn(amount)}\\cdot ${tn(z0)} = ${tn(X)}\\,\\Omega` })
    if (X > 0) {
      const L = X / w
      steps.push({ label: 'Positive X: an inductor', tex: `X = \\omega L \\;\\Rightarrow\\; L = \\frac{X}{\\omega} = \\frac{${tn(X)}}{${tn(w, 4)}} = ${teng(L, 'H')}` })
      component = { kind: 'seriesL', value: L, text: `series L = ${eng(L, 'H')}` }
    } else {
      const C = -1 / (w * X)
      steps.push({ label: 'Negative X: a capacitor', tex: `X = -\\frac{1}{\\omega C} \\;\\Rightarrow\\; C = \\frac{1}{\\omega |X|} = \\frac{1}{${tn(w, 4)}\\cdot ${tn(Math.abs(X))}} = ${teng(C, 'F')}` })
      component = { kind: 'seriesC', value: C, text: `series C = ${eng(C, 'F')}` }
    }
    const xn = X / z0
    return { outputs: [{ label: 'Adds', text: `${xn > 0 ? '+' : '−'}j${num(Math.abs(xn))} to z (X = ${num(X)} Ω)` }, { label: 'Component', text: component.text }], steps, component }
  }
  const B = normalised ? amount / z0 : amount
  if (normalised) steps.push({ label: 'Susceptance in siemens', tex: `B = \\frac{b}{Z_0} = \\frac{${tn(amount)}}{${tn(z0)}} = ${teng(B, 'S')}` })
  if (B > 0) {
    const C = B / w
    steps.push({ label: 'Positive B: a capacitor', tex: `B = \\omega C \\;\\Rightarrow\\; C = \\frac{B}{\\omega} = \\frac{${tn(B)}}{${tn(w, 4)}} = ${teng(C, 'F')}` })
    component = { kind: 'shuntC', value: C, text: `shunt C = ${eng(C, 'F')}` }
  } else {
    const L = -1 / (w * B)
    steps.push({ label: 'Negative B: an inductor', tex: `B = -\\frac{1}{\\omega L} \\;\\Rightarrow\\; L = \\frac{1}{\\omega |B|} = \\frac{1}{${tn(w, 4)}\\cdot ${tn(Math.abs(B))}} = ${teng(L, 'H')}` })
    component = { kind: 'shuntL', value: L, text: `shunt L = ${eng(L, 'H')}` }
  }
  const bn = B * z0
  return { outputs: [{ label: 'Adds', text: `${bn > 0 ? '+' : '−'}j${num(Math.abs(bn))} to y (B = ${eng(B, 'S')})` }, { label: 'Component', text: component.text }], steps, component }
}

/**
 * The matching step: one series or shunt part that takes the point from one spot to
 * another. Series changes only x (r must stay put); shunt changes only b (g must).
 */
export function componentForMove(conn: Connection, zFrom: Complex, zTo: Complex, f: number, z0: number): CalcResult & { component?: Component } {
  const steps: Step[] = []
  let warning: string | undefined
  let amount: number
  if (conn === 'series') {
    amount = zTo.im - zFrom.im
    steps.push({ label: 'A series part adds jx', tex: `z_2 = z_1 + jx \\;\\Rightarrow\\; x = x_2 - x_1 = ${tn(zTo.im)} - ${tneg(zFrom.im)} = ${tn(amount)}` })
    if (Math.abs(zTo.re - zFrom.re) > 0.02 * Math.max(1, Math.abs(zFrom.re))) {
      warning = `A series part keeps r fixed, but r goes from ${num(zFrom.re)} to ${num(zTo.re)}: one series part can't make this move. Check both points are on the same r circle.`
    }
  } else {
    const yFrom = inv(zFrom), yTo = inv(zTo)
    steps.push({ label: 'Shunt parts add admittance', tex: `y_1 = \\frac{1}{z_1} = ${tc(yFrom)}, \\quad y_2 = \\frac{1}{z_2} = ${tc(yTo)}` })
    amount = yTo.im - yFrom.im
    steps.push({ label: 'A shunt part adds jb', tex: `y_2 = y_1 + jb \\;\\Rightarrow\\; b = b_2 - b_1 = ${tn(yTo.im)} - ${tneg(yFrom.im)} = ${tn(amount)}` })
    if (Math.abs(yTo.re - yFrom.re) > 0.02 * Math.max(1, Math.abs(yFrom.re))) {
      warning = `A shunt part keeps g fixed, but g goes from ${num(yFrom.re)} to ${num(yTo.re)}: one shunt part can't make this move. Check both points are on the same g circle.`
    }
  }
  const r = componentFor(conn, amount, true, f, z0)
  return { ...r, steps: [...steps, ...r.steps], warning: warning ?? r.warning }
}

// ── 3. A network, step by step ──

export interface NetworkStep {
  index: number
  title: string
  zBefore: Complex
  zAfter: Complex
  steps: Step[]
}

/** What each element does to z at f, in order from the load, with the working. */
export function networkSteps(ZL: Complex, network: NetworkElement[], f: number, z0: number): NetworkStep[] {
  const w = 2 * Math.PI * f
  const name = (i: number, n: number) => (i === 0 ? 'z_L' : i === n ? 'z_{in}' : `z_{${i}}`)
  const out: NetworkStep[] = []
  let Z = ZL
  network.forEach((el, i) => {
    const before = scale(Z, 1 / z0)
    const Zn = applyElement(Z, el, f)
    const after = scale(Zn, 1 / z0)
    const a = name(i, network.length), b = name(i + 1, network.length)
    const steps: Step[] = []
    const fT = teng(f, 'Hz', 4)
    if (!isFiniteC(before)) {
      steps.push({ label: 'Open circuit', tex: `${a} = \\infty` })
    } else if (el.kind === 'seriesL' || el.kind === 'seriesC' || el.kind === 'seriesR') {
      const add = el.kind === 'seriesR' ? c(el.value / z0, 0) : c(0, el.kind === 'seriesL' ? (w * el.value) / z0 : -1 / (w * el.value * z0))
      if (el.kind === 'seriesL') steps.push({ label: 'Normalised reactance', tex: `x = \\frac{\\omega L}{Z_0} = \\frac{2\\pi\\cdot ${fT}\\cdot ${teng(el.value, 'H')}}{${tn(z0)}} = ${tn(add.im)}` })
      else if (el.kind === 'seriesC') steps.push({ label: 'Normalised reactance', tex: `x = -\\frac{1}{\\omega C Z_0} = -\\frac{1}{2\\pi\\cdot ${fT}\\cdot ${teng(el.value, 'F')}\\cdot ${tn(z0)}} = ${tn(add.im)}` })
      else steps.push({ label: 'Normalised resistance', tex: `\\Delta r = \\frac{R}{Z_0} = \\frac{${teng(el.value, '\\Omega')}}{${tn(z0)}} = ${tn(add.re)}` })
      steps.push({ label: 'Series: add to z', tex: `${b} = ${a} + ${el.kind === 'seriesR' ? '\\Delta r' : 'jx'} = ${tp(before)} ${add.im < 0 ? '-' : '+'} ${el.kind === 'seriesR' ? tn(add.re) : `j${tn(Math.abs(add.im))}`} = ${tc(after)}` })
    } else if (isShunt(el.kind)) {
      const yB = inv(before)
      const yA = isFiniteC(after) ? inv(after) : c(0, 0)
      const db = yA.im - yB.im
      const ya = a.replace('z', 'y'), yb = b.replace('z', 'y')
      steps.push({ label: 'Switch to admittance', tex: `${ya} = \\frac{1}{${a}} = \\frac{1}{${tc(before)}} = ${tc(yB)}` })
      const zcN = tn((el.zc ?? z0) / z0)
      const theta = (el.value * f) / (el.refHz && el.refHz > 0 ? el.refHz : f)
      if (el.kind === 'shuntC') steps.push({ label: 'Normalised susceptance', tex: `b = \\omega C Z_0 = 2\\pi\\cdot ${fT}\\cdot ${teng(el.value, 'F')}\\cdot ${tn(z0)} = ${tn(db)}` })
      else if (el.kind === 'shuntL') steps.push({ label: 'Normalised susceptance', tex: `b = -\\frac{Z_0}{\\omega L} = -\\frac{${tn(z0)}}{2\\pi\\cdot ${fT}\\cdot ${teng(el.value, 'H')}} = ${tn(db)}` })
      else if (el.kind === 'shuntR') steps.push({ label: 'Normalised conductance', tex: `\\Delta g = \\frac{Z_0}{R} = \\frac{${tn(z0)}}{${teng(el.value, '\\Omega')}} = ${tn(yA.re - yB.re)}` })
      else if (el.kind === 'openStub') steps.push({ label: 'Open stub', tex: `b = \\frac{\\tan\\theta}{z_c} = \\frac{\\tan ${tn(theta, 4)}^\\circ}{${zcN}} = ${tn(db)}` })
      else steps.push({ label: 'Shorted stub', tex: `b = -\\frac{\\cot\\theta}{z_c} = -\\frac{\\cot ${tn(theta, 4)}^\\circ}{${zcN}} = ${tn(db)}` })
      const yAdd = el.kind === 'shuntR' ? tn(yA.re - yB.re) : `${db < 0 ? '-' : '+'} j${tn(Math.abs(db))}`
      steps.push({ label: 'Shunt: add to y', tex: `${yb} = ${ya} + ${el.kind === 'shuntR' ? '\\Delta g' : 'jb'} = ${tp(yB)} ${el.kind === 'shuntR' ? `+ ${yAdd}` : yAdd} = ${tc(yA)}` })
      steps.push({ label: 'Back to impedance', tex: `${b} = \\frac{1}{${yb}} = ${tc(after)}` })
    } else {
      // Transmission line: rotate about the centre (through Zc when it isn't Z0).
      const theta = (el.value * f) / (el.refHz && el.refHz > 0 ? el.refHz : f)
      const zc = el.zc ?? z0
      const t = Math.tan(rad(theta))
      if (Math.abs(zc - z0) < 1e-9) {
        steps.push({ label: 'Electrical length', tex: `\\beta\\ell = ${tn(theta, 4)}^\\circ \\;(${tn(theta / 360, 3)}\\lambda), \\quad \\tan\\beta\\ell = ${tn(t)}` })
        steps.push({ label: 'Line input', tex: `${b} = \\frac{${a} + j\\tan\\beta\\ell}{1 + j${a}\\tan\\beta\\ell} = \\frac{${tp(before)} + j${tn(t)}}{1 + j${tn(t)}\\,${tp(before)}} = ${tc(after)}` })
        const g1 = gammaFromZ(before, 1), g2 = gammaFromZ(after, 1)
        steps.push({ label: 'On the chart', tex: `|\\Gamma| = ${tn(abs(g1))} \\text{ stays the same;}\\; \\angle\\Gamma: ${tn(deg(arg(g1)), 4)}^\\circ \\to ${tn(deg(arg(g2)), 4)}^\\circ \\;(-2\\beta\\ell)` })
      } else {
        const ZcT = tn(zc)
        steps.push({ label: 'Electrical length', tex: `\\beta\\ell = ${tn(theta, 4)}^\\circ, \\quad \\tan\\beta\\ell = ${tn(t)}, \\quad Z_c = ${ZcT}\\,\\Omega` })
        steps.push({ label: 'Line input (Ω)', tex: `Z_{out} = Z_c\\frac{Z + jZ_c\\tan\\beta\\ell}{Z_c + jZ\\tan\\beta\\ell} = ${tc(Zn)}\\,\\Omega` })
        steps.push({ label: 'Normalise', tex: `${b} = \\frac{Z_{out}}{Z_0} = ${tc(after)}` })
      }
    }
    out.push({ index: i, title: `${ELEMENT_LABEL[el.kind]}`, zBefore: before, zAfter: after, steps })
    Z = Zn
  })
  return out
}

/** Plain-text one-liner of a result, for the chart log the tutor reads. */
export const summarize = (r: CalcResult) => r.outputs.map((o) => `${o.label} ${o.text}`).join('; ')
