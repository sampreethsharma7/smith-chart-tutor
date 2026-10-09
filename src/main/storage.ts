import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { CONNECTION_PRESETS, modelLabel, type Connection, type ProviderConfig } from '@shared/llm'
import type { AppSettings } from '@shared/ipc'

/** Plain JSON files under the app's userData folder. Simple, inspectable, easy to back up. */
const root = () => join(app.getPath('userData'), 'data')
const profilesDir = () => join(root(), 'profiles')
const workspaceDir = () => join(root(), 'workspaces')
const tutorDir = () => join(root(), 'conversations')
const designDir = () => join(root(), 'design')

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/**
 * Delete a file on purpose (a cleared chat, an ended lesson), with any temp files of interrupted
 * saves next to it: otherwise the startup clean-up would "recover" one of those as the file.
 * Waits for a save already on its way, so that can't bring it back either.
 */
async function removeFile(path: string) {
  await (writing.get(path) ?? Promise.resolve()).catch(() => {})
  await fs.rm(path, { force: true })
  const dir = join(path, '..')
  const base = path.slice(dir.length + 1)
  const names = await fs.readdir(dir).catch(() => [] as string[])
  await Promise.all(names.filter((n) => n.startsWith(`${base}.`) && n.endsWith('.tmp')).map((n) => fs.rm(join(dir, n), { force: true }).catch(() => {})))
}

const writing = new Map<string, Promise<void>>()
let tmpSeq = 0

/**
 * Write via temp file + rename so a crash never leaves a half-written profile.
 * Writes to the same file are queued (overlapping saves used to share one temp
 * file), and a rename blocked on Windows by an indexer or antivirus is retried.
 */
function writeJson(path: string, data: unknown): Promise<void> {
  const text = JSON.stringify(data, null, 2)
  const run = async () => {
    await fs.mkdir(join(path, '..'), { recursive: true })
    const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.rename(tmp, path)
        return
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '')) {
          await fs.rm(tmp, { force: true }).catch(() => {})
          throw e
        }
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)))
      }
    }
  }
  const next = (writing.get(path) ?? Promise.resolve()).catch(() => {}).then(run)
  writing.set(path, next)
  next.finally(() => writing.get(path) === next && writing.delete(path)).catch(() => {})
  return next
}

/**
 * Temp files left by a save the app was closed or killed in the middle of (between writing the
 * temp file and renaming it). At startup: if the real file is missing or unreadable, the newest
 * readable temp file becomes it (that save is recovered); the rest are deleted. Files younger
 * than a minute are left alone, in case another app process is mid-save.
 */
export async function cleanUpTempFiles(): Promise<{ removed: number; recovered: string[] }> {
  const out = { removed: 0, recovered: [] as string[] }
  const tmpName = /^(.+\.json)(?:\.\d+\.\d+)?\.tmp$/
  for (const dir of [root(), profilesDir(), workspaceDir(), tutorDir(), designDir()]) {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue
    }
    const byTarget = new Map<string, { path: string; mtime: number }[]>()
    for (const n of names) {
      const m = tmpName.exec(n)
      if (!m) continue
      const path = join(dir, n)
      const st = await fs.stat(path).catch(() => null)
      if (!st || !st.isFile() || Date.now() - st.mtimeMs < 60_000) continue
      byTarget.set(m[1], [...(byTarget.get(m[1]) ?? []), { path, mtime: st.mtimeMs }])
    }
    for (const [target, tmps] of byTarget) {
      const real = join(dir, target)
      const readable = async (p: string) => {
        try {
          JSON.parse(await fs.readFile(p, 'utf8'))
          return true
        } catch {
          return false
        }
      }
      if (!(await readable(real))) {
        for (const t of [...tmps].sort((a, b) => b.mtime - a.mtime)) {
          if (await readable(t.path)) {
            await fs.copyFile(t.path, real)
            out.recovered.push(join(dir, target))
            break
          }
        }
      }
      for (const t of tmps) {
        await fs.rm(t.path, { force: true }).then(() => out.removed++, () => {})
      }
    }
  }
  return out
}

const safeId = (id: string) => id.replace(/[^a-zA-Z0-9_-]/g, '')

// ---- settings -------------------------------------------------------------

const DEFAULT_SETTINGS: AppSettings = { connections: [], providers: [], activeProviderId: null, activeProfileId: null, benchmarks: {}, benchmarkHistory: [] }

export async function getSettings(): Promise<AppSettings> {
  const raw = await readJson<AppSettings>(join(root(), 'settings.json'), DEFAULT_SETTINGS)
  let s: AppSettings = { ...DEFAULT_SETTINGS, ...raw, connections: raw.connections ?? [], providers: raw.providers ?? [] }
  if (s.providers.some((p) => !p.connectionId)) s = await migrateToConnections(s)
  const keys = await readKeys()
  const conns = new Map(s.connections.map((c) => [c.id, c]))
  return {
    ...s,
    connections: s.connections.map((c) => ({ ...c, hasKey: Boolean(keys[c.id]) })),
    // Models inherit endpoint and key from their connection.
    providers: s.providers.map((p) => {
      const c = p.connectionId ? conns.get(p.connectionId) : undefined
      return { ...p, kind: c?.kind ?? p.kind, baseUrl: c ? c.baseUrl : p.baseUrl, hasKey: Boolean(keys[p.connectionId ?? p.id]) }
    })
  }
}

/** Older settings had one key per model: group models into connections and move each key once. */
async function migrateToConnections(s: AppSettings): Promise<AppSettings> {
  const keys = await readKeys()
  const connections = [...s.connections]
  const presetFor = (p: ProviderConfig) =>
    p.kind === 'anthropic' ? 'anthropic'
      : p.kind === 'gemini' ? 'gemini'
        : !p.baseUrl ? 'openai'
          : /11434/.test(p.baseUrl) ? 'ollama'
            : /:1234/.test(p.baseUrl) ? 'lmstudio'
              : /openrouter/.test(p.baseUrl) ? 'openrouter' : 'custom'
  const providers = s.providers.map((p) => {
    if (p.connectionId) return p
    const preset = presetFor(p)
    const def = CONNECTION_PRESETS.find((y) => y.id === preset)!
    const baseUrl = p.baseUrl ?? def.baseUrl
    let c: Connection | undefined = connections.find((x) => x.preset === preset && (x.baseUrl ?? '') === (baseUrl ?? ''))
    if (!c) {
      c = { id: `cx_${preset}_${Math.random().toString(36).slice(2, 7)}`, preset, label: def.label, kind: p.kind, baseUrl }
      connections.push(c)
    }
    if (keys[p.id] && !keys[c.id]) keys[c.id] = keys[p.id]
    delete keys[p.id]
    // Old preset names ("Google Gemini") become model names ("Gemini 2.5 Pro").
    const generic = ['Google Gemini', 'OpenAI', 'OpenRouter', 'Ollama (local)', 'LM Studio (local)'].includes(p.label)
    return { ...p, connectionId: c.id, label: generic ? modelLabel(c, p.model) : p.label }
  })
  await writeJson(keysPath(), keys)
  const next = { ...s, connections, providers }
  await saveSettings(next)
  return next
}

export async function saveSettings(s: AppSettings) {
  const providers = s.providers.map(({ hasKey: _h, ...p }) => p)
  const connections = (s.connections ?? []).map(({ hasKey: _h, ...c }) => c)
  await writeJson(join(root(), 'settings.json'), { ...s, connections, providers })
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  return (await getSettings()).connections.find((c) => c.id === id)
}

export async function getProvider(id: string): Promise<ProviderConfig | undefined> {
  return (await getSettings()).providers.find((p) => p.id === id)
}

// ---- API keys (encrypted with the OS keychain via safeStorage) -------------

const keysPath = () => join(root(), 'keys.json')
async function readKeys(): Promise<Record<string, string>> {
  return readJson<Record<string, string>>(keysPath(), {})
}

export async function setKey(connectionId: string, key: string | null) {
  const keys = await readKeys()
  if (!key) delete keys[connectionId]
  else if (safeStorage.isEncryptionAvailable()) keys[connectionId] = 'enc:' + safeStorage.encryptString(key).toString('base64')
  else keys[connectionId] = 'raw:' + Buffer.from(key).toString('base64')
  await writeJson(keysPath(), keys)
}

/** Key for a connection id (for a model, pass `cfg.connectionId ?? cfg.id`). */
export async function getKey(id: string): Promise<string> {
  const v = (await readKeys())[id]
  if (!v) return ''
  if (v.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
    } catch {
      // Keys are bound to this Windows user and this app install; a copied data folder can't read them.
      throw new Error('The saved API key can’t be read on this computer/account. Paste the key again in Models.')
    }
  }
  return Buffer.from(v.slice(4), 'base64').toString('utf8')
}

// ---- profiles ---------------------------------------------------------------

export async function listProfiles(): Promise<unknown[]> {
  await fs.mkdir(profilesDir(), { recursive: true })
  const files = (await fs.readdir(profilesDir())).filter((f) => f.endsWith('.json'))
  const out = []
  for (const f of files) {
    const p = await readJson<Record<string, unknown> | null>(join(profilesDir(), f), null)
    if (p) out.push(p)
  }
  return out
}

export async function saveProfile(p: { id: string }) {
  if (deleted.has(safeId(p.id))) return
  await writeJson(join(profilesDir(), `${safeId(p.id)}.json`), p)
}

/** Profiles deleted this run: saves that were already on their way are dropped, so nothing comes back. */
const deleted = new Set<string>()

export async function deleteProfile(id: string) {
  deleted.add(safeId(id))
  await fs.rm(join(profilesDir(), `${safeId(id)}.json`), { force: true })
  await fs.rm(join(workspaceDir(), `${safeId(id)}.json`), { force: true })
  await removeFile(join(tutorDir(), `${safeId(id)}.json`))
  for (const part of DESIGN_PARTS) await removeFile(designFile(id, part))
}

// ---- per-profile chart workspace -------------------------------------------

export async function getWorkspace(profileId: string): Promise<unknown> {
  return readJson(join(workspaceDir(), `${safeId(profileId)}.json`), null)
}

export async function saveWorkspace(profileId: string, ws: unknown) {
  if (deleted.has(safeId(profileId))) return
  await writeJson(join(workspaceDir(), `${safeId(profileId)}.json`), ws)
}

// ---- per-profile live tutor conversation ------------------------------------

export async function getConversation(profileId: string): Promise<unknown> {
  return readJson(join(tutorDir(), `${safeId(profileId)}.json`), null)
}

export async function saveConversation(profileId: string, c: unknown) {
  if (deleted.has(safeId(profileId))) return
  if (c === null) await removeFile(join(tutorDir(), `${safeId(profileId)}.json`))
  else await writeJson(join(tutorDir(), `${safeId(profileId)}.json`), c)
}

// ---- per-profile Design tab: its own chart and assistant chat -----------------

const DESIGN_PARTS = ['workspace', 'chat']
function designFile(profileId: string, part: string) {
  if (!DESIGN_PARTS.includes(part)) throw new Error(`Unknown design part "${part}"`)
  return join(designDir(), `${safeId(profileId)}.${part}.json`)
}

export async function getDesign(profileId: string, part: string): Promise<unknown> {
  return readJson(designFile(profileId, part), null)
}

export async function saveDesign(profileId: string, part: string, data: unknown) {
  if (deleted.has(safeId(profileId))) return
  if (data === null) await removeFile(designFile(profileId, part))
  else await writeJson(designFile(profileId, part), data)
}

// ---- problem reports and the issue log (local only) ---------------------------

const reportsDir = () => join(root(), 'reports')

export async function reportsFolder() {
  await fs.mkdir(reportsDir(), { recursive: true })
  return reportsDir()
}

/** A flagged problem: the JSON (what was said, the tool calls, the chart) and a screenshot beside it. */
export async function saveReport(report: unknown, png: Buffer): Promise<string> {
  const name = `${new Date().toISOString().replace(/[:.]/g, '-')}`
  await fs.mkdir(reportsDir(), { recursive: true })
  await writeJson(join(reportsDir(), `${name}.json`), { ...(report as object), screenshot: `${name}.png` })
  await fs.writeFile(join(reportsDir(), `${name}.png`), png)
  return name
}

const ISSUE_LOG_MAX = 2 * 1024 * 1024
let issueWrite: Promise<void> = Promise.resolve()

/** Faults the app noticed, one JSON line each; at 2 MB the log moves to issues.old.jsonl and starts again. */
export function appendIssues(entries: unknown[]): Promise<void> {
  if (!Array.isArray(entries) || !entries.length) return Promise.resolve()
  const file = join(root(), 'issues.jsonl')
  issueWrite = issueWrite.catch(() => {}).then(async () => {
    const size = await fs.stat(file).then((s) => s.size, () => 0)
    if (size > ISSUE_LOG_MAX) await fs.rename(file, join(root(), 'issues.old.jsonl')).catch(() => {})
    await fs.appendFile(file, entries.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
  })
  return issueWrite
}

export const dataFolder = root
