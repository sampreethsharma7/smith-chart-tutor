import { useState } from 'react'
import { createProfile, exportProfile, lessonsOf, migrateProfile, overallLevel, type Profile } from '@shared/profile'
import { api, useApp } from '@/state/app'
import { useTutor } from '@/agent/tutor'

type Draft = Pick<Profile, 'name' | 'background' | 'preferences'>

const blank = (): Draft => {
  const p = createProfile('')
  return { name: '', background: p.background, preferences: p.preferences }
}

export function ProfilesView() {
  const profiles = useApp((s) => s.profiles)
  const active = useApp((s) => s.profile)
  const { addProfile, selectProfile, deleteProfile, setView } = useApp.getState()
  const draftOf = (p: Profile): Draft => ({ name: p.name, background: p.background, preferences: p.preferences })
  // First run (or an imported profile that was never set up): open the setup form straight away.
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(
    active && !active.setupComplete ? { id: active.id, draft: draftOf(active) } : null
  )
  const [msg, setMsg] = useState<string | null>(null)
  const busy = useTutor((t) => t.busy)

  const switchTo = (id: string) => selectProfile(id)

  const saveDraft = async () => {
    if (!editing || !editing.draft.name.trim()) return
    const { id, draft } = editing
    const name = draft.name.trim()
    if (id) {
      const firstSetup = !useApp.getState().profiles.find((p) => p.id === id)?.setupComplete
      await useApp.getState().updateProfileById(id, (p) => {
        // No evidence yet? Then the self-reported experience still sets the starting estimates.
        const untouched = !p.assessment && Object.values(p.skills).every((s) => s.evidence === 0)
        return {
          ...p, ...draft, name, setupComplete: true,
          skills: untouched ? createProfile(name, draft.background).skills : p.skills
        }
      })
      setEditing(null)
      if (firstSetup && !useApp.getState().profile?.assessment) setView('assessment')
    } else {
      const p = createProfile(name, draft.background)
      p.preferences = draft.preferences
      p.setupComplete = true
      await addProfile(p)
      setEditing(null)
      setView('assessment')
    }
  }

  const doExport = async (p: Profile) => {
    const ok = await api().profiles.exportToFile(JSON.stringify(exportProfile(p), null, 2), `${p.name.replace(/\W+/g, '_')}.smithprofile.json`)
    if (ok) setMsg('Profile exported.')
  }

  const doImport = async () => {
    setMsg(null)
    const text = await api().profiles.importFromFile()
    if (!text) return
    try {
      const raw = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || !raw.name || !raw.skills) throw new Error('Not a Smith Tutor profile file')
      let p = migrateProfile(raw)
      // A new id if it clashes, or isn't a plain id (the file name is made from it).
      if (!/^[\w-]+$/.test(String(p.id ?? '')) || profiles.some((x) => x.id === p.id)) p = { ...p, id: createProfile(p.name).id, name: profiles.some((x) => x.name === p.name) ? `${p.name} (imported)` : p.name }
      await addProfile(p)
      if (!p.setupComplete) {
        setEditing({ id: p.id, draft: draftOf(p) })
        setMsg(`Imported "${p.name}". Check the details below, then continue to the placement test.`)
      } else setMsg(`Imported "${p.name}".`)
    } catch (e) {
      setMsg(`Import failed: ${(e as Error).message}`)
    }
  }

  return (
    <div className="page">
      <div className="row">
        <h2>Profiles</h2>
        <span className="spacer" />
        <button onClick={() => setEditing({ id: null, draft: blank() })}>+ New profile</button>
        <button onClick={doImport}>Import…</button>
      </div>
      <p className="muted">
        Each profile has its own skills, history, tutor memory and chart workspace. <b>Export</b> saves a profile to a file for backup or another PC.
      </p>
      {msg && <div className="note">{msg}</div>}

      {editing && <ProfileForm draft={editing.draft} isNew={!editing.id} firstRun={!!editing.id && editing.id === active?.id && !active?.setupComplete} onChange={(draft) => setEditing({ ...editing, draft })} onSave={saveDraft} onCancel={() => setEditing(null)} />}

      <div className="profile-list">
        {profiles.map((p) => {
          const { level, avg } = overallLevel(p.skills)
          return (
            <div key={p.id} className={`profile-card ${p.id === active?.id ? 'active' : ''}`}>
              <div className="row">
                <b>{p.name}</b>
                {p.id === active?.id && <span className="chip ok">active</span>}
                <span className="spacer" />
                <span className="muted small">{p.assessment ? level : 'not assessed'} · {Math.round(avg * 100)}% · {lessonsOf(p).length} {lessonsOf(p).length === 1 ? 'lesson' : 'lessons'}</span>
              </div>
              <div className="muted small">{p.background.experience}{p.background.goals ? ` · ${p.background.goals}` : ''}</div>
              <div className="row wrap">
                {p.id !== active?.id && <button onClick={() => switchTo(p.id)} disabled={busy} title={busy ? 'Wait for the tutor to finish' : undefined}>Switch to</button>}
                <button onClick={() => setEditing({ id: p.id, draft: { name: p.name, background: p.background, preferences: p.preferences } })}>Edit</button>
                {!p.assessment && p.id === active?.id && <button className="primary" onClick={() => setView('assessment')}>Take placement test</button>}
                <button onClick={() => doExport(p)} title="Everything, including history: backup or move to another PC">Export</button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => window.confirm(`Delete profile "${p.name}" and all its history? This cannot be undone.`) && deleteProfile(p.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          )
        })}
      </div>
      <button className="link" onClick={() => api().files.openDataFolder()}>Open data folder</button>
    </div>
  )
}

function ProfileForm({ draft, isNew, firstRun, onChange, onSave, onCancel }: { draft: Draft; isNew: boolean; firstRun?: boolean; onChange(d: Draft): void; onSave(): void; onCancel(): void }) {
  const bg = (patch: Partial<Draft['background']>) => onChange({ ...draft, background: { ...draft.background, ...patch } })
  const pref = (patch: Partial<Draft['preferences']>) => onChange({ ...draft, preferences: { ...draft.preferences, ...patch } })
  return (
    <div className="card form">
      <h3>{firstRun ? 'Welcome! Tell your tutor about you' : isNew ? 'New profile' : 'Edit profile'}</h3>
      {firstRun && <p className="muted small">Takes a minute. Next comes a short placement test, then you connect a model and start learning. You can change all of this later.</p>}
      <div className="grid2">
        <label>Name <input autoFocus value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} /></label>
        <label>Smith chart experience
          <select value={draft.background.experience} onChange={(e) => bg({ experience: e.target.value as Draft['background']['experience'] })}>
            <option value="new">New: never really used one</option>
            <option value="basics">Basics: know what it is, rusty</option>
            <option value="intermediate">Intermediate: can do L-matches</option>
            <option value="advanced">Advanced: stubs, broadband, measured data</option>
          </select>
        </label>
        <label>Role / background <input value={draft.background.role} placeholder="e.g. antenna design engineer, EE student" onChange={(e) => bg({ role: e.target.value })} /></label>
        <label>Tutor style
          <select value={draft.preferences.tutorStyle} onChange={(e) => pref({ tutorStyle: e.target.value as Draft['preferences']['tutorStyle'] })}>
            <option value="socratic">Socratic: make me think, no answers</option>
            <option value="balanced">Balanced: questions plus explanations when stuck</option>
            <option value="direct">Direct: explain, then quiz me</option>
          </select>
        </label>
        <label className="span2">Goals <input value={draft.background.goals} placeholder="e.g. match my 2.4 GHz patch from CST data; interview prep" onChange={(e) => bg({ goals: e.target.value })} /></label>
        <label className="span2">Notes for the tutor
          <textarea rows={3} value={draft.background.mentorNotes} placeholder="Anything the tutor should know: how they learn best, what to emphasise, what to avoid…" onChange={(e) => bg({ mentorNotes: e.target.value })} />
        </label>
        <label>Default Z0 (Ω) <input type="number" value={draft.preferences.defaultZ0} onChange={(e) => pref({ defaultZ0: Number(e.target.value) || 50 })} /></label>
      </div>
      <div className="row">
        <button className="primary" onClick={onSave} disabled={!draft.name.trim()}>{isNew ? 'Create & take placement test' : firstRun ? 'Continue to placement test' : 'Save'}</button>
        {!firstRun && <button onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  )
}
