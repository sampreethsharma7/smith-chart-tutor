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

