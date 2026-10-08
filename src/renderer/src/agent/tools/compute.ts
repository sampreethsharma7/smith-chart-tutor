import { c, polar, rad } from '@shared/rf/complex'
import { metricsFromGamma, metricsFromZ } from '@shared/rf/metrics'
import { applyElement, ELEMENT_LABEL, loadImpedance, inputImpedance, sweepFreqs, type ElementKind, type NetworkElement } from '@shared/rf/network'
import { solveLMatch } from '@shared/rf/solvers'
import { describeMove } from '@shared/rf/moves'
import { fmtC, fmtEng, fmtHz } from '@/lib/format'
import { defineTools } from '../types'
import { brief, ELEMENT_KINDS } from './chart'

/** A moderate element (half a unit of normalized reactance or susceptance) when no value is given. */
export function typicalValue(kind: ElementKind, f: number, z0: number): number {
  const w = 2 * Math.PI * f
  switch (kind) {
    case 'seriesL': return (0.5 * z0) / w
    case 'seriesC': return 1 / (w * 0.5 * z0)
    case 'shuntL': return z0 / (0.5 * w)
    case 'shuntC': return 0.5 / (z0 * w)
    case 'seriesR': return 0.5 * z0
    case 'shuntR': return 2 * z0
    default: return 45
  }
}

export default defineTools([
  {
    name: 'rf_calculate',
    description: 'Exact RF calculator. Give ONE of: impedance_ohm {r,x}, normalized_z {r,x}, normalized_y {g,b}, or gamma {mag, angle_deg}. Returns Z, z, y, Γ, VSWR, return loss, mismatch loss, Q, WTG/WTL and series/shunt equivalent L/C. Always use this instead of mental arithmetic before stating numbers.',
    parameters: {
      type: 'object',
      properties: {
        impedance_ohm: { type: 'object', properties: { r: { type: 'number' }, x: { type: 'number' } } },
        normalized_z: { type: 'object', properties: { r: { type: 'number' }, x: { type: 'number' } } },
        normalized_y: { type: 'object', properties: { g: { type: 'number' }, b: { type: 'number' } } },
        gamma: { type: 'object', properties: { mag: { type: 'number' }, angle_deg: { type: 'number' } } },
        z0: { type: 'number', description: 'Defaults to the chart Z0' },
        freq_hz: { type: 'number', description: 'Defaults to the design frequency' }
      }
    },
    activity: () => 'Calculating',
    run(a, ctx) {
      const z0 = a.z0 ?? ctx.studio.z0
      const f = a.freq_hz ?? ctx.studio.designFreq
      let m
      if (a.impedance_ohm) m = metricsFromZ(c(a.impedance_ohm.r ?? 0, a.impedance_ohm.x ?? 0), z0, f)
      else if (a.normalized_z) m = metricsFromZ(c((a.normalized_z.r ?? 0) * z0, (a.normalized_z.x ?? 0) * z0), z0, f)
      else if (a.normalized_y) {
        const g = a.normalized_y.g ?? 0, b = a.normalized_y.b ?? 0, d = g * g + b * b
        m = metricsFromZ(d === 0 ? c(Infinity) : c((g / d) * z0, (-b / d) * z0), z0, f)
      } else if (a.gamma) m = metricsFromGamma(polar(a.gamma.mag, rad(a.gamma.angle_deg ?? 0)), z0, f)
      else throw new Error('Provide impedance_ohm, normalized_z, normalized_y or gamma')
      const eq = (e?: { kind: string; value: number }) => (!e || e.kind === 'none' ? null : fmtEng(e.value, e.kind === 'L' ? 'H' : 'F'))
      return {
        ...brief(m),
        Y_mS: fmtC(c(m.Y.re * 1e3, m.Y.im * 1e3)),
        mismatch_loss_db: m.mismatchLossDb,
        wtl_lambda: m.wtl,
        series_equivalent: eq(m.seriesEquivalent),
        shunt_equivalent: eq(m.shuntEquivalent),
        at: { z0, freq: fmtHz(f) }
      }
    }
  },
  {
    name: 'what_if',
    description: 'Simulate adding elements WITHOUT changing the learner\'s chart. Starts from the current load (or the current input point, or a given impedance) at a frequency and applies the elements in order (load → source). Each step returns "move": the exact circle followed (constant r / constant g / around the centre), rotation (clockwise / counter-clockwise), start and end chart half with their impedance AND admittance meaning, and where it crosses the real axis. REQUIRED before you describe any move\'s direction, chart half or arc; quote these facts, not memory.',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', enum: ['load', 'input'], description: 'Start at the load (default) or after the learner\'s current network' },
        start_impedance_ohm: { type: 'object', properties: { r: { type: 'number' }, x: { type: 'number' } } },
        start_normalized: {
          type: 'object',
          description: 'Start at a normalized point instead: {r, x} for z or {g, b} for y',
          properties: { r: { type: 'number' }, x: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' } }
        },
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ELEMENT_KINDS },
              value: { type: 'number', description: 'H, F, Ω, or degrees for lines/stubs (omit for a moderate step that just shows the direction)' },
              zc: { type: 'number' }
            },
            required: ['kind']
          }
        },
        freq_hz: { type: 'number' }
      },
      required: ['elements']
    },
    activity: () => 'Trying an idea (off-chart)',
    run(a, ctx) {
      const s = ctx.studio
      const f = a.freq_hz ?? s.designFreq
      // Forgiving about shape (weaker models send one element, bare kind names, or no value).
      const raw: unknown[] = Array.isArray(a.elements) ? a.elements
        : a.elements ? [a.elements]
          : a.element ? [a.element]
            : a.kind ? [{ kind: a.kind, value: a.value }] // a single element given at the top level
              // Any other argument whose value names an element kind ("element_kind": "shuntL"): unambiguous.
              : Object.values(a).filter((v) => typeof v === 'string' && ELEMENT_KINDS.includes(v as ElementKind)).slice(0, 1).map((k) => ({ kind: k, value: a.value }))
      const els = raw
        .map((e) => (typeof e === 'string' ? { kind: e } : (e as { kind?: string; value?: number; zc?: number })))
        .filter((e): e is { kind: ElementKind; value?: number; zc?: number } => !!e && ELEMENT_KINDS.includes(e.kind as ElementKind))
      if (!els.length) {
        throw new Error(`Give "elements" as a list, e.g. [{"kind": "shuntC", "value": 2e-12}]. Kinds: ${ELEMENT_KINDS.join(', ')}. Values in H, F, Ω or degrees.`)
      }
      const notes: string[] = []
      // Start points under unknown names are not guessed (a wrong start gives wrong facts); say what was used.
      const KNOWN = ['start', 'start_impedance_ohm', 'start_normalized', 'start_point', 'elements', 'element', 'kind', 'value', 'freq_hz']
      const ignored = Object.keys(a).filter((k) => !KNOWN.includes(k) && typeof a[k] === 'object')
      if (ignored.length) notes.push(`Ignored ${ignored.join(', ')}: to start somewhere other than the load, use start_normalized {r, x} or {g, b}, or start_impedance_ohm {r, x}. Started from ${a.start === 'input' ? 'the current input point' : 'the current load'}.`)
      let Z = a.start_impedance_ohm ? c(a.start_impedance_ohm.r, a.start_impedance_ohm.x ?? 0) : loadImpedance(s.load, f, s.datasets)
      const n = a.start_normalized ?? a.start_point
      if (!a.start_impedance_ohm && n && (typeof n.r === 'number' || typeof n.g === 'number')) {
        if (typeof n.r === 'number') Z = c(n.r * s.z0, (n.x ?? 0) * s.z0)
        else {
          const d = n.g * n.g + (n.b ?? 0) ** 2
          Z = d === 0 ? c(Infinity) : c((n.g / d) * s.z0, (-(n.b ?? 0) / d) * s.z0)
        }
      } else if (!a.start_impedance_ohm && a.start === 'input') Z = inputImpedance(Z, s.network, f)
      const steps: Array<Record<string, unknown>> = [{ step: 'start', ...brief(metricsFromZ(Z, s.z0, f)) }]
      for (const e of els) {
        let value = e.value
        if (!Number.isFinite(value)) {
          value = typicalValue(e.kind, f, s.z0)
          notes.push(`No value given for ${ELEMENT_LABEL[e.kind]}: used ${e.kind === 'tline' || e.kind.endsWith('Stub') ? `${value}°` : fmtEng(value!, e.kind.endsWith('L') ? 'H' : e.kind.endsWith('C') ? 'F' : 'Ω')} (a moderate step) to show the direction.`)
        }
        const el: NetworkElement = { id: 'w', kind: e.kind, value: value!, zc: e.zc ?? s.z0, refHz: f }
        const move = describeMove(Z, el, f, s.z0)
        Z = applyElement(Z, el, f)
        steps.push({ step: ELEMENT_LABEL[e.kind], ...brief(metricsFromZ(Z, s.z0, f)), move })
      }
      return {
        freq: fmtHz(f),
        steps,
        ...(notes.length ? { notes } : {}),
        convention: 'Impedance Smith chart, +j up. Upper half = inductive impedance (x > 0) = negative susceptance (b < 0) when read as admittance; lower half the opposite. State halves as the learner sees them on the chart.'
      }
    }
  },
  {
    name: 'solve_l_match',
    description: 'Reference solutions for a two-element L-network at a frequency (default: current load at the design frequency). FOR YOUR VERIFICATION ONLY — do not reveal component values unless the learner has genuinely tried and asks to see a solution.',
    parameters: {
      type: 'object',
      properties: {
        impedance_ohm: { type: 'object', properties: { r: { type: 'number' }, x: { type: 'number' } } },
        z0: { type: 'number' },
        freq_hz: { type: 'number' }
      }
    },
    activity: () => 'Checking reference solutions',
    run(a, ctx) {
      const s = ctx.studio
      const f = a.freq_hz ?? s.designFreq
      const ZL = a.impedance_ohm ? c(a.impedance_ohm.r, a.impedance_ohm.x ?? 0) : loadImpedance(s.load, f, s.datasets)
      const sols = solveLMatch(ZL, a.z0 ?? s.z0, f)
      return {
        load: fmtC(ZL, 'Ω'),
        freq: fmtHz(f),
        solutions: sols.map((x) => ({
          topology: x.topology,
          elements: x.elements.map((e) => `${ELEMENT_LABEL[e.kind]} ${fmtEng(e.value, e.kind.endsWith('L') ? 'H' : 'F')}`),
          detail: x.description
        }))
      }
    }
  },
  {
    name: 'analyze_sweep',
    description: 'Analyse the frequency trace (model or imported CST/VNA data): resonances (X = 0 crossings), best-match frequency, VSWR bands, and how the trace rotates. Use when discussing antenna behaviour or deciding where to match.',
    parameters: { type: 'object', properties: { use: { type: 'string', enum: ['load', 'input'] } } },
    activity: () => 'Analysing the sweep',
    run(a, ctx) {
      const d = ctx.derived()
      const s = ctx.studio
      const pick = (p: (typeof d.trace)[number]) => (a.use === 'input' ? p.Zin : p.ZL)
      const ms = d.trace.map((p) => ({ f: p.f, m: metricsFromZ(pick(p), s.z0) }))
      const best = ms.reduce((x, y) => (y.m.vswr < x.m.vswr ? y : x), ms[0])
      const resonances: string[] = []
      for (let i = 1; i < ms.length; i++) {
        const x0 = ms[i - 1].m.Z.im, x1 = ms[i].m.Z.im
        if (Number.isFinite(x0) && Number.isFinite(x1) && Math.sign(x0) !== Math.sign(x1)) {
          resonances.push(`${fmtHz(ms[i].f)} (R ≈ ${ms[i].m.Z.re.toFixed(1)} Ω, ${x0 < x1 ? 'series-type' : 'parallel-type'})`)
        }
      }
      const sample = sweepFreqs({ start: d.freqs[0], stop: d.freqs[d.freqs.length - 1], points: 9 }).map((f) => {
        const near = ms.reduce((x, y) => (Math.abs(y.f - f) < Math.abs(x.f - f) ? y : x), ms[0])
        return { freq: fmtHz(near.f), z: fmtC(near.m.z), vswr: near.m.vswr }
      })
      const bands = a.use === 'input' ? d.inputBands : d.loadBands
      return {
        points: ms.length,
        best_match: { freq: fmtHz(best.f), vswr: best.m.vswr, z: fmtC(best.m.z) },
        resonances,
        bands: bands.map((b) => ({ from: fmtHz(b.fLow), to: fmtHz(b.fHigh), fractional_pct: b.fractional * 100, clipped_by_sweep: b.clipped })),
        trace_samples: sample,
        ...(s.showBand ? {} : { note: 'The learner\'s chart shows one frequency only. If you discuss these results, first turn the band on (set_scenario show_band: true, band_reason) so they can see it.' })
      }
    }
  }
])
