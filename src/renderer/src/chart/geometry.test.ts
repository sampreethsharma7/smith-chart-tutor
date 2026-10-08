import { describe, expect, it } from 'vitest'
import { arrowAlong, backAlong } from './geometry'

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('arrowheads that stay visible next to the new point', () => {
  const line = [{ x: 0, y: 0 }, { x: 0.5, y: 0 }, { x: 1, y: 0 }]

  it('walks back along a polyline, across segments', () => {
    expect(backAlong(line, 0.25)).toEqual({ x: 0.75, y: 0 })
    expect(backAlong(line, 0.75)).toEqual({ x: 0.25, y: 0 })
    expect(backAlong(line, 5)).toEqual({ x: 0, y: 0 })
  })

  it('the tip stops at the edge of the dot at the end, pointing along the path', () => {
    const gap = 0.024 // IN dot radius plus its ring
    const [tip, l, r] = arrowAlong(line, gap, 0.03, 0.015)!
    expect(dist(tip, { x: 1, y: 0 })).toBeCloseTo(gap)
    expect(l.x).toBeCloseTo(1 - gap - 0.03)
    expect(r.x).toBeCloseTo(1 - gap - 0.03)
    expect(Math.abs(l.y - r.y)).toBeCloseTo(0.03) // symmetric about the path
  })

  it('follows a curved path at its end (the arc of a constant-r circle)', () => {
    const arc = Array.from({ length: 50 }, (_, i) => ({ x: Math.cos((i / 49) * Math.PI / 2), y: Math.sin((i / 49) * Math.PI / 2) }))
    const [tip, l, r] = arrowAlong(arc, 0.02, 0.03, 0.015)!
    expect(Math.hypot(tip.x, tip.y)).toBeCloseTo(1, 3) // on the arc
    const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 }
    expect(mid.y).toBeLessThan(tip.y) // pointing toward the end (0, 1)
  })

  it('a path too short for an arrowhead gets none (rather than one poking out backwards)', () => {
    expect(arrowAlong([{ x: 0, y: 0 }, { x: 0.02, y: 0 }], 0.024, 0.03, 0.015)).toBeNull()
    expect(arrowAlong([{ x: 0, y: 0 }], 0, 0.03, 0.015)).toBeNull()
  })
})
