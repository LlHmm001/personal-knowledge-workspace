import { describe, expect, it } from 'vitest'
import { enrichNoteForKnowledge } from '../src/note-projection.ts'

describe('note-scoped attachment remote projection', () => {
  it('appends a bounded attachment summary block per derived attachment', () => {
    const out = enrichNoteForKnowledge('# 项目复盘\n\n今天讨论了薪酬。\n\n[图片附件：会议白板.jpg]', [
      { attachmentId: 'att_a', filename: '会议白板.jpg', summary: '图片包含 ALPHA-92831 关键字。' },
      { attachmentId: 'att_b', filename: '调研报告.pdf', summary: 'PDF包含 BETA-76142 关键字。' },
    ])
    expect(out).toContain('## 附件解析摘要（会议白板.jpg）')
    expect(out).toContain('ALPHA-92831')
    expect(out).toContain('## 附件解析摘要（调研报告.pdf）')
    expect(out).toContain('BETA-76142')
    expect(out).toContain('# 项目复盘') // canonical body preserved
  })

  it('is a no-op when there is no derived data', () => {
    const md = '# 项目复盘\n\n正文'
    expect(enrichNoteForKnowledge(md, [])).toBe(md)
  })

  it('enforces the total budget and truncates long summaries', () => {
    const longSummary = 'x'.repeat(10000)
    const out = enrichNoteForKnowledge('# T', [{ attachmentId: 'a', filename: 'f.pdf', summary: longSummary }], { maxSummaryChars: 100, maxTotalChars: 200 })
    expect(out.length).toBeLessThan(400)
    expect(out).toContain('…')
    expect(out).not.toContain(longSummary)
  })

  it('skips attachments with empty derived content', () => {
    const out = enrichNoteForKnowledge('# T', [{ attachmentId: 'a', filename: 'f.pdf', summary: '' }])
    expect(out).not.toContain('附件解析摘要')
  })

  it('preserves full extracted text (chunks) so a marker sentence absent from summary stays searchable', () => {
    // A sentence only present in the chunk text, NOT in the summary — this is the
    // full-text retrieval guarantee (verified against real WeKnora chunks).
    const out = enrichNoteForKnowledge('# 项目复盘\n\n客户资料', [
      { attachmentId: 'a', filename: 'report.pdf', summary: '这是一个简短摘要', chunks: ['…季度回顾… ZXQ-7291-blue-orbit …'] },
    ])
    expect(out).toContain('ZXQ-7291-blue-orbit') // full text injected, not just summary
    expect(out).toContain('附件解析摘要（report.pdf）')
  })
})
