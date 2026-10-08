import { metricsFromZ } from './metrics'
import { bandsFromValues, inputImpedance, loadImpedance, sweepFreqs, type Dataset, type LoadModel, type NetworkElement } from './network'
import { solveLMatch, solveSingleStub, stubNetwork, toNetwork } from './solvers'
import type { Complex } from './complex'

/** What a design is judged against. */
export interface DesignGoal {
  z0: number
  /** The frequency the match is designed at */
  f0: number
  /** The band that has to work (default: just f0) */
  band?: { low: number; high: number }
  /** VSWR target (default 2) */
  vswrMax?: number
}

export interface DesignResult {
  /** At f0 */
  zin: Complex
  vswr: number
  returnLossDb: number
  /** Over the requested band */
  band?: { low: number; high: number; worstVswr: number; worstAt: number; meets: boolean }
  /** The continuous stretch around f0 where VSWR ≤ target, within the window searched */
  bandwidth?: { low: number; high: number; fractional: number; clipped: boolean }
}

/** How a network performs on this load: at f0, across the band, and how wide its match is. */
export function evaluateDesign(load: LoadModel, datasets: Dataset[], network: NetworkElement[], goal: DesignGoal): DesignResult {
  const { z0, f0 } = goal
  const thr = goal.vswrMax ?? 2
  const zinAt = (f: number) => inputImpedance(loadImpedance(load, f, datasets), network, f)
  const zin = zinAt(f0)
  const m = metricsFromZ(zin, z0, f0)
  const out: DesignResult = { zin, vswr: m.vswr, returnLossDb: m.returnLossDb }

  if (goal.band && goal.band.high > goal.band.low) {
    const fs = sweepFreqs({ start: goal.band.low, stop: goal.band.high, points: 201 })
    let worstVswr = 0, worstAt = fs[0]
    for (const f of fs) {
      const v = metricsFromZ(zinAt(f), z0, f).vswr
      if (!(v <= worstVswr)) { worstVswr = v; worstAt = f }
    }
    out.band = { ...goal.band, worstVswr, worstAt, meets: worstVswr <= thr }
  }

  // Bandwidth: search a window around f0 (±50%, or the data's own range for measured loads).
  const ds = load.kind === 'data' ? datasets.find((d) => d.id === load.datasetId) : undefined
  const lo = ds ? Math.max(ds.freqs[0], f0 * 0.5) : f0 * 0.5
  const hi = ds ? Math.min(ds.freqs[ds.freqs.length - 1], f0 * 1.5) : f0 * 1.5
  if (hi > lo && f0 >= lo && f0 <= hi) {
    const fs = sweepFreqs({ start: lo, stop: hi, points: 801 })
    const bands = bandsFromValues(fs, fs.map((f) => metricsFromZ(zinAt(f), z0, f).vswr), thr)
    const b = bands.find((x) => x.fLow <= f0 && x.fHigh >= f0)
    if (b) out.bandwidth = { low: b.fLow, high: b.fHigh, fractional: b.fractional, clipped: b.clipped }
  }
  return out
}

export interface Candidate {
  id: string
  family: 'L' | 'stub'
  /** Load → source */
  elements: NetworkElement[]
  detail: string
}

/** Every standard match at f0: the lumped L-networks and the single shunt-stub ones. */
export function matchCandidates(ZL: Complex, z0: number, f0: number): Candidate[] {
  const ls = solveLMatch(ZL, z0, f0).map((s, i) => ({ id: `L${i + 1}`, family: 'L' as const, elements: toNetwork(s), detail: `${s.topology}: ${s.description}` }))
  // Of the stub matches, the two shortest lines, each with the shorter of its two stubs.
  const stubs = solveSingleStub(ZL, z0)
  const best = new Map<string, (typeof stubs)[number]>()
  for (const s of stubs) {
    const k = s.lineDeg.toFixed(3)
    const cur = best.get(k)
    if (!cur || s.stubDeg < cur.stubDeg) best.set(k, s)
  }
  const st = [...best.values()].slice(0, 2).map((s, i) => ({ id: `S${i + 1}`, family: 'stub' as const, elements: stubNetwork(s, z0, f0), detail: s.description }))
  return [...ls, ...st]
}
