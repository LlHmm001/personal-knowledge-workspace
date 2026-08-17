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
<!-- PKW build: 1d93f55 -->
<style>
:root{--bg-app:#f6f7f9;--bg-sidebar:#fff;--bg-surface:#fff;--bg-elevated:#f8fafd;--bg-hover:#eef2f8;--bg-selected:#e7eefb;--bg-input:#fff;--text-primary:#1c2330;--text-secondary:#33415c;--text-muted:#6b7280;--border:#e3e6ea;--border-strong:#c6ccd4;--accent:#2f6fed;--accent-hover:#2456c9;--accent-soft:#eef4ff;--success:#178a4f;--warning:#b45309;--danger:#b91c1c;--shadow-sm:0 1px 3px rgba(0,0,0,.08);--shadow-md:0 8px 30px rgba(0,0,0,.18);--radius-sm:6px;--radius-md:8px;--radius-lg:12px;--space-1:4px;--space-2:8px;--space-3:12px;--space-4:16px;--space-5:24px;--code-bg:#0f172a;--code-fg:#e2e8f0;--mark-bg:#ffe9a8;--mark-fg:#1c2330;--co-note:#2f6fed;--co-note-bg:#eef4ff;--co-tip:#178a4f;--co-tip-bg:#e8f6ee;--co-info:#0e7f9e;--co-info-bg:#e7f5f9;--co-important:#7c3aed;--co-important-bg:#f2ecff;--co-warning:#b45309;--co-warning-bg:#fdf1e3;--co-question:#0891b2;--co-question-bg:#e8f8fb;--co-example:#6d28d9;--co-example-bg:#f3eefc;--co-success:#16a34a;--co-success-bg:#e9f9ef;--co-danger:#b91c1c;--co-danger-bg:#fdeaea;--bg:var(--bg-app);--panel:var(--bg-sidebar);--ink:var(--text-primary);--muted:var(--text-muted);--ok:var(--success);--warn:var(--warning);--err:var(--danger)}
[data-theme="dark"]{--bg-app:#0f1218;--bg-sidebar:#161a22;--bg-surface:#161a22;--bg-elevated:#1c212c;--bg-hover:#232a38;--bg-selected:#2a3447;--bg-input:#161a22;--text-primary:#e5e9f0;--text-secondary:#b6c0cf;--text-muted:#8b95a7;--border:#2a3242;--border-strong:#3b4557;--accent:#5b8cff;--accent-hover:#7ba3ff;--accent-soft:#1e2b47;--success:#4ade80;--warning:#fbbf24;--danger:#f87171;--shadow-sm:0 1px 3px rgba(0,0,0,.5);--shadow-md:0 8px 30px rgba(0,0,0,.6);--code-bg:#0d1117;--code-fg:#e6edf3;--mark-bg:#5c4a1e;--mark-fg:#ffe9a8;--co-note:#7ba3ff;--co-note-bg:#1e2b47;--co-tip:#4ade80;--co-tip-bg:#12301f;--co-info:#38bdf8;--co-info-bg:#0f2a3a;--co-important:#a78bfa;--co-important-bg:#281d4d;--co-warning:#fbbf24;--co-warning-bg:#33250a;--co-question:#22d3ee;--co-question-bg:#0a2e33;--co-example:#c084fc;--co-example-bg:#2b1744;--co-success:#4ade80;--co-success-bg:#12301f;--co-danger:#f87171;--co-danger-bg:#3a1414}
*{box-sizing:border-box}body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:var(--bg)}
#app{display:grid;grid-template-columns:280px 1fr 300px;grid-template-rows:52px 1fr;height:100vh}
#app.no-inspector{grid-template-columns:280px 1fr}#app.no-inspector #detail{display:none}
header{grid-column:1/-1;display:flex;align-items:center;gap:12px;padding:0 16px;background:var(--panel);border-bottom:1px solid var(--border)}
header h1{font-size:15px;margin:0;font-weight:700}
header .spacer{flex:1}
#search{width:320px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg)}
.badge{padding:2px 9px;border-radius:999px;font-size:12px;background:var(--bg-hover);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--co-tip-bg);color:var(--ok)}.badge.warn{background:var(--co-warning-bg);color:var(--warn)}.badge.err{background:var(--co-danger-bg);color:var(--err)}
.langbtn{padding:6px 11px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:12px;color:var(--ink);font-weight:600}
.langbtn:hover{background:var(--bg-hover)}
aside{border-right:1px solid var(--border);background:var(--panel);display:flex;flex-direction:column;min-height:0}
.nav{padding:10px 10px 6px;flex:0 0 auto}.nav button{display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink);margin-bottom:2px}
.nav button.active,.nav button:hover{background:var(--bg-hover)}.nav button.active{font-weight:650;color:var(--accent)}
#list{overflow:auto;padding:6px 8px 12px;flex:1 1 auto}
.tree-toolbar{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--border);flex:0 0 auto;align-items:center}
.tree-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;cursor:pointer;border:1px solid transparent;font-size:13px}
.tree-row:hover{background:var(--bg-hover)}.tree-row.active{background:var(--bg-selected);border-color:var(--border-strong)}
.tree-row .tw{width:16px;text-align:center;color:var(--muted);flex:0 0 auto;font-size:11px}
.tree-row .ic{flex:0 0 auto;font-size:12px}
.tree-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.tree-row .badge{margin-left:2px}
.trash-item{gap:8px;cursor:default}.trash-check{margin:0;cursor:pointer;flex:0 0 auto}
.trash-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;overflow:hidden}
.trash-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.trash-selbar{position:sticky;top:0;background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:6px 10px;margin-bottom:10px;display:flex;align-items:center;gap:8px;z-index:5}
.select-all{display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:13px}
.list-section{padding:10px 12px 4px;font-size:11px;letter-spacing:.04em;color:var(--muted);font-weight:650;text-transform:uppercase}
.tree-row.note .nm{font-weight:500}
.tree-children{margin-left:14px;border-left:1px solid var(--border);padding-left:4px}
main{overflow:auto;padding:20px 24px;background:var(--bg)}
main h2{margin:0 0 12px;font-size:18px;font-weight:650}
.toolbar{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap}
button.btn{padding:7px 12px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:13px}
button.btn:hover{border-color:var(--border-strong)}
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
textarea#editor{width:100%;height:56vh;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:14px 16px;border:0;resize:vertical;outline:none;display:block;background:var(--bg-surface);color:var(--text-primary)}
#preview{padding:14px 18px;min-height:56vh;background:var(--bg-surface);overflow:auto}
#preview h1{font-size:1.6em;margin:.4em 0 .3em;border-bottom:1px solid var(--border);padding-bottom:.15em}
#preview h2{font-size:1.35em;margin:.5em 0 .25em}#preview h3{font-size:1.15em}#preview h4,#preview h5,#preview h6{font-size:1em}
#preview p{margin:.5em 0}#preview ul,#preview ol{margin:.4em 0;padding-left:1.6em}
#preview blockquote{margin:.5em 0;padding:.2em 1em;border-left:3px solid var(--accent);background:var(--bg-elevated);color:var(--text-secondary)}
#preview code{font-family:ui-monospace,Menlo,Consolas,monospace;background:var(--bg-hover);padding:.1em .35em;border-radius:4px;font-size:.9em}
#preview pre{background:var(--code-bg);color:var(--code-fg);padding:12px 14px;border-radius:8px;overflow:auto}
#preview pre code{background:none;color:inherit;padding:0}
#preview table{border-collapse:collapse;margin:.6em 0}#preview th,#preview td{border:1px solid var(--border);padding:5px 10px;text-align:left}
#preview a{color:var(--accent);text-decoration:none}#preview a:hover{text-decoration:underline}
#preview a.wikilink{color:var(--accent);cursor:pointer;border-bottom:1px dotted var(--accent)}
#preview img{max-width:100%;border-radius:8px}
#preview hr{border:0;border-top:1px solid var(--border);margin:1em 0}
#preview .task{list-style:none;margin-left:-1.4em}#preview .task input{margin-right:6px}
#preview .callout{border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:8px;padding:8px 12px;margin:.6em 0;background:var(--bg-elevated)}
#preview .callout .co-title{font-weight:650;text-transform:uppercase;font-size:.8em;letter-spacing:.04em;color:var(--accent);margin-bottom:4px}
#preview .callout .co-body{color:var(--ink)}
#preview .callout.co-note{border-left-color:var(--co-note);background:var(--co-note-bg)}#preview .callout.co-note .co-title{color:var(--co-note)}
#preview .callout.co-tip{border-left-color:var(--co-tip);background:var(--co-tip-bg)}#preview .callout.co-tip .co-title{color:var(--co-tip)}
#preview .callout.co-info{border-left-color:var(--co-info);background:var(--co-info-bg)}#preview .callout.co-info .co-title{color:var(--co-info)}
#preview .callout.co-important{border-left-color:var(--co-important);background:var(--co-important-bg)}#preview .callout.co-important .co-title{color:var(--co-important)}
#preview .callout.co-warning{border-left-color:var(--co-warning);background:var(--co-warning-bg)}#preview .callout.co-warning .co-title{color:var(--co-warning)}
#preview .callout.co-question{border-left-color:var(--co-question);background:var(--co-question-bg)}#preview .callout.co-question .co-title{color:var(--co-question)}
#preview .callout.co-example{border-left-color:var(--co-example);background:var(--co-example-bg)}#preview .callout.co-example .co-title{color:var(--co-example)}
#preview .callout.co-success{border-left-color:var(--co-success);background:var(--co-success-bg)}#preview .callout.co-success .co-title{color:var(--co-success)}
#preview .callout.co-danger{border-left-color:var(--co-danger);background:var(--co-danger-bg)}#preview .callout.co-danger .co-title{color:var(--co-danger)}
#preview .callout .callout-info{display:flex;align-items:center;gap:6px;margin-bottom:4px}
#preview .callout .callout-icon{font-size:.95em;line-height:1}
#preview .callout .callout-title{font-weight:650;text-transform:uppercase;font-size:.8em;letter-spacing:.04em;color:var(--accent)}
#preview .callout .callout-content{color:var(--ink)}#preview .callout .callout-content p{margin:.25em 0}
#preview .callout[data-subtype="NOTE"]{border-left-color:var(--co-note);background:var(--co-note-bg)}#preview .callout[data-subtype="NOTE"] .callout-title{color:var(--co-note)}
#preview .callout[data-subtype="TIP"]{border-left-color:var(--co-tip);background:var(--co-tip-bg)}#preview .callout[data-subtype="TIP"] .callout-title{color:var(--co-tip)}
#preview .callout[data-subtype="INFO"]{border-left-color:var(--co-info);background:var(--co-info-bg)}#preview .callout[data-subtype="INFO"] .callout-title{color:var(--co-info)}
#preview .callout[data-subtype="IMPORTANT"]{border-left-color:var(--co-important);background:var(--co-important-bg)}#preview .callout[data-subtype="IMPORTANT"] .callout-title{color:var(--co-important)}
#preview .callout[data-subtype="WARNING"]{border-left-color:var(--co-warning);background:var(--co-warning-bg)}#preview .callout[data-subtype="WARNING"] .callout-title{color:var(--co-warning)}
#preview .callout[data-subtype="QUESTION"]{border-left-color:var(--co-question);background:var(--co-question-bg)}#preview .callout[data-subtype="QUESTION"] .callout-title{color:var(--co-question)}
#preview .callout[data-subtype="EXAMPLE"]{border-left-color:var(--co-example);background:var(--co-example-bg)}#preview .callout[data-subtype="EXAMPLE"] .callout-title{color:var(--co-example)}
#preview .callout[data-subtype="SUCCESS"]{border-left-color:var(--co-success);background:var(--co-success-bg)}#preview .callout[data-subtype="SUCCESS"] .callout-title{color:var(--co-success)}
#preview .callout[data-subtype="DANGER"]{border-left-color:var(--co-danger);background:var(--co-danger-bg)}#preview .callout[data-subtype="DANGER"] .callout-title{color:var(--co-danger)}
.vditor-ir blockquote.callout[data-subtype="NOTE"]{--callout-color:var(--co-note);--callout-background-color:var(--co-note-bg)}
.vditor-ir blockquote.callout[data-subtype="TIP"]{--callout-color:var(--co-tip);--callout-background-color:var(--co-tip-bg)}
.vditor-ir blockquote.callout[data-subtype="INFO"]{--callout-color:var(--co-info);--callout-background-color:var(--co-info-bg)}
.vditor-ir blockquote.callout[data-subtype="IMPORTANT"]{--callout-color:var(--co-important);--callout-background-color:var(--co-important-bg)}
.vditor-ir blockquote.callout[data-subtype="WARNING"]{--callout-color:var(--co-warning);--callout-background-color:var(--co-warning-bg)}
.vditor-ir blockquote.callout[data-subtype="QUESTION"]{--callout-color:var(--co-question);--callout-background-color:var(--co-question-bg)}
.vditor-ir blockquote.callout[data-subtype="EXAMPLE"]{--callout-color:var(--co-example);--callout-background-color:var(--co-example-bg)}
.vditor-ir blockquote.callout[data-subtype="SUCCESS"]{--callout-color:var(--co-success);--callout-background-color:var(--co-success-bg)}
.vditor-ir blockquote.callout[data-subtype="DANGER"]{--callout-color:var(--co-danger);--callout-background-color:var(--co-danger-bg)}
#preview table{border-collapse:collapse;margin:.6em 0;width:100%}#preview table th,#preview table td{border:1px solid var(--border);padding:6px 10px;text-align:left;font-size:13px}#preview table th{background:var(--bg-hover);font-weight:650}
#preview pre{background:var(--code-bg);color:var(--code-fg);border-radius:8px;padding:12px;overflow:auto;font-size:13px;line-height:1.5}#preview pre code{background:none;color:inherit;font-family:ui-monospace,Menlo,Consolas,monospace}
#preview .footnotes-defs-div{margin-top:1.2em;border-top:1px solid var(--border);padding-top:.5em;font-size:.9em;color:var(--muted)}
#preview .footnotes-defs-ol{padding-left:1.6em;margin:.4em 0}
#preview .footnotes-ref a{color:var(--accent);text-decoration:none}
#preview .vditor-footnotes__goto-ref{margin-left:.4em;text-decoration:none}
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
.spinner{width:16px;height:16px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:-3px}
@keyframes spin{to{transform:rotate(360deg)}}
.check-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13px;cursor:pointer}
.check-row input{margin:0}
.form-label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel)}.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:12px;color:var(--muted)}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:60;display:none}
.toast{padding:9px 16px;border-radius:8px;color:#fff;font-size:13px;box-shadow:0 4px 14px rgba(0,0,0,.15)}
.toast.ok{background:var(--ok)}.toast.err{background:var(--err)}.toast.warn{background:var(--warn)}
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:70;display:flex;align-items:center;justify-content:center}
.modal{background:var(--panel);border-radius:12px;padding:18px;min-width:320px;max-width:520px;box-shadow:0 8px 30px rgba(0,0,0,.25)}
.modal h3{margin:0 0 12px;font-size:15px}.modal input,.modal select,.modal textarea{width:100%;padding:8px;border:1px solid var(--border);border-radius:8px;font-size:13px;margin-bottom:10px;background:var(--panel);color:var(--ink);font-family:inherit;box-sizing:border-box}
.modal input:focus,.modal select:focus,.modal textarea:focus{outline:2px solid var(--accent);outline-offset:0;border-color:var(--accent)}
.modal textarea{min-height:96px;resize:vertical;line-height:1.6}
.modal .modal-actions{display:flex;gap:8px;justify-content:flex-end}
.modal .form{margin-bottom:10px}.modal .form label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
#taskDetailModal .modal{width:880px;max-width:calc(100vw - 64px);max-height:88vh;overflow:hidden;display:flex;flex-direction:column}
@media (max-width:800px){#taskDetailModal .modal{width:calc(100vw - 24px)}}
.task-detail-header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)}
.td-title-input{flex:1;font-size:20px;font-weight:650;padding:8px 10px;border:1px solid transparent;border-radius:8px;background:transparent}
.td-title-input:focus{border-color:var(--accent);background:var(--panel)}
.td-status{width:auto}
.task-detail-body{flex:1;overflow:auto;display:grid;grid-template-columns:minmax(0,1.7fr) minmax(240px,1fr);gap:20px;padding:16px}
@media (max-width:800px){.task-detail-body{grid-template-columns:1fr}}
.task-detail-main{min-width:0}
.task-detail-properties{min-width:0}
.prop-group{margin-bottom:16px}
.prop-title{font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);font-weight:650;margin-bottom:6px;padding-bottom:4px;border-bottom:1px solid var(--border)}
.prop-group label{display:block;font-size:11px;color:var(--muted);margin:6px 0 2px}
.prop-group select,.prop-group input{width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px}
.task-detail-footer{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--border)}
.task-detail-footer .spacer{flex:1}
#tdState.saved{color:var(--ok)}#tdState.dirty{color:var(--warn)}#tdState.saving{color:var(--muted)}
.close-guard-overlay{z-index:95}
.close-guard{width:400px;max-width:calc(100vw - 24px);padding:16px}
.close-guard .toolbar{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.subtask-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;font-size:13px}
.subtask-row:hover{background:var(--bg-hover)}
.subtask-row .nm{flex:1;cursor:pointer}
.subtask-del{opacity:0;cursor:pointer;color:var(--muted);font-size:15px;padding:0 5px;border:0;background:none}
.subtask-row:hover .subtask-del{opacity:1}.subtask-del:hover{color:var(--err)}
.subtask-head{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px;font-weight:650}
.subtask-edit-input{flex:1;padding:4px 6px;border:1px solid var(--accent);border-radius:6px;font-size:13px;font-family:inherit}
.quad-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.quad{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:10px;min-height:140px}
.quad-head{display:flex;align-items:center;gap:8px;padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:6px;font-size:13px}
.quad-head .count{margin-left:auto;font-size:12px;color:var(--muted)}
.quad .empty.small{padding:8px;font-size:12px}
.ctx-menu{position:fixed;z-index:90;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);min-width:160px;padding:4px}
.ctx-item{padding:7px 12px;font-size:13px;cursor:pointer;border-radius:6px}.ctx-item:hover{background:var(--bg-hover)}.ctx-item.danger{color:var(--err)}
.sel-task-btn{position:fixed;z-index:89;background:var(--accent);color:#fff;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;box-shadow:0 3px 10px rgba(0,0,0,.2)}.sel-task-btn:hover{filter:brightness(1.08)}
.sel-toolbar{position:fixed;z-index:89;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 4px 14px rgba(0,0,0,.18);padding:3px;display:flex;gap:2px}
.sel-btn{padding:4px 7px;font-size:12px;cursor:pointer;border-radius:5px;color:var(--ink);min-width:20px;text-align:center}.sel-btn:hover{background:var(--bg-hover)}
.task-card.dragging{opacity:.45}
.drop-over{outline:2px dashed var(--accent);outline-offset:-2px;background:var(--co-note-bg)}
.task-src{margin-left:6px;cursor:pointer;opacity:.65}.task-src:hover{opacity:1}
.task-mv{margin-left:auto;display:inline-flex;gap:2px;opacity:.55}.task-mv span{cursor:pointer;padding:0 5px;border-radius:4px}.task-mv span:hover{background:var(--bg-hover);opacity:1}
mark{background:var(--mark-bg);border-radius:2px;padding:0 2px}
@media (max-width:760px){.quad-grid{grid-template-columns:1fr}}
.wikilink-suggest{position:absolute;z-index:80;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);max-height:240px;overflow:auto;min-width:240px}
.wikilink-suggest .item{padding:7px 12px;cursor:pointer;font-size:13px}.wikilink-suggest .item:hover,.wikilink-suggest .item.sel{background:var(--bg-hover)}
@media(max-width:960px){#app{grid-template-columns:200px 1fr}aside.right{display:none}}
/* Vditor Live (IR) dark adaptation: the editor surface follows the tokens. */
[data-theme="dark"] .vditor,[data-theme="dark"] .vditor-ir,[data-theme="dark"] .vditor-reset{background:var(--bg-surface);color:var(--text-primary)}
[data-theme="dark"] .vditor-toolbar{background:var(--bg-sidebar);border-bottom-color:var(--border)}
[data-theme="dark"] .vditor-toolbar__item{color:var(--text-secondary)}
[data-theme="dark"] .vditor-toolbar__item:hover,[data-theme="dark"] .vditor-toolbar__item--current{background:var(--bg-hover);color:var(--text-primary)}
[data-theme="dark"] .vditor-ir__marker{color:var(--text-muted)}
[data-theme="dark"] .vditor-ir pre.vditor-reset,[data-theme="dark"] .vditor-reset pre{background:var(--code-bg);color:var(--code-fg)}
[data-theme="dark"] .vditor-ir blockquote.callout{background:var(--callout-background-color,var(--bg-elevated))}
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
    <button id="themeBtn" class="langbtn" title="Appearance / 外观">◐</button>
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
    overview:'总览', notes:'笔记', attachments:'附件库', tasks:'待办', trash:'回收站', search:'搜索',
    searchPlaceholder:'搜索知识库 (hybrid search)…', workspaceLabel:'工作区', localSummary:'本地: {n} 笔记 · {m} 文件',
    connected:'已连接', unavailable:'不可用', notConfigured:'未配置', error:'错误',
    overviewTitle:'工作区概览', overviewNotes:'笔记', overviewAttachments:'附件', overviewMappings:'已同步对象', overviewPendingSync:'待同步', overviewSyncErrors:'同步错误',
    overviewIntegration:'WeKnora 集成', overviewRecent:'最近更新', overviewEmpty:'工作区为空。点击「新建笔记」开始。', recentNote:'笔记', recentAttachment:'附件', noRecent:'暂无最近更新',
    newNote:'新建笔记', newFolder:'新建文件夹', emptyNotes:'还没有笔记。', emptyNotesCta:'新建第一篇笔记', loading:'加载中…', deletedSuffix:'已删除',
    save:'保存', renameMove:'重命名 / 移动', del:'删除', syncNow:'立即同步', reconcile:'重建索引', localSaved:'本地已保存', localSavedR:'本地已保存 · r{r}', saving:'保存中…',
    unsaved:'未保存', saved:'已保存', saveFailed:'保存失败',
    preview:'预览', newNotePrompt:'笔记标题（路径自动生成）', renamePrompt:'新相对路径', delNoteConfirm:'删除这篇笔记？', deletedMsg:'已删除', selectNote:'从左侧选择或新建一篇笔记。',
    untitled:'untitled', notSynced:'未同步', synced:'已同步', syncing:'同步中', pending:'待同步', failed:'失败', stale:'已过期', deleted:'已删除',
    upload:'上传文件', emptyAttachments:'还没有附件。', attachmentsDesc:'管理笔记中上传的文件。', size:'大小', download:'下载', delAttachmentConfirm:'删除该附件？', attachmentDetailHint:'选中附件查看详情。',
    newMatrix:'新建四象限', smartViews:'智能视图', matrices:'四象限',
    copyWikiLink:'复制 Wiki 链接', taskComplete:'完成', taskReopen:'重新打开', taskDuplicate:'复制任务', taskDelete:'删除任务', matrixArchive:'归档', matrixRemove:'删除四象限', matrixRemoveConfirm:'删除该四象限？其全部任务将移回 Inbox。',
    matrixDeleting:'正在删除四象限', matrixMovingTasks:'正在将 {n} 个任务移回 Inbox，然后删除该四象限…', matrixDeleted:'已将 {n} 个任务移回 Inbox，并删除四象限。', matrixDeleteFailed:'删除四象限失败', retry:'重试',
    themeSystem:'跟随系统', themeLight:'浅色', themeDark:'深色',
    companionNote:'建立伴随笔记', noteLocation:'笔记位置', kbIndex:'知识库索引', kbIndexHint:'索引可解析附件', uploadedNoNote:'文件已上传，但伴随笔记创建失败', uploadedCompanion:'已生成 {n} 篇伴随笔记',
    uploadProgress:'上传中…', uploadSuccess:'已上传', uploadFailed:'上传失败', searching:'搜索中…', noHits:'没有命中「{q}」。', searchHint:'输入关键词搜索本地笔记与附件（经 WeKnora hybrid search）。',
    score:'得分', openNote:'打开笔记', openAttachment:'打开附件', externalWeKnora:'WeKnora 外部', noteLabel:'笔记', attachmentLabel:'附件',
    details:'详情', noteId:'NoteId', attachmentId:'AttachmentId', path:'路径', revision:'版本', updated:'更新时间', lastError:'最近错误', maintenance:'维护', advanced:'高级',
    workspaceSummary:'工作区摘要', kb:'知识库', state:'状态', parse:'解析', syncSection:'WeKnora 同步', noSyncInfo:'尚未同步。',
    reconcileDone:'重建完成', reconcileResult:'笔记修复 {a} · 附件修复 {b} · 待同步 {c} · 已删 {d}', syncingAll:'正在同步…', genericError:'操作失败', ok:'完成', emptyPreview:'（空）', searchFailed:'搜索失败',
    folder:'文件夹', rootFolder:'（根目录）', newNoteHere:'在此新建笔记', newSubfolder:'新建子文件夹', renameFolder:'重命名', moveTo:'移动到…', deleteFolder:'删除文件夹', trashFolder:'移入回收站',
    folderTrashTitle:'此文件夹包含 {n} 个笔记 · {m} 个子文件夹', folderTrashWhole:'整个文件夹和全部内容移入回收站', folderTrashKeep:'保留内容：移到上一级，仅删除当前文件夹',
    folderRenamePrompt:'新文件夹名称', folderDeleteConfirm:'删除文件夹「{n}」？', folderNotEmpty:'文件夹不为空，无法删除。', moveNoteTo:'移动笔记到', moveUp:'上移', moveDown:'下移',
    sortMode:'排序', sortManual:'手动', sortTitle:'标题', sortUpdated:'更新时间', cancel:'取消', createFolderPrompt:'文件夹名称', folderCreated:'文件夹已创建', selectFolder:'选择一个文件夹。',
    modeLive:'实时预览', modeSource:'源码', modeReading:'阅读',
    properties:'属性', tags:'标签', title:'标题', outline:'大纲', backlinks:'反向链接', noOutline:'暂无标题', noBacklinks:'暂无反向链接',
    wikiPlaceholder:'输入 [[ 引用其他笔记', autosaveFailed:'自动保存失败', externalModified:'文件已在外部修改。选择「重载」使用磁盘版本，或「保留我的」继续编辑。', reload:'重载', keepMine:'保留我的',
    quickSwitch:'快速切换笔记', typeToSearch:'输入标题或路径…',
    taskAll:'全部任务', taskToday:'今日', taskUpcoming:'即将到来', taskCompleted:'已完成', taskInbox:'收件箱（未分类）',
    q1:'重要且紧急', q2:'重要不紧急', q3:'紧急不重要', q4:'不紧急不重要',
    taskQuickAdd:'快速添加任务', taskTitle:'标题', taskMatrix:'矩阵', taskQuadrant:'象限', taskPriority:'优先级', taskDue:'截止日期', taskSave:'创建', taskCancel:'取消', taskSaveEdit:'保存', taskClose:'关闭',
    noteToTask:'笔记 → 待办', selectionToTask:'选区 → 待办', taskNoTasks:'暂无任务。', taskTomorrow:'明天', taskYesterday:'昨天', taskOverdue:'已逾期',
    slashH1:'一级标题', slashH2:'二级标题', slashH3:'三级标题', slashList:'无序列表', slashTask:'任务列表', slashQuote:'引用', slashCalloutNote:'提示框', slashCalloutWarning:'警告框', slashTable:'表格', slashHr:'分割线',
    slashInlineCode:'行内代码', slashCodeBlock:'代码块', slashLink:'链接', slashWikiLink:'Wiki 链接', slashImage:'图片', slashFootnote:'脚注', slashCallout:'提示框',
    editorLoading:'正在加载编辑器…', buildInfo:'构建信息', bold:'加粗', italic:'斜体', strike:'删除线', highlight:'高亮',
    taskDetail:'任务详情', description:'描述', taskStatus:'状态', taskOpen:'进行中', taskScheduled:'计划日期', taskCreated:'创建', subtasks:'子任务', subtaskAdd:'添加子任务…',
    descriptionPlaceholder:'添加描述…', tagsPlaceholder:'输入标签，用逗号分隔', organization:'组织', time:'时间', info:'信息', closeGuardTitle:'有未保存的修改', closeGuardBody:'你对这个任务的修改还没有保存。', saveAndClose:'保存并关闭', discard:'放弃修改',
    tableRowAbove:'上方插入行', tableRowBelow:'下方插入行', tableColLeft:'左侧插入列', tableColRight:'右侧插入列',
    tableAlignLeft:'左对齐', tableAlignCenter:'居中对齐', tableAlignRight:'右对齐',
    tableDeleteRow:'删除当前行', tableDeleteCol:'删除当前列', tableDeleteTable:'删除表格', tableInsertSize:'插入表格',
    footnote:'脚注', footnoteContent:'脚注内容', footnoteInsert:'插入脚注', footnoteEdit:'编辑脚注', footnoteJump:'跳转到脚注', footnoteDelete:'删除脚注', footnoteBack:'回到引用', footnoteSelectText:'选中文字后插入脚注', footnoteEmpty:'（未选中文字，将在光标处插入引用）',
    trashAll:'全部', trashNotes:'笔记', trashFolders:'文件夹', trashAttachments:'附件', trashTypeFilter:'类型',
    trashEmptyTrash:'清空回收站', trashSelectAll:'全选', trashSelected:'已选择 {n} 项', trashRestore:'恢复', trashPermanentDelete:'永久删除', trashClearSelection:'取消选择',
    trashEmptyTitle:'回收站为空', trashEmptyBody:'删除的笔记、文件夹和附件会出现在这里。',
    trashEmptyConfirmTitle:'清空回收站？', trashEmptyConfirmBody:'回收站中的全部 {n} 项内容将被永久删除，此操作无法撤销。',
    trashEmptyConfirmStats:'笔记 {n} · 文件夹 {f} · 附件 {a}',
    trashPurgeConfirmTitle:'永久删除 {n} 项？', trashPurgeConfirmBody:'这些内容删除后无法从 PKW 回收站恢复。',
    trashRestoring:'正在恢复…', trashDeleting:'正在删除…', trashEmptied:'回收站已清空', trashRestored:'已恢复 {n} 项', trashRestoredPartial:'已恢复 {n} 项，{m} 项失败', trashPurged:'已永久删除 {n} 项', trashPurgedPartial:'已永久删除 {n} 项，{m} 项失败', trashDeletedTime:'删除于 {t}',
  },
  en: {
    overview:'Overview', notes:'Notes', attachments:'Attachment library', tasks:'Tasks', trash:'Trash', search:'Search',
    searchPlaceholder:'Search knowledge base (hybrid search)…', workspaceLabel:'Workspace', localSummary:'Local: {n} notes · {m} files',
    connected:'Connected', unavailable:'Unavailable', notConfigured:'Not configured', error:'error',
    overviewTitle:'Workspace Overview', overviewNotes:'Notes', overviewAttachments:'Attachments', overviewMappings:'Synced objects', overviewPendingSync:'Pending sync', overviewSyncErrors:'Sync errors',
    overviewIntegration:'WeKnora integration', overviewRecent:'Recent', overviewEmpty:'Workspace is empty. Click 「New Note」 to start.', recentNote:'Note', recentAttachment:'Attachment', noRecent:'No recent changes',
    newNote:'New Note', newFolder:'New Folder', emptyNotes:'No notes yet.', emptyNotesCta:'Create your first note', loading:'Loading…', deletedSuffix:'deleted',
    save:'Save', renameMove:'Rename / Move', del:'Delete', syncNow:'Sync now', reconcile:'Reconcile', localSaved:'Local saved', localSavedR:'Local saved · r{r}', saving:'Saving…',
    unsaved:'Unsaved', saved:'Saved', saveFailed:'Save failed',
    preview:'Preview', newNotePrompt:'Note title (path is auto-generated)', renamePrompt:'New relative path', delNoteConfirm:'Delete this note?', deletedMsg:'Deleted', selectNote:'Select or create a note from the left.',
    untitled:'untitled', notSynced:'Not synced', synced:'Synced', syncing:'Syncing', pending:'Pending', failed:'Failed', stale:'Stale', deleted:'Deleted',
    upload:'Upload file', emptyAttachments:'No attachments yet.', attachmentsDesc:'Manage files uploaded in notes.', size:'Size', download:'Download', delAttachmentConfirm:'Delete this attachment?', attachmentDetailHint:'Select an attachment to view details.',
    newMatrix:'New matrix', smartViews:'Smart views', matrices:'Matrices',
    copyWikiLink:'Copy wiki link', taskComplete:'Complete', taskReopen:'Reopen', taskDuplicate:'Duplicate task', taskDelete:'Delete task', matrixArchive:'Archive', matrixRemove:'Delete matrix', matrixRemoveConfirm:'Delete this matrix? All its tasks will move back to Inbox.',
    matrixDeleting:'Deleting matrix', matrixMovingTasks:'Moving {n} tasks back to Inbox, then deleting this matrix…', matrixDeleted:'Moved {n} tasks back to Inbox and deleted the matrix.', matrixDeleteFailed:'Failed to delete matrix', retry:'Retry',
    themeSystem:'Follow system', themeLight:'Light', themeDark:'Dark',
    companionNote:'Create companion note', noteLocation:'Note location', kbIndex:'Knowledge indexing', kbIndexHint:'Index parseable attachments', uploadedNoNote:'File uploaded, but companion note creation failed', uploadedCompanion:'Created {n} companion notes',
    uploadProgress:'Uploading…', uploadSuccess:'Uploaded', uploadFailed:'Upload failed', searching:'Searching…', noHits:'No hits for 「{q}」.', searchHint:'Type a query to search notes & attachments (via WeKnora hybrid search).',
    score:'score', openNote:'Open note', openAttachment:'Open attachment', externalWeKnora:'external WeKnora', noteLabel:'Note', attachmentLabel:'Attachment',
    details:'Details', noteId:'NoteId', attachmentId:'AttachmentId', path:'Path', revision:'Revision', updated:'Updated', lastError:'Last error', maintenance:'Maintenance', advanced:'Advanced',
    workspaceSummary:'Workspace summary', kb:'KB', state:'State', parse:'Parse', syncSection:'WeKnora Sync', noSyncInfo:'Not synced yet.',
    reconcileDone:'Reconcile done', reconcileResult:'Notes repaired {a} · attachments repaired {b} · dirty {c} · deleted {d}', syncingAll:'Syncing…', genericError:'Operation failed', ok:'Done', emptyPreview:'(empty)', searchFailed:'Search failed',
    folder:'Folder', rootFolder:'(root)', newNoteHere:'New note here', newSubfolder:'New subfolder', renameFolder:'Rename', moveTo:'Move to…', deleteFolder:'Delete folder', trashFolder:'Move to trash',
    folderTrashTitle:'This folder contains {n} notes · {m} subfolders', folderTrashWhole:'Move the whole folder and all contents to trash', folderTrashKeep:'Keep contents: move to parent, delete only this folder',
    folderRenamePrompt:'New folder name', folderDeleteConfirm:'Delete folder 「{n}」?', folderNotEmpty:'Folder is not empty and cannot be deleted.', moveNoteTo:'Move note to', moveUp:'Move up', moveDown:'Move down',
    sortMode:'Sort', sortManual:'Manual', sortTitle:'Title', sortUpdated:'Updated', cancel:'Cancel', createFolderPrompt:'Folder name', folderCreated:'Folder created', selectFolder:'Select a folder.',
    modeLive:'Live Preview', modeSource:'Source', modeReading:'Reading',
    properties:'Properties', tags:'Tags', title:'Title', outline:'Outline', backlinks:'Backlinks', noOutline:'No headings', noBacklinks:'No backlinks',
    wikiPlaceholder:'Type [[ to reference another note', autosaveFailed:'Autosave failed', externalModified:'File changed externally. Choose 「Reload」 for the disk version or 「Keep mine」 to continue editing.', reload:'Reload', keepMine:'Keep mine',
    quickSwitch:'Quick switch note', typeToSearch:'Type a title or path…',
    taskAll:'All tasks', taskToday:'Today', taskUpcoming:'Upcoming', taskCompleted:'Completed', taskInbox:'Inbox (unassigned)',
    q1:'Important & Urgent', q2:'Important, Not Urgent', q3:'Urgent, Not Important', q4:'Not Urgent, Not Important',
    taskQuickAdd:'Quick add task', taskTitle:'Title', taskMatrix:'Matrix', taskQuadrant:'Quadrant', taskPriority:'Priority', taskDue:'Due date', taskSave:'Create', taskCancel:'Cancel', taskSaveEdit:'Save', taskClose:'Close',
    noteToTask:'Note → Task', selectionToTask:'Selection → Task', taskNoTasks:'No tasks yet.', taskTomorrow:'Tomorrow', taskYesterday:'Yesterday', taskOverdue:'Overdue',
    slashH1:'Heading 1', slashH2:'Heading 2', slashH3:'Heading 3', slashList:'Bullet list', slashTask:'Task list', slashQuote:'Quote', slashCalloutNote:'Callout', slashCalloutWarning:'Warning', slashTable:'Table', slashHr:'Divider',
    slashInlineCode:'Inline code', slashCodeBlock:'Code block', slashLink:'Link', slashWikiLink:'Wiki link', slashImage:'Image', slashFootnote:'Footnote', slashCallout:'Callout',
    editorLoading:'Loading editor…', buildInfo:'Build info', bold:'Bold', italic:'Italic', strike:'Strikethrough', highlight:'Highlight',
    taskDetail:'Task detail', description:'Description', taskStatus:'Status', taskOpen:'Open', taskScheduled:'Scheduled', taskCreated:'Created', subtasks:'Subtasks', subtaskAdd:'Add subtask…',
    descriptionPlaceholder:'Add description…', tagsPlaceholder:'Enter tags, comma separated', organization:'Organization', time:'Time', info:'Info', closeGuardTitle:'Unsaved changes', closeGuardBody:'Your changes to this task are not saved yet.', saveAndClose:'Save & close', discard:'Discard changes',
    tableRowAbove:'Insert row above', tableRowBelow:'Insert row below', tableColLeft:'Insert column left', tableColRight:'Insert column right',
    tableAlignLeft:'Align left', tableAlignCenter:'Align center', tableAlignRight:'Align right',
    tableDeleteRow:'Delete row', tableDeleteCol:'Delete column', tableDeleteTable:'Delete table', tableInsertSize:'Insert table',
    footnote:'Footnote', footnoteContent:'Footnote content', footnoteInsert:'Insert footnote', footnoteEdit:'Edit footnote', footnoteJump:'Jump to footnote', footnoteDelete:'Delete footnote', footnoteBack:'Back to reference', footnoteSelectText:'Select text then insert footnote', footnoteEmpty:'(no selection — reference inserted at cursor)',
    trashAll:'All', trashNotes:'Notes', trashFolders:'Folders', trashAttachments:'Attachments', trashTypeFilter:'Type',
    trashEmptyTrash:'Empty Trash', trashSelectAll:'Select all', trashSelected:'{n} selected', trashRestore:'Restore', trashPermanentDelete:'Delete permanently', trashClearSelection:'Clear selection',
    trashEmptyTitle:'Trash is empty', trashEmptyBody:'Deleted notes, folders and attachments will appear here.',
    trashEmptyConfirmTitle:'Empty Trash?', trashEmptyConfirmBody:'All {n} items in Trash will be permanently deleted. This cannot be undone.',
    trashEmptyConfirmStats:'{n} notes · {f} folders · {a} attachments',
    trashPurgeConfirmTitle:'Delete {n} items permanently?', trashPurgeConfirmBody:'These items cannot be restored from Trash afterwards.',
    trashRestoring:'Restoring…', trashDeleting:'Deleting…', trashEmptied:'Trash emptied', trashRestored:'Restored {n} items', trashRestoredPartial:'Restored {n} items, {m} failed', trashPurged:'Deleted {n} items permanently', trashPurgedPartial:'Deleted {n} items permanently, {m} failed', trashDeletedTime:'Deleted {t}',
  },
}
const PKW_BUILD = '1d93f55'
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
  tasksCache: [],
  matricesCache: [],
  attachmentsCache: [],
  trashCache: null,
  summaryCache: null,
  scroll: { main: {}, list: {} },
  trashSelection: new Set(),
  trashFilter: 'all',
  trashBusy: false,
}
// ── View switching: navigation guard + single-flight + instrumentation ──────
let viewSeq = 0
let viewStart = 0
const inFlight = {}
function loadOnce(method, args){
  const key = method + ':' + JSON.stringify(args || {})
  if (inFlight[key]) return inFlight[key]
  const p = api(method, args).finally(() => { if (inFlight[key] === p) delete inFlight[key] })
  inFlight[key] = p
  return p
}
function invalidateLoad(method){
  const prefix = method + ':'
  Object.keys(inFlight).forEach(k => { if (k.indexOf(prefix) === 0) delete inFlight[k] })
}
// Mutation-triggered refresh: bypass a possibly-stale in-flight fetch so the
// post-mutation data is authoritative (Local mutation is an event, not polling).
function refreshTasks(){ invalidateLoad('listTasks'); invalidateLoad('listMatrices'); renderTasks() }
function refreshAttachments(){ invalidateLoad('listAttachments'); renderAttachments() }
function refreshTrash(){ invalidateLoad('listTrash'); invalidateLoad('listTrashAttachments'); invalidateLoad('listTrashFolders'); renderTrash() }
function viewMark(phase, extra){
  console.debug('[pkw.view] view=' + state.view + ' phase=' + phase + ' ms=' + Math.round(performance.now() - viewStart) + (extra ? ' ' + extra : ''))
}
// Per-view scroll memory: a view is a projection, so switching back should
// restore where the user was (main + left list), not reset to top.
function saveScroll(view){
  const m = $('#main'), l = $('#list')
  state.scroll.main[view] = m ? m.scrollTop : 0
  state.scroll.list[view] = l ? l.scrollTop : 0
}
function restoreScroll(){
  const m = $('#main'), l = $('#list')
  if (m && state.scroll.main[state.view] !== undefined) m.scrollTop = state.scroll.main[state.view]
  if (l && state.scroll.list[state.view] !== undefined) l.scrollTop = state.scroll.list[state.view]
}

function toast(msg, kind){ const el = $('#toast'); el.innerHTML = '<div class="toast ' + (kind || 'ok') + '">' + esc(msg) + '</div>'; el.style.display = 'block'; clearTimeout(toast._t); toast._t = setTimeout(() => { el.style.display = 'none' }, 3200) }
function applyLang(){ document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; $('#search').placeholder = t('searchPlaceholder'); $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'; document.querySelectorAll('.nav button').forEach(b => b.textContent = t(b.dataset.view)) }
// ── Theme (system / light / dark) — preference in localStorage, tokens in CSS ──
function currentThemeMode(){ return localStorage.getItem('pkw-theme') || 'system' }
function applyTheme(mode){
  const m = mode || currentThemeMode()
  const dark = m === 'dark' || (m === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light')
  const btn = $('#themeBtn')
  if (btn) btn.textContent = dark ? '◑' : '◐'
}
function setTheme(mode){ localStorage.setItem('pkw-theme', mode); applyTheme(mode) }
function showAppearanceMenu(x, y){
  const items = [
    { label: (currentThemeMode() === 'system' ? '✓ ' : '') + t('themeSystem'), action: 'theme-system' },
    { label: (currentThemeMode() === 'light' ? '✓ ' : '') + t('themeLight'), action: 'theme-light' },
    { label: (currentThemeMode() === 'dark' ? '✓ ' : '') + t('themeDark'), action: 'theme-dark' },
  ]
  showContextMenu(x, y, items)
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
  saveScroll(state.view)
  state.view = v
  viewSeq++
  viewStart = performance.now()
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
function renderOverviewFrom(s){
  const integ = s.integration === 'ready'
  const rows = [
    '<div class="stat"><div class="n">' + s.notes + '</div><div class="l">' + esc(t('overviewNotes')) + '</div></div>',
    '<div class="stat"><div class="n">' + s.attachments + '</div><div class="l">' + esc(t('overviewAttachments')) + '</div></div>',
    '<div class="stat"><div class="n">' + s.mappings + '</div><div class="l">' + esc(t('overviewMappings')) + '</div></div>',
    '<div class="stat"><div class="n">' + s.pendingSync + '</div><div class="l">' + esc(t('overviewPendingSync')) + '</div></div>',
    '<div class="stat"><div class="n">' + s.syncErrors + '</div><div class="l">' + esc(t('overviewSyncErrors')) + '</div></div>',
  ]
  const integBadge = '<span class="badge ' + (integ ? 'ok' : 'warn') + '">' + (integ ? t('connected') : (s.credential === 'configured' ? t('unavailable') : t('notConfigured'))) + '</span>'
  const recentHtml = (s.recent || []).length ? (s.recent || []).map(r => '<div class="tree-row" data-action="' + (r.kind === 'note' ? 'open-note' : 'open-attachment') + '" data-id="' + esc(r.id) + '"><span class="nm">' + esc(r.title) + '</span></div>').join('') : '<div class="empty">' + esc(t('noRecent')) + '</div>'
  $('#main').innerHTML = '<h2>' + esc(t('overviewTitle')) + '<span class="sub">' + esc(s.workspaceName || '') + '</span></h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-note">+ ' + esc(t('newNote')) + '</button><button class="btn" data-action="sync-now">' + esc(t('syncNow')) + '</button><button class="btn" data-action="reconcile">' + esc(t('reconcile')) + '</button></div>' +
    '<div class="stats">' + rows.join('') + '</div><h2>' + esc(t('overviewIntegration')) + '</h2>' + integBadge + '<h2 style="margin-top:16px">' + esc(t('overviewRecent')) + '</h2>' + recentHtml
  $('#detail').innerHTML = detailWorkspace(s)
  restoreScroll()
}
async function renderOverview(){
  const seq = viewSeq
  $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''
  if (state.summaryCache) { renderOverviewFrom(state.summaryCache); viewMark('warm-paint', 'cache=hit') }
  else { $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; $('#detail').innerHTML = ''; viewMark('shell', 'cache=miss') }
  try {
    const s = await loadOnce('summary', {})
    if (seq !== viewSeq) return // stale navigation guard
    state.summaryCache = s
    renderOverviewFrom(s)
    viewMark('data-ready')
  } catch (e) { if (seq === viewSeq) $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}
function detailWorkspace(s){
  return '<h3>' + esc(t('workspaceSummary')) + '</h3><div class="kv"><b>' + esc(t('workspaceLabel')) + '</b> <span class="v">' + esc(s.workspaceName || '—') + '</span></div>' +
    '<div class="kv"><b>WorkspaceId</b> <span class="v mono">' + esc(s.workspaceId || '') + '</span></div>' +
    '<h3>' + esc(t('buildInfo')) + '</h3><div class="kv"><b>PKW</b> <span class="v mono">' + esc(PKW_BUILD) + '</span></div>' +
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
    restoreScroll()
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
  out = out.replace(/==([^=]+)==/g, '<mark>$1</mark>')
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
      if (callout) {
        const icons = { note: '📝', tip: '💡', info: 'ℹ️', important: '⭐', warning: '⚠️', question: '❓', example: '🧪', success: '✅', danger: '🔥' }
        html.push('<div class="callout co-' + esc(callout) + '"><div class="co-title">' + (icons[callout] || '📌') + ' ' + esc(callout.toUpperCase()) + '</div><div class="co-body">' + q.map(renderInline).join('<br>') + '</div></div>')
      }
      else html.push('<blockquote>' + q.map(renderInline).join('<br>') + '</blockquote>')
      continue
    }
    // Fenced code block
    if (line.trimStart().charCodeAt(0) === 96 && line.trimStart().charCodeAt(1) === 96 && line.trimStart().charCodeAt(2) === 96) {
      const lang = line.trim().slice(3).trim()
      const code = []
      i++
      while (i < lines.length && !(lines[i].trimStart().charCodeAt(0) === 96 && lines[i].trimStart().charCodeAt(1) === 96 && lines[i].trimStart().charCodeAt(2) === 96)) { code.push(lines[i]); i++ }
      i++
      html.push('<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(code.join('\\n')) + '</code></pre>')
      continue
    }
    // GFM table
    if (/^\\|.*\\|$/.test(line.trim()) && i + 1 < lines.length && /^\\|[\\s:|-]+\\|$/.test(lines[i + 1].trim())) {
      const tbl = []
      while (i < lines.length && /^\\|.*\\|$/.test(lines[i].trim())) { tbl.push(lines[i].trim()); i++ }
      html.push(renderTableMd(tbl))
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
function renderTableMd(tblLines){
  const parse = (l) => l.replace(/^\\|/, '').replace(/\\|$/, '').split('\\|').map(c => c.trim())
  const header = parse(tblLines[0] || '')
  const aligns = parse(tblLines[1] || '').map(c => c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : 'left')
  const rows = tblLines.slice(2).map(parse)
  const th = header.map((c, i) => '<th style="text-align:' + aligns[i] + '">' + renderInline(c) + '</th>').join('')
  const trs = rows.map(r => '<tr>' + r.map((c, i) => '<td style="text-align:' + aligns[i] + '">' + renderInline(c) + '</td>').join('') + '</tr>').join('')
  return '<table><thead><tr>' + th + '</tr></thead><tbody>' + trs + '</tbody></table>'
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
    state.editor = { noteId, persistedMarkdown: d.markdown, body: d.body || '', frontmatter: d.frontmatter || '', dirty: false, saving: false, mode: localStorage.getItem('pkw-editor-mode') || 'live', observedRevision: d.note && d.note.observedRevision, contentHash: d.note && d.note.contentHash }
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
      (mode === 'live' ? '<div id="vditor" style="min-height:56vh"><div class="empty">' + esc(t('editorLoading')) + '</div></div>' : '') +
      (mode === 'source' ? '<textarea id="editor" aria-label="Markdown">' + esc(d.markdown) + '</textarea>' : '') +
      (mode === 'reading' ? '<div id="preview"></div>' : '') +
    '</div>'
}
function bindEditor(){
  if (state.editor.mode === 'live') initVditor()
  else if (state.editor.mode === 'source') { const el = $('#editor'); if (el) { el.addEventListener('input', onEditorInput); el.addEventListener('keyup', wikiAutocomplete) } }
  else renderPreview()
}
// Wiki-link autocomplete (Source mode only). IR/Live mode is NOT covered here:
// Vditor's hint.extend matches a single trigger key ('['), and reliably
// detecting '[[' inside IR's contenteditable would need fragile DOM/selection
// hacks we cannot browser-verify in this session — so it is deferred by design.
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
// Vditor lazy loader: assets load ONLY on first entry into Live mode, once per
// page lifecycle. Overview/Tasks/Trash/Search/Attachments/Source never fetch them.
let vditorLoadPromise = null
function loadScript(src){
  return new Promise((resolve, reject) => {
    const s = document.createElement('script'); s.src = src
    s.onload = () => resolve(); s.onerror = () => reject(new Error('load failed: ' + src))
    document.head.appendChild(s)
  })
}
function loadCss(href){
  return new Promise((resolve) => {
    const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href
    l.onload = () => resolve(); l.onerror = () => resolve()
    document.head.appendChild(l)
  })
}
function ensureVditorLoaded(){
  if (window.Vditor) return Promise.resolve()
  if (vditorLoadPromise) return vditorLoadPromise
  vditorLoadPromise = Promise.all([
    loadCss('/pkw/assets/vditor/3.11.3/dist/index.css'),
    loadScript('/pkw/assets/vditor/3.11.3/dist/js/lute/lute.min.js'),
    loadScript('/pkw/assets/vditor/3.11.3/dist/index.min.js'),
  ]).then(() => { if (!window.Vditor) throw new Error('Vditor failed to initialize') })
  return vditorLoadPromise
}
async function initVditor(){
  const el = $('#vditor')
  if (!el) return
  if (vditor) { try { vditor.destroy() } catch (e) {} vditor = null }
  try {
    await ensureVditorLoaded()
    if (!el.isConnected) return // editor torn down while assets were loading
    vditor = new window.Vditor(el, {
      mode: 'ir',
      cache: { enable: false },
      cdn: '/pkw/assets/vditor/3.11.3',
      height: '56vh',
      value: state.editor.body || '',
      toolbar: vditorToolbar(),
      hint: {
        parse: false,
        delay: 0,
        extend: [{ key: '/', hint: () => slashMenu() }],
      },
      upload: { handler: (files) => { uploadVditorFiles(files, true) } },
      input: () => { onEditorInput() },
    })
  } catch (e) {
    el.innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>'
  }
}
function vditorToolbar(){
  const calloutTypes = ['NOTE', 'TIP', 'INFO', 'IMPORTANT', 'WARNING', 'QUESTION', 'EXAMPLE', 'SUCCESS', 'DANGER']
  const ic = (s) => '<span style="font-size:13px;line-height:1">' + s + '</span>'
  return [
    'undo', 'redo', '|',
    'headings', '|',
    'bold', 'italic', 'strike', 'mark', '|',
    'list', 'ordered-list', 'check', '|',
    'quote',
    { name: 'callout', tip: t('slashCallout'), icon: ic('💡'), toolbar: calloutTypes.map(ty => ({ name: 'callout-' + ty, tip: ty, icon: ic('💡'), click: (_e, vd) => vd.insertValue('> [!' + ty + ']\\n> ') })) },
    '|',
    'link',
    { name: 'wikilink', tip: t('slashWikiLink'), icon: ic('🔗'), click: (_e, vd) => vd.insertValue('[[note]]') },
    '|',
    'upload',
    { name: 'attachment', tip: t('attachmentLabel'), icon: ic('📎'), click: () => pickAttachment() },
    '|',
    { name: 'table', tip: t('tableInsertSize'), icon: ic('⊞'), click: () => tableToolbarClick() },
    '|',
    'inline-code', 'code', '|',
    { name: 'divider', tip: t('slashHr'), icon: ic('—'), click: (_e, vd) => vd.insertValue('---\\n') },
    { name: 'footnote', tip: t('footnote'), icon: ic('①'), click: () => footnoteDialog() },
    '|',
    'outline',
  ]
}
function pickAttachment(){
  const inp = document.createElement('input')
  inp.type = 'file'; inp.multiple = true
  inp.onchange = () => { if (inp.files && inp.files.length) uploadVditorFiles(inp.files, false) }
  inp.click()
}
function slashMenu(){
  const callout = (type) => ({ html: '💡 ' + esc(t('slashCallout')) + '·' + type, value: '> [!' + type + ']\\n> ' })
  return [
    { html: 'Ｈ1 · ' + esc(t('slashH1')), value: '# ' },
    { html: 'Ｈ2 · ' + esc(t('slashH2')), value: '## ' },
    { html: 'Ｈ3 · ' + esc(t('slashH3')), value: '### ' },
    { html: '• ' + esc(t('slashList')), value: '- ' },
    { html: '☐ ' + esc(t('slashTask')), value: '- [ ] ' },
    { html: '❝ ' + esc(t('slashQuote')), value: '> ' },
    { html: '⟨⟩ ' + esc(t('slashInlineCode')), value: '\\u0060code\\u0060' },
    { html: '⟨⟩⟨⟩ ' + esc(t('slashCodeBlock')), value: '\\u0060\\u0060\\u0060\\n\\u0060\\u0060\\u0060' },
    { html: '🔗 ' + esc(t('slashLink')), value: '[text](url)' },
    { html: '🔗 ' + esc(t('slashWikiLink')), value: '[[note]]' },
    { html: '🖼 ' + esc(t('slashImage')), value: '![alt](url)' },
    { html: '① ' + esc(t('slashFootnote')), value: '[^1]' },
    callout('NOTE'),
    callout('TIP'),
    callout('INFO'),
    callout('IMPORTANT'),
    callout('WARNING'),
    callout('QUESTION'),
    callout('EXAMPLE'),
    callout('SUCCESS'),
    callout('DANGER'),
    { html: '⊞ ' + esc(t('slashTable')), value: '|  |  |\\n| --- | --- |\\n|  |  |\\n' },
    { html: '— ' + esc(t('slashHr')), value: '---\\n' },
  ]
}
function uploadVditorFiles(files, asImage){
  for (const file of files) {
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1]
      api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64 }).then(up => {
        const ref = 'attachments/' + up.attachmentId + '/' + file.name
        const md = asImage === false ? '[' + file.name + '](' + ref + ')' : '![](' + ref + ')'
        if (vditor) vditor.insertValue(md)
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
function applyPreviewHighlight(pv){
  const q = state.highlightText
  if (!q) return
  state.highlightText = ''
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
}
function renderPreview(){
  const fm = parseFrontmatterClient(state.editor.persistedMarkdown || '')
  const pv = $('#preview')
  if (!pv) return
  const body = fm.body
  const finish = () => applyPreviewHighlight(pv)
  // First paint: synchronous homemade fallback (instant), then the canonical
  // Host Lute render replaces it. On Lute failure the fallback stays.
  pv.innerHTML = renderMarkdown(body) || '<span class="muted">' + esc(t('emptyPreview')) + '</span>'
  if (!body.trim()) { finish(); return }
  api('renderMarkdown', { markdown: body }).then(html => {
    if (!pv.isConnected) return
    pv.innerHTML = html || '<span class="muted">' + esc(t('emptyPreview')) + '</span>'
    finish()
  }).catch(() => { finish() })
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
async function renameNote(noteId){
  const id = noteId || state.selectedNoteId
  if (id === null) return
  const cur = await api('getNote', { noteId: id })
  const rel = prompt(t('renamePrompt'), cur.note.relativePath)
  if (!rel || rel === cur.note.relativePath) return
  try { await api('moveNote', { noteId: id, relativePath: rel }); await renderTree(); if (state.selectedNoteId === id) await openNote(id) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
async function delNote(noteId){
  const id = noteId || state.selectedNoteId
  if (id === null) return
  if (!confirm(t('delNoteConfirm'))) return
  try {
    await api('deleteNote', { noteId: id })
    if (state.selectedNoteId === id) { state.selectedNoteId = null; state.editor = { noteId: null, persistedMarkdown: '', dirty: false, saving: false, mode: 'live' } }
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
function folderCounts(path){
  let notes = 0, subfolders = 0
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'note') { if ((n.relativePath || '').startsWith(path + '/')) notes++ }
      else if (n.kind === 'folder' && (n.path || '').startsWith(path + '/')) { subfolders++; walk(n.children || []) }
    }
  }
  walk(state.treeRoot || [])
  return { notes, subfolders }
}
async function deleteFolder(path){
  const { notes, subfolders } = folderCounts(path)
  const name = path.split('/').pop()
  if (notes === 0 && subfolders === 0) {
    if (!confirm(t('folderDeleteConfirm', { n: name }))) return
  } else {
    // Non-empty folder: whole-subtree → trash (A). Never reject again.
    if (!confirm(t('folderTrashTitle', { n: notes, m: subfolders }) + '\\n' + t('folderTrashWhole'))) return
  }
  try { await api('trashFolder', { path }); state.selectedFolder = null; toast(t('deletedMsg'), 'ok'); await renderTree(); renderDetail() }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
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
function renderAttachmentsFrom(list){
  $('#treeToolbar').innerHTML = ''
  $('#list').innerHTML = list.length ? list.map(a => '<div class="tree-row ' + (a.attachmentId === state.selectedAttachmentId ? 'active' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '"><span class="tw"></span><span class="ic">📎</span><span class="nm">' + esc(a.filename) + '</span> ' + syncBadgeHtml(a.sync) + '</div>').join('') : '<div class="empty">' + esc(t('emptyAttachments')) + '</div>'
  $('#main').innerHTML = '<h2>' + esc(t('attachments')) + '</h2><p class="muted">' + esc(t('attachmentsDesc')) + '</p><div class="toolbar"><button class="btn primary" data-action="upload-attachment">+ ' + esc(t('upload')) + '</button></div>'
  restoreScroll()
}
async function renderAttachments(){
  const seq = viewSeq
  $('#detail').innerHTML = '<h3>' + esc(t('attachments')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>'
  if (state.attachmentsCache.length) { renderAttachmentsFrom(state.attachmentsCache); viewMark('warm-paint', 'cache=hit') }
  else { $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  try {
    const list = await loadOnce('listAttachments', {})
    if (seq !== viewSeq) return
    state.attachmentsCache = list
    renderAttachmentsFrom(list)
    viewMark('data-ready')
    if (state.selectedAttachmentId !== null) await openAttachment(state.selectedAttachmentId)
  } catch (e) { if (seq === viewSeq) $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}
async function openAttachment(id){
  state.selectedAttachmentId = id
  try {
    const d = await api('getAttachment', { attachmentId: id })
    const a = d.attachment, s = d.sync
    $('#detail').innerHTML = '<h3>' + esc(t('details')) + '</h3><div class="kv"><b>' + esc(t('attachmentId')) + '</b> <span class="v mono">' + esc(a.attachmentId) + '</span></div><div class="kv"><b>' + esc(t('size')) + '</b> ' + fmtSize(a.sizeBytes) + '</div><h3>' + esc(t('syncSection')) + '</h3>' + syncBadgeHtml(s) + '<h3>' + esc(t('maintenance')) + '</h3><button class="btn small" data-action="download-attachment" data-id="' + esc(id) + '">' + esc(t('download')) + '</button> <button class="btn small danger" data-action="delete-attachment" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>'
    await refreshAttachments()
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
async function uploadFileBinary(file){
  const buf = new Uint8Array(await file.arrayBuffer())
  let bin = ''
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i])
  return api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: btoa(bin) })
}
function sanitizeNoteBase(base){
  const ok = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .-_()[]#@'
  let out = ''
  for (const ch of String(base)) out += ok.indexOf(ch) >= 0 ? ch : '_'
  return out.trim() || 'untitled'
}
async function uniqueNotePath(folder, base){
  const safe = sanitizeNoteBase(base)
  const notes = await api('listNotes')
  const existing = new Set((notes || []).map(n => n.relativePath))
  const prefix = folder ? folder + '/' : ''
  let cand = prefix + safe + '.md'
  let n = 2
  while (existing.has(cand)) { cand = prefix + safe + ' ' + n + '.md'; n++ }
  return cand
}
async function createCompanionNote(up, file, folder){
  const dot = file.name.lastIndexOf('.')
  const base = dot > 0 ? file.name.slice(0, dot) : file.name
  const isImage = String(file.type || '').indexOf('image/') === 0
  const ref = 'attachments/' + up.attachmentId + '/' + file.name
  const refMd = isImage ? '![](' + ref + ')' : '[' + file.name + '](' + ref + ')'
  const notePath = await uniqueNotePath(folder, base)
  await api('createNote', { relativePath: notePath, markdown: '# ' + base + '\\n\\n' + refMd + '\\n' })
  return notePath
}
async function uploadFilesWithCompanion(files, withNote, folder){
  let ok = 0, noteOk = 0, noteFail = 0
  for (const file of files) {
    try {
      const up = await uploadFileBinary(file)
      ok++
      if (withNote) {
        try { await createCompanionNote(up, file, folder); noteOk++ } catch (e) { noteFail++ }
      }
    } catch (e) { /* attachment upload failed */ }
  }
  if (ok === 0) { toast(t('uploadFailed'), 'err'); return }
  if (ok < files.length) { toast(t('uploadedCompanion', { n: ok }) + ' / ' + files.length, 'warn') }
  else if (withNote) {
    if (noteFail === 0) toast(t('uploadSuccess') + (ok > 1 ? ' · ' + t('uploadedCompanion', { n: noteOk }) : ''), 'ok')
    else toast(t('uploadedNoNote'), 'warn')
  } else toast(t('uploadSuccess'), 'ok')
  await refreshAttachments(); refreshHeader()
  if (withNote && noteOk > 0) { if (state.view === 'notes') renderTree() }
}
function uploadDialog(){
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'
  overlay.innerHTML = '<div class="modal"><h3>' + esc(t('upload')) + '</h3>' +
    '<input type="file" id="upFiles" multiple style="margin-bottom:10px">' +
    '<label class="check-row"><input type="checkbox" id="upNote" checked> ' + esc(t('companionNote')) + '</label>' +
    '<label class="form-label">' + esc(t('noteLocation')) + '</label><select id="upFolder" style="margin-bottom:10px"></select>' +
    '<label class="check-row"><input type="checkbox" id="upIndex" checked> ' + esc(t('kbIndex')) + ' <span class="muted small">' + esc(t('kbIndexHint')) + '</span></label>' +
    '<div class="toolbar" style="margin-top:12px"><button class="btn" id="upCancel">' + esc(t('cancel')) + '</button><button class="btn primary" id="upOk">' + esc(t('upload')) + '</button></div></div>'
  document.body.appendChild(overlay)
  const q = (s) => overlay.querySelector(s)
  api('listFolders').then(folders => {
    const sel = q('#upFolder')
    if (sel) sel.innerHTML = '<option value="">' + esc(t('rootFolder')) + '</option>' + (folders || []).map(f => '<option value="' + esc(f) + '">' + esc(f) + '</option>').join('')
  }).catch(() => {})
  q('#upCancel').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  q('#upOk').addEventListener('click', () => {
    const files = Array.prototype.slice.call(q('#upFiles').files || [])
    if (!files.length) { toast(t('uploadFailed'), 'warn'); return }
    const withNote = q('#upNote').checked
    const folder = q('#upFolder').value || ''
    overlay.remove()
    uploadFilesWithCompanion(files, withNote, folder)
  })
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
  try { await api('deleteAttachment', { attachmentId: id }); state.selectedAttachmentId = null; toast(t('deletedMsg'), 'ok'); await refreshAttachments(); refreshHeader() }
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
function taskRow(x, matrices, inMatrix){
  const due = x.dueAt ? '<span class="muted mono">' + esc(dueLabel(x.dueAt)) + '</span>' : ''
  const badge = (inMatrix ? '' : (x.matrixId ? '<span class="badge">' + esc(matrixName(matrices, x.matrixId)) + '</span>' : ''))
  const src = x.sourceRefs && x.sourceRefs[0] && x.sourceRefs[0].noteId
    ? '<span class="task-src" data-action="open-task-source" data-id="' + esc(x.sourceRefs[0].noteId) + '" data-exact="' + esc(x.sourceRefs[0].exact || '') + '" title="' + esc(t('openNote')) + '">📄</span>' : ''
  const mv = '<span class="task-mv"><span data-action="task-up" data-id="' + esc(x.taskId) + '" title="' + esc(t('moveUp')) + '">↑</span><span data-action="task-down" data-id="' + esc(x.taskId) + '" title="' + esc(t('moveDown')) + '">↓</span></span>'
  // Card click → detail; checkbox click → complete/reopen.
  return '<div class="tree-row task-card" draggable="true" data-action="open-task-detail" data-completed="' + (x.status === 'completed' ? '1' : '0') + '" data-id="' + esc(x.taskId) + '">' +
    '<span class="ic" data-action="toggle-task" data-completed="' + (x.status === 'completed' ? '1' : '0') + '" data-id="' + esc(x.taskId) + '">' + (x.status === 'completed' ? '☑' : '☐') + '</span>' +
    '<span class="nm">' + esc(x.title) + '</span>' + badge + due + src + mv + '</div>'
}
function moveTaskOrder(taskId, dir){
  const all = state.tasksCache || []
  const v = state.taskView
  let scope
  if (v === 'all' || v === 'today' || v === 'upcoming' || v === 'completed' || v === 'inbox') scope = filterTaskList(all, v).map(x => x.taskId)
  else {
    const t = all.find(x => x.taskId === taskId)
    const q = t ? quadrantOf(t) : 0
    scope = all.filter(x => x.status === 'open' && x.matrixId === v && quadrantOf(x) === q).map(x => x.taskId)
  }
  const i = scope.indexOf(taskId)
  if (i < 0) return
  const j = i + dir
  if (j < 0 || j >= scope.length) return
  const tmp = scope[i]; scope[i] = scope[j]; scope[j] = tmp
  api('reorderTasks', { taskIds: scope }).then(() => refreshTasks()).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
function renderTasksFrom(matrices, all){
  const counts = {}
  for (const x of all) if (x.status === 'open') { const k = x.matrixId ?? 'inbox'; counts[k] = (counts[k] || 0) + 1 }
  const views = [['inbox', 'Inbox'], ['today', t('taskToday')], ['upcoming', t('taskUpcoming')], ['all', t('taskAll')], ['completed', t('taskCompleted')]]
  const viewRows = views.map(v => '<div class="tree-row' + (state.taskView === v[0] ? ' active' : '') + '" data-action="task-view" data-view="' + v[0] + '"' + (v[0] === 'inbox' || v[0] === 'today' ? ' data-drop="' + v[0] + '"' : '') + '><span class="ic">' + (v[0] === 'inbox' ? '📥' : '▤') + '</span><span class="nm">' + esc(v[1]) + (v[0] === 'inbox' ? ' (' + (counts.inbox || 0) + ')' : '') + '</span></div>').join('')
  const matrixRows = matrices.map(m => '<div class="tree-row' + (state.taskView === m.matrixId ? ' active' : '') + '" data-action="task-view" data-view="' + esc(m.matrixId) + '" data-drop="matrix" data-matrixid="' + esc(m.matrixId) + '"><span class="ic">▦</span><span class="nm">' + esc(m.name) + ' (' + (counts[m.matrixId] || 0) + ')</span></div>').join('')
  $('#list').innerHTML =
    '<div class="list-head">' + esc(t('tasks')) + '</div>' +
    '<div class="list-section">' + esc(t('smartViews')) + '</div>' +
    viewRows +
    '<div class="list-section">' + esc(t('matrices')) + '</div>' +
    matrixRows +
    '<div class="tree-row" data-action="new-matrix"><span class="ic">＋</span><span class="nm">' + esc(t('newMatrix')) + '</span></div>'
  if (state.taskView === 'all' || state.taskView === 'today' || state.taskView === 'upcoming' || state.taskView === 'completed' || state.taskView === 'inbox') renderTaskList(matrices, all, state.taskView)
  else renderMatrixGrid(matrices, all, state.taskView)
  restoreScroll()
}
async function renderTasks(){
  const seq = viewSeq
  $('#detail').innerHTML = ''
  if (state.tasksCache.length && state.matricesCache.length) { renderTasksFrom(state.matricesCache, state.tasksCache); viewMark('warm-paint', 'cache=hit') }
  else { $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  try {
    const matrices = await loadOnce('listMatrices', {})
    const all = await loadOnce('listTasks', {})
    if (seq !== viewSeq) return // stale navigation guard
    state.tasksCache = all; state.matricesCache = matrices
    renderTasksFrom(matrices, all)
    viewMark('data-ready')
  } catch (e) { if (seq === viewSeq) $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
}
function filterTaskList(all, filter){
  const roots = all.filter(x => x.parentTaskId === null)
  const isToday = d => { const n = new Date(d); const now = new Date(); return n.getFullYear() === now.getFullYear() && n.getMonth() === now.getMonth() && n.getDate() === now.getDate() }
  if (filter === 'completed') return roots.filter(x => x.status === 'completed')
  if (filter === 'inbox') return roots.filter(x => x.matrixId === null && x.status === 'open')
  if (filter === 'today') return roots.filter(x => x.status === 'open' && (x.dueAt || x.scheduledAt) && (isToday(x.dueAt || x.scheduledAt) || new Date(x.dueAt || x.scheduledAt) < new Date()))
  if (filter === 'upcoming') return roots.filter(x => x.status === 'open' && (x.dueAt || x.scheduledAt) && new Date(x.dueAt || x.scheduledAt) > new Date())
  return roots.filter(x => x.status === 'open')
}
function renderTaskList(matrices, all, filter){
  const list = filterTaskList(all, filter)
  list.sort((a, b) => ((a.dueAt || a.scheduledAt) || '9999') < ((b.dueAt || b.scheduledAt) || '9999') ? -1 : 1)
  $('#main').innerHTML =
    '<h2>' + esc(t('tasks')) + '</h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-task">+ ' + esc(t('taskQuickAdd')) + '</button><button class="btn" data-action="new-matrix">+ ' + esc(t('newMatrix')) + '</button></div>' +
    (list.length ? list.map(x => taskRow(x, matrices)).join('') : '<div class="empty">' + esc(t('taskNoTasks')) + '</div>')
}
function renderMatrixGrid(matrices, all, matrixId){
  const m = matrices.find(x => x.matrixId === matrixId)
  const name = m ? m.name : matrixId
  const open = all.filter(x => x.status === 'open' && x.matrixId === matrixId && x.parentTaskId === null)
  const done = all.filter(x => x.status === 'completed' && x.matrixId === matrixId && x.parentTaskId === null)
  const cells = [[1, 'Q1', t('q1')], [2, 'Q2', t('q2')], [3, 'Q3', t('q3')], [4, 'Q4', t('q4')]]
  const grid = cells.map(([q, label, title]) => {
    const items = open.filter(x => quadrantOf(x) === q)
    return '<div class="quad" data-drop="matrix-quadrant" data-matrixid="' + esc(matrixId) + '" data-quadrant="' + q + '"><div class="quad-head"><b>' + label + '</b> <span class="muted">' + esc(title) + '</span><span class="count">' + items.length + '</span></div>' +
      (items.length ? items.map(x => taskRow(x, matrices, true)).join('') : '<div class="empty small">—</div>') + '</div>'
  }).join('')
  // Completed section keeps the matrix/quadrant context (group by quadrant).
  const doneRows = done.map(x => '<div class="tree-row task-card" data-action="open-task-detail" data-completed="1" data-id="' + esc(x.taskId) + '"><span class="ic" data-action="toggle-task" data-completed="1" data-id="' + esc(x.taskId) + '">☑</span><span class="nm">' + esc(x.title) + '</span><span class="badge">Q' + quadrantOf(x) + '</span></div>').join('')
  const doneHtml = done.length
    ? '<div class="list-section">' + esc(t('taskCompleted')) + ' (' + done.length + ')</div>' + doneRows
    : ''
  $('#main').innerHTML =
    '<h2>' + esc(name) + '<span class="sub">' + esc(t('matrices')) + '</span></h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-task-matrix" data-id="' + esc(matrixId) + '">+ ' + esc(t('taskQuickAdd')) + '</button><button class="btn" data-action="new-matrix">+ ' + esc(t('newMatrix')) + '</button></div>' +
    '<div class="quad-grid">' + grid + '</div>' + doneHtml
}

function trashReconcile(selected, freshKeys){
  const set = new Set(freshKeys)
  const out = new Set()
  selected.forEach(k => { if (set.has(k)) out.add(k) })
  return out
}
function trashSelectAllState(selected, visible){
  if (!visible.length) return 'none'
  let hit = 0
  for (const k of visible) if (selected.has(k)) hit++
  if (hit === 0) return 'none'
  if (hit === visible.length) return 'all'
  return 'partial'
}
function trashKindIcon(kind){ return kind === 'note' ? '📄' : kind === 'folder' ? '📁' : '📎' }
function trashKindLabel(kind){ return kind === 'note' ? t('trashNotes') : kind === 'folder' ? t('trashFolders') : t('trashAttachments') }
function trashItems(notes, atts, folders){
  const items = []
  for (const n of notes) items.push({ key: 'note:' + n.noteId, kind: 'note', id: n.noteId, name: n.title, sub: n.deletedAt || n.updatedAt || '', path: n.relativePath })
  for (const f of folders) items.push({ key: 'folder:' + f.trashEntryId, kind: 'folder', id: f.trashEntryId, name: f.originalPath, sub: f.deletedAt || '', path: f.originalPath })
  for (const a of atts) items.push({ key: 'attachment:' + a.attachmentId, kind: 'attachment', id: a.attachmentId, name: a.filename, sub: a.deletedAt || '', path: '' })
  return items
}
function trashVisible(notes, atts, folders){
  const all = trashItems(notes, atts, folders)
  return state.trashFilter === 'all' ? all : all.filter(x => x.kind === state.trashFilter)
}
function trashItemRow(it, checked){
  const meta = esc(trashKindLabel(it.kind)) + (it.sub ? ' · ' + t('trashDeletedTime', { t: it.sub }) : '') + (it.path ? ' · ' + esc(it.path) : '')
  return '<div class="tree-row trash-item" data-key="' + esc(it.key) + '">' +
    '<input type="checkbox" class="trash-check" data-key="' + esc(it.key) + '"' + (checked ? ' checked' : '') + '>' +
    '<span class="ic">' + trashKindIcon(it.kind) + '</span>' +
    '<span class="trash-main"><span class="trash-name">' + esc(it.name) + '</span><span class="muted small">' + meta + '</span></span>' +
    '<button class="btn small" data-action="restore-one" data-key="' + esc(it.key) + '">' + esc(t('trashRestore')) + '</button>' +
    '<button class="btn small danger" data-action="purge-one" data-key="' + esc(it.key) + '">' + esc(t('trashPermanentDelete')) + '</button>' +
    '</div>'
}
function trashVisibleKeysNow(){
  return Array.prototype.slice.call(document.querySelectorAll('.trash-check')).map(cb => cb.dataset.key)
}
function updateTrashSelectionUI(){
  const visible = trashVisibleKeysNow()
  const selCount = state.trashSelection.size
  const sa = trashSelectAllState(state.trashSelection, visible)
  const saEl = $('#trashSelectAll'); if (saEl) { saEl.checked = (sa === 'all'); saEl.indeterminate = (sa === 'partial'); saEl.disabled = state.trashBusy }
  const bar = $('#trashSelBar')
  if (bar) bar.innerHTML = selCount > 0
    ? '<span class="muted">' + esc(t('trashSelected', { n: selCount })) + '</span>' +
      '<button class="btn small" data-action="trash-restore" ' + (state.trashBusy ? 'disabled' : '') + '>' + (state.trashBusy ? esc(t('trashRestoring')) : esc(t('trashRestore'))) + '</button>' +
      '<button class="btn small danger" data-action="trash-purge" ' + (state.trashBusy ? 'disabled' : '') + '>' + (state.trashBusy ? esc(t('trashDeleting')) : esc(t('trashPermanentDelete'))) + '</button>' +
      '<button class="btn small" data-action="trash-clear-selection" ' + (state.trashBusy ? 'disabled' : '') + '>' + esc(t('trashClearSelection')) + '</button>'
    : ''
}
function renderTrashFrom(notes, atts, folders){
  const visible = trashVisible(notes, atts, folders)
  const keys = visible.map(x => x.key)
  state.trashSelection = trashReconcile(state.trashSelection, keys)
  const counts = { all: notes.length + atts.length + folders.length, note: notes.length, folder: folders.length, attachment: atts.length }
  const filterRows = [['all', t('trashAll'), '🗑'], ['note', t('trashNotes'), '📄'], ['folder', t('trashFolders'), '📁'], ['attachment', t('trashAttachments'), '📎']]
    .map(([f, label, ic]) => '<div class="tree-row' + (state.trashFilter === f ? ' active' : '') + '" data-action="trash-filter" data-filter="' + f + '"><span class="ic">' + ic + '</span><span class="nm">' + esc(label) + ' (' + (counts[f] || 0) + ')</span></div>').join('')
  $('#list').innerHTML = '<div class="list-head">' + esc(t('trash')) + '</div><div class="list-section">' + esc(t('trashTypeFilter')) + '</div>' + filterRows
  const sa = trashSelectAllState(state.trashSelection, keys)
  const rows = visible.map(it => trashItemRow(it, state.trashSelection.has(it.key))).join('')
  $('#main').innerHTML = '<h2>' + esc(t('trash')) + '<span class="sub">' + counts.all + '</span></h2>' +
    '<div class="toolbar"><label class="select-all"><input type="checkbox" id="trashSelectAll"' + (sa === 'all' ? ' checked' : '') + ' ' + (state.trashBusy ? 'disabled' : '') + '> ' + esc(t('trashSelectAll')) + '</label><span class="spacer"></span>' +
    '<button class="btn danger" data-action="empty-trash" ' + (counts.all === 0 || state.trashBusy ? 'disabled' : '') + '>' + esc(t('trashEmptyTrash')) + '</button></div>' +
    '<div id="trashSelBar" class="trash-selbar"></div>' +
    (rows ? rows : '<div class="empty"><h3>' + esc(t('trashEmptyTitle')) + '</h3><p class="muted">' + esc(t('trashEmptyBody')) + '</p></div>')
  const saEl = $('#trashSelectAll'); if (saEl) saEl.indeterminate = (sa === 'partial')
  updateTrashSelectionUI()
  restoreScroll()
}
function toggleTrashKey(key, checked){
  if (checked) state.trashSelection.add(key); else state.trashSelection.delete(key)
  updateTrashSelectionUI()
}
function selectAllVisible(checked){
  const visible = trashVisibleKeysNow()
  for (const k of visible) { if (checked) state.trashSelection.add(k); else state.trashSelection.delete(k) }
  document.querySelectorAll('.trash-check').forEach(cb => { cb.checked = state.trashSelection.has(cb.dataset.key) })
  updateTrashSelectionUI()
}
function clearTrashSelection(){
  state.trashSelection.clear()
  document.querySelectorAll('.trash-check').forEach(cb => { cb.checked = false })
  updateTrashSelectionUI()
}
function patchTrashCache(okKeys){
  const c = state.trashCache
  if (!c) return
  const okSet = new Set(okKeys)
  c.notes = c.notes.filter(n => !okSet.has('note:' + n.noteId))
  c.atts = c.atts.filter(a => !okSet.has('attachment:' + a.attachmentId))
  c.folders = c.folders.filter(f => !okSet.has('folder:' + f.trashEntryId))
}
function doBatchRestore(keys){
  if (state.trashBusy) return
  state.trashBusy = true; updateTrashSelectionUI()
  api('batchRestoreTrash', { items: keys.map(k => ({ key: k })) }).then(r => {
    state.trashBusy = false
    const ok = r.ok || [], failed = r.failed || []
    for (const k of ok) state.trashSelection.delete(k)
    patchTrashCache(ok)
    if (failed.length === 0) toast(t('trashRestored', { n: ok.length }), 'ok')
    else toast(t('trashRestoredPartial', { n: ok.length, m: failed.length }), 'warn')
    refreshTrash()
  }).catch(e => { state.trashBusy = false; toast(t('genericError') + ': ' + e.message, 'err'); updateTrashSelectionUI() })
}
function doBatchPurge(keys){
  if (state.trashBusy) return
  state.trashBusy = true; updateTrashSelectionUI()
  api('batchPurgeTrash', { items: keys.map(k => ({ key: k })) }).then(r => {
    state.trashBusy = false
    const ok = r.ok || [], failed = r.failed || []
    for (const k of ok) state.trashSelection.delete(k)
    patchTrashCache(ok)
    if (failed.length === 0) toast(t('trashPurged', { n: ok.length }), 'ok')
    else toast(t('trashPurgedPartial', { n: ok.length, m: failed.length }), 'warn')
    refreshTrash()
  }).catch(e => { state.trashBusy = false; toast(t('genericError') + ': ' + e.message, 'err'); updateTrashSelectionUI() })
}
function trashConfirmDialog(title, body, okLabel, onOk){
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'
  overlay.innerHTML = '<div class="modal trash-confirm"><h3>' + esc(title) + '</h3><p class="muted">' + body + '</p><div class="toolbar"><button class="btn" id="tcCancel">' + esc(t('cancel')) + '</button><button class="btn danger" id="tcOk">' + esc(okLabel) + '</button></div></div>'
  document.body.appendChild(overlay)
  const q = (s) => overlay.querySelector(s)
  q('#tcCancel').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  q('#tcOk').addEventListener('click', () => { overlay.remove(); onOk() })
}
function confirmBatchPurge(keys){
  trashConfirmDialog(t('trashPurgeConfirmTitle', { n: keys.length }), esc(t('trashPurgeConfirmBody')), t('trashPermanentDelete'), () => doBatchPurge(keys))
}
function confirmEmptyTrash(){
  const c = state.trashCache || { notes: [], atts: [], folders: [] }
  const total = c.notes.length + c.atts.length + c.folders.length
  if (total === 0) return
  const stats = t('trashEmptyConfirmStats', { n: c.notes.length, f: c.folders.length, a: c.atts.length })
  trashConfirmDialog(t('trashEmptyConfirmTitle'), esc(t('trashEmptyConfirmBody', { n: total })) + '<br><span class="muted small">' + esc(stats) + '</span>', t('trashEmptyTrash'), () => {
    const c2 = state.trashCache || { notes: [], atts: [], folders: [] }
    const keys = trashItems(c2.notes, c2.atts, c2.folders).map(x => x.key)
    doBatchPurge(keys)
  })
}
async function renderTrash(){
  const seq = viewSeq
  $('#detail').innerHTML = ''
  if (state.trashCache) { renderTrashFrom(state.trashCache.notes, state.trashCache.atts, state.trashCache.folders); viewMark('warm-paint', 'cache=hit') }
  else { $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  try {
    const notes = await loadOnce('listTrash', {})
    const atts = await loadOnce('listTrashAttachments', {})
    const folders = await loadOnce('listTrashFolders', {})
    if (seq !== viewSeq) return // stale navigation guard
    state.trashCache = { notes, atts, folders }
    renderTrashFrom(notes, atts, folders)
    viewMark('data-ready')
  } catch (e) { if (seq === viewSeq) $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>' }
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

// ── Note tree context menu (right-click → 添加到待办 / 移动 / 重命名 / 删除) ──
function dismissContextMenu(){ const m = $('#ctxMenu'); if (m) m.remove() }
// Unified context menu: entity → context-sensitive action list (single mutation
// path — each item just invokes an existing delegated data-action).
function showContextMenu(x, y, items){
  dismissContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 40 - items.length * 30) + 'px'
  menu.innerHTML = items.map(it => {
    let attrs = ''
    if (it.id !== undefined) attrs += ' data-id="' + esc(it.id) + '"'
    if (it.path !== undefined) attrs += ' data-path="' + esc(it.path) + '"'
    if (it.attrs) for (const k in it.attrs) attrs += ' ' + k + '="' + esc(it.attrs[k]) + '"'
    return '<div class="ctx-item' + (it.danger ? ' danger' : '') + '" data-action="' + esc(it.action) + '"' + attrs + '>' + esc(it.label) + '</div>'
  }).join('')
  document.body.appendChild(menu)
}
function showNoteContextMenu(x, y, noteId){
  showContextMenu(x, y, [
    { label: '📄 ' + t('openNote'), action: 'open-note', id: noteId },
    { label: '📝 ' + t('noteToTask'), action: 'note-to-task', id: noteId },
    { label: '🔗 ' + t('copyWikiLink'), action: 'copy-wikilink', id: noteId },
    { label: '✏️ ' + t('renameMove'), action: 'rename-note', id: noteId },
    { label: '📁 ' + t('moveNoteTo'), action: 'move-note', id: noteId },
    { label: '🗑 ' + t('trashFolder'), action: 'delete-note', id: noteId, danger: true },
  ])
}
function showFolderContextMenu(x, y, path){
  showContextMenu(x, y, [
    { label: '📄 ' + t('newNoteHere'), action: 'new-note-here', path },
    { label: '📁 ' + t('newSubfolder'), action: 'new-subfolder', path },
    { label: '✏️ ' + t('renameFolder'), action: 'rename-folder', path },
    { label: '🗑 ' + t('trashFolder'), action: 'delete-folder', path, danger: true },
  ])
}
function showTaskContextMenu(x, y, taskId, completed){
  showContextMenu(x, y, [
    { label: '📄 ' + t('taskDetail'), action: 'open-task-detail', id: taskId },
    { label: completed ? '↩ ' + t('taskReopen') : '✓ ' + t('taskComplete'), action: 'toggle-task', id: taskId, attrs: { 'data-completed': completed ? '1' : '0' } },
    { label: '⧉ ' + t('taskDuplicate'), action: 'task-duplicate', id: taskId },
    { label: '🗑 ' + t('taskDelete'), action: 'task-delete', id: taskId, danger: true },
  ])
}
function showMatrixContextMenu(x, y, matrixId){
  showContextMenu(x, y, [
    { label: '✏️ ' + t('renameFolder'), action: 'matrix-rename', id: matrixId },
    { label: '📦 ' + t('matrixArchive'), action: 'matrix-archive', id: matrixId },
    { label: '🗑 ' + t('matrixRemove'), action: 'matrix-remove', id: matrixId, danger: true },
  ])
}
let matrixDeleting = false
function matrixDeleteDialog(matrixId, name, count){
  if (matrixDeleting) return
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'
  overlay.innerHTML = '<div class="modal"><h3>' + esc(t('matrixRemove')) + '</h3><p class="muted">' + esc(t('matrixRemoveConfirm')) + '</p><div class="toolbar" id="mdActions"><button class="btn" id="mdCancel">' + esc(t('cancel')) + '</button><button class="btn danger" id="mdOk">' + esc(t('del')) + '</button></div></div>'
  document.body.appendChild(overlay)
  const q = (s) => overlay.querySelector(s)
  q('#mdCancel').addEventListener('click', () => { if (!matrixDeleting) overlay.remove() })
  overlay.addEventListener('click', (e) => { if (e.target === overlay && !matrixDeleting) overlay.remove() })
  q('#mdOk').addEventListener('click', () => {
    // Deleting state takes effect immediately; the visible busy state is delayed
    // so a fast delete never flashes a spinner (<250ms).
    matrixDeleting = true
    const okBtn = q('#mdOk'), cancelBtn = q('#mdCancel')
    if (okBtn) okBtn.disabled = true
    if (cancelBtn) cancelBtn.disabled = true
    const showBusy = () => { q('#mdActions').innerHTML = '<div><span class="spinner"></span> <span class="muted">' + esc(t('matrixDeleting')) + '</span></div><p class="muted small">' + esc(t('matrixMovingTasks', { n: count })) + '</p>' }
    const busyTimer = setTimeout(showBusy, 200)
    api('removeMatrix', { matrixId, reassignTo: null }).then(r => {
      clearTimeout(busyTimer); matrixDeleting = false; overlay.remove()
      toast(t('matrixDeleted', { n: (r && r.moved) || 0 }), 'ok')
      refreshTasks()
    }).catch(e => {
      clearTimeout(busyTimer); matrixDeleting = false
      q('#mdActions').innerHTML = '<p class="muted">' + esc(t('matrixDeleteFailed')) + ': ' + esc(e.message) + '</p><div class="toolbar"><button class="btn" id="mdClose">' + esc(t('taskClose')) + '</button><button class="btn danger" id="mdRetry">' + esc(t('retry')) + '</button></div>'
      q('#mdClose').addEventListener('click', () => overlay.remove())
      q('#mdRetry').addEventListener('click', () => { overlay.remove(); matrixDeleteDialog(matrixId, name, count) })
    })
  })
}
function showTrashContextMenu(x, y, key){
  showContextMenu(x, y, [
    { label: '↩ ' + t('trashRestore'), action: 'restore-one', attrs: { 'data-key': key } },
    { label: '🗑 ' + t('trashPermanentDelete'), action: 'purge-one', attrs: { 'data-key': key }, danger: true },
  ])
}
function editorInsert(md){
  if (state.editor.mode === 'live' && vditor) { vditor.insertValue(md); return }
  const el = $('#editor'); if (el) insertAtCursor(el, md)
}
function editorWrap(before, after){
  if (state.editor.mode === 'live' && vditor) {
    const sel = window.getSelection().toString()
    if (sel) vditor.insertValue(before + sel + after)
    return
  }
  const el = $('#editor'); if (!el) return
  const s = el.selectionStart, e2 = el.selectionEnd
  const sel = el.value.slice(s, e2)
  el.value = el.value.slice(0, s) + before + sel + after + el.value.slice(e2)
  el.selectionStart = s + before.length; el.selectionEnd = s + before.length + sel.length
  el.dispatchEvent(new Event('input'))
}
function editorContextMenu(x, y, hasSel){
  dismissContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 360) + 'px'
  const items = hasSel
    ? [
        ['B · ' + t('bold'), () => editorWrap('**', '**')],
        ['I · ' + t('italic'), () => editorWrap('*', '*')],
        ['S · ' + t('strike'), () => editorWrap('~~', '~~')],
        ['⟨⟩ · ' + t('slashInlineCode'), () => editorWrap('\\u0060', '\\u0060')],
        ['🔗 · ' + t('slashLink'), () => editorWrap('[', '](url)')],
        ['🔗 · ' + t('slashWikiLink'), () => editorWrap('[[', ']]')],
        ['📝 · ' + t('noteToTask'), () => { const ref = selectionSourceRef(); if (ref) quickTaskDialog(null, [ref], { title: ref.exact.replace(/\\n/g, ' ').trim().slice(0, 60), description: ref.exact }) }],
      ]
    : [
        ['Ｈ · ' + t('slashH1'), () => editorInsert('# ')],
        ['• · ' + t('slashList'), () => editorInsert('- ')],
        ['☐ · ' + t('slashTask'), () => editorInsert('- [ ] ')],
        ['❝ · ' + t('slashQuote'), () => editorInsert('> ')],
        ['💡 · ' + t('slashCallout'), () => editorInsert('> [!NOTE]\\n> ')],
        ['⊞ · ' + t('slashTable'), () => editorInsert('|  |  |\\n| --- | --- |\\n|  |  |\\n')],
        ['⟨⟩⟨⟩ · ' + t('slashCodeBlock'), () => editorInsert('\\u0060\\u0060\\u0060\\n\\u0060\\u0060\\u0060')],
        ['— · ' + t('slashHr'), () => editorInsert('---\\n')],
        ['🔗 · ' + t('slashLink'), () => editorInsert('[text](url)')],
        ['🔗 · ' + t('slashWikiLink'), () => editorInsert('[[note]]')],
      ]
  menu.innerHTML = items.map((it, i) => '<div class="ctx-item" data-edit-idx="' + i + '">' + esc(it[0]) + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-edit-idx]'); if (it) { const fn = items[Number(it.dataset.editIdx)][1]; dismissContextMenu(); fn() } })
  document.body.appendChild(menu)
}
// ── Table editing (Live IR) — structural cell↔canonical mapping, no cell-text ─
function resolveCellInEditor(cell){
  if (!vditor || !vditor.vditor || !vditor.vditor.ir) return null
  const table = cell.closest('table'); if (!table) return null
  const tables = Array.prototype.slice.call(vditor.vditor.ir.element.querySelectorAll('table'))
  const tableIndex = tables.indexOf(table)
  if (tableIndex < 0) return null
  const isHeader = cell.tagName === 'TH'
  let columnIndex = 0, p = cell.previousElementSibling
  while (p) { columnIndex++; p = p.previousElementSibling }
  let rowIndex = 0
  if (!isHeader) { const tr = cell.parentElement, tbody = tr.parentElement; let r = tbody.firstElementChild; while (r && r !== tr) { rowIndex++; r = r.nextElementSibling } }
  return { tableIndex, isHeader, rowIndex, columnIndex }
}
function restoreCellCaret(tableIndex, isHeader, rowIndex, columnIndex){
  if (!vditor || !vditor.vditor || !vditor.vditor.ir) return
  const tables = Array.prototype.slice.call(vditor.vditor.ir.element.querySelectorAll('table'))
  const table = tables[tableIndex]
  if (!table) { vditor.focus(); return }
  let cell = null
  if (isHeader) { const thead = table.querySelector('thead'); if (thead && thead.rows[0]) cell = thead.rows[0].cells[Math.min(columnIndex, thead.rows[0].cells.length - 1)] }
  if (!cell) { const tbody = table.querySelector('tbody'); if (tbody) { const tr = tbody.rows[Math.min(rowIndex, tbody.rows.length - 1)]; if (tr) cell = tr.cells[Math.min(columnIndex, tr.cells.length - 1)] } }
  if (!cell) { vditor.focus(); return }
  const range = document.createRange(); range.selectNodeContents(cell); range.collapse(true)
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
  vditor.focus()
}
function applyTableMutation(cell, op, align){
  if (!vditor) return
  const ctx = resolveCellInEditor(cell); if (!ctx) return
  const markdown = vditor.getValue()
  const irEl = vditor.vditor.ir.element
  const scrollTop = irEl ? irEl.scrollTop : 0
  api('tableMutation', { markdown, op, tableIndex: ctx.tableIndex, isHeader: ctx.isHeader, rowIndex: ctx.rowIndex, columnIndex: ctx.columnIndex, align }).then(r => {
    if (!vditor || r.unchanged || !r.markdown) return
    vditor.setValue(r.markdown)
    const el = vditor.vditor.ir.element; if (el && scrollTop) el.scrollTop = scrollTop
    restoreCellCaret(ctx.tableIndex, ctx.isHeader, ctx.rowIndex, ctx.columnIndex)
    onEditorInput()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
function showTableContextMenu(x, y, cell){
  const ctx = resolveCellInEditor(cell); if (!ctx) return
  dismissContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 380) + 'px'
  const items = [
    ['⬆ ' + t('tableRowAbove'), () => applyTableMutation(cell, 'addRowAbove')],
    ['⬇ ' + t('tableRowBelow'), () => applyTableMutation(cell, 'addRowBelow')],
    ['← ' + t('tableColLeft'), () => applyTableMutation(cell, 'addColumnLeft')],
    ['→ ' + t('tableColRight'), () => applyTableMutation(cell, 'addColumnRight')],
    ['◧ ' + t('tableAlignLeft'), () => applyTableMutation(cell, 'setColumnAlign', 'left')],
    ['◧ ' + t('tableAlignCenter'), () => applyTableMutation(cell, 'setColumnAlign', 'center')],
    ['◧ ' + t('tableAlignRight'), () => applyTableMutation(cell, 'setColumnAlign', 'right')],
    ['🗑 ' + t('tableDeleteRow'), () => applyTableMutation(cell, 'deleteRow')],
    ['🗑 ' + t('tableDeleteCol'), () => applyTableMutation(cell, 'deleteColumn')],
    ['🗑 ' + t('tableDeleteTable'), () => applyTableMutation(cell, 'deleteTable')],
  ]
  menu.innerHTML = items.map((it, i) => '<div class="ctx-item' + (i >= 7 ? ' danger' : '') + '" data-edit-idx="' + i + '">' + esc(it[0]) + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-edit-idx]'); if (it) { const fn = items[Number(it.dataset.editIdx)][1]; dismissContextMenu(); fn() } })
  document.body.appendChild(menu)
}
function insertTableGrid(n){
  const empty = (c) => Array.from({ length: c }, () => '  ').join(' | ')
  const header = '| ' + empty(n) + ' |'
  const sep = '| ' + Array.from({ length: n }, () => '---').join(' | ') + ' |'
  const row = '| ' + empty(n) + ' |'
  editorInsert(header + '\\n' + sep + '\\n' + Array.from({ length: n }, () => row).join('\\n') + '\\n')
}
function showTableInsertMenu(x, y){
  dismissContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 160) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 200) + 'px'
  menu.innerHTML = [2, 3, 4, 5, 6].map(n => '<div class="ctx-item" data-insert-size="' + n + '">⊞ ' + n + '×' + n + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-insert-size]'); if (it) { const n = Number(it.dataset.insertSize); dismissContextMenu(); insertTableGrid(n) } })
  document.body.appendChild(menu)
}
function tableToolbarClick(){
  const sel = window.getSelection()
  const node = sel && sel.anchorNode ? sel.anchorNode : null
  const el = node && node.nodeType === 1 ? node : (node && node.parentElement)
  const cell = el ? el.closest('td, th') : null
  if (cell) { const r = cell.getBoundingClientRect(); showTableContextMenu(r.left + 8, r.bottom + 4, cell) }
  else { showTableInsertMenu(window.innerWidth / 2, 120) }
}
// ── Footnote product UX (canonical [^key] + [^key]: definition) ──────────────
function getEditorSelection(){
  if (state.editor.mode === 'live') return window.getSelection().toString()
  const el = $('#editor'); return el ? el.value.slice(el.selectionStart, el.selectionEnd) : ''
}
function setEditorValue(md){
  if (state.editor.mode === 'live' && vditor) { vditor.setValue(md); return }
  const el = $('#editor'); if (el) { el.value = md; el.dispatchEvent(new Event('input')) }
}
function footnoteKeyFromDef(defEl){
  const t = (defEl.textContent || '')
  const i = t.indexOf('[^'); if (i !== 0) return null
  const j = t.indexOf(']:', i); if (j < 0) return null
  return t.slice(i + 2, j)
}
function footnoteDefinitionContent(markdown, key){
  const prefix = '[^' + key + ']: '
  const lines = markdown.split('\\n')
  for (let i = 0; i < lines.length; i++) if (lines[i].indexOf(prefix) === 0) return lines[i].slice(prefix.length)
  return ''
}
function insertFootnoteReference(key){
  if (state.editor.mode === 'live' && vditor) {
    const sel = window.getSelection()
    if (sel && sel.toString().trim()) { const range = sel.getRangeAt(0); range.collapse(false); sel.removeAllRanges(); sel.addRange(range) }
    vditor.insertValue('[^' + key + ']')
    return
  }
  const el = $('#editor'); if (!el) return
  const ref = '[^' + key + ']'
  el.value = el.value.slice(0, el.selectionEnd) + ref + el.value.slice(el.selectionEnd)
  el.selectionStart = el.selectionEnd = el.selectionEnd + ref.length
  el.dispatchEvent(new Event('input'))
}
function appendFootnoteDefinitionAtEnd(key, content){
  if (state.editor.mode === 'live' && vditor) {
    const irEl = vditor.vditor.ir.element
    const range = document.createRange(); range.selectNodeContents(irEl); range.collapse(false)
    const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range)
    vditor.insertValue('\\n\\n[^' + key + ']: ' + content)
    return
  }
  const el = $('#editor'); if (!el) return
  el.value = el.value.replace(/\\n+$/, '') + '\\n\\n[^' + key + ']: ' + content + '\\n'
  el.dispatchEvent(new Event('input'))
}
function applyFootnoteEdit(key, content){
  const md = getEditorValue().value
  api('footnoteEdit', { markdown: md, key, content }).then(r => {
    if (r.unchanged) { toast(t('genericError'), 'warn'); return }
    setEditorValue(r.markdown); onEditorInput()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
function applyFootnoteDelete(key){
  const md = getEditorValue().value
  api('footnoteDelete', { markdown: md, key }).then(r => {
    setEditorValue(r.markdown); onEditorInput()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
function jumpToFootnoteDef(key){
  const defs = document.querySelectorAll('[data-type="footnotes-def"]')
  for (let i = 0; i < defs.length; i++) if (footnoteKeyFromDef(defs[i]) === key) { defs[i].scrollIntoView({ block: 'center' }); return }
}
function jumpToFootnoteRef(key){
  const refs = document.querySelectorAll('sup[data-type="footnotes-ref"]')
  for (let i = 0; i < refs.length; i++) { const label = refs[i].getAttribute('data-footnotes-label') || ''; if (label === '^' + key) { refs[i].scrollIntoView({ block: 'center' }); return } }
}
function showFootnoteRefMenu(x, y, key){
  dismissContextMenu()
  const menu = document.createElement('div'); menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'; menu.style.top = Math.min(y, window.innerHeight - 140) + 'px'
  const items = [
    ['✏️ ' + t('footnoteEdit'), () => editFootnoteDialog(key)],
    ['⤵ ' + t('footnoteJump'), () => jumpToFootnoteDef(key)],
    ['🗑 ' + t('footnoteDelete'), () => applyFootnoteDelete(key)],
  ]
  menu.innerHTML = items.map((it, i) => '<div class="ctx-item' + (i === 2 ? ' danger' : '') + '" data-edit-idx="' + i + '">' + esc(it[0]) + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-edit-idx]'); if (it) { const fn = items[Number(it.dataset.editIdx)][1]; dismissContextMenu(); fn() } })
  document.body.appendChild(menu)
}
function showFootnoteDefMenu(x, y, key){
  dismissContextMenu()
  const menu = document.createElement('div'); menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'; menu.style.top = Math.min(y, window.innerHeight - 140) + 'px'
  const items = [
    ['⤴ ' + t('footnoteBack'), () => jumpToFootnoteRef(key)],
    ['✏️ ' + t('footnoteEdit'), () => editFootnoteDialog(key)],
    ['🗑 ' + t('footnoteDelete'), () => applyFootnoteDelete(key)],
  ]
  menu.innerHTML = items.map((it, i) => '<div class="ctx-item' + (i === 2 ? ' danger' : '') + '" data-edit-idx="' + i + '">' + esc(it[0]) + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-edit-idx]'); if (it) { const fn = items[Number(it.dataset.editIdx)][1]; dismissContextMenu(); fn() } })
  document.body.appendChild(menu)
}
function footnoteModal(title, initial, placeholder, onOk){
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'
  overlay.innerHTML = '<div class="modal footnote-modal"><h3>' + esc(title) + '</h3><textarea id="fnContent" rows="4" placeholder="' + esc(placeholder) + '"></textarea><div class="toolbar"><button class="btn" id="fnCancel">' + esc(t('cancel')) + '</button><button class="btn primary" id="fnOk">' + esc(t('footnoteInsert')) + '</button></div></div>'
  document.body.appendChild(overlay)
  const q = (s) => overlay.querySelector(s)
  const ta = q('#fnContent'); ta.value = initial || ''; ta.focus()
  q('#fnCancel').addEventListener('click', () => overlay.remove())
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
  q('#fnOk').addEventListener('click', () => {
    const content = ta.value.trim()
    if (!content) { ta.focus(); return }
    overlay.remove(); onOk(content)
  })
}
function footnoteDialog(){
  if (state.selectedNoteId === null) return
  const hasSel = !!(getEditorSelection() || '').trim()
  footnoteModal(t('footnoteInsert'), '', t('footnoteContent'), (content) => {
    api('nextFootnoteKey', { markdown: getEditorValue().value }).then(r => {
      insertFootnoteReference(r.key)
      appendFootnoteDefinitionAtEnd(r.key, content)
      onEditorInput()
    }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
  })
  const hint = document.querySelector('.footnote-modal')
  if (hint) hint.insertAdjacentHTML('afterbegin', '<p class="muted">' + esc(hasSel ? t('footnoteSelectText') : t('footnoteEmpty')) + '</p>')
}
function editFootnoteDialog(key){
  const cur = footnoteDefinitionContent(getEditorValue().value, key)
  footnoteModal(t('footnoteEdit'), cur, t('footnoteContent'), (content) => applyFootnoteEdit(key, content))
}
document.addEventListener('contextmenu', (e) => {
  const editorPane = e.target.closest('#editorPane')
  if (editorPane) {
    if (e.shiftKey) return // Shift + right-click → native browser menu
    const cell = e.target.closest('td, th')
    if (cell && state.editor.mode === 'live') { e.preventDefault(); showTableContextMenu(e.clientX, e.clientY, cell); return }
    const fnRef = e.target.closest('sup[data-type="footnotes-ref"]')
    if (fnRef && state.editor.mode === 'live') { const label = fnRef.getAttribute('data-footnotes-label') || ''; const key = label.slice(1); if (key) { e.preventDefault(); showFootnoteRefMenu(e.clientX, e.clientY, key); return } }
    const fnDef = e.target.closest('[data-type="footnotes-def"]')
    if (fnDef && state.editor.mode === 'live') { const key = footnoteKeyFromDef(fnDef); if (key) { e.preventDefault(); showFootnoteDefMenu(e.clientX, e.clientY, key); return } }
    const sel = window.getSelection()
    const hasSel = !!(sel && sel.toString().trim())
    e.preventDefault()
    editorContextMenu(e.clientX, e.clientY, hasSel)
    return
  }
  const trashRow = e.target.closest('.trash-item')
  if (trashRow) { e.preventDefault(); showTrashContextMenu(e.clientX, e.clientY, trashRow.dataset.key); return }
  const noteRow = e.target.closest('.tree-row.note[data-action="open-note"]')
  if (noteRow) { e.preventDefault(); showNoteContextMenu(e.clientX, e.clientY, noteRow.dataset.id); return }
  const folderRow = e.target.closest('.tree-row.folder[data-action="select-folder"]')
  if (folderRow) { e.preventDefault(); showFolderContextMenu(e.clientX, e.clientY, folderRow.dataset.path); return }
  const taskRow = e.target.closest('[data-action="toggle-task"]') || e.target.closest('.task-card[data-action="open-task-detail"]')
  if (taskRow) { e.preventDefault(); showTaskContextMenu(e.clientX, e.clientY, taskRow.dataset.id, taskRow.dataset.completed === '1'); return }
  const matrixRow = e.target.closest('[data-action="task-view"][data-view]')
  if (matrixRow && !['all', 'today', 'upcoming', 'completed', 'inbox'].includes(matrixRow.dataset.view)) {
    e.preventDefault(); showMatrixContextMenu(e.clientX, e.clientY, matrixRow.dataset.view); return
  }
  dismissContextMenu()
})

// ── Selection → floating "add to task" (appears next to the selection) ──────
let pendingSelectionRef = null
function dismissSelButton(){ const b = $('#selTaskBtn'); if (b) b.remove() }
document.addEventListener('mouseup', (e) => {
  if (state.view !== 'notes' || state.selectedNoteId === null) return
  const within = e.target.closest('#editorPane')
  const sel = window.getSelection()
  const text = sel ? sel.toString().trim() : ''
  if (!within || !text) { dismissSelButton(); pendingSelectionRef = null; return }
  pendingSelectionRef = selectionSourceRef()
  if (!pendingSelectionRef) { dismissSelButton(); return }
  const rect = sel.getRangeAt(0).getBoundingClientRect()
  dismissSelButton()
  const bar = document.createElement('div')
  bar.className = 'sel-toolbar'; bar.id = 'selTaskBtn'
  bar.style.left = Math.max(8, rect.left + rect.width / 2 - 150) + 'px'
  bar.style.top = Math.max(8, rect.top - 40) + 'px'
  const btns = [
    ['B', 'bold', () => editorWrap('**', '**')],
    ['I', 'italic', () => editorWrap('*', '*')],
    ['S', 'strike', () => editorWrap('~~', '~~')],
    ['H', 'highlight', () => editorWrap('==', '==')],
    ['⟨⟩', 'slashInlineCode', () => editorWrap('\\u0060', '\\u0060')],
    ['🔗', 'slashLink', () => editorWrap('[', '](url)')],
    ['[[', 'slashWikiLink', () => editorWrap('[[', ']]')],
    ['📝', 'noteToTask', () => { const r = pendingSelectionRef; if (r) quickTaskDialog(null, [r], { title: r.exact.replace(/\\n/g, ' ').trim().slice(0, 60), description: r.exact }) }],
  ]
  bar.innerHTML = btns.map(b => '<span class="sel-btn" title="' + esc(t(b[1])) + '">' + b[0] + '</span>').join('')
  bar.querySelectorAll('.sel-btn').forEach((el2, i) => {
    el2.addEventListener('mousedown', (ev) => ev.preventDefault())
    el2.addEventListener('click', () => { dismissSelButton(); btns[i][2]() })
  })
  document.body.appendChild(bar)
})

// ── Task drag/drop (HTML5 DnD; mirrors resolveTaskDrop domain semantics) ────
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('.task-card[draggable="true"]')
  if (!card) return
  e.dataTransfer.setData('text/plain', card.dataset.id)
  e.dataTransfer.effectAllowed = 'move'
  card.classList.add('dragging')
})
document.addEventListener('dragend', () => {
  document.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging'))
  document.querySelectorAll('.drop-over').forEach(el => el.classList.remove('drop-over'))
})
document.addEventListener('dragover', (e) => {
  const t = e.target.closest('[data-drop]')
  if (!t) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  t.classList.add('drop-over')
})
document.addEventListener('dragleave', (e) => {
  const t = e.target.closest('[data-drop]')
  if (t) t.classList.remove('drop-over')
})
document.addEventListener('drop', (e) => {
  const t = e.target.closest('[data-drop]')
  if (!t) return
  e.preventDefault()
  t.classList.remove('drop-over')
  const taskId = e.dataTransfer.getData('text/plain')
  if (!taskId) return
  const task = (state.tasksCache || []).find(x => x.taskId === taskId)
  if (!task) return
  let patch = null
  const kind = t.dataset.drop
  if (kind === 'matrix-quadrant') {
    const q = Number(t.dataset.quadrant)
    patch = { matrixId: t.dataset.matrixid, important: q === 1 || q === 2, urgent: q === 1 || q === 3 }
  } else if (kind === 'matrix') {
    patch = { matrixId: t.dataset.matrixid }
  } else if (kind === 'inbox') {
    patch = { matrixId: null }
  } else if (kind === 'today') {
    patch = { scheduledAt: new Date().toISOString().slice(0, 10) }
  }
  if (!patch) return
  api('updateTask', { taskId, patch }).then(() => refreshTasks()).catch(e => { toast(t('genericError') + ': ' + e.message, 'err'); renderTasks() })
})

// ── Delegated events ────────────────────────────────────────────────────────
document.addEventListener('click', (e) => {
  if (!e.target.closest('#wikiSuggest')) dismissWikiSuggest()
  if (!e.target.closest('#ctxMenu')) dismissContextMenu()
  if (!e.target.closest('#selTaskBtn')) dismissSelButton()
  const wiki = e.target.closest('[data-wiki]')
  if (wiki) { openWikiTarget(wiki.dataset.wiki); return }
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
  else if (act === 'rename-note') renameNote(id)
  else if (act === 'move-note') moveNote(id)
  else if (act === 'delete-note') delNote(id)
  else if (act === 'rename-folder') renameFolder(path)
  else if (act === 'delete-folder') deleteFolder(path)
  else if (act === 'sync-note') syncEntity('note', id)
  else if (act === 'sync-now') syncNow()
  else if (act === 'reconcile') reconcile()
  else if (act === 'upload-attachment') uploadDialog()
  else if (act === 'download-attachment') downloadAttachment(id)
  else if (act === 'delete-attachment') delAttachment(id)
  else if (act === 'go-attachments') setView('attachments')
  else if (act === 'new-task') quickTaskDialog(null, null)
  else if (act === 'new-task-matrix') quickTaskDialog(id || null, null)
  else if (act === 'new-matrix') { const name = prompt(t('createFolderPrompt'), ''); if (name && name.trim()) api('createMatrix', { name: name.trim() }).then(() => refreshTasks()) }
  else if (act === 'task-view') setTaskView(el.dataset.view)
  else if (act === 'note-to-task') {
    api('getNote', { noteId: id }).then(d => {
      const paras = (d.body || '').split(/\\n{2,}/).map(p => p.trim()).filter(p => p && !/^#{1,6}\\s/.test(p))
      const desc = paras.slice(0, 3).join('\\n\\n').slice(0, 500)
      quickTaskDialog(null, [{ kind: 'note', noteId: id }], { title: d.note.title, description: desc })
    }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
  }
  else if (act === 'selection-to-task') { const ref = selectionSourceRef(); if (ref) quickTaskDialog(null, [ref], { title: ref.exact.replace(/\\n/g, ' ').trim().slice(0, 60), description: ref.exact }); else toast(t('taskNoTasks'), 'warn') }
  else if (act === 'open-task-source') { state.highlightText = el.dataset.exact || ''; setView('notes'); openNote(id) }
  else if (act === 'toggle-task') {
    const task = (state.tasksCache || []).find(x => x.taskId === id)
    const isSubtask = task && task.parentTaskId !== null
    const t = el.dataset.completed === '1' ? api('reopenTask', { taskId: id }) : api('completeTask', { taskId: id })
    t.then(() => { if (!isSubtask) refreshTasks(); if (taskDetailRefreshSubtasks) taskDetailRefreshSubtasks() }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
  }
  else if (act === 'subtask-edit') { inlineEditSubtask(el, id) }
  else if (act === 'subtask-toggle') { if (taskDetailToggleSubtask) taskDetailToggleSubtask(id) }
  else if (act === 'open-task-detail') taskDetailDialog(id)
  else if (act === 'task-due') { const due = prompt(t('taskDue'), ''); if (due !== null) api('updateTask', { taskId: id, patch: { dueAt: due } }).then(() => refreshTasks()) }
  else if (act === 'task-delete') { const task = (state.tasksCache || []).find(x => x.taskId === id); const isSubtask = task && task.parentTaskId !== null; api('deleteTask', { taskId: id }).then(() => { if (!isSubtask) refreshTasks(); if (taskDetailRefreshSubtasks) taskDetailRefreshSubtasks() }).catch(e => toast(t('genericError') + ': ' + e.message, 'err')) }
  else if (act === 'task-duplicate') { const t = (state.tasksCache || []).find(x => x.taskId === id); if (t) api('createTask', { title: t.title + ' (copy)', ...(t.matrixId ? { matrixId: t.matrixId } : {}), important: t.important, urgent: t.urgent, ...(t.description ? { description: t.description } : {}), ...(t.dueAt ? { dueAt: t.dueAt } : {}), tags: t.tags || [] }).then(() => refreshTasks()) }
  else if (act === 'matrix-rename') { const name = prompt(t('folderRenamePrompt'), ''); if (name && name.trim()) api('renameMatrix', { matrixId: id, name: name.trim() }).then(() => refreshTasks()) }
  else if (act === 'matrix-archive') { api('archiveMatrix', { matrixId: id }).then(() => refreshTasks()) }
  else if (act === 'matrix-remove') { const count = (state.tasksCache || []).filter(x => x.matrixId === id).length; matrixDeleteDialog(id, count) }
  else if (act === 'copy-wikilink') { api('getNote', { noteId: id }).then(d => navigator.clipboard.writeText('[[' + (d.note.title || id) + ']]')).then(() => toast(t('ok'), 'ok')).catch(e => toast(t('genericError') + ': ' + e.message, 'err')) }
  else if (act === 'task-up') moveTaskOrder(id, -1)
  else if (act === 'task-down') moveTaskOrder(id, 1)
  else if (act === 'trash-filter') { state.trashFilter = el.dataset.filter || 'all'; if (state.trashCache) renderTrashFrom(state.trashCache.notes, state.trashCache.atts, state.trashCache.folders) }
  else if (act === 'restore-one') { doBatchRestore([el.dataset.key]) }
  else if (act === 'purge-one') { confirmBatchPurge([el.dataset.key]) }
  else if (act === 'trash-restore') { doBatchRestore(Array.from(state.trashSelection)) }
  else if (act === 'trash-purge') { confirmBatchPurge(Array.from(state.trashSelection)) }
  else if (act === 'trash-clear-selection') { clearTrashSelection() }
  else if (act === 'empty-trash') { confirmEmptyTrash() }
  else if (act === 'theme-system') setTheme('system')
  else if (act === 'theme-light') setTheme('light')
  else if (act === 'theme-dark') setTheme('dark')
})
// Trash selection is pure local state: checkbox/select-all toggles never fetch.
document.addEventListener('change', (e) => {
  const check = e.target.closest('.trash-check')
  if (check) { toggleTrashKey(check.dataset.key, check.checked); return }
  const sa = e.target.closest('#trashSelectAll')
  if (sa) { selectAllVisible(sa.checked); return }
})
function selectionSourceRef(){
  if (state.selectedNoteId === null) return null
  const rev = state.editor.observedRevision
  const hash = state.editor.contentHash
  // Source mode: raw textarea gives canonical markdown offsets + surrounding text.
  if (state.editor.mode === 'source') {
    const el = $('#editor')
    if (!el) return null
    const start = el.selectionStart, end = el.selectionEnd
    const exact = el.value.slice(start, end)
    if (!exact.trim() || exact.length > 500) return null
    const prefix = el.value.slice(Math.max(0, start - 80), start)
    const suffix = el.value.slice(end, end + 80)
    return {
      kind: 'selection', noteId: state.selectedNoteId, exact,
      ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}),
      start, end,
      ...(rev !== undefined ? { noteRevision: rev } : {}),
      ...(hash ? { contentHash: hash } : {}),
    }
  }
  // IR/Reading: DOM selection — semantic context only; markdown offset unreliable.
  const sel = window.getSelection()
  const exact = sel ? sel.toString() : ''
  if (!exact.trim() || exact.length > 500) return null
  let prefix = '', suffix = ''
  const node = sel.anchorNode
  if (node && node.textContent) {
    const full = node.textContent
    const off = sel.anchorOffset
    prefix = full.slice(Math.max(0, off - 80), off)
    suffix = full.slice(off + exact.length, off + exact.length + 80)
  }
  return {
    kind: 'selection', noteId: state.selectedNoteId, exact,
    ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}),
    ...(rev !== undefined ? { noteRevision: rev } : {}),
    ...(hash ? { contentHash: hash } : {}),
  }
}
let taskDetailSessionSeq = 0
let activeTaskDetailSession = 0
let taskDetailRefreshSubtasks = null
let taskDetailRequestClose = null
let taskDetailToggleSubtask = null
// Subtask data cache (parentTaskId → Task[]) + request dedup map. UI-only fast
// projection; the Task Store remains canonical authority.
const subtaskCache = new Map()
const subtaskInflight = new Map()
function fetchSubtasks(parentTaskId){
  if (subtaskInflight.has(parentTaskId)) return subtaskInflight.get(parentTaskId)
  const p = api('listSubtasks', { parentTaskId }).then(list => { subtaskCache.set(parentTaskId, list); return list }).finally(() => { subtaskInflight.delete(parentTaskId) })
  subtaskInflight.set(parentTaskId, p)
  return p
}
function inlineEditSubtask(span, taskId){
  const cur = span.textContent
  const input = document.createElement('input')
  input.value = cur
  input.className = 'subtask-edit-input'
  span.replaceWith(input)
  input.focus()
  let done = false
  const commit = () => {
    if (done) return
    done = true
    const v = input.value.trim()
    if (v && v !== cur) {
      api('updateTask', { taskId, patch: { title: v } }).then(() => { if (taskDetailRefreshSubtasks) taskDetailRefreshSubtasks() }).catch(e => { toast(t('genericError') + ': ' + e.message, 'err'); input.value = cur })
    } else {
      input.replaceWith(span)
    }
  }
  const cancel = () => { if (done) return; done = true; input.replaceWith(span) }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } else if (e.key === 'Escape') { cancel() } })
  input.addEventListener('blur', commit)
}
function taskDetailDialog(taskId){
  const task = (state.tasksCache || []).find(t => t.taskId === taskId)
  if (!task) return
  // Explicit session identity: every async detail callback must verify it still
  // owns the active session before touching DOM/state. Opening/closing bumps this.
  const sessionId = ++taskDetailSessionSeq
  activeTaskDetailSession = sessionId
  // Single-modal invariant: remove any previous dialog (and invalidate it).
  const prev = document.getElementById('taskDetailModal'); if (prev) prev.remove()
  const quad = quadrantOf(task)
  const srcNote = task.sourceRefs && task.sourceRefs[0] ? '<div class="form"><label>' + esc(t('noteLabel')) + '</label><span class="v mono" data-action="open-task-source" data-id="' + esc(task.sourceRefs[0].noteId) + '" data-exact="' + esc(task.sourceRefs[0].exact || '') + '" style="cursor:pointer">📄 ' + esc(task.sourceRefs[0].noteId) + '</span></div>' : ''
  // Subtask completion draft: Store baseline + local draft = Detail projection.
  let subtaskBaseline = {}
  let subtaskDraft = {}
  let subtaskList = []
  const proj = (s) => (s.taskId in subtaskDraft ? subtaskDraft[s.taskId] : (s.status === 'completed'))
  const renderSubRows = (list) => list.map(s => '<div class="subtask-row" data-id="' + esc(s.taskId) + '"><span class="ic" data-action="subtask-toggle" data-id="' + esc(s.taskId) + '">' + (proj(s) ? '☑' : '☐') + '</span><span class="nm subtask-title" data-action="subtask-edit" data-id="' + esc(s.taskId) + '" title="' + esc(t('renameMove')) + '">' + esc(s.title) + '</span><span class="subtask-del" data-action="task-delete" data-id="' + esc(s.taskId) + '" title="' + esc(t('taskDelete')) + '">×</span></div>').join('')
  // Shell renders immediately from the already-cached task object; matrices and
  // subtasks load async and patch their own sections (never block the shell).
  const mOpts = task.matrixId ? '<option value="' + esc(task.matrixId) + '" selected>' + esc(task.matrixId) + '</option>' : '<option value="" selected>' + esc(t('taskInbox')) + '</option>'
  const subSection = '<div class="form"><div class="subtask-head"><span>' + esc(t('subtasks')) + '</span><span class="muted" id="tdSubCount"></span></div><div id="tdSubtasks"><span class="muted">' + esc(t('loading')) + '</span></div><div class="toolbar" style="margin-top:4px"><input id="tdNewSub" placeholder="' + esc(t('subtaskAdd')) + '" style="flex:1" /><button class="btn small" id="tdAddSub">+</button></div></div>'
  const wrapper = document.createElement('div')
    const meta = '<div class="muted mono" style="font-size:11px">' + esc(t('taskCreated')) + ': ' + esc((task.createdAt || '').slice(0, 16)) + '<br>' + esc(t('updated')) + ': ' + esc((task.updatedAt || '').slice(0, 16)) + (task.completedAt ? '<br>' + esc(t('taskCompleted')) + ': ' + esc(task.completedAt.slice(0, 16)) : '') + '</div>'
    wrapper.innerHTML =
      '<div class="modal-overlay" id="taskDetailModal"><div class="modal task-detail-modal">' +
        '<div class="task-detail-header">' +
          '<input id="tdTitle" class="td-title-input" value="' + esc(task.title) + '" placeholder="' + esc(t('taskTitle')) + '" />' +
          '<select id="tdStatus" class="td-status"><option value="open"' + (task.status === 'open' ? ' selected' : '') + '>' + esc(t('taskOpen')) + '</option><option value="completed"' + (task.status === 'completed' ? ' selected' : '') + '>' + esc(t('taskCompleted')) + '</option></select>' +
          '<button class="btn small" id="tdCloseX" title="' + esc(t('taskClose')) + '">×</button>' +
        '</div>' +
        '<div class="task-detail-body">' +
          '<div class="task-detail-main">' +
            '<div class="form"><label>' + esc(t('description')) + '</label><textarea id="tdDesc" rows="8" placeholder="' + esc(t('descriptionPlaceholder')) + '">' + esc(task.description || '') + '</textarea></div>' +
            subSection +
            srcNote +
          '</div>' +
          '<div class="task-detail-properties">' +
            '<div class="prop-group"><div class="prop-title">' + esc(t('organization')) + '</div>' +
              '<label>' + esc(t('matrices')) + '</label><select id="tdMatrix">' + mOpts + '</select>' +
              '<label>' + esc(t('taskQuadrant')) + '</label><select id="tdQuad">' +
                '<option value="1"' + (quad === 1 ? ' selected' : '') + '>Q1 · ' + esc(t('q1')) + '</option><option value="2"' + (quad === 2 ? ' selected' : '') + '>Q2 · ' + esc(t('q2')) + '</option><option value="3"' + (quad === 3 ? ' selected' : '') + '>Q3 · ' + esc(t('q3')) + '</option><option value="4"' + (quad === 4 ? ' selected' : '') + '>Q4 · ' + esc(t('q4')) + '</option></select>' +
            '</div>' +
            '<div class="prop-group"><div class="prop-title">' + esc(t('time')) + '</div>' +
              '<label>' + esc(t('taskScheduled')) + '</label><input type="date" id="tdSched" value="' + esc((task.scheduledAt || '').slice(0, 10)) + '" />' +
              '<label>' + esc(t('taskDue')) + '</label><input type="date" id="tdDue" value="' + esc((task.dueAt || '').slice(0, 10)) + '" />' +
            '</div>' +
            '<div class="prop-group"><div class="prop-title">' + esc(t('tags')) + '</div><input id="tdTags" placeholder="' + esc(t('tagsPlaceholder')) + '" value="' + esc((task.tags || []).join(', ')) + '" /></div>' +
            '<div class="prop-group"><div class="prop-title">' + esc(t('info')) + '</div>' + meta + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="task-detail-footer">' +
          '<span id="tdState" class="saved">✓ ' + esc(t('saved')) + '</span>' +
          '<span class="spacer"></span>' +
          '<button class="btn" id="tdCancel">' + esc(t('taskClose')) + '</button>' +
          '<button class="btn primary" id="tdSave" disabled>' + esc(t('taskSaveEdit')) + '</button>' +
        '</div>' +
      '</div></div>'
    const modal = wrapper.firstElementChild
    document.body.appendChild(modal)
    const qs = (sel) => modal.querySelector(sel)
    const isActive = () => sessionId === activeTaskDetailSession
    let parentDirty = false
    let saving = false
    let subtaskSubmitting = false
    const isDirty = () => parentDirty
    const updateState = () => {
      const st = qs('#tdState')
      const sv = qs('#tdSave')
      const d = isDirty()
      if (st) { st.className = saving ? 'saving' : (d ? 'dirty' : 'saved'); st.textContent = saving ? ('… ' + t('saving')) : (d ? ('● ' + t('unsaved')) : ('✓ ' + t('saved'))) }
      if (sv) { sv.disabled = !d || saving; sv.textContent = saving ? t('saving') : t('taskSaveEdit') }
    }
    const markDirty = () => { if (!parentDirty) { parentDirty = true; updateState() } }
    const renderSubtaskSection = () => {
      const box = qs('#tdSubtasks')
      if (box) box.innerHTML = renderSubRows(subtaskList) || '<span class="muted">' + esc(t('taskNoTasks')) + '</span>'
      const cnt = qs('#tdSubCount')
      if (cnt) cnt.textContent = subtaskList.filter(proj).length + ' / ' + subtaskList.length
    }
    const toggleSubtask = (subId) => {
      const s = subtaskList.find(x => x.taskId === subId)
      if (!s) return
      const target = !proj(s)
      // Optimistic local flip (auto-save, not Parent Save-managed draft).
      subtaskDraft = { ...subtaskDraft, [subId]: target }
      renderSubtaskSection()
      const op = target ? api('completeTask', { taskId: subId }) : api('reopenTask', { taskId: subId })
      op.then(() => {
        if (!isActive()) return
        subtaskBaseline[subId] = target
        delete subtaskDraft[subId]
        const c = subtaskCache.get(taskId)
        if (c) { const i = c.findIndex(x => x.taskId === subId); if (i >= 0) c[i] = { ...c[i], status: target ? 'completed' : 'open' } }
        renderSubtaskSection()
      }).catch(e => {
        if (!isActive()) return
        delete subtaskDraft[subId] // rollback optimistic flip
        renderSubtaskSection()
        toast(t('genericError') + ': ' + e.message, 'err')
      })
    }
    taskDetailToggleSubtask = toggleSubtask
    let guardEl = null
    const dismissGuard = () => { if (guardEl) { guardEl.remove(); guardEl = null } }
    const close = () => { dismissGuard(); if (isActive()) activeTaskDetailSession = 0; taskDetailRefreshSubtasks = null; taskDetailRequestClose = null; taskDetailToggleSubtask = null; modal.remove() }
    const requestClose = () => {
      if (saving) return
      if (guardEl) { dismissGuard(); return } // Esc/backdrop on the guard → cancel, stay
      if (!isDirty()) { close(); return }
      // Custom three-way close guard (session-scoped element ref, no global id).
      const w = document.createElement('div')
      w.innerHTML = '<div class="modal-overlay close-guard-overlay"><div class="modal close-guard"><h3>' + esc(t('closeGuardTitle')) + '</h3><p class="muted">' + esc(t('closeGuardBody')) + '</p><div class="toolbar"><button class="btn" id="cgCancel">' + esc(t('cancel')) + '</button><button class="btn danger" id="cgDiscard">' + esc(t('discard')) + '</button><button class="btn primary" id="cgSaveClose">' + esc(t('saveAndClose')) + '</button></div></div></div>'
      guardEl = w.firstElementChild
      document.body.appendChild(guardEl)
      const gq = (s) => guardEl.querySelector(s)
      gq('#cgCancel').addEventListener('click', dismissGuard)
      gq('#cgDiscard').addEventListener('click', () => { dismissGuard(); close() })
      gq('#cgSaveClose').addEventListener('click', () => { dismissGuard(); doSave(true) })
      guardEl.addEventListener('click', (e) => { if (e.target === guardEl) dismissGuard() })
    }
    taskDetailRequestClose = requestClose
    // Re-fetch + patch ONLY the #tdSubtasks section (never the whole modal).
    const applyList = (list) => {
      const prevKey = subtaskList.map(s => s.taskId + ':' + s.status + ':' + s.title).join('|')
      const nextKey = list.map(s => s.taskId + ':' + s.status + ':' + s.title).join('|')
      subtaskList = list
      subtaskBaseline = {}
      for (const s of list) subtaskBaseline[s.taskId] = (s.status === 'completed')
      // Prune pending entries for children that no longer exist (deleted).
      for (const k of Object.keys(subtaskDraft)) if (!(k in subtaskBaseline)) delete subtaskDraft[k]
      if (prevKey !== nextKey) renderSubtaskSection()
    }
    // Cache-first + first-open tasksCache seed + stale-while-revalidate + dedup.
    const refreshSubtasks = () => {
      let seedSource = 'none'
      const cached = subtaskCache.get(taskId)
      if (cached !== undefined) { seedSource = 'subtask-cache'; applyList(cached) }
      else {
        // First-open seed from the existing full tasksCache snapshot (root + child).
        const tc = state.tasksCache || []
        if (tc.length > 0) {
          const seed = tc.filter(t => t.parentTaskId === taskId)
          seedSource = 'tasks-cache'
          subtaskCache.set(taskId, seed)
          applyList(seed) // positive (or valid empty) projection — no loading flash
        }
      }
      const t0 = performance.now()
      return fetchSubtasks(taskId).then(list => {
        const dur = performance.now() - t0
        console.debug('[pkw.subtasks] seed=' + seedSource + ' revalidateMs=' + Math.round(dur) + ' count=' + list.length)
        if (isActive()) applyList(list)
      })
    }
    taskDetailRefreshSubtasks = refreshSubtasks
    const doSave = (andClose) => {
      if (!isActive() || saving) return
      saving = true
      updateState()
      const q = Number(qs('#tdQuad').value)
      api('updateTask', { taskId, patch: {
        title: qs('#tdTitle').value.trim(),
        description: qs('#tdDesc').value,
        status: qs('#tdStatus').value,
        matrixId: qs('#tdMatrix').value || null,
        important: q === 1 || q === 2,
        urgent: q === 1 || q === 3,
        ...(qs('#tdSched').value ? { scheduledAt: qs('#tdSched').value } : {}),
        ...(qs('#tdDue').value ? { dueAt: qs('#tdDue').value } : {}),
        tags: (qs('#tdTags').value || '').split(',').map(s => s.trim()).filter(Boolean),
      } }).then(() => {
        if (!isActive()) return
        parentDirty = false
        saving = false
        updateState()
        refreshTasks()
        if (andClose) close()
      }).catch(e => {
        if (!isActive()) return
        saving = false
        updateState()
        toast(t('genericError') + ': ' + e.message, 'err')
      })
    }
    // Subtask create is an INDEPENDENT Task Store mutation: it must never
    // recreate/close the parent modal (which would drop the parent draft).
    const submitSubtask = () => {
      if (subtaskSubmitting) return
      const input = qs('#tdNewSub')
      const title = input.value.trim()
      if (!title) return
      subtaskSubmitting = true
      const pq = quadrantOf(task)
      api('createTask', { title, parentTaskId: taskId, ...(task.matrixId ? { matrixId: task.matrixId } : {}), important: pq === 1 || pq === 2, urgent: pq === 1 || pq === 3 })
        .then(created => {
          // Optimistically append the new child to the cache so the cache-first
          // paint shows it immediately; the revalidate below reconciles with store.
          if (created && created.taskId) {
            const cached = subtaskCache.get(taskId) || []
            if (!cached.some(x => x.taskId === created.taskId)) {
              subtaskCache.set(taskId, cached.concat([created]))
            }
          }
          return refreshSubtasks()
        })
        .then(() => {
          if (!isActive()) return
          input.value = ''
          input.focus()
        })
        .catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
        .finally(() => { subtaskSubmitting = false })
    }
    // Parent-field edits mark dirty (async loads do NOT).
    for (const sel of ['#tdTitle', '#tdDesc', '#tdStatus', '#tdMatrix', '#tdQuad', '#tdSched', '#tdDue', '#tdTags']) { const f = qs(sel); if (f) f.addEventListener('input', markDirty); if (f) f.addEventListener('change', markDirty) }
    qs('#tdAddSub').addEventListener('click', submitSubtask)
    qs('#tdNewSub').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitSubtask() } })
    qs('#tdCancel').addEventListener('click', requestClose)
    qs('#tdCloseX').addEventListener('click', requestClose)
    qs('#tdSave').addEventListener('click', () => doSave(false))
    modal.addEventListener('click', (e) => { if (e.target === modal) requestClose() })
    // Async (non-blocking) secondary data: patch their own sections when ready.
    api('listMatrices').then(matrices => {
      if (!isActive()) return
      const sel = qs('#tdMatrix')
      if (sel) sel.innerHTML = '<option value="">' + esc(t('taskInbox')) + '</option>' + matrices.map(m => '<option value="' + esc(m.matrixId) + '"' + (m.matrixId === task.matrixId ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('')
    }).catch(() => {})
    refreshSubtasks().catch(() => {})
}
function quickTaskDialog(matrixId, sourceRefs, prefill){
  const lastMatrix = localStorage.getItem('pkw-task-last-matrix') || ''
  const pre = prefill || {}
  api('listMatrices').then(matrices => {
    const opts = '<option value="">' + esc(t('taskInbox')) + '</option>' + matrices.map(m => '<option value="' + esc(m.matrixId) + '"' + (m.matrixId === (matrixId || lastMatrix) ? ' selected' : '') + '>' + esc(m.name) + '</option>').join('')
    const srcNote = sourceRefs && sourceRefs[0] ? '<div class="form"><label>' + esc(t('noteLabel')) + '</label><span class="v mono">' + esc(sourceRefs[0].noteId) + '</span></div>' : ''
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal-overlay" id="taskModal"><div class="modal"><h3>' + esc(t('taskQuickAdd')) + '</h3>' +
      '<div class="form"><label>' + esc(t('taskTitle')) + '</label><input id="tkTitle" value="' + esc(pre.title || '') + '" /></div>' +
      '<div class="form"><label>' + esc(t('description')) + '</label><textarea id="tkDesc" rows="3">' + esc(pre.description || '') + '</textarea></div>' +
      '<div class="form"><label>' + esc(t('matrices')) + '</label><select id="tkMatrix">' + opts + '</select></div>' +
      '<div class="form"><label>' + esc(t('taskQuadrant')) + '</label><select id="tkQuad">' +
        '<option value="1">Q1 · ' + esc(t('q1')) + '</option><option value="2">Q2 · ' + esc(t('q2')) + '</option><option value="3">Q3 · ' + esc(t('q3')) + '</option><option value="4">Q4 · ' + esc(t('q4')) + '</option></select></div>' +
      '<div class="form"><label>' + esc(t('taskDue')) + '</label><input type="date" id="tkDue" /></div>' +
      '<div class="form"><label>' + esc(t('tags')) + '</label><input id="tkTags" placeholder="tag1, tag2" /></div>' +
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
      const due = $('#tkDue').value
      const tags = ($('#tkTags').value || '').split(',').map(s => s.trim()).filter(Boolean)
      const description = $('#tkDesc').value
      if (m) localStorage.setItem('pkw-task-last-matrix', m)
      api('createTask', {
        title,
        ...(description ? { description } : {}),
        ...(m ? { matrixId: m } : {}),
        important: quad === 1 || quad === 2,
        urgent: quad === 1 || quad === 3,
        ...(due ? { dueAt: due } : {}),
        ...(tags.length ? { tags } : {}),
        ...(sourceRefs && sourceRefs.length ? { sourceRefs } : {}),
      }).then(() => { modal.remove(); refreshTasks() }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
    })
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove() })
    $('#tkTitle').focus()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
$('#search').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { state.view = 'search'; render(); runSearch(e.target.value.trim()) } })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (taskDetailRequestClose) { taskDetailRequestClose(); return } dismissContextMenu(); dismissSelButton(); dismissWikiSuggest(); return }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.view === 'notes' && state.selectedNoteId !== null) saveNote() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); quickSwitch() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '**bold**') }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '*italic*') }
})
$('#langBtn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pkw-lang', lang); render() })
$('#themeBtn').addEventListener('click', (e) => { e.stopPropagation(); const r = e.target.getBoundingClientRect(); showAppearanceMenu(r.left, r.bottom + 4) })
window.addEventListener('beforeunload', (e) => { if (state.editor.dirty && state.selectedNoteId !== null) { e.preventDefault(); e.returnValue = '' } })
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshHeader(); if (state.view === 'notes') { renderTree(); if (state.selectedNoteId) kickSyncPoll({ pending: true }) } } })
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentThemeMode() === 'system') applyTheme('system') })
applyTheme()
// Inspector: hide the right column when it has no context, so Main expands.
function syncInspector(){
  const detail = $('#detail')
  const has = detail && detail.innerHTML.trim() !== ''
  const app = $('#app')
  if (app) app.classList.toggle('no-inspector', !has)
}
if ($('#detail')) new MutationObserver(syncInspector).observe($('#detail'), { childList: true, subtree: true, characterData: true })
syncInspector()

render()
</script>
</body>
</html>`
}
