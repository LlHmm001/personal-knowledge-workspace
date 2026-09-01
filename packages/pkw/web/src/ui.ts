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
.badge{padding:2px 9px;border-radius:999px;font-size:12px;background:var(--bg-hover);color:var(--muted);white-space:nowrap}
.badge.ok{background:var(--co-tip-bg);color:var(--ok)}.badge.warn{background:var(--co-warning-bg);color:var(--warn)}.badge.err{background:var(--co-danger-bg);color:var(--err)}
.langbtn{padding:6px 11px;border:1px solid var(--border);background:var(--panel);border-radius:8px;cursor:pointer;font-size:12px;color:var(--ink);font-weight:600}
.langbtn:hover{background:var(--bg-hover)}
aside{border-right:1px solid var(--border);background:var(--panel);display:flex;flex-direction:column;min-height:0}
.nav{padding:10px 10px 6px;flex:0 0 auto}.nav button{display:block;width:100%;text-align:left;padding:8px 12px;border:0;background:none;border-radius:8px;cursor:pointer;font-size:13px;color:var(--ink);margin-bottom:2px}
.nav .nav-group-label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);font-weight:650;padding:4px 10px;margin-bottom:4px}
.nav button.active,.nav button:hover{background:var(--bg-hover)}.nav button.active{font-weight:650;color:var(--accent)}
.launcher{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.launcher .launch-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:10px 6px;border:1px solid transparent;border-radius:10px;background:none;color:var(--ink);cursor:pointer;text-align:center;font-size:12px}
.launcher .launch-item:hover{background:var(--bg-hover);border-color:var(--border)}
.launcher .launch-item.active{background:var(--bg-selected);border-color:var(--border-strong);color:var(--accent)}
.launcher .li-ic{display:flex;align-items:center;justify-content:center;width:26px;height:26px;color:var(--text-secondary)}
.launcher .launch-item.active .li-ic{color:var(--accent)}
.launcher .li-label{line-height:1.2}
#list{overflow:auto;padding:6px 8px 12px;flex:1 1 auto}
.tree-toolbar{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid var(--border);flex:0 0 auto;align-items:center}
.tree-row{display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:7px;cursor:pointer;border:1px solid transparent;font-size:13px}
.tree-row:hover{background:var(--bg-hover)}.tree-row.active{background:var(--bg-selected);border-color:var(--border-strong)}
.tree-row .tw{width:16px;text-align:center;color:var(--muted);flex:0 0 auto;font-size:11px}
.tree-row .ic{flex:0 0 auto;font-size:12px}
.tree-row .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.inline-rename-input{flex:1 1 auto;min-width:0;padding:2px 6px;border:1px solid var(--accent);border-radius:6px;font-size:13px;background:var(--bg-surface);color:var(--text-primary);font-family:inherit}
.editor-head .inline-rename-input{font-size:15px;font-weight:600}
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
textarea#editor{width:100%;height:calc(100vh - 180px);min-height:320px;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:14px 16px;border:0;resize:vertical;outline:none;display:block;background:var(--bg-surface);color:var(--text-primary)}
#preview{padding:14px 18px;min-height:calc(100vh - 180px);background:var(--bg-surface);overflow:auto}
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
.hit .ref{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted);margin-top:6px;flex-wrap:wrap}
.hit .ref .meta{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.hit .ref .spacer{flex:1 1 auto}
.hit .t .badge{margin-left:6px;vertical-align:1px}
.hit .reason{color:var(--text-secondary)}
.kb-section-hint{font-size:12px;color:var(--muted);margin:0 0 12px}
.empty{color:var(--muted);padding:28px;text-align:center}.empty .cta{margin-top:10px}
.spinner{width:16px;height:16px;border:2px solid var(--border-strong);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;display:inline-block;vertical-align:-3px}
@keyframes spin{to{transform:rotate(360deg)}}
.check-row{display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:13px;cursor:pointer}
.check-row input{margin:0}
.radio-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:8px;font-size:13px;cursor:pointer}
.radio-row input{margin-top:3px}
.radio-row b{font-weight:600}
.danger-text{color:var(--danger)}
.form-label{display:block;font-size:12px;color:var(--muted);margin-bottom:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:16px}
.stat{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel)}.stat .n{font-size:22px;font-weight:700}.stat .l{font-size:12px;color:var(--muted)}
#toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:60;display:none}
#activity{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:60;display:none;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:var(--panel);border:1px solid var(--border);box-shadow:0 4px 14px rgba(0,0,0,.15);font-size:13px;color:var(--text-secondary)}
#activity .spinner{margin-right:2px}
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
@media (max-width:800px){#taskDetailModal .modal{width:100vw;max-width:100vw;height:100dvh;max-height:100dvh;border-radius:0}}
.task-detail-header{padding:16px 20px 12px;border-bottom:1px solid var(--border)}
.task-detail-title-row{width:100%}
.td-title-input{width:100%;display:block;font-size:26px;line-height:1.3;font-weight:700;padding:10px 14px;border:1px solid var(--border);border-radius:12px;background:var(--panel);color:var(--text-primary);box-sizing:border-box}
.td-title-input:hover{border-color:var(--border-strong)}
.td-title-input:focus{border-color:var(--accent);background:var(--bg-elevated);outline:none}
.task-detail-controls{display:flex;align-items:center;gap:10px;margin-top:10px}
.td-status{width:auto;min-width:110px}
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
.task-card.selected{background:var(--bg-selected);border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}
.marquee{position:fixed;border:1px solid var(--accent);background:var(--accent-soft);z-index:85;pointer-events:none}
.drop-over{outline:2px dashed var(--accent);outline-offset:-2px;background:var(--co-note-bg)}
.task-src{margin-left:6px;cursor:pointer;opacity:.65}.task-src:hover{opacity:1}
.task-mv{margin-left:auto;display:inline-flex;gap:2px;opacity:.55}.task-mv span{cursor:pointer;padding:0 5px;border-radius:4px}.task-mv span:hover{background:var(--bg-hover);opacity:1}
mark{background:var(--mark-bg);border-radius:2px;padding:0 2px}
@media (max-width:760px){.quad-grid{grid-template-columns:1fr}}
.wikilink-suggest{position:absolute;z-index:80;background:var(--panel);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 20px rgba(0,0,0,.15);max-height:240px;overflow:auto;min-width:240px}
.wikilink-suggest .item{padding:7px 12px;cursor:pointer;font-size:13px}.wikilink-suggest .item:hover,.wikilink-suggest .item.sel{background:var(--bg-hover)}
@media(max-width:960px){#app{grid-template-columns:200px 1fr}aside.right{display:none}}
#bottomNav{display:none}
.bn-item{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;flex:1 1 0;padding:6px 2px;border:0;background:none;color:var(--text-muted);cursor:pointer;font-size:11px}
.bn-item .bn-ic{display:flex;align-items:center;justify-content:center;width:24px;height:24px}
.bn-item.active{color:var(--accent)}
.bn-item.active .bn-ic,.bn-item:hover .bn-ic{color:var(--accent)}
#mobileMoreBtn{display:none}
/* Mobile / small tablet: single-column workspace + bottom primary nav. */
@media(max-width:768px){
  #app{grid-template-columns:1fr;grid-template-rows:52px 1fr 58px;height:100dvh}
  #app.no-inspector{grid-template-columns:1fr}
  #app > aside:first-of-type{display:none}
  #app > aside.right{display:none}
  main{padding:16px 16px calc(58px + env(safe-area-inset-bottom) + 16px);min-width:0;max-width:100vw;box-sizing:border-box}
  #bottomNav{display:flex;position:fixed;left:0;right:0;bottom:0;height:calc(58px + env(safe-area-inset-bottom));padding-bottom:env(safe-area-inset-bottom);background:var(--panel);border-top:1px solid var(--border);z-index:50}
  #wsBadge,#integBadge,#localBadge,#langBtn,#themeBtn,#inspectorToggle{display:none}
  #mobileMoreBtn{display:inline-flex}
  header h1{flex:1;font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .launcher{grid-template-columns:1fr 1fr 1fr}
  /* no horizontal overflow: containers clip, long tokens break instead of stretch */
  body,main{overflow-x:hidden}
  /* Mobile header already shows the page title → drop the duplicate in-page h2 */
  main > h2{display:none}
  .toolbar{flex-wrap:wrap;gap:6px}
  .toolbar #attSearch{flex:1 1 100%;min-width:0}
  .toolbar .btn.small,.toolbar .btn{padding:8px 10px;min-height:36px}
  /* Notes Explorer rows: title + two-line metadata, no truncation/vertical text */
  .tree-row.note,.att-row{flex-wrap:wrap;padding:8px 6px}
  .tree-row.note .nm,.att-row .nm{flex:1 1 100%;white-space:normal;word-break:break-word;font-size:14px}
  .tree-row.note .muted.small,.att-row .muted.small{font-size:11px}
  .tree-row.note .syncbadge,.att-row .badge{font-size:11px}
  /* Sources: single-column cards */
  .att-row{display:grid;grid-template-columns:32px 1fr auto;grid-template-areas:"ic name state" "ic meta owner";row-gap:2px;column-gap:8px;align-items:center}
  .att-row .att-check{grid-area:ic}
  .att-row .att-ic,.att-row .att-thumb{grid-area:ic;width:32px;height:32px}
  .att-row .nm{grid-area:name}
  .att-row .muted.small{grid-area:meta}
  .att-row .badge{grid-area:state}
  .att-row .btn.small{grid-area:owner}
  .att-grid{grid-template-columns:repeat(auto-fill,minmax(120px,1fr))}
  /* Task cards: allow title wrap + due/overdue visible */
  .task-card{flex-wrap:wrap;width:100%;box-sizing:border-box;min-width:0}
  .task-card .task-title{white-space:normal;word-break:break-word}
  /* Knowledge cards already single-column; clamp long summaries */
  .hit{width:100%;max-width:100%;box-sizing:border-box;min-width:0}
  .hit .ref{flex-wrap:wrap}
  .hit .t{font-size:14px;word-break:break-word}
  .hit .snippet{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
  /* Sources: drop desktop-only grid/sort/all-select on mobile (default card view) */
  #attSelectAll{display:none}
  .toolbar [data-action="att-mode"],.toolbar [data-action="att-sort"]{display:none}
  .toolbar [data-action="att-type"]{flex:0 0 auto;white-space:nowrap}
  .editor-head .title{word-break:break-word;white-space:normal}
  #editorPane,.editor-head{overflow-x:auto}
  .vditor-toolbar{overflow-x:auto;flex-wrap:nowrap}
}
@media(max-width:400px){
  header h1{font-size:13px}
  #integBadge,#localBadge{display:none}
  main{padding:16px 16px calc(58px + env(safe-area-inset-bottom) + 16px)}
  .bn-item{font-size:10px}
}
/* Mobile page-content width normalization (targeted surface containers only). */
@media(max-width:600px){
  main{width:100%;max-width:none;min-width:0;box-sizing:border-box}
  #kbBody,#kbList,#attList,.macc,.mboard,.mboard-select{width:100%;max-width:none;min-width:0;box-sizing:border-box}
}
/* Mobile surface cards + bottom sheet (rendered only on mobile) */
.hit-clickable{cursor:pointer}.hit-clickable:hover{border-color:var(--accent)}
.hit .chev{float:right;color:var(--muted);font-size:16px;margin-left:6px}
.mnote,.msrc,.mtask{display:flex;align-items:flex-start;gap:10px;padding:12px 10px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--panel);width:100%;max-width:100%;min-width:0;box-sizing:border-box}
.mfolder{display:flex;align-items:center;gap:10px;padding:12px 12px;border:1px solid var(--border);border-radius:12px;margin-bottom:8px;background:var(--panel);width:100%;max-width:100%;min-width:0;box-sizing:border-box;cursor:pointer}
.mfolder-ic{flex:0 0 auto;font-size:20px}
.mfolder-main{flex:1 1 auto;min-width:0}
.mfolder-name{font-weight:600;font-size:14px}
.mfolder-count{font-size:12px;color:var(--muted);margin-top:2px}
.mfolder-title{font-weight:650;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mobile-readonly-hint{font-size:12px;color:var(--muted);padding:6px 2px;margin-bottom:4px}
.mnote-main,.msrc-main,.mtask-main{flex:1 1 auto;min-width:0}
.mnote-title,.msrc-name,.mtask-title{font-size:15px;font-weight:600;line-height:1.3;word-break:break-word}
.mnote-folder,.msrc-meta,.mtask-cat,.mtask-due{font-size:12px;color:var(--muted);margin-top:2px}
.mnote-meta{font-size:11px;color:var(--muted);margin-top:4px}
.mnote-more{flex:0 0 auto;border:0;background:none;font-size:18px;color:var(--muted);padding:0 4px;min-width:32px;min-height:36px;cursor:pointer}
.msrc-thumbwrap{flex:0 0 auto;width:44px;height:44px;border-radius:8px;overflow:hidden;background:var(--bg-hover);display:flex;align-items:center;justify-content:center;border:1px solid var(--border)}
.msrc-thumb{width:100%;height:100%;object-fit:cover}.msrc-ic{font-size:22px}
.msrc-badges{margin-top:4px;display:flex;gap:4px;flex-wrap:wrap}
.msrc-summary{font-size:12px;color:var(--muted);margin-top:6px;line-height:1.4}
.mtask-check{flex:0 0 auto;font-size:20px;padding:0 4px;min-width:32px;min-height:36px;display:flex;align-items:flex-start;justify-content:center;cursor:pointer;border:0;background:none}
.mtask-due{font-weight:600;color:var(--warning)}
.mobile-sheet-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:90;display:flex;align-items:flex-end;justify-content:center}
.mobile-sheet{width:100%;max-width:520px;background:var(--panel);border-radius:16px 16px 0 0;padding:10px 12px calc(10px + env(safe-area-inset-bottom));box-shadow:0 -6px 30px rgba(0,0,0,.25)}
.ms-title{font-size:12px;color:var(--muted);padding:6px 8px 8px;font-weight:650;letter-spacing:.03em}
.ms-item,.ms-cancel{display:block;width:100%;text-align:left;padding:13px 10px;border:0;background:none;border-radius:10px;font-size:15px;color:var(--ink);cursor:pointer}
.ms-item:hover,.ms-cancel:hover{background:var(--bg-hover)}
.ms-item.danger{color:var(--danger)}
.ms-cancel{margin-top:6px;border-top:1px solid var(--border);border-radius:0;font-weight:600;color:var(--text-secondary)}
.mobile-detail{position:fixed;inset:0;background:var(--bg-app);z-index:88;display:flex;flex-direction:column}
.mobile-detail .md-head{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid var(--border);background:var(--panel)}
.mobile-detail .md-title{font-weight:650;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mobile-detail .md-body{flex:1;overflow:auto;padding:14px;padding-bottom:calc(58px + env(safe-area-inset-bottom) + 20px)}
/* Mobile Tasks: board + 2×2 quadrant overview */
.mboard{display:flex;gap:6px;overflow-x:auto;padding-bottom:8px;margin-bottom:8px}
.mboard .btn.small{white-space:nowrap;flex:0 0 auto}
.mboard-select{width:100%;text-align:left;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel);color:var(--ink);font-size:14px;font-weight:600;margin-bottom:10px;cursor:pointer}
/* Mobile Tasks accordion (Q1-Q4 + completed) */
.macc{border:1px solid var(--border);border-radius:10px;margin-bottom:8px;background:var(--panel);overflow:hidden}
.macc-head{display:flex;align-items:center;gap:8px;width:100%;text-align:left;padding:12px 12px;border:0;background:none;cursor:pointer;font-size:14px;color:var(--ink)}
.macc-arrow{flex:0 0 auto;color:var(--muted);font-size:12px;width:14px}
.macc-label{flex:1 1 auto;font-weight:600}
.macc-count{flex:0 0 auto;font-size:12px;color:var(--muted);background:var(--bg-hover);padding:2px 9px;border-radius:999px}
.macc-body{padding:4px 10px 10px;border-top:1px solid var(--border)}
.mtask.done{opacity:.75}
/* Vditor Live (IR) dark adaptation: the editor surface follows the tokens. */
[data-theme="dark"] .vditor,[data-theme="dark"] .vditor-ir,[data-theme="dark"] .vditor-reset{background:var(--bg-surface);color:var(--text-primary)}
[data-theme="dark"] .vditor-toolbar{background:var(--bg-sidebar);border-bottom-color:var(--border)}
[data-theme="dark"] .vditor-toolbar__item{color:var(--text-secondary)}
[data-theme="dark"] .vditor-toolbar__item:hover,[data-theme="dark"] .vditor-toolbar__item--current{background:var(--bg-hover);color:var(--text-primary)}
[data-theme="dark"] .vditor-ir__marker{color:var(--text-muted)}
[data-theme="dark"] .vditor-ir pre.vditor-reset,[data-theme="dark"] .vditor-reset pre{background:var(--code-bg);color:var(--code-fg)}
[data-theme="dark"] .vditor-ir blockquote.callout{background:var(--callout-background-color,var(--bg-elevated))}
/* Attachment Manager */
.att-row{display:flex;align-items:center;gap:8px;padding:6px 8px}
.att-row .att-check{flex:0 0 auto}
.att-row .att-thumb{width:32px;height:32px;object-fit:cover;border-radius:4px;flex:0 0 auto;border:1px solid var(--border)}
.att-row .att-ic{flex:0 0 auto;font-size:18px;width:32px;text-align:center}
.att-row .nm{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.att-row.selected{background:var(--bg-hover)}
.att-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;padding:8px 0}
.att-card{position:relative;border:1px solid var(--border);border-radius:8px;padding:10px;cursor:pointer;background:var(--panel)}
.att-card:hover{border-color:var(--accent)}
.att-card.selected{outline:2px solid var(--accent)}
.att-card .att-check{position:absolute;top:8px;left:8px;z-index:2}
.att-thumbwrap{height:110px;display:flex;align-items:center;justify-content:center;overflow:hidden;border-radius:6px;background:var(--bg-elevated);margin-bottom:8px}
.att-thumbwrap .att-thumb{width:100%;height:100%;object-fit:cover}
.att-ic.big{font-size:40px}
.att-card-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:4px}
.check-row.inline{display:inline-flex;align-items:center;gap:5px;margin:0 4px;font-size:13px}
#attSearch{width:170px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--panel);color:var(--text-primary)}
/* Business Knowledge Viewer attachments */
#bkAttachments{margin-top:10px;padding:10px 16px}
#bkAttachments h3{font-size:.95em;margin:.4em 0 .6em;color:var(--text-secondary)}
.bk-att{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px;background:var(--bg-surface)}
.bk-thumb{width:72px;height:72px;object-fit:cover;border-radius:8px;flex:0 0 auto;border:1px solid var(--border)}
.bk-ic{flex:0 0 auto;width:72px;height:72px;display:flex;align-items:center;justify-content:center;font-size:30px;border-radius:8px;background:var(--bg-hover)}
.bk-att-main{flex:1 1 auto;min-width:0}
.bk-att-name{font-weight:600;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bk-summary{margin-top:6px;font-size:13px;line-height:1.5}
.bk-att-side{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}
/* Managed source block (Reading-mode file projection) */
.src-block{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-elevated);margin:8px 0}
.src-ic{flex:0 0 auto;font-size:20px}
.src-meta{flex:1 1 auto;min-width:0}
.src-name{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.src-sub{font-size:11px;color:var(--muted)}
.src-act{flex:0 0 auto;font-size:12px;color:var(--accent);text-decoration:none;padding:3px 8px;border:1px solid var(--border);border-radius:6px}
.src-act:hover{background:var(--bg-hover)}
/* Desktop PDF Preview Pane (right Inspector) */
#detail.previewing{width:460px;max-width:60vw}
.pv-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.pv-name{flex:1;font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv-frame{width:100%;height:60vh;border:1px solid var(--border);border-radius:8px;background:#fff}
.pv-img{width:100%;height:auto;border-radius:8px}
.pv-actions{display:flex;gap:6px;margin-top:10px}
/* Live managed file inline chip (rewritten attachment links) */
a.src-inline{display:inline-flex;align-items:center;gap:6px;padding:3px 9px;border:1px solid var(--border);border-radius:8px;background:var(--bg-elevated);color:var(--accent);text-decoration:none;font-size:13px}
a.src-inline::before{content:"📄";font-size:14px}
a.src-inline:hover{border-color:var(--accent)}
/* Search → Viewer navigation context */
.search-context-banner{display:inline-block;margin:2px 0 4px;padding:3px 10px;border-radius:999px;font-size:12px;background:var(--bg-hover);color:var(--text-secondary);border:1px solid var(--border)}
/* Folder-aware Notes Explorer: breadcrumb + selection */
.crumbs{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-bottom:8px}
.crumbs .crumb-link{background:none;border:none;color:var(--accent);cursor:pointer;font-size:13px;padding:2px 4px;border-radius:6px}
.crumbs .crumb-link:hover{background:var(--accent-soft)}
.crumbs .crumb-sep{color:var(--muted)}
.sel-bar{background:var(--accent-soft);border:1px solid var(--accent);border-radius:8px;padding:6px 8px}
.exp-check{flex:0 0 auto;margin:0;cursor:pointer}
.explorer-item .chev{color:var(--muted)}
</style>
</head>
<body>
<div id="app">
  <header>
    <h1 id="pageTitle">PKW</h1>
    <span class="badge" id="wsBadge">…</span>
    <span class="spacer"></span>
    <span class="badge" id="integBadge">WeKnora: …</span>
    <span class="badge" id="localBadge">Local: …</span>
    <button id="langBtn" class="langbtn" title="Switch language / 切换语言">EN</button>
    <button id="themeBtn" class="langbtn" title="Appearance / 外观">◐</button>
    <button id="inspectorToggle" class="langbtn" title="Toggle inspector / 收起侧栏">⟩</button>
    <button id="mobileMoreBtn" class="langbtn" title="More / 更多">⋯</button>
  </header>
  <aside>
    <div class="nav">
      <div class="nav-group-label">Workspace</div>
      <div class="launcher">
        <button data-view="overview" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg></span><span class="li-label">总览</span></button>
        <button data-view="tasks" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/></svg></span><span class="li-label">待办</span></button>
        <button data-view="notes" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg></span><span class="li-label">笔记</span></button>
        <button data-view="knowledge" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span><span class="li-label">知识</span></button>
        <button data-view="attachments" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg></span><span class="li-label">来源</span></button>
        <button data-view="trash" class="launch-item"><span class="li-ic" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg></span><span class="li-label">回收站</span></button>
      </div>
    </div>
    <div id="treeToolbar"></div>
    <div id="list"></div>
  </aside>
  <main id="main"></main>
  <aside class="right" id="detail"></aside>
</div>
<nav id="bottomNav" aria-label="Workspace">
  <button data-view="tasks" class="bn-item"><span class="bn-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.4"/><circle cx="4.5" cy="12" r="1.4"/><circle cx="4.5" cy="18" r="1.4"/></svg></span><span class="bn-label">待办</span></button>
  <button data-view="notes" class="bn-item"><span class="bn-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg></span><span class="bn-label">笔记</span></button>
  <button data-view="knowledge" class="bn-item"><span class="bn-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></span><span class="bn-label">知识</span></button>
  <button data-view="attachments" class="bn-item"><span class="bn-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M13 2v7h7"/></svg></span><span class="bn-label">来源</span></button>
  <button data-action="mobile-more" class="bn-item"><span class="bn-ic"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg></span><span class="bn-label">更多</span></button>
</nav>
<div id="toast"></div>
<div id="activity"></div>
<script>
const STR = {
  zh: {
    overview:'总览', notes:'笔记', attachments:'附件库', tasks:'待办', trash:'回收站', search:'搜索',
    searchPlaceholder:'搜索笔记与附件…', workspaceLabel:'工作区', localSummary:'本地: {n} 笔记 · {m} 文件',
    connected:'已连接', unavailable:'不可用', notConfigured:'未配置', error:'错误',
    overviewTitle:'工作区概览', overviewNotes:'笔记', overviewAttachments:'附件', overviewMappings:'已同步对象', overviewPendingSync:'待同步', overviewSyncErrors:'同步错误',
    overviewIntegration:'WeKnora 集成', overviewRecent:'最近更新', overviewEmpty:'工作区为空。点击「新建笔记」开始。', recentNote:'笔记', recentAttachment:'附件', noRecent:'暂无最近更新',
    newNote:'新建笔记', newFolder:'新建文件夹', emptyNotes:'还没有笔记。', emptyNotesCta:'新建第一篇笔记', loading:'加载中…', deletedSuffix:'已删除',
    save:'保存', renameMove:'重命名 / 移动', renameTitle:'重命名', del:'删除', syncNow:'立即同步', reconcile:'重建索引', localSaved:'本地已保存', localSavedR:'本地已保存 · r{r}', saving:'保存中…',
    unsaved:'未保存', saved:'已保存', saveFailed:'保存失败',
    preview:'预览', newNotePrompt:'笔记标题（路径自动生成）', renamePrompt:'新相对路径', delNoteConfirm:'删除这篇笔记？', deletedMsg:'已删除', selectNote:'从左侧选择或新建一篇笔记。',
    untitled:'untitled', notSynced:'未同步', synced:'已同步', syncing:'同步中', pending:'待同步', failed:'失败', stale:'已过期', deleted:'已删除',
    upload:'上传文件', emptyAttachments:'还没有附件。', attachmentsDesc:'管理笔记中上传的文件。', size:'大小', download:'下载', delAttachmentConfirm:'删除该附件？', attachmentDetailHint:'选中附件查看详情。',
    newMatrix:'新建四象限', smartViews:'智能视图', matrices:'四象限',
    copyWikiLink:'复制 Wiki 链接', taskComplete:'完成', taskReopen:'重新打开', taskDuplicate:'复制任务', taskDelete:'删除任务', matrixArchive:'归档', matrixRemove:'删除四象限', matrixRemoveConfirm:'删除该四象限？其全部任务将移回 Inbox。',
    matrixDeleting:'正在删除四象限', matrixMovingTasks:'正在将 {n} 个任务移回 Inbox，然后删除该四象限…', matrixDeleted:'已将 {n} 个任务移回 Inbox，并删除四象限。', matrixDeleteFailed:'删除四象限失败', retry:'重试',
    matrixTasksCount:'该四象限中共有 {n} 项任务。', matrixMoveToInbox:'移动到 Inbox', matrixMoveToInboxHint:'保留任务，只移除四象限归属', matrixDeleteTasks:'删除这些任务', matrixDeleteTasksHint:'删除四象限时同时删除其中任务（删除后无法恢复）', matrixDeletingTasks:'正在删除 {n} 项任务，然后删除四象限…', matrixDeletedTasks:'已删除 {n} 项任务和该四象限。',
    batchComplete:'标记完成', batchReopen:'重新打开', batchDelete:'删除 {n} 项任务', batchDeleteConfirm:'删除 {n} 项任务？', batchDeleteHint:'这些任务删除后无法恢复。', batchDone:'已处理 {n} 项', batchPartial:'已处理 {n} 项，{m} 项失败',
    themeSystem:'跟随系统', themeLight:'浅色', themeDark:'深色',
    knowledge:'知识', knowledgeIndexed:'已索引', knowledgePending:'待索引', knowledgeNotIndexed:'未索引', knowledgeParseFailed:'解析失败', relatedNotes:'相关笔记', relatedKnowledge:'相关知识', refAttachments:'引用附件', mime:'类型', attWaiting:'等待解析', attProcessing:'解析中', attOptimizing:'优化索引中', attReady:'已解析', attFailed:'解析失败', attachments:'附件', businessKnowledge:'知识',
    knowledgeBrowse:'浏览', knowledgeBrowseTitle:'知识发现', knowledgeEmpty:'还没有可发现的知识。', knowledgeOffline:'知识检索暂不可用', sourceLabel:'来源', attachmentsN:'附件 ×{n}', knowledgeFilterPlaceholder:'筛选知识（标题 / 摘要 / 来源）…', recentKnowledge:'最近知识', sourceOverview:'来源概览', viewAllKnowledge:'查看全部知识',
    sources:'来源', sourcesDesc:'你上传的知识资料来源文件。', usedIn:'用于', usedByN:'{n} 篇笔记使用', isolated:'未关联笔记', isolatedHint:'该文件还没有被任何笔记引用。', hasSummary:'有摘要', refresh:'刷新', sourceFiles:'来源文件', mobileMore:'更多', back:'返回', openInNewTab:'新标签打开',
    parseStatus:'解析状态', summary:'摘要', reparse:'重新解析', reparseStarted:'已提交重新解析',
    noteMissing:'笔记文件已不存在', noteMissingBody:'笔记“{id}”的 Markdown 文件在工作区中找不到，可能已被外部删除或移动。', rescan:'重新扫描', removeFromWorkspace:'从工作区移除', removeMissingConfirm:'从工作区移除“{id}”？该笔记文件已不存在。此操作将清理 PKW 中的残留记录和知识库投影，无法从回收站恢复该文件。',
    missingSource:'源文件已不存在',
    companionNote:'建立伴随笔记', noteLocation:'笔记位置', kbIndex:'解析并索引', kbIndexHint:'提取摘要与正文用于搜索', uploadedNoNote:'文件已上传，但伴随笔记创建失败', uploadedCompanion:'已生成 {n} 篇伴随笔记',
    attGridView:'网格视图', attListView:'列表视图', attSearchPlaceholder:'搜索文件名…', attTypeAll:'全部', attTypeImage:'图片', attTypeDocument:'文档', attTypeOther:'其它', attSort:'排序', attSortRecent:'最近', attSortName:'名称', attSortSize:'大小',
    attSelectAll:'全选', attSelected:'已选择 {n} 项', attBatchTrash:'移入回收站', attBatchReparse:'重新解析', attBatchIndex:'重新索引', attClearSelection:'取消选择',
    attCompanion:'伴随笔记', attCreateCompanion:'创建伴随笔记', attOpenCompanion:'打开伴随笔记', attPreview:'预览', attCopyRef:'复制引用', attNoCompanion:'未建伴随笔记', attCopied:'已复制引用', attUploadResult:'上传完成：附件 {a} · 伴随笔记 {n} · 失败 {f}', attUploadResultNoNote:'上传完成：附件 {a} 成功，伴随笔记失败 {f}', attUploadPartial:'部分上传失败：{a}/{t} 成功', attCreatedNote:'已创建伴随笔记', attOpenedExisting:'该附件已有伴随笔记，已打开', attBatchNoSelection:'请先选择附件', companionUpgrade:'将伴随笔记作为独立知识同步', companionUpgraded:'已作为独立知识同步', attachmentBacked:'附件驱动（不独立同步）',
    uploadProgress:'上传中…', uploadSuccess:'已上传', uploadFailed:'上传失败', searching:'搜索中…', noHits:'没有命中「{q}」。', searchHint:'输入关键词搜索笔记与附件。',
    score:'得分', openNote:'打开笔记', openAttachment:'打开附件', noteLabel:'笔记', attachmentLabel:'附件', noteBodyMatch:'正文命中', attMatch:'附件命中',
    details:'详情', noteId:'NoteId', attachmentId:'AttachmentId', path:'路径', revision:'版本', updated:'更新时间', lastError:'最近错误', maintenance:'维护', advanced:'高级',
    workspaceSummary:'工作区摘要', kb:'知识库', state:'状态', parse:'解析', syncSection:'WeKnora 同步', noSyncInfo:'尚未同步。',
    reconcileDone:'重建完成', reconcileResult:'笔记修复 {a} · 附件修复 {b} · 待同步 {c} · 已删 {d}', syncingAll:'正在同步…', genericError:'操作失败', ok:'完成', emptyPreview:'（空）', searchFailed:'搜索失败',
    folder:'文件夹', rootFolder:'（根目录）', notesRoot:'笔记', upLevel:'上一级', newNoteHere:'在此新建笔记', newSubfolder:'新建子文件夹', renameFolder:'重命名', moveTo:'移动到…', deleteFolder:'删除文件夹', trashFolder:'移入回收站',
    recentNotes:'最近笔记', foldersSection:'文件夹', allNotes:'全部笔记', recentEdited:'最近编辑', myFolders:'我的文件夹', manageFolders:'管理文件夹', unfiled:'未归档', notesCount:'{n} 篇笔记', noFolders:'还没有文件夹。', mobileEditDesktopOnly:'正文编辑请在桌面端使用',
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
    searchPlaceholder:'Search notes & attachments…', workspaceLabel:'Workspace', localSummary:'Local: {n} notes · {m} files',
    connected:'Connected', unavailable:'Unavailable', notConfigured:'Not configured', error:'error',
    overviewTitle:'Workspace Overview', overviewNotes:'Notes', overviewAttachments:'Attachments', overviewMappings:'Synced objects', overviewPendingSync:'Pending sync', overviewSyncErrors:'Sync errors',
    overviewIntegration:'WeKnora integration', overviewRecent:'Recent', overviewEmpty:'Workspace is empty. Click 「New Note」 to start.', recentNote:'Note', recentAttachment:'Attachment', noRecent:'No recent changes',
    newNote:'New Note', newFolder:'New Folder', emptyNotes:'No notes yet.', emptyNotesCta:'Create your first note', loading:'Loading…', deletedSuffix:'deleted',
    save:'Save', renameMove:'Rename / Move', renameTitle:'Rename', del:'Delete', syncNow:'Sync now', reconcile:'Reconcile', localSaved:'Local saved', localSavedR:'Local saved · r{r}', saving:'Saving…',
    unsaved:'Unsaved', saved:'Saved', saveFailed:'Save failed',
    preview:'Preview', newNotePrompt:'Note title (path is auto-generated)', renamePrompt:'New relative path', delNoteConfirm:'Delete this note?', deletedMsg:'Deleted', selectNote:'Select or create a note from the left.',
    untitled:'untitled', notSynced:'Not synced', synced:'Synced', syncing:'Syncing', pending:'Pending', failed:'Failed', stale:'Stale', deleted:'Deleted',
    upload:'Upload file', emptyAttachments:'No attachments yet.', attachmentsDesc:'Manage files uploaded in notes.', size:'Size', download:'Download', delAttachmentConfirm:'Delete this attachment?', attachmentDetailHint:'Select an attachment to view details.',
    newMatrix:'New matrix', smartViews:'Smart views', matrices:'Matrices',
    copyWikiLink:'Copy wiki link', taskComplete:'Complete', taskReopen:'Reopen', taskDuplicate:'Duplicate task', taskDelete:'Delete task', matrixArchive:'Archive', matrixRemove:'Delete matrix', matrixRemoveConfirm:'Delete this matrix? All its tasks will move back to Inbox.',
    matrixDeleting:'Deleting matrix', matrixMovingTasks:'Moving {n} tasks back to Inbox, then deleting this matrix…', matrixDeleted:'Moved {n} tasks back to Inbox and deleted the matrix.', matrixDeleteFailed:'Failed to delete matrix', retry:'Retry',
    matrixTasksCount:'This matrix has {n} tasks.', matrixMoveToInbox:'Move to Inbox', matrixMoveToInboxHint:'Keep tasks, only remove the matrix', matrixDeleteTasks:'Delete these tasks', matrixDeleteTasksHint:'Delete the tasks together with the matrix (cannot be undone)', matrixDeletingTasks:'Deleting {n} tasks, then deleting this matrix…', matrixDeletedTasks:'Deleted {n} tasks and the matrix.',
    batchComplete:'Mark complete', batchReopen:'Reopen', batchDelete:'Delete {n} tasks', batchDeleteConfirm:'Delete {n} tasks?', batchDeleteHint:'These tasks cannot be restored after deletion.', batchDone:'Processed {n} items', batchPartial:'Processed {n} items, {m} failed',
    themeSystem:'Follow system', themeLight:'Light', themeDark:'Dark',
    knowledge:'Knowledge', knowledgeIndexed:'Indexed', knowledgePending:'Pending', knowledgeNotIndexed:'Not indexed', knowledgeParseFailed:'Parse failed', relatedNotes:'Related notes', relatedKnowledge:'Related knowledge', refAttachments:'Referenced attachments', mime:'Type', attWaiting:'Waiting', attProcessing:'Processing', attOptimizing:'Optimizing index', attReady:'Parsed', attFailed:'Parse failed', attachments:'Attachments', businessKnowledge:'Knowledge',
    knowledgeBrowse:'Browse', knowledgeBrowseTitle:'Knowledge Discovery', knowledgeEmpty:'No discoverable knowledge yet.', knowledgeOffline:'Knowledge search unavailable', sourceLabel:'Source', attachmentsN:'{n} attachments', knowledgeFilterPlaceholder:'Filter knowledge (title / summary / source)…', recentKnowledge:'Recent knowledge', sourceOverview:'Source overview', viewAllKnowledge:'View all knowledge',
    sources:'Sources', sourcesDesc:'The source files that make up your knowledge.', usedIn:'Used in', usedByN:'{n} notes use this', isolated:'Not linked to a note', isolatedHint:'This file is not referenced by any note yet.', hasSummary:'Has summary', refresh:'Refresh', sourceFiles:'Source files', mobileMore:'More', back:'Back', openInNewTab:'Open in new tab',
    parseStatus:'Parse status', summary:'Summary', reparse:'Reparse', reparseStarted:'Reparse submitted',
    noteMissing:'Note file is missing', noteMissingBody:'The Markdown file for note "{id}" cannot be found in the workspace. It may have been deleted or moved externally.', rescan:'Rescan', removeFromWorkspace:'Remove from workspace', removeMissingConfirm:'Remove "{id}" from the workspace? Its file is already missing. This will clean up the leftover PKW records and knowledge projection, and the file cannot be restored from Trash.',
    missingSource:'Source file missing',
    companionNote:'Create companion note', noteLocation:'Note location', kbIndex:'Parse & index', kbIndexHint:'Extract summary & text for search', uploadedNoNote:'File uploaded, but companion note creation failed', uploadedCompanion:'Created {n} companion notes',
    attGridView:'Grid view', attListView:'List view', attSearchPlaceholder:'Search filename…', attTypeAll:'All', attTypeImage:'Images', attTypeDocument:'Documents', attTypeOther:'Other', attSort:'Sort', attSortRecent:'Recent', attSortName:'Name', attSortSize:'Size',
    attSelectAll:'Select all', attSelected:'{n} selected', attBatchTrash:'Trash', attBatchReparse:'Reparse', attBatchIndex:'Re-index', attClearSelection:'Clear selection',
    attCompanion:'Companion note', attCreateCompanion:'Create companion note', attOpenCompanion:'Open companion note', attPreview:'Preview', attCopyRef:'Copy reference', attNoCompanion:'No companion note', attCopied:'Reference copied', attUploadResult:'Upload done: {a} attachments · {n} companion notes · {f} failed', attUploadResultNoNote:'Upload done: {a} attachments, {f} companion notes failed', attUploadPartial:'Partial upload: {a}/{t} succeeded', attCreatedNote:'Companion note created', attOpenedExisting:'Companion note already exists — opened', attBatchNoSelection:'Select attachments first', companionUpgrade:'Sync companion note as independent knowledge', companionUpgraded:'Synced as independent knowledge', attachmentBacked:'Attachment-backed (not independently synced)',
    uploadProgress:'Uploading…', uploadSuccess:'Uploaded', uploadFailed:'Upload failed', searching:'Searching…', noHits:'No hits for 「{q}」.', searchHint:'Type a query to search notes & attachments.',
    score:'score', openNote:'Open note', openAttachment:'Open attachment', noteLabel:'Note', attachmentLabel:'Attachment', noteBodyMatch:'Body match', attMatch:'Attachment match',
    details:'Details', noteId:'NoteId', attachmentId:'AttachmentId', path:'Path', revision:'Revision', updated:'Updated', lastError:'Last error', maintenance:'Maintenance', advanced:'Advanced',
    workspaceSummary:'Workspace summary', kb:'KB', state:'State', parse:'Parse', syncSection:'WeKnora Sync', noSyncInfo:'Not synced yet.',
    reconcileDone:'Reconcile done', reconcileResult:'Notes repaired {a} · attachments repaired {b} · dirty {c} · deleted {d}', syncingAll:'Syncing…', genericError:'Operation failed', ok:'Done', emptyPreview:'(empty)', searchFailed:'Search failed',
    folder:'Folder', rootFolder:'(root)', notesRoot:'Notes', upLevel:'Up', newNoteHere:'New note here', newSubfolder:'New subfolder', renameFolder:'Rename', moveTo:'Move to…', deleteFolder:'Delete folder', trashFolder:'Move to trash',
    recentNotes:'Recent notes', foldersSection:'Folders', allNotes:'All notes', recentEdited:'Recently edited', myFolders:'My folders', manageFolders:'Manage folders', unfiled:'Unfiled', notesCount:'{n} notes', noFolders:'No folders yet.', mobileEditDesktopOnly:'Editing is available on desktop',
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
  mobileNotesFolder: null,
  explorerSel: new Set(),
  selectedAttachmentId: null,
  sortMode: localStorage.getItem('pkw-sort') || 'manual',
  treeRoot: [],
  collapsed: new Set(),
  editor: { noteId: null, persistedMarkdown: '', dirty: false, saving: false, mode: localStorage.getItem('pkw-editor-mode') || 'live' },
  taskView: localStorage.getItem('pkw-task-view') || 'all',
  mobileTaskBoard: 'inbox',
  mobileTaskBoardChosen: false,
  mobileTaskQ: 1,
  mobileOpenSections: new Set(),
  highlightText: '',
  tasksCache: [],
  matricesCache: [],
  attachmentsCache: [],
  noteAttachments: [],
  searchContext: null,
  searchQuery: '',
  searchResults: null,
  attMode: localStorage.getItem('pkw-att-mode') || 'list',
  attQuery: localStorage.getItem('pkw-att-query') || '',
  attType: localStorage.getItem('pkw-att-type') || 'all',
  attSort: localStorage.getItem('pkw-att-sort') || 'recent',
  attSelection: new Set(),
  trashCache: null,
  summaryCache: null,
  scroll: { main: {}, list: {} },
  trashSelection: new Set(),
  trashFilter: 'all',
  trashBusy: false,
  inspectorCollapsed: false,
  selectedTaskIds: new Set(),
  knowledgeCache: null,
  knowledgeShowAll: false,
}
// ── View switching: navigation guard + single-flight + instrumentation ──────
let viewSeq = 0
let viewStart = 0
let noteSeq = 0
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
// Lightweight dev mutation timing (A6): marks each awaited stage so a stuck
// mutation can be localized without a profiler. console.debug only — never UI.
function mutSpan(action){
  const t0 = performance.now()
  const mark = (p) => console.debug('[pkw.mut] ' + action + ' ' + p + ' +' + Math.round(performance.now() - t0) + 'ms')
  const end = (p) => console.debug('[pkw.mut] ' + action + ' ' + p + ' total=' + Math.round(performance.now() - t0) + 'ms')
  return { mark, end }
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
// Lightweight activity indicator (bottom pill): real feedback for async ops that
// can't show byte progress. Not a job system — just an indeterminate spinner.
function showActivity(msg){ const el = $('#activity'); if (!el) return; el.innerHTML = '<span class="spinner"></span>' + esc(msg); el.style.display = 'flex'; clearTimeout(showActivity._t) }
function clearActivity(){ const el = $('#activity'); if (!el) return; clearTimeout(showActivity._t); showActivity._t = setTimeout(() => { el.style.display = 'none' }, 150) }
function applyLang(){ document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'; $('#langBtn').textContent = lang === 'zh' ? 'EN' : '中文'; document.querySelectorAll('.nav .launch-item').forEach(b => { const l = b.querySelector('.li-label'); if (l) l.textContent = b.dataset.view === 'attachments' ? t('sources') : t(b.dataset.view) }); document.querySelectorAll('#bottomNav .bn-item').forEach(b => { const l = b.querySelector('.bn-label'); if (l) l.textContent = b.dataset.view === 'attachments' ? t('sources') : t(b.dataset.view) }) }
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
function knowledgeBadge(s){
  if (!s || (s.syncState === undefined && !s.pending && !s.error)) return '<span class="badge">' + esc(t('knowledgeNotIndexed')) + '</span>'
  if (s.error || s.remoteParseStatus === 'failed') return '<span class="badge err">' + esc(t('knowledgeParseFailed')) + '</span>'
  if (s.pending) return '<span class="badge warn">' + esc(t('knowledgePending')) + '</span>'
  if (s.syncState === 'synced') return '<span class="badge ok">' + esc(t('knowledgeIndexed')) + '</span>'
  return '<span class="badge">' + esc(t('knowledgeNotIndexed')) + '</span>'
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
  clearTimeout(sourcesPollTimer)
  if (v !== 'notes') { state.selectedNoteId = null; state.selectedFolder = null }
  if (v !== 'attachments') state.selectedAttachmentId = null
  render()
}
function render(){
  applyLang()
  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.view === state.view))
  document.querySelectorAll('#bottomNav .bn-item').forEach(b => b.classList.toggle('active', b.dataset.view === state.view))
  const pageTitle = $('#pageTitle')
  if (pageTitle) {
    let title = isMobile() ? (state.view === 'attachments' ? t('sources') : t(state.view)) : 'PKW'
    if (isMobile() && state.view === 'notes' && state.selectedNoteId === null && state.mobileNotesFolder === null) title = t('notes') + ' ▾'
    else if (isMobile() && state.view === 'notes' && state.mobileNotesFolder !== null) title = '📁 ' + state.mobileNotesFolder.split('/').pop()
    pageTitle.textContent = title
  }
  refreshHeader()
  if (state.view === 'overview') renderOverview()
  else if (state.view === 'notes') { renderTreeToolbar(); renderTree(); renderDetail(); if (state.selectedNoteId === null) renderNotesExplorer(); ensureVditorLoaded().catch(() => {}) }
  else if (state.view === 'attachments') renderAttachments()
  else if (state.view === 'tasks') renderTasks()
  else if (state.view === 'trash') renderTrash()
  else if (state.view === 'knowledge') renderKnowledgeView()
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
  const seq = viewSeq
  // stale-while-revalidate: never blank an existing tree with a loading placeholder.
  if (state.treeRoot.length === 0) $('#list').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  try {
    const tree = await api('getTree', { sortMode: state.sortMode })
    if (seq !== viewSeq) return // stale response: a newer navigation owns the surface
    state.treeRoot = tree.root || []
    $('#list').innerHTML = renderTreeNodes(state.treeRoot, '') || '<div class="empty">' + esc(t('emptyNotes')) + '<div class="cta"><button class="btn primary" data-action="new-note">+ ' + esc(t('emptyNotesCta')) + '</button></div></div>'
    if (state.view === 'notes' && state.selectedNoteId === null) renderNotesExplorer()
    restoreScroll()
  } catch (e) { if (state.treeRoot.length === 0 && seq === viewSeq) $('#list').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}
function renderTreeNodes(nodes){ if (!nodes.length) return ''; return nodes.map(n => n.kind === 'folder' ? renderFolderNode(n) : renderNoteNode(n)).join('') }
function renderFolderNode(n){
  const sel = state.selectedFolder === n.path ? ' active' : ''
  const collapsed = state.collapsed.has(n.path)
  return '<div><div class="tree-row folder ' + sel + '" data-action="select-folder" data-path="' + esc(n.path) + '"><span class="tw" data-action="toggle-folder" data-path="' + esc(n.path) + '">' + (collapsed ? '▸' : '▾') + '</span><span class="ic">📁</span><span class="nm">' + esc(n.name) + '</span></div><div class="tree-children" data-folder="' + esc(n.path) + '"' + (collapsed ? ' style="display:none"' : '') + '>' + renderTreeNodes(n.children || []) + '</div></div>'
}
function renderNoteNode(n){
  const sel = state.selectedNoteId === n.noteId ? ' active' : ''
  return '<div class="tree-row note ' + sel + '" data-action="open-note" data-id="' + esc(n.noteId) + '"><span class="tw"></span><span class="ic">📄</span><span class="nm note-title" data-id="' + esc(n.noteId) + '">' + esc(n.title || n.relativePath) + '</span> <span class="syncbadge" data-sync="note:' + esc(n.noteId) + '">' + syncBadgeHtml(n.sync) + '</span></div>'
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
// Notes Explorer: the Main-area surface for the Notes view when no Note is open.
// Folder-aware (D): direct child folders + direct child notes of the CURRENT
// folder ('' = root), breadcrumb + up-level, per-scope multi-select (E).
function explorerNoteRow(n, checked){
  const key = 'note:' + n.noteId
  return '<div class="tree-row note explorer-item" data-action="explorer-note" data-id="' + esc(n.noteId) + '">' +
    '<input type="checkbox" class="exp-check" data-action="explorer-toggle" data-key="' + esc(key) + '"' + (checked ? ' checked' : '') + '>' +
    '<span class="ic">📄</span>' +
    '<span class="nm note-title" data-id="' + esc(n.noteId) + '">' + esc(n.title || n.relativePath) + '</span>' +
    '<span class="spacer" style="flex:1 1 auto"></span>' +
    '<span class="muted small">' + esc(fmtStamp(n.updatedAt)) + '</span>' +
    '<span class="syncbadge" data-sync="note:' + esc(n.noteId) + '">' + syncBadgeHtml(n.sync) + '</span>' +
    '<button class="btn small" data-action="rename-note" data-id="' + esc(n.noteId) + '">' + esc(t('renameTitle')) + '</button>' +
    '</div>'
}
function explorerFolderRow(f, checked){
  const key = 'folder:' + f.path
  return '<div class="tree-row folder explorer-item" data-action="explorer-folder" data-path="' + esc(f.path) + '">' +
    '<input type="checkbox" class="exp-check" data-action="explorer-toggle" data-key="' + esc(key) + '"' + (checked ? ' checked' : '') + '>' +
    '<span class="ic">📁</span>' +
    '<span class="nm">' + esc(f.name) + '</span>' +
    '<span class="muted small">' + esc(t('notesCount', { n: folderNoteCount(f) })) + '</span>' +
    '<span class="spacer" style="flex:1 1 auto"></span>' +
    '<span class="chev">›</span>' +
    '</div>'
}
function explorerSelBarHtml(){
  if (state.explorerSel.size === 0) return ''
  return '<div class="toolbar sel-bar">' +
    '<span class="muted">' + esc(t('trashSelected', { n: state.explorerSel.size })) + '</span>' +
    '<button class="btn" data-action="explorer-select-all">' + esc(t('trashSelectAll')) + '</button>' +
    '<button class="btn" data-action="explorer-bulk-move">' + esc(t('moveTo')) + '…</button>' +
    '<button class="btn danger" data-action="explorer-bulk-trash">' + esc(t('trashFolder')) + '</button>' +
    '<button class="btn" data-action="explorer-clear">' + esc(t('trashClearSelection')) + '</button>' +
    '</div>'
}
function renderDesktopExplorer(path){
  const cur = path || ''
  const allNotes = []
  collectNotes(state.treeRoot || [], allNotes)
  const allFolders = []
  collectFolders(state.treeRoot || [], allFolders)
  const childFolders = allFolders.filter(f => parentOfPath(f.path) === cur)
  const childNotes = allNotes.filter(n => (n.folder || '') === cur)

  // Breadcrumb (D2): ↑ up-level + 笔记 / seg / seg, each clickable.
  let crumb = '<div class="crumbs"><button class="btn small" data-action="explorer-up"' + (cur === '' ? ' disabled' : '') + '>↑ ' + esc(t('upLevel')) + '</button>'
  crumb += '<button class="crumb-link" data-action="explorer-crumb" data-path="">' + esc(t('notesRoot')) + '</button>'
  let acc = ''
  for (const s of (cur ? cur.split('/') : [])) { acc = acc ? acc + '/' + s : s; crumb += '<span class="crumb-sep">/</span><button class="crumb-link" data-action="explorer-crumb" data-path="' + esc(acc) + '">' + esc(s) + '</button>' }
  crumb += '</div>'

  const toolbar = '<div class="toolbar"><button class="btn primary" data-action="new-note-here" data-path="' + esc(cur) + '">+ ' + esc(t('newNote')) + '</button>' +
    '<button class="btn" data-action="new-subfolder" data-path="' + esc(cur) + '">+ ' + esc(t('newFolder')) + '</button>' +
    (cur !== '' ? '<button class="btn" data-action="folder-menu" data-path="' + esc(cur) + '">' + esc(t('folder')) + ' ⋯</button>' : '') +
    '</div>'

  const body = (childFolders.length || childNotes.length)
    ? childFolders.map(f => explorerFolderRow(f, state.explorerSel.has('folder:' + f.path))).join('') +
      childNotes.map(n => explorerNoteRow(n, state.explorerSel.has('note:' + n.noteId))).join('')
    : '<div class="empty"><h3>' + esc(t('emptyNotes')) + '</h3><div class="cta"><button class="btn primary" data-action="new-note-here" data-path="' + esc(cur) + '">+ ' + esc(t('emptyNotesCta')) + '</button></div></div>'

  $('#main').innerHTML = '<h2>' + (cur ? esc(cur.split('/').pop()) : esc(t('notes'))) + '<span class="sub mono">' + esc(t('notesRoot') + (cur ? '/' + cur : '')) + '/</span></h2>' +
    crumb + explorerSelBarHtml() + toolbar + '<div>' + body + '</div>'
  renderDetail()
}
function renderNotesExplorer(){
  if (isMobile()) {
    if (state.mobileNotesFolder !== null) { renderMobileFolderView(state.mobileNotesFolder); return }
    renderMobileNotesHome()
    return
  }
  renderDesktopExplorer(state.selectedFolder || '')
}
function collectFolders(nodes, out){ for (const n of nodes) { if (n.kind === 'folder') { out.push(n); collectFolders(n.children || [], out) } else if (n.children) collectFolders(n.children, out) } }
// Explorer selection (E): keyed by 'note:<id>' / 'folder:<path>'.
function explorerScopeKeys(path){
  const cur = path || ''
  const allNotes = []
  collectNotes(state.treeRoot || [], allNotes)
  const allFolders = []
  collectFolders(state.treeRoot || [], allFolders)
  const keys = []
  for (const f of allFolders) if (parentOfPath(f.path) === cur) keys.push('folder:' + f.path)
  for (const n of allNotes) if ((n.folder || '') === cur) keys.push('note:' + n.noteId)
  return keys
}
function explorerToggleSel(key){
  if (state.explorerSel.has(key)) state.explorerSel.delete(key)
  else state.explorerSel.add(key)
  renderNotesExplorer()
}
function explorerClearSel(){ state.explorerSel.clear(); renderNotesExplorer() }
function explorerSelectAllScope(){
  for (const k of explorerScopeKeys(state.selectedFolder || '')) state.explorerSel.add(k)
  renderNotesExplorer()
}
// Normalize a mixed selection: a selected folder already covers its descendants,
// so drop descendant notes/folders to avoid double-mutating (E1).
function explorerNormalizedSelection(){
  const folderPaths = []
  const noteIds = []
  for (const k of state.explorerSel) {
    if (k.startsWith('folder:')) folderPaths.push(k.slice(7))
    else if (k.startsWith('note:')) noteIds.push(k.slice(5))
  }
  const coveredNote = id => {
    // A note is covered if any selected folder is its folder or ancestor.
    const n = (state.treeRoot && flattenNotes(state.treeRoot).find(x => x.noteId === id))
    if (!n) return false
    return folderPaths.some(fp => (n.folder || '') === fp || (n.folder || '').startsWith(fp + '/'))
  }
  const finalFolders = folderPaths.filter(fp => !folderPaths.some(other => other !== fp && fp.startsWith(other + '/')))
  const finalNotes = noteIds.filter(id => !coveredNote(id))
  return { folders: finalFolders, notes: finalNotes }
}
function flattenNotes(nodes){ const out = []; collectNotes(nodes, out); return out }
async function explorerBulkTrash(){
  const { folders, notes } = explorerNormalizedSelection()
  if (folders.length === 0 && notes.length === 0) return
  try {
    showActivity(t('trashDeleting'))
    for (const f of folders) await api('trashFolder', { path: f })
    for (const id of notes) await api('deleteNote', { noteId: id })
    state.explorerSel.clear()
    if (state.selectedFolder !== null && folders.includes(state.selectedFolder)) state.selectedFolder = null
    clearActivity()
    toast(t('deletedMsg'), 'ok')
    await renderTree()
    renderNotesExplorer()
    refreshHeader()
  } catch (e) { clearActivity(); toast(t('genericError') + ': ' + e.message, 'err') }
}
function explorerBulkMove(){
  const { folders, notes } = explorerNormalizedSelection()
  if (folders.length === 0 && notes.length === 0) return
  showFolderPicker('', async (target) => {
    try {
      showActivity(t('moveTo'))
      for (const f of folders) {
        const newPath = (target ? target + '/' : '') + f.split('/').pop()
        if (newPath !== f) await api('renameFolder', { path: f, newPath })
      }
      for (const id of notes) {
        const cur = await api('getNote', { noteId: id })
        const rel = (target ? target + '/' : '') + cur.note.relativePath.split('/').pop()
        if (rel !== cur.note.relativePath) await api('moveNote', { noteId: id, relativePath: rel })
      }
      state.explorerSel.clear()
      clearActivity()
      toast(t('localSaved'), 'ok')
      await renderTree()
      renderNotesExplorer()
    } catch (e) { clearActivity(); toast(t('genericError') + ': ' + e.message, 'err') }
  })
}
function folderNoteCount(folderNode){
  let c = 0
  const walk = (nodes) => { for (const n of nodes) { if (n.kind === 'note') c++; else if (n.kind === 'folder') walk(n.children || []) } }
  walk(folderNode.children || [])
  return c
}
function mobileFolderCard(f){
  const count = folderNoteCount(f)
  return '<div class="mfolder" data-action="mobile-folder-open" data-path="' + esc(f.path) + '">' +
    '<span class="mfolder-ic">📁</span>' +
    '<div class="mfolder-main"><div class="mfolder-name">' + esc(f.name) + '</div><div class="mfolder-count">' + esc(t('notesCount', { n: count })) + '</div></div>' +
    '<button class="mnote-more" data-action="mobile-folder-menu" data-path="' + esc(f.path) + '">⋯</button>' +
    '<span class="chev">›</span></div>'
}
function renderMobileNotesHome(){
  const folders = (state.treeRoot || []).filter(n => n.kind === 'folder')
  const allNotes = []
  collectNotes(state.treeRoot || [], allNotes)
  const unfiled = allNotes.filter(n => parentOfPath(n.relativePath || '') === '')
  const recent = allNotes.filter(n => parentOfPath(n.relativePath || '') !== '').slice().sort((a, b) => (a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1).slice(0, 10)
  const foldersHtml = folders.length ? folders.map(mobileFolderCard).join('') : '<div class="empty small">' + esc(t('noFolders')) + '</div>'
  const unfiledHtml = unfiled.length ? unfiled.map(n => mobileNoteRow(n)).join('') : '<div class="empty small">' + esc(t('emptyNotes')) + '</div>'
  const recentHtml = recent.length ? recent.map(n => mobileNoteRow(n)).join('') : ''
  $('#main').innerHTML =
    '<div class="toolbar"><button class="btn primary" data-action="mobile-notes-new">+</button></div>' +
    '<div class="list-section">' + esc(t('foldersSection')) + '</div>' + foldersHtml +
    '<div class="list-section">' + esc(t('unfiled')) + '</div>' + unfiledHtml +
    (recentHtml ? '<div class="list-section">' + esc(t('recentNotes')) + '</div>' + recentHtml : '')
}
function renderMobileFolderView(path){
  const notes = []
  collectNotes(state.treeRoot || [], notes)
  const folderNotes = notes.filter(n => parentOfPath(n.relativePath || '') === path)
  const name = path.split('/').pop()
  $('#main').innerHTML =
    '<div class="toolbar"><button class="btn" data-action="mobile-notes-back">← ' + esc(t('back')) + '</button><span class="mfolder-title">📁 ' + esc(name) + '</span><span class="spacer" style="flex:1"></span><button class="btn primary" data-action="mobile-notes-new">+</button><button class="btn small" data-action="mobile-folder-menu" data-path="' + esc(path) + '">⋯</button></div>' +
    (folderNotes.length ? folderNotes.map(n => mobileNoteRow(n)).join('') : '<div class="empty">' + esc(t('emptyNotes')) + '</div>')
}
function mobileNotesScopeSheet(){
  const folders = (state.treeRoot || []).filter(n => n.kind === 'folder')
  const items = [
    { label: t('allNotes'), action: 'mobile-notes-home' },
    { label: t('recentEdited'), action: 'mobile-notes-home' },
  ]
  for (const f of folders) items.push({ label: '📁 ' + f.name, action: 'mobile-folder-open', id: f.path })
  items.push({ label: '+ ' + t('newFolder'), action: 'new-folder' })
  mobileActionSheet(t('notes'), items)
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
    if (/^\\s*<!-- pkw:attachment-summary:(?:start|end)[^>]*-->\\s*$/.test(line)) { i++; continue }
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
    // Fenced code block (backtick or tilde) with unmatched-fence tolerance.
    const fc = line.trimStart().charCodeAt(0)
    if ((fc === 96 || fc === 126) && line.trimStart().charCodeAt(1) === fc && line.trimStart().charCodeAt(2) === fc) {
      let closer = -1
      for (let j = i + 1; j < lines.length; j++) { const t = lines[j].trimStart(); if (t.charCodeAt(0) === fc && t.charCodeAt(1) === fc && t.charCodeAt(2) === fc) { closer = j; break } }
      if (closer < 0) { html.push('<hr />'); i++; continue } // unmatched opener → horizontal rule, don't swallow the body
      const lang = line.trim().slice(3).trim()
      const code = []
      i++
      while (i < closer) { code.push(lines[i]); i++ }
      i++ // skip closer
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
function destroyVditor(){ if (setupLiveAttachmentRewrite._obs) { setupLiveAttachmentRewrite._obs.disconnect(); setupLiveAttachmentRewrite._obs = null } if (vditor) { try { vditor.destroy() } catch (e) {} vditor = null } }

async function openNote(noteId){
  const seq = ++noteSeq
  state.selectedNoteId = noteId; state.selectedFolder = null
  destroyVditor()
  clearTimeout(sourcesPollTimer)
  state.editor = { noteId, persistedMarkdown: '', dirty: false, saving: false, mode: localStorage.getItem('pkw-editor-mode') || 'live' }
  $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'
  $('#detail').innerHTML = '' // clear stale Inspector immediately
  try {
    const d = await api('getNote', { noteId })
    if (seq !== noteSeq || state.view !== 'notes') return // stale: a newer note/view owns the surface
    state.editor = { noteId, persistedMarkdown: d.markdown, body: d.body || '', frontmatter: d.frontmatter || '', dirty: false, saving: false, mode: isMobile() ? 'reading' : (localStorage.getItem('pkw-editor-mode') || 'live'), observedRevision: d.note && d.note.observedRevision, contentHash: d.note && d.note.contentHash }
    state.noteAttachments = d.attachments || []
    // Expand parent folders so the opened Note is visible + highlighted in the tree
    // (identity stays NoteId; path is only used to reveal ancestors).
    if (d.note && d.note.relativePath) expandFoldersForPath(d.note.relativePath)
    $('#main').innerHTML = renderEditorShell(d)
    bindEditor()
    $('#detail').innerHTML = detailNote(d)
    renderNoteAttachmentKnowledge(d)
    renderSources(d.note.noteId, d.attachments)
    renderRelatedKnowledge(d)
    await renderTree()
    kickSyncPoll(d.sync)
  } catch (e) {
    if (seq !== noteSeq) return // stale error: ignore
    if (String(e.message || '').indexOf('file is missing') >= 0) renderMissingNote(noteId)
    else { $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>'; $('#detail').innerHTML = '' }
  }
}
function renderMissingNote(noteId){
  $('#main').innerHTML = '<div class="empty"><h3>⚠ ' + esc(t('noteMissing')) + '</h3><p class="muted">' + esc(t('noteMissingBody', { id: noteId })) + '</p><div class="cta"><button class="btn" data-action="rescan-notes">' + esc(t('rescan')) + '</button> <button class="btn danger" data-action="remove-missing-note" data-id="' + esc(noteId) + '">' + esc(t('removeFromWorkspace')) + '</button></div></div>'
  $('#detail').innerHTML = '<h3>⚠ ' + esc(t('noteMissing')) + '</h3><div class="kv"><b>' + esc(t('noteId')) + '</b> <span class="v mono">' + esc(noteId) + '</span></div>'
}
function expandFoldersForPath(relativePath){
  const parts = String(relativePath || '').split('/')
  let cur = ''
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur === '' ? parts[i] : cur + '/' + parts[i]
    state.collapsed.delete(cur)
  }
}
function searchContextBanner(ctx){
  let label = t('noteBodyMatch')
  if (ctx.reason === 'both') label = t('noteBodyMatch') + ' · ' + t('attMatch') + ' · ' + esc(ctx.attName || '')
  else if (ctx.reason === 'attachment') label = t('attMatch') + ' · ' + esc(ctx.attName || '')
  return '<div class="search-context-banner">' + label + '</div>'
}
function renderEditorShell(d){
  const mode = state.editor.mode
  const fm = parseFrontmatterClient(d.markdown)
  const modeBtn = (m, key) => '<button class="btn mode ' + (mode === m ? 'active' : '') + '" data-action="set-mode" data-mode="' + m + '">' + esc(t(key)) + '</button>'
  if (isMobile()) {
    // OPTION C: Mobile Read-first. Reliable reading/managing/searching on mobile;
    // full body editing stays on Desktop. No Vditor/textarea on mobile.
    return '<div class="toolbar">' +
      '<button class="btn small" data-action="mobile-back-notes">← ' + esc(t('notes')) + '</button>' +
      '<span class="spacer"></span>' +
      '<button class="btn small" data-action="mobile-editor-menu">⋯</button>' +
      '</div>' +
      '<div class="editor-head"><span class="title note-title" data-id="' + esc(state.selectedNoteId) + '">' + esc(fm.title || d.note.title || '') + '</span><span class="path">' + esc(d.note.relativePath) + '</span></div>' +
      '<div class="mobile-readonly-hint">' + esc(t('mobileEditDesktopOnly')) + '</div>' +
      '<div id="editorPane"><div id="preview"></div></div>' +
      '<div id="bkAttachments"></div><div id="relatedKnowledge"></div>'
  }
  return '<div class="toolbar">' +
    '<button class="btn primary" data-action="save-note">' + esc(t('save')) + '</button>' +
    '<button class="btn" data-action="rename-note">' + esc(t('renameTitle')) + '</button>' +
    '<button class="btn" data-action="move-note" data-id="' + esc(state.selectedNoteId) + '">' + esc(t('moveNoteTo')) + '</button>' +
    (d.note && d.note.attachmentBacked ? '<button class="btn" data-action="upgrade-companion" data-id="' + esc(state.selectedNoteId) + '">' + esc(t('companionUpgrade')) + '</button>' : '<button class="btn" data-action="sync-note" data-id="' + esc(state.selectedNoteId) + '">' + esc(t('syncNow')) + '</button>') +
    '<button class="btn" data-action="selection-to-task">' + esc(t('selectionToTask')) + '</button>' +
    '<button class="btn danger" data-action="delete-note">' + esc(t('del')) + '</button>' +
    '<span id="saveStatus" class="saved">✓ ' + esc(t('saved')) + '</span>' +
    '<span class="spacer"></span>' + modeBtn('live', 'modeLive') + modeBtn('source', 'modeSource') + modeBtn('reading', 'modeReading') +
    '</div>' +
    '<div class="editor-head"><span class="title note-title" data-id="' + esc(state.selectedNoteId) + '">' + esc(fm.title || d.note.title || '') + '</span><span class="path">' + esc(d.note.relativePath) + '</span></div>' +
    (state.searchContext ? searchContextBanner(state.searchContext) : '') +
    '<div id="editorPane">' +
      (mode === 'live' ? '<div id="vditor" style="min-height:calc(100vh - 180px)"><div class="empty">' + esc(t('editorLoading')) + '</div></div>' : '') +
      (mode === 'source' ? '<textarea id="editor" aria-label="Markdown">' + esc(d.markdown) + '</textarea>' : '') +
      (mode === 'reading' ? '<div id="preview"></div>' : '') +
    '</div>' +
    // Business Knowledge Viewer: aggregated attachments (images + files) below the
    // Reading body, with user-facing processing state and summary when available.
    '<div id="bkAttachments"></div>' +
    '<div id="relatedKnowledge"></div>'
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
// Managed attachment URL resolver (Live + Reading share one rule):
// any of  attachments/<id>/<file>, ./attachments/<id>/<file>,
// /pkw/attachments/<id>/<file>, same-origin absolute → /pkw/attachment/<id>.
// Encode a filename (or relative path) into a URL-safe Markdown destination
// segment: only the user's filename/path segments are encoded, never the
// 'attachments/<id>/' structure or '/' separators. Covers space, (), #, ?, %,
// &, +, [], CJK, Japanese and emoji. Mirrors the Host-side
// 'encodeAttachmentMarkdownPath' (single write-side rule).
function encodeAttachmentPath(segment){
  return String(segment || '').split('/').map(function(seg){
    return encodeURIComponent(seg).replace(/[!'()*]/g, function(c){ return '%' + c.charCodeAt(0).toString(16).toUpperCase() })
  }).join('/')
}
function managedAttachmentUrl(src){
  if (!src) return null
  let s = src
  if (s.indexOf('./') === 0) s = s.slice(2)
  const idx = s.indexOf('attachments/')
  if (idx < 0) return null
  const after = s.slice(idx + 'attachments/'.length)
  const slash = after.indexOf('/')
  if (slash < 0) return null
  const id = after.slice(0, slash)
  if (!id) return null
  return '/pkw/attachment/' + id
}
function rewriteLiveAttachmentImgs(root){
  if (!root || !root.querySelectorAll) return
  const imgs = root.querySelectorAll('img')
  for (let i = 0; i < imgs.length; i++) {
    const img = imgs[i]
    // Vditor IR (and its preview path) may hold the canonical reference in either
    // 'src' or 'data-src'. Resolve whichever carries attachments/<id>/….
    const attrs = ['src', 'data-src']
    for (let a = 0; a < attrs.length; a++) {
      const attr = attrs[a]
      const src = img.getAttribute(attr) || ''
      if (src.indexOf('/pkw/attachment/') === 0) continue
      const resolved = managedAttachmentUrl(src)
      if (resolved) {
        console.debug('[pkw.live-img] ' + attr + '=' + src + ' currentSrc=' + (img.currentSrc || '') + ' resolved=' + resolved)
        img.setAttribute(attr, resolved)
        if (attr === 'data-src') img.setAttribute('src', resolved)
      }
    }
  }
  // Managed FILE links: rewrite attachments/<id>/... hrefs to the preview route so
  // clicking a PDF/source in Live opens the preview, never the SPA fallback.
  const links = root.querySelectorAll('a[href*="attachments/"]')
  for (let i = 0; i < links.length; i++) {
    const a = links[i]
    const href = a.getAttribute('href') || ''
    if (href.indexOf('/pkw/attachment/') === 0) continue
    const resolved = managedAttachmentUrl(href)
    if (resolved) {
      a.setAttribute('href', resolved + '/preview')
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener')
      a.classList.add('src-inline')
    }
  }
}
function setupLiveAttachmentRewrite(v){
  if (!v || !v.vditor || !v.vditor.ir || !v.vditor.ir.element) return
  const el = v.vditor.ir.element
  // Initial sweep BEFORE observing: images already in the DOM must be rewritten
  // too (not only future mutations).
  rewriteLiveAttachmentImgs(el)
  if (setupLiveAttachmentRewrite._obs) setupLiveAttachmentRewrite._obs.disconnect()
  setupLiveAttachmentRewrite._obs = new MutationObserver(() => rewriteLiveAttachmentImgs(el))
  setupLiveAttachmentRewrite._obs.observe(el, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'data-src', 'href'] })
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
      height: 'calc(100vh - 180px)',
      value: state.editor.body || '',
      toolbar: vditorToolbar(),
      hint: {
        parse: false,
        delay: 0,
        extend: [{ key: '/', hint: () => slashMenu() }],
      },
      upload: { handler: (files) => { uploadVditorFiles(files, true) } },
      input: () => { onEditorInput() },
      // Vditor's 'after' option fires ONLY after async init (i18n + Lute load +
      // initial value render) completes. Installing the MutationObserver
      // synchronously after new Vditor() was a no-op — v.vditor.ir did not exist
      // yet — which is why Live images stayed broken while the Manager thumbnail
      // (a plain <img src="/pkw/attachment/<id>">) worked.
      after: () => { setupLiveAttachmentRewrite(vditor) },
    })
  } catch (e) {
    el.innerHTML = '<div class="empty">' + esc(t('genericError')) + ': ' + esc(e.message) + '</div>'
  }
}
function vditorToolbar(){
  const calloutTypes = ['NOTE', 'TIP', 'INFO', 'IMPORTANT', 'WARNING', 'QUESTION', 'EXAMPLE', 'SUCCESS', 'DANGER']
  const ic = (s) => '<span style="font-size:13px;line-height:1">' + s + '</span>'
  if (isMobile()) return mobileVditorToolbar(ic)
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
function mobileVditorToolbar(ic){
  // Compact mobile toolbar: high-frequency formatting only; the rest lives in ⋯.
  return [
    'headings',
    'bold',
    'list',
    'link',
    { name: 'attachment', tip: t('attachmentLabel'), icon: ic('📎'), click: () => pickAttachment() },
    { name: 'mobile-format-more', tip: t('mobileMore'), icon: ic('⋯'), click: () => mobileFormatSheet() },
    '|',
    'undo', 'redo',
  ]
}
function mobileFormatSheet(){
  const items = [
    ['I · ' + t('italic'), () => editorWrap('*', '*')],
    ['S · ' + t('strike'), () => editorWrap('~~', '~~')],
    ['❝ · ' + t('slashQuote'), () => editorInsert('> ')],
    ['</> · ' + t('slashCodeBlock'), () => editorInsert('\\u0060\\u0060\\u0060\\n\\u0060\\u0060\\u0060')],
    ['⊞ · ' + t('slashTable'), () => editorInsert('|  |  |\\n| --- | --- |\\n|  |  |\\n')],
    ['🖼 · ' + t('slashImage'), () => editorInsert('![alt](url)')],
    ['① · ' + t('slashFootnote'), () => editorInsert('[^1]')],
  ]
  document.querySelectorAll('.mobile-sheet-overlay').forEach(o => o.remove())
  const ov = document.createElement('div')
  ov.className = 'mobile-sheet-overlay'
  ov.innerHTML = '<div class="mobile-sheet"><div class="ms-title">' + esc(t('mobileMore')) + '</div>' +
    items.map((it, i) => '<button class="ms-item" data-mf="' + i + '">' + esc(it[0]) + '</button>').join('') +
    '<button class="ms-cancel">' + esc(t('cancel')) + '</button></div>'
  document.body.appendChild(ov)
  ov.addEventListener('click', (e) => { const b = e.target.closest('[data-mf]'); if (b) { items[Number(b.dataset.mf)][1](); ov.remove() } else if (e.target === ov || e.target.closest('.ms-cancel')) ov.remove() })
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
    showActivity(t('uploadProgress') + ' · ' + esc(file.name))
    const reader = new FileReader()
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1]
      // Note-editor upload → NOTE-SCOPED: this file belongs to the note being
      // edited, so it does NOT become an independent WeKnora Knowledge.
      api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64: base64, knowledgeMode: 'note-scoped', ownerNoteId: state.selectedNoteId }).then(up => {
        // Reference the STORED filename (up.filename), never the raw File.name, so the
        // managed link always resolves to the persisted binary. The filename segment
        // is URL-encoded (space/()/#/…/CJK/emoji) so it is a valid Markdown destination.
        const ref = 'attachments/' + up.attachmentId + '/' + encodeAttachmentPath(up.filename)
        const md = asImage === false ? '[' + up.filename + '](' + ref + ')' : '![](' + ref + ')'
        if (vditor) vditor.insertValue(md)
        refreshHeader()
        clearActivity()
      }).catch(e => { clearActivity(); toast(t('uploadFailed') + ': ' + e.message, 'err') })
    }
    reader.onerror = () => { clearActivity(); toast(t('uploadFailed'), 'err') }
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
  api('renderMarkdown', { markdown: body, noteId: state.editor.noteId }).then(html => {
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
    (d.attachments && d.attachments.length ? '<h3>' + esc(t('refAttachments')) + '</h3><div class="kv">' + d.attachments.length + '</div><div id="noteAttachmentKnowledge"></div>' : '') +
    '<h3>' + esc(t('outline')) + '</h3><div class="outline" id="outlineBox">' + outlineHtml(d.markdown) + '</div>' +
    '<h3>' + esc(t('syncSection')) + '</h3><div id="detailSync">' + syncBadgeHtml(s) + '</div>' +
    (s && s.error ? '<div class="kv"><b>' + esc(t('lastError')) + '</b> <span class="v">' + esc(s.error) + '</span></div>' : '') +
    '<h3>' + esc(t('advanced')) + '</h3>' +
    '<div class="kv"><b>' + esc(t('noteId')) + '</b> <span class="v mono">' + esc(d.note.noteId) + '</span></div>' +
    '<div class="kv"><b>' + esc(t('revision')) + '</b> ' + d.note.observedRevision + '</div>' +
    (s && s.knowledgeId ? '<div class="kv"><b>' + esc(t('knowledgeId')) + '</b> <span class="v mono">' + esc(s.knowledgeId) + '</span></div>' : '')
}
function renderNoteAttachmentKnowledge(d){
  if (!d.attachments || !d.attachments.length) return
  api('noteAttachmentSummaries', { noteId: d.note.noteId }).then(sums => {
    const box = $('#noteAttachmentKnowledge')
    if (!box || state.selectedNoteId !== d.note.noteId) return
    const rows = sums.filter(s => s.description || s.summaryStatus).map(s => '<div class="kv"><b>' + esc(s.filename || s.attachmentId) + '</b> <span class="v">' + (s.description ? esc(s.description) : (s.summaryStatus === 'completed' ? esc(t('knowledgeIndexed')) : esc(t('knowledgePending')))) + '</span></div>').join('')
    if (rows) box.innerHTML = '<h3>' + esc(t('summary')) + '</h3>' + rows
  }).catch(() => {})
}
function procStateBadge(state){
  if (state === 'ready') return '<span class="badge ok">' + esc(t('attReady')) + '</span>'
  if (state === 'failed') return '<span class="badge err">' + esc(t('attFailed')) + '</span>'
  if (state === 'optimizing') return '<span class="badge warn">' + esc(t('attOptimizing')) + '</span>'
  if (state === 'processing') return '<span class="badge warn">' + esc(t('attProcessing')) + '</span>'
  return '<span class="badge">' + esc(t('attWaiting')) + '</span>'
}
let sourcesPollTimer = null
// Sources (Business Knowledge Viewer): a Note's referenced attachments as
// "source files" — filename / type / size / processing state / real summary /
// owner count / retry, with a manual refresh + a light poll while processing.
function renderSources(noteId, attachments){
  const box = $('#bkAttachments')
  if (!box) return
  if (!attachments || !attachments.length) { box.innerHTML = ''; return }
  api('noteAttachmentSummaries', { noteId }).then(sums => {
    if (!box || state.selectedNoteId !== noteId) return
    const rows = (sums || []).map(s => {
      const isImage = (s.mimeType || '').indexOf('image/') === 0
      const thumb = isImage
        ? '<img class="bk-thumb" src="/pkw/attachment/' + esc(s.attachmentId) + '" alt="" loading="lazy" data-action="att-preview" data-id="' + esc(s.attachmentId) + '">'
        : '<span class="bk-ic" data-action="att-preview" data-id="' + esc(s.attachmentId) + '">📄</span>'
      const summary = s.description ? '<div class="bk-summary muted">' + esc(s.description) + '</div>' : ''
      const ownerHint = s.ownerCount > 1 ? '<span class="badge">' + esc(t('usedByN', { n: s.ownerCount })) + '</span>' : ''
      const retryBtn = s.processingState === 'failed'
        ? '<button class="btn small" data-action="reparse-attachment" data-id="' + esc(s.attachmentId) + '">' + esc(t('reparse')) + '</button>'
        : ''
      return '<div class="bk-att">' + thumb +
        '<div class="bk-att-main">' +
          '<div class="bk-att-name" data-action="att-preview" data-id="' + esc(s.attachmentId) + '">' + esc(s.filename) + '</div>' +
          '<div class="muted small">' + esc(s.mimeType || '') + (s.sizeBytes != null ? ' · ' + fmtSize(s.sizeBytes) : '') + '</div>' +
          summary +
        '</div>' +
        '<div class="bk-att-side">' + procStateBadge(s.processingState) + ownerHint + retryBtn + '</div>' +
        '</div>'
    }).join('')
    box.innerHTML = '<h3>' + esc(t('sourceFiles')) + ' <button class="btn small" data-action="refresh-sources">' + esc(t('refresh')) + '</button></h3>' + rows
    if ((sums || []).some(s => s.processingState === 'processing')) scheduleSourcesPoll(noteId, attachments)
  }).catch(() => {})
}
function scheduleSourcesPoll(noteId, attachments){
  clearTimeout(sourcesPollTimer)
  if (state.view !== 'notes' || state.selectedNoteId !== noteId) return
  sourcesPollTimer = setTimeout(() => {
    if (state.view !== 'notes' || state.selectedNoteId !== noteId) return
    renderSources(noteId, attachments)
  }, 4000)
}
// Related Knowledge (lightweight): reads existing WeKnora Wiki-graph relations and
// maps them back to local Notes. Optional — renders nothing when there is no data
// or WeKnora is offline, so it never blocks the Business Knowledge Viewer.
function renderRelatedKnowledge(d){
  const box = $('#relatedKnowledge')
  if (!box) return
  api('relatedKnowledge', { noteId: d.note.noteId }).then(rel => {
    if (!box || state.selectedNoteId !== d.note.noteId) return
    const list = (rel || []).filter(r => r && r.noteId)
    if (!list.length) { box.innerHTML = ''; return }
    box.innerHTML = '<h3>' + esc(t('relatedKnowledge')) + '</h3>' +
      list.map(r => '<div class="tree-row" data-action="open-note" data-id="' + esc(r.noteId) + '"><span class="ic">📄</span><span class="nm">' + esc(r.title) + '</span></div>').join('')
  }).catch(() => {})
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
function inlineRenameTitle(targetEl, noteId){
  if (!targetEl) return
  const current = (targetEl.textContent || '').trim()
  const input = document.createElement('input')
  input.className = 'inline-rename-input'
  input.value = current
  targetEl.replaceWith(input)
  input.focus(); input.select()
  let done = false
  const finish = () => {
    if (done) return; done = true
    const v = input.value.trim()
    if (!v || v === current) { input.replaceWith(targetEl); return }
    api('renameNoteTitle', { noteId, title: v }).then(() => {
      toast(t('localSaved'), 'ok'); refreshHeader()
      if (state.selectedNoteId === noteId) openNote(noteId)
      else { renderTree(); renderNotesExplorer() }
    }).catch(e => { toast(t('genericError') + ': ' + e.message, 'err'); if (input.isConnected) input.replaceWith(targetEl) })
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); finish() } else if (e.key === 'Escape') { done = true; input.replaceWith(targetEl) } })
  input.addEventListener('blur', finish)
}
function renameNote(noteId){
  const id = noteId || state.selectedNoteId
  if (id === null || id === undefined) return
  const target = (state.selectedNoteId === id)
    ? document.querySelector('.editor-head .note-title')
    : document.querySelector('.note-title[data-id="' + CSS.escape(id) + '"]')
  inlineRenameTitle(target, id)
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
function removeMissingNote(noteId){
  trashConfirmDialog(t('removeFromWorkspace'), esc(t('removeMissingConfirm', { id: noteId })), t('removeFromWorkspace'), () => {
    api('deleteNote', { noteId }).then(() => {
      state.selectedNoteId = null
      state.editor = { noteId: null, persistedMarkdown: '', dirty: false, saving: false, mode: 'live' }
      $('#detail').innerHTML = ''
      toast(t('deletedMsg'), 'ok')
      renderTree(); refreshHeader()
    }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
  })
}
async function newFolder(parentPath){
  const name = prompt(t('createFolderPrompt'), ''); if (!name || !name.trim()) return
  const path = (parentPath ? parentPath + '/' : '') + name.trim()
  try { await api('createFolder', { path }); state.selectedFolder = path; state.selectedNoteId = null; toast(t('folderCreated'), 'ok'); await renderTree(); renderDetail(); renderFolderMain(path) }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
function renderFolderMain(path){
  renderDesktopExplorer(path)
}
async function renameFolder(path){
  const name = prompt(t('folderRenamePrompt'), path.split('/').pop()); if (!name || !name.trim()) return
  const parent = parentOfPath(path); const newPath = (parent ? parent + '/' : '') + name.trim()
  if (newPath === path) return
  const span = mutSpan('renameFolder')
  try { await api('renameFolder', { path, newPath }); span.mark('rpc'); state.selectedFolder = newPath; await renderTree(); span.mark('tree'); renderDetail(); renderFolderMain(newPath); span.end('paint') }
  catch (e) { span.end('error'); toast(t('genericError') + ': ' + e.message, 'err') }
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
  const span = mutSpan('moveNote')
  showFolderPicker('', (target) => {
    (async () => {
      span.mark('pick')
      try {
        const cur = await api('getNote', { noteId }); span.mark('getNote')
        const rel = (target ? target + '/' : '') + cur.note.relativePath.split('/').pop()
        if (rel === cur.note.relativePath) { span.end('noop'); return }
        await api('moveNote', { noteId, relativePath: rel }); span.mark('rpc')
        await renderTree(); span.mark('tree')
        await openNote(noteId); span.end('open')
      } catch (e) { span.end('error'); toast(t('genericError') + ': ' + e.message, 'err') }
    })()
  })
}
function parentOfPath(p){ const i = p.lastIndexOf('/'); return i === -1 ? '' : p.slice(0, i) }
function showFolderPicker(currentPath, cb){
  api('listFolders').then(folders => {
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = '<div class="modal"><h3>' + esc(t('moveTo')) + '</h3><select id="pickFolder"><option value="">' + esc(t('rootFolder')) + '</option>' + folders.map(f => '<option value="' + esc(f) + '"' + (f === currentPath ? ' selected' : '') + '>' + esc(f) + '</option>').join('') + '</select><div class="modal-actions"><button class="btn" data-act="pick-cancel">' + esc(t('cancel')) + '</button><button class="btn primary" data-act="pick-ok">' + esc(t('ok')) + '</button></div></div>'
    document.body.appendChild(overlay)
    const okBtn = overlay.querySelector('[data-act="pick-ok"]')
    // Scoped handles: never 'document.querySelector(.modal-overlay)' — with
    // stacked overlays the global selector removes the WRONG (first) one and
    // leaves the top overlay stuck (the "move dialog never closes" bug).
    const done = (val) => { overlay.remove(); if (val !== undefined) cb(val) }
    overlay.querySelector('[data-act="pick-cancel"]').onclick = () => done(undefined)
    okBtn.onclick = () => { okBtn.disabled = true; done(overlay.querySelector('#pickFolder').value) }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) done(undefined) })
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}

// ── Attachments: Manager (list/grid, search, filter, sort, multi-select) ────
function attTypeOf(mimeType){
  const m = String(mimeType || '')
  if (m.indexOf('image/') === 0) return 'image'
  if (m.indexOf('text/') === 0) return 'document'
  if (m.indexOf('application/pdf') === 0) return 'document'
  if (m.indexOf('word') >= 0 || m.indexOf('excel') >= 0 || m.indexOf('powerpoint') >= 0 || m.indexOf('officedocument') >= 0 || m.indexOf('json') >= 0 || m.indexOf('xml') >= 0 || m.indexOf('csv') >= 0) return 'document'
  return 'other'
}
function attFilteredList(){
  let list = state.attachmentsCache || []
  const q = String(state.attQuery || '').trim().toLowerCase()
  if (q) list = list.filter(a => (a.filename || '').toLowerCase().indexOf(q) >= 0)
  if (state.attType !== 'all') list = list.filter(a => attTypeOf(a.mimeType) === state.attType)
  const s = state.attSort
  if (s === 'name') list = list.slice().sort((a, b) => (a.filename || '') < (b.filename || '') ? -1 : (a.filename || '') > (b.filename || '') ? 1 : 0)
  else if (s === 'size') list = list.slice().sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0))
  else list = list.slice().sort((a, b) => (a.createdAt || '') < (b.createdAt || '') ? 1 : -1)
  return list
}
function fmtStamp(iso){ return String(iso || '').slice(0, 16).replace('T', ' ') }
function attIcon(a){
  if (attTypeOf(a.mimeType) === 'image') return '<img class="att-thumb" src="/pkw/attachment/' + esc(a.attachmentId) + '" alt="" loading="lazy">'
  if (attTypeOf(a.mimeType) === 'document') return '<span class="att-ic">📄</span>'
  return '<span class="att-ic">📦</span>'
}
function attCompanionHtml(a){
  if (a.companionNoteId) return '<button class="btn small" data-action="att-open-companion" data-id="' + esc(a.attachmentId) + '">📄 ' + esc(a.companionNoteTitle || t('attCompanion')) + '</button>'
  return '<button class="btn small" data-action="att-create-companion" data-id="' + esc(a.attachmentId) + '">+ ' + esc(t('attCreateCompanion')) + '</button>'
}
function sourceOwnerBadge(a){
  if (!a.ownerCount) return '<span class="badge warn">' + esc(t('isolated')) + '</span>'
  return '<span class="badge">📄 ' + a.ownerCount + '</span>'
}
function attRowHtml(a){
  const sel = state.attSelection.has(a.attachmentId)
  return '<div class="tree-row att-row ' + (sel ? 'selected' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '">' +
    '<input type="checkbox" class="att-check" data-action="att-toggle" data-id="' + esc(a.attachmentId) + '"' + (sel ? ' checked' : '') + '>' +
    attIcon(a) +
    '<span class="nm">' + esc(a.filename) + '</span>' +
    '<span class="muted small">' + esc(attTypeOf(a.mimeType)) + '</span>' +
    '<span class="muted small">' + fmtSize(a.sizeBytes) + '</span>' +
    procStateBadge(a.processingState) +
    sourceOwnerBadge(a) +
    attCompanionHtml(a) +
    '</div>'
}
function attCardHtml(a){
  const sel = state.attSelection.has(a.attachmentId)
  return '<div class="att-card ' + (sel ? 'selected' : '') + '" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '">' +
    '<input type="checkbox" class="att-check" data-action="att-toggle" data-id="' + esc(a.attachmentId) + '"' + (sel ? ' checked' : '') + '>' +
    '<div class="att-thumbwrap">' + (attTypeOf(a.mimeType) === 'image' ? '<img class="att-thumb" src="/pkw/attachment/' + esc(a.attachmentId) + '" alt="" loading="lazy">' : '<span class="att-ic big">📄</span>') + '</div>' +
    '<div class="att-card-name">' + esc(a.filename) + '</div>' +
    '<div class="muted small">' + fmtSize(a.sizeBytes) + ' · ' + esc(fmtStamp(a.createdAt)) + '</div>' +
    '<div>' + procStateBadge(a.processingState) + sourceOwnerBadge(a) + '</div>' +
    '</div>'
}
function attToolbarHtml(){
  const typeBtn = (v, label) => '<button class="btn small' + (state.attType === v ? ' primary' : '') + '" data-action="att-type" data-type="' + v + '">' + esc(label) + '</button>'
  const sortBtn = (v, label) => '<button class="btn small' + (state.attSort === v ? ' primary' : '') + '" data-action="att-sort" data-sort="' + v + '">' + esc(label) + '</button>'
  const sortLabel = state.attSort === 'name' ? t('attSortName') : state.attSort === 'size' ? t('attSortSize') : t('attSortRecent')
  return '<div class="toolbar">' +
    (isMobile() ? '' : '<button class="btn small" data-action="att-mode" data-mode="' + (state.attMode === 'list' ? 'grid' : 'list') + '">' + esc(state.attMode === 'list' ? t('attGridView') : t('attListView')) + '</button>') +
    '<input id="attSearch" type="search" placeholder="' + esc(t('attSearchPlaceholder')) + '" value="' + esc(state.attQuery) + '">' +
    typeBtn('all', t('attTypeAll')) + typeBtn('image', t('attTypeImage')) + typeBtn('document', t('attTypeDocument')) + typeBtn('other', t('attTypeOther')) +
    (isMobile()
      ? '<button class="btn small" data-action="att-sort-sheet">' + esc(t('attSort')) + '：' + esc(sortLabel) + ' ▼</button>'
      : '<span class="muted small">' + esc(t('attSort')) + '</span>' + sortBtn('recent', t('attSortRecent')) + sortBtn('name', t('attSortName')) + sortBtn('size', t('attSortSize'))) +
    '</div>'
}
function attBatchBarHtml(){
  const visible = attFilteredList()
  const sel = state.attSelection.size
  const allChecked = visible.length > 0 && visible.every(a => state.attSelection.has(a.attachmentId))
  let html = '<div class="toolbar">' +
    '<button class="btn primary" data-action="upload-attachment">+ ' + esc(t('upload')) + '</button>' +
    '<label class="check-row inline"><input type="checkbox" id="attSelectAll"' + (allChecked ? ' checked' : '') + '> ' + esc(t('attSelectAll')) + '</label>'
  if (sel > 0) {
    html += '<span class="badge">' + esc(t('attSelected', { n: sel })) + '</span>' +
      '<button class="btn small" data-action="att-batch-trash">' + esc(t('attBatchTrash')) + '</button>' +
      '<button class="btn small" data-action="att-batch-reparse">' + esc(t('attBatchReparse')) + '</button>' +
      '<button class="btn small" data-action="att-batch-index">' + esc(t('attBatchIndex')) + '</button>' +
      '<button class="btn small" data-action="att-clear-selection">' + esc(t('attClearSelection')) + '</button>'
  }
  html += '</div>'
  return html
}
function attListHtml(list){
  if (!list.length) return '<div class="empty"><h3>' + esc(t('emptyAttachments')) + '</h3><p class="muted">' + esc(t('sourcesDesc')) + '</p><div class="cta"><button class="btn primary" data-action="upload-attachment">+ ' + esc(t('upload')) + '</button></div></div>'
  if (state.attMode === 'grid') return '<div class="att-grid">' + list.map(attCardHtml).join('') + '</div>'
  return list.map(a => isMobile() ? mobileSourceCard(a) : attRowHtml(a)).join('')
}
function renderAttachmentsFrom(list){
  state.attachmentsCache = list || []
  $('#treeToolbar').innerHTML = ''
  $('#list').innerHTML = ''
  $('#main').innerHTML = '<h2>' + esc(t('sources')) + '</h2><p class="muted">' + esc(t('sourcesDesc')) + '</p>' +
    '<div id="attToolbar">' + attToolbarHtml() + '</div>' +
    '<div id="attBatchBar">' + attBatchBarHtml() + '</div>' +
    '<div id="attList">' + attListHtml(attFilteredList()) + '</div>'
  restoreScroll()
}
function attRerenderList(){
  const el = $('#attList'); if (el) el.innerHTML = attListHtml(attFilteredList())
  const bb = $('#attBatchBar'); if (bb) bb.innerHTML = attBatchBarHtml()
}
async function renderAttachments(){
  const seq = viewSeq
  $('#detail').innerHTML = '<h3>' + esc(t('sources')) + '</h3><div class="kv muted">' + esc(t('attachmentDetailHint')) + '</div>'
  if (state.attachmentsCache.length) { renderAttachmentsFrom(state.attachmentsCache); viewMark('warm-paint', 'cache=hit') }
  else { $('#list').innerHTML = ''; $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  refreshSourcesData() // entry-time revalidate: reconcile non-terminal processing, patch status
  try {
    const list = await loadOnce('listAttachments', {})
    if (seq !== viewSeq) return
    state.attachmentsCache = list
    renderAttachmentsFrom(list)
    viewMark('data-ready')
    if (state.selectedAttachmentId !== null) await openAttachment(state.selectedAttachmentId)
  } catch (e) { if (seq === viewSeq) $('#main').innerHTML = '<div class="empty">' + esc(t('genericError')) + '</div>' }
}
let lastSourcesReconcile = 0
async function refreshSourcesData(){
  const now = Date.now()
  if (now - lastSourcesReconcile < 4000) return
  lastSourcesReconcile = now
  try {
    await api('reconcileProcessing')
    invalidateLoad('listAttachments')
    const list = await api('listAttachments', {})
    if (state.view !== 'attachments') return
    state.attachmentsCache = list
    renderAttachmentsFrom(list)
    if (state.selectedAttachmentId !== null) openAttachment(state.selectedAttachmentId)
  } catch (e) { /* offline → background worker will retry */ }
}
async function openAttachment(id){
  const seq = viewSeq
  state.selectedAttachmentId = id
  try {
    const d = await api('getAttachment', { attachmentId: id })
    if (seq !== viewSeq || state.view !== 'attachments') return
    const a = d.attachment, c = d.companionNote
    const owners = d.owners || []
    const summaryHtml = d.summary
      ? '<h3>' + esc(t('summary')) + '</h3><div class="kv"><span class="v">' + esc(d.summary) + '</span></div>'
      : ''
    const ownersHtml = owners.length
      ? '<h3>' + esc(t('usedIn')) + '</h3>' + owners.map(r => '<div class="tree-row" data-action="open-note" data-id="' + esc(r.noteId) + '"><span class="ic">📄</span><span class="nm">' + esc(r.title) + '</span></div>').join('')
      : '<h3>' + esc(t('usedIn')) + '</h3><div class="kv muted">' + esc(t('isolatedHint')) + '</div>'
    const companionHtml = c
      ? '<div class="kv"><b>' + esc(t('attCompanion')) + '</b> <span class="v"><a href="#" data-action="open-note" data-id="' + esc(c.noteId) + '">' + esc(c.title) + '</a></span></div>'
      : ''
    const reparseBtn = (d.processingState === 'failed' || d.processingState === 'ready')
      ? ' <button class="btn small" data-action="reparse-attachment" data-id="' + esc(id) + '">' + esc(t('reparse')) + '</button>'
      : ''
    const html = '<h3>' + esc(t('sources')) + '</h3>' + procStateBadge(d.processingState) +
      '<div class="kv"><b>' + esc(t('mime')) + '</b> <span class="v mono">' + esc(a.mimeType) + '</span></div>' +
      '<div class="kv"><b>' + esc(t('size')) + '</b> <span class="v">' + fmtSize(a.sizeBytes) + '</span></div>' +
      '<div class="kv"><b>' + esc(t('updated')) + '</b> <span class="v">' + esc(fmtStamp(a.createdAt)) + '</span></div>' +
      summaryHtml +
      companionHtml +
      ownersHtml +
      '<h3>' + esc(t('maintenance')) + '</h3>' +
      '<button class="btn small" data-action="att-preview" data-id="' + esc(id) + '">' + esc(t('attPreview')) + '</button>' +
      ' <button class="btn small" data-action="download-attachment" data-id="' + esc(id) + '">' + esc(t('download')) + '</button>' +
      reparseBtn +
      (c ? ' <button class="btn small" data-action="att-open-companion" data-id="' + esc(id) + '">' + esc(t('attOpenCompanion')) + '</button>' : ' <button class="btn small" data-action="att-create-companion" data-id="' + esc(id) + '">' + esc(t('attCreateCompanion')) + '</button>') +
      ' <button class="btn small" data-action="att-copy-ref" data-id="' + esc(id) + '">' + esc(t('attCopyRef')) + '</button>' +
      ' <button class="btn small danger" data-action="delete-attachment" data-id="' + esc(id) + '">' + esc(t('del')) + '</button>' +
      '<h3>' + esc(t('details')) + '</h3><div class="kv"><b>' + esc(t('attachmentId')) + '</b> <span class="v mono">' + esc(a.attachmentId) + '</span></div>'
    if (isMobile()) mobileDetail(a.filename, html)
    else $('#detail').innerHTML = html
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
function fileToBase64(file){
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1] || '')
    r.onerror = () => reject(new Error('read failed: ' + file.name))
    r.readAsDataURL(file)
  })
}
async function uploadFileBinary(file, indexable){
  // readAsDataURL → base64 directly (no O(n²) String.fromCharCode loop + btoa,
  // which is slow/stack-overflow-prone for multi-MB PDFs/images).
  const contentBase64 = await fileToBase64(file)
  return api('uploadAttachment', { filename: file.name, mimeType: file.type || 'application/octet-stream', contentBase64, ...(indexable === false ? { indexable: false } : {}) })
}
// ── Companion Note (idempotent Host orchestration; local-first, never waits on WeKnora) ──
async function ensureCompanionForAttachment(id, folder){
  const r = await api('createCompanionNote', { attachmentId: id, folder: folder || '' })
  if (r.created === false) { toast(t('attOpenedExisting'), 'ok'); setView('notes'); openNote(r.noteId); return r }
  toast(t('attCreatedNote'), 'ok')
  await refreshAttachments(); refreshHeader()
  if (state.view === 'notes') renderTree()
  return r
}
async function openCompanionForAttachment(id){
  const c = await api('getCompanionNote', { attachmentId: id }).catch(() => null)
  if (c && c.noteId) { setView('notes'); openNote(c.noteId) }
  else toast(t('attNoCompanion'), 'warn')
}
async function previewAttachment(id){
  // Mobile → browser native viewer (new tab). Desktop → right Inspector preview pane.
  if (isMobile()) { window.open('/pkw/attachment/' + id + '/preview', '_blank'); return }
  try {
    const d = await api('getAttachment', { attachmentId: id })
    const a = d.attachment
    const url = '/pkw/attachment/' + id + '/preview'
    const mime = a.mimeType || ''
    const isPdf = mime === 'application/pdf'
    const isImage = mime.indexOf('image/') === 0
    const media = isPdf
      ? '<iframe class="pv-frame" src="' + esc(url) + '" title="' + esc(a.filename) + '"></iframe>'
      : isImage
        ? '<img class="pv-img" src="' + esc(url) + '" alt="' + esc(a.filename) + '">'
        : '<div class="empty">' + esc(t('attPreview')) + '</div>'
    $('#detail').classList.add('previewing')
    $('#detail').innerHTML = '<div class="pv-head"><span class="pv-name">' + esc(a.filename) + '</span>' +
      '<button class="btn small" data-action="pv-close" title="' + esc(t('taskClose')) + '">×</button></div>' +
      media +
      '<div class="pv-actions"><a class="btn small" href="' + esc(url) + '" download>' + esc(t('download')) + '</a> <a class="btn small" href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(t('openInNewTab')) + '</a></div>'
  } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
async function copyAttachmentRef(id){
  const ref = 'attachments/' + id
  try { await navigator.clipboard.writeText(ref); toast(t('attCopied'), 'ok') }
  catch (e) { toast(t('genericError') + ': ' + e.message, 'err') }
}
// ── Multi-select + batch ──────────────────────────────────────────────────────
function attToggleSelection(id){
  if (state.attSelection.has(id)) state.attSelection.delete(id); else state.attSelection.add(id)
  attRerenderList()
}
function attSelectAllVisible(checked){
  const ids = attFilteredList().map(a => a.attachmentId)
  if (checked) ids.forEach(id => state.attSelection.add(id))
  else ids.forEach(id => state.attSelection.delete(id))
  attRerenderList()
}
function attClearSelection(){ state.attSelection.clear(); attRerenderList() }
async function attBatchOp(op){
  const ids = Array.from(state.attSelection)
  if (!ids.length) { toast(t('attBatchNoSelection'), 'warn'); return }
  let done = 0, failed = 0
  for (const id of ids) {
    try {
      if (op === 'trash') await api('deleteAttachment', { attachmentId: id })
      else if (op === 'reparse') await api('reparseAttachmentKnowledge', { attachmentId: id })
      else if (op === 'index') await api('syncEntity', { entityType: 'attachment', entityId: id })
      done++
    } catch (e) { failed++; console.error('[pkw.attBatch]', op, id, e) }
  }
  state.attSelection.clear()
  if (failed === 0) toast(t('batchDone', { n: done }), 'ok')
  else toast(t('batchPartial', { n: done, m: failed }), 'warn')
  await refreshAttachments(); refreshHeader()
}
// ── Direct Upload: explicit per-file result, no swallowed failures ────────────
async function uploadFilesWithCompanion(files, withNote, folder, index){
  let attOk = 0, attFail = 0, noteOk = 0, noteFail = 0
  showActivity(t('uploadProgress') + ' · ' + files.length)
  for (const file of files) {
    try {
      showActivity(t('uploadProgress') + ' · ' + esc(file.name))
      const up = await uploadFileBinary(file, index)
      attOk++
      if (withNote) {
        try { await api('createCompanionNote', { attachmentId: up.attachmentId, folder: folder || '' }); noteOk++ }
        catch (e) { noteFail++; console.error('[pkw.upload] companion note failed', file.name, e) }
      }
    } catch (e) { attFail++; console.error('[pkw.upload] attachment failed', file.name, e) }
  }
  clearActivity()
  if (attOk === 0) { toast(t('uploadFailed'), 'err'); return }
  if (attFail > 0) toast(t('attUploadPartial', { a: attOk, t: files.length }), 'warn')
  else if (withNote && noteFail > 0) toast(t('attUploadResultNoNote', { a: attOk, f: noteFail }), 'warn')
  else if (withNote) toast(t('attUploadResult', { a: attOk, n: noteOk, f: 0 }), 'ok')
  else toast(t('uploadSuccess'), 'ok')
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
    const index = q('#upIndex').checked
    overlay.remove()
    uploadFilesWithCompanion(files, withNote, folder, index)
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
  if (isMobile()) return mobileTaskCard(x, matrices, inMatrix)
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
  // Reconcile selection with the freshly rendered visible root tasks (intersection).
  reconcileTaskSelection(all.filter(x => x.parentTaskId === null).map(x => x.taskId))
  applyTaskSelectionVisual()
  restoreScroll()
}
async function renderTasks(){
  const seq = viewSeq
  $('#detail').innerHTML = ''
  if (state.tasksCache.length && state.matricesCache.length) { if (isMobile()) renderMobileTasks(); else renderTasksFrom(state.matricesCache, state.tasksCache); viewMark('warm-paint', 'cache=hit') }
  else { $('#list').innerHTML = ''; $('#treeToolbar').innerHTML = ''; $('#main').innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  try {
    const matrices = await loadOnce('listMatrices', {})
    const all = await loadOnce('listTasks', {})
    if (seq !== viewSeq) return // stale navigation guard
    state.tasksCache = all; state.matricesCache = matrices
    if (isMobile()) renderMobileTasks(); else renderTasksFrom(matrices, all)
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
function renderMobileTasks(){
  const matrices = state.matricesCache || []
  const all = state.tasksCache || []
  // G2 default-board rule: restore a user-chosen board; otherwise default to the
  // FIRST user Matrix (stable manualOrder) — Inbox is the fallback only when the
  // user has no matrices. G4: a deleted/archived board falls back to the next
  // Matrix, then Inbox (never a dangling matrixId).
  if (!state.mobileTaskBoardChosen && matrices.length > 0) state.mobileTaskBoard = matrices[0].matrixId
  if (state.mobileTaskBoard !== 'inbox' && !matrices.some(m => m.matrixId === state.mobileTaskBoard)) {
    state.mobileTaskBoard = matrices.length > 0 ? matrices[0].matrixId : 'inbox'
  }
  const board = state.mobileTaskBoard
  const q = state.mobileTaskQ
  const inBoard = x => board === 'inbox' ? (x.matrixId === null || x.matrixId === undefined) : x.matrixId === board
  // Subtasks live inside the task-detail sheet; the mobile board lists ROOT tasks
  // only, matching the desktop matrix/list views (parentTaskId === null).
  const isRoot = x => x.parentTaskId === null
  const openInBoard = all.filter(x => x.status === 'open' && isRoot(x) && inBoard(x))
  const doneInBoard = all.filter(x => x.status === 'completed' && isRoot(x) && inBoard(x))
  const qCounts = { 1: 0, 2: 0, 3: 0, 4: 0 }
  for (const x of openInBoard) qCounts[quadrantOf(x)]++
  // Default-expand the current Q when nothing is open yet (or when switching board).
  if (state.mobileOpenSections.size === 0) state.mobileOpenSections.add(String(q))
  const boardLabel = board === 'inbox' ? t('taskInbox') : (matrixName(matrices, board) || board)
  const accordion = (key, label, count, bodyHtml) => {
    const open = state.mobileOpenSections.has(key)
    return '<div class="macc"><button class="macc-head" data-action="mobile-q-toggle" data-q="' + key + '">' +
      '<span class="macc-arrow">' + (open ? '▼' : '▶') + '</span><span class="macc-label">' + esc(label) + '</span><span class="macc-count">' + count + '</span>' +
      '</button>' + (open ? '<div class="macc-body">' + bodyHtml + '</div>' : '') + '</div>'
  }
  const qTasksHtml = qn => {
    const tasks = openInBoard.filter(x => quadrantOf(x) === qn)
    return tasks.length ? tasks.map(x => mobileTaskCard(x, matrices, board !== 'inbox')).join('') : '<div class="empty small">' + esc(t('taskNoTasks')) + '</div>'
  }
  const doneHtml = doneInBoard.length
    ? doneInBoard.map(x => mobileCompletedTaskRow(x)).join('')
    : '<div class="empty small">' + esc(t('taskNoTasks')) + '</div>'
  $('#main').innerHTML = '<h2>' + esc(t('tasks')) + '</h2>' +
    '<div class="toolbar"><button class="btn primary" data-action="new-task-mobile">+ ' + esc(t('taskQuickAdd')) + '</button></div>' +
    '<button class="mboard-select" data-action="mobile-board-sheet">' + esc(t('matrices')) + '：' + esc(boardLabel) + ' ▼</button>' +
    [1, 2, 3, 4].map(qn => accordion(String(qn), 'Q' + qn + ' · ' + t('q' + qn), qCounts[qn], qTasksHtml(qn))).join('') +
    accordion('done', t('taskCompleted'), doneInBoard.length, doneHtml)
}
function mobileCompletedTaskRow(x){
  return '<div class="mtask done" data-action="open-task-detail" data-id="' + esc(x.taskId) + '">' +
    '<span class="mtask-check">✓</span>' +
    '<div class="mtask-main"><div class="mtask-title">' + esc(x.title) + '</div>' +
    (x.completedAt ? '<div class="mtask-due muted">' + esc(fmtStamp(x.completedAt)) + '</div>' : '') + '</div>' +
    '</div>'
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
  for (const n of notes) items.push({ key: 'note:' + n.noteId, kind: 'note', id: n.noteId, name: n.title, sub: n.deletedAt || n.updatedAt || '', path: n.relativePath, missing: n.canonicalMissing === true })
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
  const missingBadge = it.missing ? ' <span class="badge warn">⚠ ' + esc(t('missingSource')) + '</span>' : ''
  return '<div class="tree-row trash-item" data-key="' + esc(it.key) + '">' +
    '<input type="checkbox" class="trash-check" data-key="' + esc(it.key) + '"' + (checked ? ' checked' : '') + '>' +
    '<span class="ic">' + trashKindIcon(it.kind) + '</span>' +
    '<span class="trash-main"><span class="trash-name">' + esc(it.name) + missingBadge + '</span><span class="muted small">' + meta + '</span></span>' +
    (it.missing ? '' : '<button class="btn small" data-action="restore-one" data-key="' + esc(it.key) + '">' + esc(t('trashRestore')) + '</button>') +
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

// ── Knowledge view: unified Discovery (browse + RAG retrieval). Search and
// Knowledge share ONE entry point; Wiki/Graph are no longer top-level tabs. ──
function renderKnowledgeView(){
  $('#list').innerHTML = '<div class="list-head">' + esc(t('knowledge')) + '</div><div class="list-section">' + esc(t('knowledgeBrowseTitle')) + '</div>'
  $('#treeToolbar').innerHTML = ''; $('#detail').innerHTML = ''
  const q = state.searchQuery || ''
  $('#main').innerHTML = '<h2>' + esc(t('knowledgeBrowseTitle')) + '</h2>' +
    '<div class="toolbar"><input id="kbSearch" placeholder="' + esc(t('searchPlaceholder')) + '" value="' + esc(q) + '" style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text-primary)">' +
    (q ? '<button class="btn" data-action="kb-clear-search">' + esc(t('cancel')) + '</button>' : '') +
    '</div><div id="kbBody"></div>'
  const input = $('#kbSearch')
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = input.value.trim(); if (v) runSearch(v) } })
  if (q) {
    if (state.searchResults) { const html = searchCardsHtml(state.searchResults); $('#kbBody').innerHTML = html || '<div class="empty">' + esc(t('noHits', { q })) + '</div>' }
    else $('#kbBody').innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
    return
  }
  renderKnowledgeBrowseInto()
}
// Unified knowledge card: shared by Knowledge Discovery browse + Search results
// so "finding knowledge" reads identically regardless of entry point. Exposes
// only user concepts (title / summary / match reason / source / updated / type).
function knowledgeCardHtml(c){
  const meta = []
  if (c.reason) meta.push('<span class="reason">' + c.reason + '</span>')
  if (c.source) meta.push('<span>' + esc(t('sourceLabel')) + ': ' + esc(c.source) + '</span>')
  if (c.updatedAt) meta.push('<span>' + esc(t('updated')) + ': ' + esc(String(c.updatedAt).slice(0, 16).replace('T', ' ')) + '</span>')
  const openBtn = c.open
    ? '<button class="btn small" data-action="' + esc(c.open.action) + '" data-id="' + esc(c.open.id) + '"' + (c.reasonAttrs || '') + '>' + esc(c.open.label) + '</button>'
    : ''
  const snippets = (c.snippets && c.snippets.length) ? c.snippets : (c.snippet ? [c.snippet] : [])
  const snippetHtml = snippets.slice(0, 2).map(s => '<div class="snippet">' + esc(s) + '</div>').join('')
  if (isMobile() && c.open) {
    return '<div class="hit hit-clickable" data-action="' + esc(c.open.action) + '" data-id="' + esc(c.open.id) + '"' + (c.reasonAttrs || '') + '>' +
      '<div class="t">' + esc(c.title) + (c.badges || '') + '<span class="chev">›</span></div>' +
      snippetHtml +
      '<div class="ref"><span class="meta">' + meta.join(' · ') + '</span></div>' +
      '</div>'
  }
  return '<div class="hit">' +
    '<div class="t">' + esc(c.title) + (c.badges || '') + '</div>' +
    snippetHtml +
    '<div class="ref"><span class="meta">' + meta.join(' · ') + '</span><span class="spacer"></span>' + openBtn + '</div>' +
    '</div>'
}
async function renderKnowledgeBrowseInto(){
  const seq = viewSeq
  const box = $('#kbBody')
  if (!box) return
  const card = (it) => {
    const badges = (it.attachmentCount ? '<span class="badge">' + esc(t('attachmentsN', { n: it.attachmentCount })) + '</span>' : '') +
      (it.indexed ? '<span class="badge ok">' + esc(t('knowledgeIndexed')) + '</span>' : (it.pending ? '<span class="badge warn">' + esc(t('knowledgePending')) + '</span>' : ''))
    return knowledgeCardHtml({
      title: it.title || it.relativePath || '',
      snippet: it.summary,
      source: it.folder,
      updatedAt: it.updatedAt,
      badges,
      open: { action: 'open-note', id: it.noteId, label: t('openNote') },
    })
  }
  // C5 Knowledge Home: no query → a bounded home (recent + source overview), NOT
  // the whole library as infinite cards. "View all" is an explicit user action.
  const drawHome = () => {
    const items = state.knowledgeCache || []
    const recent = items.slice().sort((a, b) => (a.updatedAt || '') < (b.updatedAt || '') ? 1 : -1).slice(0, 8)
    const s = state.summaryCache
    const noteCount = items.length
    const sourceCount = (s && typeof s.attachments === 'number') ? s.attachments : state.attachmentsCache.length
    box.innerHTML =
      '<div class="list-section">' + esc(t('recentKnowledge')) + '</div>' +
      (recent.length ? recent.map(card).join('') : '<div class="empty">' + esc(t('knowledgeEmpty')) + '</div>') +
      '<div class="list-section">' + esc(t('sourceOverview')) + '</div>' +
      '<div class="kv"><b>' + esc(t('overviewNotes')) + '</b> <span class="v">' + noteCount + '</span> · <b>' + esc(t('overviewAttachments')) + '</b> <span class="v">' + sourceCount + '</span></div>' +
      '<div class="cta" style="margin-top:12px"><button class="btn" data-action="knowledge-view-all">' + esc(t('viewAllKnowledge')) + '</button></div>'
  }
  const drawAll = () => {
    const items = state.knowledgeCache || []
    if (!items.length) { box.innerHTML = '<div class="empty">' + esc(t('knowledgeEmpty')) + '</div>'; return }
    box.innerHTML = items.map(card).join('') + '<div class="cta" style="margin-top:12px"><button class="btn" data-action="knowledge-back-home">← ' + esc(t('back')) + '</button></div>'
  }
  const draw = () => { if (state.knowledgeShowAll) drawAll(); else drawHome() }
  if (state.knowledgeCache) { draw(); viewMark('warm-paint', 'cache=hit') }
  else { box.innerHTML = '<div class="empty">' + esc(t('loading')) + '</div>'; viewMark('shell', 'cache=miss') }
  try {
    const list = await api('listKnowledge', {})
    if (seq !== viewSeq) return
    state.knowledgeCache = list
    draw()
    viewMark('data-ready')
  } catch (e) {
    if (seq !== viewSeq) return
    if (box) box.innerHTML = '<div class="empty">' + esc(t('knowledgeOffline')) + '</div><div class="empty"><button class="btn" data-action="knowledge-tab" data-tab="browse">' + esc(t('retry')) + '</button></div>'
  }
}
function searchCardsHtml(results){
  return results.map(r => {
    const local = r.local
    const title = r.remote.title || r.remote.filename || (local && local.title) || (local && local.entityId) || t('untitled')
    const attName = r.remote.filename || (local && local.matchedAttachmentId) || ''
    let reason = ''
    let reasonValue = 'note'
    if (local) {
      if (local.matchReason === 'both') { reason = t('noteBodyMatch') + ' · ' + t('attMatch') + ' · ' + esc(attName); reasonValue = 'both' }
      else if (local.matchReason === 'attachment' || local.matchedAttachmentId) { reason = t('attMatch') + ' · ' + esc(attName); reasonValue = 'attachment' }
      else if (local.entityType === 'attachment') { reason = t('attMatch') + ' · ' + esc(attName); reasonValue = 'attachment' }
      else reason = t('noteBodyMatch')
    }
    const kindBadge = local
      ? (local.entityType === 'note' ? '<span class="badge">' + esc(t('noteLabel')) + '</span>' : '<span class="badge">' + esc(t('attachmentLabel')) + '</span>')
      : ''
    let open = null
    let reasonAttrs = ''
    if (local) {
      if (local.companionNoteId) { open = { action: 'open-note', id: local.companionNoteId, label: t('openNote') } }
      else if (local.entityType === 'note') { open = { action: 'open-note', id: local.entityId, label: t('openNote') } }
      else { open = { action: 'open-attachment', id: local.entityId, label: t('openAttachment') } }
      if (open.action === 'open-note') reasonAttrs = ' data-reason="' + esc(reasonValue) + '" data-attname="' + esc(attName) + '"'
    }
    return knowledgeCardHtml({
      title,
      snippets: (r.remote.bestEvidence && r.remote.bestEvidence.length) ? r.remote.bestEvidence : [r.remote.snippet || (r.remote.content || '').slice(0, 220)],
      reason,
      source: local && local.folder,
      badges: kindBadge,
      open,
      reasonAttrs,
    })
  }).join('')
}
function renderSearchResults(q, results){
  if (!results || !results.length) { $('#main').innerHTML = '<div class="empty">' + t('noHits', { q: esc(q) }) + '</div>'; return }
  $('#main').innerHTML = '<h2>' + esc(t('search')) + '<span class="sub">' + esc(q) + '</span></h2>' + searchCardsHtml(results)
}
async function runSearch(q){
  state.searchQuery = q
  state.searchResults = null
  const box = $('#kbBody')
  if (box) box.innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
  else $('#main').innerHTML = '<div class="empty">' + esc(t('searching')) + '</div>'
  try {
    const payload = await api('search', { query: q, limit: 10 })
    const results = payload && Array.isArray(payload.results) ? payload.results : (Array.isArray(payload) ? payload : [])
    state.searchResults = results
    // Dev-only retrieval trace (C4): localize "no hits" to a layer; never in UI.
    if (payload && payload.trace) console.debug('[pkw.retrieval]', payload.trace)
    if (box) box.innerHTML = searchCardsHtml(results) || '<div class="empty">' + esc(t('noHits', { q })) + '</div>'
    else renderSearchResults(q, results)
  } catch (e) { state.searchResults = null; const msg = '<div class="empty">' + esc(t('knowledgeOffline')) + '</div><div class="empty muted">' + esc(e.message || '') + '</div>'; if (box) box.innerHTML = msg; else $('#main').innerHTML = msg }
}
async function syncNow(){ toast(t('syncingAll'), 'warn'); try { await api('syncNow'); toast(t('ok'), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function syncEntity(et, id){ try { await api('syncEntity', { entityType: et, entityId: id }); toast(t('ok'), 'ok'); if (et === 'note' && state.selectedNoteId === id) await openNote(id); else await renderTree() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }
async function reconcile(){ try { const r = await api('reconcile'); toast(t('reconcileResult', { a: r.notesRepaired, b: r.attachmentsRepaired, c: r.markedDirty, d: r.markedDeleted }), 'ok'); await render() } catch (e) { toast(t('genericError') + ': ' + e.message, 'err') } }

// ── Quick switcher (Ctrl+O) ─────────────────────────────────────────────────
function quickSwitch(){
  api('getTree', { sortMode: 'manual' }).then(tree => {
    const notes = []
    collectNotes(tree.root, notes)
    const overlay = document.createElement('div')
    overlay.className = 'modal-overlay'
    overlay.innerHTML = '<div class="modal"><h3>' + esc(t('quickSwitch')) + '</h3><input id="qsInput" placeholder="' + esc(t('typeToSearch')) + '" /><div id="qsList" style="max-height:300px;overflow:auto"></div></div>'
    document.body.appendChild(overlay)
    const input = overlay.querySelector('#qsInput'); input.focus()
    const listEl = overlay.querySelector('#qsList')
    const render = () => {
      const q = input.value.trim().toLowerCase()
      const list = notes.filter(n => !q || n.title.toLowerCase().includes(q) || n.relativePath.toLowerCase().includes(q)).slice(0, 30)
      listEl.innerHTML = list.map(n => '<div class="tree-row" data-qsid="' + esc(n.noteId) + '"><span class="ic">📄</span><span class="nm">' + esc(n.title) + '</span><span class="muted mono">' + esc(n.relativePath) + '</span></div>').join('') || '<div class="empty">' + esc(t('noHits', { q: '' })) + '</div>'
    }
    render()
    input.addEventListener('input', render)
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-qsid]')
      if (row) { overlay.remove(); setView('notes'); openNote(row.dataset.qsid) }
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
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
      const contentBase64 = await fileToBase64(file)
      const up = await api('uploadAttachment', { filename: 'paste-' + Date.now() + '.png', mimeType: file.type || 'image/png', contentBase64, knowledgeMode: 'note-scoped', ownerNoteId: state.selectedNoteId })
      const el = $('#editor')
      if (el) {
        // Reference the STORED filename so the managed link resolves to the binary.
        const ref = '![](attachments/' + up.attachmentId + '/' + encodeAttachmentPath(up.filename) + ')'
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
// ── Mobile presentation layer (390px): distinct surface renderers, same data/actions ──
function isMobile(){ return window.innerWidth <= 768 }
let lastWasMobile = null
window.addEventListener('resize', () => { const m = isMobile(); if (m !== lastWasMobile) { lastWasMobile = m; render() } })
function mobileActionSheet(title, items){
  document.querySelectorAll('.mobile-sheet-overlay').forEach(o => o.remove())
  const ov = document.createElement('div')
  ov.className = 'mobile-sheet-overlay'
  ov.innerHTML = '<div class="mobile-sheet"><div class="ms-title">' + esc(title) + '</div>' +
    items.map(it => {
      let attrs = ''
      if (it.id !== undefined) attrs += ' data-id="' + esc(it.id) + '"'
      if (it.path !== undefined) attrs += ' data-path="' + esc(it.path) + '"'
      return '<button class="ms-item' + (it.danger ? ' danger' : '') + '" data-action="' + esc(it.action) + '"' + attrs + '>' + esc(it.label) + '</button>'
    }).join('') +
    '<button class="ms-cancel">' + esc(t('cancel')) + '</button></div>'
  document.body.appendChild(ov)
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.ms-item') || e.target.closest('.ms-cancel')) ov.remove() })
}
function mobileNoteRow(n){
  const folder = (n.relativePath || '').includes('/') ? (n.relativePath).slice(0, (n.relativePath).lastIndexOf('/')) : ''
  return '<div class="mnote" data-action="open-note" data-id="' + esc(n.noteId) + '">' +
    '<div class="mnote-main"><div class="mnote-title">' + esc(n.title || n.relativePath) + '</div>' +
    (folder ? '<div class="mnote-folder">' + esc(folder) + '</div>' : '') +
    '<div class="mnote-meta">' + esc(fmtStamp(n.updatedAt)) + ' · ' + syncBadgeHtml(n.sync) + '</div></div>' +
    '<button class="mnote-more" data-action="mobile-note-menu" data-id="' + esc(n.noteId) + '">⋯</button></div>'
}
function mobileSourceCard(a){
  const isImage = (a.mimeType || '').indexOf('image/') === 0
  const thumb = isImage ? '<img class="msrc-thumb" src="/pkw/attachment/' + esc(a.attachmentId) + '" alt="" loading="lazy">' : '<span class="msrc-ic">📄</span>'
  const summary = a.summary ? '<div class="msrc-summary">' + esc(String(a.summary).slice(0, 120)) + '</div>' : ''
  return '<div class="msrc" data-action="open-attachment" data-id="' + esc(a.attachmentId) + '">' +
    '<div class="msrc-thumbwrap">' + thumb + '</div>' +
    '<div class="msrc-main"><div class="msrc-name">' + esc(a.filename) + '</div>' +
    '<div class="msrc-meta">' + esc(attTypeOf(a.mimeType)) + ' · ' + fmtSize(a.sizeBytes) + '</div>' +
    '<div class="msrc-badges">' + procStateBadge(a.processingState) + (a.ownerCount ? '<span class="badge">' + esc(t('usedByN', { n: a.ownerCount })) + '</span>' : '<span class="badge warn">' + esc(t('isolated')) + '</span>') + '</div>' +
    summary + '</div>' +
    '<button class="mnote-more" data-action="mobile-source-menu" data-id="' + esc(a.attachmentId) + '">⋯</button></div>'
}
function mobileTaskCard(x, matrices, inMatrix){
  const badge = (inMatrix ? '' : (x.matrixId ? '<div class="mtask-cat">' + esc(matrixName(matrices, x.matrixId)) + '</div>' : ''))
  const due = x.dueAt ? '<div class="mtask-due">' + esc(dueLabel(x.dueAt)) + '</div>' : ''
  return '<div class="mtask" data-action="open-task-detail" data-id="' + esc(x.taskId) + '">' +
    '<span class="mtask-check" data-action="toggle-task" data-completed="' + (x.status === 'completed' ? '1' : '0') + '" data-id="' + esc(x.taskId) + '">' + (x.status === 'completed' ? '☑' : '☐') + '</span>' +
    '<div class="mtask-main"><div class="mtask-title">' + esc(x.title) + '</div>' + badge + due + '</div>' +
    '<button class="mnote-more" data-action="mobile-task-menu" data-id="' + esc(x.taskId) + '">⋯</button></div>'
}
// Full-screen mobile detail (replaces the hidden desktop Inspector on mobile).
function mobileDetail(title, bodyHtml){
  document.querySelectorAll('.mobile-detail').forEach(o => o.remove())
  const ov = document.createElement('div')
  ov.className = 'mobile-detail'
  ov.innerHTML = '<div class="md-head"><button class="btn small" data-action="mobile-detail-back">← ' + esc(t('back')) + '</button><span class="md-title">' + esc(title) + '</span></div><div class="md-body">' + bodyHtml + '</div>'
  document.body.appendChild(ov)
  ov.addEventListener('click', (e) => { if (e.target === ov) ov.remove() })
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
// ── Task multi-selection (marquee + Ctrl/Cmd toggle + batch context menu) ────
let taskMarquee = null
function applyTaskSelectionVisual(){
  document.querySelectorAll('#main .task-card').forEach(card => { card.classList.toggle('selected', state.selectedTaskIds.has(card.dataset.id)) })
}
function clearTaskSelection(){ state.selectedTaskIds.clear(); applyTaskSelectionVisual() }
function toggleTaskSelection(id){ if (state.selectedTaskIds.has(id)) state.selectedTaskIds.delete(id); else state.selectedTaskIds.add(id); applyTaskSelectionVisual() }
function reconcileTaskSelection(visibleIds){
  const set = new Set(visibleIds)
  let changed = false
  for (const id of Array.from(state.selectedTaskIds)) if (!set.has(id)) { state.selectedTaskIds.delete(id); changed = true }
  if (changed) applyTaskSelectionVisual()
}
function marqueeIntersect(rect){
  const cards = document.querySelectorAll('#main .task-card')
  cards.forEach(card => {
    const r = card.getBoundingClientRect()
    const hit = !(r.right < rect.left || r.left > rect.right || r.bottom < rect.top || r.top > rect.bottom)
    if (hit) state.selectedTaskIds.add(card.dataset.id)
  })
  applyTaskSelectionVisual()
}
function startTaskMarquee(x, y){
  clearTaskSelection()
  taskMarquee = { x0: x, y0: y, el: document.createElement('div') }
  taskMarquee.el.className = 'marquee'
  document.body.appendChild(taskMarquee.el)
}
function updateTaskMarquee(x, y){
  if (!taskMarquee) return
  const l = Math.min(taskMarquee.x0, x), t = Math.min(taskMarquee.y0, y)
  const w = Math.abs(x - taskMarquee.x0), h = Math.abs(y - taskMarquee.y0)
  taskMarquee.el.style.left = l + 'px'; taskMarquee.el.style.top = t + 'px'
  taskMarquee.el.style.width = w + 'px'; taskMarquee.el.style.height = h + 'px'
  marqueeIntersect({ left: l, top: t, right: l + w, bottom: t + h })
}
function endTaskMarquee(){ if (taskMarquee) { taskMarquee.el.remove(); taskMarquee = null } }
async function batchTaskOp(op){
  const ids = Array.from(state.selectedTaskIds)
  const settled = await Promise.allSettled(ids.map(id => api(op, { taskId: id })))
  const ok = [], failed = []
  settled.forEach((r, i) => { (r.status === 'fulfilled' ? ok : failed).push(ids[i]) })
  return { ok, failed }
}
function batchTaskCompleteOrReopen(op){
  batchTaskOp(op).then(({ ok, failed }) => {
    for (const id of ok) state.selectedTaskIds.delete(id)
    if (failed.length === 0) toast(t('batchDone', { n: ok.length }), 'ok')
    else toast(t('batchPartial', { n: ok.length, m: failed.length }), 'warn')
    refreshTasks()
  }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
}
function confirmBatchTaskDelete(){
  const n = state.selectedTaskIds.size
  trashConfirmDialog(t('batchDeleteConfirm', { n }), esc(t('batchDeleteHint')), t('batchDelete', { n }), () => {
    batchTaskOp('deleteTask').then(({ ok, failed }) => {
      for (const id of ok) state.selectedTaskIds.delete(id)
      if (failed.length === 0) toast(t('batchDone', { n: ok.length }), 'ok')
      else toast(t('batchPartial', { n: ok.length, m: failed.length }), 'warn')
      refreshTasks()
    }).catch(e => toast(t('genericError') + ': ' + e.message, 'err'))
  })
}
function showBatchTaskMenu(x, y){
  const n = state.selectedTaskIds.size
  dismissContextMenu()
  const menu = document.createElement('div')
  menu.className = 'ctx-menu'; menu.id = 'ctxMenu'
  menu.style.left = Math.min(x, window.innerWidth - 220) + 'px'
  menu.style.top = Math.min(y, window.innerHeight - 140) + 'px'
  const items = [
    ['✓ ' + t('batchComplete'), () => batchTaskCompleteOrReopen('completeTask')],
    ['↩ ' + t('batchReopen'), () => batchTaskCompleteOrReopen('reopenTask')],
    ['🗑 ' + t('batchDelete', { n }), () => confirmBatchTaskDelete()],
  ]
  menu.innerHTML = items.map((it, i) => '<div class="ctx-item' + (i === 2 ? ' danger' : '') + '" data-edit-idx="' + i + '">' + esc(it[0]) + '</div>').join('')
  menu.addEventListener('click', (e) => { const it = e.target.closest('[data-edit-idx]'); if (it) { const fn = items[Number(it.dataset.editIdx)][1]; dismissContextMenu(); fn() } })
  document.body.appendChild(menu)
}
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || state.view !== 'tasks') return
  if (e.target.closest('.task-card') || e.target.closest('button') || e.target.closest('input') || e.target.closest('.ctx-menu') || e.target.closest('a')) return
  if (!e.target.closest('#main')) return
  if (e.ctrlKey || e.metaKey) return
  startTaskMarquee(e.clientX, e.clientY)
})
document.addEventListener('mousemove', (e) => { if (taskMarquee) updateTaskMarquee(e.clientX, e.clientY) })
document.addEventListener('mouseup', () => { endTaskMarquee() })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { clearTaskSelection(); dismissContextMenu() } })
function showMatrixContextMenu(x, y, matrixId){
  showContextMenu(x, y, [
    { label: '✏️ ' + t('renameFolder'), action: 'matrix-rename', id: matrixId },
    { label: '📦 ' + t('matrixArchive'), action: 'matrix-archive', id: matrixId },
    { label: '🗑 ' + t('matrixRemove'), action: 'matrix-remove', id: matrixId, danger: true },
  ])
}
let matrixDeleting = false
function matrixDeleteDialog(matrixId, name){
  if (matrixDeleting) return
  const tasks = (state.tasksCache || []).filter(x => x.matrixId === matrixId)
  const total = tasks.length
  const overlay = document.createElement('div'); overlay.className = 'modal-overlay'
  overlay.innerHTML = '<div class="modal"><h3>' + esc(t('matrixRemove')) + (name ? '：' + esc(name) : '') + '</h3>' +
    '<p class="muted">' + esc(t('matrixTasksCount', { n: total })) + '</p>' +
    '<label class="radio-row"><input type="radio" name="mdDisp" value="move-to-inbox" checked><span><b>' + esc(t('matrixMoveToInbox')) + '</b><div class="muted small">' + esc(t('matrixMoveToInboxHint')) + '</div></span></label>' +
    '<label class="radio-row"><input type="radio" name="mdDisp" value="delete-tasks"><span><b class="danger-text">' + esc(t('matrixDeleteTasks')) + '</b><div class="muted small">' + esc(t('matrixDeleteTasksHint')) + '</div></span></label>' +
    '<div class="toolbar" id="mdActions" style="margin-top:12px"><button class="btn" id="mdCancel">' + esc(t('cancel')) + '</button><button class="btn danger" id="mdOk">' + esc(t('matrixRemove')) + '</button></div></div>'
  document.body.appendChild(overlay)
  const q = (s) => overlay.querySelector(s)
  q('#mdCancel').addEventListener('click', () => { if (!matrixDeleting) overlay.remove() })
  overlay.addEventListener('click', (e) => { if (e.target === overlay && !matrixDeleting) overlay.remove() })
  q('#mdOk').addEventListener('click', () => {
    const disp = q('input[name="mdDisp"]:checked').value
    // Deleting state takes effect immediately; the visible busy state is delayed
    // so a fast delete never flashes a spinner (<250ms).
    matrixDeleting = true
    const okBtn = q('#mdOk'), cancelBtn = q('#mdCancel')
    if (okBtn) okBtn.disabled = true
    if (cancelBtn) cancelBtn.disabled = true
    const busyText = disp === 'delete-tasks' ? t('matrixDeletingTasks', { n: total }) : t('matrixMovingTasks', { n: total })
    const showBusy = () => { q('#mdActions').innerHTML = '<div><span class="spinner"></span> <span class="muted">' + esc(t('matrixDeleting')) + '</span></div><p class="muted small">' + esc(busyText) + '</p>' }
    const busyTimer = setTimeout(showBusy, 200)
    api('removeMatrix', { matrixId, taskDisposition: disp }).then(r => {
      clearTimeout(busyTimer); matrixDeleting = false; overlay.remove()
      const doneText = disp === 'delete-tasks' ? t('matrixDeletedTasks', { n: (r && r.deleted) || 0 }) : t('matrixDeleted', { n: (r && r.moved) || 0 })
      toast(doneText, 'ok')
      refreshTasks()
    }).catch(e => {
      clearTimeout(busyTimer); matrixDeleting = false
      q('#mdActions').innerHTML = '<p class="muted">' + esc(t('matrixDeleteFailed')) + ': ' + esc(e.message) + '</p><div class="toolbar"><button class="btn" id="mdClose">' + esc(t('taskClose')) + '</button><button class="btn danger" id="mdRetry">' + esc(t('retry')) + '</button></div>'
      q('#mdClose').addEventListener('click', () => overlay.remove())
      q('#mdRetry').addEventListener('click', () => { overlay.remove(); matrixDeleteDialog(matrixId, name) })
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
  if (taskRow) {
    e.preventDefault()
    const tid = taskRow.dataset.id
    if (state.selectedTaskIds.has(tid) && state.selectedTaskIds.size > 1) {
      showBatchTaskMenu(e.clientX, e.clientY) // keep the whole selection
    } else {
      clearTaskSelection(); state.selectedTaskIds.add(tid); applyTaskSelectionVisual()
      showTaskContextMenu(e.clientX, e.clientY, tid, taskRow.dataset.completed === '1')
    }
    return
  }
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

// ── Task drag/drop (HTML5 DnD, client-side) ────
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
  const bn = e.target.closest('#bottomNav [data-view]'); if (bn) { setView(bn.dataset.view); return }
  // Ctrl/Cmd + click toggles task selection (multi-select intent, not open detail).
  if ((e.ctrlKey || e.metaKey) && e.target.closest('.task-card')) {
    toggleTaskSelection(e.target.closest('.task-card').dataset.id)
    e.preventDefault()
    return
  }
  // Ctrl/Cmd + click toggles explorer selection (E) instead of opening.
  if ((e.ctrlKey || e.metaKey) && e.target.closest('.explorer-item')) {
    const item = e.target.closest('.explorer-item')
    const key = item.querySelector('.exp-check')
    if (key) explorerToggleSel(key.dataset.key)
    e.preventDefault()
    return
  }
  const el = e.target.closest('[data-action]'); if (!el) return
  const act = el.dataset.action, id = el.dataset.id, path = el.dataset.path, mode = el.dataset.mode
  if (act === 'new-note') newNote()
  else if (act === 'new-note-here') { state.selectedFolder = path; newNote() }
  else if (act === 'new-folder') newFolder(state.selectedFolder || '')
  else if (act === 'new-subfolder') newFolder(path)
  else if (act === 'open-note') { setView('notes'); if (el.dataset.reason) state.searchContext = { reason: el.dataset.reason, attName: el.dataset.attname || '' }; else state.searchContext = null; openNote(id) }
  else if (act === 'open-attachment') { setView('attachments'); openAttachment(id) }
  else if (act === 'select-folder') { state.selectedFolder = path; state.selectedNoteId = null; state.explorerSel.clear(); renderTree(); renderFolderMain(path); renderDetail() }
  else if (act === 'explorer-up') { state.selectedFolder = parentOfPath(state.selectedFolder || ''); state.selectedNoteId = null; state.explorerSel.clear(); renderTree(); renderFolderMain(state.selectedFolder || '') }
  else if (act === 'explorer-crumb') { state.selectedFolder = path || null; state.selectedNoteId = null; state.explorerSel.clear(); renderTree(); renderFolderMain(path || '') }
  else if (act === 'explorer-open-folder' || act === 'explorer-folder') { state.selectedFolder = path; state.selectedNoteId = null; state.explorerSel.clear(); renderTree(); renderFolderMain(path) }
  else if (act === 'explorer-note') { openNote(id) }
  else if (act === 'explorer-toggle') { explorerToggleSel(el.dataset.key) }
  else if (act === 'explorer-select-all') explorerSelectAllScope()
  else if (act === 'explorer-clear') explorerClearSel()
  else if (act === 'explorer-bulk-move') explorerBulkMove()
  else if (act === 'explorer-bulk-trash') explorerBulkTrash()
  else if (act === 'folder-menu') {
    showContextMenu(e.clientX, e.clientY, [
      { label: t('renameFolder'), action: 'rename-folder', id: path },
      { label: t('deleteFolder'), action: 'delete-folder', id: path },
    ])
  }
  else if (act === 'toggle-folder') { if (state.collapsed.has(path)) state.collapsed.delete(path); else state.collapsed.add(path); const c = document.querySelector('.tree-children[data-folder="' + CSS.escape(path) + '"]'); if (c) { c.style.display = state.collapsed.has(path) ? 'none' : ''; el.textContent = state.collapsed.has(path) ? '▸' : '▾' } }
  else if (act === 'save-note') saveNote()
  else if (act === 'set-mode') { state.editor.mode = mode; localStorage.setItem('pkw-editor-mode', mode); const d = state.editor.noteId; if (d) openNote(d) }
  else if (act === 'rename-note') {
    const nid = id || state.selectedNoteId
    if (!nid) return
    let target
    if (state.selectedNoteId === nid) target = document.querySelector('.editor-head .note-title')
    else { const row = el.closest('.tree-row'); target = row ? row.querySelector('.note-title') : document.querySelector('.note-title[data-id="' + CSS.escape(nid) + '"]') }
    inlineRenameTitle(target, nid)
  }
  else if (act === 'move-note') moveNote(id)
  else if (act === 'delete-note') delNote(id)
  else if (act === 'rescan-notes') { renderTree(); refreshHeader() }
  else if (act === 'remove-missing-note') { removeMissingNote(id) }
  else if (act === 'rename-folder') renameFolder(path)
  else if (act === 'delete-folder') deleteFolder(path)
  else if (act === 'sync-note') syncEntity('note', id)
  else if (act === 'upgrade-companion') { api('upgradeCompanionNote', { noteId: id }).then(() => { toast(t('companionUpgraded'), 'ok'); openNote(id) }).catch(e => toast(t('genericError') + ': ' + e.message, 'err')) }
  else if (act === 'sync-now') syncNow()
  else if (act === 'reconcile') reconcile()
  else if (act === 'upload-attachment') uploadDialog()
  else if (act === 'download-attachment') downloadAttachment(id)
  else if (act === 'reparse-attachment') { api('reparseAttachmentKnowledge', { attachmentId: id }).then(() => { toast(t('reparseStarted'), 'ok'); if (state.view === 'notes' && state.selectedNoteId !== null) renderSources(state.selectedNoteId, state.noteAttachments); else if (state.selectedAttachmentId !== null) openAttachment(id) }).catch(e => toast(t('genericError') + ': ' + e.message, 'err')) }
  else if (act === 'refresh-sources') { if (state.selectedNoteId !== null) renderSources(state.selectedNoteId, state.noteAttachments) }
  else if (act === 'delete-attachment') delAttachment(id)
  else if (act === 'att-mode') { state.attMode = mode === 'grid' ? 'grid' : 'list'; localStorage.setItem('pkw-att-mode', state.attMode); renderAttachmentsFrom(state.attachmentsCache) }
  else if (act === 'att-type') { state.attType = el.dataset.type || 'all'; localStorage.setItem('pkw-att-type', state.attType); renderAttachmentsFrom(state.attachmentsCache) }
  else if (act === 'att-sort') { state.attSort = el.dataset.sort || el.dataset.id || 'recent'; localStorage.setItem('pkw-att-sort', state.attSort); renderAttachmentsFrom(state.attachmentsCache) }
  else if (act === 'att-sort-sheet') { mobileActionSheet(t('attSort'), [
    { label: t('attSortRecent'), action: 'att-sort', id: 'recent' },
    { label: t('attSortName'), action: 'att-sort', id: 'name' },
    { label: t('attSortSize'), action: 'att-sort', id: 'size' },
  ]) }
  else if (act === 'att-toggle') attToggleSelection(id)
  else if (act === 'att-clear-selection') attClearSelection()
  else if (act === 'att-batch-trash') attBatchOp('trash')
  else if (act === 'att-batch-reparse') attBatchOp('reparse')
  else if (act === 'att-batch-index') attBatchOp('index')
  else if (act === 'att-create-companion') ensureCompanionForAttachment(id, '')
  else if (act === 'att-open-companion') openCompanionForAttachment(id)
  else if (act === 'att-copy-ref') copyAttachmentRef(id)
  else if (act === 'att-preview') previewAttachment(id)
  else if (act === 'pv-close') { $('#detail').classList.remove('previewing'); $('#detail').innerHTML = '' }
  else if (act === 'go-attachments') setView('attachments')
  else if (act === 'new-task') quickTaskDialog(null, null)
  else if (act === 'new-task-matrix') quickTaskDialog(id || null, null)
  else if (act === 'new-task-mobile') quickTaskDialog(state.mobileTaskBoard === 'inbox' ? null : state.mobileTaskBoard, null, {}, state.mobileTaskQ)
  else if (act === 'mobile-q') { state.mobileTaskQ = Number(el.dataset.q) || 1; renderMobileTasks() }
  else if (act === 'mobile-q-toggle') {
    const key = el.dataset.q || '1'
    if (state.mobileOpenSections.has(key)) state.mobileOpenSections.delete(key)
    else state.mobileOpenSections.add(key)
    if (key !== 'done') state.mobileTaskQ = Number(key) || 1
    renderMobileTasks()
  }
  else if (act === 'mobile-board') { state.mobileTaskBoard = el.dataset.id || el.dataset.board || 'inbox'; state.mobileTaskBoardChosen = true; renderMobileTasks() }
  else if (act === 'mobile-board-sheet') {
    const mats = state.matricesCache || []
    const items = []
    for (const m of mats) items.push({ label: m.name, action: 'mobile-board', id: m.matrixId })
    items.push({ label: t('taskInbox'), action: 'mobile-board', id: 'inbox' })
    items.push({ label: '+ ' + t('newMatrix'), action: 'new-matrix' })
    mobileActionSheet(t('matrices'), items)
  }
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
  else if (act === 'matrix-remove') { const m = (state.matricesCache || []).find(x => x.matrixId === id); matrixDeleteDialog(id, m ? m.name : '') }
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
  else if (act === 'knowledge-tab') { renderKnowledgeView() }
  else if (act === 'kb-clear-search') { state.searchQuery = ''; state.searchResults = null; renderKnowledgeView() }
  else if (act === 'knowledge-view-all') { state.knowledgeShowAll = true; renderKnowledgeBrowseInto() }
  else if (act === 'knowledge-back-home') { state.knowledgeShowAll = false; renderKnowledgeBrowseInto() }
  else if (act === 'mobile-more') {
    mobileActionSheet(t('mobileMore'), [
      { label: t('overview'), action: 'go-overview' },
      { label: t('trash'), action: 'go-trash' },
      { label: t('themeSystem'), action: 'theme-system' },
      { label: t('themeLight'), action: 'theme-light' },
      { label: t('themeDark'), action: 'theme-dark' },
    ])
  }
  else if (act === 'go-overview') { dismissContextMenu(); setView('overview') }
  else if (act === 'go-trash') { dismissContextMenu(); setView('trash') }
  else if (act === 'go-lang') { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pkw-lang', lang); render() }
  else if (act === 'mobile-note-menu') {
    const nid = id
    mobileActionSheet(t('renameMove'), [
      { label: t('openNote'), action: 'open-note', id: nid },
      { label: t('renameTitle'), action: 'rename-note', id: nid },
      { label: t('moveNoteTo'), action: 'move-note', id: nid },
      { label: t('trashFolder'), action: 'delete-note', id: nid, danger: true },
    ])
  }
  else if (act === 'mobile-note-create') {
    mobileActionSheet(t('newNote'), [
      { label: t('newNote'), action: 'new-note' },
      { label: t('newFolder'), action: 'new-folder' },
    ])
  }
  else if (act === 'mobile-notes-new') {
    mobileActionSheet(t('newNote'), [
      { label: '📝 ' + t('newNote'), action: 'new-note' },
      { label: '📁 ' + t('newFolder'), action: 'new-folder' },
    ])
  }
  else if (act === 'mobile-notes-back') { state.mobileNotesFolder = null; state.selectedFolder = null; render() }
  else if (act === 'mobile-notes-home') { state.mobileNotesFolder = null; state.selectedFolder = null; render() }
  else if (act === 'mobile-folder-open') { const p = el.dataset.path || ''; state.mobileNotesFolder = p; state.selectedFolder = p; render() }
  else if (act === 'mobile-folder-menu') {
    const p = el.dataset.path || ''
    if (!p) return
    mobileActionSheet(t('folder'), [
      { label: t('renameFolder'), action: 'rename-folder', path: p },
      { label: t('trashFolder'), action: 'delete-folder', path: p, danger: true },
    ])
  }
  else if (act === 'mobile-source-menu') {
    const aid = id
    mobileActionSheet(t('sources'), [
      { label: t('attPreview'), action: 'att-preview', id: aid },
      { label: t('download'), action: 'download-attachment', id: aid },
      { label: t('attOpenCompanion'), action: 'att-open-companion', id: aid },
      { label: t('attCreateCompanion'), action: 'att-create-companion', id: aid },
      { label: t('reparse'), action: 'reparse-attachment', id: aid },
      { label: t('del'), action: 'delete-attachment', id: aid, danger: true },
    ])
  }
  else if (act === 'mobile-task-menu') {
    const tid = id
    mobileActionSheet(t('tasks'), [
      { label: t('moveUp'), action: 'task-up', id: tid },
      { label: t('moveDown'), action: 'task-down', id: tid },
      { label: t('taskDuplicate'), action: 'task-duplicate', id: tid },
      { label: t('taskDelete'), action: 'task-delete', id: tid, danger: true },
    ])
  }
  else if (act === 'mobile-detail-back') { document.querySelectorAll('.mobile-detail').forEach(o => o.remove()) }
  else if (act === 'mobile-back-notes') { state.selectedNoteId = null; state.selectedFolder = null; destroyVditor(); render() }
  else if (act === 'mobile-editor-menu') {
    const nid = state.selectedNoteId
    if (!nid) return
    mobileActionSheet(t('notes'), [
      { label: t('renameTitle'), action: 'rename-note', id: nid },
      { label: t('moveNoteTo'), action: 'move-note', id: nid },
      { label: t('syncNow'), action: 'sync-note', id: nid },
      { label: t('del'), action: 'delete-note', id: nid, danger: true },
    ])
  }
})
// Trash selection is pure local state: checkbox/select-all toggles never fetch.
document.addEventListener('change', (e) => {
  const check = e.target.closest('.trash-check')
  if (check) { toggleTrashKey(check.dataset.key, check.checked); return }
  const sa = e.target.closest('#trashSelectAll')
  if (sa) { selectAllVisible(sa.checked); return }
  const attAll = e.target.closest('#attSelectAll')
  if (attAll) { attSelectAllVisible(attAll.checked); return }
})
// Attachment manager live search: re-render only the list so the input keeps focus.
document.addEventListener('input', (e) => {
  if (e.target && e.target.id === 'attSearch') {
    state.attQuery = e.target.value || ''
    localStorage.setItem('pkw-att-query', state.attQuery)
    attRerenderList()
  }
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
          '<div class="task-detail-title-row"><input id="tdTitle" class="td-title-input" value="' + esc(task.title) + '" placeholder="' + esc(t('taskTitle')) + '" /></div>' +
          '<div class="task-detail-controls">' +
            '<select id="tdStatus" class="td-status"><option value="open"' + (task.status === 'open' ? ' selected' : '') + '>' + esc(t('taskOpen')) + '</option><option value="completed"' + (task.status === 'completed' ? ' selected' : '') + '>' + esc(t('taskCompleted')) + '</option></select>' +
            '<span class="spacer"></span>' +
            '<button class="btn small" id="tdCloseX" title="' + esc(t('taskClose')) + '">×</button>' +
          '</div>' +
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
function quickTaskDialog(matrixId, sourceRefs, prefill, defaultQuad){
  const lastMatrix = localStorage.getItem('pkw-task-last-matrix') || ''
  const pre = prefill || {}
  const defQ = defaultQuad || 1
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
    $('#tkQuad').value = String(defQ)
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
// Header global search removed (Search is now the unified Knowledge entry).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (taskDetailRequestClose) { taskDetailRequestClose(); return } dismissContextMenu(); dismissSelButton(); dismissWikiSuggest(); if (state.explorerSel.size) explorerClearSel(); return }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (state.view === 'notes' && state.selectedNoteId !== null) saveNote() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); quickSwitch() }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '**bold**') }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && $('#editor')) { e.preventDefault(); document.execCommand('insertText', false, '*italic*') }
})
$('#langBtn').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; localStorage.setItem('pkw-lang', lang); render() })
$('#themeBtn').addEventListener('click', (e) => { e.stopPropagation(); const r = e.target.getBoundingClientRect(); showAppearanceMenu(r.left, r.bottom + 4) })
$('#inspectorToggle').addEventListener('click', () => toggleInspector())
$('#mobileMoreBtn').addEventListener('click', () => { mobileActionSheet(t('mobileMore'), [
  { label: t('overview'), action: 'go-overview' },
  { label: t('trash'), action: 'go-trash' },
  { label: lang === 'zh' ? 'English' : '中文', action: 'go-lang' },
  { label: t('themeSystem'), action: 'theme-system' },
  { label: t('themeLight'), action: 'theme-light' },
  { label: t('themeDark'), action: 'theme-dark' },
]) })
$('#pageTitle').addEventListener('click', () => { if (isMobile() && state.view === 'notes' && state.selectedNoteId === null && state.mobileNotesFolder === null) mobileNotesScopeSheet() })
window.addEventListener('beforeunload', (e) => { if (state.editor.dirty && state.selectedNoteId !== null) { e.preventDefault(); e.returnValue = '' } })
document.addEventListener('visibilitychange', () => { if (!document.hidden) { refreshHeader(); if (state.view === 'notes') { renderTree(); if (state.selectedNoteId) kickSyncPoll({ pending: true }) } } })
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentThemeMode() === 'system') applyTheme('system') })
applyTheme()
// Inspector: hide the right column when it has no context, so Main expands.
function syncInspector(){
  const detail = $('#detail')
  const has = detail && detail.innerHTML.trim() !== ''
  const app = $('#app')
  if (app) app.classList.toggle('no-inspector', !has || state.inspectorCollapsed)
  const btn = $('#inspectorToggle')
  if (btn) btn.textContent = state.inspectorCollapsed ? '⟨' : '⟩'
}
function toggleInspector(){ state.inspectorCollapsed = !state.inspectorCollapsed; syncInspector() }
if ($('#detail')) new MutationObserver(syncInspector).observe($('#detail'), { childList: true, subtree: true, characterData: true })
syncInspector()

render()
</script>
</body>
</html>`
}
