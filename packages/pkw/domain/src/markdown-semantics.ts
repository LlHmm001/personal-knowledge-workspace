/**
 * PKW Markdown Extension Semantics — the single, DOM-free recognition rules for
 * PKW's Markdown extensions (Callout, Wiki Link, Managed Attachment). Live and
 * Reading renderers MUST both consume these rules so they never re-interpret the
 * same canonical syntax independently.
 * @module @deepseek-ai/dsh-pkw-domain/markdown-semantics
 */

import { CALLOUT_TYPES, type CalloutType } from './editor-commands.ts'

export interface CalloutBlock {
  kind: 'callout'
  type: CalloutType
  title?: string
  body: string
}

/** Parse a blockquote block whose first line is `> [!TYPE] [title]`. */
export function parseCalloutBlock(rawLines: string[]): { block: CalloutBlock; consumed: number } | undefined {
  if (rawLines.length === 0) return undefined
  const first = rawLines[0]!.replace(/^>\s?/, '')
  const m = /^\[!([A-Za-z]+)\]\s*(.*)$/.exec(first)
  if (!m) return undefined
  const type = m[1]!.toUpperCase()
  if (!(CALLOUT_TYPES as readonly string[]).includes(type)) return undefined
  const title = m[2]!.trim() || undefined
  const bodyLines: string[] = []
  let i = 1
  while (i < rawLines.length && /^>\s?/.test(rawLines[i]!)) {
    bodyLines.push(rawLines[i]!.replace(/^>\s?/, ''))
    i++
  }
  return { block: { kind: 'callout', type: type as CalloutType, ...(title ? { title } : {}), body: bodyLines.join('\n') }, consumed: i }
}

/** Serialize a callout block back to canonical `> [!TYPE]` Markdown. */
export function serializeCalloutBlock(block: CalloutBlock): string {
  const header = block.title ? `> [!${block.type}] ${block.title}` : `> [!${block.type}]`
  const body = block.body.replace(/\r\n/g, '\n').split('\n').map(l => `> ${l}`).join('\n')
  return body ? `${header}\n${body}` : header
}

export interface WikiLink { target: string; alias?: string }

/** Parse `[[Note]]` or `[[Note|Alias]]`. */
export function parseWikiLink(text: string): WikiLink | undefined {
  const m = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/.exec(text.trim())
  if (!m) return undefined
  return { target: m[1]!.trim(), ...(m[2] !== undefined ? { alias: m[2]!.trim() } : {}) }
}

export interface AttachmentRef { attachmentId: string; filename: string; kind: 'image' | 'file' }

/**
 * Parse a managed attachment reference of the form
 * `![alt](attachments/<id>/<filename>)` (image) or
 * `[text](attachments/<id>/<filename>)` (file).
 */
export function parseAttachmentReference(text: string): AttachmentRef | undefined {
  const t = text.trim()
  const img = /^!\[[^\]]*\]\(attachments\/([^/]+)\/([^)]+)\)$/.exec(t)
  if (img) return { attachmentId: img[1]!, filename: img[2]!, kind: 'image' }
  const file = /^\[[^\]]*\]\(attachments\/([^/]+)\/([^)]+)\)$/.exec(t)
  if (file) return { attachmentId: file[1]!, filename: file[2]!, kind: 'file' }
  return undefined
}
