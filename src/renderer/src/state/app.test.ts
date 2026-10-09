import { describe, expect, it, vi } from 'vitest'
import { createProfile, migrateProfile } from '@shared/profile'

// The real app store, on an in-memory disk.
const me = { ...migrateProfile(createProfile('Me')), setupComplete: true }
const learner = { ...migrateProfile(createProfile('Course run (scripted learner)')), setupComplete: true }
const disk = {
  settings: {
    connections: [], providers: [{ id: 'mine', label: 'Mine', model: 'm' }, { id: 'run', label: 'Run', model: 'r' }],
    // The app closed mid-run: still on the learner and the run's model, with the marker saying what to put back.
    activeProviderId: 'run', activeProfileId: learner.id, benchmarks: {}, benchmarkHistory: [],
    courseRunActive: { learnerId: learner.id, profileId: me.id, providerId: 'mine' }
  } as any,
  profiles: [me, learner] as any[],
  deleted: [] as string[]
}
vi.stubGlobal('window', {
  addEventListener: () => {},
  api: {
    settings: { get: async () => disk.settings, save: async (s: any) => { disk.settings = s } },
    profiles: {
      list: async () => disk.profiles,
      save: async () => {},
      delete: async (id: string) => { disk.deleted.push(id); disk.profiles = disk.profiles.filter((p) => p.id !== id) }
    },
    workspace: { get: async () => null, save: async () => {} },
    design: { get: async () => null, save: async () => {} }
  }
})

const { useApp, switchLock } = await import('./app')

describe('review: a course run interrupted by closing the app is undone at the next start', () => {
  it('puts the profile and model back, deletes the learner and clears the marker', async () => {
    await useApp.getState().init()
    const s = useApp.getState()
    expect(s.profile?.id).toBe(me.id)
    expect(s.profiles.map((p) => p.id)).toEqual([me.id])
    expect(s.settings.activeProviderId).toBe('mine')
    expect(disk.deleted).toEqual([learner.id])
    expect(disk.settings.courseRunActive).toBeUndefined()
    expect(disk.settings.activeProfileId).toBe(me.id)
  })
})

describe('review: while a run is going, nothing else switches the profile, the model or the chart', () => {
  it('the header pickers, the Profiles page and the Learn/Design tabs are refused; afterwards they work again', async () => {
    const other = { ...migrateProfile(createProfile('Other')), setupComplete: true }
    useApp.setState({ profiles: [...useApp.getState().profiles, other] })
    switchLock.on = true
    await useApp.getState().selectProfile(other.id)
    await useApp.getState().setActiveProvider('run')
    await useApp.getState().deleteProfile(me.id)
    await useApp.getState().setView('design')
    expect(useApp.getState().profile?.id).toBe(me.id)
    expect(useApp.getState().settings.activeProviderId).toBe('mine')
    expect(useApp.getState().profiles).toHaveLength(2)
    expect(useApp.getState().view).not.toBe('design')
    switchLock.on = false
    await useApp.getState().setActiveProvider('run')
    expect(useApp.getState().settings.activeProviderId).toBe('run')
  })
})
