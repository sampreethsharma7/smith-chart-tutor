import { create } from 'zustand'
import type { AppSettings, DesktopApi } from '@shared/ipc'
import type { ProviderConfig } from '@shared/llm'
import { createProfile, migrateProfile, type Profile } from '@shared/profile'
import type { BenchmarkReport } from '@shared/benchmark'
import { useStudio, type StudioSnapshot } from './studio'
import { useCalc } from './calc'

declare global {
  interface Window {
    api: DesktopApi
  }
}
export const api = () => window.api

export type View = 'studio' | 'assessment' | 'progress' | 'models' | 'profiles'

interface AppState {
  ready: boolean
  view: View
  settings: AppSettings
  profiles: Profile[]
  profile: Profile | null
  init(): Promise<void>
  setView(v: View): void
  // models
  saveProviders(providers: ProviderConfig[], activeId?: string | null): Promise<void>
  /** Save connections and/or models together (keeps the active model valid) */
  saveConfig(patch: Partial<Pick<AppSettings, 'connections' | 'providers' | 'activeProviderId'>>): Promise<void>
  setActiveProvider(id: string | null): Promise<void>
  saveBenchmark(r: BenchmarkReport): Promise<void>
  // profiles
  selectProfile(id: string): Promise<void>
  /** Edit a profile that may not be the active one (no switching) */
  updateProfileById(id: string, fn: (p: Profile) => Profile): Promise<void>
  addProfile(p: Profile): Promise<void>
  /** Apply a change to the active profile and persist it */
  updateProfile(fn: (p: Profile) => Profile): Promise<void>
  deleteProfile(id: string): Promise<void>
}

let saveTimer: ReturnType<typeof setTimeout> | undefined
let initOnce: Promise<void> | undefined

async function doInit() {
  const settings = await api().settings.get()
  let profiles = ((await api().profiles.list()) as Profile[]).map(migrateProfile)
  if (profiles.length === 0) {
    const p = createProfile('Me', { experience: 'basics' })
    await api().profiles.save(p)
    profiles = [p]
  }
  const profile = profiles.find((p) => p.id === settings.activeProfileId) ?? profiles[0]
  useApp.setState({ settings, profiles, profile, ready: true, view: profile.setupComplete ? 'studio' : 'profiles' })
  await loadWorkspace(profile)
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  view: 'studio',
  settings: { connections: [], providers: [], activeProviderId: null, activeProfileId: null, benchmarks: {}, benchmarkHistory: [] },
  profiles: [],
  profile: null,

  init() {
    // Guard against double init (React StrictMode runs effects twice in dev).
    return (initOnce ??= doInit())
  },

  setView(view) {
    set({ view })
  },

  async saveProviders(providers, activeId) {
    await get().saveConfig({ providers, ...(activeId === undefined ? {} : { activeProviderId: activeId }) })
  },
  async saveConfig(patch) {
    const settings = { ...get().settings, ...patch }
    const ids = settings.providers.map((p) => p.id)
    if (!settings.activeProviderId || !ids.includes(settings.activeProviderId)) settings.activeProviderId = ids[0] ?? null
    await api().settings.save(settings)
    set({ settings: await api().settings.get() })
  },
  async setActiveProvider(id) {
    const settings = { ...get().settings, activeProviderId: id }
    set({ settings })
    await api().settings.save(settings)
  },
  async saveBenchmark(r) {
    const cur = get().settings
    const settings = {
      ...cur,
      benchmarks: { ...cur.benchmarks, [r.providerId]: r },
      benchmarkHistory: [...(cur.benchmarkHistory ?? []), r].slice(-300)
    }
    set({ settings })
    await api().settings.save(settings)
  },

  async selectProfile(id) {
    const profile = get().profiles.find((p) => p.id === id)
    if (!profile) return
    await flushWorkspace()
    const settings = { ...get().settings, activeProfileId: id }
    set({ profile, settings, ...(profile.setupComplete ? {} : { view: 'profiles' as View }) })
    await api().settings.save(settings)
    await loadWorkspace(profile)
    useCalc.getState().reset()
    useCalc.getState().setOpen(false)
  },
  async addProfile(p) {
    await api().profiles.save(p)
    set({ profiles: [...get().profiles.filter((x) => x.id !== p.id), p] })
    await get().selectProfile(p.id)
  },
  async updateProfile(fn) {
    const cur = get().profile
    if (!cur) return
    const next = { ...fn(cur), updatedAt: new Date().toISOString() }
    set({ profile: next, profiles: get().profiles.map((p) => (p.id === next.id ? next : p)) })
    await api().profiles.save(next)
  },
  async updateProfileById(id, fn) {
    if (get().profile?.id === id) return get().updateProfile(fn)
    const cur = get().profiles.find((p) => p.id === id)
    if (!cur) return
    const next = { ...fn(cur), updatedAt: new Date().toISOString() }
    set({ profiles: get().profiles.map((p) => (p.id === id ? next : p)) })
    await api().profiles.save(next)
  },
  async deleteProfile(id) {
    // Move off it first, then delete (main drops any save of it still on its way).
    if (get().profile?.id === id) {
      const other = get().profiles.find((p) => p.id !== id)
      if (other) await get().selectProfile(other.id)
      else await get().addProfile(createProfile('Me'))
    }
    await api().profiles.delete(id)
    set({ profiles: get().profiles.filter((p) => p.id !== id) })
  }
}))

export function activeProvider(): ProviderConfig | undefined {
  const s = useApp.getState().settings
  return s.providers.find((p) => p.id === s.activeProviderId)
}

// ---- workspace persistence (chart setup per profile) ------------------------

async function loadWorkspace(p: Profile) {
  const ws = (await api().workspace.get(p.id)) as Partial<StudioSnapshot> | null
  useStudio.getState().loadSnapshot(ws ?? { z0: p.preferences.defaultZ0 })
}

export async function flushWorkspace() {
  const p = useApp.getState().profile
  if (!p) return
  clearTimeout(saveTimer)
  await api().workspace.save(p.id, useStudio.getState().snapshot())
}

useStudio.subscribe((s, prev) => {
  const keys = ['network', 'load', 'markers', 'sweep', 'z0', 'datasets', 'designFreq', 'showBand', 'overlays', 'annotations', 'exercise', 'prediction'] as const
  if (keys.every((k) => s[k] === prev[k])) return
  clearTimeout(saveTimer)
  saveTimer = setTimeout(flushWorkspace, 800)
})

window.addEventListener('beforeunload', () => {
  flushWorkspace()
})
