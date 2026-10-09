import { applyEvidence, JUDGEMENT_CAP, overallLevel, setMastery, SKILLS, skillName, type Outcome, type SkillId } from '@shared/profile'
import { skillStanding, standingForTutor } from '@shared/standing'
import { forgetNote, inferTopic, learnerBrief, misconceptionSignOff, NOTE_CATEGORIES, saveNote, TOPIC_IDS, topicDef, type NoteCategory, type TopicId } from '@shared/memory'
import { SIGNOFF_WORDS, type Observation } from '@shared/signoff'
import { addSlips, CONFUSION_IDS, CONFUSIONS, patternNews, patternsOf, type Confusion } from '@shared/patterns'
import { defineTools, type ToolContext } from '../types'

const SKILL_IDS = SKILLS.map((s) => s.id)
const checkSkill = (s: string): SkillId => {
  if (!SKILL_IDS.includes(s as SkillId)) throw new Error(`Unknown skill "${s}". Valid: ${SKILL_IDS.join(', ')}`)
  return s as SkillId
}

/**
 * Guardrails that hold regardless of model quality: the learner model only
 * changes in response to something the learner actually did, and each skill
 * gets at most one evidence update per learner turn.
 */
const recorded = new Set<string>()
function requireObservation(ctx: ToolContext, skill?: string) {
  const turn = ctx.learnerTurns()
  if (turn === 0) {
    throw new Error('Nothing observed yet this session. Only update the learner model after the learner answers, predicts or attempts something.')
  }
  if (skill) {
    const key = `${ctx.profile().id}:${ctx.session()?.id ?? 'none'}:${turn}:${skill}`
    if (recorded.has(key)) throw new Error(`Already recorded evidence for ${skill} this turn. One update per skill per learner turn.`)
    recorded.add(key)
  }
}

export default defineTools([
  {
    name: 'set_next_focus',
    description:
      'Decide what the learner should work on next: 1–3 skills (optionally the topic within each), most important first, each with a short reason written to them. ' +
      'This is THE plan: their Progress page and the lesson launcher show it, and your next lesson starts from it. ' +
      'Decide from the brief: their goals, live misconceptions, reviews due, gaps to the strong target, what opens up other skills, and what you saw today. ' +
      'Set it at the end of every lesson (before complete_lesson) and whenever the picture changes; replace it rather than keeping a stale one.',
    parameters: {
      type: 'object',
      properties: {
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              skill: { type: 'string', enum: SKILL_IDS },
              topic: { type: 'string', enum: TOPIC_IDS, description: 'Optional: the topic inside that skill' },
              why: { type: 'string', description: 'One short sentence to the learner, e.g. "You mix up which way a shunt L turns; two quick wins will lock it in."' }
            },
            required: ['skill', 'why']
          }
        }
      },
      required: ['picks']
    },
    activity: () => 'Planning what to work on next',
    async run(a, ctx) {
      const raw: any[] = Array.isArray(a.picks) ? a.picks : a.picks ? [a.picks] : []
      if (!raw.length) throw new Error('Give 1–3 picks: [{ skill, topic?, why }].')
      const p = ctx.profile()
      const rows = skillStanding(p, new Date().toISOString())
      const advice: string[] = []
      const picks = raw.slice(0, 3).map((x) => {
        const skill = checkSkill(String(x.skill))
        const row = rows.find((r) => r.id === skill)!
        // A weak prerequisite is advice, not a wall: the number may be under-rated (one miss, an answer
        // filed under the wrong skill), and refusing the plan only loops it back to the prerequisite.
        if (row.status === 'locked') {
          const pct = row.needs.map((n) => `${n} ${Math.round(p.skills[n].mastery * 100)}%`).join(', ')
          advice.push(`${skill} builds on ${row.needs.join(' and ')} (${pct}, below 50%): open that lesson with a quick check of ${row.needs.join(' and ')}; if they get it, carry on with ${skill}, if not, teach that first`)
        }
        let topic: TopicId | undefined
        if (x.topic) {
          if (!TOPIC_IDS.includes(x.topic) || topicDef(x.topic)!.skill !== skill) throw new Error(`Topic "${x.topic}" is not part of ${skill}. Its topics: ${TOPIC_IDS.filter((t) => topicDef(t)!.skill === skill).join(', ') || 'none'}.`)
          topic = x.topic as TopicId
        }
        const why = String(x.why ?? '').trim()
        if (!why) throw new Error(`Give a short "why" for ${skill}, written to the learner.`)
        return { skill, ...(topic ? { topic } : {}), why: why.slice(0, 160) }
      })
      if (new Set(picks.map((x) => x.skill)).size !== picks.length) throw new Error('Each skill once; put the topic in "topic".')
      const s = ctx.session()
      await ctx.updateProfile((pr) => ({ ...pr, nextFocus: { picks, at: new Date().toISOString(), model: s?.models?.at(-1), session: s?.id } }))
      return `Plan saved: ${picks.map((x, i) => `${i + 1}. ${skillName(x.skill)}${x.topic ? ` (${x.topic})` : ''}`).join(', ')}. The learner sees it on Progress and when starting a lesson.${advice.length ? ` Advice: ${advice.join('; ')}.` : ''}`
    }
  },
  {
    name: 'get_learner_profile',
    description: 'Full learner model: the planning brief (skills, weak and due topics, misconceptions, recent items, notes, last lessons) plus per-topic statistics and the placement-test result. The brief is already in your instructions; call this only for detail.',
    parameters: { type: 'object', properties: {} },
    activity: () => 'Reviewing your profile',
    run(_a, ctx) {
      const p = ctx.profile()
      return {
        name: p.name,
        background: p.background,
        preferences: p.preferences,
        level: overallLevel(p.skills),
        skills: SKILLS.map((s) => ({
          id: s.id, name: s.name, mastery: p.skills[s.id].mastery, confidence: p.skills[s.id].confidence,
          evidence: p.skills[s.id].evidence, last_practiced: p.skills[s.id].lastPracticed ?? null
        })),
        next_focus: p.nextFocus ?? null,
        standing: standingForTutor(p, new Date().toISOString()),
        open_misconceptions: p.misconceptions.filter((m) => !m.resolved).map((m) => {
          const so = misconceptionSignOff(p, m)
          return { ...m, status: SIGNOFF_WORDS[so.status], evidence: `${so.points} of ${so.required}`, needs: so.needed, why_this_bar: so.why }
        }),
        brief: learnerBrief(p, new Date().toISOString()).text,
        patterns: patternsOf(p).map((x) => ({ confusion: x.confusion, name: x.name, status: x.status, seen: x.slips.length, topics: x.topics, lessons: x.lessons, last_seen: x.lastSeen, evidence: x.slips.slice(-4).map((s) => `${s.at.slice(0, 10)} ${s.topic ?? 'conversation'}: ${s.detail}`), root: x.root, check_with: x.probe })),
        topics: p.topics ?? {},
        notes: p.notes ?? [],
        placement_test: p.assessment ? { taken: p.assessment.takenAt, level: p.assessment.level, per_skill: p.assessment.perSkill } : null,
        recent_sessions: p.sessions.filter((s) => s.summary).slice(-5).map((s) => ({ date: s.startedAt, summary: s.summary, exercises: s.exercises }))
      }
    }
  },
  {
    name: 'record_evidence',
    description: 'Update the learner model after you observe them using a skill in a way the app cannot grade: an explanation, their reasoning, a good or confused question, an ungraded prediction. Graded tasks and questions are recorded automatically; don\'t record those again. Mastery moves by a fixed rule from outcome and difficulty (1 easy, 2 medium, 3 hard). ' +
      'Always say whether they gave the right reason and whether it was transfer (a new situation): with the topic, this is evidence the app uses to decide when a misconception is cleared.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: SKILL_IDS },
        outcome: { type: 'string', enum: ['correct', 'partial', 'incorrect'] },
        difficulty: { type: 'number', enum: [1, 2, 3] },
        reason: { type: 'string', enum: ['right', 'partial', 'wrong', 'none'], description: 'The reason they gave: right, partly right, wrong, or none (not given or not asked)' },
        transfer: { type: 'boolean', description: 'true if they did it in a new situation, different from where they learned it or got it wrong (other half of the chart, other side of r = 1, a different element or quantity, their own design)' },
        topic: { type: 'string', enum: TOPIC_IDS, description: 'The topic it was about, if one fits' },
        misconception: { type: 'string', description: 'The id of a live misconception this bears on, if any' },
        note: { type: 'string', description: 'What you observed (short)' }
      },
      required: ['skill', 'outcome', 'difficulty', 'reason', 'transfer']
    },
    activity: (a) => `Updating progress (${a.skill})`,
    async run(a, ctx) {
      const id = checkSkill(a.skill)
      if (!['correct', 'partial', 'incorrect'].includes(a.outcome)) throw new Error('"outcome" must be correct, partial or incorrect.')
      if (ctx.autoRecorded?.(id)) {
        throw new Error(`The app already recorded ${id} from that graded answer (see [Learner memory]). Use record_evidence only for things the app can't grade: explanations, reasoning, questions they ask.`)
      }
      if (!['right', 'partial', 'wrong', 'none'].includes(a.reason)) throw new Error('Give "reason": right, partial, wrong or none (the reason they gave for it).')
      if (typeof a.transfer !== 'boolean') throw new Error('Give "transfer": true if this was in a new situation (different from where they learned it or got it wrong), else false.')
      requireObservation(ctx, id)
      const d = ([1, 2, 3].includes(Number(a.difficulty)) ? Number(a.difficulty) : 2) as 1 | 2 | 3
      const topic = TOPIC_IDS.includes(a.topic) && topicDef(a.topic)?.skill === id ? (a.topic as TopicId) : undefined
      const session = ctx.session()?.id ?? 'none'
      const now = new Date().toISOString()
      let before = 0, after = 0
      const signoff: string[] = []
      await ctx.updateProfile((p) => {
        before = p.skills[id].mastery
        // Judgement from a conversation the tutor steers: half weight, and never past JUDGEMENT_CAP.
        // ...and it adds no confidence: only graded answers should narrow the estimate.
        const next = applyEvidence(p.skills[id], a.outcome as Outcome, d, a.note ? `tutor: ${a.note}` : 'tutor', { weight: 0.5, cap: JUDGEMENT_CAP, trust: 0 })
        after = next.mastery
        const live = p.misconceptions.find((m) => m.id === a.misconception)
        const ob: Observation = {
          at: now, session, skill: id, ...(topic ? { topic } : {}), ...(live ? { misconception: live.id } : {}),
          outcome: a.outcome, reason: a.reason, transfer: a.transfer, ...(a.note ? { note: String(a.note).slice(0, 120) } : {})
        }
        const q: typeof p = { ...p, skills: { ...p.skills, [id]: next }, observations: [...(p.observations ?? []), ob].slice(-150) }
        // The misconceptions it bears on: does this evidence clear them? (Never in the lesson they appeared.)
        return {
          ...q,
          misconceptions: q.misconceptions.map((m) => {
            const bears = m.id === ob.misconception || (!!topic && inferTopic(m) === topic)
            if (!bears || m.resolved || ob.outcome === 'incorrect') return m
            if ((m.sessions ?? []).includes(session)) {
              signoff.push(`"${m.description}": doesn't count toward clearing it (same lesson it appeared in)`)
              return m
            }
            const so = misconceptionSignOff(q, m, p)
            if (so.status === 'cleared' || so.status === 'confirmed') {
              signoff.push(`"${m.description}": cleared, provisionally (${so.why}); say so and check it again in a later lesson, don't call it fixed`)
              return { ...m, resolved: true, resolvedAt: now }
            }
            signoff.push(`"${m.description}": ${SIGNOFF_WORDS[so.status]} (evidence ${so.points} of ${so.required}); still needs ${so.needed}`)
            return m
          })
        }
      })
      return { skill: id, mastery_before: before, mastery_after: after, ...(signoff.length ? { misconceptions: signoff.join('; ') } : {}) }
    }
  },
  {
    name: 'set_skill_level',
    description: 'Override a skill\'s mastery (0–1) when your overall judgement differs from the tracked value (e.g. a placement result was a lucky guess). You can lower it freely; raising it stops at 0.6, because only graded tasks and questions can show a skill is strong. Give a reason.',
    parameters: {
      type: 'object',
      properties: { skill: { type: 'string', enum: SKILL_IDS }, mastery: { type: 'number' }, reason: { type: 'string' } },
      required: ['skill', 'mastery', 'reason']
    },
    activity: (a) => `Adjusting level (${a.skill})`,
    async run(a, ctx) {
      const id = checkSkill(a.skill)
      requireObservation(ctx)
      const m = Number(a.mastery)
      if (!Number.isFinite(m) || m < 0 || m > 1) throw new Error('"mastery" must be a number from 0 to 1.')
      await ctx.updateProfile((p) => ({ ...p, skills: { ...p.skills, [id]: setMastery(p.skills[id], m, `override: ${a.reason}`) } }))
      return 'Updated.'
    }
  },
  {
    name: 'log_misconception',
    description: 'Record a specific misconception or recurring mistake you noticed in conversation (e.g. "thinks a series L turns counter-clockwise"). Give the topic when there is one: then graded answers on that topic close it automatically (right in two separate lessons) and reopen it on a slip, and repeats are merged instead of duplicated. Give the underlying "confusion" when one fits: it joins the same record as the app\'s graded detection, so patterns across topics and lessons are seen. Wrong graded answers are recorded automatically.',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', enum: SKILL_IDS },
        topic: { type: 'string', enum: TOPIC_IDS, description: 'The specific topic, if one fits' },
        confusion: { type: 'string', enum: CONFUSION_IDS, description: 'The underlying confusion, if one fits: ' + CONFUSION_IDS.map((c) => `${c} (${CONFUSIONS[c].name})`).join('; ') },
        description: { type: 'string' }
      },
      required: ['skill', 'description']
    },
    activity: () => 'Noting a misconception',
    async run(a, ctx) {
      const id = checkSkill(a.skill)
      requireObservation(ctx)
      const given = TOPIC_IDS.includes(a.topic) && topicDef(a.topic)?.skill === id ? (a.topic as TopicId) : undefined
      // No topic given: take it from the wording when that's clear, so answers can still close it.
      const inferred = inferTopic({ description: String(a.description), skill: id })
      const topic = given ?? (inferred && topicDef(inferred)?.skill === id ? inferred : undefined)
      const now = new Date().toISOString()
      let count = 1
      const confusion = CONFUSION_IDS.includes(a.confusion) ? (a.confusion as Confusion) : undefined
      let news: string[] = []
      if (confusion) {
        await ctx.updateProfile((p) => {
          const next = addSlips(p, [{ confusion, detail: `in conversation: ${String(a.description).slice(0, 120)}` }], { at: now, session: ctx.session()?.id ?? 'none', topic, source: 'tutor' })
          news = patternNews(p, next)
          return next
        })
      }
      await ctx.updateProfile((p) => {
        const key = String(a.description).trim().toLowerCase()
        // Same topic = the same misconception (merged, newest wording kept); otherwise match the text.
        const existing = p.misconceptions.find((m) => (topic && inferTopic(m) === topic) || m.description.trim().toLowerCase() === key)
        if (existing) {
          count = existing.count + 1
          const session = ctx.session()?.id
          return {
            ...p,
            misconceptions: p.misconceptions.map((m) => (m === existing
              ? {
                  ...m, count, lastSeen: now, resolved: false, resolvedAt: undefined, description: String(a.description), topic: topic ?? m.topic,
                  ...(session && !(m.sessions ?? []).includes(session) ? { sessions: [...(m.sessions ?? []), session].slice(-8) } : {}),
                  ...(m.resolved ? { relapses: (m.relapses ?? 0) + 1 } : {})
                }
              : m))
          }
        }
        return {
          ...p,
          misconceptions: [...p.misconceptions, { id: `mc_${Date.now().toString(36)}`, skill: id, ...(topic ? { topic } : {}), description: a.description, count: 1, firstSeen: now, lastSeen: now, resolved: false, ...(ctx.session()?.id ? { sessions: [ctx.session()!.id] } : {}) }]
        }
      })
      return { recorded: true, times_seen: count, ...(topic ? { clears_automatically: 'from right answers in later lessons (never this one), against a bar set by this learner\'s record and how deep it is: the app decides, so don\'t tell them it\'s fixed' } : {}), ...(news.length ? { pattern: news.join(' ') } : {}) }
    }
  },
  {
    name: 'resolve_misconception',
    description: 'Remove a misconception that was recorded by mistake: it was never theirs (a misread answer, a slip of the mouse, a typo). Not for one they have overcome: the app clears those from evidence in later lessons (graded answers, and your record_evidence with reason and transfer), so record that evidence instead.',
    parameters: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string', description: 'Why it was recorded by mistake' } }, required: ['id', 'why'] },
    activity: () => 'Removing a misconception recorded by mistake',
    async run(a, ctx) {
      const why = String(a.why ?? '').trim()
      if (!why) throw new Error('Say why it was recorded by mistake. If they have overcome it, don\'t remove it: record_evidence (with reason and transfer) in a later lesson, and the app clears it.')
      const m = ctx.profile().misconceptions.find((x) => x.id === a.id)
      if (!m) throw new Error(`No misconception with id "${a.id}".`)
      await ctx.updateProfile((p) => ({ ...p, misconceptions: p.misconceptions.filter((x) => x.id !== a.id) }))
      return `Removed "${m.description}" (recorded by mistake: ${why.slice(0, 100)}).`
    }
  },
  {
    name: 'save_note',
    description: 'Save a durable note about this learner that the app can\'t work out from graded answers. Categories: goal (what they\'re working towards, e.g. their antenna project), preference (how they like to learn), clicked (an explanation or analogy that worked), struggle (a difficulty that isn\'t a single misconception), other. Keep it short and specific. To change a note, pass its id as replaces; a near-duplicate is replaced automatically. Only a few are kept per category, so save what will matter in future lessons, not what happened today.',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string' },
        category: { type: 'string', enum: [...NOTE_CATEGORIES] },
        replaces: { type: 'string', description: 'Id of a note this updates' }
      },
      required: ['note', 'category']
    },
    activity: () => 'Saving a note',
    async run(a, ctx) {
      const category = (NOTE_CATEGORIES.includes(a.category) ? a.category : 'other') as NoteCategory
      let id = ''
      let replaced: string | undefined
      await ctx.updateProfile((p) => {
        const r = saveNote(p, { category, text: String(a.note), replaces: a.replaces }, new Date().toISOString())
        id = r.id
        replaced = r.replaced
        return r.profile
      })
      return replaced ? `Updated note ${id}.` : `Saved as ${id}.`
    }
  },
  {
    name: 'forget_note',
    description: 'Delete a note that is no longer true or useful (an old goal, a struggle they have overcome).',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    activity: () => 'Tidying notes',
    async run(a, ctx) {
      let found = false
      await ctx.updateProfile((p) => {
        found = (p.notes ?? []).some((n) => n.id === a.id)
        return forgetNote(p, String(a.id))
      })
      if (!found) throw new Error(`No note with id "${a.id}". Note ids are shown in brackets in the learner brief.`)
      return 'Forgotten.'
    }
  }
])
