/**
 * PKW Web browser page — a self-contained HTML/JS client served by the Host at
 * `GET /pkw`. It talks only to `POST /pkw/api` (the Host bridge); it never
 * touches SQLite, the workspace filesystem, the WeKnora API key, or WeKnora REST.
 *
 * Localized to Chinese (zh) and English (en) only; the choice persists in
 * localStorage (`pkw-lang`) and toggles from the header.
 */

export function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PKW — Personal Knowledge Workspace</title>
<style>
:root{--bg:#f6f7f9;--panel:#ffffff;--border:#e3e6ea;--ink:#1c2330;--muted:#6b7280;--accent:#2f6fed;--ok:#178a4f;--warn:#b45309;--err:#b91c1c}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
#app{display:grid;grid-template-columns:260px 1fr 300px;grid-template-rows:52px 1fr;height:100vh}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{font-size:15px;margin:0;font-weight:700;letter-spacing:.02em}
header .spacer{flex:1}
#search{width:340px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.badge{padding:2px 9px;border-radius:999px;font-size:12px;background:#eef2f8;color:var(--muted);white-space:nowrap}
.badge.ok{background:#e8f6ee;color:var(--ok)}.badge.warn{background:#fdf1e3;color:var(--warn)}.badge.err{background:#fdeaea;color:var(--err)}
.langbtn{padding:6px 11px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:12px;color:var(--ink);font-weight:600}
.langbtn:hover{background:#eef2f8}
aside{border-right:1px solid var(--border);background:var(--panel);overflow:auto}
.nav{padding:10px 10px 6px}.nav button{display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink);margin-bottom:2px}
.nav button.active,.nav button:hover{background:#eef2f8}
.nav button.active{font-weight:650;color:var(--accent)}
#list{overflow:auto;padding:6px 10px 10px}
.list-head{padding:10px 10px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.row{padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:2px}
.row:hover{background:#f1f4f9}.row.active{background:#e7eefb;border-color:#cdddf7}
.row .t{font-weight:550;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.row .p{font-size:11px;color:var(--muted);word-break:break-all}
.row .badge{margin-left:4px}
main{overflow:auto;padding:20px 24px;background:var(--bg)}
main h2{margin:0 0 12px;font-size:18px;font-weight:650}
main h2 .sub{font-size:12px;color:var(--muted);font-weight:400;margin-left:8px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}
button.btn{padding:7px 12px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:13px}
button.btn:hover{border-color:#c6ccd4}
button.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.btn.danger{color:var(--err)}
button.btn:disabled{opacity:.5;cursor:default}
.editor-wrap{border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}
.editor-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)}
.editor-head .title{font-weight:600}
.editor-head .path{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace}
textarea#editor{width:100%;height:48vh;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 14px;border:0;resize:vertical;outline:none}
#preview{border-top:1px solid var(--border);padding:12px 16px;background:#fbfcfe;min-height:12vh}
#preview h1,#preview h2,#preview h3{font-size:1.05em}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
aside.right{border-left:1px solid var(--border);background:var(--panel);padding:14px;overflow:auto}
aside.right h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px}
aside.right h3:first-child{margin-top:0}
.kv{font-size:12px;margin:3px 0}.kv b{color:var(--muted);font-weight:500;display:inline-block;min-width:84px}
.kv .v{word-break:break-all}
.hit{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--panel)}
.hit .t{font-weight:600}.hit .snippet{font-size:12px;color:var(--muted);margin:4px 0}
.hit .ref{font-size:12px;color:var(--muted)}.hit button{font-size:12px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;margin-left:4px}
.empty{color:var(--muted);padding:28px;text-align:center}
.empty .cta{margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel)}
.stat .n{font-size:22px;font-weight:700}
.stat .l{font-size:12px;color:var(--muted)}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:50;display:none;gap:8px}
.toast{padding:9px 16px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.15)}
.toast.ok{background:var(--ok)}.toast.err{background:var(--err)}.toast.warn{background:var(--warn)}
@media(max-width:960px){#app{grid-template-columns:200px 1fr}aside.right{display:none}}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>PKW</h1>
    <span class="badge" id="wsBadge">…</span>
    <input id="search" placeholder="搜索知识库 (hybrid search)…" aria-label="Search" />
    <span class="spacer"></span>
    <span class="badge" id="integBadge">WeKnora: …</span>
    <span class="badge" id="localBadge">Local: …</span>
    <button id="langBtn" class="langbtn" title="Switch language / 切换语言">EN</button>
  </header>
  <aside>
    <div class="nav">
      <button data-view="overview">总览</button>
      <button data-view="notes">笔记</button>
      <button data-view="attachments">附件</button>
      <button data-view="search">搜索</button>
    </div>
    <div id="list"></div>
  </aside>
  <main id="main"></main>
  <aside class="right" id="detail"></aside>
</div>
<div id="toast"></div>
<script>
const STR = {
  zh: {
    overview:'总览', notes:'笔记', attachments:'附件', search:'搜索',
    searchPlaceholder:'搜索知识库 (hybrid search)…',
    workspaceLabel:'工作区',
    localSummary:'本地: {n} 笔记 · {m} 文件',
    connected:'已连接', unavailable:'不可用', notConfigured:'未配置', error:'错误',
    overviewTitle:'工作区概览', overviewNotes:'笔记', overviewAttachments:'附件',
    overviewMappings:'已同步对象', overviewPendingSync:'待同步', overviewSyncErrors:'同步错误',
    overviewIntegration:'WeKnora 集成', overviewRecent:'最近更新', overviewEmpty:'工作区为空。点击「新建笔记」或「上传文件」开始。',
    recentNote:'笔记', recentAttachment:'附件', noRecent:'暂无最近更新',
    newNote:'新建笔记', emptyNotes:'还没有笔记。', emptyNotesCta:'新建第一篇笔记',
    loading:'加载中…', deletedSuffix:'已删除',
    save:'保存', renameMove:'重命名 / 移动', del:'删除', syncNow:'立即同步', reconcile:'重建索引',
    localSaved:'本地已保存', localSavedR:'本地已保存 · r{r}', saving:'保存中…',
    preview:'预览', newNotePrompt:'相对路径（如 notes/foo.md）', renamePrompt:'新相对路径',
    delNoteConfirm:'删除这篇笔记？', deletedMsg:'已删除', selectNote:'从左侧选择或新建一篇笔记。',
    untitled:'untitled.md', notSynced:'未同步', synced:'已同步', syncing:'同步中', pending:'待同步', failed:'失败', stale:'已过期', deleted:'已删除',
    upload:'上传文件', emptyAttachments:'还没有附件。', attachmentsDesc:'上传 → 本地保存 → 异步同步到 WeKnora。',
    size:'大小', download:'下载', delAttachmentConfirm:'删除该附件？', attachmentDetailHint:'选中附件查看详情。',
    uploadProgress:'上传中…', uploadSuccess:'已上传', uploadFailed:'上传失败',
    searching:'搜索中…', noHits:'没有命中「{q}」。',
    searchHint:'输入关键词搜索本地笔记与附件（经 WeKnora hybrid search）。',
    score:'得分', openNote:'打开笔记', openAttachment:'打开附件', externalWeKnora:'WeKnora 外部',
    noteLabel:'笔记', attachmentLabel:'附件',
    details:'详情', noteId:'NoteId', attachmentId:'AttachmentId', path:'路径', revision:'版本',
    updated:'更新时间', lastError:'最近错误', maintenance:'维护', advanced:'高级',
    workspaceSummary:'工作区摘要', kb:'知识库', state:'状态', parse:'解析',
    syncSection:'WeKnora 同步', noSyncInfo:'尚未同步。',
    reconcileDone:'重建完成', reconcileResult:'笔记修复 {a} · 附件修复 {b} · 待同步 {c} · 已删 {d}',
    syncingAll:'正在同步…', genericError:'操作失败', ok:'完成',
    emptyPreview:'（空）', recent:'最近更新', searchFailed:'搜索失败',
  },
  en: {
    overview:'Overview', notes:'Notes', attachments:'Attachments', search:'Search',
    searchPlaceholder:'Search knowledge base (hybrid search)…',
    workspaceLabel:'Workspace',
    localSummary:'Local: {n} notes · {m} files',
    connected:'Connected', unavailable:'Unavailable', notConfigured:'Not configured', error:'error',
    overviewTitle:'Workspace Overview', overviewNotes:'Notes', overviewAttachments:'Attachments',
    overviewMappings:'Synced objects', overviewPendingSync:'Pending sync', overviewSyncErrors:'Sync errors',
    overviewIntegration:'WeKnora integration', overviewRecent:'Recent', overviewEmpty:'Workspace is empty. Click 「New Note」 or 「Upload file」 to start.',
    recentNote:'Note', recentAttachment:'Attachment', noRecent:'No recent changes',
    newNote:'New Note', emptyNotes:'No notes yet.', emptyNotesCta:'Create your first note',
    loading:'Loading…', deletedSuffix:'deleted',
    save:'Save', renameMove:'Rename / Move', del:'Delete', syncNow:'Sync now', reconcile:'Reconcile',
    localSaved:'Local saved', localSavedR:'Local saved · r{r}', saving:'Saving…',
    preview:'Preview', newNotePrompt:'Relative path (e.g. notes/foo.md)', renamePrompt:'New relative path',
    delNoteConfirm:'Delete this note?', deletedMsg:'Deleted', selectNote:'Select or create a note from the left.',
    untitled:'untitled.md', notSynced:'Not synced', synced:'Synced', syncing:'Syncing', pending:'Pending', failed:'Failed', stale:'Stale', deleted:'Deleted',
    upload:'Upload file', emptyAttachments:'No attachments yet.', attachmentsDesc:'Upload → local save → async WeKnora sync.',
    size:'Size', download:'Download', delAttachmentConfirm:'Delete this attachment?', attachmentDetailHint:'Select an attachment to view details.',
    uploadProgress:'Uploading…', uploadSuccess:'Uploaded', uploadFailed:'Upload failed',
    searching:'Searching…', noHits:'No hits for 「{q}」.',
    searchHint:'Type a query to search notes & attachments (via WeKnora hybrid search).',
    score:'score', openNote:'Open note', openAttachment:'Open attachment', externalWeKnora:'external WeKnora',
    noteLabel:'Note', attachmentLabel:'Attachment',
    details:'Details', noteId:'NoteId', attachmentId:'AttachmentId', path:'Path', revision:'Revision',
    updated:'Updated', lastError:'Last error', maintenance:'Maintenance', advanced:'Advanced',
    workspaceSummary:'Workspace summary', kb:'KB', state:'State', parse:'Parse',
    syncSection:'WeKnora Sync', noSyncInfo:'Not synced yet.',
    reconcileDone:'Reconcile done', reconcileResult:'Notes repaired {a} · attachments repaired {b} · dirty {c} · deleted {d}',
    syncingAll:'Syncing…', genericError:'Operation failed', ok:'Done',
    emptyPreview:'(empty)', recent:'Recent', searchFailed:'Search failed',
  },
}
let lang = localStorage.getItem('pkw-lang') === 'en' ? 'en' : 'zh'
const t = (key, vars) => {
  let s = STR[lang][key] ?? STR.zh[key] ?? key
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k]))
  return s
}
const api = async (method, args = {}) => {
  const res = await fetch('/pkw/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  let data = {}
  try { data = await res.json() } catch (e) { /* non-json */ }
  if (!res.ok || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data.value
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
const state = { view: 'overview', selectedNoteId: null, selectedAttachmentId: null, searchQuery: '' }

function toast(msg, kind){
  const el = $('#toast')
  el.innerHTML = '<div class="toast ' + (kind || 'ok') + '">' + esc(msg) + '</div>'
  el.style.display = 'block'
  clearTimeout(toast._t)
  toast._t = setTimeout(() => { el.style.display = 'none' }, 3200)
}

function applyLang(){
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  $('#search').placeholder = t('searchPlaceholder')
  $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'
  document.querySelectorAll('.nav button').forEach(b => b.textContent = t(b.dataset.view))
}

function syncBadgeHtml(sync){
  if (!sync || (!sync.pending && sync.syncState === undefined && sync.error === undefined)) return '<span class="badge">' + esc(t('notSynced')) + '</span>'
  let label, cls = 'warn'
  if (sync.error) { label = t('failed'); cls = 'err' }
  else if (sync.pending) { label = t('syncing'); cls = 'warn' }
  else if (sync.syncState === 'synced') { label = t('synced'); cls = 'ok' }
  else if (sync.syncState === 'deleted') { label = t('deleted'); cls = 'warn' }
  else if (sync.syncState === 'stale') { label = t('stale'); cls = 'warn' }
  else { label = sync.syncState || t('notSynced'); cls = 'warn' }
  let out = '<span class="badge ' + cls + '">' + esc(label) + '</span>'
  if (sync.syncState === 'synced' && sync.remoteParseStatus) out += ' <span class="badge">' + esc(t('parse')) + ': ' + esc(sync.remoteParseStatus) + '</span>'
  return out
}

function fmtSize(n){
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

async function refreshHeader(){
  try {
    const s = await api('summary')
    $('#wsBadge').textContent = t('workspaceLabel') + ': ' + (s.workspaceName || 'Personal Workspace')
    $('#localBadge').textContent = t('localSummary', { n: s.notes, m: s.attachments })
    $('#localBadge').className = 'badge ok'
    const integ = s.integration === 'ready'
    if (integ) $('#integBadge').textContent = 'WeKnora: ' + t('connected')
    else $('#integBadge').textContent = 'WeKnora: ' + (s.credential === 'configured' ? t('unavailable') : t('notConfigured'))
    $('#integBadge').className = 'badge ' + (integ ? 'ok' : 'warn')
    return s
  } catch (e) {
    $('#integBadge').textContent = 'WeKnora: ' + t('error')
    $('#integBadge').className = 'badge err'
    return null
  }
}

function setView(v){
  state.view = v
  state.selectedNoteId = null
  state.selectedAttachmentId = null
  render()
}

function render(){
  applyLang()
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view))
  refreshHeader()
  if (state.view === 'overview') renderOverview()
  else if (state.view === 'notes') renderNotes()
  else if (state.view === 'attachments') renderAttachments()
  else renderSearchView()
}

async function renderOverview(){
  $('#list').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = ''
  try {
    const s = await api('summary')
    const integ = s.integration === 'ready'
    const rows = []
    rows.push('<div class="stat"><div class="n">' + s.notes + '</div><div class="l">' + esc(t('overviewNotes')) + '</div></div>')
    rows.push('<div class="stat"><div class="n">' + s.attachments + '</div><div class="l">' + esc(t('overviewAttachments')) + '</div></div>')
    rows.push('<div class="stat"><div class="n">' + s.mappings + '</div><div class="l">' + esc(t('overviewMappings')) + '</div></div>')
    rows.push('<div class="stat"><div class="n">' + s.pendingSync + '</div><div class="l">' + esc(t('overviewPendingSync')) + '</div></div>')
    rows.push('<div class="stat"><div class="n">' + s.syncErrors + '</div><div class="l">' + esc(t('overviewSyncErrors')) + '</div></div>')
    const integBadge = '<span class="badge ' + (integ ? 'ok' : 'warn') + '">' + (integ ? t('connected') : (s.credential === 'configured' ? t('unavailable') : t('notConfigured'))) + '</span>'
    let recentHtml = ''
    if ((s.recent || []).length) {
      recentHtml = (s.recent || []).map(r =>
        '<div class="row" data-action="' + (r.kind === 'note' ? 'open-note' : 'open-attachment') + '" data-id="' + esc(r.id) + '">' +
        '<div class="t">' + esc(r.title) + '</div>' +
        '<div class="p">' + esc(r.kind === 'note' ? t('recentNote') : t('recentAttachment')) + ' · ' + esc(r.updatedAt) + '</div></div>'
      ).join('')
    } else recentHtml = '<div class="empty">' + esc(t('noRecent')) + '</div>'
    $('#main').innerHTML =
      '<h2>' + esc(t('overviewTitle')) + '<span class="sub">' + esc(s.workspaceName || '') + '</span></h2>' +
      '<div class="toolbar">' +
        '<button class="btn primary" data-action="new-note">+ ' + esc(t('newNote')) + '</button>' +
        '<button class="btn" data-action="go-attachments">' + esc(t('upload')) + '</button>' +
        '<button class="btn" data-action="sync-now">' + esc(t('syncNow')) + '</button>' +
        '<button class="btn" data-action="reconcile">' + esc(t('reconcile')) + '</button>' +
      '</div>' +
      '<div class="stats">' + rows.join('') + '</div>' +
      '<h2>' + esc(t('overviewIntegration')) + '</h2>' + integBadge +
      '<h2 style="margin-top:16px">' + esc(t('overviewRecent')) + '</h2>' + recentHtml
    $('#detail').innerHTML = detailWorkspace(s)
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}

function detailWorkspace(s){
  return '<h3>' + esc(t('workspaceSummary')) + '</h3>' +
    '<div class="kv"><b>' + esc(t('workspaceLabel')) + '</b> <span class="v">' + esc(s.workspaceName || '—') + '</span></div>' +
    '<div class="kv"><b>' + esc(t('path')) + '</b> <span class="v mono">' + esc(s.workspacePath || '—') + '</span></div>' +
    '<div class="kv"><b>WorkspaceId</b> <span class="v mono">' + esc(s.workspaceId || '') + '</span></div>' +
    '<div class="kv"><b>' + esc(t('kb')) + '</b> <span class="v mono">' + esc((s.kbId || '').slice(0, 12)) + '…</span></div>' +
    '<h3>' + esc(t('maintenance')) + '</h3>' +
    '<button class="btn" data-action="sync-now">' + esc(t('syncNow')) + '</button> ' +
    '<button class="btn" data-action="reconcile">' + esc(t('reconcile')) + '</button>'
}

async function renderNotes(){
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  if (state.selectedNoteId === null) { $('#main').innerHTML = '<div class="empty">' + esc(t('selectNote')) + '</div>'; $('#detail').innerHTML = '' }
  try {
    const notes = await api('listNotes')
    let listHtml
    if (!notes.length) {
      listHtml = '<div class="empty">' + esc(t('emptyNotes')) + '<div class="cta"><button class="btn primary" data-action="new-note">+ ' + esc(t('emptyNotesCta')) + '</button></div></div>'
    } else {
      const byFolder = new Map()
      for (const n of notes) {
        const f = n.folder || ''
        if (!byFolder.has(f)) byFolder.set(f, [])
        byFolder.get(f).push(n)
      }
      const folders = [...byFolder.keys()].sort()
      const parts = []
      for (const f of folders) {
        if (f) parts.push('<div class="list-head">' + esc(f) + '/</div>')
        for (const n of byFolder.get(f)) {
          parts.push('<div class="row ' + (n.noteId === state.selectedNoteId ? 'active' : '') + '" data-action="open-note" data-id="' + esc(n.noteId) + '">' +
            '<div class="t">' + esc(n.title || n.relativePath) + ' ' + syncBadgeHtml(n.sync) + '</div>' +
            '<div class="p">' + esc(n.relativePath) + (n.deleted ? ' · ' + esc(t('deletedSuffix')) : '') + '</div></div>')
        }
      }
      listHtml = parts.join('')
    }
    $('#list').innerHTML = listHtml
    if (state.selectedNoteId !== null) await openNote(state.selectedNoteId)
  } catch (e) { $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}

async function openNote(noteId){
  state.selectedNoteId = noteId
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const d = await api('getNote', { noteId })
    const sync = d.sync
    $('#main').innerHTML =
      '<div class="toolbar">' +
        '<button class="btn primary" data-action="save-note">' + esc(t('save')) + '</button>' +
        '<button class="btn" data-action="rename-note">' + esc(t('renameMove')) + '</button>' +
        '<button class="btn" data-action="sync-note" data-id="' + esc(noteId) + '">' + esc(t('syncNow')) + '</button>' +
        '<button class="btn danger" data-action="delete-note">' + esc(t('del')) + '</button>' +
        '<span id="status" class="muted">' + esc(t('localSaved')) + '</span>' +
      '</div>' +
      '<div class="editor-wrap">' +
        '<div class="editor-head"><span class="title">' + esc(d.note.title) + '</span><span class="path">' + esc(d.note.relativePath) + '</span></div>' +
        '<textarea id="editor" aria-label="Markdown">' + esc(d.markdown) + '</textarea>' +
        '<div id="preview"></div>' +
      '</div>'
    renderPreview()
    const el = $('#editor')
    if (el) el.addEventListener('input', renderPreview)
    $('#detail').innerHTML = detailNote(d)
    await renderNotes()
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}

function detailNote(d){
  const s = d.sync
  return '<h3>' + esc(t('details')) + '</h3>' +
    '<div class="kv"><b>' + esc(t('noteId')) + '</b> <span class="v mono">' + esc(d.note.noteId) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('path')) + '</b> <span class="v mono">' + esc(d.note.relativePath) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('revision')) + '</b> ' + d.note.observedRevision + '</div>' +
    '<div class="kv"><b>' + esc(t('updated')) + '</b> ' + esc(d.note.updatedAt) + '</div>' +
    '<h3>' + esc(t('syncSection')) + '</h3>' + syncBadgeHtml(s) +
    (s && s.knowledgeId ? '<div class="kv"><b>' + esc(t('knowledgeId')) + '</b> <span class="v mono">' + esc(s.knowledgeId) + '</span></div>' : '') +
    (s && s.error ? '<div class="kv"><b>' + esc(t('lastError')) + '</b> <span class="v">' + esc(s.error) + '</span></div>' : '') +
    (s && s.updatedAt ? '<div class="kv"><b>' + esc(t('updated')) + '</b> ' + esc(s.updatedAt) + '</div>' : '') +
    '<h3>' + esc(t('maintenance')) + '</h3>' +
    '<button class="btn" data-action="sync-note" data-id="' + esc(d.note.noteId) + '">' + esc(t('syncNow')) + '</button>'
}

function renderPreview(){
  const el = $('#editor')
  if (!el) return
  const md = el.value || ''
  const escMd = esc(md)
  const html = escMd
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
    .replace(/\\n/g, '<br>')
  $('#preview').innerHTML = html || '<span class="muted">' + esc(t('emptyPreview')) + '</span>'
}

async function saveNote(){
  if (state.selectedNoteId === null) return
  const btn = document.querySelector('[data-action="save-note"]')
  if (btn) { btn.disabled = true; btn.textContent = t('saving') }
  try {
    const d = await api('saveNote', { noteId: state.selectedNoteId, markdown: $('#editor').value })
    $('#status').textContent = t('localSavedR', { r: d.observedRevision })
    toast(t('localSaved'), 'ok')
    await refreshHeader(); await renderNotes()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
  finally { if (btn) { btn.disabled = false; btn.textContent = t('save') } }
}

async function newNote(){
  const rel = prompt(t('newNotePrompt'), t('untitled'))
  if (!rel) return
  try {
    const r = await api('createNote', { relativePath: rel, markdown: '---\\nid: __placeholder__\\n---\\n\\n# ' + t('newNote') + '\\n' })
    state.selectedNoteId = r.noteId
    await renderNotes(); await openNote(r.noteId)
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function renameNote(){
  if (state.selectedNoteId === null) return
  const cur = await api('getNote', { noteId: state.selectedNoteId })
  const rel = prompt(t('renamePrompt'), cur.note.relativePath)
  if (!rel || rel === cur.note.relativePath) return
  try {
    await api('moveNote', { noteId: state.selectedNoteId, relativePath: rel })
    toast(t('ok'), 'ok')
    await renderNotes(); await openNote(state.selectedNoteId)
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function delNote(){
  if (state.selectedNoteId === null) return
  if (!confirm(t('delNoteConfirm'))) return
  try {
    await api('deleteNote', { noteId: state.selectedNoteId })
    state.selectedNoteId = null
    toast(t('deletedMsg'), 'ok')
    await renderNotes(); await refreshHeader()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function renderAttachments(){
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = '<h3>' + esc(t('attachments')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>'
  try {
    const list = await api('listAttachments')
    $('#list').innerHTML = list.length ? list.map(a =>
      '<div class="row ' + (a.attachmentId === state.selectedAttachmentId ? 'active' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '">' +
      '<div class="t">' + esc(a.filename) + ' ' + syncBadgeHtml(a.sync) + '</div>' +
      '<div class="p">' + fmtSize(a.sizeBytes) + (a.deleted ? ' · ' + esc(t('deletedSuffix')) : '') + '</div></div>'
    ).join('') : '<div class="empty">' + esc(t('emptyAttachments')) + '</div>'
    $('#main').innerHTML =
      '<h2>' + esc(t('attachments')) + '</h2>' +
      '<p class="muted">' + esc(t('attachmentsDesc')) + '</p>' +
      '<div class="toolbar">' +
        '<input type="file" id="file" aria-label="file" /> ' +
        '<button class="btn primary" data-action="upload-attachment">' + esc(t('upload')) + '</button>' +
      '</div>' +
      '<div class="empty">' + esc(t('attachmentDetailHint')) + '</div>'
    if (state.selectedAttachmentId !== null) await openAttachment(state.selectedAttachmentId)
  } catch (e) { $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}

async function openAttachment(id){
  state.selectedAttachmentId = id
  try {
    const d = await api('getAttachment', { attachmentId: id })
    const a = d.attachment, s = d.sync
    $('#detail').innerHTML =
      '<h3>' + esc(t('details')) + '</h3>' +
      '<div class="kv"><b>' + esc(t('attachmentId')) + '</b> <span class="v mono">' + esc(a.attachmentId) + '</span></div>' +
      '<div class="kv"><b>' + esc(t('size')) + '</b> ' + fmtSize(a.sizeBytes) + '</div>' +
      '<div class="kv"><b>' + esc(t('revision')) + '</b> ' + a.observedRevision + '</div>' +
      '<h3>' + esc(t('syncSection')) + '</h3>' + syncBadgeHtml(s) +
      (s && s.knowledgeId ? '<div class="kv"><b>' + esc(t('knowledgeId')) + '</b> <span class="v mono">' + esc(s.knowledgeId) + '</span></div>' : '') +
      (s && s.error ? '<div class="kv"><b>' + esc(t('lastError')) + '</b> <span class="v">' + esc(s.error) + '</span></div>' : '') +
      '<h3>' + esc(t('maintenance')) + '</h3>' +
      '<button class="btn" data-action="download-attachment" data-id="' + esc(id) + '">' + esc(t('download')) + '</button> ' +
      '<button class="btn danger" data-action="delete-attachment" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>'
    await renderAttachments()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function uploadAttachment(){
  const fileInput = $('#file')
  const file = fileInput && fileInput.files && fileInput.files[0]
  if (!file) { toast(t('uploadFailed'), 'warn'); return }
  toast(t('uploadProgress'), 'warn')
  try {
    const buf = new Uint8Array(await file.arrayBuffer())
    let binary = ''
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i])
    const base64 = btoa(binary)
    await api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64 })
    toast(t('uploadSuccess'), 'ok')
    state.selectedAttachmentId = null
    await renderAttachments(); await refreshHeader()
  } catch (e) { toast(t('uploadFailed') + ': ' + e.message, 'err') }
}

async function downloadAttachment(id){
  try {
    const d = await api('downloadAttachment', { attachmentId: id })
    const bytes = Uint8Array.from(atob(d.contentBase64), c => c.charCodeAt(0))
    const blob = new Blob([bytes], { type: d.mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = d.filename
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function delAttachment(id){
  if (!confirm(t('delAttachmentConfirm'))) return
  try {
    await api('deleteAttachment', { attachmentId: id })
    state.selectedAttachmentId = null
    toast(t('deletedMsg'), 'ok')
    await renderAttachments(); await refreshHeader()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function renderSearchView(){
  $('#list').innerHTML = ''
  $('#detail').innerHTML = ''
  $('#main').innerHTML =
    '<h2>' + esc(t('search')) + '</h2>' +
    '<p class="muted">' + esc(t('searchHint')) + '</p>'
}

async function runSearch(q){
  state.searchQuery = q
  $('#main').innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
  $('#detail').innerHTML = ''
  try {
    const results = await api('search', { query: q, limit: 10 })
    if (!results.length) { $('#main').innerHTML = '<div class="empty">' + t('noHits', { q: esc(q) }) + '</div>'; return }
    $('#main').innerHTML =
      '<h2>' + esc(t('search')) + '<span class="sub">' + esc(q) + '</span></h2>' +
      results.map(r => {
        const local = r.local
        const title = r.remote.title || r.remote.filename || r.remote.knowledgeId
        const kind = local ? (local.entityType === 'note' ? t('noteLabel') : t('attachmentLabel')) : t('externalWeKnora')
        const openBtn = local
          ? '<button data-action="open-' + (local.entityType === 'note' ? 'note' : 'attachment') + '" data-id="' + esc(local.entityId) + '">' + (local.entityType === 'note' ? esc(t('openNote')) : esc(t('openAttachment'))) + '</button>'
          : ''
        return '<div class="hit"><div class="t">' + esc(title) + '</div>' +
          '<div class="snippet">' + esc((r.remote.content || '').slice(0, 220)) + '</div>' +
          '<div class="ref">' + esc(t('score')) + ' ' + (r.remote.score != null ? r.remote.score.toFixed(3) : '—') + ' · ' + esc(kind) + openBtn + '</div></div>'
      }).join('')
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('searchFailed')) + ': ' + esc(e.message) + '</div>' }
}

async function syncNow(){
  toast(t('syncingAll'), 'warn')
  try { await api('syncNow'); toast(t('ok'), 'ok'); await render() }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function syncEntity(entityType, entityId){
  try {
    await api('syncEntity', { entityType, entityId })
    toast(t('ok'), 'ok')
    await render()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function reconcile(){
  try {
    const r = await api('reconcile')
    toast(t('reconcileResult', { a: r.notesRepaired, b: r.attachmentsRepaired, c: r.markedDirty, d: r.markedDeleted }), 'ok')
    await render()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav button')
  if (nav) { setView(nav.dataset.view); return }
  const el = e.target.closest('[data-action]')
  if (!el) return
  const act = el.dataset.action, id = el.dataset.id
  if (act === 'new-note') newNote()
  else if (act === 'open-note') { state.selectedNoteId = id; setView('notes'); openNote(id) }
  else if (act === 'open-attachment') { state.selectedAttachmentId = id; setView('attachments'); openAttachment(id) }
  else if (act === 'save-note') saveNote()
  else if (act === 'rename-note') renameNote()
  else if (act === 'delete-note') delNote()
  else if (act === 'sync-note') syncEntity('note', id)
  else if (act === 'sync-now') syncNow()
  else if (act === 'reconcile') reconcile()
  else if (act === 'upload-attachment') uploadAttachment()
  else if (act === 'download-attachment') downloadAttachment(id)
  else if (act === 'delete-attachment') delAttachment(id)
  else if (act === 'go-attachments') setView('attachments')
})

$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) {
    state.view = 'search'
    render()
    runSearch(e.target.value.trim())
  }
})

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
    e.preventDefault()
    if (state.view === 'notes' && state.selectedNoteId !== null) saveNote()
  }
})

$('#langBtn').addEventListener('click', () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  localStorage.setItem('pkw-lang', lang)
  render()
})

// boot
render()
</script>
</body>
</html>`
}
