import { describe, expect, it } from 'vitest'
import { parseAttachmentReference, parseCalloutBlock, parseWikiLink, serializeCalloutBlock } from '../src/index.ts'

describe('PKW markdown semantics (shared extension recognition)', () => {
  it('parses a callout block (type + body)', () => {
    const r = parseCalloutBlock(['> [!NOTE]', '> 提示内容', '> 第二行'])
    expect(r).toBeDefined()
    expect(r!.block).toEqual({ kind: 'callout', type: 'NOTE', body: '提示内容\n第二行' })
    expect(r!.consumed).toBe(3)
  })

  it('parses callout with custom title', () => {
    const r = parseCalloutBlock(['> [!WARNING] 注意', '> 内容'])
    expect(r!.block).toEqual({ kind: 'callout', type: 'WARNING', title: '注意', body: '内容' })
  })

  it('rejects unknown callout type', () => {
    expect(parseCalloutBlock(['> [!NOTREAL]', '> x'])).toBeUndefined()
  })

  it('rejects a plain blockquote (no callout)', () => {
    expect(parseCalloutBlock(['> 普通引用'])).toBeUndefined()
  })

  it('serializes callout back to canonical (roundtrip)', () => {
    const s = serializeCalloutBlock({ kind: 'callout', type: 'IMPORTANT', body: '重点内容' })
    expect(s).toBe('> [!IMPORTANT]\n> 重点内容')
    const r = parseCalloutBlock(s.split('\n'))
    expect(r!.block).toEqual({ kind: 'callout', type: 'IMPORTANT', body: '重点内容' })
  })

  it('serializes callout with custom title', () => {
    expect(serializeCalloutBlock({ kind: 'callout', type: 'TIP', title: '小技巧', body: '内容' })).toBe('> [!TIP] 小技巧\n> 内容')
  })

  it('parses wiki links (with and without alias)', () => {
    expect(parseWikiLink('[[Note]]')).toEqual({ target: 'Note' })
    expect(parseWikiLink('[[Note|Alias]]')).toEqual({ target: 'Note', alias: 'Alias' })
    expect(parseWikiLink('not a link')).toBeUndefined()
  })

  it('parses managed attachment references (image and file)', () => {
    expect(parseAttachmentReference('![](attachments/att_1/pic.png)')).toEqual({ attachmentId: 'att_1', filename: 'pic.png', kind: 'image' })
    expect(parseAttachmentReference('[报告.pdf](attachments/att_2/报告.pdf)')).toEqual({ attachmentId: 'att_2', filename: '报告.pdf', kind: 'file' })
    expect(parseAttachmentReference('https://example.com/x')).toBeUndefined()
  })
})
