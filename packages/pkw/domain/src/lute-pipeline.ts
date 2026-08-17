/**
 * Lute render pipeline — pure, DOM-free protect/restore for the PKW Markdown
 * extensions that Lute's core does not natively render (wiki links). Callouts,
 * GFM tables, fenced code, footnotes and inline formatting are rendered by Lute
 * itself (via SetCallout(true) etc.), so this layer stays minimal. It is shared
 * by the Host-side Reading renderer and is the single canonical recognition
 * rule set alongside markdown-semantics.
 * @module @deepseek-ai/dsh-pkw-domain/lute-pipeline
 */

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

/** HTML-escape for attribute + text injection (matches the browser `esc`). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ESC[c]!)
}

export interface WikiLinkToken {
  token: string
  target: string
  alias?: string
  embed: boolean
}

/**
 * Code segments that wiki-link protection must NOT touch: fenced code blocks
 * (``` or ~~~) and inline code spans. Lute renders these verbatim, so wiki
 * links inside them must stay literal.
 */
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/

/** `[[Target]]`, `[[Target|Alias]]`, `![[Target]]`, `![[Target|Alias]]`. */
const WIKI_LINK = /!\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

function protectInText(s: string, tokens: WikiLinkToken[]): string {
  return s.replace(WIKI_LINK, (raw, embedTarget, embedAlias, linkTarget, linkAlias) => {
    const embed = raw.startsWith('!')
    const target = embed ? embedTarget : linkTarget
    const alias = embed ? embedAlias : linkAlias
    const token = '\uE000PKWWIKI' + tokens.length + '\uE001'
    tokens.push({ token, target, ...(alias ? { alias } : {}), embed })
    return token
  })
}

/**
 * Replace wiki links (outside fenced/inline code) with unique PUA-delimited
 * tokens that Lute passes through verbatim, so the Host can restore them as
 * clickable anchors after `Md2HTML`.
 */
export function protectWikiLinks(markdown: string): { text: string; tokens: WikiLinkToken[] } {
  const tokens: WikiLinkToken[] = []
  const parts = markdown.split(CODE_SEGMENT)
  let out = ''
  for (let i = 0; i < parts.length; i++) {
    out += i % 2 === 1 ? parts[i]! : protectInText(parts[i]!, tokens)
  }
  return { text: out, tokens }
}

/** Restore wiki-link tokens in Lute HTML to clickable anchors/spans. */
export function restoreWikiLinks(html: string, tokens: WikiLinkToken[]): string {
  let out = html
  for (const t of tokens) {
    const label = t.embed ? t.target : (t.alias ?? t.target)
    const inner = t.embed
      ? '<span class="wikilink" data-wiki="' + escapeHtml(t.target) + '">' + escapeHtml(label) + '</span>'
      : '<a class="wikilink" data-wiki="' + escapeHtml(t.target) + '">' + escapeHtml(label) + '</a>'
    out = out.split(t.token).join(inner)
  }
  return out
}

/**
 * Rewrite managed-attachment URLs (`attachments/<id>/<filename>`) in Lute HTML
 * to a served URL via `urlFor(id, filename)`. Matches only `src`/`href`
 * attributes with the relative `attachments/` prefix (never `https://…`), so
 * ordinary links and code-block content are untouched.
 */
export function rewriteAttachmentUrls(html: string, urlFor: (attachmentId: string, filename: string) => string): string {
  return html.replace(/((?:src|href)=")attachments\/([^/"]+)\/([^"]+)(")/g, (_m, pre: string, id: string, filename: string, post: string) => {
    return pre + urlFor(id, filename) + post
  })
}
