import { create } from 'zustand'
import type { Complex } from '@shared/rf/complex'
import { ELEMENT_LABEL, type Dataset, type ElementKind, type LoadModel, type NetworkElement, type SweepSpec } from '@shared/rf/network'
import { zFromGamma } from '@shared/rf/metrics'
import type { QuestionKey, Target } from '@shared/rf/tasks'
import type { GradedMeta } from '@shared/memory'
import { fmtC, fmtEng, fmtHz } from '@/lib/format'
import { FULL_VIEW, VIEW, type ChartView } from '@/chart/ChartBase'

/** Shapes the tutor (or the user) can draw on top of the chart. */
export interface Annotation {
  id: string
  kind: 'point' | 'vswrCircle' | 'rCircle' | 'xArc' | 'gCircle' | 'bArc' | 'qContour' | 'arrow'
  /** Γ location for point/arrow start */
  gamma?: Complex
  /** Γ end of an arrow */
  to?: Complex
  /** r, x, g, b, Q or VSWR value for circles */
  value?: number
  label?: string
  color?: string
}

export interface Exercise {
  id: string
  /** match: bring VSWR down (the default, and all older saves); reach: get the input point onto a target */
  kind?: 'match' | 'reach'
  title: string
  instructions: string
  skill?: string
  freqHz: number
  /** match: VSWR must be ≤ maxVswr at freqHz (and across the band, if given) */
  maxVswr?: number
  /** reach: where the input point has to land */
  target?: Target
  /** reach: draw the target on the chart */
  showTarget?: boolean
  /** What it practises and how hard it is (set by the app), for the learner's memory */
  graded?: GradedMeta
  band?: { fLow: number; fHigh: number }
  maxElements?: number
  allowedKinds?: ElementKind[]
  attempts: number
  status: 'active' | 'passed' | 'given_up'
  hints: string[]
  /** The learner talked it through with the tutor while it was open (a pass then counts as partly theirs) */
  helped?: boolean
}

export interface Prediction {
  id: string
  question: string
  /** mcq shows buttons; click asks the learner to click a point on the chart */
  kind: 'mcq' | 'click' | 'text'
  choices?: string[]
  answered?: string
  /** Where they clicked (click questions) */
  answeredGamma?: Complex
  /** Graded question: the app checks the answer against this key (the tutor never grades) */
  key?: QuestionKey
  /** Short name for the lesson record, and the skill it practises */
  title?: string
  skill?: string
  /** Shown under a typed answer box, e.g. "e.g. 0.6 + j0.4" */
  hint?: string
  /** A follow-up on the learner's own solution (they can skip it) */
  followUp?: boolean
  /** What it practises and how hard it is (set by the app), for the learner's memory */
  graded?: GradedMeta
  /** The learner talked it through with the tutor while it was open */
  helped?: boolean
}

export interface ChartEvent {
  at: number
  key: string
  text: string
}

export type ClickMode = 'inspect' | 'setLoad' | 'predict'

export interface Overlays {
  admittance: boolean
  qContour: number | null
  vswrCircle: number | null
  showLoadTrace: boolean
  showInputTrace: boolean
  showPath: boolean
}

export interface StudioSnapshot {
  z0: number
  load: LoadModel
  datasets: Dataset[]
  sweep: SweepSpec
  designFreq: number
  markers: number[]
  /**
   * Show the frequency band: the sweep traces, markers and bandwidths. Off means
   * the chart is about one frequency (the design frequency) only.
   */
  showBand: boolean
  network: NetworkElement[]
  overlays: Overlays
  /** Conversation-linked state, saved with the workspace so it survives restarts */
  annotations: Annotation[]
  exercise: Exercise | null
  prediction: Prediction | null
}

interface StudioState extends StudioSnapshot {
  pinned: Complex | null
  clickMode: ClickMode
  events: ChartEvent[]
  /** What part of the chart is shown (zoom/pan); not saved */
  view: ChartView
  /** Set when the tutor zoomed the chart: why, and the learner's view to go back to */
  tutorView: { reason: string; before: ChartView } | null
  /** When the learner last zoomed or panned (the tutor leaves the view alone right after) */
  learnerViewAt: number
  setView(v: ChartView, by: 'learner' | 'tutor', reason?: string): void
  /** Undo the tutor's zoom */
  restoreView(): void

  set<K extends keyof StudioSnapshot>(key: K, value: StudioSnapshot[K], why?: string): void
  setLoad(load: LoadModel, why?: string): void
  addDatasets(ds: Dataset[]): void
  removeDataset(id: string): void
  addElement(kind: ElementKind, value: number, extra?: Partial<NetworkElement>): NetworkElement
  updateElement(id: string, patch: Partial<NetworkElement>): void
  removeElement(id: string): void
  moveElement(id: string, dir: -1 | 1): void
  clearNetwork(): void
  addMarker(f: number): void
  removeMarker(f: number): void
  /** Show or hide the frequency band; the learner's choice is logged for the tutor */
  setShowBand(on: boolean, by: 'learner' | 'tutor', reason?: string): void
  setOverlays(patch: Partial<Overlays>): void
  setPinned(g: Complex | null): void
  setClickMode(m: ClickMode): void
  setAnnotations(fn: (a: Annotation[]) => Annotation[]): void
  setExercise(e: Exercise | null): void
  setPrediction(p: Prediction | null): void
  logEvent(key: string, text: string): void
  /** Events since a timestamp (what the tutor hasn't seen yet) */
  eventsSince(t: number): ChartEvent[]
  loadSnapshot(s: Partial<StudioSnapshot>): void
  snapshot(): StudioSnapshot
}

let idSeq = 0
export const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${(idSeq++).toString(36)}`

export const DEFAULT_SNAPSHOT: StudioSnapshot = {
  z0: 50,
  load: { kind: 'antenna', topology: 'series', f0: 2.45e9, R: 30, Q: 8 },
  datasets: [],
  sweep: { start: 2.0e9, stop: 2.9e9, points: 301 },
  designFreq: 2.4e9,
  markers: [2.4e9, 2.5e9],
  showBand: true,
  network: [],
  overlays: { admittance: false, qContour: null, vswrCircle: 2, showLoadTrace: true, showInputTrace: true, showPath: true },
  annotations: [],
  exercise: null,
  prediction: null
}

export function elementValueText(el: NetworkElement): string {
  switch (el.kind) {
    case 'seriesL': case 'shuntL': return fmtEng(el.value, 'H')
    case 'seriesC': case 'shuntC': return fmtEng(el.value, 'F')
    case 'seriesR': case 'shuntR': return fmtEng(el.value, 'Ω')
    default: return `${el.value.toFixed(1)}° @ ${fmtHz(el.refHz ?? 0)}, Zc ${el.zc ?? 50} Ω`
  }
}

export function describeLoad(l: LoadModel, datasets: Dataset[]): string {
  switch (l.kind) {
    case 'fixed': return `fixed Z = ${l.R} ${l.X < 0 ? '−' : '+'} j${Math.abs(l.X)} Ω`
    case 'seriesRLC': return `series RLC (R ${l.R} Ω, L ${fmtEng(l.L, 'H')}, C ${l.C ? fmtEng(l.C, 'F') : 'none'})`
    case 'parallelRLC': return `parallel RLC (R ${l.R} Ω, L ${l.L ? fmtEng(l.L, 'H') : 'none'}, C ${l.C ? fmtEng(l.C, 'F') : 'none'})`
    case 'antenna': return `${l.topology === 'series' ? 'dipole-like (series)' : 'patch-like (parallel)'} antenna, f0 ${fmtHz(l.f0)}, R ${l.R} Ω, Q ${l.Q}`
    case 'data': return `imported data "${datasets.find((d) => d.id === l.datasetId)?.name ?? '?'}"`
  }
}

/** A fixed impedance is the same at every frequency: a sweep adds nothing to it. */
export const loadVariesWithFrequency = (l: LoadModel) => l.kind !== 'fixed'

/** "340% around z ≈ 0.6 + j0.1", or "the whole chart", in the learner's terms. */
export function describeView(v: ChartView): string {
  if (v.half >= VIEW - 1e-6) return 'the whole chart'
  const z = zFromGamma({ re: v.cx, im: -v.cy }, 1)
  // "×" rather than "%", so nobody mistakes the zoom for a VSWR or efficiency.
  return `a ${(VIEW / v.half).toFixed(1)}× zoom around z ≈ ${fmtC(z)}`
}

export const useStudio = create<StudioState>((set, get) => ({
  ...DEFAULT_SNAPSHOT,
  pinned: null,
  clickMode: 'inspect',
  events: [],
  view: FULL_VIEW,
  tutorView: null,
  learnerViewAt: 0,

  setView(v, by, reason) {
    if (by === 'tutor') {
      // Remember the learner's own view (not an earlier tutor zoom) so "Back" returns to it.
      const before = get().tutorView?.before ?? get().view
      set({ view: v, tutorView: { reason: reason ?? 'what we are discussing', before } })
      return
    }
    set({ view: v, tutorView: null, learnerViewAt: Date.now() })
    get().logEvent('view', `Zoomed/panned the chart: now showing ${describeView(v)}`)
  },
  restoreView() {
    const tv = get().tutorView
    if (!tv) return
    set({ view: tv.before, tutorView: null, learnerViewAt: Date.now() })
    get().logEvent('view', `Went back to their own view (${describeView(tv.before)}) after the tutor zoomed in`)
  },

  set(key, value, why) {
    set({ [key]: value } as Partial<StudioState>)
    if (why) get().logEvent(String(key), why)
  },
  setLoad(load, why) {
    set({ load })
    get().logEvent('load', why ?? `Load set to ${describeLoad(load, get().datasets)}`)
  },
  addDatasets(ds) {
    set({ datasets: [...get().datasets, ...ds] })
    get().logEvent(`import_${ds[0]?.id}`, `Imported ${ds.map((d) => `"${d.name}" (${d.freqs.length} pts, ${fmtHz(d.freqs[0])}–${fmtHz(d.freqs[d.freqs.length - 1])})`).join(', ')}`)
  },
  removeDataset(id) {
    const { load } = get()
    set({ datasets: get().datasets.filter((d) => d.id !== id) })
    if (load.kind === 'data' && load.datasetId === id) set({ load: DEFAULT_SNAPSHOT.load })
  },
  addElement(kind, value, extra = {}) {
    const el: NetworkElement = { id: uid('el'), kind, value, ...extra }
    if ((kind === 'tline' || kind.endsWith('Stub')) && !el.refHz) el.refHz = get().designFreq
    if ((kind === 'tline' || kind.endsWith('Stub')) && !el.zc) el.zc = get().z0
    set({ network: [...get().network, el] })
    get().logEvent(`add_${el.id}`, `Added ${ELEMENT_LABEL[kind]} ${elementValueText(el)} (position ${get().network.length} from load)`)
    if (!get().overlays.showPath) {
      set({ overlays: { ...get().overlays, showPath: true } })
      get().logEvent('overlay_showPath', 'The matching path came on to show the new element')
    }
    return el
  },
  updateElement(id, patch) {
    set({ network: get().network.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
    const el = get().network.find((e) => e.id === id)
    if (el) get().logEvent(`upd_${id}`, `Changed ${ELEMENT_LABEL[el.kind]} to ${elementValueText(el)}`)
  },
  removeElement(id) {
    const el = get().network.find((e) => e.id === id)
    set({ network: get().network.filter((e) => e.id !== id) })
    if (el) get().logEvent(`rm_${id}`, `Removed ${ELEMENT_LABEL[el.kind]}`)
  },
  moveElement(id, dir) {
    const n = [...get().network]
    const i = n.findIndex((e) => e.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= n.length) return
    ;[n[i], n[j]] = [n[j], n[i]]
    set({ network: n })
    get().logEvent('reorder', `Reordered network: ${n.map((e) => ELEMENT_LABEL[e.kind]).join(' → ')} (load → source)`)
  },
  clearNetwork() {
    set({ network: [] })
    get().logEvent('clear', 'Cleared the matching network')
  },
  addMarker(f) {
    if (get().markers.includes(f)) return
    set({ markers: [...get().markers, f].sort((a, b) => a - b) })
    get().logEvent(`mk_${f}`, `Added marker at ${fmtHz(f)}`)
  },
  removeMarker(f) {
    set({ markers: get().markers.filter((m) => m !== f) })
  },
  setShowBand(on, by, reason) {
    if (get().showBand === on) return
    set({ showBand: on })
    const what = on ? 'showed the frequency band (sweep, markers, bandwidth)' : 'hid the frequency band: the chart shows the design frequency only'
    get().logEvent('band', by === 'learner' ? `Learner ${what}` : `Tutor ${what}${reason ? `: ${reason}` : ''}`)
  },
  setOverlays(patch) {
    set({ overlays: { ...get().overlays, ...patch } })
  },
  setPinned(g) {
    set({ pinned: g })
  },
  setClickMode(m) {
    set({ clickMode: m })
  },
  setAnnotations(fn) {
    set({ annotations: fn(get().annotations) })
  },
  setExercise(e) {
    set({ exercise: e })
  },
  setPrediction(p) {
    set({ prediction: p, clickMode: p?.kind === 'click' ? 'predict' : get().clickMode === 'predict' ? 'inspect' : get().clickMode })
  },
  logEvent(key, text) {
    const now = Date.now()
    const ev = get().events
    const last = ev[ev.length - 1]
    // Coalesce rapid changes (e.g. dragging a slider) into one event.
    if (last && last.key === key && now - last.at < 2000) {
      set({ events: [...ev.slice(0, -1), { at: now, key, text }] })
    } else set({ events: [...ev, { at: now, key, text }].slice(-200) })
  },
  eventsSince(t) {
    return get().events.filter((e) => e.at > t)
  },
  loadSnapshot(s) {
    set({
      ...DEFAULT_SNAPSHOT,
      ...s,
      // Workspaces saved before the band could be hidden: a fixed load gets the single-frequency view.
      showBand: s.showBand ?? (s.load ? loadVariesWithFrequency(s.load) : DEFAULT_SNAPSHOT.showBand),
      overlays: { ...DEFAULT_SNAPSHOT.overlays, ...(s.overlays ?? {}) },
      annotations: s.annotations ?? [],
      exercise: s.exercise ?? null,
      prediction: s.prediction ?? null,
      clickMode: s.prediction?.kind === 'click' && !s.prediction.answered ? 'predict' : 'inspect',
      pinned: null,
      events: [],
      view: FULL_VIEW,
      tutorView: null
    })
  },
  snapshot() {
    const { z0, load, datasets, sweep, designFreq, markers, showBand, network, overlays, annotations, exercise, prediction } = get()
    return { z0, load, datasets, sweep, designFreq, markers, showBand, network, overlays, annotations, exercise, prediction }
  }
}))

/** Hover position lives in its own tiny store so mouse moves don't re-render the panels. */
/** A trace point the cursor snapped to: which trace, its frequency and Γ there. */
export interface TraceSnap { which: 'load' | 'input'; f: number; g: Complex }

export const useHover = create<{ gamma: Complex | null; snap: TraceSnap | null; set(g: Complex | null): void; setSnap(s: TraceSnap | null): void }>((set) => ({
  gamma: null,
  /** Set by the chart while the cursor is on a trace; the readout then shows that point, like the tip */
  snap: null,
  set: (gamma) => set(gamma ? { gamma } : { gamma, snap: null }),
  setSnap: (snap) => set({ snap })
}))
