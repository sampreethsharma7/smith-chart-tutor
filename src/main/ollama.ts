/**
 * A free local tutor with Ollama, set up from the app with no admin rights:
 * find an existing Ollama or install the official standalone build into the user's
 * local app-data folder (checksum-verified), run it while the app runs, download the
 * recommended model, and measure how it runs on this machine.
 *
 * Downloads go through Electron's network stack, so the system proxy and the
 * company's certificates apply, as in a browser.
 */
import { net } from 'electron'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, promises as fs } from 'node:fs'
import { once } from 'node:events'
import { cpus, homedir, totalmem } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createZstdDecompress } from 'node:zlib'
import type { MachineInfo, OllamaStatus, SetupProgress, SpeedResult } from '@shared/localModels'

// Dev aids: a second Ollama on another port and folder, so the install can be tested beside a real one.
const PORT = Number(process.env.SMITH_OLLAMA_PORT) || 11434
const API = `http://127.0.0.1:${PORT}`
const RELEASES = 'https://github.com/ollama/ollama/releases/latest/download/'
const EXE = process.platform === 'win32' ? 'ollama.exe' : 'ollama'

/** The official standalone build for this OS and processor (the NVIDIA-capable one on Windows and Linux). */
const ASSETS: Record<string, string> = {
  'win32-x64': 'ollama-windows-amd64.zip',
  'win32-arm64': 'ollama-windows-arm64.zip',
  'darwin-x64': 'ollama-darwin.tgz',
  'darwin-arm64': 'ollama-darwin.tgz',
  'linux-x64': 'ollama-linux-amd64.tar.zst',
  'linux-arm64': 'ollama-linux-arm64.tar.zst'
}

/** Where the app's own copy goes: the local (not roaming) per-user app-data folder. */
export function managedDir(): string {
  if (process.env.SMITH_OLLAMA_DIR) return process.env.SMITH_OLLAMA_DIR
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'SmithChartTutor', 'ollama')
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'SmithChartTutor', 'ollama')
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'SmithChartTutor', 'ollama')
}

// ── What this machine has ──────────────────────────────────────────────────────

function run(cmd: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, out) => (err ? reject(err) : resolve(String(out))))
  )
}

export async function probeMachine(): Promise<MachineInfo> {
  const ramGB = totalmem() / 2 ** 30
  const cpu = cpus()[0]?.model.trim() ?? 'unknown processor'
  const m: MachineInfo = { platform: process.platform, arch: process.arch, ramGB, cpu }
  if (process.platform === 'darwin' && process.arch === 'arm64') {
    m.gpu = { name: /Apple/.test(cpu) ? cpu : 'Apple Silicon', kind: 'apple', memoryGB: ramGB }
    return m
  }
  // NVIDIA: the driver's nvidia-smi reports each GPU's memory (no admin needed).
  for (const cmd of ['nvidia-smi', ...(process.platform === 'win32' ? ['C:\\Windows\\System32\\nvidia-smi.exe'] : [])]) {
    try {
      const rows = (await run(cmd, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']))
        .split('\n').map((l) => l.split(',').map((x) => x.trim())).filter((r) => r.length === 2 && Number(r[1]) > 0)
      const best = rows.sort((a, b) => Number(b[1]) - Number(a[1]))[0]
      if (best) m.gpu = { name: best[0].replace(/^NVIDIA (GeForce )?/, ''), kind: 'nvidia', memoryGB: Number(best[1]) / 1024 }
      break
    } catch {
      // not there: try the next, or no NVIDIA GPU
    }
  }
  return m
}

// ── Finding Ollama ─────────────────────────────────────────────────────────────

async function getJson<T>(path: string, timeoutMs: number): Promise<T> {
  const r = await net.fetch(API + path, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return (await r.json()) as T
}

async function findExe(dir: string, depth = 2): Promise<string | null> {
  if (!existsSync(dir)) return null
  const direct = join(dir, EXE)
  if (existsSync(direct)) return direct
  if (depth === 0) return null
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) {
      const f = await findExe(join(dir, e.name), depth - 1)
      if (f) return f
    }
  }
  return null
}

/** An Ollama already on this machine: the app's own copy, a normal install, or one on PATH. */
async function locateBinary(): Promise<string | null> {
  const own = await findExe(managedDir())
  if (own) return own
  // Testing a fresh install beside a real Ollama: look nowhere else.
  if (process.env.SMITH_OLLAMA_DIR) return null
  const home = homedir()
  const known =
    process.platform === 'win32' ? [join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Programs', 'Ollama', EXE)]
    : process.platform === 'darwin' ? ['/Applications/Ollama.app/Contents/Resources/ollama', join(home, 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'), '/opt/homebrew/bin/ollama', '/usr/local/bin/ollama']
    : ['/usr/local/bin/ollama', '/usr/bin/ollama']
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((d) => join(d, EXE))
  return [...known, ...onPath].find((p) => existsSync(p)) ?? null
}

export async function ollamaStatus(): Promise<OllamaStatus> {
  const version = await getJson<{ version: string }>('/api/version', 1500).then((j) => j.version, () => null)
  const models = version ? await getJson<{ models: Array<{ name: string }> }>('/api/tags', 4000).then((j) => j.models.map((m) => m.name), () => []) : []
  const binary = await locateBinary()
  return { running: !!version, version, models, binary, managed: !!binary && binary.startsWith(managedDir()), apiBase: `http://localhost:${PORT}/v1` }
}

// ── Installing the app's own copy ──────────────────────────────────────────────

export type Progress = (p: SetupProgress) => void

const GB = 2 ** 30
const fmtGB = (b: number) => `${(b / GB).toFixed(b < 10 * GB ? 1 : 0)} GB`

async function freeBytes(dir: string): Promise<number> {
  let d = dir
  while (!existsSync(d) && dirname(d) !== d) d = dirname(d)
  try {
    const s = await fs.statfs(d)
    return s.bavail * s.bsize
  } catch {
    return Infinity // can't tell: don't block
  }
}

/** Download to a file, hashing as it goes; progress is reported at most every 250 ms. */
async function download(url: string, file: string, signal: AbortSignal, onBytes: (done: number, total: number) => void): Promise<string> {
  const res = await net.fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status}) from ${new URL(url).host}.`)
  const total = Number(res.headers.get('content-length')) || 0
  const free = await freeBytes(dirname(file))
  // The download and its unpacked files sit side by side for a moment.
  if (total && free < total * 2.3) throw new Error(`Not enough free disk space: this needs about ${fmtGB(total * 2.3)}, and ${fmtGB(free)} is free.`)
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  const reader = res.body.getReader()
  let done = 0
  let last = 0
  try {
    for (;;) {
      const { done: end, value } = await reader.read()
      if (end) break
      hash.update(value)
      if (!out.write(value)) await once(out, 'drain')
      done += value.length
      if (Date.now() - last > 250) { last = Date.now(); onBytes(done, total) }
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  onBytes(done, total)
  return hash.digest('hex')
}

function runTool(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed: ${err.trim().slice(0, 300)}`))))
  })
}

async function extract(file: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true })
  if (file.endsWith('.zip')) {
    // Windows 10 and later include tar (bsdtar), which unpacks zip files.
    await runTool(process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'unzip', process.platform === 'win32' ? ['-xf', file, '-C', dest] : ['-q', file, '-d', dest])
  } else if (file.endsWith('.tgz')) {
    await runTool('tar', ['-xzf', file, '-C', dest])
  } else {
    // .tar.zst: Node decompresses, the system tar unpacks.
    const tar = spawn('tar', ['-x', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] })
    const exited = new Promise<void>((resolve, reject) => {
      tar.on('error', reject)
      tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar failed (${code})`))))
    })
    await pipeline(createReadStream(file), createZstdDecompress(), tar.stdin)
    await exited
  }
}

export async function installOllama(progress: Progress, signal: AbortSignal): Promise<string> {
  const asset = ASSETS[`${process.platform}-${process.arch}`]
  if (!asset) throw new Error(`Ollama has no build for ${process.platform} ${process.arch}.`)
  const dir = managedDir()
  const work = `${dir}.download`
  await fs.rm(work, { recursive: true, force: true })
  await fs.mkdir(work, { recursive: true })
  try {
    progress({ step: 'install', text: 'Checking the latest Ollama release…' })
    const sums = await (await net.fetch(RELEASES + 'sha256sum.txt', { signal })).text()
    const expected = sums.split('\n').map((l) => l.trim().split(/\s+/)).find(([, name]) => name === `./${asset}` || name === asset)?.[0]
    if (!expected) throw new Error('Could not find the checksum for the Ollama download.')
    const file = join(work, asset)
    const got = await download(RELEASES + asset, file, signal, (done, total) =>
      progress({ step: 'install', text: `Downloading Ollama: ${fmtGB(done)}${total ? ` of ${fmtGB(total)}` : ''}`, fraction: total ? done / total : undefined }))
    if (got !== expected) throw new Error('The Ollama download did not match its published checksum, so it was not used. Try again.')
    progress({ step: 'install', text: 'Unpacking Ollama…' })
    const unpacked = join(work, 'unpacked')
    await extract(file, unpacked)
    if (!(await findExe(unpacked))) throw new Error('The Ollama download did not contain the program.')
    await fs.rm(dir, { recursive: true, force: true })
    await fs.rename(unpacked, dir)
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {})
  }
  const exe = await findExe(dir)
  if (!exe) throw new Error('Ollama was unpacked but its program is missing.')
  return exe
}

// ── Running it ─────────────────────────────────────────────────────────────────

let served: ChildProcess | null = null

const isUp = () => getJson('/api/version', 1500).then(() => true, () => false)

/** Start `ollama serve` if nothing answers yet; it runs while the app runs. */
export async function startOllama(binary: string): Promise<void> {
  if (await isUp()) return
  const p = spawn(binary, ['serve'], { env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${PORT}` }, windowsHide: true, stdio: 'ignore' })
  served = p
  let failed: Error | null = null
  p.on('error', (e) => (failed = e))
  p.on('exit', () => { if (served === p) served = null })
  for (let i = 0; i < 60; i++) {
    if (failed) throw new Error(`Ollama could not start: ${(failed as Error).message}`)
    if (served !== p) throw new Error('Ollama stopped right after starting. Another program may be using its port, or antivirus may have blocked it.')
    if (await isUp()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('Ollama did not start within 30 seconds.')
}

/** Stop the Ollama this app started (never one the user runs themselves). */
export function stopOllama(): void {
  served?.kill()
  served = null
}

// ── Models ─────────────────────────────────────────────────────────────────────

/** Read a stream of JSON lines. */
async function* jsonLines(res: Response): AsyncGenerator<Record<string, any>> {
  const reader = res.body!.getReader()
  const dec = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let i: number
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (line) yield JSON.parse(line)
    }
  }
  if (buf.trim()) yield JSON.parse(buf)
}

export async function pullModel(model: string, progress: Progress, signal: AbortSignal): Promise<void> {
  const res = await net.fetch(`${API}/api/pull`, { method: 'POST', body: JSON.stringify({ model, stream: true }), headers: { 'content-type': 'application/json' }, signal })
  if (!res.ok) throw new Error(`Ollama could not download ${model} (HTTP ${res.status}).`)
  const parts = new Map<string, { total: number; completed: number }>()
  let last = 0
  for await (const j of jsonLines(res)) {
    if (j.error) throw new Error(`Ollama: ${j.error}`)
    if (j.digest && j.total) parts.set(j.digest, { total: j.total, completed: j.completed ?? 0 })
    const total = [...parts.values()].reduce((a, p) => a + p.total, 0)
    const done = [...parts.values()].reduce((a, p) => a + p.completed, 0)
    if (Date.now() - last > 250 || j.status === 'success') {
      last = Date.now()
      progress({
        step: 'model',
        text: total ? `Downloading ${model}: ${fmtGB(done)} of ${fmtGB(total)}` : `${model}: ${j.status ?? 'working'}…`,
        fraction: total ? done / total : undefined
      })
    }
  }
}

/**
 * How the model runs here: load it once (timed), then ask a short tutor question and time
 * the wait for the answer and its speed (Ollama reports the exact token rate), and how much
 * of the model sits on the GPU.
 */
export async function speedTest(model: string, signal: AbortSignal): Promise<SpeedResult> {
  const post = (path: string, body: object, ms: number) =>
    net.fetch(API + path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]) })
  // Load it (timed on its own: it happens once per session) and warm it up with a few words.
  const t0 = Date.now()
  const load = await post('/api/generate', { model, prompt: 'Say OK.', stream: false, keep_alive: '15m', options: { num_predict: 4 } }, 300_000)
  if (!load.ok) throw new Error(`Ollama could not load ${model} (HTTP ${load.status}).`)
  await load.text()
  const loadS = (Date.now() - t0) / 1000

  // Two short tutor questions, averaged: how long thinking models think varies from one answer to the next.
  // The token cap leaves room for the thinking to finish, so the wait for the answer itself is what's timed.
  const questions = [
    'Why does adding a series inductor move a load clockwise on the Smith chart?',
    'What does the distance from the centre of the Smith chart tell you about a load?'
  ]
  const runs: Array<{ firstS: number; tps: number }> = []
  for (const q of questions) {
    const t1 = Date.now()
    let first = 0
    let evalCount = 0
    let evalNs = 0
    const res = await post('/api/chat', {
      model,
      stream: true,
      keep_alive: '15m',
      options: { num_predict: 1500 },
      messages: [
        { role: 'system', content: 'You are a patient Smith chart tutor. Answer in two or three short sentences.' },
        { role: 'user', content: q }
      ]
    }, 180_000)
    if (!res.ok) throw new Error(`Ollama could not run ${model} (HTTP ${res.status}).`)
    for await (const j of jsonLines(res)) {
      if (j.error) throw new Error(`Ollama: ${j.error}`)
      // Thinking models reason first; the learner waits for the answer itself.
      if (!first && typeof j.message?.content === 'string' && j.message.content.trim()) first = Date.now()
      if (j.done) { evalCount = j.eval_count ?? 0; evalNs = j.eval_duration ?? 0 }
    }
    // No answer at all within the cap counts as the whole wait.
    runs.push({ firstS: ((first || Date.now()) - t1) / 1000, tps: evalNs ? evalCount / (evalNs / 1e9) : 0 })
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length

  const ps = await getJson<{ models: Array<{ name: string; model?: string; size: number; size_vram: number }> }>('/api/ps', 4000).catch(() => ({ models: [] }))
  const m = ps.models.find((x) => x.name === model || x.model === model)
  return { loadS, firstTokenS: mean(runs.map((r) => r.firstS)), tokensPerSec: mean(runs.map((r) => r.tps)), gpuShare: m && m.size ? m.size_vram / m.size : 0 }
}
