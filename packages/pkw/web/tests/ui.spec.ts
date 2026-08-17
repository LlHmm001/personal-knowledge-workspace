import { describe, expect, it } from 'vitest'
import { renderPage } from '../src/ui.ts'

/** Extract the inline browser script from the served page. */
function script(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(renderPage())
  if (match === null) throw new Error('no inline script')
  return match[1]!
}

describe('PKW web UI (served page)', () => {
  it('compiles the inline script and never embeds a placeholder note id', () => {
    const js = script()
    expect(() => new Function(js)).not.toThrow()
    expect(js).not.toContain('id: __placeholder__')
  })

  it('integrates Vditor with cache disabled and a single-instance lifecycle', () => {
    const js = script()
    expect(js).toContain("cache: { enable: false }")
    expect(js).toContain('initVditor')
    expect(js).toContain('destroyVditor')
    expect(js).toContain("mode: 'ir'")
    expect(js).toContain('saveNoteBody')
  })

  it('renders all three editor modes with the right surfaces', () => {
    const js = script()
    expect(js).toContain("mode === 'live' ? '<div id=\"vditor\"")
    expect(js).toContain("mode === 'source' ? '<textarea id=\"editor\"")
    expect(js).toContain("mode === 'reading' ? '<div id=\"preview\">")
    expect(js).toContain('set-mode')
    expect(js).toContain('pkw-editor-mode')
  })

  it('uses change-driven + adaptive sync polling, not a full-tree interval', () => {
    const js = script()
    expect(js).toContain('stale-while-revalidate')
    expect(js).toContain('kickSyncPoll')
    expect(js).toContain('document.hidden')
    expect(js).not.toContain('setInterval(() => { if (state.view === \'notes\')')
  })

  it('routes wiki-link clicks (data-wiki) to openWikiTarget', () => {
    const js = script()
    expect(js).toContain("closest('[data-wiki]')")
    expect(js).toContain('openWikiTarget(wiki.dataset.wiki)')
  })

  it('styles Vditor IR callouts with the PKW 9-type palette (Live↔Reading parity)', () => {
    const page = renderPage()
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="NOTE"]')
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="DANGER"]{--callout-color:#b91c1c')
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="SUCCESS"]')
  })

  it('wires table cell editing + footnote product UX entry points', () => {
    const js = script()
    expect(js).toContain('resolveCellInEditor')
    expect(js).toContain("closest('td, th')")
    expect(js).toContain("api('tableMutation'")
    expect(js).toContain('function footnoteDialog')
    expect(js).toContain("api('footnoteEdit'")
    expect(js).toContain("api('footnoteDelete'")
    expect(js).toContain('footnoteKeyFromDef')
    expect(js).toContain('sup[data-type="footnotes-ref"]')
  })
})
