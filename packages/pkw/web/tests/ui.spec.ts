import { describe, expect, it } from 'vitest'
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

  it('wires knowledge view (Wiki list/page/search + Graph canvas)', () => {
    const js = script()
    expect(js).toContain('renderKnowledgeView')
    expect(js).toContain('renderWikiList')
    expect(js).toContain('openWikiPage')
    expect(js).toContain('renderGraphView')
    expect(js).toContain('drawGraph')
    expect(js).toContain("api('listWikiPages'")
    expect(js).toContain("api('getWikiGraph'")
    expect(js).toContain('graphCanvas')
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
    expect(js).toContain('wikiUnavailable')
    expect(js).toContain('graphUnavailable')
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
    expect(page).toContain('.mquad')
    expect(page).toContain('.mquad-cell')
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
})
