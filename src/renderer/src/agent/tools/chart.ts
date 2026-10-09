import { c, type Complex } from '@shared/rf/complex'
import { gammaFromZ, type PointMetrics } from '@shared/rf/metrics'
import { ELEMENT_LABEL, type ElementKind, type LoadModel } from '@shared/rf/network'
import { describeLoad, describeView, elementValueText, loadVariesWithFrequency, uid, useStudio, type Annotation } from '@/state/studio'
import { FULL_VIEW, frameView, inView } from '@/chart/ChartBase'
import { valueThrough } from '@/chart/geometry'
import { fmtC, fmtHz } from '@/lib/format'
import { exerciseGoal } from '@/state/exercise'
import { defineTools, type ToolContext } from '../types'

export const ELEMENT_KINDS: ElementKind[] = ['seriesL', 'seriesC', 'seriesR', 'shuntL', 'shuntC', 'shuntR', 'tline', 'openStub', 'shortStub']

/** Compact metrics for the model. */
export function brief(m: PointMetrics) {
  return {
    Z_ohm: fmtC(m.Z),
    z: fmtC(m.z),
    y: fmtC(m.y),
    gamma: `${m.gammaMag.toFixed(4)} ∠ ${m.gammaDeg.toFixed(1)}°`,
    vswr: m.vswr,
    return_loss_db: m.returnLossDb,
    q: m.q,
    wtg_lambda: m.wtg
  }
}

export const LOAD_SCHEMA = {
  type: 'object',
  description: 'Load model. fixed: R,X (Ω). seriesRLC/parallelRLC: R (Ω), L (H), C (F) (0 = absent). antenna: topology series(dipole-like)|parallel(patch-like), f0_hz, R (Ω at resonance), Q.',
  properties: {
    kind: { type: 'string', enum: ['fixed', 'seriesRLC', 'parallelRLC', 'antenna'] },
    R: { type: 'number' }, X: { type: 'number' }, L: { type: 'number' }, C: { type: 'number' },
    topology: { type: 'string', enum: ['series', 'parallel'] }, f0_hz: { type: 'number' }, Q: { type: 'number' }
  },
  required: ['kind']
}

export function parseLoad(a: Record<string, unknown>): LoadModel {
  const n = (k: string, d = 0) => (typeof a[k] === 'number' ? (a[k] as number) : Number(a[k] ?? d))
  switch (a.kind) {
    case 'fixed': return { kind: 'fixed', R: n('R', 50), X: n('X') }
    case 'seriesRLC': return { kind: 'seriesRLC', R: n('R', 50), L: n('L'), C: n('C') }
    case 'parallelRLC': return { kind: 'parallelRLC', R: n('R', 50), L: n('L'), C: n('C') }
    case 'antenna': return { kind: 'antenna', topology: a.topology === 'parallel' ? 'parallel' : 'series', f0: n('f0_hz', 2.45e9), R: n('R', 50), Q: n('Q', 5) }
  }
  throw new Error(`Unknown load kind "${String(a.kind)}"`)
}

/** A sweep around the design frequency, for when the band is shown without a range given. */
const sweepAround = (f: number) => ({ start: f * 0.8, stop: f * 1.2, points: 301 })

/**
 * Apply a tutor's chart setup. With a `load` it is a new setup and replaces the
 * old one: markers, sweep range, drawings and the band all start fresh, so
 * nothing from the previous setup (like the default antenna's markers) lingers.
 * Without a load it is a tweak and only the given fields change.
 */
export function applyScenario(ctx: ToolContext, a: Record<string, any>) {
  const s = ctx.studio
  // A new setup moves everything: a tutor zoom on the old one would frame empty space.
  if (s.tutorView) useStudio.setState({ view: FULL_VIEW, tutorView: null })
  const fresh = !!a.load
  if (a.z0) s.set('z0', a.z0)
  if (fresh) {
    const load = parseLoad(a.load)
    s.setLoad(load, `Tutor set the load: ${describeLoad(load, s.datasets)}`)
    s.set('markers', [])
    s.setAnnotations(() => [])
    s.setPinned(null)
  }
  if (a.design_freq_hz) s.set('designFreq', a.design_freq_hz)
  if (a.sweep) s.set('sweep', { start: a.sweep.start_hz, stop: a.sweep.stop_hz, points: a.sweep.points ?? 301 })
  else if (fresh) s.set('sweep', sweepAround(ctx.studio.designFreq))
  if (Array.isArray(a.markers_hz)) s.set('markers', [...a.markers_hz].sort((x, y) => x - y))
  // The band: as asked, else on only for a load that changes with frequency.
  const band = typeof a.show_band === 'boolean' ? a.show_band : fresh ? loadVariesWithFrequency(ctx.studio.load) : undefined
  if (band !== undefined) {
    s.setShowBand(band, 'tutor', typeof a.band_reason === 'string' ? a.band_reason : undefined)
    // A band without its trace shows nothing: turning the band on brings the trace with it.
    if (band && !ctx.studio.overlays.showLoadTrace) s.setOverlays({ showLoadTrace: true })
    // A shown band must contain the design frequency, or the trace would sit off to one side.
    const { designFreq: f, sweep } = ctx.studio
    if (band && (f < sweep.start || f > sweep.stop)) s.set('sweep', sweepAround(f))
  }
  if (a.clear_network) s.set('network', [])
  if (a.overlays) {
    const o = a.overlays
    s.setOverlays({
      ...(o.admittance !== undefined ? { admittance: !!o.admittance } : {}),
      ...(o.vswr_circle !== undefined ? { vswrCircle: o.vswr_circle || null } : {}),
      ...(o.q_contour !== undefined ? { qContour: o.q_contour || null } : {}),
      ...(o.load_trace !== undefined ? { showLoadTrace: !!o.load_trace } : {}),
      ...(o.input_trace !== undefined ? { showInputTrace: !!o.input_trace } : {}),
      ...(o.matching_path !== undefined ? { showPath: !!o.matching_path } : {})
    })
  }
}

export const SCENARIO_PROPS = {
  z0: { type: 'number', description: 'System impedance (Ω)' },
  load: LOAD_SCHEMA,
  design_freq_hz: { type: 'number', description: 'The one frequency the lesson works at' },
  show_band: {
    type: 'boolean',
    description: 'Show the frequency band (sweep traces, markers, bandwidth). Default: off for a fixed load, on for a load that changes with frequency. Leave it off for anything taught at one frequency (moving a point, an L-match at one frequency, reading the chart): a band there only adds clutter. Turn it on for bandwidth, Q or frequency-dependent loads, and tell the learner why it appeared.'
  },
  band_reason: { type: 'string', description: 'With show_band: why, in a few words (logged)' },
  sweep: { type: 'object', description: 'Only with the band shown. Default: ±20% around the design frequency.', properties: { start_hz: { type: 'number' }, stop_hz: { type: 'number' }, points: { type: 'number' } }, required: ['start_hz', 'stop_hz'] },
  markers_hz: { type: 'array', items: { type: 'number' }, description: 'Only with the band shown: frequencies to mark, e.g. band edges. Default: none.' },
  clear_network: { type: 'boolean' },
  overlays: {
    type: 'object',
    properties: {
      admittance: { type: 'boolean' }, vswr_circle: { type: 'number', description: 'VSWR value, 0 to hide' }, q_contour: { type: 'number', description: 'Q value, 0 to hide' },
      load_trace: { type: 'boolean', description: 'The load across the band (needs the band shown)' },
      input_trace: { type: 'boolean', description: 'The input after the network across the band (needs the band shown)' },
      matching_path: { type: 'boolean', description: 'The curve each element draws from the load to the input' }
    }
  }
}

/** Point given as normalized impedance {r, x} or normalized admittance {g, b}. */
function pointOf(p: any): Complex | undefined {
  if (!p) return undefined
  if (typeof p.r === 'number') return gammaFromZ(c(p.r, p.x ?? 0), 1)
  if (typeof p.g === 'number') {
    const d = p.g * p.g + (p.b ?? 0) ** 2
    return gammaFromZ(d === 0 ? c(Infinity) : c(p.g / d, -(p.b ?? 0) / d), 1)
  }
  return undefined
}

const fmtV = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Number(v.toPrecision(3)).toString())

/**
 * Whether a shape can be drawn, with its value: a circle given only a point "at" takes the value
 * through that point (the VSWR circle through z = 0.6 is VSWR 1.67). The reason when it can't.
 */
export function checkShape(sh: any): { value?: number; what: string } | string {
  const kind = sh?.kind
  const g = pointOf(sh?.at)
  const name = String(kind)
  if (kind === 'point') return g ? { what: `a point${sh.label ? ` "${sh.label}"` : ''}` } : 'a point without "at" ({r, x} or {g, b})'
  if (kind === 'arrow') return g && pointOf(sh.to) ? { what: `an arrow${sh.label ? ` "${sh.label}"` : ''}` } : 'an arrow needs both "at" and "to"'
  const LIMITS: Record<string, [string, (v: number) => boolean]> = {
    vswrCircle: ['VSWR circle', (v) => v > 1], rCircle: ['constant-r circle r =', (v) => v >= 0], xArc: ['constant-x arc x =', (v) => v !== 0],
    gCircle: ['constant-g circle g =', (v) => v >= 0], bArc: ['constant-b arc b =', (v) => v !== 0], qContour: ['Q contour Q =', (v) => v > 0]
  }
  if (!LIMITS[name]) return `unknown shape kind "${name}"`
  let v: number | undefined = typeof sh.value === 'number' && Number.isFinite(sh.value) ? sh.value : undefined
  let through = ''
  if (v === undefined && g) {
    v = valueThrough(name, g)
    through = ` (through the point given)`
  }
  const [label, ok] = LIMITS[name]
  if (v === undefined || !Number.isFinite(v) || !ok(v)) return `${label.replace(/ [a-zA-Z]+ =$/, '')}: give "value"${v !== undefined ? ` (got ${v})` : ''}, or a point "at" it passes through`
  return { value: v, what: name === 'vswrCircle' ? `a VSWR ${fmtV(v)} circle${through}` : `a ${label} ${fmtV(v)}${through}` }
}

const PT = {
  type: 'object',
  description: 'Normalized point: {r, x} for impedance z = r + jx, or {g, b} for admittance y = g + jb',
  properties: { r: { type: 'number' }, x: { type: 'number' }, g: { type: 'number' }, b: { type: 'number' } }
}

/** Things on the chart the learner has switched off (or never had on) that a lesson may point at. */
function hiddenFromLearner(s: ToolContext['studio']): string[] {
  const out: string[] = []
  if (s.showBand && !s.overlays.showLoadTrace) out.push('the load trace (the band is on, but its trace is hidden)')
  if (s.showBand && s.network.length && !s.overlays.showInputTrace) out.push('the input trace')
  if (s.network.length && !s.overlays.showPath) out.push('the matching path (the curves from the load to the input)')
  return out
}

export default defineTools([
  {
    name: 'get_chart_state',
    description: 'Read what is on the learner\'s Smith chart right now: Z0, load, design frequency, matching network (load→source), metrics at the design frequency and at each marker, VSWR bandwidths, active exercise, pinned point and the learner\'s recent actions. Call this before commenting on their work.',
    parameters: { type: 'object', properties: {} },
    activity: () => 'Looking at your chart',
    run(_a, ctx) {
      const s = ctx.studio
      const d = ctx.derived()
      const has = s.network.length > 0
      return {
        z0_ohm: s.z0,
        load: describeLoad(s.load, s.datasets),
        design_freq: fmtHz(s.designFreq),
        network_load_to_source: s.network.map((e, i) => ({ index: i + 1, type: ELEMENT_LABEL[e.kind], kind: e.kind, value: elementValueText(e), value_si: e.value })),
        at_design_freq: { load: brief(d.design.load), ...(has ? { input: brief(d.design.input) } : {}) },
        vswr_threshold: s.overlays.vswrCircle ?? 2,
        // Band details only when the learner can see the band; otherwise say it's a one-frequency view.
        ...(s.showBand ? {
          frequency_band: 'shown',
          markers: d.markers.map((m, i) => ({ name: `M${i + 1}`, freq: fmtHz(m.f), load: brief(m.load), ...(has ? { input: brief(m.input) } : {}) })),
          load_bands: d.loadBands.map((b) => `${fmtHz(b.fLow)}–${fmtHz(b.fHigh)} (${(b.fractional * 100).toFixed(1)}%)`),
          matched_bands: has ? d.inputBands.map((b) => `${fmtHz(b.fLow)}–${fmtHz(b.fHigh)} (${(b.fractional * 100).toFixed(1)}%)`) : undefined,
          sweep: `${fmtHz(s.sweep.start)}–${fmtHz(s.sweep.stop)}`
        } : {
          frequency_band: `hidden: the learner sees ${fmtHz(s.designFreq)} only (no sweep, markers or bandwidth). Turn it on with set_scenario show_band only if the lesson needs frequency.`
        }),
        overlays: s.overlays,
        ...(hiddenFromLearner(s).length ? { hidden_from_learner: `${hiddenFromLearner(s).join('; ')}. They can't see these: turn them on with set_scenario overlays (load_trace, input_trace, matching_path) before pointing at them.` } : {}),
        pinned_point: s.pinned ? fmtC(s.pinned) + ' (Γ)' : null,
        active_exercise: s.exercise ? { title: s.exercise.title, kind: s.exercise.kind ?? 'match', goal: exerciseGoal(s.exercise), status: s.exercise.status, attempts: s.exercise.attempts } : null,
        open_prediction: s.prediction ? { question: s.prediction.question, graded: s.prediction.key?.type ?? false, answered: s.prediction.answered ?? null } : null,
        // What the learner is looking at, so you don't point at things that are off-screen.
        view: {
          showing: describeView(s.view),
          zoomed_by: s.tutorView ? `you (${s.tutorView.reason})` : 'the learner',
          off_screen: [
            ...(inView(s.view, d.design.load.gamma) ? [] : ['load']),
            ...(has && !inView(s.view, d.design.input.gamma) ? ['input'] : []),
            ...(s.showBand ? d.markers : []).flatMap((m, i) => (inView(s.view, m.load.gamma) && (!has || inView(s.view, m.input.gamma)) ? [] : [`M${i + 1}`]))
          ]
        },
        recent_learner_actions: s.events.slice(-12).map((e) => e.text)
      }
    }
  },
  {
    name: 'set_scenario',
    description: 'Set up the chart for a task: Z0, load model, design frequency, overlays, optionally clearing the learner\'s network. Giving a load starts a fresh setup (old markers, sweep and your drawings go). Most lessons work at one frequency, so the band stays hidden for a fixed load unless you turn it on (show_band). Without a load, only the fields you give change.',
    parameters: { type: 'object', properties: SCENARIO_PROPS },
    activity: () => 'Setting up the chart',
    run(a, ctx) {
      applyScenario(ctx, a)
      return 'Scenario applied. The learner sees it now.'
    }
  },
  {
    name: 'edit_network',
    description: 'Add/update/remove/clear elements in the matching network. Use sparingly — the learner should build networks themselves; use this to demonstrate a counter-example or set up a starting point. Element values in SI units (H, F, Ω) or electrical length in degrees for lines/stubs.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'update', 'remove', 'clear'] },
        kind: { type: 'string', enum: ELEMENT_KINDS },
        value: { type: 'number', description: 'H, F, Ω, or degrees (lines/stubs)' },
        zc: { type: 'number', description: 'Line/stub characteristic impedance (Ω)' },
        index: { type: 'number', description: '1-based position (from the load) for update/remove' }
      },
      required: ['action']
    },
    activity: (a) => `Editing the network (${a.action})`,
    run(a, ctx) {
      const s = ctx.studio
      const at = (i: number) => s.network[i - 1] ?? (() => { throw new Error(`No element at index ${i}`) })()
      switch (a.action) {
        case 'add': {
          if (!a.kind || a.value === undefined) throw new Error('kind and value required')
          const el = s.addElement(a.kind, a.value, a.zc ? { zc: a.zc } : {})
          return `Added ${ELEMENT_LABEL[el.kind]} ${elementValueText(el)} at position ${s.network.length + 1}`
        }
        case 'update':
          s.updateElement(at(a.index).id, { ...(a.value !== undefined ? { value: a.value } : {}), ...(a.zc ? { zc: a.zc } : {}) })
          return 'Updated'
        case 'remove':
          s.removeElement(at(a.index).id)
          return 'Removed'
        case 'clear':
          s.clearNetwork()
          return 'Cleared'
      }
      throw new Error('Unknown action')
    }
  },
  {
    name: 'annotate_chart',
    description: 'Draw on the learner\'s chart to point at things: points, arrows, constant-r / constant-x / constant-g / constant-b circles, VSWR circles, Q contours, each with an optional short label. Great for "look here" hints without giving the answer.',
    parameters: {
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['point', 'arrow', 'rCircle', 'xArc', 'gCircle', 'bArc', 'vswrCircle', 'qContour'] },
              at: PT,
              to: PT,
              value: { type: 'number', description: 'r, x, g, b, VSWR or Q value for circle kinds (or give "at": the circle through that point)' },
              label: { type: 'string' },
              color: { type: 'string', description: 'CSS color (optional)' }
            },
            required: ['kind']
          }
        },
        replace: { type: 'boolean', description: 'Remove previous annotations first (default true)' }
      },
      required: ['shapes']
    },
    activity: () => 'Drawing on the chart',
    run(a, ctx) {
      // Check every shape can really be drawn, and say exactly what was: never "drew it" for something invisible.
      const drawn: Annotation[] = []
      const said: string[] = []
      const skipped: string[] = []
      for (const sh of (Array.isArray(a.shapes) ? a.shapes : []) as any[]) {
        const r = checkShape(sh)
        if (typeof r === 'string') skipped.push(r)
        else {
          drawn.push({ id: uid('ann'), kind: sh.kind, gamma: pointOf(sh.at), to: pointOf(sh.to), value: r.value, label: sh.label, color: sh.color })
          said.push(r.what)
        }
      }
      if (!drawn.length) throw new Error(`Nothing was drawn: ${skipped.join('; ') || 'no shapes given'}. Fix the shapes and call again before you mention a drawing.`)
      ctx.studio.setAnnotations((prev) => (a.replace === false ? [...prev, ...drawn] : drawn))
      return `Drew ${said.join('; ')}.${skipped.length ? ` NOT drawn (don't mention these): ${skipped.join('; ')}.` : ''}`
    }
  },
  {
    name: 'focus_chart',
    description: 'Zoom the learner\'s chart onto what you are talking about, when it is small or crowded (two close points, a short path step, reading a value precisely). Frame named things and/or specific points. The learner sees why ("reason") and can go back to their own view with one click. Use at most once per point you make; "whole_chart" zooms back out.',
    parameters: {
      type: 'object',
      properties: {
        targets: {
          type: 'array',
          items: { type: 'string', enum: ['load', 'input', 'markers', 'path', 'annotations', 'whole_chart'] },
          description: 'Named things to frame: load / input point at the design frequency, all markers, the matching path, your drawings'
        },
        points: { type: 'array', items: PT, description: 'Extra points to include in the frame' },
        reason: { type: 'string', description: 'Shown to the learner, e.g. "the two M1 points"' }
      }
    },
    activity: () => 'Zooming your chart',
    run(a, ctx) {
      const s = ctx.studio
      // The learner is steering the view right now: don't take it from them.
      if (Date.now() - s.learnerViewAt < 15000) {
        throw new Error(`The learner is zooming/panning the chart themselves (now showing ${describeView(s.view)}). Leave their view alone; tell them where to look instead.`)
      }
      const targets: string[] = Array.isArray(a.targets) ? a.targets : a.targets ? [a.targets] : []
      if (targets.includes('whole_chart')) {
        s.setView(FULL_VIEW, 'tutor', a.reason ?? 'the whole chart')
        return 'The learner now sees the whole chart.'
      }
      const d = ctx.derived()
      const pts: Complex[] = []
      if (targets.includes('load')) pts.push(d.design.load.gamma)
      if (targets.includes('input') && s.network.length) pts.push(d.design.input.gamma)
      if (targets.includes('markers') && s.showBand) d.markers.forEach((m) => pts.push(m.load.gamma, ...(s.network.length ? [m.input.gamma] : [])))
      if (targets.includes('path')) d.path.forEach((seg) => pts.push(...seg))
      if (targets.includes('annotations')) s.annotations.forEach((an) => { if (an.gamma) pts.push(an.gamma); if (an.to) pts.push(an.to) })
      for (const p of Array.isArray(a.points) ? a.points : []) {
        const g = pointOf(p)
        if (g) pts.push(g)
      }
      const usable = pts.filter((g) => Number.isFinite(g.re) && Number.isFinite(g.im) && Math.hypot(g.re, g.im) <= 1.0001)
      if (!usable.length) throw new Error('Nothing to frame: give targets (load, input, markers, path, annotations) or points inside the chart.')
      const v = frameView(usable)
      s.setView(v, 'tutor', String(a.reason ?? 'what we are discussing').slice(0, 80))
      return `The learner's chart now shows ${describeView(v)}. They can go back to their own view with one click.`
    }
  },
  {
    name: 'clear_annotations',
    description: 'Remove everything you drew on the chart.',
    parameters: { type: 'object', properties: {} },
    activity: () => 'Clearing drawings',
    run(_a, ctx) {
      ctx.studio.setAnnotations(() => [])
      return 'Cleared.'
    }
  }
])
