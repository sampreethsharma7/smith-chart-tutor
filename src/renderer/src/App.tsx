import { useEffect } from 'react'
import { chartModeOf, currentChartMode, useApp, type View } from '@/state/app'
import { useTutor } from '@/agent/tutor'
import { StudioChart } from '@/chart/StudioChart'
import { LoadPanel } from '@/panels/LoadPanel'
import { SweepPanel } from '@/panels/SweepPanel'
import { NetworkPanel } from '@/panels/NetworkPanel'
import { CalcPanel } from '@/panels/CalcPanel'
import { InspectCard, MarkerTable } from '@/panels/Readout'
import { TutorPanel } from '@/views/TutorPanel'
import { DesignPanel } from '@/views/DesignPanel'
import { useDesigner } from '@/agent/designer'
import { ModelsView } from '@/views/ModelsView'
import { AssessmentView } from '@/views/AssessmentView'
import { ProgressView } from '@/views/ProgressView'
import { ProfilesView } from '@/views/ProfilesView'
import { JourneyBar, LessonStatus } from '@/components/JourneyBar'
import { overallLevel } from '@shared/profile'
import { FlagDialog } from '@/components/Flag'

const TABS: Array<{ id: View; label: string; title: string }> = [
  { id: 'studio', label: 'Learn', title: 'Lessons with the tutor, on the Smith chart' },
  { id: 'design', label: 'Design', title: 'Match your own loads with a design assistant: it does the work with you. No lesson, nothing graded' },
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
  const tutorBusy = useTutor((s) => s.busy)
  const designBusy = useDesigner((s) => s.busy)
  const busy = tutorBusy || designBusy
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
          {TABS.map((t) => {
            // Learn and Design have their own charts: no swapping one out while an assistant is working on it.
            const mode = chartModeOf(t.id)
            const locked = busy && !!mode && mode !== currentChartMode()
            return (
              <button key={t.id} className={view === t.id ? 'tab active' : 'tab'} disabled={locked} title={locked ? `Wait for the ${tutorBusy ? 'tutor' : 'design assistant'} to finish` : t.title} onClick={() => setView(t.id)}>{t.label}</button>
            )
          })}
        </nav>
        <span className="spacer" />
        <LessonStatus />
        <label className="top-select" title="Learner profile">
          <span>👤</span>
          <select value={profile.id} disabled={busy} title={busy ? `Wait for the ${tutorBusy ? 'tutor' : 'design assistant'} to finish` : undefined} onChange={(e) => selectProfile(e.target.value)}>
            {profiles.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.assessment ? overallLevel(p.skills).level : 'new'}</option>)}
          </select>
        </label>
        <label className="top-select" title="AI model (tutor and design assistant)">
          <span>🤖</span>
          <select value={settings.activeProviderId ?? ''} onChange={(e) => setActiveProvider(e.target.value || null)}>
            {settings.providers.length === 0 && <option value="">no model</option>}
            {settings.providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      </header>
      <JourneyBar />
      <FlagDialog />

      {view === 'studio' || view === 'design' ? (
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
          {view === 'design' ? <DesignPanel /> : <TutorPanel />}
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
