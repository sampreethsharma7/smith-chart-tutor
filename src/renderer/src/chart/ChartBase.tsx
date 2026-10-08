import { createContext, memo, useCallback, useContext, useEffect, useRef, type ReactNode } from 'react'
import { c, type Complex } from '@shared/rf/complex'
import { bCircle, gCircle, R_MAJOR, R_MINOR, rCircle, rim, X_MAJOR, X_MINOR, xCircle } from './geometry'

/** What part of the chart is shown: centre (SVG coords) and half the side length. */
export interface ChartView { cx: number; cy: number; half: number }

interface Props {
  children?: ReactNode
  admittance?: boolean
  wtgScale?: boolean
  onHover?(g: Complex | null, px: { x: number; y: number } | null): void
  onPick?(g: Complex, e: React.MouseEvent): void
  className?: string
  /** Zoom/pan: wheel zooms around the cursor, drag pans. Omit for a fixed chart. */
  view?: ChartView
  onViewChange?(v: ChartView): void
  /** Text and dot size multiplier (A−/A+) */
  textScale?: number
}

export const VIEW = 1.24
export const FULL_VIEW: ChartView = { cx: 0, cy: 0, half: VIEW }
const MIN_HALF = 0.04

/**
 * Chart units per "normal" unit for text and dots. Text and dots keep the same
 * size on screen while zooming (so crowded spots spread out), times the A−/A+ setting.
 */
const ScaleCtx = createContext(1)
export const useChartScale = () => useContext(ScaleCtx)

/** A view that frames these points (Γ) with some margin. */
export function frameView(pts: Complex[], minHalf = 0.15): ChartView {
  const ok = pts.filter((g) => Number.isFinite(g.re) && Number.isFinite(g.im))
  if (!ok.length) return FULL_VIEW
  const xs = ok.map((g) => g.re)
  const ys = ok.map((g) => -g.im)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const half = Math.max(minHalf, Math.max(x1 - x0, y1 - y0) / 2 + 0.12)
  return clampView({ cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, half })
}

/** Is Γ inside the visible part of the chart? */
export const inView = (v: ChartView, g: Complex) => Math.abs(g.re - v.cx) <= v.half && Math.abs(-g.im - v.cy) <= v.half

/** Keep the view inside the full chart. */
export function clampView(v: ChartView): ChartView {
  const half = Math.min(VIEW, Math.max(MIN_HALF, v.half))
  const lim = VIEW - half
  return { half, cx: Math.max(-lim, Math.min(lim, v.cx)), cy: Math.max(-lim, Math.min(lim, v.cy)) }
}

/** The bare Smith chart: grid, scales, pointer → Γ conversion, and optional zoom/pan. */
export function ChartBase({ children, admittance, wtgScale = true, onHover, onPick, className, view = FULL_VIEW, onViewChange, textScale = 1 }: Props) {
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: ChartView; moved: boolean } | null>(null)
  const suppressClick = useRef(false)
  const viewRef = useRef(view)
  viewRef.current = view
  const zoomable = !!onViewChange
  const s = (view.half / VIEW) * textScale

  const toSvg = useCallback((clientX: number, clientY: number) => {
    const ctm = svgRef.current?.getScreenCTM()
    return ctm ? new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse()) : null
  }, [])
  const toGamma = useCallback((e: React.MouseEvent): Complex | null => {
    const pt = toSvg(e.clientX, e.clientY)
    return pt ? c(pt.x, -pt.y) : null
  }, [toSvg])

  // Wheel zoom around the cursor. A native listener, because React's wheel handler is passive and can't stop the page scrolling.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg || !zoomable) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const pt = toSvg(e.clientX, e.clientY)
      if (!pt) return
      const v = viewRef.current
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0015)
      const half = Math.min(VIEW, Math.max(MIN_HALF, v.half * f))
      const k = half / v.half
      onViewChange!(clampView({ half, cx: pt.x - (pt.x - v.cx) * k, cy: pt.y - (pt.y - v.cy) * k }))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomable, onViewChange, toSvg])

  return (
    <svg
      ref={svgRef}
      className={`smith ${className ?? ''} ${zoomable && view.half < VIEW ? 'zoomed' : ''}`}
      viewBox={`${view.cx - view.half} ${view.cy - view.half} ${2 * view.half} ${2 * view.half}`}
      style={{ '--s': s } as React.CSSProperties}
      onPointerDown={(e) => {
        if (!zoomable || e.button !== 0 || view.half >= VIEW) return
        drag.current = { x: e.clientX, y: e.clientY, view, moved: false }
      }}
      onPointerUp={() => {
        if (drag.current?.moved) suppressClick.current = true
        drag.current = null
      }}
      onMouseMove={(e) => {
        const d = drag.current
        if (d && (d.moved || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4)) {
          // Drag to pan (only once zoomed in).
          d.moved = true
          const px = svgRef.current!.getBoundingClientRect().width / (2 * d.view.half)
          onViewChange!(clampView({ ...d.view, cx: d.view.cx - (e.clientX - d.x) / px, cy: d.view.cy - (e.clientY - d.y) / px }))
          onHover?.(null, null)
          return
        }
        if (!onHover) return
        const g = toGamma(e)
        const r = svgRef.current!.getBoundingClientRect()
        onHover(g && Math.hypot(g.re, g.im) <= 1.0 ? g : null, { x: e.clientX - r.left, y: e.clientY - r.top })
      }}
      onMouseLeave={() => {
        drag.current = null
        onHover?.(null, null)
      }}
      onClick={(e) => {
        if (suppressClick.current) {
          suppressClick.current = false
          return
        }
        const g = toGamma(e)
        if (g && Math.hypot(g.re, g.im) <= 1.0) onPick?.(g, e)
      }}
    >
      <defs>
        <clipPath id="unit">
          <circle cx={0} cy={0} r={1} />
        </clipPath>
      </defs>
      <circle cx={0} cy={0} r={1} className="chart-bg" />
      <Grid admittance={!!admittance} />
      {wtgScale && <WtgScale />}
      <ScaleCtx.Provider value={s}>{children}</ScaleCtx.Provider>
    </svg>
  )
}

const Grid = memo(function Grid({ admittance }: { admittance: boolean }) {
  return (
    <g className="grid" vectorEffect="non-scaling-stroke">
      <g clipPath="url(#unit)">
        {admittance && (
          <g className="adm">
            {[...R_MAJOR, ...R_MINOR].map((g) => {
              const k = gCircle(g)
              return <circle key={`g${g}`} cx={k.cx} cy={k.cy} r={k.r} className={R_MAJOR.includes(g) ? 'major' : ''} />
            })}
            {[...X_MAJOR, ...X_MINOR].flatMap((b) =>
              [b, -b].map((bb) => {
                const k = bCircle(bb)
                return <circle key={`b${bb}`} cx={k.cx} cy={k.cy} r={k.r} className={X_MAJOR.includes(b) ? 'major' : ''} />
              })
            )}
          </g>
        )}
        {R_MINOR.map((r) => {
          const k = rCircle(r)
          return <circle key={`rm${r}`} cx={k.cx} cy={k.cy} r={k.r} className="minor" />
        })}
        {X_MINOR.flatMap((x) =>
          [x, -x].map((xx) => {
            const k = xCircle(xx)
            return <circle key={`xm${xx}`} cx={k.cx} cy={k.cy} r={k.r} className="minor" />
          })
        )}
        {R_MAJOR.map((r) => {
          const k = rCircle(r)
          return <circle key={`r${r}`} cx={k.cx} cy={k.cy} r={k.r} className={r === 1 ? 'unity' : 'major'} />
        })}
        {X_MAJOR.flatMap((x) =>
          [x, -x].map((xx) => {
            const k = xCircle(xx)
            return <circle key={`x${xx}`} cx={k.cx} cy={k.cy} r={k.r} className={x === 1 ? 'unity' : 'major'} />
          })
        )}
      </g>
      <line x1={-1} y1={0} x2={1} y2={0} className="major" />
      <circle cx={0} cy={0} r={1} className="rim" />
      {/* resistance labels along the real axis */}
      {[0, ...R_MAJOR, 10].map((r) => (
        <text key={`rl${r}`} x={(r - 1) / (r + 1) + 0.008} y={-0.012} className="lbl">{r}</text>
      ))}
      {/* reactance labels around the rim */}
      {[...X_MAJOR, 10].flatMap((x) =>
        [x, -x].map((xx) => {
          const ang = (Math.atan2(2 * xx, xx * xx - 1) * 180) / Math.PI
          const p = rim(ang, 1.045)
          return (
            <text key={`xl${xx}`} x={p.x} y={p.y} className="lbl rim-lbl" textAnchor="middle" dominantBaseline="middle">
              {xx > 0 ? '+j' : '−j'}{Math.abs(xx)}
            </text>
          )
        })
      )}
      <text x={-1.0} y={0.06} className="lbl dim" textAnchor="middle">short</text>
      <text x={1.0} y={0.06} className="lbl dim" textAnchor="middle">open</text>
    </g>
  )
})

const WtgScale = memo(function WtgScale() {
  const ticks = []
  for (let i = 0; i < 50; i++) {
    const wtg = i / 100
    const ang = 180 - 720 * wtg
    const a = rim(ang, 1.1)
    const b = rim(ang, i % 5 === 0 ? 1.13 : 1.12)
    ticks.push(<line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />)
    if (i % 5 === 0) {
      const t = rim(ang, 1.17)
      ticks.push(
        <text key={`t${i}`} x={t.x} y={t.y} className="lbl wtg" textAnchor="middle" dominantBaseline="middle">
          {wtg.toFixed(2)}
        </text>
      )
    }
  }
  return (
    <g className="wtg-scale">
      <circle cx={0} cy={0} r={1.1} />
      {ticks}
      <text x={0} y={-1.215} className="lbl dim" textAnchor="middle">wavelengths toward generator →</text>
    </g>
  )
})
