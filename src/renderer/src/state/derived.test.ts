import { describe, expect, it } from 'vitest'
import { computeDerived, resultRows } from './derived'
import { DEFAULT_SNAPSHOT } from './studio'

describe('results table rows', () => {
  const d = computeDerived({ ...DEFAULT_SNAPSHOT, load: { kind: 'fixed', R: 30, X: 20 } })

  it('single frequency: just the design frequency, never the markers', () => {
    const rows = resultRows(d, false)
    expect(rows.map((r) => r.name)).toEqual(['Design'])
    expect(rows[0].f).toBe(2.4e9)
    expect(rows[0].load.vswr).toBeCloseTo(2.04, 2)
  })

  it('with the band: the design frequency first, then each marker', () => {
    const rows = resultRows(d, true)
    expect(rows.map((r) => `${r.name} ${r.f / 1e9}`)).toEqual(['Design 2.4', 'M1 2.4', 'M2 2.5'])
  })
})
