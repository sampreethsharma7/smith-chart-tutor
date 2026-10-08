import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Complex } from '@shared/rf/complex'
import { metricsFromZ, type PointMetrics } from '@shared/rf/metrics'
import {
  computeTrace, inputImpedance, loadImpedance, networkPath, sweepFreqs, traceBands,
  type Band, type TracePoint
} from '@shared/rf/network'
import { useStudio, type StudioSnapshot } from './studio'

export interface Derived {
  freqs: number[]
  trace: TracePoint[]
  loadBands: Band[]
  inputBands: Band[]
  design: { f: number; ZL: Complex; Zin: Complex; load: PointMetrics; input: PointMetrics }
  path: Complex[][]
  markers: Array<{ f: number; load: PointMetrics; input: PointMetrics }>
}

/** Pure computation of everything the chart shows; also used by the tutor's tools. */
export function computeDerived(s: Omit<StudioSnapshot, 'annotations' | 'exercise' | 'prediction' | 'showBand'>): Derived {
  const ds = s.load.kind === 'data' ? s.datasets.find((d) => d.id === (s.load as { datasetId: string }).datasetId) : undefined
  // For measured data, sweep the data's own frequency points (within the sweep window if it overlaps).
  let freqs = sweepFreqs(s.sweep)
  if (ds) {
    const inWin = ds.freqs.filter((f) => f >= s.sweep.start && f <= s.sweep.stop)
    freqs = inWin.length > 2 ? inWin : ds.freqs
  }
  const trace = computeTrace(s.load, s.network, freqs, s.z0, s.datasets)
  const thr = s.overlays.vswrCircle ?? 2
  const ZL = loadImpedance(s.load, s.designFreq, s.datasets)
  const Zin = inputImpedance(ZL, s.network, s.designFreq)
  return {
    freqs,
    trace,
    loadBands: traceBands(trace, s.z0, thr, false),
    inputBands: traceBands(trace, s.z0, thr, true),
    design: {
      f: s.designFreq, ZL, Zin,
      load: metricsFromZ(ZL, s.z0, s.designFreq),
      input: metricsFromZ(Zin, s.z0, s.designFreq)
    },
    path: networkPath(ZL, s.network, s.designFreq, s.z0),
    markers: s.markers.map((f) => {
      const zl = loadImpedance(s.load, f, s.datasets)
      return { f, load: metricsFromZ(zl, s.z0, f), input: metricsFromZ(inputImpedance(zl, s.network, f), s.z0, f) }
    })
  }
}

export function useDerived(): Derived {
  const snap = useStudio(
    useShallow((s) => ({
      z0: s.z0, load: s.load, datasets: s.datasets, sweep: s.sweep, designFreq: s.designFreq,
      markers: s.markers, network: s.network, overlays: s.overlays
    }))
  )
  return useMemo(() => computeDerived(snap), [snap])
}

/** One row of the results table under the chart. */
export interface ResultRow { name: string; title: string; f: number; load: PointMetrics; input: PointMetrics }

/**
 * Rows of the results table: the design frequency always; the markers only when the
 * frequency band is shown (they are points on the sweep, which single-frequency mode hides).
 */
export function resultRows(d: Derived, band: boolean): ResultRow[] {
  const design: ResultRow = { name: 'Design', title: 'The design frequency: the L and IN points on the chart', f: d.design.f, load: d.design.load, input: d.design.input }
  return [design, ...(band ? d.markers.map((m, i) => ({ name: `M${i + 1}`, title: `Marker ${i + 1}`, f: m.f, load: m.load, input: m.input })) : [])]
}
