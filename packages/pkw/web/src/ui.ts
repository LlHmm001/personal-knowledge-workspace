/**
 * PKW Web browser page — a self-contained HTML/JS client served by the Host at
 * `GET /pkw`. Talks only to `POST /pkw/api` (the Host bridge); never touches
 * SQLite, the workspace filesystem, the WeKnora API key, or WeKnora REST.
 *
 * Notes editor: three modes (Live Preview / Source / Reading), system frontmatter
 * hidden from the rendered body, change-driven local mutations, and adaptive
 * remote-sync polling that never rebuilds the editor or the folder tree.
 */

export function renderPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>PKW — Personal Knowledge Workspace</title>
<link rel="stylesheet" href="/pkw/assets/vditor/index.css" />
<script src="/pkw/assets/vditor/js/lute/lute.min.js"></script>
<script src="/pkw/assets/vditor/index.min.js"></script>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--border:#e3e6ea;--ink:#1c2330;--muted:#6b7280;--accent:#2f6fed;--ok:#178a4f;--warn:#b45309;--err:#b91c1c}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
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
.tree-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;cursor:pointer;border:1px solid transparent;font-size:13px}
.tree-row:hover{background:#f1f4f9}.tree-row.active{background:#e7eefb;border-color:#cdddf7}
.tree-row .tw{width:16px;text-align:center;color:var(--muted);flex:0 0 auto;font-size:11px}
.tree-row .ic{flex:0 0 auto;font-size:12px}
.tree-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.tree-row .badge{margin-left:2px}
.tree-row.note .nm{font-weight:500}
.tree-children{margin-left:14px;border-left:1px solid var(--border);padding-left:4px}
main{overflow:auto;padding:20px 24px;background:var(--bg)}
main h2{margin:0 0 12px;font-size:18px;font-weight:650}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
button.btn{padding:7px 12px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:13px}
button.btn:hover{border-color:#c6ccd4}
button.btn.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
button.btn.danger{color:var(--err)}
button.btn:disabled{opacity:.5;cursor:default}
button.btn.small{padding:4px 8px;font-size:12px}
button.btn.mode{padding:4px 10px;font-size:12px}
button.btn.mode.active{background:var(--accent);color:#fff;border-color:var(--accent)}
select.sel{padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:13px;background:var(--panel)}
.editor-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--border)}
.editor-head .title{font-weight:600;font-size:15px}
.editor-head .path{font-size:12px;color:var(--muted);font-family:ui-monospace,Menlo,Consolas,monospace}
#saveStatus{font-size:12px;color:var(--muted);display:inline-flex;align-items:center;gap:4px}
#saveStatus.dirty{color:var(--warn);font-weight:600}#saveStatus.saving{color:var(--accent)}#saveStatus.saved{color:var(--ok)}
#editorPane{border:1px solid var(--border);border-radius:10px;background:var(--panel);overflow:hidden}
textarea#editor{width:100%;height:56vh;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:14px 16px;border:0;resize:vertical;outline:none;display:block;background:#fff}
#preview{padding:14px 18px;min-height:56vh;background:#fff;overflow:auto}
#preview h1{font-size:1.6em;margin:.4em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.15em}
#preview h2{font-size:1.35em;margin:.5em 0 .25em}#preview h3{font-size:1.15em}#preview h4,#preview h5,#preview h6{font-size:1em}
#preview p{margin:.5em 0}#preview ul,#preview ol{margin:.4em 0;padding-left:1.6em}
#preview blockquote{margin:.5em 0;padding:.2em 1em;border-left:3px solid var(--accent);background:#f5f8fd;color:#33415c}
#preview code{font-family:ui-monospace,Menlo,Consolas,monospace;background:#eef1f5;padding:.1em .35em;border-radius:4px;font-size:.9em}
#preview pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;overflow:auto}
#preview pre code{background:none;color:inherit;padding:0}
#preview table{border-collapse:collapse;margin:.6em 0}#preview th,#preview td{border:1px solid var(--border);padding:5px 10px;text-align:left}
#preview a{color:var(--accent);text-decoration:none}#preview a:hover{text-decoration:underline}
#preview a.wikilink{color:var(--accent);cursor:pointer;border-bottom:1px dotted var(--accent)}
#preview img{max-width:100%;border-radius:8px}
#preview hr{border:0;border-top:1px solid var(--border);margin:1em 0}
#preview .task{list-style:none;margin-left:-1.4em}#preview .task input{margin-right:6px}
#preview .callout{border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:8px 12px;margin:.6em 0;background:#f8fafd}
#preview .callout .co-title{font-weight:650;text-transform:uppercase;font-size:.8em;letter-spacing:.04em;color:var(--accent)}
.muted{color:var(--muted)}.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
aside.right{border-left:1px solid var(--border);background:var(--panel);padding:14px;overflow:auto}
aside.right h3{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:16px 0 6px}
aside.right h3:first-child{margin-top:0}
.kv{font-size:12px;margin:3px 0}.kv b{color:var(--muted);font-weight:500;display:inline-block;min-width:88px}.kv .v{word-break:break-all}
.outline a{display:block;color:var(--ink);text-decoration:none;font-size:12.5px;padding:2px 0 2px 8px;border-left:2px solid transparent}
.outline a:hover{color:var(--accent)}.outline a.lv2{padding-left:20px}.outline a.lv3{padding-left:32px}
.hit{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:10px;background:var(--panel)}
.hit .t{font-weight:600}.hit .snippet{font-size:12px;color:var(--muted);margin:4px 0}
.empty{color:var(--muted);padding:28px;text-align:center}.empty .cta{margin-top:10px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel)}.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:12px;color:var(--muted)}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:60;display:none}
.toast{padding:9px 16px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.15)}
.toast.ok{background:var(--ok)}.toast.err{background:var(--err)}.toast.warn{background:var(--warn)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:70;display:flex;align-items:center;justify-content:center}
.modal{background:var(--panel);border-radius:12px;padding:18px;min-width:320px;max-width:520px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.modal h3{margin:0 0 12px;font-size:15px}.modal input,.modal select{width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:13px;margin-bottom:10px}
.modal .modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal .form{margin-bottom:10px}.modal .form label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
.quad-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.quad{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;min-height:140px}
.quad-head{display:flex;align-items:center;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:6px;font-size:13px}
.quad-head .count{margin-left:auto;font-size:12px;color:var(--muted)}
.quad .empty.small{padding:8px;font-size:12px}
.task-src{margin-left:6px;cursor:pointer;opacity:.65}.task-src:hover{opacity:1}
mark{background:#ffe9a8;border-radius:2px;padding:0 2px}
@media (max-width:760px){.quad-grid{grid-template-columns:1fr}}
.wikilink-suggest{position:absolute;z-index:80;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);max-height:240px;overflow:auto;min-width:240px}
.wikilink-suggest .item{padding:7px 12px;cursor:pointer;font-size:13px}.wikilink-suggest .item:hover,.wikilink-suggest .item.sel{background:#eef2f8}
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
      <button data-view="tasks">待办</button>
      <button data-view="trash">回收站</button>
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
    overview:'总览', notes:'笔记', attachments:'附件', tasks:'待办', trash:'回收站', search:'搜索',
    searchPlaceholder:'搜索知识库 (hybrid search)…', workspaceLabel:'工作区', localSummary:'本地: {n} 笔记 · {m} 文件',
    connected:'已连接', unavailable:'不可用', notConfigured:'未配置', error:'错误',
    overviewTitle:'工作区概览', overviewNotes:'笔记', overviewAttachments:'附件', overviewMappings:'已同步对象', overviewPendingSync:'待同步', overviewSyncErrors:'同步错误',
    overviewIntegration:'WeKnora 集成', overviewRecent:'最近更新', overviewEmpty:'工作区为空。点击「新建笔记」开始。', recentNote:'笔记', recentAttachment:'附件', noRecent:'暂无最近更新',
    newNote:'新建笔记', newFolder:'新建文件夹', emptyNotes:'还没有笔记。', emptyNotesCta:'新建第一篇笔记', loading:'加载中…', deletedSuffix:'已删除',
    save:'保存', renameMove:'重命名 / 移动', del:'删除', syncNow:'立即同步', reconcile:'重建索引', localSaved:'本地已保存', localSavedR:'本地已保存 · r{r}', saving:'保存中…',
    unsaved:'未保存', saved:'已保存', saveFailed:'保存失败',
    preview:'预览', newNotePrompt:'笔记标题（路径自动生成）', renamePrompt:'新相对路径', delNoteConfirm:'删除这篇笔记？', deletedMsg:'已删除', selectNote:'从左侧选择或新建一篇笔记。',
    untitled:'untitled', notSynced:'未同步', synced:'已同步', syncing:'同步中', pending:'待同步', failed:'失败', stale:'已过期', deleted:'已删除',
    upload:'上传文件', emptyAttachments:'还没有附件。', attachmentsDesc:'上传 → 本地保存 → 异步同步到 WeKnora。', size:'大小', download:'下载', delAttachmentConfirm:'删除该附件？', attachmentDetailHint:'选中附件查看详情。',
    uploadProgress:'上传中…', uploadSuccess:'已上传', uploadFailed:'上传失败', searching:'搜索中…', noHits:'没有命中「{q}」。', searchHint:'输入关键词搜索本地笔记与附件（经 WeKnora hybrid search）。',
    score:'得分', openNote:'打开笔记', openAttachment:'打开附件', externalWeKnora:'WeKnora 外部', noteLabel:'笔记', attachmentLabel:'附件',
    details:'详情', noteId:'NoteId', attachmentId:'AttachmentId', path:'路径', revision:'版本', updated:'更新时间', lastError:'最近错误', maintenance:'维护', advanced:'高级',
    workspaceSummary:'工作区摘要', kb:'知识库', state:'状态', parse:'解析', syncSection:'WeKnora 同步', noSyncInfo:'尚未同步。',
    reconcileDone:'重建完成', reconcileResult:'笔记修复 {a} · 附件修复 {b} · 待同步 {c} · 已删 {d}', syncingAll:'正在同步…', genericError:'操作失败', ok:'完成', emptyPreview:'（空）', searchFailed:'搜索失败',
    folder:'文件夹', rootFolder:'（根目录）', newNoteHere:'在此新建笔记', newSubfolder:'新建子文件夹', renameFolder:'重命名', moveTo:'移动到…', deleteFolder:'删除文件夹',
    folderRenamePrompt:'新文件夹名称', folderDeleteConfirm:'删除文件夹「{n}」？', folderNotEmpty:'文件夹不为空，无法删除。', moveNoteTo:'移动笔记到', moveUp:'上移', moveDown:'下移',
    sortMode:'排序', sortManual:'手动', sortTitle:'标题', sortUpdated:'更新时间', cancel:'取消', createFolderPrompt:'文件夹名称', folderCreated:'文件夹已创建', selectFolder:'选择一个文件夹。',
    modeLive:'实时预览', modeSource:'源码', modeReading:'阅读',
    properties:'属性', tags:'标签', title:'标题', outline:'大纲', backlinks:'反向链接', noOutline:'暂无标题', noBacklinks:'暂无反向链接',
    wikiPlaceholder:'输入 [[ 引用其他笔记', autosaveFailed:'自动保存失败', externalModified:'文件已在外部修改。选择「重载」使用磁盘版本，或「保留我的」继续编辑。', reload:'重载', keepMine:'保留我的',
    quickSwitch:'快速切换笔记', typeToSearch:'输入标题或路径…',
    taskAll:'全部任务', taskToday:'今日', taskUpcoming:'即将到来', taskCompleted:'已完成', taskInbox:'收件箱（未分类）',
    q1:'重要且紧急', q2:'重要不紧急', q3:'紧急不重要', q4:'不紧急不重要',
    taskQuickAdd:'快速添加任务', taskTitle:'标题', taskMatrix:'矩阵', taskQuadrant:'象限', taskPriority:'优先级', taskDue:'截止日期', taskSave:'创建', taskCancel:'取消',
    noteToTask:'笔记 → 待办', selectionToTask:'选区 → 待办', taskNoTasks:'暂无任务。', taskTomorrow:'明天', taskYesterday:'昨天', taskOverdue:'已逾期',
  },
  en: {
    overview:'Overview', notes:'Notes', attachments:'Attachments', tasks:'Tasks', trash:'Trash', search:'Search',
    searchPlaceholder:'Search knowledge base (hybrid search)…', workspaceLabel:'Workspace', localSummary:'Local: {n} notes · {m} files',
    connected:'Connected', unavailable:'Unavailable', notConfigured:'Not configured', error:'error',
    overviewTitle:'Workspace Overview', overviewNotes:'Notes', overviewAttachments:'Attachments', overviewMappings:'Synced objects', overviewPendingSync:'Pending sync', overviewSyncErrors:'Sync errors',
    overviewIntegration:'WeKnora integration', overviewRecent:'Recent', overviewEmpty:'Workspace is empty. Click 「New Note」 to start.', recentNote:'Note', recentAttachment:'Attachment', noRecent:'No recent changes',
    newNote:'New Note', newFolder:'New Folder', emptyNotes:'No notes yet.', emptyNotesCta:'Create your first note', loading:'Loading…', deletedSuffix:'deleted',
    save:'Save', renameMove:'Rename / Move', del:'Delete', syncNow:'Sync now', reconcile:'Reconcile', localSaved:'Local saved', localSavedR:'Local saved · r{r}', saving:'Saving…',
    unsaved:'Unsaved', saved:'Saved', saveFailed:'Save failed',
    preview:'Preview', newNotePrompt:'Note title (path is auto-generated)', renamePrompt:'New relative path', delNoteConfirm:'Delete this note?', deletedMsg:'Deleted', selectNote:'Select or create a note from the left.',
    untitled:'untitled', notSynced:'Not synced', synced:'Synced', syncing:'Syncing', pending:'Pending', failed:'Failed', stale:'Stale', deleted:'Deleted',
    upload:'Upload file', emptyAttachments:'No attachments yet.', attachmentsDesc:'Upload → local save → async WeKnora sync.', size:'Size', download:'Download', delAttachmentConfirm:'Delete this attachment?', attachmentDetailHint:'Select an attachment to view details.',
    uploadProgress:'Uploading…', uploadSuccess:'Uploaded', uploadFailed:'Upload failed', searching:'Searching…', noHits:'No hits for 「{q}」.', searchHint:'Type a query to search notes & attachments (via WeKnora hybrid search).',
    score:'score', openNote:'Open note', openAttachment:'Open attachment', externalWeKnora:'external WeKnora', noteLabel:'Note', attachmentLabel:'Attachment',
    details:'Details', noteId:'NoteId', attachmentId:'AttachmentId', path:'Path', revision:'Revision', updated:'Updated', lastError:'Last error', maintenance:'Maintenance', advanced:'Advanced',
    workspaceSummary:'Workspace summary', kb:'KB', state:'State', parse:'Parse', syncSection:'WeKnora Sync', noSyncInfo:'Not synced yet.',
    reconcileDone:'Reconcile done', reconcileResult:'Notes repaired {a} · attachments repaired {b} · dirty {c} · deleted {d}', syncingAll:'Syncing…', genericError:'Operation failed', ok:'Done', emptyPreview:'(empty)', searchFailed:'Search failed',
    folder:'Folder', rootFolder:'(root)', newNoteHere:'New note here', newSubfolder:'New subfolder', renameFolder:'Rename', moveTo:'Move to…', deleteFolder:'Delete folder',
    folderRenamePrompt:'New folder name', folderDeleteConfirm:'Delete folder 「{n}」?', folderNotEmpty:'Folder is not empty and cannot be deleted.', moveNoteTo:'Move note to', moveUp:'Move up', moveDown:'Move down',
    sortMode:'Sort', sortManual:'Manual', sortTitle:'Title', sortUpdated:'Updated', cancel:'Cancel', createFolderPrompt:'Folder name', folderCreated:'Folder created', selectFolder:'Select a folder.',
    modeLive:'Live Preview', modeSource:'Source', modeReading:'Reading',
    properties:'Properties', tags:'Tags', title:'Title', outline:'Outline', backlinks:'Backlinks', noOutline:'No headings', noBacklinks:'No backlinks',
    wikiPlaceholder:'Type [[ to reference another note', autosaveFailed:'Autosave failed', externalModified:'File changed externally. Choose 「Reload」 for the disk version or 「Keep mine」 to continue editing.', reload:'Reload', keepMine:'Keep mine',
    quickSwitch:'Quick switch note', typeToSearch:'Type a title or path…',
    taskAll:'All tasks', taskToday:'Today', taskUpcoming:'Upcoming', taskCompleted:'Completed', taskInbox:'Inbox (unassigned)',
    q1:'Important & Urgent', q2:'Important, Not Urgent', q3:'Urgent, Not Important', q4:'Not Urgent, Not Important',
    taskQuickAdd:'Quick add task', taskTitle:'Title', taskMatrix:'Matrix', taskQuadrant:'Quadrant', taskPriority:'Priority', taskDue:'Due date', taskSave:'Create', taskCancel:'Cancel',
    noteToTask:'Note → Task', selectionToTask:'Selection → Task', taskNoTasks:'No tasks yet.', taskTomorrow:'Tomorrow', taskYesterday:'Yesterday', taskOverdue:'Overdue',
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
  editor: { noteId: null, persistedMarkdown: '', dirty: false, saving: false, mode: localStorage.getItem('pkw-editor-mode') || 'live' },
  taskView: localStorage.getItem('pkw-task-view') || 'all',
  highlightText: '',
}

function toast(msg, kind){ const el = $('#toast'); el.innerHTML = '<div class="toast ' + (kind || 'ok') + '">' + esc(msg) + '</div>'; el.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.display = 'none' }, 3200) }
function applyLang(){ document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; $('#search').placeholder = t('searchPlaceholder'); $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'; document.querySelectorAll('.nav button').forEach(b => b.textContent = t(b.dataset.view)) }
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
function isTerminalSync(sync){ return !sync || (sync.syncState === 'synced' && !sync.pending) || sync.syncState === 'deleted' || sync.syncState === 'stale' }
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
  else if (state.view === 'tasks') renderTasks()
  else if (state.view === 'trash') renderTrash()
  else renderSearchView()
}

// ── Overview ────────────────────────────────────────────────────────────────
async function renderOverview(){
  $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; $('#detail').innerHTML = ''
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
    let recentHtml = (s.recent || []).length ? (s.recent || []).map(r => '<div class="tree-row" data-action="' + (r.kind === 'note' ? 'open-note' : 'open-attachment') + '" data-id="' + esc(r.id) + '"><span class="nm">' + esc(r.title) + '</span></div>').join('') : '<div class="empty">' + esc(t('noRecent')) + '</div>'
    $('#main').innerHTML = '<h2>' + esc(t('overviewTitle')) + '<span class="sub">' + esc(s.workspaceName || '') + '</span></h2>' +
      '<div class="toolbar"><button class="btn primary" data-action="new-note">+ ' + esc(t('newNote')) + '</button><button class="btn" data-action="go-attachments">' + esc(t('upload')) + '</button><button class="btn" data-action="sync-now">' + esc(t('syncNow')) + '</button><button class="btn" data-action="reconcile">' + esc(t('reconcile')) + '</button></div>' +
      '<div class="stats">' + rows.join('') + '</div><h2>' + esc(t('overviewIntegration')) + '</h2>' + integBadge + '<h2 style="margin-top:16px">' + esc(t('overviewRecent')) + '</h2>' + recentHtml
    $('#detail').innerHTML = detailWorkspace(s)
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}
function detailWorkspace(s){
  return '<h3>' + esc(t('workspaceSummary')) + '</h3><div class="kv"><b>' + esc(t('workspaceLabel')) + '</b> <span class="v">' + esc(s.workspaceName || '—') + '</span></div>' +
    '<div class="kv"><b>WorkspaceId</b> <span class="v mono">' + esc(s.workspaceId || '') + '</span></div>' +
    '<h3>' + esc(t('maintenance')) + '</h3><button class="btn small" data-action="sync-now">' + esc(t('syncNow')) + '</button> <button class="btn small" data-action="reconcile">' + esc(t('reconcile')) + '</button>'
}

// ── Notes tree ──────────────────────────────────────────────────────────────
function renderTreeToolbar(){
  const sel = '<select id="sortSel" class="sel"><option value="manual"' + (state.sortMode === 'manual' ? ' selected' : '') + '>' + esc(t('sortManual')) + '</option><option value="title"' + (state.sortMode === 'title' ? ' selected' : '') + '>' + esc(t('sortTitle')) + '</option><option value="updated"' + (state.sortMode === 'updated' ? ' selected' : '') + '>' + esc(t('sortUpdated')) + '</option></select>'
  $('#treeToolbar').innerHTML = '<div class="tree-toolbar"><button class="btn small primary" data-action="new-note">+ ' + esc(t('newNote')) + '</button><button class="btn small" data-action="new-folder">+ ' + esc(t('newFolder')) + '</button></div><div class="tree-toolbar" style="border-top:0">' + esc(t('sortMode')) + ' ' + sel + '</div>'
  $('#sortSel').addEventListener('change', (e) => { state.sortMode = e.target.value; localStorage.setItem('pkw-sort', state.sortMode); renderTree() })
}
async function renderTree(){
  // stale-while-revalidate: never blank an existing tree with a loading placeholder.
  if (state.treeRoot.length === 0) $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const tree = await api('getTree', { sortMode: state.sortMode })
    state.treeRoot = tree.root || []
    $('#list').innerHTML = renderTreeNodes(state.treeRoot, '') || '<div class="empty">' + esc(t('emptyNotes')) + '<div class="cta"><button class="btn primary" data-action="new-note">+ ' + esc(t('emptyNotesCta')) + '</button></div></div>'
  } catch (e) { if (state.treeRoot.length === 0) $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}
function renderTreeNodes(nodes){ if (!nodes.length) return ''; return nodes.map(n => n.kind === 'folder' ? renderFolderNode(n) : renderNoteNode(n)).join('') }
function renderFolderNode(n){
  const sel = state.selectedFolder === n.path ? ' active' : ''
  const collapsed = state.collapsed.has(n.path)
  return '<div><div class="tree-row folder ' + sel + '" data-action="select-folder" data-path="' + esc(n.path) + '"><span class="tw" data-action="toggle-folder" data-path="' + esc(n.path) + '">' + (collapsed ? '▸' : '▾') + '</span><span class="ic">📁</span><span class="nm">' + esc(n.name) + '</span></div><div class="tree-children" data-folder="' + esc(n.path) + '"' + (collapsed ? ' style="display:none"' : '') + '>' + renderTreeNodes(n.children || []) + '</div></div>'
}
function renderNoteNode(n){
  const sel = state.selectedNoteId === n.noteId ? ' active' : ''
  return '<div class="tree-row note ' + sel + '" data-action="open-note" data-id="' + esc(n.noteId) + '"><span class="tw"></span><span class="ic">📄</span><span class="nm">' + esc(n.title || n.relativePath) + '</span> <span class="syncbadge" data-sync="note:' + esc(n.noteId) + '">' + syncBadgeHtml(n.sync) + '</span></div>'
}
function renderDetail(){
  if (state.view !== 'notes') return
  if (state.selectedNoteId !== null) return
  if (state.selectedFolder !== null) {
    const f = state.selectedFolder
    $('#detail').innerHTML = '<h3>' + esc(t('folder')) + '</h3><div class="kv"><b>' + esc(t('path')) + '</b> <span class="v mono">' + esc(f) + '/</span></div>' +
      '<h3>' + esc(t('maintenance')) + '</h3><button class="btn small" data-action="rename-folder" data-path="' + esc(f) + '">' + esc(t('renameFolder')) + '</button> <button class="btn small danger" data-action="delete-folder" data-path="' + esc(f) + '">' + esc(t('deleteFolder')) + '</button>'
  } else $('#detail').innerHTML = ''
}

// ── Markdown renderer ───────────────────────────────────────────────────────
function parseFrontmatterClient(md){
  const m = /^---\\s*\\r?\\n([\\s\\S]*?)\\r?\\n---\\s*\\r?\\n?/.exec(md)
  if (!m) return { frontmatter: {}, body: md }
  const raw = m[1] || ''
  const fm = {}
  const id = /^id:\\s*([^\\r\\n]+)$/m.exec(raw); if (id) fm.id = id[1].trim()
  const title = /^title:\\s*([^\\r\\n]+)$/m.exec(raw); if (title) fm.title = title[1].trim().replace(/^["']|["']$/g, '')
  const tags = /^tags:\\s*\\[([^\\]]*)\\]$/m.exec(raw); if (tags) fm.tags = tags[1].split(',').map(function(x){ return x.trim().replace(/^['"]|['"]$/g, '') }).filter(Boolean)
  return { frontmatter: fm, body: md.slice(m[0].length) }
}
function renderInline(s){
  let out = esc(s)
  out = out.replace(/\`([^\`]+)\`/g, '<code>$1</code>')
  out = out.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g, '<img alt="$1" src="$2" />')
  out = out.replace(/!\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g, function(_, target){ return '<span class="wikilink" data-wiki="' + esc(target) + '">' + esc(target) + '</span>' })
  out = out.replace(/\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]/g, function(_, target, alias){ return '<a class="wikilink" data-wiki="' + esc(target) + '">' + esc(alias || target) + '</a>' })
  out = out.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
  out = out.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
  out = out.replace(/\\*([^*]+)\\*/g, '<em>$1</em>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  return out
}
function renderMarkdown(body){
  const lines = body.replace(/\\r\\n/g, '\\n').split('\\n')
  const html = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (/^\\s*$/.test(line)) { i++; continue }
    const h = /^(#{1,6})\\s+(.*)$/.exec(line)
    if (h) { const lv = h[1].length; html.push('<h' + lv + '>' + renderInline(h[2]) + '</h' + lv + '>'); i++; continue }
    if (/^\\s*([-*_])\\s*(\\1\\s*){2,}$/.test(line)) { html.push('<hr />'); i++; continue }
    if (/^>\\s?/.test(line)) {
      const q = []; let callout = null
      while (i < lines.length && /^>\\s?/.test(lines[i])) {
        const t = lines[i].replace(/^>\\s?/, '')
        const co = /^\\[!(\\w+)\\]\\s?(.*)$/.exec(t)
        if (co && q.length === 0) callout = co[1].toLowerCase()
        q.push(co ? (co[2] || '') : t)
        i++
      }
      if (callout) html.push('<div class="callout"><div class="co-title">' + esc(callout) + '</div>' + q.map(renderInline).join('<br>') + '</div>')
      else html.push('<blockquote>' + q.map(renderInline).join('<br>') + '</blockquote>')
      continue
    }
    const task = /^\\s*[-*]\\s+\\[([ xX])\\]\\s+(.*)$/.exec(line)
    if (task) { const checked = task[1].toLowerCase() === 'x'; html.push('<div class="task"><input type="checkbox" disabled ' + (checked ? 'checked' : '') + ' /> ' + renderInline(task[2]) + '</div>'); i++; continue }
    const ul = /^\\s*[-*]\\s+(.*)$/.exec(line)
    if (ul) { const items = []; while (i < lines.length && /^\\s*[-*]\\s+(.*)$/.test(lines[i])) { items.push(renderInline(lines[i].replace(/^\\s*[-*]\\s+/, ''))); i++ } html.push('<ul>' + items.map(function(x){ return '<li>' + x + '</li>' }).join('') + '</ul>'); continue }
    const ol = /^\\s*\\d+[.)]\\s+(.*)$/.exec(line)
    if (ol) { const items = []; while (i < lines.length && /^\\s*\\d+[.)]\\s+(.*)$/.test(lines[i])) { items.push(renderInline(lines[i].replace(/^\\s*\\d+[.)]\\s+/, ''))); i++ } html.push('<ol>' + items.map(function(x){ return '<li>' + x + '</li>' }).join('') + '</ol>'); continue }
    const para = [line]; i++
    while (i < lines.length && !/^\\s*$/.test(lines[i]) && !/^(#{1,6}\\s|>\\s?|[-*]\\s|\\d+[.)]\\s)/.test(lines[i])) { para.push(lines[i]); i++ }
    html.push('<p>' + renderInline(para.join(' ')) + '</p>')
  }
  return html.join('\\n')
}

// ── Notes editor ────────────────────────────────────────────────────────────
let vditor = null // active Vditor instance (Live mode only)
function destroyVditor(){ if (vditor) { try { vditor.destroy() } catch (e) {} vditor = null } }

async function openNote(noteId){
  state.selectedNoteId = noteId; state.selectedFolder = null
  destroyVditor()
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const d = await api('getNote', { noteId })
    state.editor = { noteId, persistedMarkdown: d.markdown, body: d.body || '', frontmatter: d.frontmatter || '', dirty: false, saving: false, mode: localStorage.getItem('pkw-editor-mode') || 'live' }
    $('#main').innerHTML = renderEditorShell(d)
    bindEditor()
    $('#detail').innerHTML = detailNote(d)
    await renderTree()
    kickSyncPoll(d.sync)
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}
function renderEditorShell(d){
  const mode = state.editor.mode
  const fm = parseFrontmatterClient(d.markdown)
  const modeBtn = (m, key) => '<button class="btn mode ' + (mode === m ? 'active' : '') + '" data-action="set-mode" data-mode="' + m + '">' + esc(t(key)) + '</button>'
  return '<div class="toolbar">' +
    '<button class="btn primary" data-action="save-note">' + esc(t('save')) + '</button>' +
    '<button class="btn" data-action="rename-note">' + esc(t('renameMove')) + '</button>' +
    '<button class="btn" data-action="move-note" data-id="' + esc(state.selectedNoteId) + '">' + esc(t('moveNoteTo')) + '</button>' +
    '<button class="btn" data-action="sync-note" data-id="' + esc(state.selectedNoteId) + '">' + esc(t('syncNow')) + '</button>' +
    '<button class="btn" data-action="selection-to-task">' + esc(t('selectionToTask')) + '</button>' +
    '<button class="btn danger" data-action="delete-note">' + esc(t('del')) + '</button>' +
    '<span id="saveStatus" class="saved">✓ ' + esc(t('saved')) + '</span>' +
    '<span class="spacer"></span>' + modeBtn('live', 'modeLive') + modeBtn('source', 'modeSource') + modeBtn('reading', 'modeReading') +
    '</div>' +
    '<div class="editor-head"><span class="title">' + esc(fm.title || d.note.title || '') + '</span><span class="path">' + esc(d.note.relativePath) + '</span></div>' +
    '<div id="editorPane">' +
      (mode === 'live' ? '<div id="vditor" style="min-height:56vh"></div>' : '') +
      (mode === 'source' ? '<textarea id="editor" aria-label="Markdown">' + esc(d.markdown) + '</textarea>' : '') +
      (mode === 'reading' ? '<div id="preview"></div>' : '') +
    '</div>'
}
function bindEditor(){
  if (state.editor.mode === 'live') initVditor()
  else if (state.editor.mode === 'source') { const el = $('#editor'); if (el) { el.addEventListener('input', onEditorInput); el.addEventListener('keyup', wikiAutocomplete) } }
  else renderPreview()
}
function wikiAutocomplete(e){
  const el = $('#editor'); if (!el) return
  dismissWikiSuggest()
  if (e && (e.key === 'Escape' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) return
  const pos = el.selectionStart, text = el.value.slice(0, pos)
  const m = /\\[\\[$]?\\[\\[([^\\[\\]]*)$/.exec(text)
  if (!m) return
  const q = m[1]
  api('getTree', { sortMode: 'manual' }).then(tree => {
    const notes = []; collectNotes(tree.root || [], notes)
    const list = notes.filter(n => !q || n.title.toLowerCase().includes(q.toLowerCase())).slice(0, 10)
    if (!list.length) return
    const rect = el.getBoundingClientRect()
    const div = document.createElement('div')
    div.className = 'wikilink-suggest'; div.id = 'wikiSuggest'
    div.style.left = rect.left + 'px'; div.style.top = (rect.bottom + 4) + 'px'
    div.innerHTML = list.map((n, i) => '<div class="item' + (i === 0 ? ' sel' : '') + '" data-wikititle="' + esc(n.title) + '">' + esc(n.title) + '</div>').join('')
    div.addEventListener('click', ev => { const t = ev.target.closest('.item'); if (t) { insertWikiLink(el, t.dataset.wikititle, pos, q.length) } })
    document.body.appendChild(div)
  }).catch(() => {})
}
function insertWikiLink(el, title, pos, qLen){
  const start = pos - 2 - qLen
  const tail = el.value.slice(pos)
  el.value = el.value.slice(0, start) + '[[' + title + ']]' + tail
  el.selectionStart = el.selectionEnd = start + title.length + 4
  dismissWikiSuggest(); el.dispatchEvent(new Event('input')); el.focus()
}
function dismissWikiSuggest(){ const s = $('#wikiSuggest'); if (s) s.remove() }
function initVditor(){
  const el = $('#vditor')
  if (!el || typeof window.Vditor === 'undefined') return
  if (vditor) { try { vditor.destroy() } catch (e) {} vditor = null }
  vditor = new window.Vditor(el, {
    mode: 'ir',
    cache: { enable: false },
    cdn: '/pkw/assets/vditor',
    height: '56vh',
    value: state.editor.body || '',
    toolbar: ['undo', 'redo', '|', 'headings', 'bold', 'italic', 'strike', '|', 'list', 'ordered-list', 'check', '|', 'quote', 'inline-code', 'code', '|', 'link', 'table', '|', 'upload', '|', 'outline'],
    upload: { handler: (files) => { uploadVditorFiles(files) } },
    input: () => { onEditorInput() },
  })
}
function uploadVditorFiles(files){
  for (const file of files) {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1]
      api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64 }).then(up => {
        if (vditor) vditor.insertValue('![](attachments/' + up.attachmentId + '/' + file.name + ')')
        refreshHeader()
      }).catch(e => toast(t('uploadFailed') + ': ' + e.message, 'err'))
    }
    reader.readAsDataURL(file)
  }
}
function getEditorValue(){
  if (state.editor.mode === 'live' && vditor) return { kind: 'body', value: vditor.getValue() }
  if (state.editor.mode === 'source') { const el = $('#editor'); return { kind: 'markdown', value: el ? el.value : '' } }
  return { kind: 'body', value: state.editor.body || '' }
}
function onEditorInput(){
  const v = getEditorValue().value
  const dirty = state.editor.mode === 'source' ? (v !== state.editor.persistedMarkdown) : (v !== state.editor.body)
  if (dirty !== state.editor.dirty) { state.editor.dirty = dirty; updateSaveStatus() }
  clearTimeout(onEditorInput._t)
  onEditorInput._t = setTimeout(autosave, 1500)
}
function updateSaveStatus(){
  const st = $('#saveStatus'); if (!st) return
  if (state.editor.saving) { st.className = 'saving'; st.textContent = '… ' + t('saving') }
  else if (state.editor.dirty) { st.className = 'dirty'; st.textContent = '● ' + t('unsaved') }
  else { st.className = 'saved'; st.textContent = '✓ ' + t('saved') }
}
function renderPreview(){
  const fm = parseFrontmatterClient(state.editor.persistedMarkdown || '')
  const pv = $('#preview')
  if (pv) pv.innerHTML = renderMarkdown(fm.body) || '<span class="muted">' + esc(t('emptyPreview')) + '</span>'
  const q = state.highlightText
  if (q && pv) {
    const walker = document.createTreeWalker(pv, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      const i = n.nodeValue.indexOf(q)
      if (i >= 0) {
        const mark = document.createElement('mark')
        mark.textContent = q
        const tail = n.splitText(i + q.length)
        const head = n.splitText(i)
        head.parentNode.replaceChild(mark, head)
        mark.scrollIntoView({ block: 'center' })
        break
      }
    }
    state.highlightText = ''
  }
}
async function openWikiTarget(target){
  // resolve [[Note]] target to a stable NoteId via the tree/title index.
  try {
    const tree = await api('getTree', { sortMode: 'manual' })
    const found = findNoteByTitleOrPath(tree.root, target)
    if (found) { setView('notes'); openNote(found.noteId) }
    else toast(t('noHits', { q: target }), 'warn')
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
function findNoteByTitleOrPath(nodes, target){
  for (const n of nodes) {
    if (n.kind === 'note') {
      if (n.noteId === target || n.title === target || n.relativePath === target || n.relativePath.endsWith('/' + target)) return n
    } else if (n.kind === 'folder') {
      const r = findNoteByTitleOrPath(n.children || [], target); if (r) return r
    }
  }
  return null
}
function detailNote(d){
  const s = d.sync
  const fm = parseFrontmatterClient(d.markdown)
  return '<h3>' + esc(t('properties')) + '</h3>' +
    '<button class="btn small" data-action="note-to-task" data-id="' + esc(d.note.noteId) + '">' + esc(t('noteToTask')) + '</button>' +
    (fm.title ? '<div class="kv"><b>' + esc(t('title')) + '</b> <span class="v">' + esc(fm.title) + '</span></div>' : '') +
    (fm.tags && fm.tags.length ? '<div class="kv"><b>' + esc(t('tags')) + '</b> <span class="v">' + esc(fm.tags.join(', ')) + '</span></div>' : '') +
    '<div class="kv"><b>' + esc(t('path')) + '</b> <span class="v mono">' + esc(d.note.relativePath) + '</span></div>' +
    '<h3>' + esc(t('outline')) + '</h3><div class="outline" id="outlineBox">' + outlineHtml(d.markdown) + '</div>' +
    '<h3>' + esc(t('syncSection')) + '</h3><div id="detailSync">' + syncBadgeHtml(s) + '</div>' +
    (s && s.error ? '<div class="kv"><b>' + esc(t('lastError')) + '</b> <span class="v">' + esc(s.error) + '</span></div>' : '') +
    '<h3>' + esc(t('advanced')) + '</h3>' +
    '<div class="kv"><b>' + esc(t('noteId')) + '</b> <span class="v mono">' + esc(d.note.noteId) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('revision')) + '</b> ' + d.note.observedRevision + '</div>' +
    (s && s.knowledgeId ? '<div class="kv"><b>' + esc(t('knowledgeId')) + '</b> <span class="v mono">' + esc(s.knowledgeId) + '</span></div>' : '')
}
function outlineHtml(md){
  const fm = parseFrontmatterClient(md)
  const items = []
  for (const line of fm.body.split('\\n')) {
    const h = /^(#{1,6})\\s+(.*)$/.exec(line)
    if (h) items.push({ lv: h[1].length, text: renderInline(h[2]).replace(/<[^>]+>/g, '') })
  }
  if (!items.length) return '<span class="muted">' + esc(t('noOutline')) + '</span>'
  return items.map(h => '<a class="lv' + h.lv + '" href="#preview" data-outline="' + esc(h.text) + '">' + esc(h.text) + '</a>').join('')
}

async function saveNote(){
  if (state.selectedNoteId === null) return
  const btn = document.querySelector('[data-action="save-note"]'); if (btn) btn.disabled = true
  state.editor.saving = true; updateSaveStatus()
  try {
    const v = getEditorValue()
    const d = v.kind === 'body'
      ? await api('saveNoteBody', { noteId: state.selectedNoteId, body: v.value })
      : await api('saveNote', { noteId: state.selectedNoteId, markdown: v.value })
    if (v.kind === 'body') state.editor.body = v.value
    else state.editor.persistedMarkdown = v.value
    state.editor.dirty = false; state.editor.saving = false; updateSaveStatus()
    toast(t('localSavedR', { r: d.observedRevision }), 'ok')
    refreshHeader(); renderTree()
    kickSyncPoll({ pending: true })
  } catch (e) { state.editor.saving = false; updateSaveStatus(); toast(t('saveFailed') + ': ' + e.message, 'err') }
  finally { if (btn) btn.disabled = false }
}
async function autosave(){
  if (!state.editor.dirty || state.selectedNoteId === null || state.editor.saving) return
  state.editor.saving = true; updateSaveStatus()
  try {
    const v = getEditorValue()
    const d = v.kind === 'body'
      ? await api('saveNoteBody', { noteId: state.selectedNoteId, body: v.value })
      : await api('saveNote', { noteId: state.selectedNoteId, markdown: v.value })
    if (v.kind === 'body') state.editor.body = v.value
    else state.editor.persistedMarkdown = v.value
    state.editor.dirty = false; state.editor.saving = false; updateSaveStatus()
    refreshHeader()
    kickSyncPoll({ pending: true })
  } catch (e) { state.editor.saving = false; updateSaveStatus(); toast(t('autosaveFailed'), 'err') }
}

// ── Adaptive remote-sync polling (never rebuilds editor/tree) ───────────────
let syncPollDelay = 2000, syncPollTimer = null, syncPollStarted = 0
function kickSyncPoll(sync){
  syncPollStarted = Date.now()
  syncPollDelay = 2000
  if (isTerminalSync(sync)) return
  scheduleSyncPoll()
}
function scheduleSyncPoll(){
  clearTimeout(syncPollTimer)
  if (document.hidden || state.view !== 'notes' || state.selectedNoteId === null) return
  syncPollTimer = setTimeout(pollSync, syncPollDelay)
}
async function pollSync(){
  if (document.hidden || state.view !== 'notes' || state.selectedNoteId === null) return
  try {
    const d = await api('getNote', { noteId: state.selectedNoteId })
    const syncEl = $('#detailSync'); if (syncEl) syncEl.innerHTML = syncBadgeHtml(d.sync)
    patchNoteBadge(state.selectedNoteId, d.sync)
    if (isTerminalSync(d.sync)) { syncPollDelay = 2000; return } // done: stop polling
    syncPollDelay = Math.min(15000, Math.max(3000, Date.now() - syncPollStarted < 20000 ? 3000 : syncPollDelay * 1.6))
    scheduleSyncPoll()
  } catch (e) { scheduleSyncPoll() }
}
function patchNoteBadge(noteId, sync){
  const el = document.querySelector('[data-sync="note:' + CSS.escape(noteId) + '"]')
  if (el) el.innerHTML = syncBadgeHtml(sync)
}

// ── Create / rename / delete / folders / order (change-driven) ──────────────
async function newNote(){
  const title = prompt(t('newNotePrompt'), '')
  if (title === null) return
  const slug = (title.trim() || 'untitled').replace(/[\\/:*?"<>|#]+/g, ' ').trim().replace(/\s+/g, '-').slice(0, 60) || 'untitled'
  const base = state.selectedFolder ? (state.selectedFolder + '/') : ''
  const rel = base + slug + '.md'
  try {
    const r = await api('createNote', { relativePath: rel, markdown: '# ' + (title.trim() || 'New note') + '\\n' })
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
    state.selectedNoteId = null; state.editor = { noteId: null, persistedMarkdown: '', dirty: false, saving: false, mode: 'live' }
    toast(t('deletedMsg'), 'ok'); render()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
async function newFolder(parentPath){
  const name = prompt(t('createFolderPrompt'), ''); if (!name || !name.trim()) return
  const path = (parentPath ? parentPath + '/' : '') + name.trim()
  try { await api('createFolder', { path }); state.selectedFolder = path; state.selectedNoteId = null; toast(t('folderCreated'), 'ok'); await renderTree(); renderDetail(); renderFolderMain(path) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
function renderFolderMain(path){
  $('#main').innerHTML = '<h2>' + esc(t('folder')) + '<span class="sub mono">' + esc(path) + '/</span></h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-note-here" data-path="' + esc(path) + '">+ ' + esc(t('newNoteHere')) + '</button><button class="btn" data-action="new-subfolder" data-path="' + esc(path) + '">+ ' + esc(t('newSubfolder')) + '</button><button class="btn" data-action="rename-folder" data-path="' + esc(path) + '">' + esc(t('renameFolder')) + '</button><button class="btn" data-action="delete-folder" data-path="' + esc(path) + '">' + esc(t('deleteFolder')) + '</button></div>'
  renderDetail()
}
async function renameFolder(path){
  const name = prompt(t('folderRenamePrompt'), path.split('/').pop()); if (!name || !name.trim()) return
  const parent = parentOfPath(path); const newPath = (parent ? parent + '/' : '') + name.trim()
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
    document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay"><div class="modal"><h3>' + esc(t('moveTo')) + '</h3><select id="pickFolder"><option value="">' + esc(t('rootFolder')) + '</option>' + folders.map(f => '<option value="' + esc(f) + '"' + (f === currentPath ? ' selected' : '') + '>' + esc(f) + '</option>').join('') + '</select><div class="modal-actions"><button class="btn" data-act="pick-cancel">' + esc(t('cancel')) + '</button><button class="btn primary" data-act="pick-ok">' + esc(t('ok')) + '</button></div></div></div>')
    const done = (val) => { document.querySelector('.modal-overlay')?.remove(); if (val !== undefined) cb(val) }
    document.querySelector('[data-act="pick-cancel"]').onclick = () => done(undefined)
    document.querySelector('[data-act="pick-ok"]').onclick = () => done($('#pickFolder').value)
  })
}

// ── Attachments / Search / Maintenance ──────────────────────────────────────
async function renderAttachments(){
  $('#treeToolbar').innerHTML = ''
  $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = '<h3>' + esc(t('attachments')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>'
  try {
    const list = await api('listAttachments')
    $('#list').innerHTML = list.length ? list.map(a => '<div class="tree-row ' + (a.attachmentId === state.selectedAttachmentId ? 'active' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '"><span class="tw"></span><span class="ic">📎</span><span class="nm">' + esc(a.filename) + '</span> ' + syncBadgeHtml(a.sync) + '</div>').join('') : '<div class="empty">' + esc(t('emptyAttachments')) + '</div>'
    $('#main').innerHTML = '<h2>' + esc(t('attachments')) + '</h2><p class="muted">' + esc(t('attachmentsDesc')) + '</p><div class="toolbar"><input type="file" id="file" /> <button class="btn primary" data-action="upload-attachment">' + esc(t('upload')) + '</button></div>'
    if (state.selectedAttachmentId !== null) await openAttachment(state.selectedAttachmentId)
  } catch (e) { $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}
async function openAttachment(id){
  state.selectedAttachmentId = id
  try {
    const d = await api('getAttachment', { attachmentId: id })
    const a = d.attachment, s = d.sync
    $('#detail').innerHTML = '<h3>' + esc(t('details')) + '</h3><div class="kv"><b>' + esc(t('attachmentId')) + '</b> <span class="v mono">' + esc(a.attachmentId) + '</span></div><div class="kv"><b>' + esc(t('size')) + '</b> ' + fmtSize(a.sizeBytes) + '</div><h3>' + esc(t('syncSection')) + '</h3>' + syncBadgeHtml(s) + '<h3>' + esc(t('maintenance')) + '</h3><button class="btn small" data-action="download-attachment" data-id="' + esc(id) + '">' + esc(t('download')) + '</button> <button class="btn small danger" data-action="delete-attachment" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>'
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
function quadrantOf(x){ return x.important ? (x.urgent ? 1 : 2) : (x.urgent ? 3 : 4) }
function matrixName(matrices, id){ const m = matrices.find(m => m.matrixId === id); return m ? m.name : id }
function setTaskView(v){ state.taskView = v; localStorage.setItem('pkw-task-view', v); renderTasks() }
function dueLabel(iso){
  if (!iso) return ''
  const d = new Date(iso.length <= 10 ? iso + 'T00:00:00' : iso)
  if (isNaN(d.getTime())) return iso
  const now = new Date(); const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((that - today) / 86400000)
  if (diff === 0) return t('taskToday')
  if (diff === 1) return t('taskTomorrow')
  if (diff === -1) return t('taskYesterday')
  if (diff < -1) return t('taskOverdue') + ' ' + (-diff) + 'd'
  return (d.getMonth() + 1) + '/' + d.getDate()
}
function taskRow(x, matrices){
  const due = x.dueAt ? '<span class="muted mono">' + esc(dueLabel(x.dueAt)) + '</span>' : ''
  const pri = x.priority !== undefined ? '<span class="badge warn">P' + x.priority + '</span>' : ''
  const badge = x.matrixId ? '<span class="badge">' + esc(matrixName(matrices, x.matrixId)) + '</span>' : ''
  const src = x.sourceRefs && x.sourceRefs[0] && x.sourceRefs[0].noteId
    ? '<span class="task-src" data-action="open-task-source" data-id="' + esc(x.sourceRefs[0].noteId) + '" data-exact="' + esc(x.sourceRefs[0].exact || '') + '" title="' + esc(t('openNote')) + '">📄</span>' : ''
  return '<div class="tree-row" data-action="toggle-task" data-completed="' + (x.status === 'completed' ? '1' : '0') + '" data-id="' + esc(x.taskId) + '"><span class="ic">' + (x.status === 'completed' ? '☑' : '☐') + '</span><span class="nm">' + esc(x.title) + '</span>' + badge + pri + due + src + '</div>'
}
async function renderTasks(){
  $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#detail').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const matrices = await api('listMatrices')
    const all = await api('listTasks', {})
    const counts = {}
    for (const x of all) if (x.status === 'open') { const k = x.matrixId ?? 'inbox'; counts[k] = (counts[k] || 0) + 1 }
    const views = [['all', t('taskAll')], ['today', t('taskToday')], ['upcoming', t('taskUpcoming')], ['completed', t('taskCompleted')]]
    const viewRows = views.map(v => '<div class="tree-row' + (state.taskView === v[0] ? ' active' : '') + '" data-action="task-view" data-view="' + v[0] + '"><span class="ic">▤</span><span class="nm">' + esc(v[1]) + '</span></div>').join('')
    const matrixRows = matrices.map(m => '<div class="tree-row' + (state.taskView === m.matrixId ? ' active' : '') + '" data-action="task-view" data-view="' + esc(m.matrixId) + '"><span class="ic">▦</span><span class="nm">' + esc(m.name) + ' (' + (counts[m.matrixId] || 0) + ')</span></div>').join('')
    $('#list').innerHTML =
      '<div class="list-head">' + esc(t('tasks')) + '</div>' +
      viewRows +
      '<div class="tree-row' + (state.taskView === 'inbox' ? ' active' : '') + '" data-action="task-view" data-view="inbox"><span class="ic">📥</span><span class="nm">Inbox (' + (counts.inbox || 0) + ')</span></div>' +
      matrixRows
    if (state.taskView === 'all' || state.taskView === 'today' || state.taskView === 'upcoming' || state.taskView === 'completed' || state.taskView === 'inbox') renderTaskList(matrices, all, state.taskView)
    else renderMatrixGrid(matrices, all, state.taskView)
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}
function renderTaskList(matrices, all, filter){
  const isToday = d => { const n = new Date(d); const now = new Date(); return n.getFullYear() === now.getFullYear() && n.getMonth() === now.getMonth() && n.getDate() === now.getDate() }
  let list
  if (filter === 'completed') list = all.filter(x => x.status === 'completed')
  else if (filter === 'inbox') list = all.filter(x => x.matrixId === null && x.status === 'open')
  else if (filter === 'today') list = all.filter(x => x.status === 'open' && (x.dueAt || x.scheduledAt) && (isToday(x.dueAt || x.scheduledAt) || new Date(x.dueAt || x.scheduledAt) < new Date()))
  else if (filter === 'upcoming') list = all.filter(x => x.status === 'open' && (x.dueAt || x.scheduledAt) && new Date(x.dueAt || x.scheduledAt) > new Date())
  else list = all.filter(x => x.status === 'open')
  list.sort((a, b) => ((a.dueAt || a.scheduledAt) || '9999') < ((b.dueAt || b.scheduledAt) || '9999') ? -1 : 1)
  $('#main').innerHTML =
    '<h2>' + esc(t('tasks')) + '</h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-task">+ ' + esc(t('taskQuickAdd')) + '</button><button class="btn" data-action="new-matrix">+ ' + esc(t('newFolder')) + '</button></div>' +
    (list.length ? list.map(x => taskRow(x, matrices)).join('') : '<div class="empty">' + esc(t('taskNoTasks')) + '</div>')
}
function renderMatrixGrid(matrices, all, matrixId){
  const m = matrices.find(x => x.matrixId === matrixId)
  const name = m ? m.name : matrixId
  const open = all.filter(x => x.status === 'open' && x.matrixId === matrixId)
  const cells = [[1, 'Q1', t('q1')], [2, 'Q2', t('q2')], [3, 'Q3', t('q3')], [4, 'Q4', t('q4')]]
  const grid = cells.map(([q, label, title]) => {
    const items = open.filter(x => quadrantOf(x) === q)
    return '<div class="quad"><div class="quad-head"><b>' + label + '</b> <span class="muted">' + esc(title) + '</span><span class="count">' + items.length + '</span></div>' +
      (items.length ? items.map(x => taskRow(x, matrices)).join('') : '<div class="empty small">—</div>') + '</div>'
  }).join('')
  $('#main').innerHTML =
    '<h2>' + esc(name) + '<span class="sub">' + esc(t('taskMatrix')) + '</span></h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-task-matrix" data-id="' + esc(matrixId) + '">+ ' + esc(t('taskQuickAdd')) + '</button><button class="btn" data-action="new-matrix">+ ' + esc(t('newFolder')) + '</button></div>' +
    '<div class="quad-grid">' + grid + '</div>'
}

async function renderTrash(){
  $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#detail').innerHTML = ''
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const notes = await api('listTrash')
    const atts = await api('listTrashAttachments')
    const folders = await api('listTrashFolders')
    const rows = []
    for (const f of folders) rows.push('<div class="tree-row"><span class="ic">📁</span><span class="nm">' + esc(f) + '/</span><button class="btn small" data-action="restore-folder" data-path="' + esc(f) + '">' + esc(t('reconcile')) + '</button></div>')
    for (const n of notes) rows.push('<div class="tree-row"><span class="ic">📄</span><span class="nm">' + esc(n.title) + '</span><button class="btn small" data-action="restore-note" data-id="' + esc(n.noteId) + '">' + esc(t('reconcile')) + '</button><button class="btn small danger" data-action="purge-note" data-id="' + esc(n.noteId) + '">' + esc(t('del')) + '</button></div>')
    for (const a of atts) rows.push('<div class="tree-row"><span class="ic">📎</span><span class="nm">' + esc(a.filename) + '</span><button class="btn small" data-action="restore-attachment" data-id="' + esc(a.attachmentId) + '">' + esc(t('reconcile')) + '</button><button class="btn small danger" data-action="purge-attachment" data-id="' + esc(a.attachmentId) + '">' + esc(t('del')) + '</button></div>')
    $('#list').innerHTML = '<div class="list-head">' + esc(t('trash')) + '</div>'
    $('#main').innerHTML = '<h2>' + esc(t('trash')) + '</h2>' + (rows.length ? rows.join('') : '<div class="empty">' + esc(t('noRecent')) + '</div>')
  } catch (e) { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}

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
async function syncNow(){ toast(t('syncingAll'), 'warn'); try { await api('syncNow'); toast(t('ok'), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function syncEntity(et, id){ try { await api('syncEntity', { entityType: et, entityId: id }); toast(t('ok'), 'ok'); if (et === 'note' && state.selectedNoteId === id) await openNote(id); else await renderTree() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function reconcile(){ try { const r = await api('reconcile'); toast(t('reconcileResult', { a: r.notesRepaired, b: r.attachmentsRepaired, c: r.markedDirty, d: r.markedDeleted }), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }

// ── Quick switcher (Ctrl+O) ─────────────────────────────────────────────────
function quickSwitch(){
  api('getTree', { sortMode: 'manual' }).then(tree => {
    const notes = []
    collectNotes(tree.root, notes)
    document.body.insertAdjacentHTML('beforeend', '<div class="modal-overlay"><div class="modal"><h3>' + esc(t('quickSwitch')) + '</h3><input id="qsInput" placeholder="' + esc(t('typeToSearch')) + '" /><div id="qsList" style="max-height:300px;overflow:auto"></div></div></div>')
    const input = $('#qsInput'); input.focus()
    const render = () => {
      const q = input.value.trim().toLowerCase()
      const list = notes.filter(n => !q || n.title.toLowerCase().includes(q) || n.relativePath.toLowerCase().includes(q)).slice(0, 30)
      $('#qsList').innerHTML = list.map(n => '<div class="tree-row" data-qsid="' + esc(n.noteId) + '"><span class="ic">📄</span><span class="nm">' + esc(n.title) + '</span><span class="muted mono">' + esc(n.relativePath) + '</span></div>').join('') || '<div class="empty">' + esc(t('noHits', { q: '' })) + '</div>'
    }
    render()
    input.addEventListener('input', render)
    $('#qsList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-qsid]')
      if (row) { document.querySelector('.modal-overlay')?.remove(); setView('notes'); openNote(row.dataset.qsid) }
    })
    document.querySelector('.modal-overlay').addEventListener('click', (e) => { if (e.target.classList.contains('modal-overlay')) document.querySelector('.modal-overlay')?.remove() })
  })
}
function collectNotes(nodes, out){ for (const n of nodes) { if (n.kind === 'note') out.push(n); else collectNotes(n.children || [], out) } }

// ── Paste image → attachment ────────────────────────────────────────────────
document.addEventListener('paste', async (e) => {
  // Vditor (Live mode) handles paste via its own upload hook; this manual handler
  // is for Source mode only (a raw textarea with no upload integration).
  if (state.view !== 'notes' || state.selectedNoteId === null || state.editor.mode !== 'source') return
  const items = (e.clipboardData && e.clipboardData.items) || []
  for (const item of items) {
    if (item.type.indexOf('image/') === 0) {
      const file = item.getAsFile()
      if (!file) continue
      const buf = new Uint8Array(await file.arrayBuffer()); let bin = ''
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
      const up = await api('uploadAttachment', { filename: 'paste-' + Date.now() + '.png', mimeType: file.type || 'image/png', contentBase64: btoa(bin) })
      const el = $('#editor')
      if (el) {
        const ref = '![](attachments/' + up.attachmentId + '/paste-' + Date.now() + '.png)'
        insertAtCursor(el, '\\n' + ref + '\\n')
      }
      toast(t('uploadSuccess'), 'ok'); refreshHeader()
      e.preventDefault()
    }
  }
})
function insertAtCursor(el, text){
  const start = el.selectionStart, end = el.selectionEnd
  el.value = el.value.slice(0, start) + text + el.value.slice(end)
  el.selectionStart = el.selectionEnd = start + text.length
  el.dispatchEvent(new Event('input'))
}

// ── Delegated events ────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wikiSuggest')) dismissWikiSuggest()
  const nav = e.target.closest('.nav button'); if (nav) { setView(nav.dataset.view); return }
  const el = e.target.closest('[data-action]'); if (!el) return
  const act = el.dataset.action, id = el.dataset.id, path = el.dataset.path, mode = el.dataset.mode
  if (act === 'new-note') newNote()
  else if (act === 'new-note-here') { state.selectedFolder = path; newNote() }
  else if (act === 'new-folder') newFolder(state.selectedFolder || '')
  else if (act === 'new-subfolder') newFolder(path)
  else if (act === 'open-note') { setView('notes'); openNote(id) }
  else if (act === 'open-attachment') { setView('attachments'); openAttachment(id) }
  else if (act === 'select-folder') { state.selectedFolder = path; state.selectedNoteId = null; renderTree(); renderFolderMain(path); renderDetail() }
  else if (act === 'toggle-folder') { if (state.collapsed.has(path)) state.collapsed.delete(path); else state.collapsed.add(path); const c = document.querySelector('.tree-children[data-folder="' + CSS.escape(path) + '"]'); if (c) { c.style.display = state.collapsed.has(path) ? 'none' : ''; el.textContent = state.collapsed.has(path) ? '▸' : '▾' } }
  else if (act === 'save-note') saveNote()
  else if (act === 'set-mode') { state.editor.mode = mode; localStorage.setItem('pkw-editor-mode', mode); const d = state.editor.noteId; if (d) openNote(d) }
  else if (act === 'rename-note') renameNote()
  else if (act === 'move-note') moveNote(id)
  else if (act === 'delete-note') delNote()
  else if (act === 'rename-folder') renameFolder(path)
  else if (act === 'delete-folder') deleteFolder(path)
  else if (act === 'sync-note') syncEntity('note', id)
  else if (act === 'sync-now') syncNow()
  else if (act === 'reconcile') reconcile()
  else if (act === 'upload-attachment') uploadAttachment()
  else if (act === 'download-attachment') downloadAttachment(id)
  else if (act === 'delete-attachment') delAttachment(id)
  else if (act === 'go-attachments') setView('attachments')
  else if (act === 'new-task') quickTaskDialog(null, null)
  else if (act === 'new-task-matrix') quickTaskDialog(id || null, null)
  else if (act === 'new-matrix') { const name = prompt(t('createFolderPrompt'), ''); if (name && name.trim()) api('createMatrix', { name: name.trim() }).then(() => renderTasks()) }
  else if (act === 'task-view') setTaskView(el.dataset.view)
  else if (act === 'note-to-task') quickTaskDialog(null, [{ kind: 'note', noteId: id }])
  else if (act === 'selection-to-task') { const ref = selectionSourceRef(); if (ref) quickTaskDialog(null, [ref]); else toast(t('taskNoTasks'), 'warn') }
  else if (act === 'open-task-source') { state.highlightText = el.dataset.exact || ''; setView('notes'); openNote(id) }
  else if (act === 'toggle-task') { const t = el.dataset.completed === '1' ? api('reopenTask', { taskId: id }) : api('completeTask', { taskId: id }); t.then(() => renderTasks()) }
  else if (act === 'restore-note') { api('restoreNote', { noteId: id }).then(() => renderTrash()).then(refreshHeader) }
  else if (act === 'purge-note') { if (confirm(t('delNoteConfirm'))) api('purgeNote', { noteId: id }).then(() => renderTrash()).then(refreshHeader) }
  else if (act === 'restore-attachment') { api('restoreAttachment', { attachmentId: id }).then(() => renderTrash()).then(refreshHeader) }
  else if (act === 'purge-attachment') { if (confirm(t('delAttachmentConfirm'))) api('purgeAttachment', { attachmentId: id }).then(() => renderTrash()).then(refreshHeader) }
  else if (act === 'restore-folder') { api('restoreFolder', { path }).then(() => renderTrash()) }
})
function selectionSourceRef(){
  if (state.selectedNoteId === null) return null
  const sel = window.getSelection()
  const text = sel ? sel.toString().trim() : ''
  if (!text || text.length > 500) return null
  let prefix = '', suffix = ''
  const node = sel.anchorNode
  if (node && node.textContent) {
    const full = node.textContent
    const off = sel.anchorOffset
    prefix = full.slice(Math.max(0, off - 80), off)
    suffix = full.slice(off + text.length, off + text.length + 80)
  }
  return { kind: 'selection', noteId: state.selectedNoteId, exact: text, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) }
}
function quickTaskDialog(matrixId, sourceRefs){
  const lastMatrix = localStorage.getItem('pkw-task-last-matrix') || ''
  api('listMatrices').then(matrices => {
    const opts = '<option value="">' + esc(t('taskInbox')) + '</option>' + matrices.map(m => '<option value="' + esc(m.matrixId) + '"' + (m.matrixId === (matrixId || lastMatrix) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('')
    const srcNote = sourceRefs && sourceRefs[0] ? '<div class="form"><label>' + esc(t('noteLabel')) + '</label><span class="v mono">' + esc(sourceRefs[0].noteId) + '</span></div>' : ''
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal-overlay" id="taskModal"><div class="modal"><h3>' + esc(t('taskQuickAdd')) + '</h3>' +
      '<div class="form"><label>' + esc(t('taskTitle')) + '</label><input id="tkTitle" /></div>' +
      '<div class="form"><label>' + esc(t('taskMatrix')) + '</label><select id="tkMatrix">' + opts + '</select></div>' +
      '<div class="form"><label>' + esc(t('taskQuadrant')) + '</label><select id="tkQuad">' +
        '<option value="1">Q1 · ' + esc(t('q1')) + '</option><option value="2">Q2 · ' + esc(t('q2')) + '</option><option value="3">Q3 · ' + esc(t('q3')) + '</option><option value="4">Q4 · ' + esc(t('q4')) + '</option></select></div>' +
      '<div class="form"><label>' + esc(t('taskPriority')) + '</label><select id="tkPri"><option value="">—</option><option value="1">P1</option><option value="2">P2</option><option value="3">P3</option><option value="4">P4</option></select></div>' +
      '<div class="form"><label>' + esc(t('taskDue')) + '</label><input type="date" id="tkDue" /></div>' +
      srcNote +
      '<div class="toolbar"><button class="btn primary" id="tkSave">' + esc(t('taskSave')) + '</button><button class="btn" id="tkCancel">' + esc(t('taskCancel')) + '</button></div></div></div>'
    )
    const modal = $('#taskModal')
    $('#tkCancel').addEventListener('click', () => modal.remove())
    $('#tkSave').addEventListener('click', () => {
      const title = $('#tkTitle').value.trim()
      if (!title) { toast(t('taskTitle'), 'warn'); return }
      const m = $('#tkMatrix').value
      const quad = Number($('#tkQuad').value)
      const pri = $('#tkPri').value
      const due = $('#tkDue').value
      if (m) localStorage.setItem('pkw-task-last-matrix', m)
      api('createTask', {
        title,
        ...(m ? { matrixId: m } : {}),
        important: quad === 1 || quad === 2,
        urgent: quad === 1 || quad === 3,
        ...(pri ? { priority: Number(pri) } : {}),
        ...(due ? { dueAt: due } : {}),
        ...(sourceRefs && sourceRefs.length ? { sourceRefs } : {}),
      }).then(() => { modal.remove(); renderTasks() }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
    })
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
    $('#tkTitle').focus()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { state.view = 'search'; render(); runSearch(e.target.value.trim()) } })
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.view === 'notes' && state.selectedNoteId !== null) saveNote() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); quickSwitch() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '**bold**') }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '*italic*') }
})
$('#langBtn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pkw-lang', lang); render() })
window.addEventListener('beforeunload', (e) => { if (state.editor.dirty && state.selectedNoteId !== null) { e.preventDefault(); e.returnValue = '' } })
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshHeader(); if (state.view === 'notes') { renderTree(); if (state.selectedNoteId) kickSyncPoll({ pending: true }) } } })

render()
</script>
</body>
</html>`
}
