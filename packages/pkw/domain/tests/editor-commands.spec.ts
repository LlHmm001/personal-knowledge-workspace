import { describe, expect, it } from 'vitest'
import {
  buildSelectionSourceRef,
  calloutMarkdown,
  codeBlockMarkdown,
  inlineCodeMarkdown,
  selectionTaskTitle,
  tableMarkdown,
  wikiLinkMarkdown,
  wrapMarkdown,
  CALLOUT_TYPES,
  CODE_LANGUAGES,
} from '../src/index.ts'

describe('editor-commands (pure markdown transforms)', () => {
  it('wrapMarkdown wraps a selection (bold/italic/strike)', () => {
    expect(wrapMarkdown('重点', '**', '**')).toBe('**重点**')
    expect(wrapMarkdown('斜体', '*', '*')).toBe('*斜体*')
    expect(wrapMarkdown('删', '~~', '~~')).toBe('~~删~~')
  })

  it('inlineCodeMarkdown uses single backticks', () => {
    expect(inlineCodeMarkdown('code')).toBe('`code`')
  })

  it('calloutMarkdown wraps selection into a canonical > [!TYPE] block', () => {
    expect(calloutMarkdown('IMPORTANT', '这是重点。')).toBe('> [!IMPORTANT]\n> 这是重点。')
    expect(calloutMarkdown('TIP', '第一行\n第二行')).toBe('> [!TIP]\n> 第一行\n> 第二行')
  })

  it('CALLOUT_TYPES includes the full admonition set (incl SUCCESS/DANGER)', () => {
    expect(CALLOUT_TYPES).toContain('NOTE')
    expect(CALLOUT_TYPES).toContain('SUCCESS')
    expect(CALLOUT_TYPES).toContain('DANGER')
    expect(CALLOUT_TYPES).toHaveLength(9)
  })

  it('tableMarkdown emits canonical GFM with correct rows/cols', () => {
    const t = tableMarkdown(2, 3)
    expect(t).toBe('|    |    |    |\n| --- | --- | --- |\n|    |    |    |\n|    |    |    |')
  })

  it('codeBlockMarkdown emits a fenced block with language', () => {
    expect(codeBlockMarkdown('typescript')).toBe('```typescript\n\n```')
    expect(codeBlockMarkdown()).toBe('```\n\n```')
  })

  it('wikiLinkMarkdown emits [[title]] or [[title|alias]]', () => {
    expect(wikiLinkMarkdown('商业方案')).toBe('[[商业方案]]')
    expect(wikiLinkMarkdown('商业方案', '方案')).toBe('[[商业方案|方案]]')
  })

  it('buildSelectionSourceRef carries full TextQuoteAnchor context', () => {
    const ref = buildSelectionSourceRef({ noteId: 'note_abc', exact: '整理附件', prefix: '先', suffix: '后', start: 3, end: 7, noteRevision: 2, contentHash: 'h1' })
    expect(ref).toEqual({ kind: 'selection', noteId: 'note_abc', exact: '整理附件', prefix: '先', suffix: '后', start: 3, end: 7, noteRevision: 2, contentHash: 'h1' })
    const min = buildSelectionSourceRef({ noteId: 'n', exact: 'x' })
    expect(min).toEqual({ kind: 'selection', noteId: 'n', exact: 'x' })
  })

  it('selectionTaskTitle truncates to the first non-empty line', () => {
    expect(selectionTaskTitle('整理 PKW 的附件逻辑')).toBe('整理 PKW 的附件逻辑')
    expect(selectionTaskTitle('\n\n第一行\n第二行')).toBe('第一行')
    expect(selectionTaskTitle('x'.repeat(80))).toHaveLength(61) // 60 chars + ellipsis
  })

  it('CODE_LANGUAGES lists common languages', () => {
    expect(CODE_LANGUAGES).toContain('javascript')
    expect(CODE_LANGUAGES).toContain('typescript')
    expect(CODE_LANGUAGES).toContain('python')
    expect(CODE_LANGUAGES).toContain('bash')
  })
})
