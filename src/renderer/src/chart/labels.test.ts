import { describe, expect, it } from 'vitest'
import { around, mergeCoincident, placeLabels, type Box } from './labels'

const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

describe('chart label placement', () => {
  it('separates labels that share an anchor (point at the centre + arrow from it)', () => {
    const placed = placeLabels(
      [
        { id: 'a', text: 'centre (z = 1, matched)', x: 0, y: 0, size: 0.036 },
        { id: 'b', text: 'distance from centre', x: 0, y: 0, size: 0.036 }
      ],
      [],
      1.24
    )
    expect(placed).toHaveLength(2)
    expect(overlap(placed[0].box, placed[1].box)).toBe(false)
  })

  it('moves a label off a dot and keeps it inside the chart', () => {
    const dot = around(0.05, -0.05, 0.03)
    const [p] = placeLabels([{ id: 'a', text: 'load', x: 0, y: 0, size: 0.036 }], [dot], 1.24)
    expect(overlap(p.box, dot)).toBe(false)
    const [edge] = placeLabels([{ id: 'e', text: 'a long label near the open circuit', x: 1, y: 0, size: 0.036 }], [], 1.24)
    expect(edge.box.x1).toBeLessThanOrEqual(1.24)
  })

  it('gives coincident points one shared label (a marker at the design frequency)', () => {
    const groups = mergeCoincident(
      [
        { x: 0.1, y: 0.2, label: 'M1' }, // load marker
        { x: 0.3, y: -0.1, label: 'M1' }, // input marker
        { x: 0.3005, y: -0.1, label: 'IN' }, // design input, same spot
        { x: 0.1, y: 0.2005, label: 'L' } // design load, same spot
      ],
      0.02
    )
    expect(groups.map((g) => g.labels.join(' · '))).toEqual(['M1 · L', 'M1 · IN'])
  })

  it('keeps labels inside a zoomed-in view', () => {
    const view = { x0: 0.2, y0: -0.2, x1: 0.5, y1: 0.1 }
    const [p] = placeLabels([{ id: 'a', text: 'a fairly long label', x: 0.48, y: -0.05, size: 0.01 }], [], view)
    expect(p.box.x1).toBeLessThanOrEqual(view.x1)
  })
})
