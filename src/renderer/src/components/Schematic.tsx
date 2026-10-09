import { ELEMENT_LABEL, isShunt, type NetworkElement } from '@shared/rf/network'
import { useStudio, valuesCovered } from '@/state/studio'
import { PATH_COLORS } from '@/chart/StudioChart'
import { loadText, partText, SCH, schematicCells } from '@/lib/schematic'

const MID = (SCH.top + SCH.rail) / 2

/** A coil, plates or a zig-zag from (x1, y1) to (x2, y2), horizontal or vertical. */
function symbolPath(kind: 'L' | 'C' | 'R', x1: number, y1: number, x2: number, y2: number): string {
  const vertical = x1 === x2
  const len = vertical ? y2 - y1 : x2 - x1
  const at = (t: number, off: number) => (vertical ? `${x1 + off} ${y1 + t}` : `${x1 + t} ${y1 + off}`)
  if (kind === 'L') {
    // Four loops along the wire.
    const r = len / 8
    let d = `M ${at(0, 0)}`
    for (let k = 0; k < 4; k++) d += ` A ${r} ${r} 0 0 1 ${at((k + 1) * 2 * r, 0)}`
    return d
  }
  if (kind === 'R') {
    let d = `M ${at(0, 0)}`
    const n = 6
    for (let k = 0; k < n; k++) d += ` L ${at((len * (k + 0.5)) / n, k % 2 ? 5 : -5)}`
    return `${d} L ${at(len, 0)}`
  }
  // Two plates across the wire, with the gap in the middle.
  const m = len / 2
  return `M ${at(0, 0)} L ${at(m - 3, 0)} M ${at(m - 3, -9)} L ${at(m - 3, 9)} M ${at(m + 3, -9)} L ${at(m + 3, 9)} M ${at(m + 3, 0)} L ${at(len, 0)}`
}

const lumped = (k: NetworkElement['kind']): 'L' | 'C' | 'R' | null => (k.endsWith('L') ? 'L' : k.endsWith('C') ? 'C' : k.endsWith('R') ? 'R' : null)

function Part({ el, x }: { el: NetworkElement; x: number }) {
  const cx = x + SCH.part / 2
  const k = lumped(el.kind)
  if (!isShunt(el.kind)) {
    // In the signal wire: wire in, the part, wire out.
    const a = cx - 16, b = cx + 16
    return (
      <>
        <path d={`M ${x} ${SCH.top} L ${a} ${SCH.top} M ${b} ${SCH.top} L ${x + SCH.part} ${SCH.top}`} className="sch-wire" />
        {k ? <path d={symbolPath(k, a, SCH.top, b, SCH.top)} /> : (
          // A line section: a cylinder in the wire.
          <>
            <rect x={a - 2} y={SCH.top - 7} width={36} height={14} rx={7} />
            <path d={`M ${a + 5} ${SCH.top} L ${b - 5} ${SCH.top}`} className="sch-thin" />
          </>
        )}
        <path d={`M ${x} ${SCH.rail} L ${x + SCH.part} ${SCH.rail}`} className="sch-wire" />
      </>
    )
  }
  // To ground: a branch off the signal wire.
  const y1 = SCH.top + 14, y2 = SCH.rail - 14
  const stub = el.kind === 'openStub' || el.kind === 'shortStub'
  return (
    <>
      <path d={`M ${x} ${SCH.top} L ${x + SCH.part} ${SCH.top} M ${x} ${SCH.rail} L ${x + SCH.part} ${SCH.rail}`} className="sch-wire" />
      <circle cx={cx} cy={SCH.top} r={2.5} className="sch-dot" />
      {k ? (
        <path d={`M ${cx} ${SCH.top} L ${cx} ${y1} ${symbolPath(k, cx, y1, cx, y2)} M ${cx} ${y2} L ${cx} ${SCH.rail}`} />
      ) : stub ? (
        <>
          <path d={`M ${cx} ${SCH.top} L ${cx} ${y1 - 4}`} />
          <rect x={cx - 7} y={y1 - 4} width={14} height={y2 - y1 + 2} rx={7} />
          {el.kind === 'shortStub'
            ? <path d={`M ${cx} ${y2 - 2} L ${cx} ${SCH.rail}`} />
            // An open end: it stops short of the ground rail (a bar there would read as a ground symbol).
            : <text x={cx} y={y2 + 9} className="sch-open">open</text>}
        </>
      ) : null}
    </>
  )
}

/**
 * The matching network as a circuit: the source on the left, each part with its value and its
 * number (the list's number, in the colour of its step on the chart), the load on the right.
 * Hovering a part lights up its step on the chart; clicking it finds it in the list.
 */
export function Schematic({ compact = false }: { compact?: boolean }) {
  const network = useStudio((s) => s.network)
  const z0 = useStudio((s) => s.z0)
  const load = useStudio((s) => s.load)
  const datasets = useStudio((s) => s.datasets)
  const hover = useStudio((s) => s.hoverElement)
  const covered = useStudio(valuesCovered)
  const { cells, width } = schematicCells(network.length)
  const lt = loadText(load, datasets, covered)
  const setHover = (i: number | null) => useStudio.getState().setHoverElement(i)
  const find = (id: string) => {
    const li = document.getElementById(`net-el-${id}`)
    if (!li) return
    li.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    li.classList.remove('flash')
    void li.offsetWidth // restart the animation
    li.classList.add('flash')
  }
  const said = ['Source', ...[...network].reverse().map((e) => `${ELEMENT_LABEL[e.kind]} ${partText(e).join(', ')}`), lt.join(' ')].join(' → ')

  return (
    <div className={`schematic${compact ? ' compact' : ''}`}>
      <svg viewBox={`0 0 ${width} ${SCH.height}`} width={width} style={{ minWidth: width * 0.7, maxWidth: width * 1.15 }} role="img" aria-label={`Circuit, source to load: ${said}`}>
        {cells.map((c) => {
          if (c.kind === 'source') {
            const cx = c.x + SCH.source / 2
            return (
              <g key="src" className="sch-part">
                <path d={`M ${cx} ${SCH.top} L ${c.x + SCH.source} ${SCH.top} M ${cx} ${SCH.top} L ${cx} ${MID - 12} M ${cx} ${MID + 12} L ${cx} ${SCH.rail} L ${c.x + SCH.source} ${SCH.rail}`} />
                <circle cx={cx} cy={MID} r={12} />
                <path d={`M ${cx - 7} ${MID} q 3.5 -7 7 0 t 7 0`} className="sch-thin" />
                <text x={cx} y={SCH.badge + 4} className="sch-name">Source</text>
                <text x={cx} y={SCH.value} className="sch-val">Z0 {z0} Ω</text>
              </g>
            )
          }
          if (c.kind === 'load') {
            const cx = c.x + SCH.load / 2
            return (
              <g key="load" className="sch-part">
                <path d={`M ${c.x} ${SCH.top} L ${cx} ${SCH.top} L ${cx} ${SCH.top + 12} M ${cx} ${SCH.rail - 12} L ${cx} ${SCH.rail} L ${c.x} ${SCH.rail}`} />
                <rect x={cx - 14} y={SCH.top + 12} width={28} height={SCH.rail - SCH.top - 24} rx={2} />
                <text x={cx} y={MID + 4} className="sch-name">Z<tspan dy={3} fontSize={7}>L</tspan></text>
                <text x={cx} y={SCH.badge + 4} className="sch-name">{lt[0]}</text>
                {lt[1] && <text x={cx} y={SCH.value} className="sch-val">{lt[1]}</text>}
              </g>
            )
          }
          const el = network[c.index!]
          const color = PATH_COLORS[c.index! % PATH_COLORS.length]
          const cx = c.x + SCH.part / 2
          const lines = partText(el)
          return (
            <g
              key={el.id}
              className={`sch-part sch-el${hover === null ? '' : hover === c.index ? ' hl' : ' dim'}`}
              style={{ color }}
              onMouseEnter={() => setHover(c.index!)}
              onMouseLeave={() => setHover(null)}
              onClick={() => find(el.id)}
            >
              <title>{`${c.index! + 1}. ${ELEMENT_LABEL[el.kind]} ${lines.join(', ')}: step ${c.index! + 1} on the chart`}</title>
              {/* A wide invisible target, easier to hover than the thin lines. */}
              <rect x={c.x} y={0} width={SCH.part} height={SCH.height} className="sch-hit" />
              <Part el={el} x={c.x} />
              <circle cx={cx} cy={SCH.badge} r={8} className="sch-badge" />
              <text x={cx} y={SCH.badge + 3.5} className="sch-num">{c.index! + 1}</text>
              {lines.map((t, j) => <text key={j} x={cx} y={SCH.value + j * 11} className="sch-val">{t}</text>)}
            </g>
          )
        })}
      </svg>
    </div>
  )
}
