import { describe, expect, it, vi } from 'vitest'
import { loadText, partText, SCH, schematicCells } from './schematic'

vi.stubGlobal('window', { addEventListener: () => {} })
const { useStudio, DEFAULT_SNAPSHOT } = await import('@/state/studio')

describe('the circuit drawing: source on the left, load on the right', () => {
  it('draws the network in reverse of its load → source order, so the part next to the load is rightmost', () => {
    const { cells, width } = schematicCells(3)
    expect(cells.map((c) => c.kind)).toEqual(['source', 'part', 'part', 'part', 'load'])
    // Next to the source: the last part added (index 2); next to the load: the first (index 0).
    expect(cells.filter((c) => c.kind === 'part').map((c) => c.index)).toEqual([2, 1, 0])
    expect(width).toBe(SCH.source + 3 * SCH.part + SCH.load)
    // Cells touch end to end, left to right.
    for (let i = 1; i < cells.length; i++) expect(cells[i].x).toBeGreaterThan(cells[i - 1].x)
    expect(schematicCells(0).cells.map((c) => c.kind)).toEqual(['source', 'load'])
  })

  it('labels each part with its size, and a line or stub with its length and Zc', () => {
    expect(partText({ id: 'a', kind: 'seriesL', value: 3.3e-9 })).toEqual(['3.3 nH'])
    expect(partText({ id: 'b', kind: 'shuntC', value: 1.2e-12 })).toEqual(['1.2 pF'])
    expect(partText({ id: 'c', kind: 'seriesR', value: 10 })).toEqual(['10 Ω'])
    expect(partText({ id: 'd', kind: 'tline', value: 45, zc: 70.7 })).toEqual(['45°', '70.7 Ω'])
    expect(partText({ id: 'e', kind: 'openStub', value: 30 })).toEqual(['30°', '50 Ω'])
  })

  it('names the load by its kind; a fixed one shows its Z, unless a reading question covers the values', () => {
    expect(loadText({ kind: 'fixed', R: 30, X: -20 }, [])).toEqual(['Load', '30 − j20 Ω'])
    expect(loadText({ kind: 'fixed', R: 30, X: -20 }, [], true)).toEqual(['Load'])
    expect(loadText({ kind: 'antenna', topology: 'parallel', f0: 2.44e9, R: 40, Q: 8 }, [])).toEqual(['Antenna', '2.44 GHz'])
    expect(loadText({ kind: 'data', datasetId: 'x' }, [{ id: 'x', name: 'patch_antenna_v3.s1p' } as never])).toEqual(['Data', 'patch_anten…'])
  })
})

describe('pointing at a part lights up its step on the chart', () => {
  it('is cleared when parts go away, so no step stays lit for a part that is gone', () => {
    const st = useStudio.getState
    st().loadSnapshot({ ...DEFAULT_SNAPSHOT })
    const a = st().addElement('seriesL', 3e-9)
    st().addElement('shuntC', 1e-12)
    st().setHoverElement(1)
    expect(st().hoverElement).toBe(1)
    st().removeElement(a.id)
    expect(st().hoverElement).toBeNull()
    st().setHoverElement(0)
    st().set('network', [])
    expect(st().hoverElement).toBeNull()
    st().setHoverElement(0)
    st().clearNetwork()
    expect(st().hoverElement).toBeNull()
    st().setHoverElement(0)
    st().loadSnapshot({ ...DEFAULT_SNAPSHOT })
    expect(st().hoverElement).toBeNull()
  })
})
