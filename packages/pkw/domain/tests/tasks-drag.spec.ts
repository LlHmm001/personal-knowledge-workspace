import { describe, expect, it } from 'vitest'
import { isReorderOnly, noteTaskDescriptionPreview, resolveTaskDrop, stripFrontmatter } from '../src/index.ts'

const task = (over: Record<string, unknown> = {}) => ({
  taskId: 'task_1' as never,
  workspaceId: 'ws' as never,
  matrixId: 'matrix_work' as never,
  title: 't',
  status: 'open' as const,
  important: false,
  urgent: false,
  tags: [],
  parentTaskId: null,
  sourceRefs: [],
  manualOrder: 0,
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  ...over,
})

describe('resolveTaskDrop', () => {
  it('matrix-quadrant drop sets matrix + important×urgent (Q1)', () => {
    const t = task({ matrixId: 'matrix_a' as never, important: false, urgent: false })
    const intent = resolveTaskDrop(t, { kind: 'matrix-quadrant', matrixId: 'matrix_b' as never, quadrant: 1 })
    expect(intent).toEqual({ matrixId: 'matrix_b', important: true, urgent: true })
  })

  it('matrix-quadrant Q4 sets important=false urgent=false', () => {
    const intent = resolveTaskDrop(task(), { kind: 'matrix-quadrant', matrixId: 'matrix_b' as never, quadrant: 4 })
    expect(intent).toEqual({ matrixId: 'matrix_b', important: false, urgent: false })
  })

  it('matrix drop keeps quadrant (no important/urgent in intent)', () => {
    const intent = resolveTaskDrop(task({ important: true, urgent: false }), { kind: 'matrix', matrixId: 'matrix_c' as never })
    expect(intent).toEqual({ matrixId: 'matrix_c' })
  })

  it('inbox drop → matrixId null', () => {
    expect(resolveTaskDrop(task(), { kind: 'inbox' })).toEqual({ matrixId: null })
  })

  it('today drop → scheduledAt today (injectable now)', () => {
    const now = new Date('2026-08-17T12:00:00Z')
    expect(resolveTaskDrop(task(), { kind: 'today' }, now)).toEqual({ scheduledAt: '2026-08-17' })
  })

  it('completed drop → status completed', () => {
    expect(resolveTaskDrop(task(), { kind: 'completed' })).toEqual({ status: 'completed' })
  })
})

describe('isReorderOnly', () => {
  it('same matrix+quadrant is reorder-only', () => {
    const src = { matrixId: 'matrix_a' as never, important: true, urgent: false }
    expect(isReorderOnly(src, { kind: 'matrix-quadrant', matrixId: 'matrix_a' as never, quadrant: 2 })).toBe(true)
  })
  it('different quadrant is NOT reorder-only', () => {
    const src = { matrixId: 'matrix_a' as never, important: true, urgent: false }
    expect(isReorderOnly(src, { kind: 'matrix-quadrant', matrixId: 'matrix_a' as never, quadrant: 1 })).toBe(false)
  })
})

describe('noteTaskDescriptionPreview', () => {
  it('skips frontmatter and takes meaningful paragraphs (not headings)', () => {
    const md = '---\nid: note_1\ntitle: T\n---\n\n# 标题\n\n这是第一个有效段落，用于任务描述。\n\n第二段。'
    expect(noteTaskDescriptionPreview(md)).toBe('这是第一个有效段落，用于任务描述。\n\n第二段。')
  })

  it('returns empty for heading-only body', () => {
    expect(noteTaskDescriptionPreview('---\nid: x\n---\n\n# 只有标题')).toBe('')
  })

  it('truncates long paragraphs to maxLen', () => {
    const md = '# h\n\n' + '长'.repeat(1000)
    expect(noteTaskDescriptionPreview(md, 100).length).toBeLessThanOrEqual(100)
  })
})

describe('stripFrontmatter', () => {
  it('removes a leading YAML block', () => {
    expect(stripFrontmatter('---\na: 1\n---\n\nbody')).toBe('body')
  })
  it('leaves no-frontmatter markdown intact', () => {
    expect(stripFrontmatter('# plain')).toBe('# plain')
  })
})
