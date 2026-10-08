import { useMemo } from 'react'
import type { Profile } from '@shared/profile'
import { skillName } from '@shared/profile'
import { calibrationOf } from '@shared/memory'
import { startLesson } from '@/state/journey'
import {
  BENCHMARKS, overall, plannedFocus, probeTargets, skillStanding, topicStanding, ZONES,
  type SkillStanding, type TopicStanding, type TopicState
} from '@shared/standing'

/**
 * "Where you stand": the learner against two targets (strong and top), skill by
 * skill and topic by topic, and the few things that would move them most.
 * Blue is you, green is the top target (the same green as task targets on the chart).
 */
export function Standing({ profile }: { profile: Profile }) {
  const now = new Date().toISOString()
  const rows = useMemo(() => skillStanding(profile, now), [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  const topics = useMemo(() => topicStanding(profile, now), [profile]) // eslint-disable-line react-hooks/exhaustive-deps
  const o = overall(rows)
  // The pick is the tutor's (set_next_focus); the app only adds the facts for each skill.
  const plan = plannedFocus(profile, rows)
  const probe = probeTargets(rows)
  const nf = profile.nextFocus

  return (
    <div className="standing">
      <div className="stand-hero">
        <div className="stand-hero-head">
          <div>
            <div className="stand-level">{o.level}</div>
            <div className="muted small">{o.headline}</div>
          </div>
          <span className="spacer" />
          <div className="pips" title={`${o.atStrong} of ${o.total} skills at strong level, ${o.atTop} at top level`}>
            {rows.map((r) => (
              <i key={r.id} className={r.status === 'top' || r.status === 'strong' || r.status === 'provisional' ? r.status : ''} title={`${r.name}: ${Math.round(r.mastery * 100)}%${r.status === 'provisional' ? ' (provisional: not proven yet)' : ''}`} />
            ))}
            <span className="muted small">skills at strong</span>
          </div>
        </div>
        <Scale value={o.avg} />
        {probe.length > 0 && (
          <div className="probe-row">
            <span className="small muted">Not sure the numbers are right? {probe.map((r) => r.name).join(', ')} {probe.length > 1 ? 'have' : 'has'} the least proof behind {probe.length > 1 ? 'them' : 'it'}.</span>
            <button onClick={() => startLesson('probe')} title="5–6 graded questions in a row, no teaching: it finds out what really holds">Check yourself (about 5 min)</button>
          </div>
        )}
      </div>

      <h3>Work on next {nf && <span className="muted small plan-by">· your tutor's plan, {new Date(nf.at).toLocaleDateString()}</span>}</h3>
      {plan.length > 0 ? (
        <div className="focus-cards">
          {plan.map((f, i) => (
            <div key={f.skill} className="focus-card">
              <div className="row"><b>{i + 1}. {f.name}</b></div>
              <Track r={f.row} compact />
              <p className="focus-why">{f.why}</p>
              <ul>{facts(f.row, f.topic && topics.find((t) => t.id === f.topic)).map((x) => <li key={x}>{x}</li>)}</ul>
              <button className="primary" onClick={() => startLesson(f.skill)}>Practise</button>
            </div>
          ))}
        </div>
      ) : (
        <div className="focus-empty muted small">
          Your tutor decides what to work on next at the end of each lesson, from everything below; it will appear here.{' '}
          <button className="link" onClick={() => startLesson()}>Start a lesson</button>
        </div>
      )}

      <h3>Skills</h3>
      <div className="stand-legend small">
        <span><i className="lg-you" /> you</span>
        <span><i className="lg-range" /> how sure (narrows with practice)</span>
        <span><i className="lg-strong" /> strong: {BENCHMARKS.strong.meaning}</span>
        <span><i className="lg-top" /> top: {BENCHMARKS.top.meaning}</span>
        <span title="A strong number counts only with proof: right on your own, in two lessons, at medium level or harder, in two different situations"><i className="lg-prov" /> provisional: high, not proven yet</span>
        <span className="topic-key">topics: {(['untried', 'shaky', 'building', 'strong', 'top'] as TopicState[]).map((s) => <span key={s}><b className={`tsq ${s}`} /> {TOPIC_WORD[s]}</span>)}</span>
      </div>
      <div className="ladder">
        <div className="ladder-axis">
          <span />
          <div className="axis">
            {ZONES.map((z) => <span key={z.label} style={{ left: `${z.from * 100}%`, width: `${(z.to - z.from) * 100}%` }}>{z.label}</span>)}
          </div>
          <span className="muted small">topics</span>
          <span />
        </div>
        {rows.map((r) => (
          <div key={r.id} className={`ladder-row ${r.status}`}>
            <span className="ladder-name" title={r.status === 'locked' ? `Builds on ${r.needs.map(skillName).join(' and ')}` : undefined}>
              {r.status === 'locked' && '🔒 '}{r.name}
            </span>
            <Track r={r} />
            <TopicSquares topics={topics.filter((t) => t.skill === r.id)} />
            <span className={`ladder-status ${r.status}`}>{statusText(r)}</span>
          </div>
        ))}
      </div>
      <p className="muted small">The targets come from how the app grades, not from other people: steady right answers at medium difficulty take a skill to {Math.round(BENCHMARKS.strong.mastery * 100)}% (strong); only the hardest level reaches {Math.round(BENCHMARKS.top.mastery * 100)}% (top). A number counts only with proof: answers right on your own (not after talking it through, and a lucky pick counts less), in two lessons and two different situations. The placement test and the tutor's impressions can't make a skill strong. Hover anything for details.</p>
      <SelfJudgement profile={profile} />
    </div>
  )
}

/** The facts behind a pick, from the same numbers as the bars below. */
function facts(r: SkillStanding, topic?: TopicStanding | false): string[] {
  const out: string[] = []
  if (topic) out.push(`topic: ${topic.name} (${TOPIC_WORD[topic.state]})`)
  if (r.openMisconceptions) out.push(`${r.openMisconceptions} misconception${r.openMisconceptions > 1 ? 's' : ''} to clear`)
  if (r.dueReviews) out.push(`${r.dueReviews} review${r.dueReviews > 1 ? 's' : ''} due`)
  out.push(r.status === 'provisional' ? `needs ${r.proof.missing}` : statusText(r))
  return out
}

const TOPIC_WORD: Record<TopicState, string> = { untried: 'not tried', shaky: 'shaky', building: 'building', strong: 'strong', top: 'top' }

function statusText(r: SkillStanding): string {
  switch (r.status) {
    case 'locked': return `after ${r.needs.map((n) => skillName(n).split(' ')[0]).join(', ')}`
    case 'unmeasured': return 'not measured'
    case 'top': return 'top ★'
    case 'provisional': return 'provisional: prove it'
    case 'strong': return `strong ✓ · ${Math.round(r.toTop * 100)} to top`
    default: return `${Math.round(r.toStrong * 100)} to strong`
  }
}

/** One skill on the 0–100 % scale: your bar, how sure we are, and the two targets. */
function Track({ r, compact = false }: { r: SkillStanding; compact?: boolean }) {
  const pct = (v: number) => `${v * 100}%`
  const proof = r.proof.right
    ? ` Proof: ${r.proof.right} right on their own, in ${r.proof.lessons} lesson${r.proof.lessons > 1 ? 's' : ''}, ${r.proof.contexts} situation${r.proof.contexts > 1 ? 's' : ''}, hardest level ${r.proof.hardest}.`
    : ' No graded answers on it yet.'
  const tip = `${r.name}: ${Math.round(r.mastery * 100)}% (likely ${Math.round(r.low * 100)}–${Math.round(r.high * 100)}%, from ${r.confidence < 0.3 ? 'little' : r.confidence < 0.7 ? 'some' : 'plenty of'} evidence).${proof}` +
    `${r.status === 'provisional' || r.status === 'strong' ? ` For ${r.status === 'strong' ? 'top' : 'strong'} it still needs ${r.proof.missing}.` : ''} ` +
    `Strong at ${Math.round(BENCHMARKS.strong.mastery * 100)}%, top at ${Math.round(BENCHMARKS.top.mastery * 100)}%.` +
    `${r.dueReviews ? ` ${r.dueReviews} topic review${r.dueReviews > 1 ? 's' : ''} due.` : ''}${r.openMisconceptions ? ` ${r.openMisconceptions} open misconception${r.openMisconceptions > 1 ? 's' : ''}.` : ''}`
  return (
    <div className={`track${compact ? ' compact' : ''}${r.status === 'unmeasured' ? ' unmeasured' : ''}`} title={tip}>
      {ZONES.slice(1).map((z) => <i key={z.label} className="zone-line" style={{ left: pct(z.from) }} />)}
      <i className="range" style={{ left: pct(r.low), width: pct(r.high - r.low) }} />
      <i className="you" style={{ width: pct(r.mastery) }} />
      <i className="tick strong" style={{ left: pct(BENCHMARKS.strong.mastery) }} />
      <i className="tick top" style={{ left: pct(BENCHMARKS.top.mastery) }} />
      {!compact && <span className="you-num" style={{ left: pct(r.mastery) }}>{Math.round(r.mastery * 100)}</span>}
    </div>
  )
}

/** The overall scale, with the level bands named and the two targets marked. */
function Scale({ value }: { value: number }) {
  const pct = (v: number) => `${v * 100}%`
  return (
    <div className="scale">
      <div className="scale-bands">
        {ZONES.map((z) => <span key={z.label} style={{ width: pct(z.to - z.from) }} className={value >= z.from && value < (z.to === 1 ? 1.01 : z.to) ? 'here' : ''}>{z.label}</span>)}
      </div>
      <div className="scale-track">
        <i className="you" style={{ width: pct(value) }} />
        <i className="tick strong" style={{ left: pct(BENCHMARKS.strong.mastery) }}><em>strong</em></i>
        <i className="tick top" style={{ left: pct(BENCHMARKS.top.mastery) }}><em>top</em></i>
        <b className="marker" style={{ left: pct(value) }}>you · {Math.round(value * 100)}%</b>
      </div>
    </div>
  )
}

/** A square per topic in the skill, coloured by how it's going; ↻ = review due. */
function TopicSquares({ topics }: { topics: TopicStanding[] }) {
  return (
    <span className="tsqs">
      {topics.map((t) => (
        <b
          key={t.id}
          className={`tsq ${t.state}${t.due ? ' due' : ''}`}
          title={t.state === 'untried'
            ? `${t.name}: not tried yet`
            : `${t.name}: ${TOPIC_WORD[t.state]}. ${t.correct} of ${t.seen} right (recent ${Math.round(t.recent * 100)}%); questions now at level ${t.level} of 3.${t.due ? ' Review due.' : ''}`}
        />
      ))}
    </span>
  )
}

/**
 * How well they judge themselves: of the answers they were sure of, unsure of or
 * guessed, how many were right. The honest answer to "do I really know this?".
 */
function SelfJudgement({ profile }: { profile: Profile }) {
  const c = calibrationOf(profile)
  const rows = [
    { key: 'sure', label: 'When you were sure', v: c.sure },
    { key: 'unsure', label: 'When you weren\'t sure', v: c.unsure },
    { key: 'guess', label: 'When you guessed', v: c.guess }
  ]
  const total = c.sure.n + c.unsure.n + c.guess.n
  const verdict = {
    under: 'You are right far more often than you feel. When you think "I\'m not sure", trust yourself a little more.',
    over: 'You are sometimes sure and wrong. Before you commit, check the move on the chart.',
    fair: 'Your feeling of "I know this" matches your results.',
    unknown: `After each graded question you say how sure you were. After ${Math.max(0, 5 - total)} more, this shows how well your feeling matches your results.`
  }[c.verdict]
  return (
    <>
      <h3>How well you judge yourself</h3>
      <div className="self-judge">
        {rows.map((r) => (
          <div key={r.key} className="sj-row" title={r.v.n ? `${r.v.right} of ${r.v.n} right` : 'No answers yet'}>
            <span>{r.label}</span>
            <div className="sj-bar"><i className={r.key} style={{ width: `${r.v.n ? (r.v.right / r.v.n) * 100 : 0}%` }} /></div>
            <span className="sj-num">{r.v.n ? `${Math.round((r.v.right / r.v.n) * 100)}% right` : '—'} <span className="muted">({r.v.n})</span></span>
          </div>
        ))}
        <p className={`sj-verdict ${c.verdict}`}>{verdict}</p>
      </div>
    </>
  )
}
