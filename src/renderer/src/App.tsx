import { useEffect } from 'react'
import { useApp, type View } from '@/state/app'
import { useTutor } from '@/agent/tutor'
import { StudioChart } from '@/chart/StudioChart'
import { LoadPanel } from '@/panels/LoadPanel'
import { SweepPanel } from '@/panels/SweepPanel'
import { NetworkPanel } from '@/panels/NetworkPanel'
import { CalcPanel } from '@/panels/CalcPanel'
import { InspectCard, MarkerTable } from '@/panels/Readout'
import { TutorPanel } from '@/views/TutorPanel'
import { ModelsView } from '@/views/ModelsView'
import { AssessmentView } from '@/views/AssessmentView'
import { ProgressView } from '@/views/ProgressView'
import { ProfilesView } from '@/views/ProfilesView'
import { JourneyBar, LessonStatus } from '@/components/JourneyBar'
import { overallLevel } from '@shared/profile'

const TABS: Array<{ id: View; label: string; title: string }> = [
  { id: 'studio', label: 'Learn', title: 'Lessons with the tutor, on the Smith chart' },
  { id: 'progress', label: 'Progress', title: 'Skills, misconceptions and past lessons' },
  { id: 'assessment', label: 'Placement test', title: 'Sets your starting level' },
  { id: 'profiles', label: 'Profiles', title: 'Who is learning' },
  { id: 'models', label: 'Models', title: 'Which AI model tutors you' }
]

export function App() {
  const ready = useApp((s) => s.ready)
  const view = useApp((s) => s.view)
  const profile = useApp((s) => s.profile)
  const profiles = useApp((s) => s.profiles)
  const settings = useApp((s) => s.settings)
  const busy = useTutor((s) => s.busy)
  const { init, setView, selectProfile, setActiveProvider } = useApp.getState()

  useEffect(() => {
    init().catch((e) => console.error(e))
  }, [init])

  if (!ready || !profile) return <div className="loading">Loading…</div>


  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="-1.1 -1.1 2.2 2.2" width="22" height="22" aria-hidden>
            <circle r="1" fill="none" stroke="currentColor" strokeWidth="0.12" />
            <circle cx="0.5" r="0.5" fill="none" stroke="currentColor" strokeWidth="0.1" />
            <line x1="-1" x2="1" stroke="currentColor" strokeWidth="0.08" />
          </svg>
          Smith Tutor
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={view === t.id ? 'tab active' : 'tab'} title={t.title} onClick={() => setView(t.id)}>{t.label}</button>
          ))}
        </nav>
        <span className="spacer" />
        <LessonStatus />
        <label className="top-select" title="Learner profile">
          <span>👤</span>
          <select value={profile.id} disabled={busy} title={busy ? 'Wait for the tutor to finish' : undefined} onChange={(e) => selectProfile(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.assessment ? overallLevel(p.skills).level : 'new'}</option>)}
          </select>
        </label>
        <label className="top-select" title="Tutor model">
          <span>🤖</span>
          <select value={settings.activeProviderId ?? ''} onChange={(e) => setActiveProvider(e.target.value || null)}>
            {settings.providers.length === 0 && <option value="">no model</option>}
            {settings.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </header>
      <JourneyBar />

      {view === 'studio' ? (
        <main className="studio">
          <div className="side">
            <LoadPanel />
            <SweepPanel />
            <NetworkPanel />
            <CalcPanel />
          </div>
          <div className="center">
            <StudioChart />
            <div className="readouts">
              <InspectCard />
              <MarkerTable />
            </div>
          </div>
          <TutorPanel />
        </main>
      ) : (
        <main className="scroll">
          {view === 'models' && <ModelsView />}
          {view === 'assessment' && <AssessmentView />}
          {view === 'progress' && <ProgressView />}
          {view === 'profiles' && <ProfilesView />}
        </main>
      )}
    </div>
  )
}
