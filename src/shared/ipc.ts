import type { ChatRequest, Connection, ProviderConfig, StreamEvent } from './llm'
import type { BenchmarkReport } from './benchmark'
import type { MachineInfo, OllamaStatus, SetupProgress, SetupResult } from './localModels'

export interface AppSettings {
  /** Provider accounts/endpoints; each holds one API key */
  connections: Connection[]
  /** Models (each on a connection) */
  providers: ProviderConfig[]
  activeProviderId: string | null
  activeProfileId: string | null
  /** Latest benchmark per provider id */
  benchmarks: Record<string, BenchmarkReport>
  /** Every benchmark run on this machine, including models since removed */
  benchmarkHistory: BenchmarkReport[]
}

export interface OpenedFile {
  name: string
  text: string
}

/** The API exposed on `window.api` by the preload script. */
export interface DesktopApi {
  settings: {
    get(): Promise<AppSettings>
    save(s: AppSettings): Promise<void>
  }
  keys: {
    /** Store (or clear with null) the API key of a connection */
    set(connectionId: string, key: string | null): Promise<void>
  }
  llm: {
    /** Streams events to `onEvent`; `done` resolves with the terminal (done/error) event. */
    chat(req: ChatRequest, onEvent: (ev: StreamEvent) => void): { requestId: string; done: Promise<StreamEvent | undefined> }
    abort(requestId: string): Promise<void>
    /** Models available on a connection (uses its saved key) */
    models(connectionId: string): Promise<string[]>
  }
  profiles: {
    list(): Promise<unknown[]>
    save(p: { id: string }): Promise<void>
    delete(id: string): Promise<void>
    exportToFile(json: string, suggestedName: string): Promise<boolean>
    importFromFile(): Promise<string | null>
  }
  workspace: {
    get(profileId: string): Promise<unknown>
    save(profileId: string, ws: unknown): Promise<void>
  }
  /** The live tutor conversation per profile (null clears it) */
  conversation: {
    get(profileId: string): Promise<unknown>
    save(profileId: string, c: unknown): Promise<void>
  }
  files: {
    openData(): Promise<OpenedFile[]>
    openDataFolder(): Promise<void>
  }
  /** A free local tutor with Ollama: what this machine has, and a one-click setup */
  local: {
    probe(): Promise<{ machine: MachineInfo; status: OllamaStatus }>
    /** Installs Ollama if needed, starts it, downloads the model and measures it; progress streams to onProgress */
    setup(model: string, onProgress: (p: SetupProgress) => void): { id: string; done: Promise<SetupResult> }
    cancel(id: string): Promise<void>
  }
}
