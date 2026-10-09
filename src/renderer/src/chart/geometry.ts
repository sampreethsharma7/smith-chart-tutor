import type { Complex } from '@shared/rf/complex'

/** SVG uses y-down; Γ uses imag-up. Chart radius is 1 in user units. */
export const sx = (g: Complex) => g.re
export const sy = (g: Complex) => -g.im

export interface Circle {
  cx: number
  cy: number
  r: number
}

export const rCircle = (r: number): Circle => ({ cx: r / (1 + r), cy: 0, r: 1 / (1 + r) })
export const xCircle = (x: number): Circle => ({ cx: 1, cy: -1 / x, r: 1 / Math.abs(x) })
export const gCircle = (g: number): Circle => ({ cx: -g / (1 + g), cy: 0, r: 1 / (1 + g) })
export const bCircle = (b: number): Circle => ({ cx: -1, cy: 1 / b, r: 1 / Math.abs(b) })
export const vswrCircle = (s: number): Circle => ({ cx: 0, cy: 0, r: (s - 1) / (s + 1) })
/** The two arcs of a constant-|Q| contour (upper = inductive, lower = capacitive). */
/** The value of a circle family through a point Γ: the VSWR, r, x, g, b or Q circle that passes there. */
export function valueThrough(kind: string, g: Complex): number | undefined {
  const den = (1 - g.re) ** 2 + g.im ** 2
  const z = { re: (1 - g.re * g.re - g.im * g.im) / den, im: (2 * g.im) / den }
  const d = z.re * z.re + z.im * z.im
  const m = Math.hypot(g.re, g.im)
  const v = { vswrCircle: (1 + m) / (1 - m), rCircle: z.re, xArc: z.im, gCircle: z.re / d, bArc: -z.im / d, qContour: Math.abs(z.im) / z.re }[kind]
  return v !== undefined && Number.isFinite(v) ? v : undefined
}

export const qCircles = (q: number): [Circle, Circle] => {
  const r = Math.sqrt(1 + 1 / (q * q))
  return [{ cx: 0, cy: 1 / q, r }, { cx: 0, cy: -1 / q, r }]
}

export const R_MAJOR = [0.2, 0.5, 1, 2, 5]
export const R_MINOR = [0.1, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 1.5, 3, 4, 10, 20]
export const X_MAJOR = [0.2, 0.5, 1, 2, 5]
export const X_MINOR = [0.1, 0.3, 0.4, 0.6, 0.7, 0.8, 0.9, 1.5, 3, 4, 10, 20]

/** Polyline "x,y x,y" string, splitting at non-finite points. */
export function polylines(pts: Complex[]): string[] {
  const out: string[] = []
  let cur: string[] = []
  for (const p of pts) {
    if (!Number.isFinite(p.re) || !Number.isFinite(p.im) || Math.hypot(p.re, p.im) > 1.5) {
      if (cur.length > 1) out.push(cur.join(' '))
      cur = []
      continue
    }
    cur.push(`${p.re.toFixed(5)},${(-p.im).toFixed(5)}`)
  }
  if (cur.length > 1) out.push(cur.join(' '))
  return out
}

/** Point on the rim for a given Γ angle (degrees), at radius k. */
export const rim = (angleDeg: number, k = 1) => {
  const a = (angleDeg * Math.PI) / 180
  return { x: k * Math.cos(a), y: -k * Math.sin(a) }
}

export interface Pt { x: number; y: number }

/** The point `dist` back from the end of a polyline, measured along it (the start if it is shorter). */
export function backAlong(pts: Pt[], dist: number): Pt {
  let left = dist
  for (let i = pts.length - 1; i > 0; i--) {
    const a = pts[i], b = pts[i - 1]
    const seg = Math.hypot(a.x - b.x, a.y - b.y)
    if (seg >= left && seg > 0) {
      const t = left / seg
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
    left -= seg
  }
  return pts[0]
}

const pathLength = (pts: Pt[]) => pts.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)

/**
 * Arrowhead for the end of a path, as a triangle in chart units. Its tip stops `gap`
 * before the end, so a dot drawn at the end (the new point) doesn't cover it; it
 * points along the path there. Null when the path is too short to carry one.
 */
export function arrowAlong(pts: Pt[], gap: number, len: number, halfWidth: number): Pt[] | null {
  if (pts.length < 2 || pathLength(pts) < gap + len * 0.6) return null
  const tip = backAlong(pts, gap)
  const base = backAlong(pts, gap + len)
  const dx = tip.x - base.x, dy = tip.y - base.y
  const d = Math.hypot(dx, dy)
  if (d === 0) return null
  const ux = dx / d, uy = dy / d
  const b = { x: tip.x - ux * len, y: tip.y - uy * len }
  return [tip, { x: b.x - uy * halfWidth, y: b.y + ux * halfWidth }, { x: b.x + uy * halfWidth, y: b.y - ux * halfWidth }]
}
