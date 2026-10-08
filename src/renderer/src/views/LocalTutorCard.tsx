import { useEffect, useState } from 'react'
import { modelLabel, type Connection, type ProviderConfig } from '@shared/llm'
import { judgeSpeed, LOCAL_MODELS, ollamaDownloadGB, recommendLocal, type MachineInfo, type OllamaStatus, type SetupProgress, type SpeedVerdict } from '@shared/localModels'
import { api, useApp } from '@/state/app'

const uid = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const gb = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)} GB`

/** Add the model under an Ollama connection (creating it if needed); returns the model's id. */
async function addToModels(model: string, apiBase: string): Promise<string> {
  const { settings, saveConfig } = useApp.getState()
  const connections = [...settings.connections]
  let c = connections.find((x) => x.preset === 'ollama')
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

/**
 * A free local tutor in one click: what this computer can run, the model the tutor benchmark
 * recommends for it, setup (Ollama included, no admin rights), and how fast it really runs here.
 */
export function LocalTutorCard() {
  const activeId = useApp((s) => s.settings.activeProviderId)
  const { setActiveProvider } = useApp.getState()
  const [info, setInfo] = useState<{ machine: MachineInfo; status: OllamaStatus } | null>(null)
  const [probeErr, setProbeErr] = useState<string | null>(null)
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ id: string; p: SetupProgress } | null>(null)
  const [done, setDone] = useState<{ model: string; providerId: string; v: SpeedVerdict; loadS: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const probe = () => api().local.probe().then(setInfo, (e) => setProbeErr((e as Error).message))
  useEffect(() => { probe() }, [])

  if (probeErr) return <div className="connection local-card"><b>Free local tutor (Ollama)</b><div className="error">Couldn’t check this computer: {probeErr}</div></div>
  if (!info) return <div className="connection local-card"><b>Free local tutor (Ollama)</b> <span className="muted small dots">Checking this computer</span></div>

  const { machine: m, status: st } = info
  const rec = recommendLocal(m)
  const model = choice ?? rec.pick?.model ?? null
  const spec = LOCAL_MODELS.find((x) => x.model === model)
  const haveModel = !!model && st.models.includes(model)
  const needOllama = !st.running && !st.binary
  const downloadGB = (needOllama ? ollamaDownloadGB(m.platform, m.arch) : 0) + (haveModel || !spec ? 0 : spec.downloadGB)

  const setup = async (which: string) => {
    setErr(null)
    setDone(null)
    const { id, done: finished } = api().local.setup(which, (p) => setBusy({ id, p }))
    setBusy({ id, p: { step: 'start', text: 'Starting…' } })
    const r = await finished
    setBusy(null)
    if (!r.ok) {
      setErr(r.error)
    } else {
      const providerId = await addToModels(which, r.apiBase)
      setDone({ model: which, providerId, v: judgeSpeed(r.speed), loadS: r.speed.loadS })
    }
    probe()
  }

  const machineLine = [
    m.gpu ? (m.gpu.kind === 'apple' ? `${m.gpu.name} (memory shared with the GPU)` : `${m.gpu.name}${/GPU/i.test(m.gpu.name) ? '' : ' GPU'}, ${gb(m.gpu.memoryGB)}`) : 'No NVIDIA or Apple GPU found',
    `${gb(m.ramGB)} memory`
  ].join(' · ')
  const ollamaLine = st.running
    ? `Ollama ${st.version} is running${st.models.length ? `, ${st.models.length} model${st.models.length === 1 ? '' : 's'} downloaded` : ''}.`
    : st.binary
      ? 'Ollama is installed; the app starts it when needed.'
      : 'Ollama isn’t installed: the app sets up its own copy, with no admin rights.'

  return (
    <div className="connection local-card">
      <div className="row">
        <b>Free local tutor (Ollama)</b>
        <span className="muted small">runs on this computer: no API key, no cost, works offline</span>
      </div>
      <div className="small">This computer: {machineLine}. {ollamaLine}</div>

      {rec.pick ? (
        <div className="local-rec">
          <div><b>Recommended: {rec.pick.model}</b>{choice && choice !== rec.pick.model && <span className="muted small"> (you chose {choice})</span>}</div>
          <div className="small">{rec.reason}</div>
          {rec.caution && <div className="small warn">{rec.caution}</div>}
        </div>
      ) : (
        <div className="local-rec">
          <div className="small">{rec.reason}</div>
          {rec.caution && <div className="small warn">{rec.caution}</div>}
        </div>
      )}

      {busy ? (
        <div className="local-progress">
          <div className="small">{busy.p.text}</div>
          <div className="progressbar"><div style={{ width: busy.p.fraction !== undefined ? `${Math.round(busy.p.fraction * 100)}%` : '100%' }} className={busy.p.fraction === undefined ? 'indeterminate' : ''} /></div>
          <button className="link" onClick={() => api().local.cancel(busy.id)}>Cancel</button>
        </div>
      ) : model && (
        <div className="row wrap">
          <button className="primary" onClick={() => setup(model)}>
            {haveModel && st.running ? `Check speed and add ${model}` : `Set up ${model}`}
          </button>
          {downloadGB > 0 && <span className="muted small">downloads {st.running ? 'about' : 'up to'} {gb(downloadGB)}; you can keep using the app meanwhile</span>}
          {rec.smaller && model !== rec.smaller.model && <button className="link" onClick={() => setChoice(rec.smaller!.model)}>or the smaller {rec.smaller.model}</button>}
          {choice && rec.pick && choice !== rec.pick.model && <button className="link" onClick={() => setChoice(null)}>back to {rec.pick.model}</button>}
        </div>
      )}

      {err && <div className="error">{err}</div>}

      {done && (
        <div className={`local-result verdict-${done.v.verdict}`}>
          <div className="small">
            <b>{done.v.verdict === 'good' ? '✓' : done.v.verdict === 'ok' ? '~' : '!'} {done.model} is ready.</b> {done.v.text}
            {done.loadS >= 2 && ` The first answer of a session also waits about ${Math.round(done.loadS)} s while the model loads.`}
          </div>
          <div className="row wrap">
            {activeId === done.providerId ? <span className="chip ok">your tutor</span> : <button className="primary" onClick={() => setActiveProvider(done.providerId)}>Use as tutor</button>}
            {done.v.verdict === 'slow' && rec.smaller && done.model !== rec.smaller.model && (
              <button onClick={() => { setChoice(rec.smaller!.model); setup(rec.smaller!.model) }}>Try the smaller {rec.smaller.model}</button>
            )}
            {done.v.verdict === 'slow' && <span className="muted small">or add a cloud model below for faster answers</span>}
          </div>
        </div>
      )}
    </div>
  )
}
