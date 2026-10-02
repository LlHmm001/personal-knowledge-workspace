import { describe, expect, it, vi } from 'vitest'
import { runInNewContext } from 'node:vm'
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

  it('integrates Vditor with cache disabled and a single-instance lifecycle', () => {
    const js = script()
    expect(js).toContain("cache: { enable: false }")
    expect(js).toContain('initVditor')
    expect(js).toContain('destroyVditor')
    expect(js).toContain("mode: 'ir'")
    expect(js).toContain('saveNoteBody')
  })

  it('renders all three editor modes with the right surfaces', () => {
    const js = script()
    expect(js).toContain("mode === 'live' ? '<div id=\"vditor\"")
    expect(js).toContain("mode === 'source' ? '<textarea id=\"editor\"")
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

  it('routes wiki-link clicks (data-wiki) to openWikiTarget', () => {
    const js = script()
    expect(js).toContain("closest('[data-wiki]')")
    expect(js).toContain('openWikiTarget(wiki.dataset.wiki)')
  })

  it('styles Vditor IR callouts with the PKW 9-type palette (Live↔Reading parity)', () => {
    const page = renderPage()
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="NOTE"]')
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="DANGER"]{--callout-color:var(--co-danger)')
    expect(page).toContain('.vditor-ir blockquote.callout[data-subtype="SUCCESS"]')
  })

  it('wires table cell editing + footnote product UX entry points', () => {
    const js = script()
    expect(js).toContain('resolveCellInEditor')
    expect(js).toContain("closest('td, th')")
    expect(js).toContain("api('tableMutation'")
    expect(js).toContain('function footnoteDialog')
    expect(js).toContain("api('footnoteEdit'")
    expect(js).toContain("api('footnoteDelete'")
    expect(js).toContain('footnoteKeyFromDef')
    expect(js).toContain('sup[data-type="footnotes-ref"]')
  })

  it('wires view performance: cache-first, single-flight, navigation guard, instrumentation', () => {
    const js = script()
    expect(js).toContain('loadOnce')
    expect(js).toContain('invalidateLoad')
    expect(js).toContain('viewSeq')
    expect(js).toContain('viewMark')
    expect(js).toContain('cache=hit')
    expect(js).toContain('stale navigation guard')
    expect(js).toContain('saveScroll')
    expect(js).toContain('restoreScroll')
  })

  it('wires trash manager: selection, batch restore/purge, empty-trash, stable identity', () => {
    const js = script()
    expect(js).toContain('trashSelection')
    expect(js).toContain("api('batchRestoreTrash'")
    expect(js).toContain("api('batchPurgeTrash'")
    expect(js).toContain('confirmEmptyTrash')
    expect(js).toContain('trashSelectAllState')
    expect(js).toContain('trashReconcile')
    expect(js).toContain("'note:'")
    expect(js).toContain('trash-check')
  })

  it('wires matrix-delete long-operation feedback (busy state + duplicate guard)', () => {
    const js = script()
    expect(js).toContain('matrixDeleteDialog')
    expect(js).toContain('matrixDeleting')
    expect(js).toContain('matrixMovingTasks')
    expect(js).toContain('matrixDeleteFailed')
  })

  it('wires direct upload → companion note workflow (Host-orchestrated, explicit result)', () => {
    const js = script()
    expect(js).toContain('uploadDialog')
    expect(js).toContain('uploadFilesWithCompanion')
    expect(js).toContain('ensureCompanionForAttachment')
    expect(js).toContain('openCompanionForAttachment')
    expect(js).toContain("api('createCompanionNote'")
    expect(js).toContain('attUploadResult')
    expect(js).not.toContain('catch (e) { noteFail++ }') // no swallowed failures
  })

  it('wires the Attachment Manager (list/grid, search, filter, sort, multi-select, batch)', () => {
    const js = script()
    expect(js).toContain('attTypeOf')
    expect(js).toContain('attFilteredList')
    expect(js).toContain('attToolbarHtml')
    expect(js).toContain('attBatchBarHtml')
    expect(js).toContain('attToggleSelection')
    expect(js).toContain('attSelectAllVisible')
    expect(js).toContain('attBatchOp')
    expect(js).toContain('att-create-companion')
    expect(js).toContain('att-open-companion')
    expect(js).toContain('att-batch-trash')
    expect(js).toContain('att-batch-reparse')
    expect(js).toContain('att-batch-index')
    expect(js).toContain('att-copy-ref')
    expect(renderPage()).toContain('att-grid')
    expect(renderPage()).toContain('att-card')
    expect(renderPage()).toContain('att-thumb')
  })

  it('wires theme (system/light/dark tokens) + contextual inspector', () => {
    const page = renderPage()
    expect(page).toContain('[data-theme="dark"]')
    // Native buttons otherwise retain the browser's default black text in dark mode.
    expect(page).toMatch(/button\.btn\{[^}]*color:var\(--ink\)/)
    expect(page).toContain('button.btn.primary{background:var(--accent);color:#fff')
    expect(page).toContain('button.btn.danger{color:var(--err)}')
    expect(page).toContain('--bg-app')
    expect(page).toContain('--bg-hover')
    expect(page).toContain('--co-note')
    expect(page).toContain('#app.no-inspector')
    const js = script()
    expect(js).toContain('applyTheme')
    expect(js).toContain('currentThemeMode')
    expect(js).toContain('syncInspector')
    expect(js).toContain('theme-system')
    expect(js).toContain('toggleInspector')
    expect(js).toContain('inspectorCollapsed')
  })

  it('rewrites Live managed-attachment img src to /pkw/attachment/<id>', () => {
    const js = script()
    expect(js).toContain('rewriteLiveAttachmentImgs')
    expect(js).toContain('setupLiveAttachmentRewrite')
    expect(js).toContain('managedAttachmentUrl')
    expect(js).toContain("'/pkw/attachment/'")
    expect(js).toContain("'data-src'")
    // Live media rewriter must be installed via Vditor's `after` hook (async init),
    // not synchronously after `new Vditor()` when v.vditor.ir does not exist yet.
    expect(js).toContain('after: () => { setupLiveAttachmentRewrite(vditor) }')
  })

  it('wires task marquee multi-selection + batch context menu', () => {
    const js = script()
    expect(js).toContain('selectedTaskIds')
    expect(js).toContain('startTaskMarquee')
    expect(js).toContain('showBatchTaskMenu')
    expect(js).toContain('batchTaskOp')
    expect(js).toContain('confirmBatchTaskDelete')
    expect(js).toContain('toggleTaskSelection')
    expect(js).toContain('reconcileTaskSelection')
    expect(renderPage()).toContain('.task-card.selected')
  })

  it('wires knowledge view (Home + unified RAG search)', () => {
    const js = script()
    expect(js).toContain('renderKnowledgeView')
    expect(js).toContain('renderKnowledgeBrowseInto')
    expect(js).toContain('runSearch')
    expect(js).toContain('searchCardsHtml')
  })

  it('wires missing-canonical-note recovery (missing state + remove + idempotent delete)', () => {
    const js = script()
    expect(js).toContain('renderMissingNote')
    expect(js).toContain('removeMissingNote')
    expect(js).toContain('remove-missing-note')
    expect(js).toContain('rescan-notes')
  })

  it('wires attachment-backed companion upgrade + feature-level knowledge errors', () => {
    const js = script()
    expect(js).toContain('upgrade-companion')
    expect(js).toContain("api('upgradeCompanionNote'")
    expect(js).toContain('knowledgeOffline')
    expect(js).toContain('companionUpgrade')
  })

  it('renders Task Detail with a primary, full-width editable title (not a cramped inline input)', () => {
    const js = script()
    expect(js).toContain('task-detail-title-row')
    expect(js).toContain('task-detail-controls')
    expect(js).toContain("id=\"tdTitle\"")
    expect(renderPage()).toContain('.td-title-input{width:100%')
  })

  it('ships the Knowledge Discovery surface (browse/search/wiki/graph) with a unified card', () => {
    const js = script()
    expect(js).toContain('renderKnowledgeBrowse')
    expect(js).toContain('knowledgeCardHtml')
    expect(js).toContain('renderRelatedKnowledge')
    expect(js).toContain("api('listKnowledge'")
    expect(js).toContain("api('relatedKnowledge'")
    expect(js).toContain('knowledgeBrowseTitle')
  })

  it('never renders WeKnora internal ids in search results', () => {
    const js = script()
    expect(js).not.toContain('remote.knowledgeId')
    expect(js).not.toContain('externalWeKnora')
  })

  it('ships the Knowledge Sources surface (attachment → sources, owner + processing state)', () => {
    const js = script()
    expect(js).toContain('renderSources')
    expect(js).toContain('sourceOwnerBadge')
    expect(js).toContain('refresh-sources')
    expect(js).toContain('noteAttachmentSummaries')
    expect(js).toContain('sourceFiles')
    expect(js).toContain('isolatedHint')
  })

  it('ships navigation-epoch guards, Notes Explorer, inline rename, and base64 upload', () => {
    const js = script()
    expect(js).toContain('noteSeq')
    expect(js).toContain('if (seq !== viewSeq) return')
    expect(js).toContain('renderNotesExplorer')
    expect(js).toContain('inlineRenameTitle')
    expect(js).toContain('renameNoteTitle')
    expect(js).toContain('fileToBase64')
    expect(js).toContain('showActivity')
    // No more O(n²) String.fromCharCode + btoa upload path.
    expect(js).not.toContain('btoa(bin)')
  })

  it('ships the Workspace Launcher + responsive bottom nav + unified Knowledge entry', () => {
    const js = script()
    const page = renderPage()
    expect(page).toContain('class="launcher"')
    expect(page).toContain('id="bottomNav"')
    expect(js).toContain('mobile-more')
    expect(js).toContain('kb-clear-search')
    expect(page).toContain('.launcher{display:grid')
    expect(page).toContain('@media(max-width:768px)')
  })

  it('orders the Launcher (总览|待办 / 笔记|知识 / 来源|回收站) and drops the header global search', () => {
    const page = renderPage()
    const idx = (needle: string) => page.indexOf('data-view="' + needle + '"')
    expect(idx('overview')).toBeLessThan(idx('tasks'))
    expect(idx('tasks')).toBeLessThan(idx('notes'))
    expect(idx('notes')).toBeLessThan(idx('knowledge'))
    expect(idx('knowledge')).toBeLessThan(idx('attachments'))
    expect(idx('attachments')).toBeLessThan(idx('trash'))
    expect(page).not.toContain('id="search"')
  })

  it('ships mobile surface CSS (safe-area, no horizontal overflow, single-column) + sources revalidate', () => {
    const page = renderPage()
    const js = script()
    expect(page).toContain('env(safe-area-inset-bottom)')
    expect(page).toContain('overflow-x:hidden')
    expect(page).toContain('.att-row{display:grid')
    expect(js).toContain('refreshSourcesData')
    expect(js).toContain('reconcileProcessing')
  })

  it('ships distinct mobile surface renderers + action sheet (not just CSS)', () => {
    const js = script()
    const page = renderPage()
    // Mobile renderers
    expect(js).toContain('function isMobile()')
    expect(js).toContain('function mobileNoteRow')
    expect(js).toContain('function mobileSourceCard')
    expect(js).toContain('function mobileTaskCard')
    expect(js).toContain('function mobileActionSheet')
    expect(js).toContain('function mobileDetail')
    // ⋯ menus + editor mobile shell + back navigation
    expect(js).toContain('mobile-note-menu')
    expect(js).toContain('mobile-source-menu')
    expect(js).toContain('mobile-task-menu')
    expect(js).toContain('mobile-editor-menu')
    expect(js).toContain('mobile-back-notes')
    expect(js).toContain('mobile-detail-back')
    // Desktop renderers remain intact
    expect(js).toContain('function explorerNoteRow')
    expect(js).toContain('function attRowHtml')
    expect(js).toContain('function taskRow')
    // Mobile card/sheet CSS surface present
    expect(page).toContain('.mobile-sheet-overlay')
    expect(page).toContain('.mnote')
    expect(page).toContain('.msrc')
    expect(page).toContain('.mtask')
    expect(page).toContain('.mobile-detail')
  })

  it('ships managed source projection + mobile Task Board→Q1-Q4 IA', () => {
    const js = script()
    const page = renderPage()
    // Managed source: browser strips summary markers + passes noteId for source blocks
    expect(js).toContain('pkw:attachment-summary:')
    expect(js).toContain('noteId: state.editor.noteId')
    expect(page).toContain('.src-block')
    // Mobile Tasks: board + Q1-Q4 overview + selected quadrant
    expect(js).toContain('renderMobileTasks')
    expect(js).toContain('mobile-q')
    expect(js).toContain('mobile-board')
    expect(js).toContain('new-task-mobile')
    expect(js).toContain('mobileTaskBoard')
    expect(js).toContain('mobileTaskQ')
    expect(js).toContain('mobile-q-toggle')
    expect(page).toContain('.macc-head')
    expect(page).toContain('.macc-body')
  })

  it('orders bottom nav Tasks-first + minimal mobile header + full board selector', () => {
    const js = script()
    const page = renderPage()
    // Bottom nav: tasks first, then notes/knowledge/sources/more.
    const bn = page.slice(page.indexOf('id="bottomNav"'))
    expect(bn.indexOf('data-view="tasks"')).toBeLessThan(bn.indexOf('data-view="notes"'))
    expect(bn.indexOf('data-view="notes"')).toBeLessThan(bn.indexOf('data-view="knowledge"'))
    expect(bn.indexOf('data-view="knowledge"')).toBeLessThan(bn.indexOf('data-view="attachments"'))
    expect(bn.indexOf('data-view="attachments"')).toBeLessThan(bn.indexOf('data-action="mobile-more"'))
    // Mobile header: page title + more btn; desktop badges hidden via CSS.
    expect(page).toContain('id="pageTitle"')
    expect(page).toContain('id="mobileMoreBtn"')
    expect(page).toContain('#wsBadge,#integBadge,#localBadge,#langBtn,#themeBtn,#inspectorToggle{display:none}')
    // Tasks board selector: full matrix list via sheet, not clipped chips.
    expect(js).toContain('mobile-board-sheet')
    expect(js).toContain('mboard-select')
    // PDF preview: preview route, not SPA fallback.
    expect(js).toContain("'/preview'")
    expect(js).toContain("a[href*=\"attachments/\"]")
  })

  it('ships the Phase 1 closure surfaces (PDF pane, mobile toolbar, create/sort sheets)', () => {
    const js = script()
    const page = renderPage()
    // Desktop PDF preview pane + mobile new-tab split
    expect(js).toContain('pv-close')
    expect(js).toContain('previewing')
    expect(js).toContain('openInNewTab')
    expect(page).toContain('.pv-frame')
    // Mobile Vditor toolbar config (not desktop toolbar via CSS)
    expect(js).toContain('mobileVditorToolbar')
    expect(js).toContain('mobileFormatSheet')
    expect(js).toContain('mobile-format-more')
    // Mobile Notes create sheet + Sources sort sheet
    expect(js).toContain('mobile-note-create')
    expect(js).toContain('att-sort-sheet')
    // Live managed file inline chip
    expect(js).toContain('src-inline')
  })

  it('ships the mobile 390px layout closure (16px padding, no duplicate title, cards fit)', () => {
    const page = renderPage()
    expect(page).toContain('main{padding:16px 16px calc(58px + env(safe-area-inset-bottom) + 16px)')
    expect(page).toContain('main > h2{display:none}')
    expect(page).toContain('.hit{width:100%;max-width:100%;box-sizing:border-box;min-width:0}')
    expect(page).toContain('.mnote,.msrc,.mtask{display:flex;align-items:flex-start;gap:10px;padding:12px 10px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--panel);width:100%;max-width:100%;min-width:0;box-sizing:border-box}')
  })

  it('mobile-layout-regression: no-inspector grid must collapse to 1 column on mobile', () => {
    const page = renderPage()
    // Root cause: #app.no-inspector (desktop hide-inspector) had higher specificity
    // than the mobile #app{grid-template-columns:1fr}, so main stayed in the 280px
    // column whenever #detail was empty (Tasks/Notes/Knowledge). The mobile override
    // must collapse no-inspector to a single column too.
    expect(page).toContain('#app.no-inspector{grid-template-columns:1fr}')
    // Targeted surface containers normalize to full width (no broad main > * rule).
    expect(page).toContain('main{width:100%;max-width:none;min-width:0;box-sizing:border-box}')
    expect(page).toContain('#kbBody,#kbList,#attList,.macc,.mboard,.mboard-select{width:100%;max-width:none;min-width:0;box-sizing:border-box}')
  })

  it('mobile Tasks accordion: Q1-Q4 groups + completed, board selector reordered', () => {
    const js = script()
    const page = renderPage()
    expect(js).toContain('mobile-q-toggle')
    expect(js).toContain('mobileCompletedTaskRow')
    expect(js).toContain('mobileOpenSections')
    expect(js).toContain('macc')
    expect(page).toContain('.macc-head')
    expect(page).toContain('.macc-body')
  })

  it('mobile Notes folder system: home + folder view + scope sheet', () => {
    const js = script()
    const page = renderPage()
    expect(js).toContain('renderMobileNotesHome')
    expect(js).toContain('renderMobileFolderView')
    expect(js).toContain('mobileFolderCard')
    expect(js).toContain('mobileNotesScopeSheet')
    expect(js).toContain('mobile-notes-new')
    expect(js).toContain('mobile-folder-open')
    expect(js).toContain('mobile-notes-back')
    expect(js).toContain('mobileNotesFolder')
    expect(page).toContain('.mfolder')
  })

  it('mobile Notes unfiled section + folder menu + OPTION C read-only editor', () => {
    const js = script()
    const page = renderPage()
    // Unfiled notes (root notes) must surface in the mobile Notes home.
    expect(js).toContain('unfiled')
    expect(js).toContain("parentOfPath(n.relativePath || '') === ''")
    // Folder management reuses existing rename/trash mutations via ⋯.
    expect(js).toContain('mobile-folder-menu')
    expect(js).toContain("action: 'rename-folder'")
    expect(js).toContain("action: 'delete-folder'")
    // OPTION C: mobile is read-first — no Vditor/textarea on mobile.
    expect(js).toContain('mobileEditDesktopOnly')
    expect(js).toContain('mobile-readonly-hint')
    expect(js).toContain("mode: isMobile() ? 'reading'")
    expect(page).toContain('.mobile-readonly-hint')
  })
})

// Execute the served browser functions, replacing only browser/HTTP facilities.
// Deferred responses exercise races that string-presence checks cannot detect.
function browserSection(start: string, end: string): string {
  const js = script()
  const from = js.indexOf(start), to = js.indexOf(end, from)
  if (from < 0 || to < 0) throw new Error('browser section missing: ' + start)
  return js.slice(from, to)
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function microtasks() { for (let i = 0; i < 12; i++) await Promise.resolve() }
function editorHarness() {
  const state = {
    view: 'notes', selectedNoteId: 'note-a', selectedFolder: null, selectedAttachmentId: null,
    editor: { noteId: 'note-a', mode: 'source', persistedMarkdown: 'original', body: '', dirty: true, saving: false },
  }
  const env: Record<string, any> = {
    state, draft: 'first edit', navigationSeq: 0, noteSeq: 0, viewSeq: 0, searchSeq: 0, viewStart: 0, sourcesPollTimer: null,
    api: vi.fn(), onEditorInput() {}, clearTimeout: vi.fn(), setTimeout: vi.fn(),
    getEditorValue: () => ({ kind: 'markdown', value: env.draft }),
    updateSaveStatus: vi.fn(), refreshHeader: vi.fn(), renderTree: vi.fn(), kickSyncPoll: vi.fn(),
    toast: vi.fn(), t: (key: string) => key, esc: (value: string) => value, saveScroll: vi.fn(), destroyVditor: vi.fn(),
    performance: { now: () => 0 }, render: vi.fn(),
  }
  runInNewContext(browserSection('// A save owns', '// ── Adaptive remote-sync polling') +
    browserSection('async function setView(v)', 'function render(){'), env)
  return env
}

describe('browser note save ownership and navigation', () => {
  it('keeps edits typed during an autosave dirty until their own response arrives', async () => {
    const env = editorHarness(), first = deferred<any>(), second = deferred<any>()
    env.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const saving = env.autosave()
    expect(env.api).toHaveBeenLastCalledWith('saveNote', { noteId: 'note-a', markdown: 'first edit' })
    env.draft = 'newer edit'
    first.resolve({ observedRevision: 2 })
    await saving
    expect(env.state.editor.persistedMarkdown).toBe('first edit')
    expect(env.state.editor.dirty).toBe(true)
    expect(env.setTimeout).toHaveBeenCalled()
    const savingAgain = env.autosave()
    expect(env.api).toHaveBeenLastCalledWith('saveNote', { noteId: 'note-a', markdown: 'newer edit', expectedRevision: 2 })
    second.resolve({ observedRevision: 3 })
    await savingAgain
    expect(env.state.editor.dirty).toBe(false)
  })

  it('flushes new input after an in-flight save before leaving the editor', async () => {
    const env = editorHarness(), first = deferred<any>(), second = deferred<any>()
    env.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const saving = env.autosave()
    const navigation = env.setView('tasks')
    env.draft = 'edit typed while saving'
    expect(env.state.view).toBe('notes')
    first.resolve({ observedRevision: 2 })
    await saving; await microtasks()
    expect(env.state.view).toBe('notes')
    expect(env.api).toHaveBeenCalledTimes(2)
    expect(env.api).toHaveBeenLastCalledWith('saveNote', { noteId: 'note-a', markdown: 'edit typed while saving', expectedRevision: 2 })
    second.resolve({ observedRevision: 3 })
    expect(await navigation).toBe(true)
    expect(env.state.view).toBe('tasks')
    expect(env.state.editor.dirty).toBe(false)
  })

  it('retains the current editor and dirty content when save fails', async () => {
    const env = editorHarness()
    env.api.mockRejectedValue(new Error('offline'))
    expect(await env.setView('tasks')).toBe(false)
    expect(env.state.view).toBe('notes')
    expect(env.state.selectedNoteId).toBe('note-a')
    expect(env.state.editor.dirty).toBe(true)
    expect(env.draft).toBe('first edit')
    expect(env.destroyVditor).not.toHaveBeenCalled()
    expect(env.toast).toHaveBeenLastCalledWith('navigationSaveFailed', 'err')
  })

  it('runs only the latest navigation when several destinations wait for one save', async () => {
    const env = editorHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    const first = env.setView('tasks'), latest = env.setView('knowledge')
    expect(env.api).toHaveBeenCalledTimes(1)
    request.resolve({ observedRevision: 2 })
    expect(await first).toBe(false)
    expect(await latest).toBe(true)
    expect(env.state.view).toBe('knowledge')
    expect(env.render).toHaveBeenCalledTimes(1)
  })

  it('invalidates a pending note load when the user opens a folder', async () => {
    const env = editorHarness(), request = deferred<any>()
    env.state.editor.dirty = false
    const main = { innerHTML: '' }, detail = { innerHTML: '' }
    env.$ = (selector: string) => selector === '#main' ? main : detail
    env.localStorage = { getItem: () => 'source' }
    env.api.mockReturnValue(request.promise)
    runInNewContext(browserSection('async function openNote(', 'function renderMissingNote('), env)
    const opening = env.openNote('note-b')
    await microtasks()
    expect(env.api).toHaveBeenCalledWith('getNote', { noteId: 'note-b' })
    expect(await env.prepareNoteNavigation()).toBe(true)
    env.state.selectedNoteId = null
    main.innerHTML = 'folder view'
    request.resolve({ markdown: 'old load should never paint' })
    await opening
    expect(main.innerHTML).toBe('folder view')
  })

  it('saves input typed while create-folder RPC runs before replacing the editor', async () => {
    const env = editorHarness(), folder = deferred<any>(), save = deferred<any>()
    env.state.editor.dirty = false
    env.prompt = () => 'new-folder'
    env.renderFolderMain = vi.fn(); env.renderDetail = vi.fn()
    env.api.mockReturnValueOnce(folder.promise).mockReturnValueOnce(save.promise)
    runInNewContext(browserSection('async function newFolder(parentPath)', 'function renderFolderMain('), env)
    const creating = env.newFolder('')
    await microtasks()
    env.draft = 'input during folder creation'; env.state.editor.dirty = true
    folder.resolve({}); await microtasks()
    expect(env.state.selectedNoteId).toBe('note-a')
    expect(env.api).toHaveBeenLastCalledWith('saveNote', { noteId: 'note-a', markdown: 'input during folder creation' })
    save.resolve({ observedRevision: 2 }); await creating
    expect(env.state.selectedNoteId).toBe(null)
    expect(env.renderFolderMain).toHaveBeenCalledWith('new-folder')
  })

  it('does not let a late save response acknowledge a different editor', async () => {
    const env = editorHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    const saving = env.autosave()
    const other = { noteId: 'note-b', dirty: true, saving: false, persistedMarkdown: 'other original' }
    env.state.editor = other; env.state.selectedNoteId = 'note-b'; env.draft = 'other edit'
    request.resolve({ observedRevision: 2 })
    await saving
    expect(other.dirty).toBe(true)
    expect(other.persistedMarkdown).toBe('other original')
    expect(env.refreshHeader).not.toHaveBeenCalled()
  })
})

function searchHarness() {
  const box = { innerHTML: '', setAttribute: vi.fn() }
  const env: Record<string, any> = {
    state: { view: 'knowledge', searchQuery: '', searchResults: null, searchStatus: 'idle', searchError: '', knowledgeCache: null },
    viewSeq: 1, searchSeq: 0, api: vi.fn(), renderKnowledgeSearchState: vi.fn(), renderKnowledgeView: vi.fn(),
    $: (selector: string) => selector === '#kbBody' ? box : null,
    console: { debug: vi.fn() }, esc: (value: string) => value, t: (key: string) => key,
    viewMark: vi.fn(), knowledgeCardHtml: vi.fn(), box,
  }
  runInNewContext(browserSection('async function runSearch(q)', 'async function syncNow()') +
    browserSection('function clearKnowledgeSearch()', '// Unified knowledge card:') +
    browserSection('async function renderKnowledgeBrowseInto()', 'function searchCardsHtml('), env)
  return env
}

describe('browser knowledge search async ownership', () => {
  it('shows the latest search when earlier success and errors arrive late', async () => {
    const env = searchHarness(), older = deferred<any>(), latest = deferred<any>()
    env.api.mockReturnValueOnce(older.promise).mockReturnValueOnce(latest.promise)
    const first = env.runSearch('older'), second = env.runSearch('latest')
    latest.resolve({ results: [{ title: 'correct latest' }] }); await second
    older.reject(new Error('old request failed')); await first
    expect(env.state.searchQuery).toBe('latest')
    expect(env.state.searchStatus).toBe('success')
    expect(env.state.searchResults).toEqual([{ title: 'correct latest' }])
    expect(env.state.searchError).toBe('')
  })

  it('does not restore a cleared query when its response arrives', async () => {
    const env = searchHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    const searching = env.runSearch('discarded')
    env.clearKnowledgeSearch()
    request.resolve({ results: [{ title: 'stale' }] }); await searching
    expect(env.state.searchQuery).toBe('')
    expect(env.state.searchResults).toBe(null)
    expect(env.state.searchStatus).toBe('idle')
  })

  it('does not update a different view after navigation', async () => {
    const env = searchHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    const searching = env.runSearch('old query')
    env.state.view = 'notes'; env.viewSeq++
    request.resolve({ results: [{ title: 'stale' }] }); await searching
    expect(env.state.searchResults).toBe(null)
    expect(env.renderKnowledgeSearchState).toHaveBeenCalledTimes(1)
  })

  it('does not let an older knowledge-home request paint over search results', async () => {
    const env = searchHarness(), browse = deferred<any>(), search = deferred<any>()
    env.api.mockReturnValueOnce(browse.promise).mockReturnValueOnce(search.promise)
    const browsing = env.renderKnowledgeBrowseInto()
    const searching = env.runSearch('new query')
    search.resolve({ results: [] }); await searching
    env.box.innerHTML = 'search owns this surface'
    browse.resolve([]); await browsing
    expect(env.box.innerHTML).toBe('search owns this surface')
    expect(env.state.knowledgeCache).toBe(null)
  })
})

describe('version and search presentation', () => {
  it('uses the supplied package version and safely embeds script-sensitive input', () => {
    const page = renderPage('0.2.0-rc.1</script><script>throw new Error("injected")</script>')
    expect(page).not.toContain('1d93f55')
    expect(page.match(/<script>/g)).toHaveLength(1)
    expect(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(page)![1]!)).not.toThrow()
    expect(page).toContain('0.2.0-rc.1\\u003c/script>')
  })
  it('provides a keyboard and touch search action, status and recoverable error', () => {
    const js = script()
    expect(js).toContain('id="kbSearchForm"')
    expect(js).toContain('type="submit"')
    expect(js).toContain('for="kbSearch"')
    expect(js).toContain('data-action="kb-retry-search"')
    expect(js).toContain('aria-busy')
    expect(js).not.toContain("noteBodyMatch:'正文命中'")
    expect(js).not.toContain('esc(s.knowledgeId)')
  })
})

describe('browser async work stays with its original note', () => {
  it('keeps an in-flight note load valid when a new-note prompt is canceled', async () => {
    const env = editorHarness(), request = deferred<any>(), main = { innerHTML: '' }, detail = { innerHTML: '' }
    env.state.editor.dirty = false
    Object.assign(env, {
      $: (selector: string) => selector === '#main' ? main : detail,
      localStorage: { getItem: () => 'source' }, prompt: () => null, isMobile: () => false,
      renderEditorShell: () => 'loaded note', bindEditor: vi.fn(), detailNote: () => 'detail',
      expandFoldersForPath: vi.fn(), renderNoteAttachmentKnowledge: vi.fn(), renderSources: vi.fn(), renderRelatedKnowledge: vi.fn(),
    })
    env.api.mockReturnValue(request.promise)
    runInNewContext(browserSection('async function openNote(', 'function renderMissingNote(') +
      browserSection('async function newNote()', 'function inlineRenameTitle('), env)
    const opening = env.openNote('note-b'); await microtasks()
    await env.newNote()
    request.resolve({ markdown: 'body', note: { noteId: 'note-b', relativePath: 'b.md' }, attachments: [] })
    await opening
    expect(main.innerHTML).toBe('loaded note')
    expect(env.state.selectedNoteId).toBe('note-b')
  })

  it('ignores an old note sync response after another note opens', async () => {
    const env = editorHarness(), request = deferred<any>(), status = { innerHTML: 'note-b pending' }
    Object.assign(env, { document: { hidden: false }, $: () => status, patchNoteBadge: vi.fn(), syncBadgeHtml: () => 'synced', scheduleSyncPoll: vi.fn() })
    env.api.mockReturnValue(request.promise)
    runInNewContext(browserSection('async function pollSync()', 'function patchNoteBadge('), env)
    const polling = env.pollSync()
    env.state.selectedNoteId = 'note-b'; env.state.editor = { noteId: 'note-b' }
    request.resolve({ sync: { syncState: 'synced' } }); await polling
    expect(env.patchNoteBadge).not.toHaveBeenCalled()
    expect(status.innerHTML).toBe('note-b pending')
  })

  it('does not navigate back when an older wiki lookup completes', async () => {
    const env = editorHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    env.findNoteByTitleOrPath = () => ({ noteId: 'note-b' })
    runInNewContext(browserSection('async function openWikiTarget(', 'function findNoteByTitleOrPath('), env)
    const opening = env.openWikiTarget('Note B')
    env.navigationSeq++; env.state.view = 'overview'
    request.resolve({ root: [] }); await opening
    expect(env.state.view).toBe('overview')
    expect(env.render).not.toHaveBeenCalled()
  })

  it('keeps upload ownership and never inserts an old file into a new note', async () => {
    const env = editorHarness(), request = deferred<any>(), readers: any[] = []
    const firstEditor = { insertValue: vi.fn() }, secondEditor = { insertValue: vi.fn() }
    Object.assign(env, {
      vditor: firstEditor, showActivity: vi.fn(), clearActivity: vi.fn(), encodeAttachmentPath: (name: string) => name,
      FileReader: class {
        result = 'data:application/pdf;base64,YQ=='
        onload = () => {}
        constructor() { readers.push(this) }
        readAsDataURL() {}
      },
    })
    env.api.mockReturnValue(request.promise)
    runInNewContext(browserSection('function uploadVditorFiles(', 'function getEditorValue('), env)
    env.uploadVditorFiles([{ name: 'source.pdf', type: 'application/pdf' }], false)
    env.state.editor = { noteId: 'note-b' }; env.state.selectedNoteId = 'note-b'; env.vditor = secondEditor
    readers[0].onload()
    expect(env.api).toHaveBeenCalledWith('uploadAttachment', expect.objectContaining({ ownerNoteId: 'note-a' }))
    request.resolve({ attachmentId: 'att_123456789abc', filename: 'source.pdf' }); await microtasks()
    expect(firstEditor.insertValue).not.toHaveBeenCalled()
    expect(secondEditor.insertValue).not.toHaveBeenCalled()
    expect(env.toast).toHaveBeenCalledWith('uploadRetained', 'ok')
  })

  it('provides an explicit highlight tool instead of an unsupported built-in mark button', () => {
    const env: Record<string, any> = { isMobile: () => false, t: (key: string) => key, editorWrap: vi.fn() }
    runInNewContext(browserSection('function vditorToolbar()', 'function mobileVditorToolbar('), env)
    const mark = env.vditorToolbar().find((item: any) => item.name === 'mark')
    expect(mark.tip).toBe('highlight')
    expect(mark.icon).toContain('H')
    mark.click()
    expect(env.editorWrap).toHaveBeenCalledWith('==', '==')
  })
})

describe('browser revision conflict recovery', () => {
  it('sends both read tokens and adopts new tokens after a successful save', async () => {
    const env = editorHarness()
    env.state.editor.observedRevision = 7; env.state.editor.contentHash = 'read-hash'
    env.api.mockResolvedValue({ observedRevision: 8, contentHash: 'saved-hash' })
    await env.autosave()
    expect(env.api).toHaveBeenCalledWith('saveNote', {
      noteId: 'note-a', markdown: 'first edit', expectedRevision: 7, expectedContentHash: 'read-hash',
    })
    expect(env.state.editor.observedRevision).toBe(8)
    expect(env.state.editor.contentHash).toBe('saved-hash')
  })

  it('preserves the draft on conflict, blocks navigation, and stops automatic retry', async () => {
    const env = editorHarness()
    const error = Object.assign(new Error('note changed'), { code: 'PKW_NOTE_CONFLICT' })
    env.api.mockRejectedValue(error)
    await env.autosave()
    expect(env.state.editor.conflict).toBe(true)
    expect(env.state.editor.dirty).toBe(true)
    expect(env.draft).toBe('first edit')
    expect(env.state.editor.persistedMarkdown).toBe('original')
    await env.autosave()
    expect(await env.setView('tasks')).toBe(false)
    expect(env.api).toHaveBeenCalledTimes(1)
    expect(env.setTimeout).not.toHaveBeenCalled()
    expect(env.state.view).toBe('notes')
  })

  it('keeps a conflicted draft protected even when edited back to its old value', () => {
    const env = editorHarness()
    env.state.editor.conflict = true; env.draft = 'original'; env.updateNoteConflict = vi.fn()
    runInNewContext(browserSection('function onEditorInput()', 'function updateSaveStatus('), env)
    env.onEditorInput()
    expect(env.state.editor.dirty).toBe(true)
    expect(env.setTimeout).not.toHaveBeenCalled()
    expect(env.updateNoteConflict).toHaveBeenCalled()
  })

  it('requires explicit discard confirmation to reload and offers manual copy when clipboard fails', async () => {
    const env = editorHarness(), details = { open: false }
    const draft = { closest: () => details, focus: vi.fn(), select: vi.fn() }
    Object.assign(env, { $: () => draft, navigator: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } },
      confirm: vi.fn().mockReturnValue(false), openNote: vi.fn() })
    env.state.editor.conflict = true
    runInNewContext(browserSection('function updateNoteConflict()', 'function applyPreviewHighlight('), env)
    await env.copyNoteDraft()
    expect(env.navigator.clipboard.writeText).toHaveBeenCalledWith('first edit')
    expect(details.open).toBe(true)
    expect(draft.select).toHaveBeenCalled()
    await env.reloadConflictedNote()
    expect(env.state.editor.dirty).toBe(true)
    expect(env.openNote).not.toHaveBeenCalled()
    env.confirm.mockReturnValue(true)
    env.updateNoteConflict = vi.fn()
    const latest = { markdown: 'latest' }
    env.api.mockResolvedValue(latest)
    await env.reloadConflictedNote()
    expect(env.openNote).toHaveBeenCalledWith('note-a', latest)
    expect(env.state.editor.dirty).toBe(false)
  })

  it('keeps the original draft and recovery controls when reloading fails', async () => {
    const env = editorHarness()
    env.state.editor.conflict = true
    Object.assign(env, { confirm: () => true, openNote: vi.fn() })
    runInNewContext(browserSection('async function reloadConflictedNote()', 'function applyPreviewHighlight('), env)
    env.updateNoteConflict = vi.fn()
    env.api.mockRejectedValue(new Error('connection lost'))
    await env.reloadConflictedNote()
    expect(env.state.editor.conflict).toBe(true)
    expect(env.state.editor.dirty).toBe(true)
    expect(env.state.editor.reloading).toBe(false)
    expect(env.draft).toBe('first edit')
    expect(env.openNote).not.toHaveBeenCalled()
    expect(env.toast).toHaveBeenLastCalledWith('reloadFailed', 'err')
  })

  it('does not discard edits typed while the latest note is loading', async () => {
    const env = editorHarness(), request = deferred<any>()
    env.state.editor.conflict = true
    Object.assign(env, { confirm: () => true, openNote: vi.fn() })
    runInNewContext(browserSection('async function reloadConflictedNote()', 'function applyPreviewHighlight('), env)
    env.updateNoteConflict = vi.fn(); env.api.mockReturnValue(request.promise)
    const reloading = env.reloadConflictedNote()
    env.draft = 'new edits made during reload'
    request.resolve({ markdown: 'latest server note' }); await reloading
    expect(env.openNote).not.toHaveBeenCalled()
    expect(env.state.editor.dirty).toBe(true)
    expect(env.draft).toBe('new edits made during reload')
    expect(env.toast).toHaveBeenLastCalledWith('reloadDraftChanged', 'warn')
  })

  it('preserves server error codes in the RPC bridge for conflict handling', async () => {
    const env: Record<string, any> = {
      fetch: async () => ({ ok: false, status: 409, json: async () => ({ ok: false, error: 'note changed', code: 'PKW_NOTE_CONFLICT' }) }),
    }
    runInNewContext(browserSection('const api = async', 'const $ =') + '\nglobalThis.callApi = api', env)
    await expect(env.callApi('saveNote', {})).rejects.toMatchObject({ code: 'PKW_NOTE_CONFLICT', message: 'note changed' })
  })

  it('keeps current note and search requests alive when their active navigation item is clicked', async () => {
    const env = editorHarness()
    env.state.editor.dirty = false
    env.noteSeq = 3; env.viewSeq = 5
    expect(await env.setView('notes')).toBe(true)
    expect(env.noteSeq).toBe(3); expect(env.viewSeq).toBe(5)
    env.state.view = 'knowledge'; env.state.searchStatus = 'loading'
    expect(await env.setView('knowledge')).toBe(true)
    expect(env.viewSeq).toBe(5)
    expect(env.render).not.toHaveBeenCalled()
  })
})

function transformHarness() {
  const env = editorHarness()
  env.state.editor.mode = 'live'
  const source = { value: 'source', selectionStart: 0, selectionEnd: 0 }
  env.$ = () => source
  env.vditor = { getValue: () => env.draft, setValue: vi.fn(), vditor: { ir: { element: { scrollTop: 0 } } } }
  env.getEditorValue = () => ({ kind: env.state.editor.mode === 'live' ? 'body' : 'markdown', value: env.draft })
  env.resolveCellInEditor = () => ({ tableIndex: 0, isHeader: true, rowIndex: 0, columnIndex: 0 })
  env.restoreCellCaret = vi.fn(); env.setEditorValue = vi.fn(); env.onEditorInput = vi.fn()
  runInNewContext(browserSection('function captureEditorSnapshot()', 'function showTableContextMenu(') +
    browserSection('function applyFootnoteEdit(', 'function jumpToFootnoteDef('), env)
  return env
}

describe('browser text transformations own their original draft', () => {
  const mutations = [
    ['table', (env: any) => env.applyTableMutation({}, 'addRowAbove')],
    ['footnote edit', (env: any) => env.applyFootnoteEdit('1', 'definition')],
    ['footnote delete', (env: any) => env.applyFootnoteDelete('1')],
  ] as const
  it.each(mutations)('%s rejects an old response after opening another note', async (_, invoke) => {
    const env = transformHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    invoke(env)
    env.state.selectedNoteId = 'note-b'; env.state.editor = { noteId: 'note-b', mode: 'live' }; env.draft = 'note-b text'
    request.resolve({ markdown: 'old transformed text' }); await microtasks()
    expect(env.vditor.setValue).not.toHaveBeenCalled()
    expect(env.setEditorValue).not.toHaveBeenCalled()
    expect(env.onEditorInput).not.toHaveBeenCalled()
    expect(env.toast).toHaveBeenCalledWith('editorOperationStale', 'warn')
  })
  it.each(mutations)('%s keeps new input typed during its request', async (_, invoke) => {
    const env = transformHarness(), request = deferred<any>()
    env.api.mockReturnValue(request.promise)
    invoke(env); env.draft = 'newer user input'
    request.resolve({ markdown: 'old transformed text' }); await microtasks()
    expect(env.vditor.setValue).not.toHaveBeenCalled()
    expect(env.setEditorValue).not.toHaveBeenCalled()
    expect(env.draft).toBe('newer user input')
  })
  it.each(mutations)('%s applies to an unchanged owned draft', async (_, invoke) => {
    const env = transformHarness()
    env.api.mockResolvedValue({ markdown: 'transformed text' })
    invoke(env); await microtasks()
    expect(env.vditor.setValue.mock.calls.concat(env.setEditorValue.mock.calls)).toEqual([['transformed text']])
    expect(env.onEditorInput).toHaveBeenCalledTimes(1)
  })
  it('applies a valid empty result when deleting the last table', async () => {
    const env = transformHarness()
    env.api.mockResolvedValue({ markdown: '' })
    env.applyTableMutation({}, 'deleteTable'); await microtasks()
    expect(env.vditor.setValue).toHaveBeenCalledWith('')
    expect(env.onEditorInput).toHaveBeenCalledTimes(1)
  })
  it('rejects mode or editor-instance replacement even when text and NoteId are unchanged', () => {
    const env = transformHarness(), snapshot = env.captureEditorSnapshot()
    env.state.editor.mode = 'source'
    expect(env.acceptEditorSnapshot(snapshot)).toBe(false)
    env.state.editor.mode = 'live'; env.vditor = { ...env.vditor }
    expect(env.acceptEditorSnapshot(snapshot)).toBe(false)
  })
  it('does not insert a footnote when its key response belongs to a previous draft', async () => {
    const env = transformHarness(), request = deferred<any>()
    Object.assign(env, {
      getEditorSelection: () => '', document: { querySelector: () => null },
      footnoteModal: (_title: string, _initial: string, _placeholder: string, onOk: any) => { env.submitFootnote = onOk },
      insertFootnoteReference: vi.fn(), appendFootnoteDefinitionAtEnd: vi.fn(),
    })
    runInNewContext(browserSection('function footnoteDialog()', 'function editFootnoteDialog('), env)
    env.api.mockReturnValue(request.promise)
    env.footnoteDialog(); env.submitFootnote('footnote text')
    env.draft = 'new input'
    request.resolve({ key: '1' }); await microtasks()
    expect(env.insertFootnoteReference).not.toHaveBeenCalled()
    expect(env.appendFootnoteDefinitionAtEnd).not.toHaveBeenCalled()
  })
})

function taskSaveHarness() {
  const fields: Record<string, any> = Object.fromEntries([
    ['#tdTitle', 'original task'], ['#tdDesc', 'description'], ['#tdStatus', 'open'], ['#tdMatrix', ''],
    ['#tdQuad', '1'], ['#tdSched', ''], ['#tdDue', ''], ['#tdTags', 'tag'],
  ].map(([key, value]) => [key, { value }]))
  const env: Record<string, any> = {
    taskId: 'task-a', editGeneration: 1, parentDirty: true, saving: false, fields, qs: (key: string) => fields[key],
    isActive: () => true, updateState: vi.fn(), api: vi.fn(), refreshTasks: vi.fn(), close: vi.fn(), toast: vi.fn(), t: (key: string) => key,
  }
  runInNewContext(browserSection('const doSave = (andClose)', '// Subtask create is an INDEPENDENT') +
    '\nglobalThis.saveTask = doSave\n' + browserSection('const markDirty = () =>', 'const renderSubtaskSection =') +
    '\nglobalThis.markTaskDirty = markDirty', env)
  return env
}

describe('task save and attachment selection races', () => {
  it('retains edits typed while saving a task and does not close over newer changes', async () => {
    const env = taskSaveHarness(), first = deferred<any>(), second = deferred<any>()
    env.api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    env.saveTask(true)
    expect(env.api).toHaveBeenLastCalledWith('updateTask', expect.objectContaining({ patch: expect.objectContaining({ title: 'original task' }) }))
    env.fields['#tdTitle'].value = 'newer task title'; env.markTaskDirty()
    first.resolve({}); await microtasks()
    expect(env.parentDirty).toBe(true)
    expect(env.close).not.toHaveBeenCalled()
    env.saveTask(true)
    expect(env.api).toHaveBeenLastCalledWith('updateTask', expect.objectContaining({ patch: expect.objectContaining({ title: 'newer task title' }) }))
    second.resolve({}); await microtasks()
    expect(env.parentDirty).toBe(false)
    expect(env.close).toHaveBeenCalledTimes(1)
  })
  it('sends explicit empty-string values to clear both task dates', async () => {
    const env = taskSaveHarness()
    env.api.mockResolvedValue({})
    env.saveTask(false); await microtasks()
    expect(env.api).toHaveBeenCalledWith('updateTask', expect.objectContaining({ patch: expect.objectContaining({ dueAt: '', scheduledAt: '' }) }))
  })
  it('keeps the latest attachment details and actions when an older response arrives', async () => {
    const first = deferred<any>(), second = deferred<any>(), detail = { innerHTML: '' }
    const env: Record<string, any> = {
      attachmentSeq: 0, viewSeq: 0, state: { view: 'attachments', selectedAttachmentId: null },
      api: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
      $: () => detail, esc: (x: any) => String(x ?? ''), t: (key: string) => key,
      procStateBadge: () => '', configurationHint: () => '', fmtSize: () => '', fmtStamp: () => '', isMobile: () => false, toast: vi.fn(),
    }
    runInNewContext(browserSection('async function openAttachment(', 'function fileToBase64('), env)
    const a = env.openAttachment('att-a'), b = env.openAttachment('att-b')
    second.resolve({ attachment: { attachmentId: 'att-b', filename: 'B' } }); await b
    first.resolve({ attachment: { attachmentId: 'att-a', filename: 'A' } }); await a
    expect(env.state.selectedAttachmentId).toBe('att-b')
    expect(detail.innerHTML).toContain('data-action="delete-attachment" data-id="att-b"')
    expect(detail.innerHTML).not.toContain('att-a')
  })
})

function statusHarness() {
  const env: Record<string, any> = { t: (key: string) => key, esc: (value: any) => String(value ?? '') }
  runInNewContext(browserSection('function syncConfigurationState(', 'function isTerminalSync(') +
    browserSection('function procStateBadge(', 'let sourcesPollTimer'), env)
  return env
}
describe('honest configuration and synchronization status', () => {
  it.each(['missing_base_url', 'missing_credential', 'missing_kb'])('shows %s as awaiting configuration across note, knowledge and source badges', configuration => {
    const env = statusHarness(), sync = { configuration, pending: true, intentState: 'pending' }
    expect(env.syncBadgeHtml(sync)).toContain('syncWaitingConfig')
    expect(env.knowledgeBadge(sync)).toContain('syncWaitingConfig')
    expect(env.procStateBadge('processing', sync)).toContain('syncWaitingConfig')
    expect(env.syncBadgeHtml(sync)).not.toContain('>syncing<')
    expect(env.configurationHint(sync)).toContain('syncWaitingConfigHint')
  })
  it('distinguishes queued work, running work, configuration failures and real errors', () => {
    const env = statusHarness()
    expect(env.syncBadgeHtml({ configuration: 'configured', pending: true, intentState: 'pending' })).toContain('>pending<')
    expect(env.syncBadgeHtml({ configuration: 'configured', pending: true, intentState: 'running' })).toContain('>syncing<')
    expect(env.knowledgeBadge({ configuration: 'configured', pending: true, intentState: 'running' })).toContain('>syncing<')
    expect(env.syncBadgeHtml({ configuration: 'unavailable', pending: true })).toContain('syncConfigUnavailable')
    expect(env.syncBadgeHtml({ configuration: 'missing_credential', error: 'previous failure' })).toContain('>failed<')
  })
})

function navigationRenderHarness() {
  const env: Record<string, any> = {
    state: { selectedNoteId: null, selectedFolder: null, collapsed: new Set(), explorerSel: new Set() },
    esc: (value: any) => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)),
    t: (key: string, vars?: any) => key + (vars?.name ? ':' + vars.name : ''), syncBadgeHtml: () => '', renderTreeNodes: () => '',
    fmtStamp: () => '', folderNoteCount: () => 0, procStateBadge: () => '', attTypeOf: () => '', fmtSize: () => '', matrixName: () => '',
    isMobile: () => true,
  }
  runInNewContext(browserSection('function renderFolderNode(', 'function renderDetail(') +
    browserSection('function explorerNoteRow(', 'function explorerSelBarHtml(') +
    browserSection('function mobileFolderCard(', 'function renderMobileNotesHome(') +
    browserSection('function mobileNoteRow(', '// Full-screen mobile detail') +
    browserSection('function knowledgeCardHtml(', 'async function renderKnowledgeBrowseInto('), env)
  return env
}

describe('keyboard-accessible navigation and folder actions', () => {
  it('renders native note and folder buttons with independent named selection controls', () => {
    const env = navigationRenderHarness()
    const note = { noteId: 'n1', title: 'Project <One>', relativePath: 'a.md' }, folder = { path: 'work', name: 'Work', children: [] }
    expect(env.renderNoteNode(note)).toMatch(/<button[^>]+data-action="open-note"[^>]*>Project &lt;One&gt;<\/button>/)
    expect(env.explorerNoteRow(note, false)).toMatch(/<button[^>]+data-action="explorer-note"/)
    expect(env.explorerNoteRow(note, false)).toContain('aria-label="selectItem:Project &lt;One&gt;"')
    expect(env.explorerFolderRow(folder, false)).toMatch(/<button[^>]+data-action="explorer-folder"/)
    expect(env.explorerFolderRow(folder, false)).toContain('aria-label="selectItem:Work"')
    env.state.collapsed.add('work')
    expect(env.renderFolderNode(folder)).toMatch(/<button[^>]+data-action="toggle-folder"[^>]+aria-expanded="false"/)
    expect(env.renderFolderNode(folder)).toMatch(/<button[^>]+data-action="select-folder"/)
  })

  it('gives mobile cards native open controls and names the per-item menus', () => {
    const env = navigationRenderHarness()
    const note = env.mobileNoteRow({ noteId: 'n1', title: 'One', relativePath: 'one.md' })
    const folder = env.mobileFolderCard({ name: 'Work', path: 'work' })
    const source = env.mobileSourceCard({ attachmentId: 'a1', filename: 'file.pdf' })
    const task = env.mobileTaskCard({ taskId: 't1', title: 'Task', status: 'open' }, [], true)
    for (const [html, action, name] of [[note, 'open-note', 'One'], [folder, 'mobile-folder-open', 'Work'], [source, 'open-attachment', 'file.pdf'], [task, 'open-task-detail', 'Task']]) {
      expect(html).toMatch(new RegExp('<button[^>]+data-action="' + action + '"'))
      expect(html).toContain('aria-label="itemActions:' + name + '"')
    }
    expect(task).toMatch(/<button[^>]+aria-pressed="false"[^>]+data-action="toggle-task"/)
    const card = env.knowledgeCardHtml({ title: 'Found note', open: { action: 'open-note', id: 'n1' } })
    expect(card).toMatch(/<button[^>]+data-action="open-note"[^>]*>Found note<\/button>/)
  })

  it('returns keyboard focus to the same checkbox after its list is replaced', () => {
    const input = { focus: vi.fn() }
    const env: Record<string, any> = { state: { explorerSel: new Set() }, renderNotesExplorer: vi.fn(),
      CSS: { escape: (key: string) => key }, document: { querySelector: vi.fn().mockReturnValue(input) } }
    runInNewContext(browserSection('function explorerToggleSel(', 'function explorerClearSel('), env)
    env.explorerToggleSel('note:n1')
    expect(env.state.explorerSel.has('note:n1')).toBe(true)
    expect(env.document.querySelector).toHaveBeenCalledWith('.exp-check[data-key="note:n1"]')
    expect(input.focus).toHaveBeenCalledTimes(1)
  })

  it('passes the folder path from the actual toolbar menu through the delegated rename and delete actions', async () => {
    let click!: (event: any) => Promise<void>
    const menu = { style: {}, innerHTML: '', id: '', className: '' }
    const env: Record<string, any> = {
      document: { addEventListener: (_type: string, callback: any) => { click = callback }, createElement: () => menu, body: { appendChild: vi.fn() } },
      window: { innerWidth: 1200, innerHeight: 800 }, esc: (value: any) => String(value ?? ''), t: (key: string) => key,
      dismissWikiSuggest: vi.fn(), dismissContextMenu: vi.fn(), dismissSelButton: vi.fn(), renameFolder: vi.fn(), deleteFolder: vi.fn(),
    }
    runInNewContext(browserSection('function showContextMenu(', '// ── Mobile presentation layer') +
      browserSection('// ── Delegated events', '// Trash selection is pure local state'), env)
    const event = (dataset: Record<string, string>) => ({ clientX: 10, clientY: 20, target: { closest: (selector: string) => selector === '[data-action]' ? { dataset } : null } })
    await click(event({ action: 'folder-menu', path: 'projects/work' }))
    expect(menu.innerHTML).toContain('data-action="rename-folder" data-path="projects/work"')
    expect(menu.innerHTML).toContain('data-action="delete-folder" data-path="projects/work"')
    await click(event({ action: 'rename-folder', path: 'projects/work' }))
    await click(event({ action: 'delete-folder', path: 'projects/work' }))
    expect(env.renameFolder).toHaveBeenCalledWith('projects/work')
    expect(env.deleteFolder).toHaveBeenCalledWith('projects/work')
  })
})

// These emitted navigation fragments use explicit closing tags. Reject mismatches
// before browser HTML repair can silently change delegated-action ancestry.
function navigationFragment(html: string): any[] {
  const nodes: any[] = [], stack: any[] = []
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link'])
  for (const token of html.matchAll(/<\/?([a-z][\w-]*)([^>]*?)\/?>/gi)) {
    const tag = token[1]!.toLowerCase()
    if (token[0].startsWith('</')) {
      expect(stack.at(-1)?.tag, 'unbalanced navigation fragment at ' + token[0]).toBe(tag)
      stack.pop(); continue
    }
    const attrs = Object.fromEntries(Array.from(token[2]!.matchAll(/([\w-]+)="([^"]*)"/g), match => [match[1]!, match[2]!]))
    const node: any = { tag, attrs, parent: stack.at(-1), dataset: {} }
    for (const [key, value] of Object.entries(attrs)) if (key.startsWith('data-')) node.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
    node.closest = (selector: string) => {
      for (let current: any = node; current; current = current.parent) {
        if (selector === '[data-action]' && current.dataset.action) return current
      }
      return null
    }
    nodes.push(node)
    if (!voidTags.has(tag) && !token[0].endsWith('/>')) stack.push(node)
  }
  expect(stack, 'navigation fragment must close all non-void elements').toHaveLength(0)
  return nodes
}

describe('rendered navigation action boundaries', () => {
  it.each([
    ['desktop', 'open'], ['desktop', 'completed'], ['mobile', 'open'], ['mobile', 'completed'],
  ])('%s task title opens details while its status control only toggles completion (%s)', async (surface, status) => {
    const env = navigationRenderHarness()
    env.isMobile = () => surface === 'mobile'
    runInNewContext(browserSection('function taskRow(', 'function moveTaskOrder('), env)
    const nodes = navigationFragment(env.taskRow({ taskId: 'task-a', title: 'Task title', status }, [], false))
    const title = nodes.find(node => node.attrs.class?.split(' ').includes(surface === 'mobile' ? 'mtask-title' : 'nm'))
    const toggle = nodes.find(node => node.dataset.action === 'toggle-task')
    expect(title.closest('[data-action]').dataset.action).toBe('open-task-detail')
    expect(toggle.closest('[data-action]').dataset.action).toBe('toggle-task')
    let click!: (event: any) => Promise<void>
    Object.assign(env, {
      document: { addEventListener: (_type: string, callback: any) => { click = callback } },
      dismissWikiSuggest: vi.fn(), dismissContextMenu: vi.fn(), dismissSelButton: vi.fn(),
      taskDetailDialog: vi.fn(), api: vi.fn().mockResolvedValue({}), refreshTasks: vi.fn(), taskDetailRefreshSubtasks: null,
    })
    runInNewContext(browserSection('// ── Delegated events', '// Trash selection is pure local state'), env)
    await click({ target: title })
    expect(env.taskDetailDialog).toHaveBeenCalledWith('task-a')
    expect(env.api).not.toHaveBeenCalled()
    await click({ target: toggle }); await microtasks()
    expect(env.api).toHaveBeenCalledWith(status === 'completed' ? 'reopenTask' : 'completeTask', { taskId: 'task-a' })
    expect(env.taskDetailDialog).toHaveBeenCalledTimes(1)
  })

  it('keeps every touched native-button fragment balanced and never nests buttons', () => {
    const env = navigationRenderHarness()
    runInNewContext(browserSection('function mobileCompletedTaskRow(', 'function renderTaskList('), env)
    const note = { noteId: 'n1', title: 'Note', relativePath: 'note.md' }, folder = { name: 'Work', path: 'work', children: [] }
    const fragments = [env.renderNoteNode(note), env.renderFolderNode(folder), env.explorerNoteRow(note, false), env.explorerFolderRow(folder, false),
      env.mobileNoteRow(note), env.mobileFolderCard(folder), env.mobileSourceCard({ attachmentId: 'a1', filename: 'file.pdf' }),
      env.mobileTaskCard({ taskId: 't1', title: 'Task', status: 'open' }, [], true),
      env.mobileCompletedTaskRow({ taskId: 't1', title: 'Task', status: 'completed' }),
      env.knowledgeCardHtml({ title: 'Found', open: { action: 'open-note', id: 'n1' } })]
    for (const html of fragments) {
      for (const node of navigationFragment(html).filter(node => node.tag === 'button')) {
        for (let ancestor = node.parent; ancestor; ancestor = ancestor.parent) expect(ancestor.tag).not.toBe('button')
      }
    }
  })
})
