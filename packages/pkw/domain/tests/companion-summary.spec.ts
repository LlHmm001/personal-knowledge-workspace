import { describe, expect, it } from 'vitest'
import { companionUserContent, extractAttachmentSummary, hasCompanionUserContent, insertAttachmentSummary, stripManagedSummaryMarkers } from '../src/index.ts'

describe('companion attachment-summary materialization', () => {
  it('inserts a new managed block at the end', () => {
    const md = '# 海报\n\n![](attachments/att_x/海报.png)'
    const out = insertAttachmentSummary(md, 'att_x', '这是一段摘要。')
    expect(out).toContain('<!-- pkw:attachment-summary:start att_x -->')
    expect(out).toContain('## 附件解析摘要')
    expect(out).toContain('这是一段摘要。')
    expect(out).toContain('<!-- pkw:attachment-summary:end -->')
  })

  it('replaces an existing block in place (no duplicate append)', () => {
    const md = '# 海报\n\n' + insertAttachmentSummary('', 'att_x', '旧摘要')
    const out = insertAttachmentSummary(md, 'att_x', '新摘要')
    expect(out).toContain('新摘要')
    expect(out).not.toContain('旧摘要')
    // only one start marker
    expect(out.split('pkw:attachment-summary:start').length - 1).toBe(1)
  })

  it('extracts the summary text for a given attachmentId', () => {
    const md = insertAttachmentSummary('# 海报\n', 'att_x', '提取我')
    expect(extractAttachmentSummary(md, 'att_x')).toBe('提取我')
    expect(extractAttachmentSummary(md, 'att_y')).toBeUndefined()
  })

  it('is a same-summary no-op (extract === new summary)', () => {
    const md = insertAttachmentSummary('# 海报\n', 'att_x', '相同摘要')
    expect(extractAttachmentSummary(md, 'att_x')).toBe('相同摘要')
  })

  it('distinguishes managed region from user-authored content (never body.length)', () => {
    const managed = '# 海报\n\n![](attachments/att_x/海报.png)\n\n' + insertAttachmentSummary('', 'att_x', '自动摘要')
    expect(hasCompanionUserContent(managed)).toBe(false)
    expect(companionUserContent(managed)).toBe('')

    const withNote = managed + '\n\n这是我的补充笔记。\n'
    expect(hasCompanionUserContent(withNote)).toBe(true)
    expect(companionUserContent(withNote)).toContain('这是我的补充笔记。')
    expect(companionUserContent(withNote)).not.toContain('att_x')
    expect(companionUserContent(withNote)).not.toContain('附件解析摘要')
  })

  it('stripManagedSummaryMarkers hides markers but keeps heading + summary (display projection)', () => {
    const md = '# 海报\n\n![](attachments/att_x/海报.png)\n\n' + insertAttachmentSummary('', 'att_x', '自动摘要正文')
    const stripped = stripManagedSummaryMarkers(md)
    expect(stripped).not.toContain('pkw:attachment-summary:start')
    expect(stripped).not.toContain('pkw:attachment-summary:end')
    expect(stripped).toContain('附件解析摘要')
    expect(stripped).toContain('自动摘要正文')
  })
})
