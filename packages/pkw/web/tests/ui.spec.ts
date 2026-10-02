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
    expect(js).toContain("PKW_BASE + '/attachment/'")
    expect(js).toContain('const PKW_BASE = "/pkw"')
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
    expect(js).toContain("mode: isMobile() || workspaceReadOnly() ? 'reading'")
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
    performance: { now: () => 0 }, render: vi.fn(), workspaceReadOnly: () => false,
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
    env.PKW_BASE = '/pkw'; env.ensureWorkspaceSession = async () => null
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
    taskConflict: false, taskReloading: false, taskContentHash: 'a'.repeat(64),
    isActive: () => true, updateState: vi.fn(), api: vi.fn(), refreshTasks: vi.fn(), close: vi.fn(), toast: vi.fn(), t: (key: string) => key,
    requestClose: () => env.close(),
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

// A small deterministic DOM/event model for the emitted dialog code. It checks
// explicit markup, focus ownership and event routing; real layout/AT remain a
// browser acceptance layer, not something this model claims to emulate.
function dialogHarness() {
  const listeners: Record<string, { callback: any; capture: boolean }[]> = {}
  const observers = new Set<any>()
  let document: any, scheduled = false
  const mutate = () => {
    if (scheduled) return
    scheduled = true
    Promise.resolve().then(() => { scheduled = false; for (const observer of [...observers]) observer.callback() })
  }
  const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  class Element {
    tagName: string; attrs: Record<string, string> = {}; children: Element[] = []; parentElement: Element | null = null
    style: Record<string, string> = {}; events: Record<string, any[]> = {}; dataset: Record<string, string> = {}
    inert = false; disabled = false; hidden = false; checked = false; files: any[] = []; ownText = ''; valueOverride: string | undefined; tabOverride: number | undefined
    constructor(tag: string) { this.tagName = tag.toUpperCase() }
    get id() { return this.attrs.id || '' } set id(value: string) { this.attrs.id = value }
    get className() { return this.attrs.class || '' } set className(value: string) { this.attrs.class = value }
    get isConnected(): boolean { return this === document.body || !!this.parentElement?.isConnected }
    get firstElementChild(): Element | null { return this.children[0] || null }
    get tabIndex() { return this.tabOverride ?? (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A'].includes(this.tagName) ? 0 : -1) }
    set tabIndex(value: number) { this.tabOverride = value }
    get value(): string { return this.valueOverride ?? this.attrs.value ?? (this.tagName === 'SELECT' ? (this.querySelector('option[selected]') || this.querySelector('option'))?.value || '' : this.tagName === 'TEXTAREA' ? this.textContent : '') }
    set value(value: string) { this.valueOverride = value }
    get textContent(): string { return this.ownText + this.children.map(child => child.textContent).join('') }
    set textContent(value: string) { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = value; mutate() }
    set innerHTML(html: string) {
      navigationFragment(html)
      for (const child of this.children) child.parentElement = null
      this.children = []; this.ownText = ''
      const stack: Element[] = [this]
      for (const token of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
        const raw = token[0]
        if (raw.startsWith('</')) { stack.pop(); continue }
        if (!raw.startsWith('<')) { stack.at(-1)!.ownText += decode(raw); continue }
        const tag = /^<([\w-]+)/.exec(raw)![1]!, el = new Element(tag)
        const attrText = raw.slice(tag.length + 1).replace(/\/?\s*>$/, '')
        for (const attr of attrText.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) el.setAttribute(attr[1]!, decode(attr[2] || ''))
        stack.at(-1)!.appendChild(el)
        if (!['input', 'img', 'br', 'hr', 'meta', 'link'].includes(tag) && !raw.endsWith('/>')) stack.push(el)
      }
      mutate()
    }
    get innerHTML(): string { return '' }
    setAttribute(key: string, value: string) {
      this.attrs[key] = value
      if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
      if (key === 'disabled') this.disabled = true
      if (key === 'hidden') this.hidden = true
      if (key === 'checked') this.checked = true
      if (key === 'tabindex') this.tabIndex = Number(value)
    }
    getAttribute(key: string) { return this.attrs[key] ?? null }
    removeAttribute(key: string) { delete this.attrs[key] }
    appendChild(el: Element) { if (el.parentElement) el.remove(); el.parentElement = this; this.children.push(el); mutate(); return el }
    remove() {
      if (this.contains(document.activeElement)) document.activeElement = document.body
      if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this)
      this.parentElement = null; mutate()
    }
    replaceWith(el: Element) {
      const parent = this.parentElement; if (!parent) return
      const index = parent.children.indexOf(this); this.parentElement = null
      el.parentElement = parent; parent.children[index] = el; mutate()
    }
    select() { this.attrs['data-selected'] = 'true' }
    contains(el: Element | null): boolean { return !!el && (el === this || this.children.some(child => child.contains(el))) }
    matches(selector: string): boolean {
      return selector.split(',').some(part => {
        let sel = part.trim()
        if (sel.includes(' ')) { const pieces = sel.split(/\s+/); const tail = pieces.pop()!; return this.matches(tail) && !!this.parentElement?.closest(pieces.join(' ')) }
        if (sel.endsWith(':checked')) { if (!this.checked) return false; sel = sel.slice(0, -8) }
        for (const match of sel.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
          const name = match[1]!, value = name === 'inert' ? (this.inert ? '' : null) : name === 'hidden' ? (this.hidden ? '' : null) : this.getAttribute(name)
          if (value === null || (match[2] !== undefined && match[2] !== value)) return false
        }
        sel = sel.replace(/\[[^\]]+\]/g, '')
        const id = /#([\w-]+)/.exec(sel); if (id && id[1] !== this.id) return false
        for (const match of sel.matchAll(/\.([\w-]+)/g)) if (!this.className.split(' ').includes(match[1]!)) return false
        const tag = /^[a-z][\w-]*/i.exec(sel); return !tag || tag[0].toUpperCase() === this.tagName
      })
    }
    closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) || null }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
    querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] || null }
    getClientRects() { return this.isConnected && !this.closest('[hidden]') ? [{}] : [] }
    focus() { if (!this.isConnected || this.disabled || this.closest('[inert]')) return; document.activeElement = this; dispatch('focusin', this) }
    addEventListener(type: string, callback: any) { (this.events[type] ||= []).push(callback) }
    click() { if (!this.disabled && !this.closest('[inert]')) dispatch('click', this) }
  }
  const dispatch = (type: string, target: any, extra: any = {}) => {
    const event: any = { type, target, currentTarget: target, ...extra, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() { this.stopped = true }, stopPropagation() { this.stopped = true } }
    for (const item of listeners[type] || []) if (item.capture && !event.stopped) item.callback(event)
    for (let current = target; current && !event.stopped; current = current.parentElement) {
      event.currentTarget = current
      for (const callback of current.events[type] || []) if (!event.stopped) callback(event)
      if (!event.stopped && current['on' + type]) current['on' + type](event)
    }
    for (const item of listeners[type] || []) if (!item.capture && !event.stopped) item.callback(event)
    return event
  }
  document = {
    body: new Element('body'), activeElement: null,
    createElement: (tag: string) => new Element(tag),
    getElementById: (id: string) => document.body.querySelector('#' + id),
    querySelector: (selector: string) => document.body.querySelector(selector), querySelectorAll: (selector: string) => document.body.querySelectorAll(selector),
    addEventListener: (type: string, callback: any, capture = false) => (listeners[type] ||= []).push({ callback, capture }),
  }
  document.activeElement = document.body
  document.body.innerHTML = '<div id="app"><button id="opener">Open</button><main id="main" tabindex="-1"></main></div><div id="toast" role="status"></div>'
  document.getElementById('opener').focus()
  const env: Record<string, any> = {
    document, dispatch, MutationObserver: class { constructor(public callback: any) {} observe() { observers.add(this) } disconnect() { observers.delete(this) } },
    t: (key: string) => key, esc: (value: any) => String(value ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!)),
    $: document.querySelector, toast: vi.fn(), confirm: vi.fn().mockReturnValue(false), api: vi.fn().mockResolvedValue([]),
    localStorage: { getItem: () => null, setItem: vi.fn() }, window: { location: { assign: vi.fn() } }, refreshTasks: vi.fn(),
    console: { debug: vi.fn() }, performance: { now: () => 0 }, setTimeout: vi.fn(), clearTimeout: vi.fn(),
    state: { tasksCache: [{ taskId: 'task-a', title: 'Task <A>', status: 'open', tags: [], parentTaskId: null, contentHash: 'a'.repeat(64) }] },
    navigator: { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('clipboard unavailable')) } },
    quadrantOf: () => 1, subtaskCache: new Map(), fetchSubtasks: vi.fn().mockResolvedValue([]), taskDetailSessionSeq: 0, activeTaskDetailSession: 0,
    taskDetailRefreshSubtasks: null, taskDetailRequestClose: null, taskDetailToggleSubtask: null,
  }
  runInNewContext(browserSection('// ── Dialog lifecycle:', '// ── View switching:') +
    browserSection('function showFolderPicker(', '// ── Attachments:') +
    browserSection('function trashConfirmDialog(', 'function confirmBatchPurge(') +
    browserSection('function mobileActionSheet(', 'function mobileNoteRow(') +
    browserSection('function footnoteModal(', 'function footnoteDialog(') +
    browserSection('function uploadDialog()', 'async function downloadAttachment(') +
    browserSection('function matrixDeleteDialog(', 'function showTrashContextMenu(') +
    browserSection('function quickSwitch()', '// ── Paste image') +
    browserSection('function mobileDetail(', 'function showNoteContextMenu(') +
    browserSection('function taskDraftText(', '// Subtask data cache') +
    browserSection('function inlineEditSubtask(', 'function taskDetailDialog(') +
    browserSection('function taskDetailDialog(', '// Header global search removed'), env)
  env.key = (key: string, extra = {}) => dispatch('keydown', document.activeElement, { key, ...extra })
  return env
}

describe('dialog keyboard and draft lifecycle', () => {
  it('replaces the initial subtask loading state with an empty result even when both lists are empty', async () => {
    const env = dialogHarness()
    env.taskDetailDialog('task-a'); await microtasks()
    expect(env.document.querySelector('#tdSubtasks').textContent).toBe('taskNoTasks')
    expect(env.document.querySelector('#tdSubCount').textContent).toBe('0 / 0')
  })
  it('starts destructive confirmation on cancel, traps Tab and restores the opener without deleting on Escape', async () => {
    const env = dialogHarness(), doc = env.document, remove = vi.fn(), opener = doc.activeElement
    env.trashConfirmDialog('Delete permanently?', 'Cannot restore.', 'Delete', remove)
    const panel = doc.querySelector('.trash-confirm')
    expect(panel.getAttribute('role')).toBe('dialog'); expect(panel.getAttribute('aria-modal')).toBe('true')
    expect(panel.getAttribute('aria-label')).toBe('Delete permanently?')
    expect(doc.activeElement.id).toBe('tcCancel'); expect(doc.getElementById('app').inert).toBe(true)
    expect(doc.getElementById('toast').inert).toBe(false)
    expect(env.key('Tab', { shiftKey: true }).defaultPrevented).toBe(true); expect(doc.activeElement.id).toBe('tcOk')
    env.key('Tab'); expect(doc.activeElement.id).toBe('tcCancel')
    env.key('Escape'); await microtasks()
    expect(remove).not.toHaveBeenCalled(); expect(doc.querySelector('.modal-overlay')).toBeNull()
    expect(doc.activeElement).toBe(opener); expect(doc.getElementById('app').inert).toBe(false)
    expect(doc.body.style.overflow).toBeUndefined()
  })

  it('keeps a folder selection independent and invokes its action only after confirmation', async () => {
    const env = dialogHarness(), moved = vi.fn()
    env.api.mockResolvedValue(['work', 'work/archive'])
    env.showFolderPicker('work', moved); await microtasks()
    expect(env.document.activeElement.id).toBe('pickFolder')
    env.key('Escape'); expect(moved).not.toHaveBeenCalled()
    env.showFolderPicker('work', moved); await microtasks()
    env.document.querySelector('#pickFolder').value = 'work/archive'
    env.document.querySelector('[data-act="pick-ok"]').click()
    expect(moved).toHaveBeenCalledExactlyOnceWith('work/archive')
    expect(env.document.getElementById('app').inert).toBe(false)
  })

  it('keeps mobile actions as balanced independent buttons and lets the selected action bubble once', () => {
    const env = dialogHarness(), actions: string[] = []
    env.document.addEventListener('click', (e: any) => { const action = e.target.closest('[data-action]'); if (action) actions.push(action.dataset.action) })
    env.mobileActionSheet('Note actions', [{ label: 'Rename', action: 'rename-note', id: 'note-a' }, { label: 'Trash', action: 'delete-note', id: 'note-a', danger: true }])
    expect(env.document.querySelector('.mobile-sheet').getAttribute('aria-label')).toBe('Note actions')
    env.document.querySelector('[data-action="rename-note"]').click()
    expect(actions).toEqual(['rename-note']); expect(env.document.querySelector('.mobile-sheet-overlay')).toBeNull()
    expect(env.document.activeElement.id).toBe('opener')
  })

  it('preserves nested task drafts and returns focus to the task after cancelling the close guard', async () => {
    const env = dialogHarness(), doc = env.document
    env.taskDetailDialog('task-a'); await microtasks()
    const title = doc.querySelector('#tdTitle'); title.value = 'Unsent title'; env.dispatch('input', title)
    expect(env.dialogHasDraft()).toBe(true)
    env.key('Escape')
    expect(doc.activeElement.id).toBe('cgCancel'); expect(doc.querySelector('#taskDetailModal').inert).toBe(true)
    env.key('Escape')
    expect(doc.querySelector('.close-guard-overlay')).toBeNull(); expect(doc.activeElement).toBe(title)
    expect(title.value).toBe('Unsent title'); expect(env.dialogHasDraft()).toBe(true)
    env.key('Escape'); doc.querySelector('#cgDiscard').click(); await microtasks()
    expect(doc.querySelector('#taskDetailModal')).toBeNull(); expect(env.dialogHasDraft()).toBe(false)
    expect(doc.activeElement.id).toBe('opener'); expect(env.api.mock.calls.every(([method]: string[]) => method !== 'updateTask')).toBe(true)
  })

  it('does not close over a pending save or new task input, and retains the draft after failed save-and-close', async () => {
    const env = dialogHarness(), doc = env.document, save = deferred<any>()
    env.api.mockImplementation((method: string) => method === 'updateTask' ? save.promise : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const title = doc.querySelector('#tdTitle'); title.value = 'Draft A'; env.dispatch('input', title)
    env.key('Escape'); doc.querySelector('#cgSaveClose').click()
    env.key('Escape'); expect(doc.querySelector('#taskDetailModal')).not.toBeNull()
    title.value = 'Draft B'; env.dispatch('input', title)
    save.reject(new Error('offline')); await microtasks()
    expect(title.value).toBe('Draft B'); expect(env.dialogHasDraft()).toBe(true)
    expect(doc.querySelector('#tdSave').disabled).toBe(false); expect(doc.querySelector('#taskDetailModal')).not.toBeNull()
  })

  it('preserves an unsubmitted child and newer child text typed during create', async () => {
    const env = dialogHarness(), doc = env.document, create = deferred<any>()
    env.api.mockImplementation((method: string) => method === 'createTask' ? create.promise : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const input = doc.querySelector('#tdNewSub'); input.value = 'Child A'; input.focus()
    env.key('Escape'); expect(doc.querySelector('#taskDetailModal')).not.toBeNull()
    expect(env.toast).toHaveBeenCalledWith('subtaskDraftPending', 'warn')
    doc.querySelector('#tdAddSub').click(); input.value = 'Child B'
    env.key('Escape'); expect(doc.querySelector('#taskDetailModal')).not.toBeNull()
    create.resolve({ taskId: 'child-a', title: 'Child A' }); await microtasks()
    expect(input.value).toBe('Child B'); expect(env.dialogHasDraft()).toBe(true)
  })

  it('requires explicit draft discard for quick creation, prevents duplicate creates, and keeps failed values', async () => {
    const env = dialogHarness(), doc = env.document, create = deferred<any>()
    env.api.mockImplementation((method: string) => method === 'createTask' ? create.promise : Promise.resolve([]))
    env.quickTaskDialog(); await microtasks()
    const title = doc.querySelector('#tkTitle'); title.value = 'New task'
    env.key('Escape'); expect(env.confirm).toHaveBeenCalledWith('discardDraftConfirm'); expect(title.isConnected).toBe(true)
    doc.querySelector('#tkSave').click(); env.key('s', { ctrlKey: true }); env.key('Escape')
    expect(env.api.mock.calls.filter(([method]: string[]) => method === 'createTask')).toHaveLength(1)
    expect(title.disabled).toBe(true); expect(title.isConnected).toBe(true)
    create.reject(new Error('offline')); await microtasks()
    expect(title.disabled).toBe(false); expect(title.value).toBe('New task'); expect(doc.activeElement).toBe(title)
    env.confirm.mockReturnValue(true); env.key('Escape'); expect(title.isConnected).toBe(false)
  })

  it('does not discard edited footnote content on an unconfirmed Escape or steal background save shortcuts', () => {
    const env = dialogHarness(), insert = vi.fn()
    env.footnoteModal('Footnote', 'Original', 'Content', insert)
    const input = env.document.querySelector('#fnContent'); input.value = 'Updated'
    const save = env.key('s', { ctrlKey: true }); expect(save.defaultPrevented).toBe(true); expect(save.stopped).toBe(true)
    env.key('Escape'); expect(input.isConnected).toBe(true); expect(input.value).toBe('Updated')
    env.document.querySelector('#fnOk').click(); expect(insert).toHaveBeenCalledExactlyOnceWith('Updated')
    expect(env.document.activeElement.id).toBe('opener')
  })

  it('restores pre-existing inert state, contains programmatic focus, and cleans up externally removed dialogs', async () => {
    const env = dialogHarness(), doc = env.document, inert = doc.createElement('div')
    inert.inert = true; doc.body.appendChild(inert)
    env.trashConfirmDialog('Confirm', '', 'Delete', vi.fn())
    env.dispatch('focusin', doc.getElementById('opener'))
    expect(doc.activeElement.id).toBe('tcCancel')
    doc.querySelector('.modal-overlay').remove(); await microtasks()
    expect(doc.activeElement.id).toBe('opener'); expect(doc.getElementById('app').inert).toBe(false); expect(inert.inert).toBe(true)
  })

  it('keeps upload choices when cancellation is refused and submits selected files once', async () => {
    const env = dialogHarness(), doc = env.document
    env.uploadFilesWithCompanion = vi.fn(); env.uploadDialog(); await microtasks()
    const files = doc.querySelector('#upFiles'); files.files = [{ name: 'file.pdf' }]
    env.key('Escape'); expect(files.isConnected).toBe(true); expect(env.dialogHasDraft()).toBe(true)
    doc.querySelector('#upOk').click()
    expect(env.uploadFilesWithCompanion).toHaveBeenCalledExactlyOnceWith(files.files, true, '', true)
    expect(doc.activeElement.id).toBe('opener')
  })

  it('does not cancel an in-flight matrix deletion and returns focus to the retryable failure action', async () => {
    const env = dialogHarness(), doc = env.document, remove = deferred<any>()
    env.matrixDeleting = false; env.api.mockReturnValue(remove.promise)
    env.matrixDeleteDialog('matrix-a', 'Matrix A')
    expect(doc.activeElement.id).toBe('mdCancel')
    doc.querySelector('#mdOk').click(); env.key('Escape')
    expect(doc.querySelector('.modal-overlay')).not.toBeNull()
    remove.reject(new Error('offline')); await microtasks()
    expect(doc.activeElement.id).toBe('mdClose')
    env.key('Escape'); expect(doc.activeElement.id).toBe('opener')
  })

  it('renders keyboard-operable quick-switch results and restores a mobile detail opener', async () => {
    const env = dialogHarness(), doc = env.document
    env.api.mockResolvedValue({ root: [{ kind: 'note', noteId: 'note-a', title: 'Note A', relativePath: 'a.md' }] })
    env.setView = vi.fn().mockResolvedValue(true); env.openNote = vi.fn()
    env.quickSwitch(); await microtasks()
    const row = doc.querySelector('[data-qsid="note-a"]')
    expect(row.tagName).toBe('BUTTON'); row.click(); await microtasks()
    expect(env.openNote).toHaveBeenCalledExactlyOnceWith('note-a')
    env.mobileDetail('Attachment', '<p>Details</p>')
    const detail = doc.querySelector('.mobile-detail')
    expect(detail.getAttribute('aria-label')).toBe('Attachment')
    expect(doc.activeElement.dataset.action).toBe('mobile-detail-back')
    env.key('Escape'); expect(doc.activeElement.id).toBe('opener')
  })

  it('warns before leaving a page with a modal draft even when no note is dirty', () => {
    const env = dialogHarness(); let beforeUnload!: (event: any) => void
    env.window.addEventListener = (_name: string, callback: any) => { beforeUnload = callback }
    env.state.editor = { dirty: false, saving: false }; env.state.selectedNoteId = null
    runInNewContext(browserSection("window.addEventListener('beforeunload'", "document.addEventListener('visibilitychange'"), env)
    env.footnoteModal('Footnote', '', 'Content', vi.fn()); env.document.querySelector('#fnContent').value = 'Draft'
    const event = { preventDefault: vi.fn(), returnValue: undefined }
    beforeUnload(event); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(event.returnValue).toBe('')
  })
})

function workspaceApiHarness(basePath = '/pkw/spaces/team-a') {
  const env: Record<string, any> = { PKW_BASE: basePath, fetch: vi.fn(), t: (key: string) => key, paintWorkspaceSession: vi.fn() }
  runInNewContext(browserSection('let workspaceSessionPromise =', 'const $ =') + '\nglobalThis.callApi = api', env)
  return env
}
const jsonResponse = (status: number, data: any) => ({ ok: status >= 200 && status < 300, status, json: async () => data })
const sessionResponse = (id = 'team-a', role = 'editor', csrf = 'csrf-test') => jsonResponse(200, { ok: true, value: { username: 'alice', csrf, spaces: [{ id, name: 'Team A', kind: 'shared', role }] } })

describe('isolated workspace page and session bridge', () => {
  it.each(['/pkw/spaces/team-a', '/pkw/spaces/private_1', '/pkw'])('keeps RPC, editor assets, attachment images and previews in %s', async basePath => {
    const page = renderPage('test-version', basePath)
    const env: Record<string, any> = {
      PKW_BASE: basePath, ensureWorkspaceSession: async () => basePath === '/pkw' ? null : ({ csrf: 'csrf' }),
      fetch: vi.fn().mockResolvedValue(jsonResponse(200, { ok: true, value: { done: true } })),
      window: { Vditor: null, open: vi.fn() }, vditorLoadPromise: null,
      loadCss: vi.fn().mockResolvedValue(undefined), loadScript: vi.fn().mockImplementation(async () => { env.window.Vditor = {} }),
      isMobile: () => true, esc: (value: string) => value, attTypeOf: () => 'image',
    }
    runInNewContext(browserSection('const api = async', 'const $ =') + '\nglobalThis.callApi = api\n' +
      browserSection('function ensureVditorLoaded()', 'function rewriteLiveAttachmentImgs(') +
      browserSection('async function previewAttachment(', 'async function copyAttachmentRef(') +
      browserSection('function attIcon(', 'function attCompanionHtml('), env)
    await env.callApi('getNote', { noteId: 'n1' })
    expect(env.fetch).toHaveBeenCalledWith(basePath + '/api', expect.objectContaining({ method: 'POST' }))
    await env.ensureVditorLoaded()
    expect(env.loadCss).toHaveBeenCalledWith(basePath + '/assets/vditor/3.11.3/dist/index.css')
    expect(env.loadScript.mock.calls.map(([url]: string[]) => url)).toEqual([basePath + '/assets/vditor/3.11.3/dist/js/lute/lute.min.js', basePath + '/assets/vditor/3.11.3/dist/index.min.js'])
    expect(env.managedAttachmentUrl('attachments/att-1/report.pdf')).toBe(basePath + '/attachment/att-1')
    expect(env.attIcon({ attachmentId: 'att-1', mimeType: 'image/png' })).toContain('src="' + basePath + '/attachment/att-1"')
    await env.previewAttachment('att-1'); expect(env.window.open).toHaveBeenCalledWith(basePath + '/attachment/att-1/preview', '_blank')
    expect(page).toContain('const PKW_BASE = ' + JSON.stringify(basePath))
    expect(() => new Function(/<script>([\s\S]*?)<\/script>/.exec(page)![1]!)).not.toThrow()
    expect(page.includes('id="spaceBack"')).toBe(basePath !== '/pkw')
  })

  it.each(['/pkw/', '/pkw/spaces/../admin', '/pkw/spaces/a/b', '//evil.example', '/pkw/spaces/a?x', '/pkw/spaces/<script>', '/other', '/pkw\n'])('rejects unsafe base path %s', basePath => {
    expect(() => renderPage('version', basePath)).toThrow('Invalid PKW base path')
  })

  it('shares one initial session fetch across concurrent calls and sends the scoped CSRF header', async () => {
    const env = workspaceApiHarness(), session = deferred<any>()
    env.fetch.mockImplementation((url: string) => url === '/pkw/session' ? session.promise : Promise.resolve(jsonResponse(200, { ok: true, value: 'ok' })))
    const a = env.callApi('getTree'), b = env.callApi('getSummary')
    expect(env.fetch).toHaveBeenCalledTimes(1)
    session.resolve(sessionResponse()); await Promise.all([a, b])
    const posts = env.fetch.mock.calls.filter(([url]: [string]) => url.endsWith('/api'))
    expect(posts).toHaveLength(2)
    for (const [, options] of posts) expect(options.headers['X-PKW-CSRF']).toBe('csrf-test')
  })

  it.each([401, 403])('does not automatically replay a rejected write on HTTP %s and requires a fresh session for the next manual attempt', async status => {
    const env = workspaceApiHarness()
    env.fetch.mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(jsonResponse(status, { ok: false, code: status === 401 ? 'PKW_AUTH_REQUIRED' : 'PKW_FORBIDDEN', error: 'rejected' }))
      .mockResolvedValueOnce(sessionResponse('team-a', 'editor', 'csrf-new'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true, value: { saved: true } }))
    await expect(env.callApi('saveNote', { markdown: 'draft A' })).rejects.toMatchObject({ code: status === 401 ? 'PKW_AUTH_REQUIRED' : 'PKW_FORBIDDEN' })
    expect(env.fetch).toHaveBeenCalledTimes(2)
    await env.callApi('saveNote', { markdown: 'draft A' })
    expect(env.fetch.mock.calls[2][0]).toBe('/pkw/session')
    expect(env.fetch.mock.calls[3][1].headers['X-PKW-CSRF']).toBe('csrf-new')
  })

  it('fails before posting when the session is expired or the current space is absent', async () => {
    for (const response of [jsonResponse(401, { ok: false, code: 'PKW_AUTH_REQUIRED' }), sessionResponse('another-space')]) {
      const env = workspaceApiHarness(); env.fetch.mockResolvedValue(response)
      await expect(env.callApi('saveNote', { markdown: 'draft' })).rejects.toThrow()
      expect(env.fetch).toHaveBeenCalledTimes(1)
    }
    const legacy = workspaceApiHarness('/pkw'); legacy.fetch.mockResolvedValue(jsonResponse(200, { ok: true, value: {} }))
    await legacy.callApi('getSummary'); expect(legacy.fetch.mock.calls[0][0]).toBe('/pkw/api')
    expect(legacy.fetch.mock.calls[0][1].headers).not.toHaveProperty('X-PKW-CSRF')
  })

  it('distinguishes viewer write controls from editor permanent deletion while preserving read actions', () => {
    const env = dialogHarness()
    Object.assign(env, { PKW_BASE: '/pkw/spaces/team-a', workspaceAccess: { role: 'viewer' } })
    runInNewContext(browserSection('function workspaceReadOnly()', 'const state ='), env)
    const app = env.document.getElementById('app')
    app.innerHTML = '<button data-action="new-note">New</button><button data-action="set-mode" data-mode="live">Edit</button><button data-action="set-mode" data-mode="reading">Read</button><button data-action="open-note">Open</button><button data-action="purge-one">Purge</button><button data-action="delete-note">Trash</button>'
    env.applyWorkspacePermissions()
    for (const action of ['new-note', 'purge-one', 'delete-note']) expect(app.querySelector('[data-action="' + action + '"]').disabled).toBe(true)
    expect(app.querySelector('[data-mode="live"]').disabled).toBe(true); expect(app.querySelector('[data-mode="reading"]').disabled).toBe(false)
    expect(app.querySelector('[data-action="open-note"]').disabled).toBe(false)
    env.workspaceAccess.role = 'editor'; env.applyWorkspacePermissions()
    expect(app.querySelector('[data-action="new-note"]').disabled).toBe(false); expect(app.querySelector('[data-action="purge-one"]').disabled).toBe(true)
    env.workspaceAccess.role = 'owner'; env.applyWorkspacePermissions()
    expect(app.querySelector('[data-action="purge-one"]').disabled).toBe(false)
  })

  it('blocks space navigation on an open dialog draft or failed note flush, and leaves only after a successful flush', async () => {
    const env = dialogHarness(), doc = env.document
    doc.body.innerHTML = '<a id="spaceBack" href="/pkw">Back</a><button id="spaceRetry">Retry</button>'
    Object.assign(env, { PKW_BASE: '/pkw/spaces/team-a', applyWorkspacePermissions: vi.fn(), workspaceActionDenied: () => false, ensureWorkspaceSession: vi.fn(), flushNoteEdits: vi.fn().mockResolvedValue(false) })
    env.pendingDraft = true; env.dialogHasDraft = () => env.pendingDraft
    runInNewContext(browserSection("if (PKW_BASE !== '/pkw') {\n  $('#spaceBack')", '\nrender()'), env)
    doc.querySelector('#spaceBack').click(); await microtasks()
    expect(env.flushNoteEdits).not.toHaveBeenCalled(); expect(env.window.location.assign).not.toHaveBeenCalled()
    env.pendingDraft = false; doc.querySelector('#spaceBack').click(); await microtasks()
    expect(env.window.location.assign).not.toHaveBeenCalled()
    env.flushNoteEdits.mockResolvedValue(true); doc.querySelector('#spaceBack').click(); await microtasks()
    expect(env.window.location.assign).toHaveBeenCalledExactlyOnceWith('/pkw')
  })
})

describe('task version ownership and conflict recovery', () => {
  it('retains the displayed task hash across background refresh and advances only after its own successful save', async () => {
    const env = dialogHarness(), doc = env.document, first = deferred<any>(), second = deferred<any>()
    let writes = 0
    env.api.mockImplementation((method: string) => method === 'updateTask' ? (++writes === 1 ? first.promise : second.promise) : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const title = doc.querySelector('#tdTitle'); title.value = 'Draft A'; env.dispatch('input', title)
    env.state.tasksCache = [{ ...env.state.tasksCache[0], contentHash: 'f'.repeat(64) }]
    doc.querySelector('#tdSave').click()
    expect(env.api).toHaveBeenLastCalledWith('updateTask', expect.objectContaining({ expectedContentHash: 'a'.repeat(64) }))
    title.value = 'Draft B'; env.dispatch('input', title)
    first.resolve({ contentHash: 'b'.repeat(64) }); await microtasks()
    expect(env.dialogHasDraft()).toBe(true)
    doc.querySelector('#tdSave').click()
    expect(env.api).toHaveBeenLastCalledWith('updateTask', expect.objectContaining({ expectedContentHash: 'b'.repeat(64), patch: expect.objectContaining({ title: 'Draft B' }) }))
    second.resolve({ contentHash: 'c'.repeat(64) }); await microtasks()
    expect(env.dialogHasDraft()).toBe(false)
  })

  it('keeps conflicted fields, stops repeated saves, allows manual copying, and retains the draft when reloading fails', async () => {
    const env = dialogHarness(), doc = env.document
    env.api.mockImplementation((method: string) => method === 'updateTask' ? Promise.reject(Object.assign(new Error('changed'), { code: 'PKW_TASK_CONFLICT' })) : method === 'listTasks' ? Promise.reject(new Error('offline')) : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const title = doc.querySelector('#tdTitle'); title.value = 'My conflicting draft'; env.dispatch('input', title)
    doc.querySelector('#tdSave').click(); await microtasks()
    expect(title.value).toBe('My conflicting draft'); expect(doc.querySelector('#tdConflict').hidden).toBe(false)
    expect(doc.querySelector('#tdSave').disabled).toBe(true); expect(env.dialogHasDraft()).toBe(true)
    env.key('s', { ctrlKey: true }); await microtasks()
    expect(env.api.mock.calls.filter(([method]: string[]) => method === 'updateTask')).toHaveLength(1)
    doc.querySelector('#tdCopyDraft').click(); await microtasks()
    expect(doc.querySelector('#tdDraft').value).toContain('My conflicting draft'); expect(doc.querySelector('#tdDraft').hidden).toBe(false)
    env.confirm.mockReturnValue(true); doc.querySelector('#tdReload').click(); await microtasks()
    expect(title.value).toBe('My conflicting draft'); expect(doc.querySelector('#tdConflict').hidden).toBe(false)
    expect(env.dialogHasDraft()).toBe(true)
  })

  it('rejects a reload that would replace newer task input and accepts a later explicit unchanged reload', async () => {
    const env = dialogHarness(), doc = env.document, read = deferred<any>()
    env.api.mockImplementation((method: string) => method === 'updateTask' ? Promise.reject(Object.assign(new Error('changed'), { code: 'PKW_TASK_CONFLICT' })) : method === 'listTasks' ? read.promise : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const title = doc.querySelector('#tdTitle'); title.value = 'Draft A'; env.dispatch('input', title)
    doc.querySelector('#tdSave').click(); await microtasks(); env.confirm.mockReturnValue(true)
    doc.querySelector('#tdReload').click(); title.value = 'Draft B'; env.dispatch('input', title)
    const latest = { taskId: 'task-a', title: 'Server version', status: 'open', contentHash: 'c'.repeat(64) }
    read.resolve([latest]); await microtasks()
    expect(title.value).toBe('Draft B'); expect(env.dialogHasDraft()).toBe(true)
    doc.querySelector('#tdReload').click(); await microtasks()
    expect(title.value).toBe('Server version'); expect(doc.querySelector('#tdConflict').hidden).toBe(true)
    title.value = 'Merged manually'; env.dispatch('input', title); doc.querySelector('#tdSave').click()
    expect(env.api).toHaveBeenLastCalledWith('updateTask', expect.objectContaining({ expectedContentHash: 'c'.repeat(64) }))
  })

  it('keeps an inline child title and its observed hash through a conflict and asynchronous subtree refresh', async () => {
    const env = dialogHarness(), doc = env.document, update = deferred<any>()
    const child = { taskId: 'child-a', parentTaskId: 'task-a', title: 'Child A', status: 'open', contentHash: 'd'.repeat(64) }
    env.fetchSubtasks.mockResolvedValue([child]); env.api.mockImplementation((method: string) => method === 'updateTask' ? update.promise : Promise.resolve([]))
    env.taskDetailDialog('task-a'); await microtasks()
    const button = doc.querySelector('[data-action="subtask-edit"]')
    expect(button.tagName).toBe('BUTTON'); expect(button.dataset.contentHash).toBe('d'.repeat(64))
    env.inlineEditSubtask(button, 'child-a')
    const input = doc.querySelector('.subtask-edit-input'); input.value = 'My child draft'
    env.dispatch('keydown', input, { key: 'Enter' })
    expect(env.api).toHaveBeenLastCalledWith('updateTask', { taskId: 'child-a', expectedContentHash: 'd'.repeat(64), patch: { title: 'My child draft' } })
    env.fetchSubtasks.mockResolvedValue([{ ...child, title: 'Other child title', contentHash: 'e'.repeat(64) }])
    await env.taskDetailRefreshSubtasks()
    expect(input.isConnected).toBe(true); expect(input.value).toBe('My child draft')
    update.reject(Object.assign(new Error('changed'), { code: 'PKW_TASK_CONFLICT' })); await microtasks()
    expect(input.value).toBe('My child draft'); expect(doc.querySelector('#taskPatchDraft').value).toContain('My child draft')
    expect(env.dialogHasDraft()).toBe(true)
  })

  it.each(['PKW_TASK_CONFLICT', 'NETWORK_ERROR'])('captures the date-edit hash before the prompt and preserves a rejected date for copying (%s)', async code => {
    const env = dialogHarness(), doc = env.document
    Object.assign(env, { dismissWikiSuggest: vi.fn(), dismissContextMenu: vi.fn(), dismissSelButton: vi.fn(), prompt: () => {
      env.state.tasksCache = [{ ...env.state.tasksCache[0], contentHash: 'f'.repeat(64) }]; return '2026-12-31'
    } })
    env.api.mockRejectedValue(Object.assign(new Error('changed'), { code }))
    runInNewContext(browserSection('// ── Delegated events', '// Trash selection is pure local state'), env)
    const button = doc.createElement('button'); button.setAttribute('data-action', 'task-due'); button.setAttribute('data-id', 'task-a'); doc.body.appendChild(button)
    button.click(); await microtasks()
    expect(env.api).toHaveBeenCalledExactlyOnceWith('updateTask', { taskId: 'task-a', expectedContentHash: 'a'.repeat(64), patch: { dueAt: '2026-12-31' } })
    expect(doc.querySelector('#taskPatchDraft').value).toContain('2026-12-31')
  })

  it.each([false, true])('binds a drag operation to the task version at drag start rather than a later cache refresh (conflict=%s)', async conflict => {
    const env = dialogHarness(), doc = env.document
    env.workspaceReadOnly = () => false
    if (conflict) env.api.mockRejectedValue(Object.assign(new Error('changed'), { code: 'PKW_TASK_CONFLICT' }))
    else env.api.mockResolvedValue({})
    runInNewContext(browserSection('// ── Task drag/drop', '// ── Delegated events'), env)
    const card = doc.createElement('div'); card.className = 'task-card'; card.setAttribute('draggable', 'true'); card.setAttribute('data-id', 'task-a'); card.classList = { add: vi.fn(), remove: vi.fn() }
    const target = doc.createElement('div'); target.setAttribute('data-drop', 'inbox'); target.classList = { add: vi.fn(), remove: vi.fn() }
    doc.body.appendChild(card); doc.body.appendChild(target)
    let id = ''; const dataTransfer = { setData: (_type: string, value: string) => { id = value }, getData: () => id }
    env.dispatch('dragstart', card, { dataTransfer })
    env.state.tasksCache = [{ ...env.state.tasksCache[0], contentHash: 'f'.repeat(64) }]
    env.dispatch('drop', target, { dataTransfer }); await microtasks()
    expect(env.api).toHaveBeenCalledExactlyOnceWith('updateTask', { taskId: 'task-a', expectedContentHash: 'a'.repeat(64), patch: { matrixId: null } })
    if (conflict) expect(env.toast).toHaveBeenCalledWith('taskActionConflict', 'err')
  })
})

describe('search scope and fallback disclosure', () => {
  it.each([{ results: [] }, { results: [{ remote: { title: 'Local note' }, local: { entityType: 'note', entityId: 'n1' } }] }])('persistently renders escaped scope warnings beside successful results, including no hits (%j)', async ({ results }) => {
    const env = searchHarness()
    env.esc = (value: string) => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!))
    env.searchCardsHtml = vi.fn().mockReturnValue('<article>Result</article>')
    runInNewContext(browserSection('function renderKnowledgeSearchState()', 'function clearKnowledgeSearch()'), env)
    env.api.mockResolvedValue({ results, mode: 'local-keyword', warning: '仅本地文件名 <img src=x onerror=alert(1)>' })
    await env.runSearch('query')
    expect(env.box.innerHTML).toContain('仅本地文件名 &lt;img src=x onerror=alert(1)&gt;')
    expect(env.box.innerHTML).not.toContain('<img')
    if (results.length) expect(env.box.innerHTML).toContain('searchLocalEvidenceHint')
    else expect(env.box.innerHTML).toContain('noHits')
    env.renderKnowledgeSearchState(); expect(env.box.innerHTML).toContain('仅本地文件名')
  })

  it('does not let a late old warning replace a newer query, and clears disclosure on new query, failure or clear', async () => {
    const env = searchHarness(), old = deferred<any>(), current = deferred<any>()
    env.state.searchWarning = 'Previous warning'; env.state.searchMode = 'remote'
    env.api.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const a = env.runSearch('old'); expect(env.state.searchWarning).toBe('')
    const b = env.runSearch('new')
    current.resolve({ results: [], mode: 'remote', warning: 'Some attachment text is unavailable' }); await b
    old.resolve({ results: [], mode: 'local-keyword', warning: 'Old fallback' }); await a
    expect(env.state.searchWarning).toBe('Some attachment text is unavailable'); expect(env.state.searchMode).toBe('remote')
    env.clearKnowledgeSearch(); expect(env.state.searchWarning).toBe(''); expect(env.state.searchMode).toBeNull()
    env.api.mockRejectedValue(new Error('offline')); await env.runSearch('failed')
    expect(env.state.searchWarning).toBe(''); expect(env.state.searchMode).toBeNull()
  })

  it('labels fallback attachment matches as filenames instead of attachment content', () => {
    const env = searchHarness(); env.state.searchMode = 'local-keyword'
    env.knowledgeCardHtml.mockImplementation((card: any) => card.reason + card.reasonAttrs)
    runInNewContext(browserSection('function searchCardsHtml(', 'function renderSearchResults('), env)
    const html = env.searchCardsHtml([{ remote: { title: 'File', filename: 'report.pdf' }, local: { entityType: 'attachment', entityId: 'a1', companionNoteId: 'n1' } }])
    expect(html).toContain('attachmentNameMatch'); expect(html).toContain('data-reason="attachment-name"'); expect(html).not.toContain('attMatch')
  })
})

function trashTaskHarness() {
  const env = dialogHarness(), doc = env.document
  for (const id of ['list', 'treeToolbar', 'detail']) {
    const node = doc.createElement('div'); node.id = id; doc.body.appendChild(node)
  }
  Object.assign(env.state, {
    view: 'trash', trashSelection: new Set(), trashFilter: 'all', trashBusy: false,
    trashTaskBusy: null, trashTaskError: '', trashTasksLoadError: '',
    trashCache: { notes: [], atts: [], folders: [], tasks: [{ taskId: 'task-deleted', title: 'Deleted <task>', deletedAt: '2026-10-02T12:00:00Z' }] },
  })
  Object.assign(env, {
    viewSeq: 1, trashSeq: 0, workspaceReadOnly: () => false,
    restoreScroll: vi.fn(), viewMark: vi.fn(), invalidateLoad: vi.fn(),
    dismissWikiSuggest: vi.fn(), dismissContextMenu: vi.fn(), dismissSelButton: vi.fn(),
    loadOnce: vi.fn(async (method: string) => method === 'listTrashTasks' ? env.state.trashCache.tasks : []),
  })
  runInNewContext(browserSection('function trashReconcile(', '// ── Knowledge view:') +
    browserSection('function refreshTrash(', 'function viewMark(') +
    browserSection('// ── Delegated events', '// Trash selection is pure local state'), env)
  env.renderTrashFrom([], [], [], env.state.trashCache.tasks)
  return env
}

describe('deleted task recovery in Trash', () => {
  it('renders a separately named task section with a native restore action and escaped user text', () => {
    const env = trashTaskHarness(), doc = env.document
    const section = doc.querySelector('#trashTasks'), restore = section.querySelector('[data-action="restore-task"]')
    expect(section.getAttribute('aria-labelledby')).toBe('trashTasksTitle')
    expect(section.querySelector('#trashTasksTitle').textContent).toContain('trashTasks')
    expect(section.textContent).toContain('Deleted <task>')
    expect(section.querySelector('task')).toBeNull()
    expect(restore.tagName).toBe('BUTTON')
    expect(restore.dataset.id).toBe('task-deleted')
    expect(section.querySelectorAll('input')).toHaveLength(0)
    expect(section.querySelector('[data-action="purge-one"]')).toBeNull()
    expect(env.trashItems([], [], [])).toHaveLength(0)
    expect(env.trashTasksHtml(env.state.trashCache.tasks)).toContain('Deleted &lt;task&gt;')
    navigationFragment(env.trashTasksHtml(env.state.trashCache.tasks))
  })

  it('routes the rendered restore button to one restore request and refreshes after success', async () => {
    const env = trashTaskHarness(), restore = deferred<any>()
    env.api.mockReturnValueOnce(restore.promise)
    env.document.querySelector('[data-action="restore-task"]').click(); await microtasks()
    expect(env.api).toHaveBeenCalledExactlyOnceWith('restoreTask', { taskId: 'task-deleted' })
    expect(env.document.querySelector('[data-action="restore-task"]').disabled).toBe(true)
    await env.restoreTrashedTask('task-deleted')
    expect(env.api).toHaveBeenCalledTimes(1)
    restore.resolve({ taskId: 'task-deleted', title: 'Deleted <task>' }); await microtasks()
    expect(env.state.trashCache.tasks).toEqual([])
    expect(env.document.querySelector('[data-action="restore-task"]')).toBeNull()
    expect(env.document.querySelector('#trashTasks').textContent).toContain('trashTasksEmpty')
    expect(env.invalidateLoad).toHaveBeenCalledWith('listTasks')
    expect(env.invalidateLoad).toHaveBeenCalledWith('listTrashTasks')
    expect(env.loadOnce).toHaveBeenCalledWith('listTrashTasks', {})
    expect(env.state.tasksCache).toEqual([])
    expect(env.toast).toHaveBeenCalledWith('trashTaskRestored', 'ok')
    expect(env.state.trashTaskBusy).toBeNull()
  })

  it('keeps a failed restore visible with a retryable error, without claiming deletion or success', async () => {
    const env = trashTaskHarness()
    env.api.mockRejectedValueOnce(new Error('network <uncertain>'))
    expect(await env.restoreTrashedTask('task-deleted')).toBe(false)
    const section = env.document.querySelector('#trashTasks')
    expect(env.state.trashCache.tasks).toHaveLength(1)
    expect(section.querySelector('[data-action="restore-task"]').disabled).toBe(false)
    expect(section.querySelector('[role="alert"]').textContent).toContain('network <uncertain>')
    expect(section.querySelector('uncertain')).toBeNull()
    expect(section.querySelector('[data-action="retry-trash-tasks"]')).not.toBeNull()
    expect(env.toast).not.toHaveBeenCalledWith('trashTaskRestored', 'ok')
    expect(env.loadOnce).not.toHaveBeenCalled()
    section.querySelector('[data-action="retry-trash-tasks"]').click(); await microtasks()
    expect(env.state.trashTaskError).toBe('')
  })

  it('lets viewers read deleted tasks while denying both UI and direct restore requests', async () => {
    const env = trashTaskHarness()
    env.workspaceReadOnly = () => true; env.renderTrashTasksInto()
    const button = env.document.querySelector('[data-action="restore-task"]')
    expect(button.disabled).toBe(true)
    expect(env.document.querySelector('#trashTasks').textContent).toContain('spaceReadOnly')
    button.click(); await microtasks()
    expect(await env.restoreTrashedTask('task-deleted')).toBe(false)
    expect(env.api).not.toHaveBeenCalled()
    expect(env.state.trashCache.tasks).toHaveLength(1)
  })

  it('preserves deleted documents when task loading fails, labels stale tasks, and supports retry', async () => {
    const env = trashTaskHarness()
    env.loadOnce.mockImplementation(async (method: string) => {
      if (method === 'listTrashTasks') throw new Error('task read unavailable')
      if (method === 'listTrash') return [{ noteId: 'note-trash', title: 'Deleted note' }]
      return []
    })
    await env.renderTrash()
    expect(env.document.querySelector('#main').textContent).toContain('Deleted note')
    expect(env.document.querySelector('#trashTasks').textContent).toContain('trashTasksReadFailed')
    expect(env.document.querySelector('#trashTasks').textContent).toContain('trashTasksStale')
    expect(env.document.querySelector('[data-action="restore-task"]')).not.toBeNull()
    env.loadOnce.mockResolvedValue([])
    env.document.querySelector('[data-action="retry-trash-tasks"]').click(); await microtasks()
    expect(env.state.trashTasksLoadError).toBe('')
    expect(env.document.querySelector('#trashTasks').textContent).toContain('trashTasksEmpty')
  })

  it('ignores old same-view reads after a restore refresh and old reads after navigation', async () => {
    const env = trashTaskHarness(), old = deferred<any>()
    let taskReads = 0
    env.loadOnce.mockImplementation(async (method: string) => method === 'listTrashTasks' && ++taskReads === 1 ? old.promise : [])
    const earlier = env.renderTrash()
    await env.renderTrash()
    old.resolve([{ taskId: 'old', title: 'Outdated deleted task' }]); await earlier
    expect(env.state.trashCache.tasks).toEqual([])
    expect(env.document.querySelector('#main').textContent).not.toContain('Outdated deleted task')
    const afterNavigation = deferred<any>()
    env.loadOnce.mockImplementation(async (method: string) => method === 'listTrashTasks' ? afterNavigation.promise : [])
    const pending = env.renderTrash()
    env.state.view = 'overview'; env.viewSeq++
    env.document.querySelector('#main').innerHTML = '<p>Current overview</p>'
    afterNavigation.resolve([{ taskId: 'old', title: 'Late task' }]); await pending
    expect(env.document.querySelector('#main').textContent).toBe('Current overview')
  })

  it('does not overwrite another view when a pending restore finishes', async () => {
    const env = trashTaskHarness(), restore = deferred<any>()
    env.api.mockReturnValueOnce(restore.promise)
    const pending = env.restoreTrashedTask('task-deleted')
    env.state.view = 'overview'; env.viewSeq++
    env.document.querySelector('#main').innerHTML = '<p>Current overview</p>'
    restore.resolve({ taskId: 'task-deleted' }); await pending
    expect(env.state.trashCache.tasks).toEqual([])
    expect(env.document.querySelector('#main').textContent).toBe('Current overview')
    expect(env.loadOnce).not.toHaveBeenCalled()
    expect(env.refreshTasks).not.toHaveBeenCalled()
  })

  it('excludes deleted tasks from the existing permanent deletion flow and document filters', () => {
    const env = trashTaskHarness()
    env.state.trashCache.notes = [{ noteId: 'note-deleted', title: 'Note' }]
    env.trashConfirmDialog = vi.fn()
    env.confirmEmptyTrash()
    env.doBatchPurge = vi.fn()
    env.trashConfirmDialog.mock.calls[0][3]()
    expect(env.doBatchPurge).toHaveBeenCalledWith(['note:note-deleted'])
    env.state.trashFilter = 'note'
    env.renderTrashFrom(env.state.trashCache.notes, [], [], env.state.trashCache.tasks)
    expect(env.document.querySelector('#trashTasks').textContent).toContain('Deleted <task>')
    expect(env.document.querySelectorAll('.trash-check')).toHaveLength(1)
  })
})
