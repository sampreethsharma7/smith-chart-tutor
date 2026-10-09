import { create } from 'zustand'
import type { AppSettings, DesktopApi } from '@shared/ipc'
import type { ProviderConfig } from '@shared/llm'
import { createProfile, migrateProfile, type Profile } from '@shared/profile'
import type { BenchmarkReport } from '@shared/benchmark'
import type { CourseReport } from '@shared/course'
import { useStudio, type StudioSnapshot } from './studio'
import { useCalc } from './calc'

declare global {
  interface Window {
    api: DesktopApi
  }
}
export const api = () => window.api

export type View = 'studio' | 'design' | 'assessment' | 'progress' | 'models' | 'profiles'

/** Which chart is loaded: the lesson's (Learn) or the Design tab's. Each profile has one of each. */
export type ChartMode = 'lesson' | 'design'
let chartMode: ChartMode = 'lesson'
export const currentChartMode = () => chartMode
/** The chart a view shows; views without a chart keep whichever is loaded. */
/** Assistants working on the loaded chart (tutor, design assistant): the chart can't be swapped under them. */
const busyChecks: Array<() => boolean> = []
export const registerBusy = (check: () => boolean) => { busyChecks.push(check) }
export const agentBusy = () => busyChecks.some((f) => f())
/**
 * While a course run is going it alone switches profile, model and chart: anything else that tries
 * (the header pickers, the Profiles page, a tab) is refused, so the run can't act on the user's own
 * profile or credit one model with another's teaching.
 */
export const switchLock = { on: false }
export const chartModeOf = (v: View): ChartMode | null => (v === 'design' ? 'design' : v === 'studio' ? 'lesson' : null)

interface AppState {
  ready: boolean
  view: View
  settings: AppSettings
  profiles: Profile[]
  profile: Profile | null
  init(): Promise<void>
  /** Switching between Learn and Design also swaps the chart (resolves once it's loaded) */
  setView(v: View): Promise<void>
  // models
  saveProviders(providers: ProviderConfig[], activeId?: string | null): Promise<void>
  /** Save connections and/or models together (keeps the active model valid) */
  saveConfig(patch: Partial<Pick<AppSettings, 'connections' | 'providers' | 'activeProviderId'>>): Promise<void>
  setActiveProvider(id: string | null): Promise<void>
  saveBenchmark(r: BenchmarkReport): Promise<void>
  saveCourseRun(r: CourseReport): Promise<void>
  /** Note (or clear) a course run in progress, so a restart can undo it */
  markCourseRun(m: AppSettings['courseRunActive'] | null): Promise<void>
  deleteCourseRun(id: string): Promise<void>
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
  let settings = await api().settings.get()
  // The app closed during a course run: put the profile and model back and delete the run's learner.
  const run = settings.courseRunActive
  if (run) {
    await api().profiles.delete(run.learnerId).catch(() => {})
    const { courseRunActive: _done, ...rest } = settings
    settings = { ...rest, activeProfileId: run.profileId, activeProviderId: run.providerId && settings.providers.some((p) => p.id === run.providerId) ? run.providerId : settings.activeProviderId }
    await api().settings.save(settings)
  }
  let profiles = ((await api().profiles.list()) as Profile[]).map(migrateProfile).filter((p) => p.id !== run?.learnerId)
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

  async setView(view) {
    const mode = chartModeOf(view)
    if (mode && mode !== chartMode) {
      if (agentBusy() || switchLock.on) return // its tools act on the chart that's loaded
      await flushWorkspace()
      chartMode = mode
      const p = get().profile
      if (p) await loadWorkspace(p)
    }
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
    if (switchLock.on) return
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

  async saveCourseRun(r) {
    const cur = get().settings
    const settings = { ...cur, courseRuns: [...(cur.courseRuns ?? []), r].slice(-50) }
    set({ settings })
    await api().settings.save(settings)
  },
  async markCourseRun(m) {
    const { courseRunActive: _old, ...cur } = get().settings
    const settings = m ? { ...cur, courseRunActive: m } : cur
    set({ settings })
    await api().settings.save(settings)
  },
  async deleteCourseRun(id) {
    const cur = get().settings
    const settings = { ...cur, courseRuns: (cur.courseRuns ?? []).filter((r) => r.id !== id) }
    set({ settings })
    await api().settings.save(settings)
  },

  async selectProfile(id) {
    if (switchLock.on) return
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
    if (switchLock.on) return
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
    if (switchLock.on) return
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
  const mode = chartMode
  const ws = (mode === 'design' ? await api().design.get(p.id, 'workspace') : await api().workspace.get(p.id)) as Partial<StudioSnapshot> | null
  if (mode !== chartMode) return // switched again meanwhile
  useStudio.getState().loadSnapshot(ws ?? { z0: p.preferences.defaultZ0 })
}

export async function flushWorkspace() {
  const p = useApp.getState().profile
  if (!p) return
  clearTimeout(saveTimer)
  const snap = useStudio.getState().snapshot()
  if (chartMode === 'design') await api().design.save(p.id, 'workspace', snap)
  else await api().workspace.save(p.id, snap)
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
