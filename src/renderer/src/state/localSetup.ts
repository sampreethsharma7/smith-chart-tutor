import { create } from 'zustand'
import { modelLabel, type Connection, type ProviderConfig } from '@shared/llm'
import { judgeSpeed, type MachineInfo, type OllamaStatus, type SetupProgress, type SpeedVerdict } from '@shared/localModels'
import { api, useApp } from './app'

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

/** Same Ollama? localhost and 127.0.0.1 are one place; a different host or port is another computer or server. */
function sameEndpoint(a: string | undefined, b: string): boolean {
  try {
    const x = new URL(a ?? '')
    const y = new URL(b)
    const local = (h: string) => (h === '127.0.0.1' ? 'localhost' : h)
    return local(x.hostname) === local(y.hostname) && (x.port || '80') === (y.port || '80')
  } catch {
    return false
  }
}

/** Add the model under the Ollama connection for this computer (created if needed); returns the model's id. */
async function addToModels(model: string, apiBase: string): Promise<string> {
  const { settings, saveConfig } = useApp.getState()
  const connections = [...settings.connections]
  let c = connections.find((x) => x.preset === 'ollama' && sameEndpoint(x.baseUrl, apiBase))
  if (!c) {
    c = { id: uid('cx'), preset: 'ollama', label: 'Ollama (local)', kind: 'openai', baseUrl: apiBase } satisfies Connection
    connections.push(c)
  }
  const providers = [...settings.providers]
  let p = providers.find((x) => x.connectionId === c.id && x.model === model)
  if (!p) {
    p = { id: uid('pv'), label: modelLabel(c, model), connectionId: c.id, kind: c.kind, baseUrl: c.baseUrl, model } satisfies ProviderConfig
    providers.push(p)
  }
  await saveConfig({ connections, providers })
  return p.id
}

interface LocalSetupState {
  /** A setup in progress (kept here, not in the card, so leaving the Models tab doesn't lose it) */
  running: { id: string; model: string; progress: SetupProgress } | null
  done: { model: string; providerId: string; verdict: SpeedVerdict; loadS: number } | null
  error: string | null
  /** The last check of this computer, kept so the card shows at once when the tab is reopened */
  info: { machine: MachineInfo; status: OllamaStatus } | null
  probeError: string | null
  /** Re-check the machine and Ollama (in the background when there's already a result) */
  probe(): Promise<void>
  start(model: string): Promise<void>
  cancel(): void
}

export const useLocalSetup = create<LocalSetupState>((set, get) => ({
  running: null,
  done: null,
  error: null,
  info: null,
  probeError: null,
  async probe() {
    try {
      set({ info: await api().local.probe(), probeError: null })
    } catch (e) {
      if (!get().info) set({ probeError: (e as Error).message })
    }
  },
  async start(model) {
    if (get().running) return
    set({ error: null, done: null })
    const { id, done } = api().local.setup(model, (progress) => set({ running: { id, model, progress } }))
    set({ running: { id, model, progress: { step: 'start', text: 'Starting…' } } })
    const r = await done
    if (!r.ok) {
      set({ running: null, error: r.error })
      get().probe()
      return
    }
    const providerId = await addToModels(model, r.apiBase)
    set({ running: null, done: { model, providerId, verdict: judgeSpeed(r.speed), loadS: r.speed.loadS } })
    get().probe() // Ollama and its models have changed
  },
  cancel() {
    const r = get().running
    if (r) api().local.cancel(r.id)
  }
}))
