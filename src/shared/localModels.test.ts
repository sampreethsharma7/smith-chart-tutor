import { describe, expect, it } from 'vitest'
import { judgeSpeed, LOCAL_MODELS, recommendLocal, type MachineInfo } from './localModels'

const base: MachineInfo = { platform: 'win32', arch: 'x64', ramGB: 16, cpu: 'Intel Core i7' }

describe('recommending a local tutor model for this machine', () => {
  it('the candidates carry their real benchmark scores, best first', () => {
    expect(LOCAL_MODELS.map((m) => m.model)).toEqual(['qwen3:8b', 'qwen3:1.7b'])
    expect(LOCAL_MODELS[0].score).toBeGreaterThan(LOCAL_MODELS[1].score)
    expect(LOCAL_MODELS[1].score).toBeGreaterThan(0.5)
  })

  it('a 12 GB NVIDIA GPU gets the best model, on the GPU, with the small one as a fallback', () => {
    const r = recommendLocal({ ...base, gpu: { name: 'RTX 5070 Laptop', kind: 'nvidia', memoryGB: 12 } })
    expect(r).toMatchObject({ pick: { model: 'qwen3:8b' }, runsOn: 'gpu', smaller: { model: 'qwen3:1.7b' } })
    expect(r.reason).toMatch(/fits in your RTX 5070 Laptop's 12 GB and scored 8\d% on the tutor benchmark/)
  })

  it('a 4–6 GB GPU gets the small model on the GPU, and says why not the big one', () => {
    const r = recommendLocal({ ...base, gpu: { name: 'GTX 1650', kind: 'nvidia', memoryGB: 4 } })
    expect(r).toMatchObject({ pick: { model: 'qwen3:1.7b' }, runsOn: 'gpu' })
    expect(r.reason).toMatch(/qwen3:8b needs about 7 GB/)
  })

  it('Apple Silicon uses about two thirds of its shared memory', () => {
    expect(recommendLocal({ ...base, platform: 'darwin', arch: 'arm64', gpu: { name: 'Apple M2', kind: 'apple', memoryGB: 16 } }).pick?.model).toBe('qwen3:8b')
    expect(recommendLocal({ ...base, platform: 'darwin', arch: 'arm64', ramGB: 8, gpu: { name: 'Apple M1', kind: 'apple', memoryGB: 8 } }).pick?.model).toBe('qwen3:1.7b')
  })

  it('no usable GPU: the small model on the processor, with an honest caution; too little memory: none', () => {
    const cpu = recommendLocal(base)
    expect(cpu).toMatchObject({ pick: { model: 'qwen3:1.7b' }, runsOn: 'cpu' })
    expect(cpu.caution).toMatch(/slower than from a cloud model/)
    const tiny = recommendLocal({ ...base, ramGB: 4 })
    expect(tiny.pick).toBeNull()
    expect(tiny.caution).toMatch(/Use a cloud model instead/)
  })
})

describe('judging the measured speed', () => {
  it('fast on the GPU is good; middling is ok; crawling is slow', () => {
    expect(judgeSpeed({ firstTokenS: 0.8, tokensPerSec: 60, gpuShare: 1, loadS: 3 })).toMatchObject({ verdict: 'good', text: expect.stringMatching(/start almost at once .* about 45 words a second \(fully on your GPU\)\. That's comfortable/) })
    expect(judgeSpeed({ firstTokenS: 9, tokensPerSec: 9, gpuShare: 0.4, loadS: 3 })).toMatchObject({ verdict: 'ok', text: expect.stringMatching(/40% on your GPU, the rest on the processor/) })
    expect(judgeSpeed({ firstTokenS: 40, tokensPerSec: 3, gpuShare: 0, loadS: 3 }).verdict).toBe('slow')
  })
})
