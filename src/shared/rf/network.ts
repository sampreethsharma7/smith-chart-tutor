import { Complex, add, c, div, inv, isFiniteC, lerp, mul, rad, scale } from './complex'
import { gammaFromZ, metricsFromZ, zFromGamma } from './metrics'

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

export type LoadModel =
  | { kind: 'fixed'; R: number; X: number }
  /** C = 0 means "no capacitor" (shorted) */
  | { kind: 'seriesRLC'; R: number; L: number; C: number }
  /** L = 0 or C = 0 means "element absent" (open) */
  | { kind: 'parallelRLC'; R: number; L: number; C: number }
  /** Resonant antenna approximation: series ≈ dipole/monopole, parallel ≈ patch */
  | { kind: 'antenna'; topology: 'series' | 'parallel'; f0: number; R: number; Q: number }
  | { kind: 'data'; datasetId: string }

export interface Dataset {
  id: string
  name: string
  /** e.g. "Touchstone .s1p" or "CST ASCII" */
  source: string
  /** Reference impedance of the stored reflection coefficients */
  z0: number
  freqs: number[]
  gamma: Complex[]
  notes?: string[]
}

const OPEN = c(Infinity, 0)

function toY(Z: Complex): Complex {
  if (!isFiniteC(Z)) return c(0, 0)
  return inv(Z)
}
function toZ(Y: Complex): Complex {
  if (Y.re === 0 && Y.im === 0) return OPEN
  return inv(Y)
}

/** Interpolate a dataset's Γ at f (linear in re/im, clamped to the data range). */
export function datasetGamma(ds: Dataset, f: number): Complex {
  const { freqs, gamma } = ds
  if (freqs.length === 0) return c(0)
  if (f <= freqs[0]) return gamma[0]
  if (f >= freqs[freqs.length - 1]) return gamma[gamma.length - 1]
  let lo = 0
  let hi = freqs.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (freqs[mid] <= f) lo = mid
    else hi = mid
  }
  return lerp(gamma[lo], gamma[hi], (f - freqs[lo]) / (freqs[hi] - freqs[lo]))
}

export function loadImpedance(load: LoadModel, f: number, datasets: Dataset[] = []): Complex {
  const w = 2 * Math.PI * f
  switch (load.kind) {
    case 'fixed':
      return c(load.R, load.X)
    case 'seriesRLC': {
      const x = w * load.L - (load.C > 0 ? 1 / (w * load.C) : 0)
      return c(load.R, x)
    }
    case 'parallelRLC': {
      let Y = c(load.R > 0 ? 1 / load.R : 0, 0)
      if (load.L > 0) Y = add(Y, c(0, -1 / (w * load.L)))
      if (load.C > 0) Y = add(Y, c(0, w * load.C))
      return toZ(Y)
    }
    case 'antenna': {
      const w0 = 2 * Math.PI * load.f0
      if (load.topology === 'series') {
        const L = (load.Q * load.R) / w0
        const C = 1 / (w0 * w0 * L)
        return c(load.R, w * L - 1 / (w * C))
      }
      const C = load.Q / (w0 * load.R)
      const L = 1 / (w0 * w0 * C)
      return toZ(c(1 / load.R, w * C - 1 / (w * L)))
    }
    case 'data': {
      const ds = datasets.find((d) => d.id === load.datasetId)
      if (!ds) return c(NaN, NaN)
      return zFromGamma(datasetGamma(ds, f), ds.z0)
    }
  }
}

// ---------------------------------------------------------------------------
// Matching-network elements (ordered from the load toward the source)
// ---------------------------------------------------------------------------

export type ElementKind =
  | 'seriesL' | 'seriesC' | 'seriesR'
  | 'shuntL' | 'shuntC' | 'shuntR'
  | 'tline' | 'openStub' | 'shortStub'

export interface NetworkElement {
  id: string
  kind: ElementKind
  /** H for L, F for C, Ω for R, electrical length in degrees (at refHz) for lines/stubs */
  value: number
  /** Characteristic impedance for lines and stubs */
  zc?: number
  /** Frequency at which `value` (electrical length) is specified */
  refHz?: number
}

export const ELEMENT_LABEL: Record<ElementKind, string> = {
  seriesL: 'Series L', seriesC: 'Series C', seriesR: 'Series R',
  shuntL: 'Shunt L', shuntC: 'Shunt C', shuntR: 'Shunt R',
  tline: 'Transmission line', openStub: 'Open stub (shunt)', shortStub: 'Shorted stub (shunt)'
}

export const isShunt = (k: ElementKind) => k.startsWith('shunt') || k.endsWith('Stub')

/** Line electrical length at f, in radians. */
function lineTheta(el: NetworkElement, f: number): number {
  const ref = el.refHz && el.refHz > 0 ? el.refHz : f
  return rad(el.value) * (f / ref)
}

/** Series reactance (Ω) or shunt susceptance (S) that an element adds at f. */
function elementImmittance(el: NetworkElement, f: number): Complex {
  const w = 2 * Math.PI * f
  const zc = el.zc ?? 50
  switch (el.kind) {
    case 'seriesL': return c(0, w * el.value)
    case 'seriesC': return c(0, el.value > 0 ? -1 / (w * el.value) : 0)
    case 'seriesR': return c(el.value, 0)
    case 'shuntL': return c(0, el.value > 0 ? -1 / (w * el.value) : 0)
    case 'shuntC': return c(0, w * el.value)
    case 'shuntR': return c(el.value > 0 ? 1 / el.value : 0, 0)
    case 'openStub': return c(0, Math.tan(lineTheta(el, f)) / zc)
    case 'shortStub': {
      const t = Math.tan(lineTheta(el, f))
      return c(0, t === 0 ? -1e12 : -1 / (zc * t))
    }
    case 'tline': return c(0, 0)
  }
}

function transformLine(Z: Complex, zc: number, theta: number): Complex {
  const t = Math.tan(theta)
  if (!isFiniteC(Z)) return Math.abs(t) < 1e-15 ? OPEN : c(0, -zc / t)
  const num = add(Z, c(0, zc * t))
  const den = add(c(zc), mul(c(0, t), Z))
  return scale(div(num, den), zc)
}

/**
 * Apply one element. `t` ∈ [0, 1] sweeps the element "on" gradually, which is
 * what we use to draw the path on the chart (reactance/susceptance grows
 * linearly; a line grows in electrical length).
 */
export function applyElement(Z: Complex, el: NetworkElement, f: number, t = 1): Complex {
  if (el.kind === 'tline') return transformLine(Z, el.zc ?? 50, lineTheta(el, f) * t)
  const imm = scale(elementImmittance(el, f), t)
  if (isShunt(el.kind)) return toZ(add(toY(Z), imm))
  if (!isFiniteC(Z)) return OPEN
  return add(Z, imm)
}

export function inputImpedance(ZL: Complex, network: NetworkElement[], f: number): Complex {
  return network.reduce((Z, el) => applyElement(Z, el, f), ZL)
}

/** Γ path traced by each element at frequency f (one polyline per element). */
export function networkPath(
  ZL: Complex, network: NetworkElement[], f: number, z0: number, samples = 48
): Complex[][] {
  const paths: Complex[][] = []
  let Z = ZL
  for (const el of network) {
    const pts: Complex[] = []
    for (let i = 0; i <= samples; i++) pts.push(gammaFromZ(applyElement(Z, el, f, i / samples), z0))
    paths.push(pts)
    Z = applyElement(Z, el, f)
  }
  return paths
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

export interface SweepSpec {
  start: number
  stop: number
  points: number
}

export interface TracePoint {
  f: number
  ZL: Complex
  Zin: Complex
  gammaL: Complex
  gammaIn: Complex
}

export function sweepFreqs(s: SweepSpec): number[] {
  const n = Math.max(2, Math.floor(s.points))
  return Array.from({ length: n }, (_, i) => s.start + ((s.stop - s.start) * i) / (n - 1))
}

export function computeTrace(
  load: LoadModel, network: NetworkElement[], freqs: number[], z0: number, datasets: Dataset[] = []
): TracePoint[] {
  return freqs.map((f) => {
    const ZL = loadImpedance(load, f, datasets)
    const Zin = inputImpedance(ZL, network, f)
    return { f, ZL, Zin, gammaL: gammaFromZ(ZL, z0), gammaIn: gammaFromZ(Zin, z0) }
  })
}

/**
 * The point of a sweep trace nearest to q (a cursor), if it's within tol: the frequency there
 * and Γ, interpolated between the sweep's samples so the frequency reads finer than the sweep step.
 * The chart has no frequency axis; this is how hovering a trace tells you its frequency.
 */
export function nearestOnTrace(points: Array<{ f: number; g: Complex }>, q: Complex, tol: number): { f: number; g: Complex } | null {
  let best: { f: number; g: Complex; d: number } | null = null
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    if (!isFiniteC(a.g)) continue
    const b = points[i + 1]
    let t = 0
    if (b && isFiniteC(b.g)) {
      const ex = b.g.re - a.g.re, ey = b.g.im - a.g.im
      const len2 = ex * ex + ey * ey
      t = len2 > 0 ? Math.max(0, Math.min(1, ((q.re - a.g.re) * ex + (q.im - a.g.im) * ey) / len2)) : 0
    }
    const g = t > 0 && b ? lerp(a.g, b.g, t) : a.g
    const d = Math.hypot(q.re - g.re, q.im - g.im)
    if (d <= tol && (!best || d < best.d)) best = { f: t > 0 && b ? a.f + (b.f - a.f) * t : a.f, g, d }
  }
  return best && { f: best.f, g: best.g }
}

export interface Band {
  fLow: number
  fHigh: number
  center: number
  bandwidth: number
  fractional: number
  /** True when the band touches the edge of the sweep (real band may be wider) */
  clipped: boolean
}

/** Frequency ranges where values ≤ threshold, with linearly interpolated edges. */
export function bandsFromValues(freqs: number[], values: number[], threshold: number): Band[] {
  const bands: Band[] = []
  let start: number | null = null
  let startClipped = false
  const cross = (i: number) => {
    const v0 = values[i - 1], v1 = values[i]
    const t = (threshold - v0) / (v1 - v0)
    return freqs[i - 1] + (freqs[i] - freqs[i - 1]) * (Number.isFinite(t) ? t : 0)
  }
  for (let i = 0; i < freqs.length; i++) {
    const ok = values[i] <= threshold
    if (ok && start === null) {
      start = i === 0 ? freqs[0] : cross(i)
      startClipped = i === 0
    } else if (!ok && start !== null) {
      bands.push(mkBand(start, cross(i), startClipped))
      start = null
    }
  }
  if (start !== null) bands.push(mkBand(start, freqs[freqs.length - 1], true))
  return bands
}

function mkBand(fLow: number, fHigh: number, clipped: boolean): Band {
  const center = (fLow + fHigh) / 2
  const bandwidth = fHigh - fLow
  return { fLow, fHigh, center, bandwidth, fractional: center > 0 ? bandwidth / center : 0, clipped }
}

/** Convenience: VSWR ≤ threshold bands of a trace referenced to z0. */
export function traceBands(trace: TracePoint[], z0: number, threshold = 2, useInput = true): Band[] {
  const values = trace.map((p) => metricsFromZ(useInput ? p.Zin : p.ZL, z0).vswr)
  return bandsFromValues(trace.map((p) => p.f), values, threshold)
}
