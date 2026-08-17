import { describe, expect, it } from 'vitest'
import { escapeHtml, protectWikiLinks, restoreWikiLinks, rewriteAttachmentUrls } from '../src/index.ts'

describe('lute pipeline (wiki-link protect/restore)', () => {
  it('protects and restores plain + aliased + embed wiki links', () => {
    const { text, tokens } = protectWikiLinks('see [[Target]] and [[Target|Alias]] and ![[Embed]]')
    expect(tokens).toHaveLength(3)
    expect(tokens[0]).toMatchObject({ target: 'Target', embed: false })
    expect(tokens[1]).toMatchObject({ target: 'Target', alias: 'Alias', embed: false })
    expect(tokens[2]).toMatchObject({ target: 'Embed', embed: true })
    expect(text).not.toContain('[[')
    const html = restoreWikiLinks(text, tokens)
    expect(html).toContain('<a class="wikilink" data-wiki="Target">Target</a>')
    expect(html).toContain('<a class="wikilink" data-wiki="Target">Alias</a>')
    expect(html).toContain('<span class="wikilink" data-wiki="Embed">Embed</span>')
  })

  it('leaves wiki links inside fenced code blocks literal', () => {
    const md = '```\n[[NotLinked]]\n```\n\n[[Linked]]'
    const { text, tokens } = protectWikiLinks(md)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ target: 'Linked' })
    expect(text).toContain('[[NotLinked]]') // code preserved verbatim
    expect(text).not.toContain('[[Linked]]') // outside code → tokenized
  })

  it('leaves wiki links inside inline code spans literal', () => {
    const md = '`[[NotLinked]]` and [[Linked]]'
    const { text, tokens } = protectWikiLinks(md)
    expect(tokens).toHaveLength(1)
    expect(tokens[0]).toMatchObject({ target: 'Linked' })
    expect(text).toContain('`[[NotLinked]]`')
  })

  it('escapes target + alias on restore (XSS-safe)', () => {
    const { text, tokens } = protectWikiLinks('[[<script>|"quoted"]]')
    const html = restoreWikiLinks(text, tokens)
    expect(html).not.toContain('<script>')
    expect(html).toContain('data-wiki="&lt;script&gt;"')
    expect(html).toContain('&quot;quoted&quot;')
  })

  it('escapeHtml escapes the browser-escaped set only', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; \'')
  })

  it('rewrites managed attachment srcs/hrefs, leaving external links + code untouched', () => {
    const html = [
      '<p><img src="attachments/abc/pic.png" alt="x" /></p>',
      '<p><a href="attachments/abc/file.pdf">f</a></p>',
      '<p><a href="https://x.com/attachments/a/b">ext</a></p>',
      '<pre><code>attachments/abc/code.txt</code></pre>',
    ].join('')
    const out = rewriteAttachmentUrls(html, (id, _f) => '/pkw/attachment/' + encodeURIComponent(id))
    expect(out).toContain('src="/pkw/attachment/abc"')
    expect(out).toContain('href="/pkw/attachment/abc"')
    expect(out).toContain('href="https://x.com/attachments/a/b"') // external untouched
    expect(out).toContain('attachments/abc/code.txt') // code content untouched
  })

  it('passes attachmentId + filename to urlFor', () => {
    const seen: Array<[string, string]> = []
    rewriteAttachmentUrls('<img src="attachments/att_a1b2c3d4e5f6/pic.png">', (id, f) => { seen.push([id, f]); return 'X' })
    expect(seen).toEqual([['att_a1b2c3d4e5f6', 'pic.png']])
  })
})
