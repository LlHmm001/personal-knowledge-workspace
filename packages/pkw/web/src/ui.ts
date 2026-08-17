/**
 * PKW Web browser page — a self-contained HTML/JS client served by the Host at
 * `GET /pkw`. Talks only to `POST /pkw/api` (the Host bridge); never touches
 * SQLite, the workspace filesystem, the WeKnora API key, or WeKnora REST.
 *
 * Editor draft is separate from persisted note state: background sync/parse
 * status updates never rebuild the editor or disturb the cursor. Localized to
 * Chinese (zh) and English (en) only.
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
#app{display:grid;grid-template-columns:280px 1fr 300px;grid-template-rows:52px 1fr;height:100vh}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{font-size:15px;margin:0;font-weight:700}
header .spacer{flex:1}
#search{width:320px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.badge{padding:2px 9px;border-radius:999px;font-size:12px;background:#eef2f8;color:var(--muted);white-space:nowrap}
.badge.ok{background:#e8f6ee;color:var(--ok)}.badge.warn{background:#fdf1e3;color:var(--warn)}.badge.err{background:#fdeaea;color:var(--err)}
.langbtn{padding:6px 11px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:12px;color:var(--ink);font-weight:600}
.langbtn:hover{background:#eef2f8}
aside{border-right:1px solid var(--border);background:var(--panel);display:flex;flex-direction:column;min-height:0}
.nav{padding:10px 10px 6px;flex:0 0 auto}.nav button{display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink);margin-bottom:2px}
.nav button.active,.nav button:hover{background:#eef2f8}.nav button.active{font-weight:650;color:var(--accent)}
#list{overflow:auto;padding:6px 8px 12px;flex:1 1 auto}
.tree-toolbar{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--border);flex:0 0 auto;align-items:center}
.tree-toolbar .btn{flex:1}
.tree-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;cursor:pointer;border:1px solid transparent;font-size:13px}
.tree-row:hover{background:#f1f4f9}
.tree-row.active{background:#e7eefb;border-color:#cdddf7}
.tree-row .tw{width:16px;text-align:center;color:var(--muted);flex:0 0 auto;font-size:11px}
.tree-row .ic{flex:0 0 auto;font-size:12px}
.tree-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.tree-row .badge{margin-left:2px}
.tree-row.note .nm{font-weight:500}
.tree-children{margin-left:14px;border-left:1px solid var(--border);padding-left:4px}
main{overflow:auto;padding:20px 24px;background:var(--bg)}
main h2{margin:0 0 12px;font-size:18px;font-weight:650}
main h2 .sub{font-size:12px;color:var(--muted);font-weight:400;margin-left:8px}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap}
button.btn{padding:7px 12px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:13px}
button.btn:hover{border-color:#c6ccd4}
button.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.btn.danger{color:var(--err)}
button.btn:disabled{opacity:.5;cursor:default}
button.btn.small{padding:4px 8px;font-size:12px}
select.sel{padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--panel)}
.editor-wrap{border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}
.editor-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)}
.editor-head .title{font-weight:600}
.editor-head .path{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace}
textarea#editor{width:100%;height:50vh;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px 14px;border:0;resize:vertical;outline:none;display:block}
#preview{border-top:1px solid var(--border);padding:12px 16px;background:#fbfcfe;min-height:12vh}
#preview h1,#preview h2,#preview h3{font-size:1.05em}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
#saveStatus{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:4px}
#saveStatus.dirty{color:var(--warn);font-weight:600}
#saveStatus.saving{color:var(--accent)}
#saveStatus.saved{color:var(--ok)}
aside.right{border-left:1px solid var(--border);background:var(--panel);padding:14px;overflow:auto}
aside.right h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px}
aside.right h3:first-child{margin-top:0}
.kv{font-size:12px;margin:3px 0}.kv b{color:var(--muted);font-weight:500;display:inline-block;min-width:88px}
.kv .v{word-break:break-all}
.hit{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--panel)}
.hit .t{font-weight:600}.hit .snippet{font-size:12px;color:var(--muted);margin:4px 0}
.hit .ref{font-size:12px;color:var(--muted)}.hit button{font-size:12px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer;margin-left:4px}
.empty{color:var(--muted);padding:28px;text-align:center}
.empty .cta{margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel)}
.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:12px;color:var(--muted)}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:60;display:none}
.toast{padding:9px 16px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.15)}
.toast.ok{background:var(--ok)}.toast.err{background:var(--err)}.toast.warn{background:var(--warn)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:70;display:flex;align-items:center;justify-content:center}
.modal{background:var(--panel);border-radius:12px;padding:18px;min-width:320px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.modal h3{margin:0 0 12px;font-size:15px}
.modal select{width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:13px;margin-bottom:12px}
.modal-actions{display:flex;gap:8px;justify-content:flex-end}
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
    <div id="treeToolbar"></div>
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
    workspaceLabel:'工作区', localSummary:'本地: {n} 笔记 · {m} 文件',
    connected:'已连接', unavailable:'不可用', notConfigured:'未配置', error:'错误',
    overviewTitle:'工作区概览', overviewNotes:'笔记', overviewAttachments:'附件',
    overviewMappings:'已同步对象', overviewPendingSync:'待同步', overviewSyncErrors:'同步错误',
    overviewIntegration:'WeKnora 集成', overviewRecent:'最近更新', overviewEmpty:'工作区为空。点击「新建笔记」开始。',
    recentNote:'笔记', recentAttachment:'附件', noRecent:'暂无最近更新',
    newNote:'新建笔记', newFolder:'新建文件夹', emptyNotes:'还没有笔记。', emptyNotesCta:'新建第一篇笔记',
    loading:'加载中…', deletedSuffix:'已删除',
    save:'保存', renameMove:'重命名 / 移动', del:'删除', syncNow:'立即同步', reconcile:'重建索引',
    localSaved:'本地已保存', localSavedR:'本地已保存 · r{r}', saving:'保存中…',
    unsaved:'未保存', saved:'已保存',
    preview:'预览', newNotePrompt:'笔记标题（相对路径将自动生成）', renamePrompt:'新相对路径',
    delNoteConfirm:'删除这篇笔记？', deletedMsg:'已删除', selectNote:'从左侧选择或新建一篇笔记。',
    untitled:'untitled.md', notSynced:'未同步', synced:'已同步', syncing:'同步中', pending:'待同步', failed:'失败', stale:'已过期', deleted:'已删除',
    upload:'上传文件', emptyAttachments:'还没有附件。', attachmentsDesc:'上传 → 本地保存 → 异步同步到 WeKnora。',
    size:'大小', download:'下载', delAttachmentConfirm:'删除该附件？', attachmentDetailHint:'选中附件查看详情。',
    uploadProgress:'上传中…', uploadSuccess:'已上传', uploadFailed:'上传失败',
    searching:'搜索中…', noHits:'没有命中「{q}」。', searchHint:'输入关键词搜索本地笔记与附件（经 WeKnora hybrid search）。',
    score:'得分', openNote:'打开笔记', openAttachment:'打开附件', externalWeKnora:'WeKnora 外部',
    noteLabel:'笔记', attachmentLabel:'附件',
    details:'详情', noteId:'NoteId', attachmentId:'AttachmentId', path:'路径', revision:'版本',
    updated:'更新时间', lastError:'最近错误', maintenance:'维护', advanced:'高级',
    workspaceSummary:'工作区摘要', kb:'知识库', state:'状态', parse:'解析',
    syncSection:'WeKnora 同步', noSyncInfo:'尚未同步。',
    reconcileDone:'重建完成', reconcileResult:'笔记修复 {a} · 附件修复 {b} · 待同步 {c} · 已删 {d}',
    syncingAll:'正在同步…', genericError:'操作失败', ok:'完成', emptyPreview:'（空）', searchFailed:'搜索失败',
    folder:'文件夹', rootFolder:'（根目录）', newNoteHere:'在此新建笔记', newSubfolder:'新建子文件夹',
    renameFolder:'重命名', moveTo:'移动到…', moveFolder:'移动文件夹', deleteFolder:'删除文件夹',
    folderRenamePrompt:'新文件夹名称', folderDeleteConfirm:'删除文件夹「{n}」？', folderNotEmpty:'文件夹不为空，无法删除。',
    moveNoteTo:'移动笔记到', moveUp:'上移', moveDown:'下移',
    sortMode:'排序', sortManual:'手动', sortTitle:'标题', sortUpdated:'更新时间',
    cancel:'取消', createFolderPrompt:'文件夹名称', folderCreated:'文件夹已创建',
    selectFolder:'选择一个文件夹。',
  },
  en: {
    overview:'Overview', notes:'Notes', attachments:'Attachments', search:'Search',
    searchPlaceholder:'Search knowledge base (hybrid search)…',
    workspaceLabel:'Workspace', localSummary:'Local: {n} notes · {m} files',
    connected:'Connected', unavailable:'Unavailable', notConfigured:'Not configured', error:'error',
    overviewTitle:'Workspace Overview', overviewNotes:'Notes', overviewAttachments:'Attachments',
    overviewMappings:'Synced objects', overviewPendingSync:'Pending sync', overviewSyncErrors:'Sync errors',
    overviewIntegration:'WeKnora integration', overviewRecent:'Recent', overviewEmpty:'Workspace is empty. Click 「New Note」 to start.',
    recentNote:'Note', recentAttachment:'Attachment', noRecent:'No recent changes',
    newNote:'New Note', newFolder:'New Folder', emptyNotes:'No notes yet.', emptyNotesCta:'Create your first note',
    loading:'Loading…', deletedSuffix:'deleted',
    save:'Save', renameMove:'Rename / Move', del:'Delete', syncNow:'Sync now', reconcile:'Reconcile',
    localSaved:'Local saved', localSavedR:'Local saved · r{r}', saving:'Saving…',
    unsaved:'Unsaved', saved:'Saved',
    preview:'Preview', newNotePrompt:'Note title (path is auto-generated)', renamePrompt:'New relative path',
    delNoteConfirm:'Delete this note?', deletedMsg:'Deleted', selectNote:'Select or create a note from the left.',
    untitled:'untitled.md', notSynced:'Not synced', synced:'Synced', syncing:'Syncing', pending:'Pending', failed:'Failed', stale:'Stale', deleted:'Deleted',
    upload:'Upload file', emptyAttachments:'No attachments yet.', attachmentsDesc:'Upload → local save → async WeKnora sync.',
    size:'Size', download:'Download', delAttachmentConfirm:'Delete this attachment?', attachmentDetailHint:'Select an attachment to view details.',
    uploadProgress:'Uploading…', uploadSuccess:'Uploaded', uploadFailed:'Upload failed',
    searching:'Searching…', noHits:'No hits for 「{q}」.', searchHint:'Type a query to search notes & attachments (via WeKnora hybrid search).',
    score:'score', openNote:'Open note', openAttachment:'Open attachment', externalWeKnora:'external WeKnora',
    noteLabel:'Note', attachmentLabel:'Attachment',
    details:'Details', noteId:'NoteId', attachmentId:'AttachmentId', path:'Path', revision:'Revision',
    updated:'Updated', lastError:'Last error', maintenance:'Maintenance', advanced:'Advanced',
    workspaceSummary:'Workspace summary', kb:'KB', state:'State', parse:'Parse',
    syncSection:'WeKnora Sync', noSyncInfo:'Not synced yet.',
    reconcileDone:'Reconcile done', reconcileResult:'Notes repaired {a} · attachments repaired {b} · dirty {c} · deleted {d}',
    syncingAll:'Syncing…', genericError:'Operation failed', ok:'Done', emptyPreview:'(empty)', searchFailed:'Search failed',
    folder:'Folder', rootFolder:'(root)', newNoteHere:'New note here', newSubfolder:'New subfolder',
    renameFolder:'Rename', moveTo:'Move to…', moveFolder:'Move folder', deleteFolder:'Delete folder',
    folderRenamePrompt:'New folder name', folderDeleteConfirm:'Delete folder 「{n}」?', folderNotEmpty:'Folder is not empty and cannot be deleted.',
    moveNoteTo:'Move note to', moveUp:'Move up', moveDown:'Move down',
    sortMode:'Sort', sortManual:'Manual', sortTitle:'Title', sortUpdated:'Updated',
    cancel:'Cancel', createFolderPrompt:'Folder name', folderCreated:'Folder created',
    selectFolder:'Select a folder.',
  },
}
let lang = localStorage.getItem('pkw-lang') === 'en' ? 'en' : 'zh'
const t = (key, vars) => { let s = STR[lang][key] ?? STR.zh[key] ?? key; if (vars) for (const k in vars) s = s.split('{' + k + '}').join(String(vars[k])); return s }
const api = async (method, args = {}) => {
  const res = await fetch('/pkw/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  let data = {}
  try { data = await res.json() } catch (e) {}
  if (!res.ok || data.ok !== true) throw new Error((data && data.error) || ('HTTP ' + res.status))
  return data.value
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))

const state = {
  view: 'overview',
  selectedNoteId: null,
  selectedFolder: null,
  selectedAttachmentId: null,
  sortMode: localStorage.getItem('pkw-sort') || 'manual',
  treeRoot: [],
  collapsed: new Set(),
  editor: { noteId: null, persistedMarkdown: '', dirty: false, saving: false },
}

function toast(msg, kind){ const el = $('#toast'); el.innerHTML = '<div class="toast ' + (kind || 'ok') + '">' + esc(msg) + '</div>'; el.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.display = 'none' }, 3200) }

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
  return '<span class="badge ' + cls + '">' + esc(label) + '</span>'
}

function fmtSize(n){ if (n < 1024) return n + ' B'; if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'; return (n / 1024 / 1024).toFixed(1) + ' MB' }

async function refreshHeader(){
  try {
    const s = await api('summary')
    $('#wsBadge').textContent = t('workspaceLabel') + ': ' + (s.workspaceName || 'Personal Workspace')
    $('#localBadge').textContent = t('localSummary', { n: s.notes, m: s.attachments })
    $('#localBadge').className = 'badge ok'
    const integ = s.integration === 'ready'
    $('#integBadge').textContent = 'WeKnora: ' + (integ ? t('connected') : (s.credential === 'configured' ? t('unavailable') : t('notConfigured')))
    $('#integBadge').className = 'badge ' + (integ ? 'ok' : 'warn')
  } catch (e) { $('#integBadge').textContent = 'WeKnora: ' + t('error'); $('#integBadge').className = 'badge err' }
}

function setView(v){
  state.view = v
  if (v !== 'notes') { state.selectedNoteId = null; state.selectedFolder = null }
  if (v !== 'attachments') state.selectedAttachmentId = null
  render()
}

function render(){
  applyLang()
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view))
  refreshHeader()
  if (state.view === 'overview') renderOverview()
  else if (state.view === 'notes') { renderTreeToolbar(); renderTree(); renderDetail() }
  else if (state.view === 'attachments') renderAttachments()
  else renderSearchView()
}

// ── Overview ────────────────────────────────────────────────────────────────

async function renderOverview(){
  $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = ''
  try {
    const s = await api('summary')
    const integ = s.integration === 'ready'
    const rows = [
      '<div class="stat"><div class="n">' + s.notes + '</div><div class="l">' + esc(t('overviewNotes')) + '</div></div>',
      '<div class="stat"><div class="n">' + s.attachments + '</div><div class="l">' + esc(t('overviewAttachments')) + '</div></div>',
      '<div class="stat"><div class="n">' + s.mappings + '</div><div class="l">' + esc(t('overviewMappings')) + '</div></div>',
      '<div class="stat"><div class="n">' + s.pendingSync + '</div><div class="l">' + esc(t('overviewPendingSync')) + '</div></div>',
      '<div class="stat"><div class="n">' + s.syncErrors + '</div><div class="l">' + esc(t('overviewSyncErrors')) + '</div></div>',
    ]
    const integBadge = '<span class="badge ' + (integ ? 'ok' : 'warn') + '">' + (integ ? t('connected') : (s.credential === 'configured' ? t('unavailable') : t('notConfigured'))) + '</span>'
    let recentHtml = (s.recent || []).length
      ? (s.recent || []).map(r => '<div class="tree-row" data-action="' + (r.kind === 'note' ? 'open-note' : 'open-attachment') + '" data-id="' + esc(r.id) + '"><span class="nm">' + esc(r.title) + '</span></div>').join('')
      : '<div class="empty">' + esc(t('noRecent')) + '</div>'
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
    '<div class="kv"><b>WorkspaceId</b> <span class="v mono">' + esc(s.workspaceId || '') + '</span></div>' +
    '<div class="kv"><b>' + esc(t('kb')) + '</b> <span class="v mono">' + esc((s.kbId || '').slice(0, 12)) + '…</span></div>' +
    '<h3>' + esc(t('maintenance')) + '</h3>' +
    '<button class="btn small" data-action="sync-now">' + esc(t('syncNow')) + '</button> ' +
    '<button class="btn small" data-action="reconcile">' + esc(t('reconcile')) + '</button>'
}

// ── Notes tree ──────────────────────────────────────────────────────────────

function renderTreeToolbar(){
  const sel = '<select id="sortSel" class="sel">' +
    '<option value="manual"' + (state.sortMode === 'manual' ? ' selected' : '') + '>' + esc(t('sortManual')) + '</option>' +
    '<option value="title"' + (state.sortMode === 'title' ? ' selected' : '') + '>' + esc(t('sortTitle')) + '</option>' +
    '<option value="updated"' + (state.sortMode === 'updated' ? ' selected' : '') + '>' + esc(t('sortUpdated')) + '</option>' +
    '</select>'
  $('#treeToolbar').innerHTML =
    '<div class="tree-toolbar">' +
      '<button class="btn small primary" data-action="new-note">+ ' + esc(t('newNote')) + '</button>' +
      '<button class="btn small" data-action="new-folder">+ ' + esc(t('newFolder')) + '</button>' +
    '</div>' +
    '<div class="tree-toolbar" style="border-top:0">' + esc(t('sortMode')) + ' ' + sel + '</div>'
  $('#sortSel').addEventListener('change', (e) => { state.sortMode = e.target.value; localStorage.setItem('pkw-sort', state.sortMode); renderTree() })
}

async function renderTree(){
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const tree = await api('getTree', { sortMode: state.sortMode })
    state.treeRoot = tree.root || []
    $('#list').innerHTML = renderTreeNodes(state.treeRoot, '') || '<div class="empty">' + esc(t('emptyNotes')) + '<div class="cta"><button class="btn primary" data-action="new-note">+ ' + esc(t('emptyNotesCta')) + '</button></div></div>'
  } catch (e) { $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}

function renderTreeNodes(nodes, parentPath){
  if (!nodes.length) return ''
  return nodes.map(n => n.kind === 'folder'
    ? renderFolderNode(n)
    : renderNoteNode(n)).join('')
}

function renderFolderNode(n){
  const sel = state.selectedFolder === n.path ? ' active' : ''
  const collapsed = state.collapsed.has(n.path)
  return '<div>' +
    '<div class="tree-row folder ' + sel + '" data-action="select-folder" data-path="' + esc(n.path) + '">' +
      '<span class="tw" data-action="toggle-folder" data-path="' + esc(n.path) + '">' + (collapsed ? '▸' : '▾') + '</span>' +
      '<span class="ic">📁</span>' +
      '<span class="nm">' + esc(n.name) + '</span>' +
    '</div>' +
    '<div class="tree-children" data-folder="' + esc(n.path) + '"' + (collapsed ? ' style="display:none"' : '') + '>' + renderTreeNodes(n.children || [], n.path) + '</div>' +
  '</div>'
}

function renderNoteNode(n){
  const sel = state.selectedNoteId === n.noteId ? ' active' : ''
  return '<div class="tree-row note ' + sel + '" data-action="open-note" data-id="' + esc(n.noteId) + '">' +
    '<span class="tw"></span><span class="ic">📄</span>' +
    '<span class="nm">' + esc(n.title || n.relativePath) + '</span> ' + syncBadgeHtml(n.sync) +
  '</div>'
}

function renderDetail(){
  if (state.view !== 'notes') return
  if (state.selectedNoteId !== null) { /* editor already rendered it */ return }
  if (state.selectedFolder !== null) {
    const f = state.selectedFolder
    $('#detail').innerHTML =
      '<h3>' + esc(t('folder')) + '</h3>' +
      '<div class="kv"><b>' + esc(t('path')) + '</b> <span class="v mono">' + esc(f) + '/</span></div>' +
      '<h3>' + esc(t('maintenance')) + '</h3>' +
      '<button class="btn small" data-action="rename-folder" data-path="' + esc(f) + '">' + esc(t('renameFolder')) + '</button> ' +
      '<button class="btn small danger" data-action="delete-folder" data-path="' + esc(f) + '">' + esc(t('deleteFolder')) + '</button> ' +
      '<button class="btn small" data-action="move-up-folder" data-path="' + esc(f) + '">' + esc(t('moveUp')) + '</button> ' +
      '<button class="btn small" data-action="move-down-folder" data-path="' + esc(f) + '">' + esc(t('moveDown')) + '</button>'
  } else {
    $('#detail').innerHTML = ''
  }
}

// ── Notes editor ────────────────────────────────────────────────────────────

async function openNote(noteId){
  state.selectedNoteId = noteId
  state.selectedFolder = null
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const d = await api('getNote', { noteId })
    state.editor = { noteId, persistedMarkdown: d.markdown, dirty: false, saving: false }
    $('#main').innerHTML =
      '<div class="toolbar">' +
        '<button class="btn primary" data-action="save-note">' + esc(t('save')) + '</button>' +
        '<button class="btn" data-action="rename-note">' + esc(t('renameMove')) + '</button>' +
        '<button class="btn" data-action="move-note" data-id="' + esc(noteId) + '">' + esc(t('moveNoteTo')) + '</button>' +
        '<button class="btn" data-action="sync-note" data-id="' + esc(noteId) + '">' + esc(t('syncNow')) + '</button>' +
        '<button class="btn danger" data-action="delete-note">' + esc(t('del')) + '</button>' +
        '<span id="saveStatus" class="saved">✓ ' + esc(t('saved')) + '</span>' +
      '</div>' +
      '<div class="editor-wrap">' +
        '<div class="editor-head"><span class="title">' + esc(d.note.title) + '</span><span class="path">' + esc(d.note.relativePath) + '</span></div>' +
        '<textarea id="editor" aria-label="Markdown">' + esc(d.markdown) + '</textarea>' +
        '<div id="preview"></div>' +
      '</div>'
    renderPreview()
    const el = $('#editor')
    if (el) el.addEventListener('input', onEditorInput)
    $('#detail').innerHTML = detailNote(d)
    await renderTree()
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}

function onEditorInput(){
  const el = $('#editor')
  if (!el) return
  const dirty = el.value !== state.editor.persistedMarkdown
  if (dirty !== state.editor.dirty) { state.editor.dirty = dirty; updateSaveStatus() }
  renderPreview()
}

function updateSaveStatus(){
  const st = $('#saveStatus')
  if (!st) return
  if (state.editor.saving) { st.className = 'saving'; st.textContent = '… ' + t('saving') }
  else if (state.editor.dirty) { st.className = 'dirty'; st.textContent = '● ' + t('unsaved') }
  else { st.className = 'saved'; st.textContent = '✓ ' + t('saved') }
}

function renderPreview(){
  const el = $('#editor'); if (!el) return
  const escMd = esc(el.value || '')
  const html = escMd.replace(/^### (.*)$/gm, '<h3>$1</h3>').replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>').replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>').replace(/\\n/g, '<br>')
  $('#preview').innerHTML = html || '<span class="muted">' + esc(t('emptyPreview')) + '</span>'
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
    (s && s.error ? '<div class="kv"><b>' + esc(t('lastError')) + '</b> <span class="v">' + esc(s.error) + '</span></div>' : '')
}

async function saveNote(){
  if (state.selectedNoteId === null) return
  const el = $('#editor'); if (!el) return
  const btn = document.querySelector('[data-action="save-note"]')
  if (btn) btn.disabled = true
  state.editor.saving = true; updateSaveStatus()
  try {
    const d = await api('saveNote', { noteId: state.selectedNoteId, markdown: el.value })
    state.editor.persistedMarkdown = el.value
    state.editor.dirty = false; state.editor.saving = false
    updateSaveStatus()
    toast(t('localSavedR', { r: d.observedRevision }), 'ok')
    refreshHeader(); renderTree()
  } catch (e) { state.editor.saving = false; updateSaveStatus(); toast(t('genericError') + ': ' + e.message, 'err') }
  finally { if (btn) btn.disabled = false }
}

async function newNote(){
  const title = prompt(t('newNotePrompt'), '')
  if (title === null) return
  const slug = (title.trim() || 'untitled').replace(/[\\/:*?"<>|#]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled'
  const base = state.selectedFolder ? (state.selectedFolder + '/') : ''
  const rel = base + slug + '.md'
  try {
    const r = await api('createNote', { relativePath: rel, markdown: '---\\nid: __placeholder__\\n---\\n\\n# ' + (title.trim() || 'New note') + '\\n' })
    state.selectedNoteId = r.noteId; state.selectedFolder = null
    await openNote(r.noteId); refreshHeader()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function renameNote(){
  if (state.selectedNoteId === null) return
  const cur = await api('getNote', { noteId: state.selectedNoteId })
  const rel = prompt(t('renamePrompt'), cur.note.relativePath)
  if (!rel || rel === cur.note.relativePath) return
  try { await api('moveNote', { noteId: state.selectedNoteId, relativePath: rel }); await renderTree(); await openNote(state.selectedNoteId) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function delNote(){
  if (state.selectedNoteId === null) return
  if (!confirm(t('delNoteConfirm'))) return
  try {
    await api('deleteNote', { noteId: state.selectedNoteId })
    state.selectedNoteId = null; state.editor = { noteId: null, persistedMarkdown: '', dirty: false, saving: false }
    toast(t('deletedMsg'), 'ok'); render()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

// ── Folders ─────────────────────────────────────────────────────────────────

async function newFolder(parentPath){
  const name = prompt(t('createFolderPrompt'), '')
  if (!name || !name.trim()) return
  const path = (parentPath ? parentPath + '/' : '') + name.trim()
  try { await api('createFolder', { path }); state.selectedFolder = path; state.selectedNoteId = null; toast(t('folderCreated'), 'ok'); await renderTree(); renderDetail(); renderFolderMain(path) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

function renderFolderMain(path){
  $('#main').innerHTML =
    '<h2>' + esc(t('folder')) + '<span class="sub mono">' + esc(path) + '/</span></h2>' +
    '<div class="toolbar">' +
      '<button class="btn primary" data-action="new-note-here" data-path="' + esc(path) + '">+ ' + esc(t('newNoteHere')) + '</button>' +
      '<button class="btn" data-action="new-subfolder" data-path="' + esc(path) + '">+ ' + esc(t('newSubfolder')) + '</button>' +
      '<button class="btn" data-action="rename-folder" data-path="' + esc(path) + '">' + esc(t('renameFolder')) + '</button>' +
      '<button class="btn" data-action="delete-folder" data-path="' + esc(path) + '">' + esc(t('deleteFolder')) + '</button>' +
    '</div>'
  renderDetail()
}

async function renameFolder(path){
  const name = prompt(t('folderRenamePrompt'), path.split('/').pop())
  if (!name || !name.trim()) return
  const parent = parentOfPath(path)
  const newPath = (parent ? parent + '/' : '') + name.trim()
  if (newPath === path) return
  try { await api('renameFolder', { path, newPath }); state.selectedFolder = newPath; await renderTree(); renderDetail(); renderFolderMain(newPath) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function deleteFolder(path){
  if (!confirm(t('folderDeleteConfirm', { n: path.split('/').pop() }))) return
  try { await api('deleteFolder', { path }); state.selectedFolder = null; toast(t('deletedMsg'), 'ok'); await renderTree(); renderDetail() }
  catch (e) { toast((e.message && e.message.indexOf('not empty') >= 0 ? t('folderNotEmpty') : t('genericError') + ': ' + e.message), 'err') }
}

async function moveNote(noteId){
  showFolderPicker('', (target) => {
    (async () => {
      const cur = await api('getNote', { noteId })
      const rel = (target ? target + '/' : '') + cur.note.relativePath.split('/').pop()
      if (rel === cur.note.relativePath) return
      try { await api('moveNote', { noteId, relativePath: rel }); await renderTree(); await openNote(noteId) }
      catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
    })()
  })
}

function parentOfPath(p){ const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i) }

function showFolderPicker(currentPath, cb){
  api('listFolders').then(folders => {
    const html = '<div class="modal-overlay"><div class="modal"><h3>' + esc(t('moveTo')) + '</h3>' +
      '<select id="pickFolder"><option value="">' + esc(t('rootFolder')) + '</option>' +
      folders.map(f => '<option value="' + esc(f) + '"' + (f === currentPath ? ' selected' : '') + '>' + esc(f) + '</option>').join('') +
      '</select>' +
      '<div class="modal-actions"><button class="btn" data-act="pick-cancel">' + esc(t('cancel')) + '</button>' +
      '<button class="btn primary" data-act="pick-ok">' + esc(t('ok')) + '</button></div></div></div>'
    document.body.insertAdjacentHTML('beforeend', html)
    const done = (val) => { document.querySelector('.modal-overlay')?.remove(); if (val !== undefined) cb(val) }
    document.querySelector('[data-act="pick-cancel"]').onclick = () => done(undefined)
    document.querySelector('[data-act="pick-ok"]').onclick = () => done($('#pickFolder').value)
  })
}

// ── Manual ordering ─────────────────────────────────────────────────────────

async function moveItem(path, kind, dir){
  const parent = kind === 'note' ? '' : parentOfPath(path) // note path handled separately
  // For notes we need folder from current note; for folders use parentOfPath.
  if (kind === 'note') {
    const cur = await api('getNote', { noteId: state.selectedNoteId })
    const p = cur.note.relativePath.indexOf('/') === -1 ? '' : cur.note.relativePath.slice(0, cur.note.relativePath.lastIndexOf('/'))
    await moveChild(p, kind, state.selectedNoteId, dir)
  } else {
    await moveChild(parentOfPath(path), 'folder', path.split('/').pop(), dir)
  }
}

async function moveChild(parentPath, kind, id, dir){
  const siblings = childrenOf(state.treeRoot, parentPath)
  const i = siblings.findIndex(s => s.kind === kind && (kind === 'note' ? s.noteId === id : s.name === id))
  const j = i + dir
  if (i < 0 || j < 0 || j >= siblings.length) return
  const arr = siblings.slice(); const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp
  await api('setOrder', { parentPath, children: arr.map(s => ({ kind: s.kind, id: s.kind === 'note' ? s.noteId : s.name })) })
  await renderTree()
}

function childrenOf(root, parentPath){
  if (parentPath === '') return root
  let nodes = root
  for (const seg of parentPath.split('/')) {
    const f = nodes.find(n => n.kind === 'folder' && n.name === seg)
    if (!f) return []
    nodes = f.children || []
  }
  return nodes
}

// ── Attachments ─────────────────────────────────────────────────────────────

async function renderAttachments(){
  $('#treeToolbar').innerHTML = ''
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = '<h3>' + esc(t('attachments')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>'
  try {
    const list = await api('listAttachments')
    $('#list').innerHTML = list.length ? list.map(a =>
      '<div class="tree-row ' + (a.attachmentId === state.selectedAttachmentId ? 'active' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '">' +
      '<span class="tw"></span><span class="ic">📎</span><span class="nm">' + esc(a.filename) + '</span> ' + syncBadgeHtml(a.sync) + '</div>'
    ).join('') : '<div class="empty">' + esc(t('emptyAttachments')) + '</div>'
    $('#main').innerHTML =
      '<h2>' + esc(t('attachments')) + '</h2>' +
      '<p class="muted">' + esc(t('attachmentsDesc')) + '</p>' +
      '<div class="toolbar"><input type="file" id="file" /> <button class="btn primary" data-action="upload-attachment">' + esc(t('upload')) + '</button></div>'
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
      '<h3>' + esc(t('syncSection')) + '</h3>' + syncBadgeHtml(s) +
      '<h3>' + esc(t('maintenance')) + '</h3>' +
      '<button class="btn small" data-action="download-attachment" data-id="' + esc(id) + '">' + esc(t('download')) + '</button> ' +
      '<button class="btn small danger" data-action="delete-attachment" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>'
    await renderAttachments()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function uploadAttachment(){
  const fi = $('#file'); const file = fi && fi.files && fi.files[0]
  if (!file) { toast(t('uploadFailed'), 'warn'); return }
  toast(t('uploadProgress'), 'warn')
  try {
    const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
    await api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: btoa(bin) })
    toast(t('uploadSuccess'), 'ok'); await renderAttachments(); refreshHeader()
  } catch (e) { toast(t('uploadFailed') + ': ' + e.message, 'err') }
}

async function downloadAttachment(id){
  try {
    const d = await api('downloadAttachment', { attachmentId: id })
    const bytes = Uint8Array.from(atob(d.contentBase64), c => c.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: d.mimeType }))
    const a = document.createElement('a'); a.href = url; a.download = d.filename
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

async function delAttachment(id){
  if (!confirm(t('delAttachmentConfirm'))) return
  try { await api('deleteAttachment', { attachmentId: id }); state.selectedAttachmentId = null; toast(t('deletedMsg'), 'ok'); await renderAttachments(); refreshHeader() }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}

// ── Search ──────────────────────────────────────────────────────────────────

function renderSearchView(){ $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#detail').innerHTML = ''; $('#main').innerHTML = '<h2>' + esc(t('search')) + '</h2><p class="muted">' + esc(t('searchHint')) + '</p>' }

async function runSearch(q){
  $('#main').innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
  try {
    const results = await api('search', { query: q, limit: 10 })
    if (!results.length) { $('#main').innerHTML = '<div class="empty">' + t('noHits', { q: esc(q) }) + '</div>'; return }
    $('#main').innerHTML = '<h2>' + esc(t('search')) + '<span class="sub">' + esc(q) + '</span></h2>' + results.map(r => {
      const local = r.local
      const title = r.remote.title || r.remote.filename || r.remote.knowledgeId
      const kind = local ? (local.entityType === 'note' ? t('noteLabel') : t('attachmentLabel')) : t('externalWeKnora')
      const openBtn = local ? '<button data-action="open-' + (local.entityType === 'note' ? 'note' : 'attachment') + '" data-id="' + esc(local.entityId) + '">' + (local.entityType === 'note' ? esc(t('openNote')) : esc(t('openAttachment'))) + '</button>' : ''
      return '<div class="hit"><div class="t">' + esc(title) + '</div><div class="snippet">' + esc((r.remote.content || '').slice(0, 220)) + '</div><div class="ref">' + esc(t('score')) + ' ' + (r.remote.score != null ? r.remote.score.toFixed(3) : '—') + ' · ' + esc(kind) + openBtn + '</div></div>'
    }).join('')
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('searchFailed')) + ': ' + esc(e.message) + '</div>' }
}

// ── Maintenance ─────────────────────────────────────────────────────────────

async function syncNow(){ toast(t('syncingAll'), 'warn'); try { await api('syncNow'); toast(t('ok'), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function syncEntity(et, id){ try { await api('syncEntity', { entityType: et, entityId: id }); toast(t('ok'), 'ok'); if (et === 'note' && state.selectedNoteId === id) await openNote(id); else await renderTree() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function reconcile(){ try { const r = await api('reconcile'); toast(t('reconcileResult', { a: r.notesRepaired, b: r.attachmentsRepaired, c: r.markedDirty, d: r.markedDeleted }), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }

// ── Event handling ──────────────────────────────────────────────────────────

document.addEventListener('click', (e) => {
  const nav = e.target.closest('.nav button')
  if (nav) { setView(nav.dataset.view); return }
  const el = e.target.closest('[data-action]')
  if (!el) return
  const act = el.dataset.action, id = el.dataset.id, path = el.dataset.path
  if (act === 'new-note') newNote()
  else if (act === 'new-note-here') { state.selectedFolder = path; newNote() }
  else if (act === 'new-folder') newFolder(state.selectedFolder || '')
  else if (act === 'new-subfolder') newFolder(path)
  else if (act === 'open-note') { setView('notes'); openNote(id) }
  else if (act === 'open-attachment') { setView('attachments'); openAttachment(id) }
  else if (act === 'select-folder') { state.selectedFolder = path; state.selectedNoteId = null; renderTree(); renderFolderMain(path); renderDetail() }
  else if (act === 'toggle-folder') { if (state.collapsed.has(path)) state.collapsed.delete(path); else state.collapsed.add(path); const c = document.querySelector('.tree-children[data-folder="' + CSS.escape(path) + '"]'); if (c) { const hidden = state.collapsed.has(path); c.style.display = hidden ? 'none' : ''; el.textContent = hidden ? '▸' : '▾' } }
  else if (act === 'save-note') saveNote()
  else if (act === 'rename-note') renameNote()
  else if (act === 'move-note') moveNote(id)
  else if (act === 'delete-note') delNote()
  else if (act === 'rename-folder') renameFolder(path)
  else if (act === 'delete-folder') deleteFolder(path)
  else if (act === 'move-up-folder') moveItem(path, 'folder', -1)
  else if (act === 'move-down-folder') moveItem(path, 'folder', 1)
  else if (act === 'sync-note') syncEntity('note', id)
  else if (act === 'sync-now') syncNow()
  else if (act === 'reconcile') reconcile()
  else if (act === 'upload-attachment') uploadAttachment()
  else if (act === 'download-attachment') downloadAttachment(id)
  else if (act === 'delete-attachment') delAttachment(id)
  else if (act === 'go-attachments') setView('attachments')
})

$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { state.view = 'search'; render(); runSearch(e.target.value.trim()) }
})

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.view === 'notes' && state.selectedNoteId !== null) saveNote() }
})

$('#langBtn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pkw-lang', lang); render() })

// Fine-grained status refresh: only badges/header, never the editor.
setInterval(() => { if (state.view === 'notes') { refreshHeader(); renderTree() } }, 5000)

render()
</script>
</body>
</html>`
}
