import { useEffect, useState } from 'react'
import { abs, type Complex } from '@shared/rf/complex'
import { gammaFromZ, metricsFromGamma, zFromGamma } from '@shared/rf/metrics'
import { admittanceOf, type Target } from '@shared/rf/tasks'
import { ELEMENT_LABEL, nearestOnTrace } from '@shared/rf/network'
import { useStudio, useHover, type Annotation } from '@/state/studio'
import { useDerived } from '@/state/derived'
import { useCalc } from '@/state/calc'
import { fmtC, fmtHz, fmtNum, fmtDb } from '@/lib/format'
import { ChartBase, clampView, FULL_VIEW, frameView, useChartScale, VIEW, type ChartView } from './ChartBase'
import { valueThrough, arrowAlong, bCircle, gCircle, polylines, type Pt, qCircles, R_MAJOR, R_MINOR, rCircle, sx, sy, vswrCircle, X_MAJOR, X_MINOR, xCircle, type Circle } from './geometry'
import { around, mergeCoincident, placeLabels, textWidth, type Box, type LabelRequest } from './labels'

/** One colour per network step, in order; the calculator's step list uses the same ones. */
export const PATH_COLORS = ['var(--path-1)', 'var(--path-2)', 'var(--path-3)', 'var(--path-4)', 'var(--path-5)', 'var(--path-6)']

const TEXT_KEY = 'chart.textScale'
const TEXT_STEPS = [0.85, 1, 1.15, 1.3, 1.5, 1.75, 2]
const TEXT_DEFAULT = 1.15
const readTextScale = () => {
  try {
    const v = Number(localStorage.getItem(TEXT_KEY))
    return TEXT_STEPS.includes(v) ? v : TEXT_DEFAULT
  } catch {
    return TEXT_DEFAULT
  }
}

const fmtGrid = (v: number) => String(Math.round(v * 100) / 100)

/**
 * When zoomed in, the fixed scale labels (on the real axis and the rim) are
 * mostly out of view. Label each visible r circle and x arc where it passes
 * closest to the middle of the view instead.
 */
function zoomGridLabels(view: ChartView, s: number): Array<{ x: number; y: number; text: string; box: Box }> {
  if (view.half > 0.8) return []
  const out: Array<{ x: number; y: number; text: string; box: Box }> = []
  const size = 0.03 * s
  const inView = (x: number, y: number) =>
    x > view.cx - view.half * 0.92 && x < view.cx + view.half * 0.85 && y > view.cy - view.half * 0.85 && y < view.cy + view.half * 0.92
  const add = (k: Circle, text: string) => {
    const dx = view.cx - k.cx
    const dy = view.cy - k.cy
    const d = Math.hypot(dx, dy) || 1
    const x = k.cx + (k.r * dx) / d
    const y = k.cy + (k.r * dy) / d
    if (Math.hypot(x, y) > 0.995 || !inView(x, y)) return
    if (out.some((o) => Math.hypot(o.x - x, o.y - y) < 0.06 * s)) return // keep them sparse
    const w = textWidth(text, size)
    out.push({ x, y, text, box: { x0: x + 0.004 * s, y0: y - 0.9 * size, x1: x + 0.004 * s + w, y1: y + 0.1 * size } })
  }
  for (const r of [...R_MAJOR, ...R_MINOR]) add(rCircle(r), fmtGrid(r))
  for (const x of [...X_MAJOR, ...X_MINOR]) {
    add(xCircle(x), `+j${fmtGrid(x)}`)
    add(xCircle(-x), `−j${fmtGrid(x)}`)
  }
  return out
}

const finite = (g?: Complex | null): g is Complex => !!g && Number.isFinite(g.re) && Number.isFinite(g.im)

export function StudioChart() {
  const d = useDerived()
  const overlays = useStudio((s) => s.overlays)
  const network = useStudio((s) => s.network)
  // The step the learner is pointing at in the calculator stands out; the others step back.
  const calcHighlight = useCalc((s) => (s.open && s.tab === 'network' ? s.highlight : null))
  const annotations = useStudio((s) => s.annotations)
  // A reach task's target, drawn so the learner sees where to aim (unless finding it is the task).
  const exercise = useStudio((s) => s.exercise)
  const target = exercise?.kind === 'reach' && exercise.target && exercise.showTarget !== false ? exercise.target : null
  const pinned = useStudio((s) => s.pinned)
  const clickMode = useStudio((s) => s.clickMode)
  const z0 = useStudio((s) => s.z0)
  // Off: the chart is about the design frequency only (no traces, markers or band labels).
  const band = useStudio((s) => s.showBand)
  const showLoadTrace = band && overlays.showLoadTrace
  const showInputTrace = band && overlays.showInputTrace
  const markers = band ? d.markers : []
  const [hoverPx, setHoverPx] = useState<{ x: number; y: number } | null>(null)
  const hover = useHover((s) => s.gamma)
  const setHover = useHover((s) => s.set)
  const [guides, setGuides] = useState(true)
  const view = useStudio((s) => s.view)
  const tutorView = useStudio((s) => s.tutorView)
  const setView = (v: ChartView | ((v: ChartView) => ChartView)) =>
    useStudio.getState().setView(typeof v === 'function' ? v(useStudio.getState().view) : v, 'learner')
  const [textScale, setTextScale] = useState(readTextScale)
  const s = (view.half / VIEW) * textScale

  const onPick = (g: Complex) => {
    const st = useStudio.getState()
    if (st.clickMode === 'setLoad') {
      const Z = zFromGamma(g, st.z0)
      const R = Math.round(Z.re * 100) / 100
      const X = Math.round(Z.im * 100) / 100
      st.setLoad({ kind: 'fixed', R, X }, `Clicked the chart to set the load to Z = ${fmtC({ re: R, im: X }, 'Ω')}`)
    } else if (st.clickMode === 'predict' && st.prediction) {
      const m = metricsFromGamma(g, st.z0)
      const text = `clicked Γ = ${fmtC(g)} (z = ${fmtC(m.z)})`
      st.setPrediction({ ...st.prediction, answered: text, answeredGamma: g })
      st.logEvent('prediction', `Prediction answer: ${text}`)
      st.setPinned(g)
    } else {
      // Pin tolerance follows the zoom, so small spots can be pinned when zoomed in.
      st.setPinned(pinned && abs({ re: pinned.re - g.re, im: pinned.im - g.im }) < 0.02 * s ? null : g)
    }
  }

  const loadLines = polylines(d.trace.map((p) => p.gammaL))
  const inLines = network.length ? polylines(d.trace.map((p) => p.gammaIn)) : []
  const first = d.trace[0]
  const last = d.trace[d.trace.length - 1]
  // A frequency-independent load (fixed Z) draws its whole sweep on one spot: no visible trace, so no end labels.
  const traceCollapsed = !!first && d.trace.every((p) => abs({ re: p.gammaL.re - first.gammaL.re, im: p.gammaL.im - first.gammaL.im }) < 0.005)
  // What each point name means, for the hover explanation on (possibly shared) labels.
  const meanings: Record<string, string> = {
    L: `the load at the design frequency (${fmtHz(d.design.f)})`,
    IN: `the input after your network, at ${fmtHz(d.design.f)}`,
    ...Object.fromEntries(markers.map((m, i) => [`M${i + 1}`, `marker ${i + 1}, at ${fmtHz(m.f)}`]))
  }

  // Every named point on the chart; labels are laid out together below.
  const points: ChartPoint[] = []
  // With a network, the input trace's markers carry the names (that's where the match is judged);
  // the load's copies stay as plain dots, named on hover, so each marker is labelled once.
  const inputNamed = network.length > 0 && showInputTrace
  markers.forEach((m, i) => {
    if (showLoadTrace) points.push({ g: m.load.gamma, cls: 'marker load', label: `M${i + 1}`, ...(inputNamed ? { unlabelled: true } : {}), tip: `M${i + 1}: the load at ${fmtHz(m.f)}` })
    if (inputNamed) points.push({ g: m.input.gamma, cls: 'marker input', label: `M${i + 1}`, tip: `M${i + 1}: the input after your network, at ${fmtHz(m.f)}` })
  })
  points.push({ g: d.design.load.gamma, cls: 'design load', label: 'L', big: true })
  if (network.length > 0) points.push({ g: d.design.input.gamma, cls: 'design input', label: 'IN', big: true })
  const shown = points.filter((p) => finite(p.g))
  /**
   * How far short an arrow ending at g has to stop so the dot drawn there doesn't cover its
   * head: that dot's radius plus its ring (0 when nothing is drawn there).
   */
  const gapAt = (g?: Complex) => {
    if (!finite(g)) return 0
    const near = (q: Complex) => Math.hypot(sx(q) - sx(g), sy(q) - sy(g)) < 0.01 * s
    const radii = [
      ...shown.filter((p) => near(p.g)).map((p) => (p.big ? 0.02 : 0.013) * s),
      ...annotations.filter((a) => a.kind === 'point' && finite(a.gamma) && near(a.gamma)).map(() => 0.022 * s)
    ]
    return radii.length ? Math.max(...radii) + 0.005 * s : 0
  }
  // Each matching-path step: its arrowhead, and the spots labels must keep off (the line and the head).
  const heads = overlays.showPath ? d.path.map((seg) => arrowAlong(lastRun(seg), gapAt(seg[seg.length - 1]), 0.034 * s, 0.017 * s)) : []
  const pathAvoid: Box[] = overlays.showPath
    ? [
        ...d.path.flatMap((seg) => seg.filter((g, k) => finite(g) && k % 3 === 0).map((g) => around(sx(g), sy(g), 0.008 * s))),
        ...heads.flatMap((h) => (h ? [{ x0: Math.min(...h.map((p) => p.x)), y0: Math.min(...h.map((p) => p.y)), x1: Math.max(...h.map((p) => p.x)), y1: Math.max(...h.map((p) => p.y)) }] : []))
      ]
    : []

  const setText = (dir: 1 | -1) => {
    const i = Math.max(0, Math.min(TEXT_STEPS.length - 1, TEXT_STEPS.indexOf(textScale) + dir))
    setTextScale(TEXT_STEPS[i])
    try {
      localStorage.setItem(TEXT_KEY, String(TEXT_STEPS[i]))
    } catch { /* not remembered */ }
  }
  const zoomBy = (f: number) => setView((v) => clampView({ ...v, half: v.half * f }))
  /** Frame the load, input, markers and matching path. */
  const focus = () => {
    const pts = [...shown.map((p) => p.g), ...(overlays.showPath ? d.path.flat() : [])].filter(finite)
    if (pts.length) setView(frameView(pts))
  }
  const zoomed = view.half < VIEW - 1e-6
  const gridLabels = zoomGridLabels(view, s)

  // Hovering on or near a trace reads the trace there (its frequency, and its Z), not the empty chart:
  // a Smith chart has no frequency axis, so this is how you find "where is it at 5.2 GHz?".
  const snap = (() => {
    if (!hover) return null
    const tol = 0.03 * (view.half / VIEW)
    const hits: Array<{ which: 'load' | 'input'; f: number; g: Complex }> = []
    if (showLoadTrace && !traceCollapsed) {
      const h = nearestOnTrace(d.trace.map((p) => ({ f: p.f, g: p.gammaL })), hover, tol)
      if (h) hits.push({ which: 'load', ...h })
    }
    if (showInputTrace && network.length > 0) {
      const h = nearestOnTrace(d.trace.map((p) => ({ f: p.f, g: p.gammaIn })), hover, tol)
      if (h) hits.push({ which: 'input', ...h })
    }
    const dist = (g: Complex) => Math.hypot(g.re - hover.re, g.im - hover.im)
    return hits.sort((a, b) => dist(a.g) - dist(b.g))[0] ?? null
  })()
  // The readout under the chart shows the same point as the tip.
  const setSnap = useHover((st) => st.setSnap)
  useEffect(() => setSnap(snap), [setSnap, snap?.which, snap?.f, snap?.g.re, snap?.g.im]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="chart-wrap">
      <ChartBase
        admittance={overlays.admittance}
        onHover={(g, px) => {
          setHover(g)
          setHoverPx(px)
        }}
        onPick={onPick}
        className={clickMode !== 'inspect' ? 'picking' : ''}
        view={view}
        onViewChange={(v) => setView(v)}
        textScale={textScale}
      >
        {/* Q contour: shade the low-Q region */}
        {overlays.qContour && <QRegion q={overlays.qContour} />}
        {overlays.vswrCircle && (
          <circle {...circ(vswrCircle(overlays.vswrCircle))} className="vswr-circle" />
        )}

        {/* hover guides: constant r, x, |Γ| through the cursor */}
        {guides && hover && <HoverGuides g={snap?.g ?? hover} admittance={overlays.admittance} />}

        {/* traces */}
        {showLoadTrace && loadLines.map((pts, i) => <polyline key={`l${i}`} points={pts} className="trace load" />)}
        {showInputTrace && inLines.map((pts, i) => <polyline key={`i${i}`} points={pts} className="trace input" />)}
        {showLoadTrace && first && !traceCollapsed && <circle cx={sx(first.gammaL)} cy={sy(first.gammaL)} r={0.012 * s} className="trace-end load" />}

        {/* matching path at the design frequency */}
        {overlays.showPath &&
          d.path.map((seg, i) => {
            const head = heads[i]
            return (
              <g key={`p${i}`} className={calcHighlight === null ? undefined : calcHighlight === i ? 'path-hl' : 'path-dim'} style={{ color: PATH_COLORS[i % PATH_COLORS.length] }}>
                {polylines(seg).map((pts, j) => <polyline key={j} points={pts} className="path" />)}
                {head && <polygon points={head.map((p) => `${p.x},${p.y}`).join(' ')} className="path-head" />}
              </g>
            )
          })}

        {shown.map((p, i) => <Dot key={i} g={p.g} cls={p.cls} big={p.big} tip={p.tip} />)}
        {snap && <circle cx={sx(snap.g)} cy={sy(snap.g)} r={0.014 * s} className={`trace-snap ${snap.which}`} />}

        {target && <TargetShape t={target} />}
        {annotations.map((a) => <AnnotationShape key={a.id} a={a} endGap={a.kind === 'arrow' ? gapAt(a.to) : 0} />)}

        {pinned && (
          <g className="pinned">
            <circle cx={sx(pinned)} cy={sy(pinned)} r={0.018 * s} />
            <line x1={sx(pinned) - 0.03 * s} y1={sy(pinned)} x2={sx(pinned) + 0.03 * s} y2={sy(pinned)} />
            <line x1={sx(pinned)} y1={sy(pinned) - 0.03 * s} x2={sx(pinned)} y2={sy(pinned) + 0.03 * s} />
          </g>
        )}

        {gridLabels.map((g, i) => (
          <text key={`gl${i}`} x={g.box.x0} y={g.y} className="lbl grid-lbl">{g.text}</text>
        ))}

        <ChartLabels
          s={s}
          view={view}
          avoid={[...gridLabels.map((g) => g.box), ...pathAvoid]}
          points={shown}
          meanings={meanings}
          fixedLoad={band && traceCollapsed}
          annotations={target ? [...annotations, targetLabel(target)] : annotations}
          pathLabels={overlays.showPath ? d.path.map((seg, i) => ({
            at: seg[Math.floor(seg.length / 2)],
            text: `${i + 1}·${ELEMENT_LABEL[network[i]?.kind]?.split(' ').slice(0, 2).join(' ') ?? ''}`,
            color: PATH_COLORS[i % PATH_COLORS.length]
          })) : []}
          traceLabels={showLoadTrace && first && !traceCollapsed ? [
            { at: first.gammaL, text: fmtHz(first.f, 3) },
            ...(abs({ re: last.gammaL.re - first.gammaL.re, im: last.gammaL.im - first.gammaL.im }) > 0.08 ? [{ at: last.gammaL, text: fmtHz(last.f, 3) }] : [])
          ] : []}
        />
      </ChartBase>

      {hover && hoverPx && (snap
        ? <HoverTip g={snap.g} z0={z0} f={snap.f} px={hoverPx} on={`${snap.which === 'load' ? 'Load' : 'Input (after your network)'} at ${fmtHz(snap.f, 4)}`} />
        : <HoverTip g={hover} z0={z0} f={d.design.f} px={hoverPx} />)}

      <div className="chart-legend">
        <span className="lg load">● load</span>
        {network.length > 0 && <span className="lg input">● input (after network)</span>}
        <span className="lg design">◎ design f = {fmtHz(d.design.f)}</span>
        {markers.length > 0 && (
          <span className="lg marker" title={`${markers.map((m, i) => `M${i + 1} = ${fmtHz(m.f)}`).join(', ')}. Where the load${network.length ? ' and your match sit' : ' sits'} at those frequencies; values are in the table below the chart.`}>
            • {markers.map((_, i) => `M${i + 1}`).join(', ')} markers
          </span>
        )}
        {band && traceCollapsed && (
          <span className="lg note" title="A fixed impedance doesn't change with frequency, so the load, its markers and its whole sweep sit on one point. Add a network: L and C do change with frequency, so the matched points spread out.">
            fixed load: same point at every frequency
          </span>
        )}
        <label className="lg" title={band
          ? 'Showing the load (and input) across the sweep, with markers and bandwidth. Untick to see the design frequency only.'
          : 'The chart shows the design frequency only. Tick to see how the load (and your match) change across a band of frequencies.'}>
          <input type="checkbox" checked={band} onChange={(e) => useStudio.getState().setShowBand(e.target.checked, 'learner')} /> frequency band
        </label>
        <label className="lg"><input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} /> hover guides</label>
      </div>

      <div className="chart-tools" role="toolbar" aria-label="Chart view">
        <button onClick={() => zoomBy(1 / 1.5)} title="Zoom in (or scroll on the chart)">＋</button>
        <button onClick={() => zoomBy(1.5)} disabled={!zoomed} title="Zoom out">－</button>
        <button onClick={focus} title="Zoom to the load, input, markers and matching path">⌖ Focus</button>
        <button onClick={() => setView(FULL_VIEW)} disabled={!zoomed} title="Show the whole chart">Fit</button>
        <span className="sep" />
        <button onClick={() => setText(-1)} disabled={textScale === TEXT_STEPS[0]} title="Smaller text and dots">A−</button>
        <button onClick={() => setText(1)} disabled={textScale === TEXT_STEPS[TEXT_STEPS.length - 1]} title="Larger text and dots">A+</button>
        {zoomed && <span className="zoom-hint">{(VIEW / view.half).toFixed(1)}× · drag to pan</span>}
      </div>

      {tutorView && (
        <div className="tutor-view-chip" role="status">
          <span>🔍 Tutor zoomed in: {tutorView.reason}</span>
          <button onClick={() => useStudio.getState().restoreView()} title="Return to the view you had">↩ Back to my view</button>
        </div>
      )}
    </div>
  )
}

const circ = (k: Circle) => ({ cx: k.cx, cy: k.cy, r: k.r })

/** The end of a path in SVG coordinates, up to the last break (a point off to infinity). */
function lastRun(seg: Complex[]): Pt[] {
  const out: Pt[] = []
  for (let i = seg.length - 1; i >= 0 && finite(seg[i]) && Math.hypot(seg[i].re, seg[i].im) <= 1.5; i--) out.unshift({ x: sx(seg[i]), y: sy(seg[i]) })
  return out
}

/** A named point on the chart. `unlabelled`: drawn and named on hover, but no label on the chart. */
interface ChartPoint { g: Complex; cls: string; label: string; big?: boolean; unlabelled?: boolean; tip?: string }

function Dot({ g, cls, big, tip }: { g: Complex; cls: string; big?: boolean; tip?: string }) {
  const s = useChartScale()
  return (
    <g className={`dot ${cls}`}>
      <circle cx={sx(g)} cy={sy(g)} r={(big ? 0.02 : 0.013) * s}>{tip && <title>{tip}</title>}</circle>
    </g>
  )
}

/**
 * All text on top of the chart, laid out together so nothing overlaps: point
 * names (coincident points share one label), the tutor's annotations, matching
 * path steps and the sweep's end frequencies.
 */
function ChartLabels({ s, view, avoid, points, meanings, fixedLoad, annotations, pathLabels, traceLabels }: {
  s: number
  view: ChartView
  meanings: Record<string, string>
  fixedLoad: boolean
  /** Other text already on the chart (zoomed scale labels) */
  avoid: Box[]
  points: ChartPoint[]
  annotations: Annotation[]
  pathLabels: Array<{ at?: Complex; text: string; color: string }>
  traceLabels: Array<{ at: Complex; text: string }>
}) {
  const obstacles: Box[] = [...avoid]
  for (const p of points) obstacles.push(around(sx(p.g), sy(p.g), (p.big ? 0.026 : 0.02) * s))
  for (const a of annotations) {
    if (a.kind === 'point' && finite(a.gamma)) obstacles.push(around(sx(a.gamma), sy(a.gamma), 0.028 * s))
    if (a.kind === 'arrow' && finite(a.gamma) && finite(a.to)) {
      // Sample along the arrow so labels don't sit across it.
      for (let t = 0; t <= 1; t += 0.1) {
        obstacles.push(around(sx(a.gamma) + t * (sx(a.to) - sx(a.gamma)), sy(a.gamma) + t * (sy(a.to) - sy(a.gamma)), 0.012 * s))
      }
    }
  }

  const reqs: LabelRequest[] = []
  // Design points (L, IN) name a shared spot first: "L · M1 · M2".
  // Points close together share one label ("L · M1 · M2") rather than crowding each other out.
  const ordered = [...points].filter((p) => !p.unlabelled).sort((a, b) => Number(!!b.big) - Number(!!a.big))
  const groups = mergeCoincident(ordered.map((p) => ({ x: sx(p.g), y: sy(p.g), label: p.label, cls: p.cls })), 0.045 * s)
  groups.forEach((g, i) => {
    const what = g.labels.map((l) => `${l} = ${meanings[l] ?? l}`).join('\n')
    const why = g.labels.length < 2 ? '' : fixedLoad && g.labels.includes('L')
      ? '\n\nThey share one spot because the load is a fixed impedance: it is the same at every frequency. Add a network and the matched points separate (L and C change with frequency).'
      : '\n\nThese points are close together on the chart.'
    reqs.push({ id: `pt${i}`, text: g.labels.join(' · '), x: g.x, y: g.y, size: 0.032 * s, className: 'lbl dot-lbl', title: what + why })
  })
  for (const a of annotations) {
    if (!a.label) continue
    let at: Complex | null = null
    let prefer: LabelRequest['prefer']
    if (a.kind === 'arrow' && finite(a.gamma) && finite(a.to)) {
      at = { re: (a.gamma.re + a.to.re) / 2, im: (a.gamma.im + a.to.im) / 2 }
      prefer = a.to.re < a.gamma.re ? 'right' : 'left'
    } else {
      at = finite(a.gamma) ? a.gamma : labelSpot(a)
    }
    if (at) reqs.push({ id: a.id, text: a.label, x: sx(at), y: sy(at), size: 0.036 * s, prefer, className: 'lbl ann-lbl', color: a.color ?? 'var(--tutor)' })
  }
  pathLabels.forEach((p, i) => {
    if (finite(p.at)) reqs.push({ id: `path${i}`, text: p.text, x: sx(p.at), y: sy(p.at), size: 0.03 * s, className: 'lbl path-lbl', color: p.color })
  })
  traceLabels.forEach((t, i) => {
    if (finite(t.at)) reqs.push({ id: `tr${i}`, text: t.text, x: sx(t.at), y: sy(t.at), size: 0.03 * s, className: 'lbl small load-lbl' })
  })

  const placed = placeLabels(reqs, obstacles, { x0: view.cx - view.half, y0: view.cy - view.half, x1: view.cx + view.half, y1: view.cy + view.half })
  const pad = 0.006 * s
  return (
    <g className="chart-labels">
      {placed.map((p) => (
        <g key={p.id}>
          {/* Plate behind the text so grid lines and traces don't run through it */}
          <rect x={p.box.x0 - pad} y={p.box.y0 - pad / 2} width={p.box.x1 - p.box.x0 + 2 * pad} height={p.box.y1 - p.box.y0 + pad} rx={pad} className="label-plate" />
          <text x={p.x} y={p.y} textAnchor={p.anchor} className={p.className} style={p.color ? { fill: p.color } : undefined}>
            {p.title && <title>{p.title}</title>}
            {p.text}
          </text>
        </g>
      ))}
    </g>
  )
}

/** The target of a reach task: a ringed spot, or the circle or arc to land on. */
function TargetShape({ t }: { t: Target }) {
  const s = useChartScale()
  if (t.type === 'point') {
    const g = gammaFromZ(t.z, 1)
    return (
      <g className="target-shape">
        <circle cx={sx(g)} cy={sy(g)} r={0.032 * s} />
        <circle cx={sx(g)} cy={sy(g)} r={0.009 * s} className="core" />
      </g>
    )
  }
  if ((t.family === 'x' || t.family === 'b') && Math.abs(t.value) < 1e-9) {
    return <g className="target-shape"><line x1={-1} y1={0} x2={1} y2={0} /></g>
  }
  const k = { r: rCircle, g: gCircle, x: xCircle, b: bCircle, vswr: vswrCircle }[t.family](t.value)
  return <g className="target-shape" clipPath="url(#unit)"><circle {...circ(k)} /></g>
}

/** Where the "target" label goes: on the shape, somewhere easy to see. */
function targetLabel(t: Target): Annotation {
  let z: Complex
  if (t.type === 'point') z = t.z
  else if (t.family === 'r') z = { re: t.value, im: 0 }
  else if (t.family === 'g') z = t.value > 0 ? { re: 1 / t.value, im: 0 } : { re: 0, im: 1 }
  else if (t.family === 'x') z = { re: 1, im: t.value }
  else if (t.family === 'b') z = admittanceOf({ re: 1, im: t.value })
  else z = zFromGamma({ re: 0, im: (t.value - 1) / (t.value + 1) }, 1)
  return { id: 'target', kind: 'point', gamma: gammaFromZ(z, 1), label: 'target', color: 'var(--target)' }
}

function QRegion({ q }: { q: number }) {
  const [a, b] = qCircles(q)
  return (
    <g className="q-region">
      <defs>
        <clipPath id="qclip-a" clipPath="url(#unit)">
          <circle {...circ(a)} />
        </clipPath>
      </defs>
      <circle {...circ(b)} clipPath="url(#qclip-a)" className="q-fill" />
      <g clipPath="url(#unit)">
        <circle {...circ(a)} className="q-line" />
        <circle {...circ(b)} className="q-line" />
      </g>
      <text x={0.02} y={-Math.sqrt(1 + 1 / (q * q)) + 1 / q - 0.015} className="lbl q-lbl">Q = {q}</text>
    </g>
  )
}

function HoverGuides({ g, admittance }: { g: Complex; admittance: boolean }) {
  const m = metricsFromGamma(g, 1)
  const r = m.z.re
  const x = m.z.im
  return (
    <g className="guides" clipPath="url(#unit)">
      <circle {...circ(vswrCircle(Math.min(m.vswr, 1e6)))} className="guide vswr" />
      {r > 0 && Number.isFinite(r) && <circle {...circ(rCircle(r))} className="guide r" />}
      {Math.abs(x) > 1e-3 && Number.isFinite(x) && <circle {...circ(xCircle(x))} className="guide x" />}
      {admittance && m.y.re > 0 && <circle {...circ(gCircle(m.y.re))} className="guide g" />}
      {admittance && Math.abs(m.y.im) > 1e-3 && <circle {...circ(bCircle(m.y.im))} className="guide b" />}
    </g>
  )
}

function AnnotationShape({ a, endGap = 0 }: { a: Annotation; endGap?: number }) {
  const s = useChartScale()
  const color = a.color ?? 'var(--tutor)'
  const style = { color, stroke: color }
  // A circle saved with only a point (before drawings were checked): the circle through that point.
  const v = a.value ?? (a.gamma ? valueThrough(a.kind, a.gamma) : undefined) ?? 1
  let shape: React.ReactNode = null
  switch (a.kind) {
    case 'point':
      if (!a.gamma) return null
      shape = <circle cx={sx(a.gamma)} cy={sy(a.gamma)} r={0.022 * s} className="ann-point" />
      break
    case 'arrow':
      if (!a.gamma || !a.to) return null
      {
        // The head stops at the edge of a dot at the end, so the point it shows stays visible.
        const from = { x: sx(a.gamma), y: sy(a.gamma) }
        const head = arrowAlong([from, { x: sx(a.to), y: sy(a.to) }], endGap, 0.034 * s, 0.017 * s)
        const end = head ? head[0] : { x: sx(a.to), y: sy(a.to) }
        shape = (
          <>
            <line x1={from.x} y1={from.y} x2={end.x} y2={end.y} className="ann-line" />
            {head && <polygon points={head.map((p) => `${p.x},${p.y}`).join(' ')} className="ann-head" />}
          </>
        )
      }
      break
    case 'vswrCircle': shape = <circle {...circ(vswrCircle(v))} className="ann-line" />; break
    case 'rCircle': shape = <circle {...circ(rCircle(v))} className="ann-line" clipPath="url(#unit)" />; break
    case 'xArc': shape = <circle {...circ(xCircle(v))} className="ann-line" clipPath="url(#unit)" />; break
    case 'gCircle': shape = <circle {...circ(gCircle(v))} className="ann-line" clipPath="url(#unit)" />; break
    case 'bArc': shape = <circle {...circ(bCircle(v))} className="ann-line" clipPath="url(#unit)" />; break
    case 'qContour': {
      const [c1, c2] = qCircles(v)
      shape = (
        <g clipPath="url(#unit)">
          <circle {...circ(c1)} className="ann-line" />
          <circle {...circ(c2)} className="ann-line" />
        </g>
      )
      break
    }
  }
  return (
    <g className="annotation" style={style}>
      {shape}
    </g>
  )
}

function labelSpot(a: Annotation): Complex | null {
  const v = a.value ?? 1
  switch (a.kind) {
    case 'vswrCircle': return { re: 0, im: (v - 1) / (v + 1) }
    case 'rCircle': return { re: (v - 1) / (v + 1), im: 0 }
    case 'gCircle': return { re: -(v - 1) / (v + 1), im: 0 }
    default: return null
  }
}

/** What's under the cursor; `on` names the trace point it snapped to (with its frequency), if any. */
function HoverTip({ g, z0, f, px, on }: { g: Complex; z0: number; f: number; px: { x: number; y: number }; on?: string }) {
  const m = metricsFromGamma(g, z0, f)
  return (
    <div className="hover-tip" style={{ left: px.x + 16, top: px.y + 16 }}>
      {on && <div className="tip-head">{on}</div>}
      <div><b>z</b> {fmtC(m.z)} &nbsp; <b>Z</b> {fmtC(m.Z, 'Ω')}</div>
      <div><b>y</b> {fmtC(m.y)}</div>
      <div><b>|Γ|</b> {fmtNum(m.gammaMag)} ∠ {m.gammaDeg.toFixed(1)}° &nbsp; <b>VSWR</b> {fmtNum(m.vswr)}</div>
      <div><b>RL</b> {fmtDb(m.returnLossDb)} &nbsp; <b>Q</b> {fmtNum(m.q)}</div>
    </div>
  )
}
