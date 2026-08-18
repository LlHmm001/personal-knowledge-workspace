/**
 * A2 federated-search acceptance harness (development/验收 script).
 *
 * Boots the REAL PKW service stack (Notes + Attachments + WeKnora Sync) against a
 * REAL WeKnora instance, creates acceptance-prefixed fixtures, runs the note-scoped
 * processing + federated search, and prints a machine-readable PASS/FAIL summary.
 *
 * It does NOT run against the browser UI and does NOT destructive-migrate any
 * existing data. All fixtures are prefixed `[A2-ACCEPT]`.
 *
 * Usage:
 *   WEKNORA_BASE_URL=http://127.0.0.1:18088/api/v1 \
 *   WEKNORA_API_KEY=sk-... \
 *   KB_ID=<main-kb-id> \
 *   node --import tsx/esm scripts/knowledge-a2-acceptance.ts
 *
 * NOTE: requires a real image fixture with OCR text and a >50k-char TXT fixture
 * under fixtures/ (image.png, large.txt). The large.txt must contain the three
 * markers EARLY/MIDDLE/LATE at the documented positions.
 */
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { NoteId, stripInternalFrontmatter } from '@deepseek-ai/dsh-pkw-domain'
import PkwEventStoreService from '../packages/pkw/events/src/index.ts'
import PkwWorkspaceService from '../packages/pkw/workspace/src/index.ts'
import NotesService from '../packages/pkw/notes/src/index.ts'
import AttachmentsService from '../packages/pkw/attachments/src/index.ts'
import WeKnoraClient from '../packages/pkw/weknora/src/index.ts'
import WeKnoraSyncService from '../packages/pkw/weknora-sync/src/index.ts'

const baseUrl = process.env.WEKNORA_BASE_URL ?? 'http://127.0.0.1:18088/api/v1'
const apiKey = process.env.WEKNORA_API_KEY ?? ''
const kbId = process.env.KB_ID ?? ''
if (apiKey === '' || kbId === '') {
  console.error('A2 ACCEPTANCE: SKIP — WEKNORA_API_KEY / KB_ID not set')
  process.exit(0)
}

const runId = Date.now().toString(36)
const NOTE_MARKER = `PKW-NOTE-${runId}`
const results: Array<[string, boolean, string]> = []
function report(name: string, ok: boolean, detail = ''): void { results.push([name, ok, detail]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`) }

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pkw-a2-'))
  await mkdir(join(dir, 'notes'), { recursive: true })
  await mkdir(join(dir, 'attachments'), { recursive: true })

  const ctx = new Context()
  await ctx.plugin(Storage)
  const backend = new SqliteStorageBackend({ path: ':memory:', journalMode: 'wal' })
  ctx.storage.backend.register('sqlite', backend)
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  ctx.provide('sessionPersistence', { list: async () => [], load: () => { throw new Error('unused') }, inspect: () => { throw new Error('unused') } } as never)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(Timer)
  await ctx.plugin(PkwEventStoreService)
  await ctx.plugin(PkwWorkspaceService)

  const ws = await ctx.workspaceRegistry.create(dir)
  await ctx.plugin(NotesService, { workspaceId: ws.id })
  await ctx.plugin(AttachmentsService, { workspaceId: ws.id })
  await ctx.plugin(WeKnoraClient, { baseUrl, apiKey, apiKeyRef: '' })
  await ctx.plugin(WeKnoraSyncService, { kbId, workspaceId: ws.id, pollMs: 500, retryBaseMs: 500, retryMaxMs: 5000, recoveryGraceAttempts: 2 })

  const notes = ctx.pkwNotes
  const attachments = ctx.pkwAttachments
  const sync = ctx.pkwWeKnoraSync

  // 1. Business Note.
  const note = await notes.create({ relativePath: `[A2-ACCEPT] ${runId}.md`, markdown: `# A2 Acceptance ${runId}\n\n${NOTE_MARKER}\n\n这是客户项目资料。\n\n![img](attachments/att_placeholder/image.png)\n` })
  const noteId = String(note.noteId)

  // 2. image fixture (requires a real OCR-able image at fixtures/image.png).
  let imageAttachmentId: string | undefined
  try {
    const imgBytes = new Uint8Array(await readFile('fixtures/image.png'))
    const img = await attachments.importFile({ content: imgBytes, filename: 'image.png', mimeType: 'image/png', knowledgeMode: 'note-scoped', ownerNoteId: note.noteId })
    imageAttachmentId = String(img.id)
  } catch { report('image fixture', false, 'fixtures/image.png missing — skip image assertions') }

  // 3. large TXT fixture with EARLY/MIDDLE/LATE markers.
  let txtAttachmentId: string | undefined
  try {
    const txtBytes = new Uint8Array(await readFile('fixtures/large.txt'))
    const txt = await attachments.importFile({ content: txtBytes, filename: 'large.txt', mimeType: 'text/plain', knowledgeMode: 'note-scoped', ownerNoteId: note.noteId })
    txtAttachmentId = String(txt.id)
  } catch { report('large txt fixture', false, 'fixtures/large.txt missing — skip text assertions') }

  // 4. wait for processing to reach derived-ready.
  const deadline = Date.now() + 60000
  for (;;) {
    await sync.drainNoteScopedProcessing()
    const ids = [imageAttachmentId, txtAttachmentId].filter((x): x is string => x !== undefined)
    const allReady = ids.every(id => sync.getDerivedContent(id as never) !== undefined)
    if (allReady || Date.now() > deadline) break
    await new Promise(r => setTimeout(r, 1000))
  }

  // 5. identity assertions.
  const mainMapping = sync.getMapping(note.noteId)
  report('NoteId → Main KnowledgeId', mainMapping?.knowledgeId !== undefined, mainMapping?.knowledgeId ?? '')
  for (const id of [imageAttachmentId, txtAttachmentId].filter((x): x is string => x !== undefined)) {
    const proc = (sync as never as { reqProcessing?: () => unknown }) // internal access not exposed; use getDerivedContent as the ready signal instead
    void proc
    report(`attachment ${id} derived-ready`, sync.getDerivedContent(id as never) !== undefined)
  }

  // 6. federated search assertions.
  const search = async (q: string) => sync.search(q, { limit: 5 })
  const hitsNote = (res: Array<{ local?: { entityType?: string; entityId?: string; matchedAttachmentId?: string } }>, marker: string) =>
    res.some(r => r.local?.entityType === 'note' && r.local.entityId === noteId && (marker === NOTE_MARKER || r.local.matchedAttachmentId !== undefined))

  report('Main note query', hitsNote(await search(NOTE_MARKER), NOTE_MARKER), NOTE_MARKER)
  if (imageAttachmentId !== undefined) report('Image OCR query (federated)', hitsNote(await search(`PKW-IMAGE-${runId}`), 'IMG'), '')
  if (txtAttachmentId !== undefined) {
    report('EARLY marker federated', hitsNote(await search('PKW-EARLY-4811'), 'EARLY'), '')
    report('MIDDLE marker federated', hitsNote(await search('PKW-MIDDLE-7291'), 'MIDDLE'), '')
    report('LATE marker federated', hitsNote(await search('PKW-LATE-9637'), 'LATE'), '')
  }

  // 7. projection hygiene: main payload must NOT contain the processing markers.
  const doc = await notes.getDocument(note.noteId)
  const projected = stripInternalFrontmatter(doc.markdown)
  report('frontmatter id stripped', !projected.includes(noteId), '')
  report('canonical unchanged (has id)', doc.markdown.includes(noteId), '')

  console.log('\n=== A2 ACCEPTANCE SUMMARY ===')
  for (const [name, ok] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  const failed = results.filter(([, ok]) => !ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  await ctx.fiber.dispose().catch(() => {})
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
