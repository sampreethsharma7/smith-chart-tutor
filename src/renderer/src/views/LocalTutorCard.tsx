import { useEffect, useState } from 'react'
import { LOCAL_MODELS, ollamaDownloadGB, recommendLocal } from '@shared/localModels'
import { useApp } from '@/state/app'
import { useLocalSetup } from '@/state/localSetup'

const gb = (x: number) => `${x < 10 ? x.toFixed(1) : Math.round(x)} GB`

/**
 * A free local tutor in one click: what this computer can run, the model the tutor benchmark
 * recommends for it, setup (Ollama included, no admin rights), and how fast it really runs here.
 */
export function LocalTutorCard() {
  const activeId = useApp((s) => s.settings.activeProviderId)
  const { setActiveProvider } = useApp.getState()
  const { running, done, error, info, probeError: probeErr, start, cancel } = useLocalSetup()
  const [choice, setChoice] = useState<string | null>(null)

  // Check the machine on opening (the last result shows meanwhile; setups re-check it themselves).
  useEffect(() => {
    useLocalSetup.getState().probe()
  }, [])

  if (probeErr) return <div className="connection local-card"><b>Free local tutor (Ollama)</b><div className="error">Couldn’t check this computer: {probeErr}</div></div>
  if (!info) return <div className="connection local-card"><b>Free local tutor (Ollama)</b> <span className="muted small dots">Checking this computer</span></div>

  const { machine: m, status: st } = info
  const rec = recommendLocal(m)
  const model = running?.model ?? choice ?? rec.pick?.model ?? null
  const spec = LOCAL_MODELS.find((x) => x.model === model)
  const haveModel = !!model && st.models.includes(model)
  const needOllama = !st.running && !st.binary
  const downloadGB = (needOllama ? ollamaDownloadGB(m.platform, m.arch) : 0) + (haveModel || !spec ? 0 : spec.downloadGB)

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

      <div className="local-rec">
        {rec.pick && <div><b>Recommended: {rec.pick.model}</b>{model && model !== rec.pick.model && <span className="muted small"> (you chose {model})</span>}</div>}
        <div className="small">{rec.reason}</div>
        {rec.caution && <div className="small warn">{rec.caution}</div>}
      </div>

      {running ? (
        <div className="local-progress">
          <div className="small">{running.progress.text}</div>
          <div className="progressbar"><div style={{ width: running.progress.fraction !== undefined ? `${Math.round(running.progress.fraction * 100)}%` : '100%' }} className={running.progress.fraction === undefined ? 'indeterminate' : ''} /></div>
          <div className="row">
            <button className="link" onClick={cancel}>Cancel</button>
            <span className="muted small">You can use the rest of the app meanwhile; this keeps going.</span>
          </div>
        </div>
      ) : model && (
        <div className="row wrap">
          <button className="primary" onClick={() => start(model)}>
            {haveModel && st.running ? `Check speed and add ${model}` : `Set up ${model}`}
          </button>
          {downloadGB > 0 && <span className="muted small">downloads {st.running ? 'about' : 'up to'} {gb(downloadGB)}</span>}
          {rec.smaller && model !== rec.smaller.model && <button className="link" onClick={() => setChoice(rec.smaller!.model)}>or the smaller {rec.smaller.model}</button>}
          {rec.pick && model !== rec.pick.model && <button className="link" onClick={() => setChoice(null)}>back to {rec.pick.model}</button>}
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {done && !running && (
        <div className={`local-result verdict-${done.verdict.verdict}`}>
          <div className="small">
            <b>{done.verdict.verdict === 'good' ? '✓' : done.verdict.verdict === 'ok' ? '~' : '!'} {done.model} is ready.</b> {done.verdict.text}
            {done.loadS >= 2 && ` The first answer of a session also waits about ${Math.round(done.loadS)} s while the model loads.`}
          </div>
          <div className="row wrap">
            {activeId === done.providerId ? <span className="chip ok">your tutor</span> : <button className="primary" onClick={() => setActiveProvider(done.providerId)}>Use as tutor</button>}
            {done.verdict.verdict === 'slow' && rec.smaller && done.model !== rec.smaller.model && (
              <button onClick={() => { setChoice(rec.smaller!.model); start(rec.smaller!.model) }}>Try the smaller {rec.smaller.model}</button>
            )}
            {done.verdict.verdict === 'slow' && <span className="muted small">or add a cloud model below for faster answers</span>}
          </div>
        </div>
      )}
    </div>
  )
}
