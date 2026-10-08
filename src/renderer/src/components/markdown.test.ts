import { describe, expect, it } from 'vitest'
import { plainMath } from './Markdown'

describe('maths written as LaTeX shows as plain text', () => {
  it('drops $…$ and \\(…\\) delimiters (from a real Gemini reply)', () => {
    expect(plainMath('As an impedance, it\'s $z = 0.6 + j0.4$. But ($y = 1.15 - j0.77$).')).toBe("As an impedance, it's z = 0.6 + j0.4. But (y = 1.15 - j0.77).")
    expect(plainMath('a load of \\(30 \\, \\Omega - j9.9 \\, \\Omega\\)')).toBe('a load of 30 Ω - j9.9 Ω')
  })

  it('leaves prices and lone dollar signs alone', () => {
    expect(plainMath('It costs $5 per month')).toBe('It costs $5 per month')
  })
})

describe('formulas in tutor messages are found and typeset', async () => {
  const { splitMath } = await import('./mathText')
  const { texHtml } = await import('./Tex')
  it('finds inline and display formulas, and leaves prices as prose', () => {
    const parts = splitMath('So $x = \\omega L / Z_0$ and $$L = \\frac{X}{\\omega}$$ but it costs $5 and $10.')
    expect(parts.filter((p) => p.math !== null).map((p) => [p.math, !!p.block])).toEqual([['x = \\omega L / Z_0', false], ['L = \\frac{X}{\\omega}', true]])
    expect(parts.at(-1)!.text).toBe(' but it costs $5 and $10.')
    expect(splitMath('\\(y = 1/z\\) then \\[\\Gamma = \\frac{z-1}{z+1}\\]').filter((p) => p.math).length).toBe(2)
    expect(splitMath('a single $x$ works').find((p) => p.math)!.math).toBe('x')
  })
  it('typesets what KaTeX can read and falls back to plain text otherwise', () => {
    expect(texHtml('\\Gamma = \\frac{z-1}{z+1}')).toContain('katex')
    expect(texHtml('\\frac{1}{')).toBeNull()
  })
})

describe('emphasis around formulas', async () => {
  const { createElement } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const { Markdown } = await import('./Markdown')
  const html = (t: string) => renderToStaticMarkup(createElement(Markdown, { text: t }))
  it('bold can wrap a formula (from a real Gemini reply), and a formula\'s own _ and * stay maths', () => {
    const h = html('- **$\\Gamma$ vs. VSWR:** a recurring slip')
    expect(h).not.toContain('**')
    expect(h).toMatch(/<b>.*katex.* vs\. VSWR:<\/b>/s)
    const k = html('So $Z_0 * x_1$ and *this*')
    expect(k).toContain('<i>this</i>')
    expect(k.match(/<i>/g)).toHaveLength(1)
  })
})
