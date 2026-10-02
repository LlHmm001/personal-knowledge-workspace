/**
 * Host-side Lute renderer for PKW Reading mode. Loads the pinned Vditor
 * `lute.min.js` (GopherJS) into an isolated `node:vm` sandbox once and renders
 * canonical Markdown → HTML through Lute, with the PKW wiki-link extension
 * protected/restored around it (callouts, GFM tables, code and inline
 * formatting are rendered by Lute itself via SetCallout(true) etc.).
 *
 * Live (Vditor IR) and Reading (this renderer) therefore share one parser,
 * eliminating the two-parser semantic drift that Reading's homemade regex
 * renderer caused.
 * @module @deepseek-ai/dsh-pkw-web/lute
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { protectWikiLinks, restoreWikiLinks, rewriteAttachmentUrls, stripManagedSummaryMarkers, neutralizeUnmatchedTildeFences } from '@deepseek-ai/dsh-pkw-domain'

interface LuteGlobal {
  New: () => LuteEngine
}

interface LuteEngine {
  SetAutoSpace(v: boolean): void
  SetCallout(v: boolean): void
  SetFixTermTypo(v: boolean): void
  SetFootnotes(v: boolean): void
  SetGFMAutoLink(v: boolean): void
  SetMark(v: boolean): void
  SetSanitize(v: boolean): void
  Md2HTML(markdown: string): string
}

let lutePromise: Promise<LuteGlobal> | null = null

async function loadLute(): Promise<LuteGlobal> {
  if (lutePromise === null) {
    lutePromise = (async () => {
      const entry = createRequire(import.meta.url).resolve('vditor/dist/js/lute/lute.min.js')
      const src = await readFile(entry, 'utf8')
      const sandbox = createContext({
        console,
        TextDecoder,
        TextEncoder,
        Buffer,
        process,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
      })
      runInContext(src, sandbox, { filename: 'lute.min.js' })
      const Lute = (sandbox as unknown as { Lute?: LuteGlobal }).Lute
      if (Lute === undefined || typeof Lute.New !== 'function') throw new Error('Lute failed to initialize')
      return Lute
    })()
    // A failed load must be retried on the next render (no poisoned singleton).
    lutePromise.catch(() => { lutePromise = null })
  }
  return lutePromise
}

/**
 * Render canonical Markdown to HTML. Matches Vditor's own Lute options for
 * Live parity, except `mark` is enabled so `==highlight==` keeps rendering
 * (the toolbar offers it and the prior Reading renderer rendered it).
 */
export async function renderMarkdownToHtml(markdown: string, basePath = '/pkw'): Promise<string> {
  if (!/^\/pkw(?:\/spaces\/[a-zA-Z0-9_-]+)?$/.test(basePath)) throw new Error('Invalid PKW basePath')
  const Lute = await loadLute()
  // Display projection: hide machine-managed summary markers (canonical untouched),
  // and neutralize only UNMATCHED tilde fences (a bare ~{3,} with no closer) so
  // they cannot swallow the body; valid tilde fences keep their semantics.
  const text = neutralizeUnmatchedTildeFences(stripManagedSummaryMarkers(markdown))
  const { text: protectedText, tokens } = protectWikiLinks(text)
  const lute = Lute.New()
  lute.SetCallout(true)
  lute.SetGFMAutoLink(true)
  lute.SetFootnotes(true)
  lute.SetSanitize(true)
  lute.SetMark(true)
  lute.SetAutoSpace(false)
  lute.SetFixTermTypo(false)
  const html = lute.Md2HTML(protectedText)
  const restored = restoreWikiLinks(html, tokens)
  // Managed attachments (`attachments/<id>/<file>`) → served byte URL.
  return rewriteAttachmentUrls(restored, (id, _filename) => basePath + '/attachment/' + encodeURIComponent(id))
}
