import { describe, expect, it } from 'vitest'
import { renderMarkdownToHtml } from '../src/lute.ts'

/**
 * Host-side Reading renderer: one Lute parse of a representative PKW document
 * must produce the same standard-syntax HTML Live mode renders, plus the PKW
 * wiki-link extension (the only syntax Lute's core does not natively handle).
 */
describe('lute markdown renderer (Host Reading)', () => {
  it('renders callout/table/code/wiki/highlight/inline', async () => {
    const md = [
      '# Title',
      '',
      'A **bold** *italic* ~~strike~~ ==highlight== and `inline`.',
      '',
      '- [ ] todo open',
      '- [x] todo done',
      '',
      '> [!NOTE]',
      '> A note body.',
      '',
      '| A | B |',
      '| - | - |',
      '| 1 | 2 |',
      '',
      '```js',
      'const x = 1',
      '```',
      '',
      'See [[Target]] and [[Target|Alias]] and ![[Embed]].',
      '',
      '![pic](attachments/att_a1b2c3d4e5f6/pic.png) and [file](attachments/att_a1b2c3d4e5f6/doc.pdf).',
    ].join('\n')

    const html = await renderMarkdownToHtml(md)

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>italic</em>')
    expect(html).toContain('<del>strike</del>')
    expect(html).toContain('<mark>highlight</mark>')
    expect(html).toContain('<code>inline</code>')
    // Callout rendered by Lute natively (SetCallout).
    expect(html).toContain('class="callout"')
    expect(html).toContain('data-subtype="NOTE"')
    expect(html).toContain('A note body.')
    // GFM table + fenced code with language.
    expect(html).toContain('<table>')
    expect(html).toContain('<th>A</th>')
    expect(html).toContain('<code class="language-js">const x = 1')
    // Wiki-link extension (protect → Lute → restore).
    expect(html).toContain('<a class="wikilink" data-wiki="Target">Target</a>')
    expect(html).toContain('<a class="wikilink" data-wiki="Target">Alias</a>')
    expect(html).toContain('<span class="wikilink" data-wiki="Embed">Embed</span>')
    // No raw wiki syntax leaks into the output.
    expect(html).not.toContain('[[Target')
    // Managed attachments rewritten to the served byte URL.
    expect(html).toContain('src="/pkw/attachment/att_a1b2c3d4e5f6"')
    expect(html).toContain('href="/pkw/attachment/att_a1b2c3d4e5f6"')
  })

  it('keeps wiki links inside fenced code literal', async () => {
    const html = await renderMarkdownToHtml('```\n[[NotLinked]]\n```\n\n[[Linked]]')
    expect(html).toContain('[[NotLinked]]') // literal inside <code>
    expect(html).toContain('<a class="wikilink" data-wiki="Linked">Linked</a>')
  })

  it('escapes hostile wiki-link text', async () => {
    const html = await renderMarkdownToHtml('[[<script>alert(1)</script>]]')
    expect(html).not.toContain('<script>alert')
    expect(html).toContain('data-wiki="&lt;script&gt;alert(1)&lt;/script&gt;"')
  })
})
