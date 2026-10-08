import { abs, c, deg, isFiniteC, type Complex } from './complex'
import { gammaFromZ } from './metrics'
import { applyElement, ELEMENT_LABEL, isShunt, type NetworkElement } from './network'

/**
 * Exact, qualitative description of one element's move on the chart: which
 * circle it follows, which way it turns, which half it starts and ends in, and
 * where (if anywhere) it crosses the real axis. The tutor states these facts
 * from here, never from memory.
 *
 * Chart convention: impedance Smith chart (Γ-plane) with +j up. In impedance
 * terms the upper half is x > 0 (inductive). Read as admittance on the same
 * chart, the signs flip: the upper half is b < 0 and the lower half b > 0.
 */
export interface MoveFacts {
  element: string
  follows: string
  rotation: 'clockwise' | 'counter-clockwise' | 'none'
  turned_deg: number
  start: PointFacts
  end: PointFacts
  real_axis: string
  summary: string
}

interface PointFacts {
  z: string
  y: string
  chart_half: 'upper' | 'lower' | 'on the real axis'
  /** What that half means in impedance and in admittance terms */
  meaning: string
}

const r2 = (v: number) => (Math.abs(v) < 5e-4 ? '0' : (Math.round(v * 100) / 100).toString())
const fmtZ = (z: Complex, im = 'j') => `${r2(z.re)} ${z.im < 0 ? '−' : '+'} ${im}${r2(Math.abs(z.im))}`

function pointFacts(Z: Complex, z0: number): PointFacts {
  if (!isFiniteC(Z)) return { z: 'open (∞)', y: '0', chart_half: 'on the real axis', meaning: 'open circuit, right edge' }
  const z = c(Z.re / z0, Z.im / z0)
  const d = z.re * z.re + z.im * z.im
  const y = d === 0 ? c(Infinity, 0) : c(z.re / d, -z.im / d)
  const half = Math.abs(z.im) < 1e-3 ? 'on the real axis' : z.im > 0 ? 'upper' : 'lower'
  const meaning = half === 'upper'
    ? 'impedance: inductive, x > 0; as admittance: b < 0'
    : half === 'lower'
      ? 'impedance: capacitive, x < 0; as admittance: b > 0'
      : 'purely resistive (x = 0, b = 0)'
  return { z: fmtZ(z), y: isFiniteC(y) ? fmtZ(y) : '∞ (short)', chart_half: half, meaning }
}

export function describeMove(Zstart: Complex, el: NetworkElement, f: number, z0: number, samples = 96): MoveFacts {
  const label = ELEMENT_LABEL[el.kind]
  // Trace the actual path: the element grows from nothing to its full value.
  const pts: Complex[] = []
  for (let i = 0; i <= samples; i++) pts.push(applyElement(Zstart, el, f, i / samples))
  const Zend = pts[pts.length - 1]
  const g = pts.map((Z) => gammaFromZ(Z, z0))

  const z = c(Zstart.re / z0, Zstart.im / z0)
  const dz = z.re * z.re + z.im * z.im
  const gS = dz === 0 ? Infinity : z.re / dz
  let follows: string
  let centre: Complex | null
  if (el.kind === 'tline') {
    const matched = Math.abs((el.zc ?? z0) - z0) < 1e-9
    follows = matched ? `a circle around the chart centre (constant |Γ| = ${r2(abs(g[0]))})` : `a circle centred on z = ${r2((el.zc ?? z0) / z0)} (line Zc ≠ Z0, so |Γ| changes)`
    centre = matched ? c(0, 0) : null
  } else if (el.kind === 'seriesR') {
    follows = `the constant x = ${r2(z.im)} arc (resistance changes, reactance doesn't)`
    centre = null
  } else if (el.kind === 'shuntR') {
    follows = `the constant b arc (conductance changes, susceptance doesn't)`
    centre = null
  } else if (isShunt(el.kind)) {
    follows = `the constant g = ${r2(gS)} circle (red admittance circle, touches the short at the left edge)`
    centre = c(-gS / (1 + gS), 0)
  } else {
    follows = `the constant r = ${r2(z.re)} circle (touches the open at the right edge)`
    centre = c(z.re / (1 + z.re), 0)
  }

  // Signed angle swept around the circle's centre, summed along the path (works for moves over 180°).
  let turned = 0
  if (centre) {
    for (let i = 1; i < g.length; i++) {
      if (!isFiniteC(g[i]) || !isFiniteC(g[i - 1])) continue
      const a0 = Math.atan2(g[i - 1].im - centre.im, g[i - 1].re - centre.re)
      const a1 = Math.atan2(g[i].im - centre.im, g[i].re - centre.re)
      let d = a1 - a0
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      turned += d
    }
  }
  const rotation = !centre || Math.abs(turned) < 1e-6 ? 'none' : turned < 0 ? 'clockwise' : 'counter-clockwise'

  // Where the path crosses the real axis, if it does.
  const crossings: number[] = []
  for (let i = 1; i < g.length; i++) {
    const a = g[i - 1], b = g[i]
    if (!isFiniteC(a) || !isFiniteC(b)) continue
    if ((a.im > 1e-9 && b.im < -1e-9) || (a.im < -1e-9 && b.im > 1e-9)) crossings.push(a.re + ((b.re - a.re) * a.im) / (a.im - b.im))
  }
  const real_axis = crossings.length === 0
    ? 'does not cross the real axis'
    : crossings.map((x) => {
      const edge = x > 0.98 ? ' (at the open-circuit edge, right)' : x < -0.98 ? ' (at the short-circuit edge, left)' : ', on the side facing the chart centre (not around the edge)'
      const zr = (1 + x) / (1 - x)
      return `crosses at Γ = ${r2(x)} (z = ${r2(zr)})${edge}`
    }).join('; ')

  const start = pointFacts(Zstart, z0)
  const end = pointFacts(Zend, z0)
  const halves = start.chart_half === end.chart_half ? `stays in the ${start.chart_half} half` : `goes from the ${start.chart_half} half to the ${end.chart_half} half`
  const turn = rotation === 'none' ? '' : `, ${rotation} by ${Math.round(Math.abs(deg(turned)))}°`
  return {
    element: label,
    follows,
    rotation,
    turned_deg: Math.round(Math.abs(deg(turned))),
    start,
    end,
    real_axis,
    summary: `${label}: z ${start.z} → ${end.z} (y ${start.y} → ${end.y}); moves along ${follows}${turn}; ${halves} of the chart; ${real_axis}.`
  }
}
