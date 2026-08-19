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
})
