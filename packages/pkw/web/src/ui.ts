/**
 * PKW Web MVP browser page — a self-contained HTML/JS client served by the Host
 * at `GET /pkw`. It calls only `POST /pkw/api` (the Host bridge); it never
 * touches SQLite, the workspace filesystem, the WeKnora API key, or WeKnora REST.
 *
 * UI strings are localized to Chinese (zh) and English (en) only. The selected
 * language persists in localStorage (`pkw-lang`) and can be toggled in the header.
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
#app{display:grid;grid-template-columns:220px 1fr 280px;grid-template-rows:52px 1fr;height:100vh}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{font-size:15px;margin:0;font-weight:650}
header .spacer{flex:1}
#search{width:340px;padding:7px 10px;border:1px solid var(--border);border-radius:8px}
.badge{padding:2px 9px;border-radius:999px;font-size:12px;background:#eef2f8;color:var(--muted)}
.badge.ok{background:#e8f6ee;color:var(--ok)}.badge.warn{background:#fdf1e3;color:var(--warn)}.badge.err{background:#fdeaea;color:var(--err)}
.langbtn{padding:6px 10px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:12px;color:var(--ink)}
.langbtn:hover{background:#eef2f8}
aside{border-right:1px solid var(--border);background:var(--panel);overflow:auto}
.nav{padding:10px}.nav button{display:block;width:100%;text-align:left;padding:8px 10px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink)}
.nav button.active,.nav button:hover{background:#eef2f8}
#list{overflow:auto;padding:8px 10px}.row{padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.row:hover{background:#f1f4f9}.row.active{background:#e7eefb;border-color:#cdddf7}
.row .t{font-weight:550;font-size:13px}.row .p{font-size:11px;color:var(--muted);word-break:break-all}
main{overflow:auto;padding:18px 22px;background:var(--bg)}
#toolbar{display:flex;align-items:center;gap:10px;margin-bottom:12px}
button.btn{padding:7px 12px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:13px}
button.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.btn.danger{color:var(--err)}
textarea{width:100%;height:52vh;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px;border:1px solid var(--border);border-radius:10px;resize:vertical}
#preview{border:1px solid var(--border);border-radius:10px;padding:12px 16px;background:var(--panel);min-height:20vh}
#preview h1,#preview h2{font-size:1.2em}.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
#status{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);margin-left:8px}
aside.right{border-left:1px solid var(--border);background:var(--panel);padding:14px;overflow:auto}
aside.right h3{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:14px 0 6px}
.kv{font-size:12px;margin:3px 0}.kv b{color:var(--muted);font-weight:500}
.hit{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--panel)}
.hit .t{font-weight:600}.hit .snippet{font-size:12px;color:var(--muted);margin:4px 0}
.hit .ref{font-size:12px}.hit button{font-size:12px;padding:3px 8px;border:1px solid var(--border);border-radius:6px;background:#fff;cursor:pointer}
.hidden{display:none}
.empty{color:var(--muted);padding:20px;text-align:center}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>PKW</h1>
    <span class="badge" id="wsName">Personal Knowledge Workspace</span>
    <input id="search" placeholder="搜索知识库 (hybrid search)…" />
    <span class="spacer"></span>
    <span class="badge" id="integBadge">WeKnora: …</span>
    <span class="badge" id="localBadge">Local: …</span>
    <button id="langBtn" class="langbtn" title="Switch language / 切换语言">EN</button>
  </header>
  <aside>
    <div class="nav">
      <button data-view="notes" class="active">Notes</button>
      <button data-view="attachments">Attachments</button>
      <button data-view="search">Search</button>
    </div>
    <div id="list"></div>
  </aside>
  <main id="main"></main>
  <aside class="right" id="detail"></aside>
</div>
<script>
const STR = {
  zh: {
    searchPlaceholder: '搜索知识库 (hybrid search)…',
    workspaceLabel: '工作区',
    localSummary: '本地: {n} 笔记 · {m} 文件',
    weknoraConnected: 'WeKnora: 已连接',
    weknoraUnavailable: 'WeKnora: 不可用',
    weknoraNotConfigured: 'WeKnora: 未配置',
    weknoraError: 'WeKnora: 错误',
    notes: '笔记',
    attachments: '附件',
    search: '搜索',
    loading: '加载中…',
    emptyDetail: '选中一项查看详情',
    emptyNotes: '还没有笔记。点击「新建 Note」开始。',
    deletedSuffix: '已删除',
    save: '保存',
    rename: '重命名 / 移动',
    del: '删除',
    localSaved: '本地已保存',
    localSavedR: '本地已保存 · r{r}',
    syncState: '同步: {s}',
    parseStatus: '解析: {s}',
    syncPending: '同步: 待处理',
    preview: '预览',
    note: '笔记',
    noteId: 'NoteId',
    path: '路径',
    revision: '版本',
    weknoraSync: 'WeKnora 同步',
    knowledgeId: 'KnowledgeId',
    kb: 'KB',
    state: '状态',
    parse: '解析',
    updated: '更新时间',
    notSynced: '尚未同步到 WeKnora。',
    maintenance: '维护',
    reconcile: '重建索引',
    newNote: '新建笔记',
    emptyPreview: '（空）',
    newNotePrompt: '相对路径（如 notes/foo.md）',
    renamePrompt: '新相对路径',
    delNoteConfirm: '删除这篇笔记？',
    deletedMsg: '已删除',
    emptyAttachments: '还没有附件。',
    attachmentsDesc: '上传文件 → PKW Attachment Core（workspace binary 事实源）→ 异步 WeKnora Sync。',
    upload: '上传',
    attachmentDetailHint: '选中附件查看详情。',
    attachment: '附件',
    attachmentId: 'AttachmentId',
    delAttachmentConfirm: '删除该附件？',
    searching: '搜索中…',
    noHits: '没有命中「{q}」。',
    score: '得分',
    externalWeKnora: 'WeKnora 外部',
    openNote: '打开笔记',
    searchViewHint: '在顶部搜索框输入查询。',
    reconcileDone: '重建完成: markedDirty={d}, markedDeleted={x}',
  },
  en: {
    searchPlaceholder: 'Search knowledge base (hybrid search)…',
    workspaceLabel: 'Workspace',
    localSummary: 'Local: {n} notes · {m} files',
    weknoraConnected: 'WeKnora: Connected',
    weknoraUnavailable: 'WeKnora: Unavailable',
    weknoraNotConfigured: 'WeKnora: Not configured',
    weknoraError: 'WeKnora: error',
    notes: 'Notes',
    attachments: 'Attachments',
    search: 'Search',
    loading: 'Loading…',
    emptyDetail: 'Select an item to view details',
    emptyNotes: 'No notes yet. Click 「New Note」 to start.',
    deletedSuffix: 'deleted',
    save: 'Save',
    rename: 'Rename / Move',
    del: 'Delete',
    localSaved: 'Local Saved',
    localSavedR: 'Local Saved · r{r}',
    syncState: 'Sync: {s}',
    parseStatus: 'Parse: {s}',
    syncPending: 'Sync: pending',
    preview: 'Preview',
    note: 'Note',
    noteId: 'NoteId',
    path: 'Path',
    revision: 'Revision',
    weknoraSync: 'WeKnora Sync',
    knowledgeId: 'KnowledgeId',
    kb: 'KB',
    state: 'State',
    parse: 'Parse',
    updated: 'Updated',
    notSynced: 'Not synced to WeKnora yet.',
    maintenance: 'Maintenance',
    reconcile: 'Reconcile',
    newNote: 'New note',
    emptyPreview: '(empty)',
    newNotePrompt: 'Relative path (e.g. notes/foo.md)',
    renamePrompt: 'New relative path',
    delNoteConfirm: 'Delete this note?',
    deletedMsg: 'Deleted',
    emptyAttachments: 'No attachments yet.',
    attachmentsDesc: 'Upload a file → PKW Attachment Core (workspace binary source of truth) → async WeKnora Sync.',
    upload: 'Upload',
    attachmentDetailHint: 'Select an attachment to view details.',
    attachment: 'Attachment',
    attachmentId: 'AttachmentId',
    delAttachmentConfirm: 'Delete this attachment?',
    searching: 'Searching…',
    noHits: 'No hits for 「{q}」.',
    score: 'score',
    externalWeKnora: 'external WeKnora',
    openNote: 'Open Note',
    searchViewHint: 'Type a query in the top search box.',
    reconcileDone: 'Reconcile done: markedDirty={d}, markedDeleted={x}',
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
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'rpc error')
  return data.value
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let view = 'notes', selectedNoteId = null

function applyLang(){
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  $('#search').placeholder = t('searchPlaceholder')
  $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'
  document.querySelector('[data-view="notes"]').textContent = t('notes')
  document.querySelector('[data-view="attachments"]').textContent = t('attachments')
  document.querySelector('[data-view="search"]').textContent = t('search')
}

function rerender(){
  refreshSummary()
  if (view === 'notes') { if (selectedNoteId) openNote(selectedNoteId); else renderNotes() }
  else if (view === 'attachments') renderAttachments()
  else renderSearchView()
}

function setDetail(html){ $('#detail').innerHTML = html || '<div class="empty">' + esc(t('emptyDetail')) + '</div>' }

async function refreshSummary(){
  try {
    const s = await api('summary')
    $('#wsName').textContent = t('workspaceLabel') + ' ' + s.workspaceId.slice(0,8)
    $('#localBadge').textContent = t('localSummary', { n: s.notes, m: s.attachments })
    $('#localBadge').className = 'badge ok'
    const integ = s.integration === 'ready'
    $('#integBadge').textContent = integ ? t('weknoraConnected') : (s.credential === 'configured' ? t('weknoraUnavailable') : t('weknoraNotConfigured'))
    $('#integBadge').className = 'badge ' + (integ ? 'ok' : 'warn')
  } catch(e){ $('#integBadge').textContent = t('weknoraError'); $('#integBadge').className = 'badge err' }
}

async function renderNotes(){
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  const notes = await api('listNotes')
  $('#list').innerHTML = notes.length ? notes.map(n =>
    '<div class="row ' + (n.noteId===selectedNoteId?'active':'') + '" data-id="' + esc(n.noteId) + '">' +
      '<div class="t">' + esc(n.title || n.relativePath) + '</div>' +
      '<div class="p">' + esc(n.relativePath) + ' · r' + n.observedRevision + (n.deleted?' · ' + esc(t('deletedSuffix')):'') + '</div></div>'
  ).join('') : '<div class="empty">' + esc(t('emptyNotes')) + '</div>'
  $('#list').querySelectorAll('.row').forEach(el => el.onclick = () => openNote(el.dataset.id))
}

async function openNote(noteId){
  selectedNoteId = noteId
  await renderNotes()
  const d = await api('getNote', { noteId })
  const sync = d.sync
  $('#main').innerHTML =
    '<div id="toolbar">' +
      '<button class="btn primary" onclick="saveNote()">' + esc(t('save')) + '</button>' +
      '<button class="btn" onclick="renameNote()">' + esc(t('rename')) + '</button>' +
      '<button class="btn danger" onclick="delNote()">' + esc(t('del')) + '</button>' +
      '<span id="status">' + esc(t('localSaved')) + '</span>' +
      (sync ? '<span class="badge ' + (sync.syncState==='synced'?'ok':'warn') + '">' + esc(t('syncState', { s: sync.syncState })) + '</span>'
             + (sync.remoteParseStatus ? '<span class="badge">' + esc(t('parseStatus', { s: sync.remoteParseStatus })) + '</span>' : '') : '<span class="badge">' + esc(t('syncPending')) + '</span>') +
    '</div>' +
    '<h2>' + esc(d.note.title) + '</h2>' +
    '<textarea id="editor">' + esc(d.markdown) + '</textarea>' +
    '<h3>' + esc(t('preview')) + '</h3><div id="preview"></div>'
  renderPreview()
  setDetail(
    '<h3>' + esc(t('note')) + '</h3>' +
    '<div class="kv"><b>' + esc(t('noteId')) + '</b> <span class="mono">' + esc(d.note.noteId) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('path')) + '</b> <span class="mono">' + esc(d.note.relativePath) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('revision')) + '</b> ' + d.note.observedRevision + '</div>' +
    '<h3>' + esc(t('weknoraSync')) + '</h3>' +
    (sync ? '<div class="kv"><b>' + esc(t('knowledgeId')) + '</b> <span class="mono">' + esc(sync.knowledgeId) + '</span></div>' +
            '<div class="kv"><b>' + esc(t('kb')) + '</b> <span class="mono">' + esc(sync.kbId.slice(0,12)) + '…</span></div>' +
            '<div class="kv"><b>' + esc(t('state')) + '</b> ' + esc(sync.syncState) + '</div>' +
            '<div class="kv"><b>' + esc(t('parse')) + '</b> ' + esc(sync.remoteParseStatus || '—') + '</div>' +
            '<div class="kv"><b>' + esc(t('updated')) + '</b> ' + esc(sync.updatedAt) + '</div>'
          : '<div class="kv muted">' + esc(t('notSynced')) + '</div>') +
    '<h3>' + esc(t('maintenance')) + '</h3>' +
    '<button class="btn" onclick="reconcile()">' + esc(t('reconcile')) + '</button>'
  )
}

function renderPreview(){
  const md = $('#editor').value || ''
  // Minimal markdown-ish preview (headings, bold, code fences) — best-effort.
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
  const d = await api('saveNote', { noteId: selectedNoteId, markdown: $('#editor').value })
  $('#status').textContent = t('localSavedR', { r: d.observedRevision })
  await renderNotes(); await refreshSummary()
}

async function newNote(){
  const rel = prompt(t('newNotePrompt'), 'untitled.md')
  if(!rel) return
  const r = await api('createNote', { relativePath: rel, markdown: '---\\nid: __placeholder__\\n---\\n\\n# ' + t('newNote') + '\\n' })
  await renderNotes(); await openNote(r.noteId)
}

async function renameNote(){
  const rel = prompt(t('renamePrompt'), '')
  if(!rel) return
  await api('moveNote', { noteId: selectedNoteId, relativePath: rel })
  await renderNotes(); await openNote(selectedNoteId)
}

async function delNote(){
  if(!confirm(t('delNoteConfirm'))) return
  await api('deleteNote', { noteId: selectedNoteId })
  selectedNoteId = null
  await renderNotes(); $('#main').innerHTML = '<div class="empty">' + esc(t('deletedMsg')) + '</div>'; setDetail('')
}

async function renderAttachments(){
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  const list = await api('listAttachments')
  $('#list').innerHTML = list.length ? list.map(a =>
    '<div class="row" data-id="' + esc(a.attachmentId) + '"><div class="t">' + esc(a.filename) + '</div>' +
    '<div class="p">' + a.sizeBytes + ' bytes · r' + a.observedRevision + (a.deleted?' · ' + esc(t('deletedSuffix')):'') + '</div></div>'
  ).join('') : '<div class="empty">' + esc(t('emptyAttachments')) + '</div>'
  $('#list').querySelectorAll('.row').forEach(el => el.onclick = () => openAttachment(el.dataset.id))
  $('#main').innerHTML =
    '<h2>' + esc(t('attachments')) + '</h2>' +
    '<p class="muted">' + esc(t('attachmentsDesc')) + '</p>' +
    '<input type="file" id="file" /> <button class="btn primary" onclick="uploadFile()">' + esc(t('upload')) + '</button>'
  setDetail('<h3>' + esc(t('attachments')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>')
}

function openAttachment(id){
  setDetail('<h3>' + esc(t('attachment')) + '</h3><div class="kv"><b>' + esc(t('attachmentId')) + '</b> <span class="mono">' + esc(id) + '</span></div>' +
    '<h3>' + esc(t('maintenance')) + '</h3><button class="btn danger" onclick="delAttachment(\\'' + esc(id) + '\\')">' + esc(t('del')) + '</button>')
}

async function uploadFile(){
  const file = $('#file').files[0]
  if(!file) return
  const buf = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for(let i=0;i<buf.length;i++) binary += String.fromCharCode(buf[i])
  const base64 = btoa(binary)
  await api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64 })
  await renderAttachments(); await refreshSummary()
}

async function delAttachment(id){ if(confirm(t('delAttachmentConfirm'))){ await api('deleteAttachment', { attachmentId: id }); await renderAttachments(); setDetail('') } }

async function renderSearch(q){
  $('#list').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
  const results = await api('search', { query: q, limit: 10 })
  if(!results.length){ $('#main').innerHTML = '<div class="empty">' + t('noHits', { q: esc(q) }) + '</div>'; return }
  $('#main').innerHTML = results.map(r =>
    '<div class="hit"><div class="t">' + esc(r.remote.title || r.remote.filename || r.remote.knowledgeId) + '</div>' +
    '<div class="snippet">' + esc((r.remote.content||'').slice(0,220)) + '</div>' +
    '<div class="ref">' + esc(t('score')) + ' ' + r.remote.score.toFixed(3) + ' · ' + esc(t('kb')) + ' ' + esc(r.remote.kbId.slice(0,8)) + '…' +
    (r.local ? ' · <span class="mono">' + esc(r.local.entityType) + ':' + esc(r.local.entityId) + '</span>'
             : ' · <span class="muted">' + esc(t('externalWeKnora')) + '</span>') +
    (r.local && r.local.entityType === 'note' ? ' <button onclick="openNote(\\'' + esc(r.local.entityId) + '\\')">' + esc(t('openNote')) + '</button>' : '') +
    '</div></div>'
  ).join('')
}

function renderSearchView(){
  $('#main').innerHTML = '<h2>' + esc(t('search')) + '</h2><p class="muted">' + esc(t('searchViewHint')) + '</p>'
  $('#list').innerHTML = ''
}

async function reconcile(){ const r = await api('reconcile'); alert(t('reconcileDone', { d: r.markedDirty, x: r.markedDeleted })); await refreshSummary() }

$('#langBtn').onclick = () => {
  lang = lang === 'zh' ? 'en' : 'zh'
  localStorage.setItem('pkw-lang', lang)
  applyLang()
  rerender()
}

document.querySelectorAll('.nav button').forEach(b => b.onclick = async () => {
  document.querySelectorAll('.nav button').forEach(x => x.classList.remove('active'))
  b.classList.add('active'); view = b.dataset.view
  if(view === 'notes') await renderNotes()
  else if(view === 'attachments') await renderAttachments()
  else renderSearchView()
})
$('#search').addEventListener('keydown', async (e) => { if(e.key === 'Enter' && e.target.value.trim()){ await renderSearch(e.target.value.trim()) } })
$('#editor')?.addEventListener('input', renderPreview)

// boot
applyLang()
refreshSummary()
renderNotes()
</script>
</body>
</html>`
}
