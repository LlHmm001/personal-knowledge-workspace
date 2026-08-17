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

  it('guards the editor preview binding so Source mode cannot throw on a missing #preview', () => {
    const js = script()
    // The regression was: $('#preview').addEventListener(...) with no null guard,
    // which throws in Source mode (no preview div). The fix uses a guarded const.
    expect(js).toContain('const pv = $(\'#preview\')')
    expect(js).toContain('if (pv) pv.addEventListener')
  })

  it('renders all three editor modes with the right surfaces', () => {
    const js = script()
    expect(js).toContain("mode === 'source' ? '<textarea id=\"editor\"")
    expect(js).toContain("mode === 'live' ? '<textarea id=\"editor\"")
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
})
