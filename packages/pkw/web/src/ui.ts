/**
 * PKW Web MVP browser page — a self-contained HTML/JS client served by the Host
 * at `GET /pkw`. It calls only `POST /pkw/api` (the Host bridge); it never
 * touches SQLite, the workspace filesystem, the WeKnora API key, or WeKnora REST.
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
const api = async (method, args = {}) => {
  const res = await fetch('/pkw/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ method, args }) })
  const data = await res.json()
  if (!data.ok) throw new Error(data.error || 'rpc error')
  return data.value
}
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))
let view = 'notes', selectedNoteId = null

function setDetail(html){ $('#detail').innerHTML = html || '<div class="empty">选中一项查看详情</div>' }

async function refreshSummary(){
  try {
    const s = await api('summary')
    $('#wsName').textContent = 'Workspace ' + s.workspaceId.slice(0,8)
    $('#localBadge').textContent = 'Local: ' + s.notes + ' notes · ' + s.attachments + ' files'
    $('#localBadge').className = 'badge ok'
    const integ = s.integration === 'ready'
    $('#integBadge').textContent = integ ? 'WeKnora: Connected' : 'WeKnora: ' + (s.credential === 'configured' ? 'Unavailable' : 'Not configured')
    $('#integBadge').className = 'badge ' + (integ ? 'ok' : 'warn')
  } catch(e){ $('#integBadge').textContent = 'WeKnora: error'; $('#integBadge').className = 'badge err' }
}

async function renderNotes(){
  $('#list').innerHTML = '<div class="empty">加载中…</div>'
  const notes = await api('listNotes')
  $('#list').innerHTML = notes.length ? notes.map(n =>
    '<div class="row ' + (n.noteId===selectedNoteId?'active':'') + '" data-id="' + esc(n.noteId) + '">' +
      '<div class="t">' + esc(n.title || n.relativePath) + '</div>' +
      '<div class="p">' + esc(n.relativePath) + ' · r' + n.observedRevision + (n.deleted?' · deleted':'') + '</div></div>'
  ).join('') : '<div class="empty">还没有笔记。点击「新建 Note」开始。</div>'
  $('#list').querySelectorAll('.row').forEach(el => el.onclick = () => openNote(el.dataset.id))
}

async function openNote(noteId){
  selectedNoteId = noteId
  await renderNotes()
  const d = await api('getNote', { noteId })
  const sync = d.sync
  $('#main').innerHTML =
    '<div id="toolbar">' +
      '<button class="btn primary" onclick="saveNote()">Save</button>' +
      '<button class="btn" onclick="renameNote()">Rename / Move</button>' +
      '<button class="btn danger" onclick="delNote()">Delete</button>' +
      '<span id="status">Local Saved</span>' +
      (sync ? '<span class="badge ' + (sync.syncState==='synced'?'ok':'warn') + '">Sync: ' + esc(sync.syncState) + '</span>'
             + (sync.remoteParseStatus ? '<span class="badge">Parse: ' + esc(sync.remoteParseStatus) + '</span>' : '') : '<span class="badge">Sync: pending</span>') +
    '</div>' +
    '<h2>' + esc(d.note.title) + '</h2>' +
    '<textarea id="editor">' + esc(d.markdown) + '</textarea>' +
    '<h3>Preview</h3><div id="preview"></div>'
  renderPreview()
  setDetail(
    '<h3>Note</h3>' +
    '<div class="kv"><b>NoteId</b> <span class="mono">' + esc(d.note.noteId) + '</span></div>' +
    '<div class="kv"><b>Path</b> <span class="mono">' + esc(d.note.relativePath) + '</span></div>' +
    '<div class="kv"><b>Revision</b> ' + d.note.observedRevision + '</div>' +
    '<h3>WeKnora Sync</h3>' +
    (sync ? '<div class="kv"><b>KnowledgeId</b> <span class="mono">' + esc(sync.knowledgeId) + '</span></div>' +
            '<div class="kv"><b>KB</b> <span class="mono">' + esc(sync.kbId.slice(0,12)) + '…</span></div>' +
            '<div class="kv"><b>State</b> ' + esc(sync.syncState) + '</div>' +
            '<div class="kv"><b>Parse</b> ' + esc(sync.remoteParseStatus || '—') + '</div>' +
            '<div class="kv"><b>Updated</b> ' + esc(sync.updatedAt) + '</div>'
          : '<div class="kv muted">尚未同步到 WeKnora。</div>') +
    '<h3>Maintenance</h3>' +
    '<button class="btn" onclick="reconcile()">Reconcile</button>'
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
  $('#preview').innerHTML = html || '<span class="muted">（空）</span>'
}

async function saveNote(){
  const d = await api('saveNote', { noteId: selectedNoteId, markdown: $('#editor').value })
  $('#status').textContent = 'Local Saved · r' + d.observedRevision
  await renderNotes(); await refreshSummary()
}

async function newNote(){
  const rel = prompt('相对路径（如 notes/foo.md）', 'untitled.md')
  if(!rel) return
  const r = await api('createNote', { relativePath: rel, markdown: '---\\nid: __placeholder__\\n---\\n\\n# New note\\n' })
  await renderNotes(); await openNote(r.noteId)
}

async function renameNote(){
  const rel = prompt('新相对路径', '')
  if(!rel) return
  await api('moveNote', { noteId: selectedNoteId, relativePath: rel })
  await renderNotes(); await openNote(selectedNoteId)
}

async function delNote(){
  if(!confirm('删除这篇笔记？')) return
  await api('deleteNote', { noteId: selectedNoteId })
  selectedNoteId = null
  await renderNotes(); $('#main').innerHTML = '<div class="empty">已删除</div>'; setDetail('')
}

async function renderAttachments(){
  $('#list').innerHTML = '<div class="empty">加载中…</div>'
  const list = await api('listAttachments')
  $('#list').innerHTML = list.length ? list.map(a =>
    '<div class="row" data-id="' + esc(a.attachmentId) + '"><div class="t">' + esc(a.filename) + '</div>' +
    '<div class="p">' + a.sizeBytes + ' bytes · r' + a.observedRevision + (a.deleted?' · deleted':'') + '</div></div>'
  ).join('') : '<div class="empty">还没有附件。</div>'
  $('#list').querySelectorAll('.row').forEach(el => el.onclick = () => openAttachment(el.dataset.id))
  $('#main').innerHTML =
    '<h2>Attachments</h2>' +
    '<p class="muted">上传文件 → PKW Attachment Core（workspace binary 事实源）→ 异步 WeKnora Sync。</p>' +
    '<input type="file" id="file" /> <button class="btn primary" onclick="uploadFile()">Upload</button>'
  setDetail('<h3>Attachments</h3><div class="kv muted">选中附件查看详情。</div>')
}

function openAttachment(id){
  setDetail('<h3>Attachment</h3><div class="kv"><b>AttachmentId</b> <span class="mono">' + esc(id) + '</span></div>' +
    '<h3>Maintenance</h3><button class="btn danger" onclick="delAttachment(\\'' + esc(id) + '\\')">Delete</button>')
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

async function delAttachment(id){ if(confirm('删除该附件？')){ await api('deleteAttachment', { attachmentId: id }); await renderAttachments(); setDetail('') } }

async function renderSearch(q){
  $('#list').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">搜索中…</div>'
  const results = await api('search', { query: q, limit: 10 })
  if(!results.length){ $('#main').innerHTML = '<div class="empty">没有命中「' + esc(q) + '」。</div>'; return }
  $('#main').innerHTML = results.map(r =>
    '<div class="hit"><div class="t">' + esc(r.remote.title || r.remote.filename || r.remote.knowledgeId) + '</div>' +
    '<div class="snippet">' + esc((r.remote.content||'').slice(0,220)) + '</div>' +
    '<div class="ref">score ' + r.remote.score.toFixed(3) + ' · KB ' + esc(r.remote.kbId.slice(0,8)) + '…' +
    (r.local ? ' · <span class="mono">' + esc(r.local.entityType) + ':' + esc(r.local.entityId) + '</span>'
             : ' · <span class="muted">external WeKnora</span>') +
    (r.local && r.local.entityType === 'note' ? ' <button onclick="openNote(\\'' + esc(r.local.entityId) + '\\')">Open Note</button>' : '') +
    '</div></div>'
  ).join('')
}

async function reconcile(){ const r = await api('reconcile'); alert('Reconcile done: markedDirty=' + r.markedDirty + ', markedDeleted=' + r.markedDeleted); await refreshSummary() }

document.querySelectorAll('.nav button').forEach(b => b.onclick = async () => {
  document.querySelectorAll('.nav button').forEach(x => x.classList.remove('active'))
  b.classList.add('active'); view = b.dataset.view
  if(view === 'notes') await renderNotes()
  else if(view === 'attachments') await renderAttachments()
  else { $('#main').innerHTML = '<h2>Search</h2><p class="muted">在顶部搜索框输入查询。</p>'; $('#list').innerHTML = '' }
})
$('#search').addEventListener('keydown', async (e) => { if(e.key === 'Enter' && e.target.value.trim()){ await renderSearch(e.target.value.trim()) } })
$('#editor')?.addEventListener('input', renderPreview)

// boot
refreshSummary()
renderNotes()
</script>
</body>
</html>`
}
