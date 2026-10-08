/**
 * Place text labels on the chart so they don't sit on top of each other or on
 * the chart's own dots. Greedy: each label tries a few spots around its anchor
 * and takes the first free one (or the least crowded). Units are chart units
 * (the unit circle has radius 1).
 */

export interface Box { x0: number; y0: number; x1: number; y1: number }

export interface LabelRequest {
  id: string
  text: string
  /** Styling for the rendered text */
  className?: string
  color?: string
  /** Hover explanation */
  title?: string
  /** Anchor in SVG coordinates */
  x: number
  y: number
  /** Font size in chart units */
  size: number
  /** Preferred side, e.g. away from an arrow */
  prefer?: 'right' | 'left'
}

export interface PlacedLabel { id: string; text: string; x: number; y: number; anchor: 'start' | 'end'; box: Box; className?: string; color?: string; title?: string }

/**
 * Points closer than `eps` share one label ("IN · M1"), so coincident points
 * (a marker at the design frequency, say) don't print their names on top of each other.
 */
export function mergeCoincident<T extends { x: number; y: number; label: string }>(pts: T[], eps: number): Array<T & { labels: string[] }> {
  const groups: Array<T & { labels: string[] }> = []
  for (const p of pts) {
    const g = groups.find((q) => Math.hypot(q.x - p.x, q.y - p.y) < eps)
    if (g) { if (!g.labels.includes(p.label)) g.labels.push(p.label) }
    else groups.push({ ...p, labels: [p.label] })
  }
  return groups
}

/** Rough text width: the chart's semibold sans measures ~0.45 em per character; a little slack on top. */
export const textWidth = (text: string, size: number) => text.length * size * 0.5

const area = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0))

/** `bounds`: the visible region (a half-size for a centred square, or a box when zoomed). */
export function placeLabels(reqs: LabelRequest[], obstacles: Box[], bounds: number | Box): PlacedLabel[] {
  const b: Box = typeof bounds === 'number' ? { x0: -bounds, y0: -bounds, x1: bounds, y1: bounds } : bounds
  const taken: Box[] = [...obstacles]
  const out: PlacedLabel[] = []
  for (const r of reqs) {
    const w = textWidth(r.text, r.size)
    const h = r.size
    const g = h * 0.8 // gap from the anchor
    // Right/left of the anchor, above then below, then further out.
    const right: Array<[number, number, 'start' | 'end']> = [[g, -g, 'start'], [g, g + h, 'start'], [g, -g - 1.2 * h, 'start'], [g, g + 2.2 * h, 'start']]
    const left: Array<[number, number, 'start' | 'end']> = right.map(([dx, dy]) => [-dx, dy, 'end'])
    const order = r.prefer === 'left' ? [...left, ...right] : [...right, ...left]

    let best: PlacedLabel | null = null
    let bestCost = Infinity
    for (const [dx, dy, anchor] of order) {
      const x = r.x + dx
      const y = r.y + dy
      const box: Box = anchor === 'start'
        ? { x0: x, y0: y - 0.8 * h, x1: x + w, y1: y + 0.25 * h }
        : { x0: x - w, y0: y - 0.8 * h, x1: x, y1: y + 0.25 * h }
      // Off the drawing area counts as a heavy overlap.
      const outside = Math.max(0, b.x0 - box.x0) + Math.max(0, box.x1 - b.x1) + Math.max(0, b.y0 - box.y0) + Math.max(0, box.y1 - b.y1)
      const cost = taken.reduce((s, t) => s + area(box, t), 0) + outside * h * 4
      if (cost < bestCost) {
        bestCost = cost
        best = { id: r.id, text: r.text, x, y, anchor, box, className: r.className, color: r.color, title: r.title }
        if (cost === 0) break
      }
    }
    if (best) {
      out.push(best)
      taken.push(best.box)
    }
  }
  return out
}

/** A small square around a point (dots, markers), as an obstacle. */
export const around = (x: number, y: number, r: number): Box => ({ x0: x - r, y0: y - r, x1: x + r, y1: y + r })
