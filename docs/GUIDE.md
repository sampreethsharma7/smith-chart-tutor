# Smith Chart Tutor: the full guide

Everything the app does and how it decides, in detail. For an overview, see the [README](../README.md).

A desktop Smith chart with an agentic AI tutor. The chart shows every metric (Z, z, Y, y, Γ, VSWR, return loss, mismatch loss, Q, WTG/WTL, equivalent L/C) on hover and at target-frequency markers. Hovering on or near a sweep trace snaps to it and shows that point's frequency, since a Smith chart has no frequency axis of its own. The tutor watches what you do on the chart, sets exercises, remembers your progress across lessons, and works with any LLM.

**Reading the chart:**
- **Zoom:** scroll on the chart to zoom around the cursor, and drag to pan once zoomed.
- **Chart buttons (top right):**
  - **＋ / －** zoom in and out.
  - **⌖ Focus** frames your load, input, markers and matching path.
  - **Fit** shows the whole chart again.
  - **A− / A+** set the size of text and dots. The setting is remembered.
- Text and dots keep their on-screen size while you zoom, so crowded spots spread out. When zoomed in, resistance and reactance values are labelled near the middle of the view.
- Points that sit on the same spot share one label (e.g. "M1 · IN"), and no labels overlap.
- **Frequency band** (tick box in the chart legend and the Frequency panel): off, the chart shows the design frequency only. On, it adds the sweep traces, markers and bandwidths. A fixed load starts with it off, since a fixed impedance is the same at every frequency. Antennas, RLC loads and imported data start with it on.

## Run

Most people should download the ready-built app from the [latest release](https://github.com/sampreethsharma7/smith-chart-tutor/releases/latest): a Windows installer or portable `.exe`, a Mac `.dmg` or a Linux AppImage / `.deb`, made by [the release workflow](../.github/workflows/release.yml) with [electron-builder](../electron-builder.yml). They are unsigned for now, so the first start asks once (see the [README](../README.md#getting-started)).

To run from source without installing anything, use the one-click start: extract the ZIP and double-click `Start-Windows.cmd`, `Start-Mac.command` or `Start-Linux.sh` (see the [README](../README.md#getting-started)). It needs no admin rights: a private Node.js goes into `.runtime/` in the app folder, then [scripts/launch.mjs](../scripts/launch.mjs) installs, builds and starts the app, redoing a step only when its inputs changed. `--no-launch` stops before starting the app.

For development:

```bash
npm install
npm run dev        # development, hot reload
npm run build && npm start
npm test           # RF engine, importers, solver, assessment key, tool-arg coercion
```

> Running from a VS Code terminal? VS Code sets `ELECTRON_RUN_AS_NODE=1`, which makes Electron start as plain Node. Unset it first (`$env:ELECTRON_RUN_AS_NODE=$null` in PowerShell, `unset ELECTRON_RUN_AS_NODE` in bash).

## First steps

Everything leads to a **lesson** with the tutor. Until your first one, a *Get started* bar on every tab shows where you are and a button for the next step:

1. **Profiles**: set your name, experience, goals and tutor style.
2. **Placement test**: 21 questions (graded exactly, not by the LLM) that set your starting level per skill. You can skip it and let the tutor gauge you.
3. **Models**: add a *connection* (Anthropic, Google Gemini, OpenAI, OpenRouter, Ollama, LM Studio or any OpenAI-compatible endpoint), paste its one API key, and tick the models you want from the list that key can use. Run the benchmark on any of them.
4. **Learn**: press **▶ Start lesson**. Pick the tutor's suggestion, a skill, or your own question. The tutor sets a goal with 2–4 steps, which you see as a checklist above the chat, and starts step 1 straight away. It ticks off each step once *you* have done it.

**How a lesson ends:**
- **When you reach the goal,** the tutor gives a recap and a **Goal reached** bar appears. The lesson stays open, so you can read back over it. **Finish lesson** saves it and shows what you can now do, how your skill estimates moved, and what to practise next. **Keep going** carries on in the same lesson (more practice, a harder one, questions); finish it whenever you like, and it still counts as reaching the goal.
- **Finish early** saves it as *partly done*. The next lesson picks up from there.
- **Leave** appears if you haven't answered anything yet. That lesson isn't saved or counted.
- **Closing the app** only pauses a lesson.

After that, **▶ Start lesson** sits in the top bar on every tab. While a lesson is running, the top bar shows "Lesson N · step 2 of 3" and a way back to it. There's no clock: a lesson ends at its goal. On Progress, **Practise** starts a lesson on one skill. Once you have earlier lessons, you can tick **Start with a quick review question**: one question on past material, skippable, off by default and remembered once you tick it.

## Models and the benchmark

Keys belong to **connections** (one per provider account), not to models: one Anthropic key covers every Claude model. Temporary API errors (overload, per-minute rate limits) are retried automatically; daily or free-tier quotas fail fast with a clear message; model refusals are reported instead of showing an empty reply.

Three adapters cover most providers: Anthropic, OpenAI-compatible (OpenAI, Ollama, LM Studio, OpenRouter, Groq, vLLM…) and Gemini. LLM calls run in the main process, so keys never reach the page. Reasoning models' `<think>` blocks are hidden from the chat.

### Free local tutor (Ollama)

The card at the top of the Models tab sets up a local tutor in one click, with no admin rights. The code is in [localModels.ts](../src/shared/localModels.ts) and [ollama.ts](../src/main/ollama.ts).

1. **It checks this computer.**
   - It reads the memory, and the GPU's memory: NVIDIA through the driver's `nvidia-smi`, while Apple Silicon shares the RAM and about two thirds of it is usable.
   - It looks for an Ollama that's already running or installed, including the app's own copy.
2. **It recommends a model.** The candidates are the local models that did best on the tutor benchmark, using the scores shipped with the app:
   - **qwen3:8b** when about 7 GB of GPU memory is free
   - **qwen3:1.7b** when there's about 3 GB, or when it has to run on the processor
   - none, with an honest pointer to cloud models, for machines with under 8 GB of memory and no usable GPU

   The reason is shown in plain words, and a smaller model is always one click away.
3. **It sets it up.**
   - **Ollama:** if there's no Ollama, it downloads the official standalone build for this OS into the per-user local app-data folder (on Windows `%LOCALAPPDATA%\SmithChartTutor\ollama`, not the roaming profile). The download is checked against Ollama's published checksum.
   - **Running it:** the app starts it when the app opens, and again whenever a lesson or the model list needs it (for example after it was closed from its tray). The app stops its own copy, with the model runner, when it closes. It never stops an Ollama you run yourself.
   - **One setup at a time:** the setup keeps going if you switch tabs, and a second one waits until the first finishes. A model download that won't fit on the disk is stopped before it starts, and a very slow machine gets a *slow* verdict rather than an error.
   - **The model:** it downloads the model with a progress bar. Downloads go through Electron's network stack, so the system proxy and company certificates apply.
4. **It measures this machine.**
   - It loads the model once, which is timed separately because it happens once per session.
   - It asks two short tutor questions and averages how long the answer takes to start (thinking included, because the learner waits for it) and how fast it streams.
   - It reads how much of the model sits on the GPU.
   - The verdict is *comfortable*, *usable, with some waiting*, or *slow*. Slow offers the smaller model or a cloud model.
5. **It adds the model** under an Ollama connection, with **Use as tutor**.

**Run benchmark** (or **Benchmark all** on a connection) runs 18 checks, all graded by code (no LLM judge). Each attribute matches a job the model does in the tool:

| Attribute | Used for | Example checks |
|---|---|---|
| Guiding | Socratic tutoring | withholds component values, corrects "series L goes counter-clockwise", short hints |
| Tool use | the agent loop | right tool and arguments, reads the chart before answering, converts nH/pF to SI, waits after a prediction card, no tool calls for small talk |
| RF knowledge | explanations | 12 concept questions (moves, λ/2, Foster, Q vs bandwidth, stubs, V_min…) |
| RF maths | numbers without the calculator | 6 calculations (weighted low; the tutor uses tools) |
| Learner tracking | your profile | records a wrong answer correctly, doesn't invent evidence |
| Summaries | the tutor's memory | key facts in under 110 words |
| Speed | responsiveness | first visible token, tokens/s |

**Compare models** (bottom of the Models tab) puts these in one table:

- Reference results that ship with the app
- Every model you've benchmarked, including deleted ones
- A model being tested right now, filling in live

Tick the attributes that matter to you, or pick a use case (Socratic coaching, Quick drills, Accuracy…). The ranking re-weights to those attributes only. The model you're testing is highlighted with its rank, untick a model to hide it, and hover any score to see what was tested.

Benchmark from the command line (keys stay encrypted in the app's store):

```bash
# all configured models, or a comma-separated list of provider ids/labels
SMITH_BENCH=all SMITH_MACHINE="RTX 5070 Laptop, Ollama" npx electron .
# debugging: list the models each saved key can use, or send one prompt to a model
SMITH_LIST_MODELS=1 npx electron .
SMITH_PROBE="Claude Sonnet 5.5" SMITH_PROMPT="Say hi" npx electron .
# refresh the shipped reference set from one or more settings.json files
node scripts/export-reference.mjs "%APPDATA%/smith-tutor/data/settings.json"
```

## Design tab: matching your own loads

**Learn** is for lessons. **Design** is for real work: an assistant that matches your load with you, like a colleague. It uses the same model as the tutor.

- **Its own chart.** Design has its own chart, separate from the lesson's, so a lesson exercise and your real design never overwrite each other. Import your `.s1p` or CST file on the left, or set up a load.
- **It does the work.** Tell it what you need, for example "match to 50 Ω at 2.45 GHz, VSWR under 2 from 2.4 to 2.5 GHz". It works out the lumped L-networks and single-stub matches, checks each one across the band, and shows 2–3 as cards: parts, VSWR and return loss at the design frequency, the worst VSWR in your band, the matched bandwidth, a one-line trade-off and its recommendation. Every number is computed by the app, not the model.
- **You decide.** Nothing changes on your chart until you press **Apply** on a card (or ask it to apply one). **Undo** puts your previous network back.
- **Pitched to you.** It explains as much as your profile suggests: terse for someone advanced, a sentence on each part for someone newer.
- **Not graded.** Nothing in the Design tab counts as answers, mistakes or progress.
- **Teach me why.** Opens a tutor lesson on a copy of the design (the Design tab keeps its own), and the tutor takes it apart step by step. If a lesson is already open, the design is brought into it.
- **Limits for now:** ideal parts (no tolerance, loss or self-resonance, no snapping to standard values), and L-networks and single stubs only. It can check any other network you describe.

While either assistant is replying, the other tab is locked, because its tools act on the chart that's loaded.

## CST / measured data

- **Best:** in CST, *Post-Processing → Import/Export → Touchstone* → `.s1p` / `.s2p` (S11 is used; S22 can be selected in code).
- **Also works:** *1D Results → S-Parameters → (right click) Export → Plot Data (ASCII)*. This needs **complex** data: Real/Imag, or Magnitude and Phase. A magnitude-only (dB) export can't be placed on a Smith chart; the importer explains this. Files with several parameter-sweep blocks become one dataset per block. If the column format is guessed wrong, change it in the Load panel.

## Calculator and formulas

**The circuit drawing.** Above the list of parts, the Network panel draws the matching network as a circuit: the source on the left, the load on the right, the way circuits are usually drawn. The list runs the other way (load → source, the order the point moves on the chart), so each part carries the list's number, in the colour of its step on the chart. Series parts sit in the signal wire; shunt parts and stubs go down to the ground rail (a shorted stub reaches it, an open one stops short); a line is drawn as a section of the wire with its length and Zc. **Point at a part**, in the drawing or the list, and its step lights up on the chart while the others fade; **click it** to find it in the list. After your first Check, the task card shows the same drawing under *What you built*, so the tutor's follow-up ("why this part first?") has the circuit in front of you. When a reading question covers the values, a fixed load's impedance is hidden in the drawing too.

The **Calculator** panel (under the matching network) does the arithmetic that goes with reading the chart, at the design frequency and Z0. It shows its working as typeset formulas with your numbers put in:

- **Convert:** one point as Z, z, Y, y, Γ, VSWR, return loss and Q (type it, or take the load, the input or a clicked point).
- **Component:** the L or C that adds a reactance (series) or susceptance (shunt), or the part that moves the point from one spot to another. It warns when one part of that kind can't make the move (r or g would have to change). "Add to network" puts the part on the chart.
- **Network:** what each element of your network does to z, step by step. Hovering a step highlights its path on the chart.

The tutor can open it filled in (`show_calculation`) to walk you through a calculation, and it sees what you calculated. To keep graded work fair, the converter pauses while a "read this value" question is open, and the tutor can't fill the calculator in during a graded question. There is no "solve the whole match" button.

The tutor's messages typeset LaTeX formulas too (`$…$` inline, `$$…$$` on their own line). Formulas use [KaTeX](https://katex.org), bundled with the app, so this works offline.

## The tutor is agentic: adding tools

The tutor decides for itself which tools to use; nothing is scripted. Every file in [src/renderer/src/agent/tools/](../src/renderer/src/agent/tools/) that default-exports `defineTools([...])` is picked up automatically:

```ts
import { defineTools } from '../types'
export default defineTools([{
  name: 'my_tool',
  description: 'When and why the tutor should use this.',
  parameters: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] },
  activity: () => 'Doing my thing',      // shown in the chat
  endsTurn: false,                        // true = learner acts next (like an exercise card)
  run: (args, ctx) => ({ result: args.x * 2 })  // ctx: chart store, derived metrics, profile
}])
```

Current tools:

- **Chart:** `get_chart_state`, `set_scenario`, `edit_network`, `annotate_chart`, `clear_annotations`, `focus_chart`
- **Exact maths:** `rf_calculate`, `what_if`, `solve_l_match`, `analyze_sweep`
- **Teaching:** the tutor designs its own tasks and questions. The app works out each right answer, refuses impossible tasks, and grades exactly:
  - `create_exercise`: match a load to a VSWR target, optionally across a band
  - `create_target_task`: get the point onto a spot or a circle (g = 1, the real axis, z = 1 + j1…) with limited elements; it can continue from your network
  - `ask_move`: which way, and along which circle, one element moves the point, or which half it ends in (multiple choice)
  - `ask_locate`: click a spot on the chart (a given z or y, or where an element takes the point)
  - `ask_value`: read or work out one number (VSWR, return loss, |Γ|, angle of Γ, z, y, Z, Y, Q, WTG), graded within ±5% with sensible minimums
  - `ask_component`: which part and what value adds a given x or b (or makes a given move). The learner types it with its unit ("2.7 nH"), and the unit says which part they chose. Graded within ±5%; a forgotten 2π, a missed de-normalisation and L/C swapped are recognised as slips.
  - `ask_spot_error`: a worked L-match with one planted mistake, or none (see below)
  - `ask_prediction`: open-ended predictions (not graded)
  - `check_exercise`, `close_exercise`
- **Lessons:** `set_lesson_goal`, `advance_lesson_step`, `set_lesson_coordinates`, `complete_lesson`
- **Learner model:** `get_learner_profile`, `record_evidence`, `set_skill_level`, `log_misconception`, `resolve_misconception`, `save_note`, `forget_note`

### Guardrails that work with any model

- Tool arguments are coerced to their schema types.
- Learner-model updates are refused until the learner has actually done something, with at most one update per skill per turn.
- An exercise, task or question card ends the tutor's turn.
- **Solve, then explain.** When you pass a task, the tutor gets your network with each move verified, and must ask one follow-up about your own solution before closing the task or the lesson. If it only praises you, it's reminded once. Follow-ups are marked optional, and every graded question can be skipped. You see ✓ or ✗; the exact answer goes to the tutor, which guides you to it instead of just telling you.
- Repeated tool loops are capped.
- An empty reply gets one nudge.
- Grading and maths are always exact; the LLM never grades.
- **Every chart move is verified before it's explained.**
  - `what_if` returns exact move facts for each element:
    - the circle it follows (constant r, constant g, or around the centre)
    - which way it turns, and by how many degrees
    - the start and end chart half, in both impedance and admittance terms
    - where it crosses the real axis
  - If the tutor states a direction, chart half or arc without having called `what_if` that turn, the reply is withdrawn before any of its actions run. The tutor must then verify and restate it. Questions to the learner don't count as claims.
- **Coordinates are never assumed.** Each step records whether it reads the chart as impedance or admittance. If the tutor doesn't say, the app infers it from the step's wording, and only on strong evidence. Otherwise it's *unknown*, and every direction claim is withdrawn until the tutor sets it. Lessons saved before this existed are inferred the same way when they load (for example, a shunt-C step that talks about y = 1.15 − j0.77 resolves to admittance).
- **Frequency only when it matters.** Giving the tutor's scenario a load starts a fresh setup, so markers, the sweep and the tutor's drawings from the previous setup don't carry over. The band stays hidden for one-frequency topics. The tutor turns it on only for bandwidth, Q or a frequency-dependent load, and gives a reason. An exercise graded across a band turns it on and marks the band edges.
- **The lesson state survives a model switch.**
  - The goal, steps, current step, coordinates (impedance, admittance or unknown) and sign convention are part of every system prompt.
  - Switching models mid-lesson is announced in the chat.
  - Each reply records the model that wrote it, and Progress shows it in the transcript.

## Profiles and history

Each profile stores:

- Per-skill mastery and confidence, with history
- Per-topic results (see below)
- Misconceptions
- The tutor's own notes about you
- Session transcripts and summaries
- The placement result
- Its own chart workspace

### Where you stand (Progress)

The Progress page shows the learner against two targets, defined in [src/shared/standing.ts](../src/shared/standing.ts):

- **Strong (75%):** right every time at medium difficulty. Steady medium answers approach 80% but never reach it, so the mark sits at 75%, about 8–10 steady right answers from a typical start.
- **Top (95%):** right at the hardest level too. Only hard answers get there.

The targets come from how the app grades, not from other learners. The page has four parts:

- **Overall:** your level, an overall scale with both targets marked, and one square per skill that turns blue at strong and green at top.
- **Work on next:** the tutor's plan (see below). Each card shows the tutor's reason, followed by the facts for that skill: the topic it chose, misconceptions, reviews due, and the gap to strong.
- **Skills:** one bar per skill with the two target lines and a shaded "how sure" range that narrows with evidence. A skill whose prerequisites are measured and weak says "best after …": advice, not a lock, so you can still start it. A self-reported starting guess holds nothing back.
- **Topics:** one square per topic, coloured by how it's going (not tried, shaky, building, strong, top), with ↻ when a review is due.

**How the app judges what you know.** A high score has to be earned with proof, so the number can't run ahead of the understanding:

- **Answers count for what they prove.**
  - A right pick from k choices is discounted by the chance of guessing it (1/k), and a two-part question counts as one pick from all the combinations.
  - Clicks, typed values and tasks count fully.
  - Right after talking it through with the tutor, or after several Checks, counts as partly right.
- **Judgement can't make a skill strong.** The placement test, the tutor's `record_evidence` (half weight) and its `set_skill_level` override all stop at 60%. Older profiles were brought into line once: a skill with no graded answers behind it came down to 60%.
- **Strong needs proof.** That means right answers on your own, in two lessons, at medium level or harder, in two different situations; top needs the hardest level. Until then a skill above 75% is "provisional", and the page says what proof is missing.
- **How sure you were, in the same click.** On a graded question, where you click an answer says how sure you are: the left third is guessing, the middle not sure, the right third sure. A meter along each button fills and a tag names the zone as you move. Two-part questions carry it on the reason; click and typed answers carry it on Submit. There is no extra step. A keyboard answer (Enter) records no confidence.
  - Right but unsure counts less, isn't proof, and comes back for review soon.
  - A right guess counts as partly right.
  - Wrong but sure is flagged as a real misconception and goes to the top of the tutor's list.
  - A wrong guess is a gap, not a misconception.
  - "How well you judge yourself" on Progress shows how often you're right when sure, unsure and guessing, so you can see whether you're under- or overconfident.
- **Questions that dig:**
  - Move questions ask why as well as which way. Picking the right direction for the wrong reason counts as partly right and records the wrong idea.
  - `ask_spot_error` shows a worked L-match with one realistic planted mistake, or none: an inverted normalisation, the wrong direction or circle, the wrong part for the sign, or a forgotten 2π.
  - Every item records its situation (which half, which side of r = 1, which quantity), and a topic is solid only once it has been right in two.
  - After each answer the app tells the tutor to probe one level up or down, to find your ceiling and floor quickly.
- **Check yourself** (on Progress, or in the lesson launcher) is a short session of graded questions with no teaching. It targets the skills with the least proof, then gives an honest summary from the results.

**Patterns: the same confusion, noticed over time** ([src/shared/patterns.ts](../src/shared/patterns.ts)). The app knows every right answer exactly, so it can tell how an answer is wrong. It never guesses: an answer that is wrong in no recognisable way leaves no trace, and neither does a wrong guess.

- **What counts as a recognisable mistake:**
  - **Clicks:** a click mirrored through the centre is the admittance point; the other half means a flipped sign; swapped r and x.
  - **Typed values:** |Γ| given for VSWR, radians given for degrees, y given for z, a value never normalised, a forgotten 2π.
  - **Move questions:** the wrong circle or the wrong way, and what a wrong reason shows.
  - **Spot the mistake:** which planted mistake they accepted.
- **Each one maps to one of 11 underlying confusions,** such as z vs y, series vs shunt, rotation, sign, normalisation, 2π, |Γ| vs VSWR, and line direction or motion.
- **The record:** it keeps each mistake as a "slip" (up to 150). The tutor adds what it hears in conversation through `log_misconception`'s `confusion` field.
- **The pattern lifecycle:**
  - The same confusion in **two topics or two lessons** is a pattern.
  - It clears by the adaptive sign-off below: **looking better**, then **cleared** (to re-check), then **confirmed** after one more clean lesson.
  - A new slip brings it back as a relapse, with a higher bar.
  - The status is worked out from the record each time, so it can't drift.
- **What the tutor gets:**
  - "NEW PATTERN" / "PATTERN BACK" in the result of the answer that triggered it.
  - The live patterns at the top of its brief, with the root idea and the questions to check it with.
  - The pattern listed as a reason in the "candidates by the numbers".
- **On Progress,** "Patterns the tutor has noticed" shows each pattern with the idea behind it and its evidence.

**Who picks what's next: the tutor, in one place.** The app never picks for the learner. Two single sources keep every screen consistent:

- **The facts** come from [standing.ts](../src/shared/standing.ts) and `topicState` in [memory.ts](../src/shared/memory.ts): the targets, each skill's gap or lock, how each topic is going, and the "candidates by the numbers". The Progress page draws them, and the tutor reads the same facts in its instructions. If something is judged wrong, it's fixed there, once.
- **The decision** is the tutor's `set_next_focus`: 1–3 skills (optionally a topic in each), each with a reason, saved on the profile. The Progress page ("Work on next"), the lesson launcher ("in your tutor's plan") and the tutor's own next lesson ("Tutor's pick") all read it.

The tutor may disagree with the candidates when it has a reason. A skill whose measured prerequisites are weak is accepted with advice (open that lesson with a quick check of the prerequisite), never refused: refusing it looped the plan back to the prerequisite 27 times in one test, often because that number was under-rated. It sets the plan at the end of every lesson; `complete_lesson` asks for it once, without blocking a model that won't.

### The tutor's memory of you

The app keeps it, so it's the same whichever model teaches, and it stays small however long you use the app.

- **Graded answers update it automatically.** Every task and graded question is filed under a specific topic, such as "which way a shunt C moves the point" or "|Γ|, VSWR and return loss". There are 22 topics under the 9 skills. The app also sets each item's difficulty (1–3) from the task itself. One answer moves:
  - the skill estimate, by a fixed rule
  - the topic's counts
  - the topic's **aim level**: two right in a row at the edge of your level steps it up; a miss at or below it steps it down; easy items don't move it
  - the topic's **next review date**: tomorrow after a miss, then 3, 7, 14 and 30 days as you keep getting it right

  The tutor can't record the same answer again. Its own `record_evidence` is for what can't be graded, such as explanations and reasoning.
- **The independence ladder** ([ladder.ts](../src/shared/ladder.ts)) measures something difficulty doesn't: how much of a task you decide yourself. A hard problem with the part named is still guided.
  - **The rungs:** 1 guided (the part and target are given), 2 one choice (you pick the part, or its value), 3 unguided (a load and a goal), 4 constrained (a band, a tight VSWR, fewer parts), 5 judge (find the mistake in a worked match). Each skill has the rungs it has items for: single moves go guided, one choice, judge; L-matching has all five.
  - **The app rates each item**, from how the tutor set it up, including whether the instructions name the parts. The model never labels its own items.
  - **Your rung moves both ways.** It goes up after clean answers at it (how many comes from how fast your past climbs went: 1 to 3), or one step for a clean pass on a harder item. It holds when you're right but unsure, had help, or guessed. It comes down after a sure miss or two misses in a row. Judging is earned only by passing a judge item.
  - **The app holds the tutor to it:** an item two or more steps below your rung is refused, with how to pitch it instead, unless the tutor gives a reason (a warm-up once a lesson, right after a miss, or you asked for easier).
  - **New skills get a head start** from the skills they build on (one step below), marked as an estimate until your first answer there. Profiles from before the ladder get rungs rebuilt from their saved answers, also as estimates.
  - **Progress** shows it under each skill ("Now: planning whole matches yourself"), with the next step up on hover. It's saved with the profile, cleared by Reset progress, and kept in exports.
- **Reading from the chart, not the readout** ([reading.ts](../src/shared/reading.ts)). Reading questions (a value at a point, or a point to click) could be answered by copying a number the app already shows, which proves you can find the number, not read the chart.
  - **While a reading question is open, the values are covered:** the readout card, the hover tip's numbers, the results table, the network panel's "z after", the design cards' numbers, the calculator's Convert and Network tabs and its "from the chart" pickers, and Pick load on chart. A click question also hides the clicked value. Typing the point instead (the keyboard way) still works but counts partly, and doesn't move the step either way. The chart itself stays: the grid, the hover guides and the VSWR circle. Everything comes back the moment you answer.
  - **Two steps per skill:** off the readout (values shown, answers count as partly right) and from the chart (values covered, answers count fully). Beginners start on the readout and move to the chart after a few right answers on their own (their pace, as on the ladder), or at once after reading one right from the chart. A sure miss, two misses, or uncovering the values twice in a row takes them back to the readout for a while. Mastery of 40% or more, or reading chart basics from the chart, starts a skill on the chart as an estimate.
  - **Z in Ω of a fixed load** isn't asked as a reading question: the load panel prints it.
  - **Show values** on the question card uncovers them at any time; the answer then counts as partly right, and the tutor is told.
  - **The tutor** can cover the values for a beginner (a stretch), but showing them to someone who reads the chart needs the same reasons as the ladder (warm-up, after a miss, you asked), from the same allowance per lesson.
  - **Allowance:** a value read by eye is allowed ±8% (±5% when the values were shown); a question that asks for an estimate gets the by-eye allowance even with the values shown. Clicks keep their usual distance.
  - **Worked out, not read:** a question that states its own point ("your load is 100 + j50 Ω: what is z?") is arithmetic, so nothing is covered and it doesn't count toward reading from the chart.
  - **Progress** shows the step for chart basics, Γ/VSWR and admittance ("Now: reading values from the chart yourself").
- **Your project** ([capstone.ts](../src/shared/capstone.ts)): one real task tied to your goal, e.g. "match a 2.44 GHz patch-like antenna across 2.4–2.48 GHz to VSWR ≤ 2", and the route to it. It's the reason to come back.
  - **It's described by its settings, not picked from a list:** what to match (your imported data, or a load model such as your antenna), where (one frequency or a band), how well (the VSWR target) and with what parts (L and C, a line and a stub, or any). Judge worked solutions instead of building is a setting too, for interview prep.
  - **The route comes from the settings:** reading the chart, then the skills that kind of match needs, each at a step of the independence ladder (choosing the part yourself, planning whole matches, matching under limits), with Q & bandwidth for a band, lines and stubs for a stub match, and anything those build on. A step is ticked only from your own answers, never from an estimate.
  - **Your tutor proposes it** from your goal in your first lessons (`set_capstone`). You can change any setting on Progress (Change), and the tutor won't replace a project you set yourself unless you ask.
  - **The final task opens when every step is ticked:** a graded match on the project's own load, band, VSWR, parts and Z0, which the tutor can't water down. It counts only on the project's load (the card has "Put the project's load back" if it changed). Passing it marks the project done (also when the tutor confirms the pass in the chat instead of you pressing Check), and your tutor proposes the next, harder one. It is your own work: while it is open, the tutor can hint (which part, which way, which circle) but the app withholds any reply or card that names a part value of its solution, unless it is a value you have already put on the chart.
  - **Only projects that can work are accepted:** the load must need matching, imported data must cover the frequencies, an L-and-C project at one frequency must have practical part values, and a band must be within the Bode–Fano limit for the load's Q (no network of any size can do better).
  - **"Up next"** at the end of each lesson and on the lesson launcher names the next step toward your project (or, without one, the next step up on what your tutor planned).
- **Misconceptions are tied to topics.** A wrong pick on a move question records exactly which wrong idea it shows. A misconception clears by itself through the adaptive sign-off, and reopens if you slip again. Older ones get their topic from their wording.
- **Adaptive sign-off** ([signoff.ts](../src/shared/signoff.ts)): when is a mistake really fixed?
  - **Evidence** comes only from lessons after the one it appeared in. Each such lesson counts once: 1 for a right graded answer, plus ¼ each if they were sure, gave the right reason, or did it in a new situation, at most 1.5. The tutor's own observations (`record_evidence`, which must say the `reason` and whether it was `transfer`) count half.
  - **The bar** is `SIGNOFF.defaultBar` (2, about two lessons) by default. It moves with the learner's record: retention (how often cleared mistakes came back), pace (share of graded answers right) and calibration (right when sure). Each is pulled toward the default with one strength (`SIGNOFF.strength`, 15 answers' worth), and the whole adjustment is weighed by how much history there is with that same strength, so a new learner gets the standard bar. It ranges from 1.25 (one strong lesson, for someone whose fixes stick) up to 4.
  - **Learner-wide, on purpose.** One learner rarely has enough answers on a single topic to judge it: after 10 lessons, typically 1–4 per topic. Every graded answer is kept with its topic and skill (`Profile.answers`, the last 1,000), so per-topic records can be added once there's data for them.
  - **Deeper mistakes need more:** seen many times or over several lessons, sure of it, or back after being cleared. The deepest also need one lesson in a new situation.
  - **Cleared is provisional:** one clean lesson later confirms it. The tutor speaks in these words (looking better, cleared, confirmed) and can't declare a mistake fixed: `resolve_misconception` only removes one recorded by mistake.
- **Notes are few and categorised:** goal, preference, what clicked, struggle, other. At most 5 are kept per category. A near-duplicate replaces the older note; the tutor can update or delete notes, and so can you, on Progress.
- **The tutor plans from a short brief.** It's rebuilt every turn and bounded in size:
  - your goals
  - each skill's level, trend and aim level
  - weak topics, topics due for review, and solid topics
  - live misconceptions
  - the last items asked, so they aren't repeated
  - notes and the last few lessons
  - how long this lesson has been going (this sitting, if it was picked up again after a break)

  It's also told to read your energy: if replies turn short or frustrated, it backs off (a smaller step, a worked example, or an offer to wrap up).

  The tutor picks the area (reviews and misconceptions first, then weak topics, then the lesson goal), pitches at the aim level and varies the form. Transcripts are kept for you to read, but the tutor no longer reads old ones.
- **Progress** shows each skill's topics: how often you got them right, the next aim level, and whether a review is due.

**Export** saves the whole profile (history included, API keys never) to a file for backup or moving to another PC; **Import** brings it back. **Reset progress** starts over with the same name, background and preferences: lessons, answers, skills, mistakes, the tutor's notes and the plan are cleared (export first to keep a copy).

### What is saved, and when

Everything saves automatically, per profile, and survives tab switches, profile switches and restarts.

| What | When it saves | File |
|---|---|---|
| Placement test in progress | after every answer; resume from Placement test or the Get started bar | `profiles/<id>.json` |
| Chart setup, exercise card, prediction card, the tutor's drawings | as you change them | `workspaces/<id>.json` |
| Live tutor conversation | while you talk; restored on the next launch | `conversations/<id>.json` |
| Design tab chart and assistant chat | as you change them | `design/<id>.workspace.json`, `design/<id>.chat.json` |
| Flagged problems (⚑) | when you save one | `reports/<time>.json` + `.png` |
| Faults the app noticed | as they happen | `issues.jsonl` |
| Session transcript and exercises | after every turn | `profiles/<id>.json` |

Finishing a lesson (after the goal or early) writes a summary for the tutor's memory. Lessons you never ended are summarised automatically when you next start one.

**Long lessons.** The tutor model sees the last 60 messages. As older ones fall out of view, the app folds them into running notes for the lesson ("Learner told me: …", what was taught, what you asked and got wrong). The notes are written in the background after a turn, oldest first, and keep every fact you gave about yourself or your project. The tutor gets them on every turn, and the end-of-lesson summary is built from them, so the start of a three-hour lesson isn't forgotten. Other limits that keep a long lesson fast:
- The chat panel draws the latest 150 messages; *Show earlier messages* adds more.
- A very long paste, such as a data file, reaches the model shortened. Import measured data from the Load panel instead.
- A lesson stores its latest 2000 messages, each up to 4000 characters, along with the true message count. Lessons older than the last 20 keep their summary and last 20 messages.

Data folder (plain JSON): `%APPDATA%/smith-tutor/data/`. Profiles → *Open data folder*.

### Course run: a model on whole lessons

The benchmark checks single replies. A **course run** (Models tab, under Compare models) checks whole lessons: the tutor teaches a scripted beginner for several lessons in a row (6 by default), and the app scores the teaching from what happened. You choose when to run it, since it costs model requests: about 20–35 a lesson, shown before you start.

- **The learner is scripted, not a model**, so only the tutor uses requests. It has a hidden ability per skill that starts at beginner level and grows with practice. It answers graded cards right or wrong by chance from that ability (harder, more independent and covered items are harder; help makes them easier), says how sure it is, builds task networks with the app's own solvers (a wrong try has one part the wrong size), and sometimes takes a beginner's shortcuts: "Show values", typing a point, asking for help, skipping. When no card is open it sends short beginner lines ("ok", "I don't get it", "can I try a harder one?"). The same **seed** gives the same learner, so runs can be compared.
- **It runs in the app itself**, on a throwaway profile, with the real tutor and the real answer paths, starting each lesson on the tutor's pick. A lesson ends when the tutor reaches its goal, or after 30 learner actions. You can watch on Learn, and stop it at any time. While it runs, the profile and model pickers are locked, and no benchmark can start (the run counts every request). Afterwards the throwaway profile is deleted and your profile, model and page come back; only the report is kept, even when the run was stopped or a lesson failed. If the app closes mid-run, the next start puts your profile and model back and deletes the learner. Its faults go into the report, not the issue log.
- **The scores are counted, none judged by a model:**
  - *Rising challenge*: each item in the second half is compared with the first half on its own skill (above it, level with it, or below it), and a skill first met in the second half counts as new ground; plus the independence steps the learner climbs (ladder rungs, reading from the chart). Not scored for a one-lesson run.
  - *No repeats*: the same item (the same point, value, move or task, whatever the wording) asked again after a right answer.
  - *Reading from the chart*: in the later lessons, the tutor covers the values on reading questions instead of showing them (what the learner then does, like uncovering them, doesn't count against it).
  - *Clean replies*: tool names, withheld replies or a literal `
` reaching the learner, and claims of drawings or changes that weren't made.
  - *Smooth flow*: refused tool calls, repeats, step limits, empty replies, and stretches of 3 learner messages without a card or task.
  - *Right physics*: directions the app had to correct.
  - *Lessons finished*: lessons that reached their goal.

  The details show the item level lesson by lesson, how reading answers were seen, the project's steps, tasks the scripted learner couldn't solve (not counted against the tutor), and each lesson's goal, cards, tasks and requests. The tutor's notes between lessons are model requests; the last lesson's notes are not, since the learner is deleted after it.

## Finding problems: flags, the issue log and the audit

Three things work together so problems get found and fixed, most common first. All of it stays on your PC.

- **Flag it (⚑).** Hover a tutor or design-assistant message and click ⚑, or use ⚑ in the chart toolbar. Add a line about what looks wrong if you like. The app saves a report to `reports/` in the data folder: the message, the recent conversation with every tool call and its result, the chart, and a screenshot of the window. Nothing is sent anywhere.
- **The issue log.** The app also notes mechanical faults by itself, as they happen, in `issues.jsonl`:
  - a reply that says it drew something, or changed the chart, when no tool did that turn
  - a failed or refused tool call, or the same tool called over and over
  - a tool name or a literal `\n` in what you read
  - the step limit, an empty reply, or a guard that had to rewrite a reply

  The log restarts at 2 MB; the previous one is kept as `issues.old.jsonl`.
- **The audit.** `npm run audit` reads the reports, the issue log, the saved chats (replayed through the same checks) and the lesson transcripts, and prints the faults most common first, by model, with examples. It only reads. `npm run audit -- --since 2026-10-01` limits it to recent ones; `npm run audit -- <folder>` reads another data folder.

## Layout

```
src/shared/rf/        complex maths, metrics, networks & loads, solvers, Touchstone/CST importers (+ tests)
src/shared/           llm types, profile/skill model, assessment bank, benchmark
src/main/             Electron main: window, storage, encrypted keys, LLM adapters (anthropic/openai/gemini)
src/preload/          safe IPC bridge (window.api)
src/renderer/src/     React UI: chart/, panels/, views/, state/, agent/ (loop, prompt, registry, tools/)
```
