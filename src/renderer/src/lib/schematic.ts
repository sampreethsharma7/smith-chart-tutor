import type { Dataset, LoadModel, NetworkElement } from '@shared/rf/network'
import { fmtEng, fmtHz, fmtNum } from './format'

/**
 * The circuit drawing of the matching network, laid out the way circuits are read: the source on the
 * left, the load on the right. The network is stored load → source, so element i (1 = next to the
 * load) is drawn i-th from the right. Two rails: the signal wire on top, ground underneath.
 */
export const SCH = {
  /** Width of the source, of each part, and of the load */
  source: 44, part: 54, load: 62,
  /** The signal wire, the ground rail, and the label rows above and below */
  top: 30, rail: 92, badge: 12, value: 108, height: 128
} as const

export interface Cell {
  kind: 'source' | 'part' | 'load'
  /** Left edge */
  x: number
  /** Parts: index in the network (0 = next to the load) */
  index?: number
}

/** Where everything goes, source first. */
export function schematicCells(n: number): { cells: Cell[]; width: number } {
  const cells: Cell[] = [{ kind: 'source', x: 0 }]
  let x: number = SCH.source
  for (let k = 0; k < n; k++) {
    cells.push({ kind: 'part', x, index: n - 1 - k })
    x += SCH.part
  }
  cells.push({ kind: 'load', x })
  return { cells, width: x + SCH.load }
}

const deg = (v: number) => `${fmtNum(v, 3)}°`

/** The value under a part: its size, or for a line or stub its length and Zc. */
export function partText(el: NetworkElement): string[] {
  switch (el.kind) {
    case 'seriesL': case 'shuntL': return [fmtEng(el.value, 'H')]
    case 'seriesC': case 'shuntC': return [fmtEng(el.value, 'F')]
    case 'seriesR': case 'shuntR': return [fmtEng(el.value, 'Ω')]
    default: return [deg(el.value), `${fmtNum(el.zc ?? 50, 3)} Ω`]
  }
}

/** What the load box says: what kind of load it is, and its value when that's short. */
export function loadText(load: LoadModel, datasets: Dataset[], hideZ = false): string[] {
  switch (load.kind) {
    // A reading question with the values covered: the box doesn't give the impedance away.
    case 'fixed': return hideZ ? ['Load'] : ['Load', `${fmtNum(load.R, 3)} ${load.X < 0 ? '−' : '+'} j${fmtNum(Math.abs(load.X), 3)} Ω`]
    case 'seriesRLC': return ['Series RLC', `R ${fmtNum(load.R, 3)} Ω`]
    case 'parallelRLC': return ['Parallel RLC', `R ${fmtNum(load.R, 3)} Ω`]
    case 'antenna': return ['Antenna', fmtHz(load.f0, 3)]
    case 'data': {
      const name = datasets.find((d) => d.id === load.datasetId)?.name ?? 'data'
      return ['Data', name.length > 12 ? `${name.slice(0, 11)}…` : name]
    }
  }
}
