import { Complex, c, div, polar, rad, scale, add, sub, ONE } from './complex'
import { gammaFromZ } from './metrics'
import type { Dataset } from './network'

const UNIT_SCALE: Record<string, number> = { hz: 1, khz: 1e3, mhz: 1e6, ghz: 1e9, thz: 1e12 }

export class ImportError extends Error {}

let idCounter = 0
const newId = () => `ds_${Date.now().toString(36)}_${(idCounter++).toString(36)}`

/** Picks the right parser from the file name / content. */
export function importFile(fileName: string, text: string, opts: { port?: number } = {}): Dataset[] {
  const m = /\.s(\d+)p$/i.exec(fileName)
  if (m) return [parseTouchstone(text, { name: fileName, nPorts: Number(m[1]), port: opts.port })]
  if (/^\s*#\s*(hz|khz|mhz|ghz|thz)\b/im.test(text) && !/frequency\s*\//i.test(text)) {
    return [parseTouchstone(text, { name: fileName, nPorts: 1, port: opts.port })]
  }
  return parseCstAscii(text, fileName)
}

// ---------------------------------------------------------------------------
// Touchstone (v1 and the common subset of v2)
// ---------------------------------------------------------------------------

export function parseTouchstone(
  text: string,
  opts: { name: string; nPorts?: number; port?: number }
): Dataset {
  let unit = 1e9
  let param = 'S'
  let format = 'MA'
  let ref = 50
  let nPorts = opts.nPorts ?? 1
  const tokens: number[] = []
  let sawOption = false

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/!.*$/, '').trim()
    if (!line) continue
    if (line.startsWith('[')) {
      const np = /^\[number of ports\]\s+(\d+)/i.exec(line)
      if (np) nPorts = Number(np[1])
      continue
    }
    if (line.startsWith('#')) {
      if (sawOption) continue
      sawOption = true
      const parts = line.slice(1).trim().split(/\s+/)
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i].toLowerCase()
        if (p in UNIT_SCALE) unit = UNIT_SCALE[p]
        else if (['s', 'y', 'z', 'h', 'g'].includes(p)) param = p.toUpperCase()
        else if (['db', 'ma', 'ri'].includes(p)) format = p.toUpperCase()
        else if (p === 'r' && parts[i + 1]) ref = Number(parts[++i])
      }
      continue
    }
    for (const t of line.split(/[\s,]+/)) {
      const v = Number(t)
      if (!Number.isFinite(v)) throw new ImportError(`Unexpected token "${t}" in Touchstone data`)
      tokens.push(v)
    }
  }

  if (param !== 'S' && param !== 'Z' && param !== 'Y') {
    throw new ImportError(`${param}-parameters are not supported (use S, Z or Y)`)
  }
  const perRow = 1 + 2 * nPorts * nPorts
  if (tokens.length < perRow) throw new ImportError('No data rows found in the Touchstone file')
  if (tokens.length % perRow !== 0) {
    throw new ImportError(`Data length doesn't match a ${nPorts}-port file (${perRow} numbers per frequency)`)
  }

  const port = Math.min(Math.max(opts.port ?? 1, 1), nPorts)
  // Index of S(port,port) within a row. 2-port v1 order is 11 21 12 22; otherwise row-major.
  const idx = nPorts === 2 ? (port === 1 ? 0 : 3) : (port - 1) * nPorts + (port - 1)

  const freqs: number[] = []
  const gamma: Complex[] = []
  for (let r = 0; r < tokens.length; r += perRow) {
    freqs.push(tokens[r] * unit)
    const a = tokens[r + 1 + idx * 2]
    const b = tokens[r + 2 + idx * 2]
    let v: Complex
    if (format === 'RI') v = c(a, b)
    else if (format === 'MA') v = polar(a, rad(b))
    else v = polar(Math.pow(10, a / 20), rad(b))

    if (param === 'S') gamma.push(v)
    else if (param === 'Z') gamma.push(gammaFromZ(scale(v, ref), ref))
    else gamma.push(gammaFromZ(div(ONE, scale(v, 1 / ref)), ref))
  }

  const notes: string[] = []
  if (nPorts > 1) notes.push(`${nPorts}-port file: using S${port}${port} (other ports assumed matched).`)
  if (param !== 'S') notes.push(`Converted ${param}-parameters to reflection coefficient.`)

  return {
    id: newId(),
    name: opts.name,
    source: `Touchstone (${nPorts}-port, ${param}/${format})`,
    z0: ref,
    freqs,
    gamma,
    notes
  }
}

// ---------------------------------------------------------------------------
// CST "Export → Plot Data (ASCII)" text files
// ---------------------------------------------------------------------------

export type CstColumnFormat = 'reim' | 'magPhaseDeg' | 'dbPhaseDeg' | 'magPhaseRad' | 'zReIm'

interface Block {
  header: string[]
  rows: number[][]
}

function detectUnit(header: string): number {
  const m = /(thz|ghz|mhz|khz|hz)/i.exec(header)
  return m ? UNIT_SCALE[m[1].toLowerCase()] : 1e9
}

function detectFormat(header: string, rows: number[][]): CstColumnFormat | null {
  const h = header.toLowerCase()
  const isZ = /\bz\s*[,(]?\s*1\s*,?\s*1\b|impedance/.test(h)
  if (/\bre\b|real|re\(/.test(h) && /\bim\b|imag|im\(/.test(h)) return isZ ? 'zReIm' : 'reim'
  const hasPhase = /arg|phase|degree|\bdeg\b|\brad\b/.test(h)
  if (/db/.test(h) && hasPhase) return 'dbPhaseDeg'
  if (/(abs|mag|lin)/.test(h) && hasPhase) return /\brad/.test(h) ? 'magPhaseRad' : 'magPhaseDeg'

  // No usable header: guess from the numbers.
  if (rows.length === 0 || rows[0].length < 3) return null
  const col2 = rows.map((r) => r[1])
  const col3 = rows.map((r) => r[2])
  const maxAbs3 = Math.max(...col3.map(Math.abs))
  if (maxAbs3 > Math.PI + 0.01) {
    return col2.some((v) => v < 0) ? 'dbPhaseDeg' : 'magPhaseDeg'
  }
  return 'reim'
}

/**
 * Parse a CST ASCII export. A file may contain several blocks (e.g. a parameter
 * sweep); each becomes its own dataset. Pass `format` to override detection.
 */
export function parseCstAscii(text: string, name: string, format?: CstColumnFormat, z0 = 50): Dataset[] {
  const blocks: Block[] = []
  let cur: Block | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^[-=#\s]+$/.test(line)) continue
    const nums = line.split(/[\s,;]+/).map(Number)
    if (nums.every((n) => Number.isFinite(n))) {
      if (!cur) {
        cur = { header: [], rows: [] }
        blocks.push(cur)
      }
      cur.rows.push(nums)
    } else {
      if (!cur || cur.rows.length > 0) {
        cur = { header: [], rows: [] }
        blocks.push(cur)
      }
      cur.header.push(line)
    }
  }

  const datasets: Dataset[] = []
  const usable = blocks.filter((b) => b.rows.length > 0)
  if (usable.length === 0) throw new ImportError('No numeric data found in the file')

  usable.forEach((b, i) => {
    const header = b.header.join(' ')
    if (b.rows[0].length < 3) {
      throw new ImportError(
        'Only one data column found (magnitude without phase). A Smith chart needs complex data: ' +
          'in CST export S1,1 as Real/Imag (or Magnitude + Phase), or use Post-Processing → Touchstone export.'
      )
    }
    const fmt = format ?? detectFormat(header, b.rows)
    if (!fmt) throw new ImportError('Could not work out the column format; choose it manually.')
    const unit = detectUnit(header)
    const freqs: number[] = []
    const gamma: Complex[] = []
    for (const r of b.rows) {
      freqs.push(r[0] * unit)
      const [a, bb] = [r[1], r[2]]
      switch (fmt) {
        case 'reim': gamma.push(c(a, bb)); break
        case 'magPhaseDeg': gamma.push(polar(a, rad(bb))); break
        case 'magPhaseRad': gamma.push(polar(a, bb)); break
        case 'dbPhaseDeg': gamma.push(polar(Math.pow(10, a / 20), rad(bb))); break
        case 'zReIm': gamma.push(div(sub(c(a, bb), c(z0)), add(c(a, bb), c(z0)))); break
      }
    }
    const label = b.header.find((h) => /[a-z]/i.test(h))?.replace(/["#]/g, '').trim()
    datasets.push({
      id: newId(),
      name: usable.length > 1 ? `${name} [${i + 1}]${label ? ' ' + label.slice(0, 40) : ''}` : name,
      source: `CST ASCII (${fmt})`,
      z0,
      freqs,
      gamma,
      notes: [`Detected columns as ${fmt}; frequency unit ×${unit}. Change the format if the trace looks wrong.`]
    })
  })
  return datasets
}
