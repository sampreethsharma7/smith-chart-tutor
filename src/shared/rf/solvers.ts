import { inv, type Complex } from './complex'
import type { ElementKind, NetworkElement } from './network'

export interface LMatchSolution {
  topology: 'series-first' | 'shunt-first'
  /** Elements ordered load → source */
  elements: Array<{ kind: ElementKind; value: number; reactanceOhm?: number; susceptanceS?: number }>
  description: string
}

const seriesEl = (X: number, w: number) =>
  X >= 0 ? { kind: 'seriesL' as const, value: X / w, reactanceOhm: X } : { kind: 'seriesC' as const, value: -1 / (w * X), reactanceOhm: X }
const shuntEl = (B: number, w: number) =>
  B >= 0 ? { kind: 'shuntC' as const, value: B / w, susceptanceS: B } : { kind: 'shuntL' as const, value: -1 / (w * B), susceptanceS: B }

/** All two-element lumped L-network solutions matching ZL to a real Z0 at f. */
export function solveLMatch(ZL: Complex, z0: number, f: number): LMatchSolution[] {
  const w = 2 * Math.PI * f
  const out: LMatchSolution[] = []
  const { re: RL, im: XL } = ZL

  // Series element at the load, then shunt (needs RL ≤ Z0)
  if (RL > 0 && RL <= z0) {
    for (const s of [1, -1]) {
      const xt = s * Math.sqrt(RL * (z0 - RL)) // total series reactance XL + X
      const X = xt - XL
      const B = xt / (RL * z0)
      const els = [seriesEl(X, w), shuntEl(B, w)]
      if (Math.abs(X) < 1e-9) els.shift()
      out.push({ topology: 'series-first', elements: els, description: `series X = ${X.toFixed(2)} Ω, then shunt B = ${(B * 1e3).toFixed(3)} mS` })
    }
  }

  // Shunt element at the load, then series (needs GL ≤ 1/Z0)
  const YL = inv(ZL)
  const GL = YL.re
  const BL = YL.im
  if (GL > 0 && GL <= 1 / z0) {
    for (const s of [1, -1]) {
      const bt = s * Math.sqrt(GL * (1 / z0 - GL)) // total shunt susceptance BL + B
      const B = bt - BL
      const X = (bt * z0) / GL
      const els = [shuntEl(B, w), seriesEl(X, w)]
      if (Math.abs(B) < 1e-12) els.shift()
      out.push({ topology: 'shunt-first', elements: els, description: `shunt B = ${(B * 1e3).toFixed(3)} mS, then series X = ${X.toFixed(2)} Ω` })
    }
  }
  return out
}

export function toNetwork(sol: LMatchSolution): NetworkElement[] {
  return sol.elements.map((e, i) => ({ id: `sol_${i}`, kind: e.kind, value: e.value }))
}


export interface StubSolution {
  /** Line from the load to the stub, electrical degrees at f (0 = stub right at the load) */
  lineDeg: number
  stub: 'openStub' | 'shortStub'
  /** Stub length, electrical degrees at f */
  stubDeg: number
  description: string
}

/**
 * Single shunt-stub matches at f: a line (Zc = z0) from the load to where g = 1, then an open or
 * shorted stub that cancels the susceptance there. Both crossings of the g = 1 circle, each with
 * both stub kinds, shortest line first.
 */
export function solveSingleStub(ZL: Complex, z0: number): StubSolution[] {
  const zl = { re: ZL.re / z0, im: ZL.im / z0 }
  if (!(zl.re > 0) || !Number.isFinite(zl.re) || !Number.isFinite(zl.im)) return []
  // Normalized admittance after a line of t radians (Zc = z0).
  const yAt = (t: number) => {
    const tn = Math.tan(t)
    // z(t) = (zl + j tn) / (1 + j tn zl)
    const nr = zl.re, ni = zl.im + tn
    const dr = 1 - tn * zl.im, di = tn * zl.re
    // y = 1/z = (dr + j di) / (nr + j ni)
    const m = nr * nr + ni * ni
    return { g: (dr * nr + di * ni) / m, b: (di * nr - dr * ni) / m }
  }
  const crossings: number[] = []
  if (Math.abs(yAt(0).g - 1) < 1e-9) crossings.push(0)
  const N = 3600
  const h = (k: number) => yAt((Math.PI * k) / N).g - 1
  for (let k = 0; k < N; k++) {
    let a = k, bnd = k + 1
    let fa = h(a), fb = h(bnd)
    if (!Number.isFinite(fa) || !Number.isFinite(fb) || fa === 0 || Math.sign(fa) === Math.sign(fb)) continue
    let lo = (Math.PI * a) / N, hi = (Math.PI * bnd) / N
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2
      const fm = yAt(mid).g - 1
      if (Math.sign(fm) === Math.sign(fa)) { lo = mid; fa = fm } else hi = mid
    }
    crossings.push((lo + hi) / 2)
  }
  const deg = (r: number) => (r * 180) / Math.PI
  const wrap = (r: number) => ((r % Math.PI) + Math.PI) % Math.PI
  const out: StubSolution[] = []
  for (const t of crossings) {
    const b = yAt(t).b
    if (Math.abs(b) < 1e-9) continue // already matched there: no stub needed (a line alone)
    // Open stub adds j·tan(θ); shorted adds −j·cot(θ). Each must add −b.
    const open = wrap(Math.atan(-b))
    const short = wrap(Math.atan(1 / b))
    for (const [stub, s] of [['openStub', open], ['shortStub', short]] as const) {
      out.push({ lineDeg: deg(t), stub, stubDeg: deg(s), description: `line ${deg(t).toFixed(1)}°, then ${stub === 'openStub' ? 'open' : 'shorted'} stub ${deg(s).toFixed(1)}° (cancels b = ${b.toFixed(3)})` })
    }
  }
  return out.sort((x, y) => x.lineDeg - y.lineDeg || x.stubDeg - y.stubDeg)
}

export function stubNetwork(s: StubSolution, z0: number, f: number): NetworkElement[] {
  return [
    ...(s.lineDeg > 1e-6 ? [{ id: 'stub_line', kind: 'tline' as const, value: s.lineDeg, zc: z0, refHz: f }] : []),
    { id: 'stub', kind: s.stub, value: s.stubDeg, zc: z0, refHz: f }
  ]
}
